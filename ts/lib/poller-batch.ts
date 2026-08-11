/**
 * Batch-processing + persistence-durability retry logic for the
 * getUpdates poller (durability fix PR-B, 2026-07).
 *
 * Owns the single durability invariant:
 *
 *   NEVER advance the persisted getUpdates offset past an inbound update
 *   whose DB persistence FAILED.
 *
 * Before this, the poller set `offset = update_id + 1` in-memory BEFORE
 * handleUpdate ran and persisted that advanced offset unconditionally
 * after the batch. A saveInbound throw was caught + swallowed, so the
 * offset still advanced → Telegram never redelivered → the message was
 * SILENTLY lost forever. processBatch closes that hole: it advances only
 * past updates the handler reports durable ("ok"/"duplicate") and STOPS
 * (loudly) on the first real "persistError", leaving the offset AT the
 * failed update_id so Telegram redelivers it (Telegram retains
 * undelivered updates ~24h).
 */

import { log } from "./log.js";
import { broadcastSystemAlert } from "./loudfail.js";
import { handleUpdate, type UpdateStatus } from "./handle-update.js";
import { saveCoverageGap, type CoverageGap } from "./store-meta.js";

/**
 * Consecutive persistError count on the SAME update_id we tolerate
 * before giving up and SKIPPING it (loudly). This bounds the wedge: a
 * permanently-unpersistable update (e.g. a genuinely corrupt row) can't
 * block the bridge forever, but the eventual loss is always announced,
 * never silent.
 */
export const MAX_PERSIST_RETRIES = 5;

// In-memory consecutive-failure tracker keyed on the failing update_id.
// Reset on ANY success (or once we skip past the poison update). Not
// persisted — a process restart re-reads the un-advanced offset and
// simply retries, which is exactly the desired behaviour.
let persistFail: { updateId: number; count: number } | null = null;

/** Test-only: reset the consecutive-failure tracker. */
export function _resetPersistFailures(): void {
  persistFail = null;
}

type UpdateHandler = (update: any) => Promise<UpdateStatus>;

/**
 * Emit a LOUD failure notification. Broadcasts directly to Telegram (see
 * lib/loudfail.ts::broadcastSystemAlert) so a persistence failure is
 * surfaced to the operator even though this now runs in the standalone
 * poller process with no mcp/Server object to notify through. Also
 * logged. Best-effort — broadcastSystemAlert never throws/rejects (we
 * must not throw out of the poll loop).
 */
function emitLoud(content: string): void {
  log("poller", content);
  void broadcastSystemAlert(content);
}

/**
 * Did updates go missing between what we ASKED for and what we GOT?
 *
 * We always call getUpdates with `offset = <last durable update_id> + 1`, so
 * a healthy batch starts EXACTLY at that offset. If Telegram's first
 * update_id is HIGHER, the ids in between existed and are gone: either
 * another consumer holding this bot token confirmed them (which discards them
 * for us — Telegram serves each update to whoever asks first), or they aged
 * out of its ~24h retention while nothing was polling.
 *
 * Both are the same fact for a reader: update_ids Telegram counted never
 * reached this store, and re-reading will not bring them back. We record that
 * FACT rather than a diagnosis, because we cannot tell the two causes apart
 * from here.
 *
 * KNOWN OVERCOUNT, stated rather than hidden: we pass `allowed_updates`
 * (message + message_reaction), so update types we never subscribed to also
 * consume ids and show up here as a small gap. That inflates the count; it
 * does not invent one. A gap of thousands is contention or expiry, a gap of
 * one or two is usually a filtered update type.
 *
 * This is the signal lib/poll-watchdog.ts structurally cannot carry: its
 * heartbeat is stamped whenever getUpdates RETURNS, and a batch stolen by
 * another consumer returns perfectly well — just empty. On 2026-08-10 that
 * cost scitex-dev 8h35m of both-directions history behind a silent watchdog.
 *
 * Logged, never broadcast: the operator can do nothing about it in the
 * moment, and #92/#95 established that unactionable alarms destroy the one
 * channel a real outage needs. The read path (lib/ingestion-coverage.ts)
 * surfaces it to the AGENT, which can act on it.
 */
