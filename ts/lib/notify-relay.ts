/**
 * Cross-process relay for inbound messages that could not be live-pushed
 * at ingestion time (adversarial-review finding #3, follow-up to the
 * poller/MCP-server decoupling PR).
 *
 * Interactive-CLI (no TURN_URL / !wakeEnabled()) deployments used to
 * receive inbound Telegram messages as a live `mcp.notification()` push
 * straight from the poller's own lib/handle-update.ts, rendering into an
 * ACTIVE turn. Once the poller became a separate process
 * (ts/telegram-poller.ts) with no mcp/Server object at all, that direct
 * push became categorically impossible from there — a separate OS process
 * cannot call a method on another process's live MCP stdio connection.
 * The first cut of this decoupling PR left this as a documented gap
 * (message durably saved, but not live-pushed). This module closes it.
 *
 * The fix: the WRITER (the poller process, via
 * lib/handle-update.ts::savePendingNotification) persists the fully-built
 * notification payload onto the message's own row in the shared store. The
 * READER (THIS module, running in the MCP-server process, which still holds
 * the live `mcp` object throughout an interactive session) polls for pending
 * rows and calls mcp.notification() itself, then clears the payload once
 * delivered — restoring the ORIGINAL live-push behaviour via a short (default
 * 1s) delay instead of an immediate call, the necessary cost of the payload
 * having to cross a process boundary via the store instead of a function call.
 *
 * Only ever populated for !wakeEnabled() deployments (see
 * lib/handle-update.ts) — wake-enabled agents deliver via the already
 * mcp-independent /v1/turn POST and never write here, so this relay simply
 * finds nothing to do for them; started only when !wakeEnabled() in
 * ts/telegram-server.ts to avoid a pointless poll for the common
 * (wake-enabled fleet) case.
 *
 * NOTE ON THE ENGINE MOVE: this module used to open its own independent
 * database handle, each one having to remember its own lock-timeout setting
 * (a footgun documented in four separate places in this codebase). It now
 * shares the one pooled connection like everything else, which retires that
 * whole class of mistake.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { getSql } from "./pg.js";
import { storeSchema } from "./store.js";
import { statements } from "./store-schema.js";
import { log } from "./log.js";

export interface PendingNotificationPayload {
  content: string;
  meta: Record<string, string>;
}

/**
 * WRITER side — called from lib/handle-update.ts (standalone poller
 * process). Persists the fully-built notification payload VERBATIM on the
 * message's own row, so the reader delivers EXACTLY what the old direct
 * push would have (including the attachment descriptor appended to
 * `deliveredText`, which is not itself a separate stored column) — no
 * re-derivation needed on the reader side. Best-effort: a write failure is
 * logged, never thrown — must not crash inbound message handling over a
 * delivery-relay concern.
 */
export async function savePendingNotification(
  rowId: number,
  payload: PendingNotificationPayload,
): Promise<void> {
  try {
    await getSql().unsafe(statements(storeSchema()).setPendingNotification, [
      JSON.stringify(payload),
      rowId,
    ]);
  } catch (err) {
    log("notify-relay", "failed to persist pending notification", {
      row_id: rowId,
      error: String(err),
    });
  }
}

/**
 * Check whether a notification saved via savePendingNotification() is still
 * pending (i.e. the notify-relay reader has not yet delivered and NULLed
 * the column). Returns true when the row exists AND its
 * pending_notification is not null. Returns false on any thrown error so a
 * broken probe never creates a false alarm.
 *
 * @param rowId - The messages row to check.
 * @param schema - The namespace to read. Defaults to the initialized store's.
 *   Injected so tests can target a namespace that does not exist without
 *   touching the one the rest of the suite shares.
 */
export async function isNotificationPending(
  rowId: number,
  schema?: string,
): Promise<boolean> {
  try {
    const rows = await getSql().unsafe(
      statements(schema ?? storeSchema()).readPendingNotification,
      [rowId],
    );
    const row = rows[0] as { pending_notification: string | null } | undefined;
    return !!row && row.pending_notification !== null;
  } catch {
    return false;
  }
}

interface PendingRow {
  id: number;
  pending_notification: string;
}

/** Currently-pending rows, oldest first. */
async function readPendingRows(): Promise<PendingRow[]> {
  const rows = (await getSql().unsafe(
    statements(storeSchema()).pendingNotifications,
    [],
  )) as Array<{ id: string | number; pending_notification: string }>;
  return rows.map((r) => ({
    id: Number(r.id),
    pending_notification: r.pending_notification,
  }));
}

