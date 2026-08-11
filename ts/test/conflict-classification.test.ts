/**
 * A 409 Conflict must be RECOGNISED as a conflict.
 *
 * MEASURED OUTAGE, scitex-hub, 2026-08-10 (poller-00ec09b9.log, 4h window):
 *
 *     161 x "getUpdates error: Telegram API getUpdates failed: Conflict:
 *            terminated by other getUpdates request; make sure that only one
 *            bot instance is running. Retrying in 3s..."
 *       5 x "INGESTION STALL — self-terminating for respawn"
 *       8 x "preempted previous poller (newest wins)"
 *       0 x "409 Conflict on getUpdates (n/30)"      <- never once
 *       0 x the FATAL stand-down + operator broadcast <- never once
 *
 * The poller classified conflicts with `errMsg.includes("409")`, but tgApi
 * throws `Telegram API <method> failed: ${json.description ?? res.status}` —
 * and when Telegram sends a 409 it ALWAYS sends a description, so the
 * numeric code is dropped on the floor and the thrown message contains the
 * word "Conflict" and no digits at all. Every conflict therefore fell into
 * the generic retry branch:
 *
 *   - consecutive409 never incremented, so MAX_CONSECUTIVE_409 never tripped
 *     and the one ACTIONABLE alert ("another consumer holds this bot token")
 *     was unreachable code in production;
 *   - no getUpdates ever returned, so recordSuccessfulPoll() was never
 *     called, the heartbeat froze, and at 180s the stall watchdog respawned
 *     the poller INTO the contention that was already blocking it.
 *
 * That self-feeding loop is why scitex-hub's inbound Telegram rail stored
 * nothing between 2026-07-08 and 2026-08-11 while every kill-0 liveness
 * check read green. Telegram only retains undelivered updates for 24h, so a
 * month of operator messages expired unread and unrecoverable.
 *
 * The lesson is the general one: never classify a typed failure by pattern
 * -matching the prose a producer happens to emit. The 409 is a NUMBER in the
 * response envelope; carry it, and test against the EXACT bytes Telegram
 * sends.
 */

import { describe, test, expect } from "bun:test";
import { TelegramApiError, isConflictError } from "../lib/telegram-api.js";

/** Telegram's real 409 envelope, verbatim from the Bot API. */
const CONFLICT_DESCRIPTION =
  "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running";

describe("TelegramApiError carries the envelope instead of flattening it", () => {
  test("error_code and description survive as named fields", () => {
    const err = TelegramApiError.fromEnvelope("getUpdates", {
      ok: false,
      error_code: 409,
      description: CONFLICT_DESCRIPTION,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.errorCode).toBe(409);
    expect(err.description).toBe(CONFLICT_DESCRIPTION);
    expect(err.method).toBe("getUpdates");
  });

  test("the human-readable message keeps BOTH the code and the description", () => {
    // Belt and braces: any legacy reader still doing a substring check on
    // the message now finds the number that used to be dropped.
    const err = TelegramApiError.fromEnvelope("getUpdates", {
      ok: false,
      error_code: 409,
      description: CONFLICT_DESCRIPTION,
    });

    expect(err.message).toContain("409");
    expect(err.message).toContain("Conflict");
    expect(err.message).toContain("getUpdates");
  });

  test("a missing error_code degrades to unknown, never to a wrong number", () => {
    // Three-valued: absent is its own answer, not silently 0 or 200.
    const err = TelegramApiError.fromEnvelope("sendMessage", {
      ok: false,
      description: "Bad Request: chat not found",
    });

    expect(err.errorCode).toBeUndefined();
    expect(err.description).toBe("Bad Request: chat not found");
  });
});

describe("isConflictError — the classifier the poll loop branches on", () => {
  test("THE REGRESSION: the exact error the 2026-08-10 outage produced", () => {
    // Reproduce what the OLD tgApi threw, byte for byte:
    //   `Telegram API ${method} failed: ${json.description ?? res.status}`
    const legacyMessage = `Telegram API getUpdates failed: ${CONFLICT_DESCRIPTION}`;

    // The old rule, stated as code so it cannot be argued with. This is the
    // single `false` that cost a month of inbound messages.
    expect(legacyMessage.includes("409")).toBe(false);

    // The new rule gets it right from either shape — the envelope we now
    // carry, and the flattened message an older build still produces.
    const fromEnvelope = TelegramApiError.fromEnvelope("getUpdates", {
      ok: false,
      error_code: 409,
      description: CONFLICT_DESCRIPTION,
    });
    expect(isConflictError(fromEnvelope)).toBe(true);
    expect(isConflictError(new Error(legacyMessage))).toBe(true);
  });

  test("classifies on the numeric code, not on the prose", () => {
    // Same code, description Telegram might reword tomorrow. Still a conflict.
    const reworded = TelegramApiError.fromEnvelope("getUpdates", {
      ok: false,
      error_code: 409,
      description: "some future wording we do not control",
    });

    expect(isConflictError(reworded)).toBe(true);
  });

  test("falls back to the description when the code was lost upstream", () => {
    // Defence in depth for any path that still flattens the envelope into a
    // plain Error (an older build, a re-thrown message).
    const flattened = new Error(
      `Telegram API getUpdates failed: ${CONFLICT_DESCRIPTION}`,
    );

    expect(isConflictError(flattened)).toBe(true);
  });

  test("does NOT fire on other Telegram failures", () => {
    // A negative assertion needs a positive control, and these are it: the
    // classifier must separate conflicts from the neighbours that share the
    // same envelope shape, or "no conflict" would pass for free.
    const rateLimited = TelegramApiError.fromEnvelope("getUpdates", {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 5",
    });
    const unauthorized = TelegramApiError.fromEnvelope("getUpdates", {
      ok: false,
      error_code: 401,
      description: "Unauthorized",
    });
    const badRequest = TelegramApiError.fromEnvelope("sendMessage", {
      ok: false,
      error_code: 400,
      description: "Bad Request: chat not found",
    });

    expect(isConflictError(rateLimited)).toBe(false);
    expect(isConflictError(unauthorized)).toBe(false);
    expect(isConflictError(badRequest)).toBe(false);
  });

  test("does NOT fire on transport failures or unrelated errors", () => {
    expect(isConflictError(new Error("fetch failed"))).toBe(false);
    expect(isConflictError(new Error("ECONNRESET"))).toBe(false);
    expect(isConflictError(undefined)).toBe(false);
    expect(isConflictError(null)).toBe(false);
    expect(isConflictError("Conflict")).toBe(false); // not an Error at all
  });

  test("does NOT fire on a merge-conflict-shaped message from elsewhere", () => {
    // "conflict" is an ordinary English word. Only Telegram's own
    // `Conflict:` prefix (or the 409 code) may count.
    expect(
      isConflictError(new Error("git rebase failed: conflict in poller.ts")),
    ).toBe(false);
  });
});
