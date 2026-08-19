/**
 * A 409 AT STARTUP IS A REFUSAL, NOT A RETRY LOOP.
 *
 * Telegram returns 409 on getUpdates only when another getUpdates is already
 * open for the same token. That is not a transient network condition — it is a
 * statement that a second consumer exists.
 *
 * Before this change every 409 got the same treatment: 30 retries x 3s = ~90s
 * of silent backoff, justified by one specific case — our own predecessor
 * draining its long-poll after we took its pidfile. That case is real and the
 * grace is correct FOR IT.
 *
 * But it was applied to a case it does not describe. Measured on scitex-hub
 * 2026-08-16 (card cct-refuse-to-start-on-token-contention-...-20260816): two
 * agents genuinely shared one token (hash 00ec09b9 on two hosts). There was no
 * predecessor to drain, so the backoff was waiting for something that was never
 * going to happen; the conflict outlasted the window, the stall watchdog fired
 * at 180s, the poller exited "for respawn", and nothing respawned it. The
 * operator talked to an agent that could not hear him for 27 minutes.
 *
 * The distinguishing fact is already computed at startup and was simply unused:
 * claimAuthoritative() returns the OUTGOING pidfile snapshot. If we displaced a
 * LIVE predecessor, a drain is plausible and the long grace is earned. If we
 * displaced nobody, a 409 means a FOREIGN consumer holds the token and there is
 * nothing to wait for — so waiting is not patience, it is silence.
 */

import { describe, test, expect } from "bun:test";
import {
  startupConflictVerdict,
  STARTUP_409_LIMIT,
} from "../lib/startup-conflict.js";

describe("startupConflictVerdict", () => {
  test("no predecessor displaced: refuses almost immediately", () => {
    // Nobody to drain. The first 409 already means someone else holds it.
    for (let n = 1; n < STARTUP_409_LIMIT; n++) {
      expect(
        startupConflictVerdict({
          displacedLivePredecessor: false,
          hasPolledSuccessfully: false,
          consecutive409: n,
        }),
      ).toBe("retry");
    }
    expect(
      startupConflictVerdict({
        displacedLivePredecessor: false,
        hasPolledSuccessfully: false,
        consecutive409: STARTUP_409_LIMIT,
      }),
    ).toBe("refuse");
  });

  test("predecessor WAS displaced: keeps the long drain grace", () => {
    // This is the case the 90s window was written for. Do not break it.
    expect(
      startupConflictVerdict({
        displacedLivePredecessor: true,
        hasPolledSuccessfully: false,
        consecutive409: STARTUP_409_LIMIT,
      }),
    ).toBe("retry");
    expect(
      startupConflictVerdict({
        displacedLivePredecessor: true,
        hasPolledSuccessfully: false,
        consecutive409: STARTUP_409_LIMIT + 5,
      }),
    ).toBe("retry");
  });

  test("after a successful poll it is no longer a STARTUP conflict", () => {
    // Mid-run 409 = a successor taking over from us, which is the designed
    // handoff. The per-iteration authority check owns that path; this
    // classifier must not hijack it.
    expect(
      startupConflictVerdict({
        displacedLivePredecessor: false,
        hasPolledSuccessfully: true,
        consecutive409: STARTUP_409_LIMIT + 99,
      }),
    ).toBe("retry");
  });

  test("the startup limit is seconds, not minutes", () => {
    // The card's wording: "a bounded retry for a genuine handoff is fine — one
    // or two attempts, seconds not minutes". Guard the intent, not the number:
    // at a 3s backoff this must stay well under the 180s stall threshold.
    expect(STARTUP_409_LIMIT).toBeLessThanOrEqual(3);
    expect(STARTUP_409_LIMIT * 3000).toBeLessThan(180_000);
  });
});
