/**
 * Ingestion coverage — can this store VOUCH for the window it is showing you?
 *
 * WHY THIS EXISTS (incident 2026-08-10, scitex-dev's bridge, measured):
 *
 *   Its store's last row was 16:01:22. The next was 00:36:26 — 8h35m later.
 *   In between, the operator sent at least six messages that the agent
 *   received and acted on, and the agent sent thirteen replies that Telegram
 *   accepted. None of it was written. Meanwhile the poller log for that window
 *   is COMPLETELY EMPTY (no error, no 409, no stall alarm) and the persisted
 *   getUpdates offset never moved off 882957028 across four restarts.
 *
 *   `get_unread` returned `[]` for that window — the same `[]` it returns when
 *   the operator genuinely said nothing.
 *
 * That is the exact failure the fleet's restart protocol exists to prevent:
 * "check your operator channel ... do NOT assume a quiet inbox means nothing
 * was sent." The instruction is correct and the store could not honour it,
 * because an empty result carried no statement about its own completeness.
 *
 * WHY THE EXISTING WATCHDOG DOES NOT COVER THIS: lib/poll-watchdog.ts stamps
 * its heartbeat whenever getUpdates RETURNS — including a return of zero
 * updates, which is what a healthy long-poll does all day. So
 *
 *     "getUpdates returns empty forever"  ==  "the operator is not talking"
 *
 * to that watchdog, and it stayed silent for 8.5 hours. A gate that cannot
 * fail is not a gate (constitution §2). This module adds the signal the
 * heartbeat cannot carry, and keeps the two SEPARATE rather than collapsing
 * them into one boolean:
 *
 *   - verdict     — about NOW: is ingestion demonstrably live, so an empty
 *                   answer means "nothing arrived" rather than "nobody was
 *                   listening"? Driven purely by poll freshness.
 *   - lastGap*    — historical FACT: a discontinuity in Telegram's update_id
 *                   sequence was observed at T, so N updates that Telegram
 *                   counted never reached this store. Recorded forever,
 *                   because a hole in the record does not heal; NOT folded
 *                   into the verdict, because a permanent alarm is noise.
 *
 * Three-valued by construction: "covered", "unverifiable", and — for the gap
 * history — `null` meaning "no discontinuity has ever been observed", which
 * is not the same as "there was none".
 */

/** NOW-verdict: can an empty answer be read as a genuine absence? */
export type CoverageVerdict = "covered" | "unverifiable";

/**
 * How stale the poll heartbeat may get before an empty answer stops being
 * trustworthy. The poller's long-poll caps at 30s and its error backoff is 3s,
 * so a healthy loop stamps well inside this; 180s matches the stall
 * watchdog's own threshold (lib/poll-watchdog.ts DEFAULT_STALL_SECONDS) so the
 * two agree about what "recently alive" means.
 */
export const DEFAULT_POLL_STALENESS_MS = 180_000;

/**
 * The FIXED shape every coverage answer takes. Never a bare boolean, never a
 * key that is sometimes absent: a caller must not have to guess which fields
 * exist on this call (constitution §2).
 */
export interface IngestionCoverage {
  verdict: CoverageVerdict;
  /** Epoch-ms of the last getUpdates that returned; null = never polled. */
  lastPollTs: number | null;
  /** ms since that return; null when lastPollTs is null. */
  pollStaleMs: number | null;
  /** The staleness budget the verdict was judged against. */
  stalenessThresholdMs: number;
  /** Epoch-ms of the most recent observed update_id discontinuity; null = none observed. */
  lastGapAt: number | null;
  /** How many update_ids Telegram counted that never reached this store at that gap. */
  lastGapMissedUpdates: number | null;
  /** Human-readable verdict + what to DO about it. Never empty. */
  reason: string;
}

