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
 * 24 HOURS, CHOSEN FROM THE DISTRIBUTION rather than from intuition.
 *
 * The previous value was SEVEN DAYS, justified here as "longer than any
 * plausible quiet stretch for an agent whose operator uses it at all". That
 * reasoning was never checked against data, and when it finally was
 * (2026-08-23, 2532 inter-arrival gaps across the six live stores on
 * compute-04 that hold inbound rows) it turned out to be true in the worst
 * possible way:
 *
 *     p50   1m      p95    1.1h        7d fires on   0 / 2532   (0.00%)
 *     p75   4m      p99    9.1h       24h fires on   9 / 2532   (0.36%)
 *     p90  24m      p99.9  3.9d       max observed gap: 6.0d
 *
 * Seven days sat ABOVE THE LARGEST GAP EVER RECORDED. Not "generous" —
 * outside the observed range entirely, so it could not fire on anything that
 * had ever happened. That is §2's gate-that-cannot-fail wearing warn-style
 * clothes: a nudge that cannot nudge.
 *
 * And the 6.0d maximum is very likely not a healthy quiet at all. It belongs
 * to scitex-hub, whose inbound was dead for six days — the outage this check
 * exists to surface, sitting one day under the threshold meant to surface it.
 *
 * 24h clears p99 (9.1h) with room and fires on 0.36% of gaps: roughly one or
 * two events per store across their entire lifetimes. Still a NUDGE, not a
 * failure — see the warn-style note above, it never flips the report's
 * top-level `ok` — so the cost of firing is one visible line, and the cost of
 * NOT firing was six days of silence nobody was told about.
 *
 * BEFORE CHANGING THIS, RE-MEASURE. The number that was wrong here was wrong
 * because it was reasoned about rather than counted, and a replacement chosen
 * the same way would deserve the same fate. The measurement is one query over
 * `messages.created_at`; see the card below for the method (WAL replay, and
 * empty stores reported as unreadable rather than as quiet).
 *
 * Card: cct-409-limit-counts-consecutive-not-rate-and-health-asserts-liveness-20260822
 */
export const INBOUND_QUIET_WARN_MS = 86_400_000;

const DAY_MS = 86_400_000;

/** "14d" / "6h" / "3m" — coarse on purpose; the exact stamp is in the detail. */
function humanAge(ms: number): string {
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.max(0, Math.floor(ms / 60_000))}m`;
}

/**
 * The cursor, and the ASYMMETRY that makes it useful in only one direction.
 *
 * getUpdates advances the offset only over updates the poller ACKNOWLEDGED,
 * so the cursor's position relative to the newest STORED row says something —
 * but it says much more one way than the other:
 *
 *   offset == max_stored + 1   CONCLUSIVE. Every update Telegram delivered is
 *                              in the store, so a long quiet is a genuinely
 *                              quiet channel. This is what settled the
 *                              2026-08-11 scitex-storage case in one glance.
 *   offset >  max_stored + 1   NOT CONCLUSIVE, and emphatically not proof of
 *                              loss. update_id advances for reactions, edits,
 *                              chat-member changes and messages from senders
 *                              outside the allowlist — none of which becomes a
 *                              stored row. A chat anyone reacts to grows this
 *                              gap on its own, forever.
 *
 * THIS DOCSTRING USED TO SAY A GAP WAS "real loss, and the case worth waking
 * someone", and the hint below told a reader the same thing. That was WRONG,
 * and it contradicted `db_schema_current` in this same report, which had
 * already measured the false positive: scitex-hub, 2026-08-11, gap 1355,
 * reported implausible, ingestion demonstrably live. Chasing it leads to
 * resetting update_offset, which re-delivers up to 24h of Telegram's backlog —
 * messages the operator has already read. Only a gap of MILLIONS is diagnostic,
 * and `db_schema_current` owns that branch (POISONED_OFFSET_GAP).
 *
 * So this function REPORTS the gap and refuses to interpret it. The number is
 * worth showing; the conclusion was not ours to draw.
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
      `${maxUpdateId}) — expected: reactions, edits and non-allowlisted ` +
      "senders advance update_id without becoming rows"
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
          "genuinely idle channel makes. The cursor settles ONE of those and " +
          "not the other. offset == max_stored+1 is CONCLUSIVE: every update " +
          "Telegram ever sent is in the store, so the quiet is real and " +
          "nothing is wrong. Measured 2026-08-11 on scitex-storage — 14 days " +
          "quiet, 14/14 green, cursor idle — the operator had simply moved to " +
          "another channel, one message before the silence began. A GAP " +
          "(offset > max_stored+1) proves NOTHING on its own and is not " +
          "evidence of loss: reactions, edits and non-allowlisted senders all " +
          "advance update_id without becoming rows, so this number grows by " +
          "itself on any chat someone reacts to. Do NOT reset update_offset " +
          "on the strength of it — that re-delivers up to 24h of backlog the " +
          "operator has already read. db_schema_current owns the only gap " +
          "large enough to be diagnostic. To tell quiet from dead when the " +
          "cursor is not idle, send yourself a message and watch for the row.",
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