async function clearPendingRow(id: number): Promise<void> {
  await getSql().unsafe(statements(storeSchema()).clearPendingNotification, [
    id,
  ]);
}

export interface NotifyRelayDeps {
  mcp: Server;
  /** Injectable for tests; defaults to a real readPendingRows() call. */
  getPending?: () => PendingRow[] | Promise<PendingRow[]>;
  /** Injectable for tests; defaults to a real clearPendingRow() call. */
  clearPending?: (id: number) => void | Promise<void>;
  logFn?: typeof log;
}

/**
 * READER side — called from ts/telegram-server.ts, which holds the live
 * mcp object throughout the process lifetime. One poll tick: relay every
 * currently-pending notification, oldest first, then clear it. Exported
 * separately from startNotifyRelay() so the relay DECISION is unit-
 * testable without a real timer (same injectable-seam pattern
 * poller-batch.ts / poll-watchdog.ts already use).
 */
export async function relayPendingNotificationsOnce(
  deps: NotifyRelayDeps,
): Promise<number> {
  const getPending = deps.getPending ?? readPendingRows;
  const clearPending = deps.clearPending ?? clearPendingRow;
  const logFn = deps.logFn ?? log;

  let delivered = 0;
  let pending: PendingRow[];
  try {
    pending = await getPending();
  } catch (err) {
    // The snapshot itself failed (store unreachable). Nothing to relay this
    // tick; the next one retries. Logged, never thrown — same contract the
    // per-row branch below already honoured.
    logFn("notify-relay", "failed to read pending notifications", {
      error: String(err),
    });
    return 0;
  }
  for (const row of pending) {
    try {
      const payload = JSON.parse(
        row.pending_notification,
      ) as PendingNotificationPayload;
      await deps.mcp.notification({
        method: "notifications/claude/channel",
        params: payload,
      });
      await clearPending(row.id);
      delivered += 1;
    } catch (err) {
      // Leave the row pending — retried on the next tick. Logged, never
      // thrown (must not crash the relay loop or the MCP server).
      logFn("notify-relay", "failed to relay a pending notification", {
        row_id: row.id,
        error: String(err),
      });
    }
  }
  return delivered;
}

export interface NotifyRelayHandle {
  stop(): void;
}

/**
 * Production entry point: poll every intervalMs (default 1000ms), unref'd
 * so it never keeps the MCP server process alive on its own. Called from
 * ts/telegram-server.ts only when !wakeEnabled().
 *
 * SELF-RESCHEDULING, not a bare setInterval (round-2 adversarial-review
 * finding #1 — real duplicate delivery, confirmed via
 * ts/test/notify-relay.test.ts): relayPendingNotificationsOnce takes a
 * snapshot then sequentially awaits mcp.notification()+clearPending() per
 * row, uncapped. A bare setInterval fires on a fixed wall-clock schedule
 * REGARDLESS of whether the previous tick finished — so a tick slower than
 * intervalMs (one slow notification round-trip, or a modest backlog; the
 * realistic trigger is a long-lived detached poller draining an
 * accumulated backlog in a burst the moment an MCP-server session
 * connects) lets the NEXT tick start while the SAME rows are still
 * uncleared, re-relaying them — the operator sees the same message twice.
 * Scheduling the next tick only AFTER the current one's promise settles
 * makes that structurally impossible: at most one tick is ever in flight.
 */
export function startNotifyRelay(
  deps: NotifyRelayDeps,
  intervalMs = 1000,
): NotifyRelayHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const logFn = deps.logFn ?? log;

  const unrefTimer = (h: ReturnType<typeof setTimeout>) => {
    if (typeof h === "object" && h && "unref" in h) {
      (h as { unref: () => void }).unref();
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    unrefTimer(timer);
  };

  const tick = () => {
    void relayPendingNotificationsOnce(deps)
      .catch((err) => {
        // relayPendingNotificationsOnce already catches per-row errors
        // internally and never rejects in practice, but guard here too —
        // a throw must not silently kill the reschedule loop.
        logFn("notify-relay", "unexpected error in relay tick", {
          error: String(err),
        });
      })
      .finally(() => {
        scheduleNext();
      });
  };

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