export interface CoverageInputs {
  /** Epoch-ms of the last successful getUpdates return (0 / null = never). */
  lastPollTs: number | null;
  /** Epoch-ms of the most recent recorded discontinuity (null = none). */
  lastGapAt: number | null;
  /** Missed update count at that discontinuity (null = none recorded). */
  lastGapMissedUpdates: number | null;
  /** Injectable clock (epoch-ms). */
  now?: number;
  /** Injectable staleness budget. */
  stalenessThresholdMs?: number;
}

function describeGap(at: number | null, missed: number | null): string {
  if (at === null) return "";
  const when = new Date(at).toISOString();
  const n = missed === null ? "an unknown number of" : String(missed);
  return (
    ` A discontinuity was recorded at ${when}: ${n} update(s) Telegram counted` +
    " never reached this store, so history around that time has a hole that" +
    " re-reading cannot fill."
  );
}

/**
 * Build the coverage answer. Pure — every input is injected — so the verdict
 * logic is unit-testable with no store, no clock and no network.
 */
export function buildCoverage(inputs: CoverageInputs): IngestionCoverage {
  const now = inputs.now ?? Date.now();
  const stalenessThresholdMs =
    inputs.stalenessThresholdMs ?? DEFAULT_POLL_STALENESS_MS;
  const lastPollTs =
    inputs.lastPollTs && inputs.lastPollTs > 0 ? inputs.lastPollTs : null;
  const pollStaleMs = lastPollTs === null ? null : now - lastPollTs;
  const gapNote = describeGap(inputs.lastGapAt, inputs.lastGapMissedUpdates);

  let verdict: CoverageVerdict;
  let reason: string;

  if (lastPollTs === null) {
    verdict = "unverifiable";
    reason =
      "NO poll heartbeat has ever been recorded in this store, so an empty" +
      " result says nothing about whether messages arrived. Check that the" +
      " poller is running (claude-code-telegrammer health) before treating a" +
      " quiet inbox as quiet." +
      gapNote;
  } else if (pollStaleMs !== null && pollStaleMs > stalenessThresholdMs) {
    verdict = "unverifiable";
    reason =
      `The last successful getUpdates was ${Math.round(
        pollStaleMs / 1000,
      )}s ago (budget ${Math.round(stalenessThresholdMs / 1000)}s), so this` +
      " store cannot vouch for that window: an empty result here is NOT" +
      " evidence that nothing was sent. Check the poller" +
      " (claude-code-telegrammer health) and re-read once it is polling." +
      gapNote;
  } else {
    verdict = "covered";
    reason =
      `Ingestion is live (last getUpdates ${Math.round(
        (pollStaleMs ?? 0) / 1000,
      )}s ago), so an empty result here does mean nothing arrived.` + gapNote;
  }

  return {
    verdict,
    lastPollTs,
    pollStaleMs,
    stalenessThresholdMs,
    lastGapAt: inputs.lastGapAt,
    lastGapMissedUpdates: inputs.lastGapMissedUpdates,
    reason,
  };
}

/**
 * Fail where the answer is BUILT, not three layers downstream in an agent's
 * reasoning (constitution §2). Throws on any malformed coverage object.
 */
export function assertValidCoverage(c: IngestionCoverage): void {
  if (c.verdict !== "covered" && c.verdict !== "unverifiable") {
    throw new Error(`IngestionCoverage.verdict invalid: ${String(c.verdict)}`);
  }
  if (c.lastPollTs !== null && !Number.isFinite(c.lastPollTs)) {
    throw new Error("IngestionCoverage.lastPollTs must be a number or null");
  }
  if ((c.lastPollTs === null) !== (c.pollStaleMs === null)) {
    throw new Error(
      "IngestionCoverage.pollStaleMs must be null exactly when lastPollTs is",
    );
  }
  if (!c.reason) {
    throw new Error(
      "IngestionCoverage.reason must say WHY and what to do — an empty reason" +
        " is how 'I could not tell' silently becomes 'yes'",
    );
  }
}
