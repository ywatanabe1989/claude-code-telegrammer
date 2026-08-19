/**
 * AN EMPTY ALLOWLIST MUST REFUSE TO START — because starting DESTROYS mail.
 *
 * Two facts combine into data loss:
 *
 *   1. poller.ts's startup check is commented "fail loud if empty" and only
 *      log()s. The poller then polls on.
 *   2. handle-update.ts returns "ok" for a rejected message, and poller-batch
 *      treats "ok" as durable — so the offset advances PAST it.
 *
 * So a misconfigured allowlist does not merely refuse messages, it CONSUMES
 * them. Measured 2026-08-16: four of the operator's updates were rejected and
 * the offset advanced past all four. They could not be recovered; he was asked
 * to resend.
 *
 * Rejecting a stranger is correct and should still advance — otherwise a
 * stranger's message is redelivered forever. The bug is narrower: when NOTHING
 * can ever be accepted, polling can only destroy. A poller that consumes and
 * discards is worse than one that never ran.
 */

import { describe, test, expect } from "bun:test";
import { allowlistIsUsable } from "../lib/access.js";

describe("empty allowlist is a refusal, not a filter", () => {
  test("no users and no groups is UNUSABLE — nothing could ever be accepted", () => {
    expect(allowlistIsUsable({ allowFrom: [], groups: {} })).toBe(false);
  });

  test("one allowed user is usable", () => {
    expect(allowlistIsUsable({ allowFrom: ["8379369979"], groups: {} })).toBe(
      true,
    );
  });

  test("a group policy alone is usable — groups are a real grant", () => {
    // An agent may legitimately serve only a group chat and no DMs. Refusing
    // that configuration would be the opposite error: breaking a working
    // deployment to fix a broken one.
    expect(
      allowlistIsUsable({
        allowFrom: [],
        groups: { "-100123": { allowFrom: [] } },
      }),
    ).toBe(true);
  });
});