export function detectCoverageGap(
  updates: any[],
  startOffset: number,
  recordGap: (gap: CoverageGap) => void,
  now: () => number,
): void {
  // startOffset 0 means "give me whatever you have" — there is no expectation
  // to violate, so a first poll can never report a gap.
  if (startOffset <= 0 || updates.length === 0) return;
  const first = updates[0]?.update_id;
  if (typeof first !== "number" || first <= startOffset) return;

  const missedUpdates = first - startOffset;
  log(
    "poller",
    `COVERAGE GAP: asked Telegram for update ${startOffset}, got ${first} — ` +
      `${missedUpdates} update_id(s) never reached this store and cannot be ` +
      "refetched. Another consumer holding this bot token, or Telegram's ~24h " +
      "retention expiring while nothing polled. Reads over this window are now " +
      "reported as unverifiable rather than empty.",
    { startOffset, firstUpdateId: first, missedUpdates },
  );
  try {
    recordGap({ at: now(), missedUpdates });
  } catch (err) {
    // A diagnostic that cannot be written must not take down ingestion.
    log("poller", "failed to persist coverage gap", { error: String(err) });
  }
}

/**
 * Process one getUpdates batch and return the offset that should be
 * persisted (via saveOffset) afterwards.
 *
 * For each update the handler returns an {@link UpdateStatus}:
 *
 *   - "ok" / "duplicate": the update is durable → advance the offset
 *     past it (update_id + 1) and reset the failure tracker.
 *
 *   - "persistError": saveInbound threw. On the 1st..(N-1)th consecutive
 *     failure for this update_id we do NOT advance past it — the returned
 *     offset is set to the failed update_id (so it AND the rest of the
 *     batch are refetched next poll), a LOUD notification is emitted, and
 *     the rest of the batch is DEFERRED (loop stops). On the Nth
 *     consecutive failure (MAX_PERSIST_RETRIES) we emit a FATAL loud
 *     notification and THEN advance past it (skip) so the bridge can't
 *     wedge forever — the loss is loud, never silent.
 *
 * The handler is injectable (defaults to handleUpdate) so the retry /
 * offset / loud-notification logic is unit-testable without any network.
 */
export async function processBatch(
  updates: any[],
  startOffset: number,
  handle: UpdateHandler = handleUpdate,
  recordGap: (gap: CoverageGap) => void = saveCoverageGap,
  now: () => number = Date.now,
): Promise<number> {
  detectCoverageGap(updates, startOffset, recordGap, now);

  let offset = startOffset;

  for (const update of updates) {
    let status: UpdateStatus;
    try {
      status = await handle(update);
    } catch (err) {
      // An UNEXPECTED throw — NOT the saveInbound-throw path, which
      // handleUpdate converts to "persistError". saveInbound failures
      // never reach here, so this is a post-persist / non-persist bug:
      // log and advance, exactly as the pre-PR loop did, so a handler
      // bug can't newly wedge the poller.
      log("poller", `error handling update ${update.update_id}`, {
        error: String(err),
      });
      offset = update.update_id + 1;
      persistFail = null;
      continue;
    }

    if (status === "persistError") {
      if (persistFail && persistFail.updateId === update.update_id) {
        persistFail.count += 1;
      } else {
        persistFail = { updateId: update.update_id, count: 1 };
      }

      if (persistFail.count >= MAX_PERSIST_RETRIES) {
        emitLoud(
          `FATAL: update ${update.update_id} failed to persist ` +
            `${persistFail.count}× consecutively — SKIPPING it to unwedge ` +
            `the poller. This message is PERMANENTLY LOST, but the loss is ` +
            `announced here, never silent. Investigate the SQLite store ` +
            `(disk full / corruption / locked DB).`,
        );
        offset = update.update_id + 1;
        persistFail = null;
        continue;
      }

      emitLoud(
        `persist FAILED for update ${update.update_id} ` +
          `(attempt ${persistFail.count}/${MAX_PERSIST_RETRIES}) — NOT ` +
          `advancing the getUpdates offset. Telegram will redeliver it on ` +
          `the next poll; the rest of this batch is deferred until it ` +
          `persists.`,
      );
      // Leave the offset AT the failed update_id — it (and everything
      // after it in this batch) is refetched next poll. Stop here.
      offset = update.update_id;
      break;
    }

    // "ok" or "duplicate": durable → advance past it and clear the
    // failure tracker (reset-on-any-success).
    offset = update.update_id + 1;
    persistFail = null;
  }

  return offset;
}
