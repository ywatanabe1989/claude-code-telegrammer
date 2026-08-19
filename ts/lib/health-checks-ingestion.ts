import { unknownCheck } from "./health-checks.js";
/**
 * `ingestion_live` — is anything actually ARRIVING?
 *
 * A separate module from health-checks.ts for the same reason
 * health-checks-wake.ts is: this check answers its own question, against its
 * own signal, with its own threshold.
 *
 * WHY IT EXISTS. scitex-hub's inbound Telegram rail stored nothing between
 * 2026-07-08 and 2026-08-11 while every existing check read green:
 *
 *     poller_alive          ok   (kill-0 on a live pid)
 *     bot_token_valid       ok   (getMe answered)
 *     webhook_absent        ok
 *     state_dir_writable    ok
 *     wake_delivery_backlog ok
 *
 * Each of those was true and none of them was the question. The poller
 * PROCESS was alive and looping; what it was doing was losing a getUpdates
 * race — 161 `Conflict` errors in four hours — and storing nothing. The only
 * signal that could tell the difference is the heartbeat that
 * recordSuccessfulPoll() stamps on a SUCCESSFUL poll and never on a failed
 * one. It sat frozen for a month. Nothing read it.
 *
 * poller_alive asks "does the process exist?". This asks "is anything
 * arriving?". The outage lived precisely in the gap between those two
 * questions, so the gap gets its own check.
 */

import type { DbProbe, PollerProbe } from "./health.js";
import { skippedDisabled, type CheckOutcome } from "./health-checks.js";

/**
 * How stale the poll heartbeat may get before inbound counts as dead.
 *
 * A healthy long-poll returns at least every 30s, and the in-process stall
 * watchdog already self-terminates for respawn at 180s. 300s therefore means
 * "the self-healing path had its chance and inbound is STILL not moving" —
 * comfortably clear of a slow cycle, and far short of how long it actually
 * took a human to notice (a month).
 */
export const INGESTION_STALE_MS = 300_000;

/** Build the `ingestion_live` entry. Pure; `now` is injected. */
export function checkIngestionLive(
  db: DbProbe,
  poller: PollerProbe | null,
  now: number,
): CheckOutcome {
  const ok = (detail: string): CheckOutcome => ({
    entry: { name: "ingestion_live", ok: true, detail, hint: null },
    warn: false,
  });

  // No token → no poller. bot_token_present already reports the disabled
  // state loudly; repeating it here would just add noise. Uses the SHARED
  // skip marker so a tokenless agent's report stays uniform — the contract
  // test compares this detail literally.
  if (poller === null) {
    return skippedDisabled("ingestion_live");
  }

  // A dead poller is poller_alive's failure, not this one's. Double-failing
  // makes one fault look like two and buries which one to fix.
  const pollerAlive = poller.kind === "self" || poller.pidfileAlive;
  if (!pollerAlive) {
    return unknownCheck(
      "ingestion_live",
      "the poller process is not running (poller_alive reports that failure)",
    );
  }

  if (!db.exists || db.error !== undefined) {
    return unknownCheck(
      "ingestion_live",
      "the store could not be read (see db_schema_current)",
    );
  }

  // Three-valued: "never stamped" is a first run, not a fault.
  const lastPollTs = db.lastPollTs ?? null;
  if (lastPollTs === null) {
    return ok("no successful poll recorded yet (first run)");
  }

  const ageMs = now - lastPollTs;
  if (ageMs > INGESTION_STALE_MS) {
    return {
      entry: {
        name: "ingestion_live",
        ok: false,
        detail:
          "the poller process is ALIVE but its last successful getUpdates was " +
          `${Math.round(ageMs / 60_000)} minutes ago (meta.last_poll_ts) — ` +
          "inbound is not flowing",
        hint:
          "the process being up is not the same as messages arriving, and a " +
          "kill-0 liveness check cannot tell them apart. Read the poller log " +
          "in the state dir: repeated `Conflict: terminated by other " +
          "getUpdates request` means another consumer holds this bot token " +
          "(each agent needs its own); repeated `INGESTION STALL` with " +
          "respawns means the poller keeps restarting into that same " +
          "contention. Otherwise suspect a wedged long-poll or a black-holed " +
          "network.",
      },
      warn: false,
    };
  }

  return ok(`last successful poll ${Math.round(ageMs / 1000)}s ago`);
}
