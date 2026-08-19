/**
 * Should a 409 Conflict during STARTUP be retried, or refused?
 *
 * Telegram returns 409 on getUpdates only when another getUpdates is already
 * open for the same token. It is never a transient network condition: it is a
 * statement that a second consumer exists. The only question is WHO.
 *
 * Two situations produce it and they want opposite responses:
 *
 *   OUR PREDECESSOR IS DRAINING.  We just took the pidfile from a live poller;
 *   its long-poll has not returned yet. It will exit on its next authority
 *   check. Waiting is correct, and ~90s covers Telegram's 30s long-poll cap
 *   with margin. This is what the original backoff was written for.
 *
 *   A FOREIGN CONSUMER HOLDS THE TOKEN.  Nobody was in the pidfile, or the
 *   process there was already dead — so there is no drain in flight and
 *   nothing will yield. Here the backoff is not patience, it is silence: we
 *   retry for 90 seconds, give up, and (measured 2026-08-16) exit into a void
 *   where nothing respawns us, while the operator keeps typing.
 *
 * The fact that separates them is already computed and was simply unused:
 * `claimAuthoritative()` returns the OUTGOING pidfile snapshot. Displacing a
 * live predecessor earns the long grace; displacing nobody does not.
 *
 * AFTER the first successful poll this classifier stands down entirely. A 409
 * then means a SUCCESSOR is taking over from us, which is the designed handoff
 * and belongs to the per-iteration authority check, not here.
 */

/**
 * Attempts tolerated at startup when no predecessor was displaced.
 *
 * Deliberately small. The card's wording is "one or two attempts, seconds not
 * minutes" — the point of refusing is that it happens while someone is still
 * watching the restart, not three minutes later in a log nobody reads.
 *
 * Kept as a named constant so the test can assert the INTENT (well under the
 * 180s stall threshold at a 3s backoff) rather than a magic number.
 */
export const STARTUP_409_LIMIT = 3;

export interface StartupConflictInput {
  /** Did claimAuthoritative() displace a LIVE predecessor for this token? */
  displacedLivePredecessor: boolean;
  /** Has any getUpdates call succeeded yet in this process? */
  hasPolledSuccessfully: boolean;
  /** Consecutive 409s so far, including the one being classified. */
  consecutive409: number;
}

/**
 * "retry"  — back off and try again; the caller keeps its existing limits.
 * "refuse" — stop, name the holder, and exit NON-ZERO. Never fall through to
 *            a stall: an exit code is a fact a supervisor can act on, whereas
 *            a wedged poller looks alive to every liveness check we have.
 */
export function startupConflictVerdict(
  input: StartupConflictInput,
): "retry" | "refuse" {
  // Not a startup conflict at all — a successor is preempting us.
  if (input.hasPolledSuccessfully) return "retry";

  // Our own predecessor may still be draining; the long grace is earned.
  if (input.displacedLivePredecessor) return "retry";

  // Nobody to wait for.
  return input.consecutive409 >= STARTUP_409_LIMIT ? "refuse" : "retry";
}
