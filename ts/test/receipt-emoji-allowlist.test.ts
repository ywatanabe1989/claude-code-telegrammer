/**
 * Receipt emoji must be on Telegram's setMessageReaction allowlist.
 *
 * This file exists because a COMMENT used to make this claim and the claim
 * was false. `config.ts` said "All four emojis are on Telegram's fixed
 * reaction whitelist" while RECEIPT_DONE was "✅" and RECEIPT_FAILED was
 * "❌" — neither of which Telegram accepts.
 *
 * The consequence was invisible in exactly the way that costs the most:
 *
 *   - the message was delivered and read normally
 *   - the reaction call failed with REACTION_INVALID, 100% of the time
 *   - the failure was a WARNING in a per-agent log nobody tails
 *   - so the operator saw NO acknowledgment on anything he sent, and a
 *     FAILED turn was equally blank, since stage 4 could not render either
 *
 * Measured 2026-08-10: 12 of 12 inbound messages that day failed their
 * receipt. The operator had previously reported "agents are ignoring me" as
 * an incident; an acknowledgment that cannot be drawn produces precisely
 * that impression while every health check stays green.
 *
 * A comment cannot fail. This can.
 */

import { describe, expect, test } from "bun:test";
import {
  RECEIPT_DELIVERED_EMOJI,
  RECEIPT_DONE_EMOJI,
  RECEIPT_FAILED_EMOJI,
  RECEIPT_READ_EMOJI,
  TELEGRAM_ALLOWED_REACTIONS,
} from "../lib/config";

describe("receipt emoji are all on Telegram's reaction allowlist", () => {
  const stages: ReadonlyArray<readonly [string, string]> = [
    ["delivered (stage 1)", RECEIPT_DELIVERED_EMOJI],
    ["read (stage 2)", RECEIPT_READ_EMOJI],
    ["done (stage 3)", RECEIPT_DONE_EMOJI],
    ["failed (stage 4)", RECEIPT_FAILED_EMOJI],
  ];

  for (const [label, emoji] of stages) {
    test(`${label} uses an emoji Telegram accepts`, () => {
      expect(TELEGRAM_ALLOWED_REACTIONS).toContain(emoji);
    });
  }

  test("the two emoji that caused the outage are still rejected", () => {
    // Guards the specific regression rather than the general rule: if
    // someone reinstates ✅ because it "looks right", this fails.
    expect(TELEGRAM_ALLOWED_REACTIONS).not.toContain("✅");
  });

  test("the failure emoji that was equally invisible is still rejected", () => {
    expect(TELEGRAM_ALLOWED_REACTIONS).not.toContain("❌");
  });

  test("every stage is visually distinct, so the operator can tell them apart", () => {
    // Four stages rendering as the same glyph would be as uninformative as
    // no receipt at all — the failure this whole mechanism exists to avoid.
    const used = stages.map(([, emoji]) => emoji);
    expect(new Set(used).size).toBe(used.length);
  });
});
