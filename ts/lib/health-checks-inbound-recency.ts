import { unknownCheck } from "./health-checks.js";
/**
 * `inbound_recency` — WHEN did the last inbound message actually land?
 *
 * Its own module for the same reason health-checks-ingestion.ts is: this
 * answers its own question, against its own signal, with its own threshold.
 *
 * WHY IT EXISTS. On 2026-08-11 the scitex-storage agent's inbound rail had
 * stored nothing for FOURTEEN DAYS and every check read green — including
 * `ingestion_live`, the check written specifically to catch a silent inbound
 * outage:
 *
 *     poller_alive     ok   (kill-0 on a live pid)
 *     ingestion_live   ok   "last successful poll 13s ago"
 *     db_schema_current ok  schema_version=2, offset plausible
 *
 *     store: newest inbound = 2026-07-28 08:02, rows after 2026-07-29 = 0
 *     poller log: a start line on 2026-07-29, then nothing until the restart
 *
 * `ingestion_live` keys on meta.last_poll_ts, which recordSuccessfulPoll()
 * stamps on a successful POLL. That correctly separates "the process exists"
 * from "polling works". It cannot separate "polling works and the channel is
 * quiet" from "polling works and nothing is reaching the store", because a
 * getUpdates that succeeds with zero updates looks identical to both. Fourteen
 * days of silence is exactly what a quiet channel looks like to it.
 *
 * So poller_alive asks "does the process exist?", ingestion_live asks "are
 * polls succeeding?", and this asks "has anything ARRIVED?". The outage lived
 * in the gap after the second question, so the gap gets its own check.
 *
 * WHAT THIS CHECK DELIBERATELY DOES NOT DO: claim the rail is broken. An agent
 * whose operator simply has not written in a fortnight is healthy, and a check
 * that goes red on that is a false-alarm generator. This check cannot tell a
 * quiet channel from a dead one — nothing inside this process can — so it says
 * so, in those words, and is WARN-STYLE: it never flips the report's top-level
 * `ok`. Its job is to put the number where a reader will see it, next to the
 * poll age, so that "polls fresh / nothing stored in 14 days" is a diagnosis at
 * a glance. Either number alone is not.
 */

import type { DbProbe, PollerProbe } from "./health.js";
import { skippedDisabled, type CheckOutcome } from "./health-checks.js";

/**
 * How long the store may go without a new inbound message before the report
 * says so out loud.
 *
 * Seven days is chosen to be longer than any plausible quiet stretch for an
 * agent whose operator uses it at all, and far shorter than the fourteen days
 * this went unnoticed. It is a NUDGE threshold, not a failure threshold — see
 * the warn-style note above — so erring long costs visibility, not correctness.
 */
export const INBOUND_QUIET_WARN_MS = 604_800_000;

const DAY_MS = 86_400_000;

/** "14d" / "6h" / "3m" — coarse on purpose; the exact stamp is in the detail. */
function humanAge(ms: number): string {
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.max(0, Math.floor(ms / 60_000))}m`;
}

/**
 * IDLE vs LOSSY, the distinction a stale timestamp alone cannot make.
 *
 * getUpdates advances the offset only over updates the poller ACKNOWLEDGED.
 * So the cursor's position relative to the newest update actually stored is
 * the discriminator:
 *
 *   offset == max_stored + 1   every delivered update is in the store. A long
 *                              quiet is then genuinely a quiet channel.
 *   offset >  max_stored + 1   updates were acknowledged and never stored —
 *                              real loss, and the case worth waking someone.
 *
 * Derived by hand at 06:00 on 2026-08-11 to tell those apart; it belongs in
 * the check so nobody has to derive it again.
 */
function describeCursor(
  updateOffset: number | null,
  maxUpdateId: number | null,
): string {
  if (updateOffset === null || maxUpdateId === null) {
    return "cursor not comparable (offset or max stored update_id unknown)";
  }
  const gap = updateOffset - (maxUpdateId + 1);
  if (gap === 0) {
    return `cursor idle (offset ${updateOffset} == max stored update_id + 1)`;
  }
  if (gap > 0) {
    return (
      `cursor AHEAD by ${gap} (offset ${updateOffset}, max stored ` +
      `${maxUpdateId}) — that many updates were acknowledged but not stored`
    );
  }
  return (
    `cursor BEHIND by ${-gap} (offset ${updateOffset}, max stored ` +
    `${maxUpdateId}) — the store holds updates past the persisted offset`
  );
}

/** Build the `inbound_recency` entry. Pure; `now` is injected. */
export function checkInboundRecency(
  db: DbProbe,
  poller: PollerProbe | null,
  now: number,
): CheckOutcome {
  const report = (
    detail: string,
    hint: string | null = null,
  ): CheckOutcome => ({
    entry: { name: "inbound_recency", ok: true, detail, hint },
    warn: false,
  });

  // No token → no poller → nothing can arrive by design. bot_token_present
  // already reports the disabled state loudly; uses the SHARED skip marker so
  // a tokenless agent's report stays uniform.
  if (poller === null) return skippedDisabled("inbound_recency");

  if (!db.exists || db.error !== undefined) {
    return unknownCheck(
      "inbound_recency",
      "the store could not be read (see db_schema_current)",
    );
  }

  // Optional field: an older adapter or fixture that does not supply it must
  // skip, not fail. Absent and null mean different things and are kept apart:
  // absent ⇔ nobody asked, null ⇔ asked and the store holds no inbound row.
  if (db.newestInboundMs === undefined) {
    // Absent ⇔ nobody asked; null ⇔ asked and there is no row. "Nobody asked"
    // is a statement about the CALLER's capability, not about system health,
    // so it is a skip — not an unknown. Making it unknown would degrade every
    // older adapter's report for a question it never posed.
    return report("not evaluated — the probe did not report inbound recency");
  }
  if (db.newestInboundMs === null) {
    return report("no inbound message has ever been stored (first run)");
  }

  const ageMs = now - db.newestInboundMs;
  const stamp = new Date(db.newestInboundMs).toISOString();
  const cursor = describeCursor(db.updateOffset, db.maxUpdateId);

  if (ageMs > INBOUND_QUIET_WARN_MS) {
    return {
      entry: {
        name: "inbound_recency",
        ok: false,
        detail:
          `nothing has arrived in ${humanAge(ageMs)} — newest stored inbound ` +
          `is ${stamp}; ${cursor}. This check CANNOT tell a quiet channel ` +
          "from a dead rail; it reports the numbers so you can.",
        hint:
          "read it beside ingestion_live: polls fresh AND nothing stored for " +
          "days is the shape a silent outage makes — and also the shape a " +
          "genuinely idle channel makes. The CURSOR is what separates them. " +
          "offset == max_stored+1 means the cursor is idle: every update " +
          "Telegram ever sent is in the store, and the quiet is real. A GAP " +
          "(offset > max_stored+1) means updates were acknowledged and never " +
          "stored — that is loss, and it is the one that needs you. " +
          "Measured 2026-08-11 on scitex-storage: 14 days quiet, 14/14 green, " +
          "and the cursor said idle — the operator had simply moved to " +
          "another channel, one message before the silence began.",
      },
      // WARN-style on purpose: a genuinely idle agent must not read as
      // unhealthy. Visible in `checks`, never in the aggregate. A check that
      // announced "inbound is dead" from this signal would have been WRONG on
      // the very agent whose outage motivated it.
      warn: true,
    };
  }

  return report(
    `newest stored inbound ${humanAge(ageMs)} ago (${stamp}); ${cursor}`,
  );
}
