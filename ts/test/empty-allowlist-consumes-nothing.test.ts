/**
 * THE REFUSAL MUST NOT CONSUME — the card's verification step 3, asserted.
 *
 * cct-refuse-to-start-...-20260816 spells out how to verify this defect:
 *
 *     "Unset the allowlist and start. Assert refusal, and assert the stored
 *      offset is UNCHANGED afterwards."
 *
 * The refusal itself is already covered by empty-allowlist-refuses.test.ts —
 * but that file only exercises the `allowlistIsUsable` PREDICATE. Proving the
 * predicate says "unusable" is not proving the poller stops before it eats
 * anything, and eating the operator's mail is the entire harm: on 2026-08-16
 * four of his updates were rejected AND the offset advanced past all four,
 * unrecoverably.
 *
 * KNOWN STRUCTURAL LIMIT, found by running this test and worth stating rather
 * than discovering during the next incident: the refusal calls
 * broadcastSystemAlert, and broadcast delivers TO THE ALLOWLIST. With an empty
 * allowlist there are no recipients, so the alert announcing that the allowlist
 * is empty cannot be delivered — loudfail logs "system alert has no recipients
 * (empty allowlist) — dropped". That is honest (it does not pretend to have
 * sent), but it means Telegram CANNOT carry this particular failure. The only
 * signals are the poller log, the non-zero exit, and supervision's eventual
 * give-up — which broadcasts through the same dead channel. Reaching a human
 * here would need a rail outside cct, and the 2026-07-17 retreat directive
 * forbids cct depending on scitex-cards for it. So this is a real limit of the
 * design, not an oversight to patch quietly.
 *
 * So this asserts the consequence, not the helper. The env is configured
 * BEFORE any import, because config.ts resolves its values at module load.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const STATE = mkdtempSync(join(tmpdir(), "cct-empty-allowlist-"));

// A token must exist or the poller has nothing to refuse ON. Both spellings
// must be set to the SAME value: getenv() rejects disagreeing aliases outright
// (TelegrammerEnvConflict), and the suite's harness may already export one.
const TOKEN = process.env.CLAUDE_CODE_TELEGRAMMER_BOT_TOKEN ?? "111111:AAAA";
process.env.CCT_BOT_TOKEN = TOKEN;
process.env.CLAUDE_CODE_TELEGRAMMER_BOT_TOKEN = TOKEN;
process.env.CCT_STATE_DIR = STATE;
process.env.CLAUDE_CODE_TELEGRAMMER_STATE_DIR = STATE;
// getenv() resolves THREE spellings (CCT_ / CLAUDE_CODE_TELEGRAMMER_ / legacy)
// and treats "" as absent, so every spelling must be cleared for the allowlist
// to be genuinely empty rather than accidentally satisfied by one of them.
for (const p of ["CCT_", "CLAUDE_CODE_TELEGRAMMER_"]) {
  delete process.env[`${p}ALLOWED_USERS`];
}

describe("an empty allowlist refuses BEFORE consuming anything", () => {
  test("startPolling makes ZERO Telegram calls and leaves the offset untouched", async () => {
    const { initStore } = await import("../lib/store.js");
    const { saveOffset, loadOffset } = await import("../lib/store-meta.js");
    initStore();

    // A non-zero offset that a consuming poller would advance past.
    const SEEDED = 4242;
    saveOffset(SEEDED);
    expect(loadOffset()).toBe(SEEDED);

    // Any HTTP at all is a failure: the offset can only move after getUpdates
    // returns updates, so zero calls is the strongest form of "consumed
    // nothing" — and it also catches a refusal placed after getMe.
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, ...rest: unknown[]) => {
      calls.push(String(url));
      return realFetch(url as string, ...(rest as []));
    }) as typeof fetch;

    try {
      const { startPolling } = await import("../lib/poller.js");
      await startPolling();
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls).toEqual([]);
    expect(loadOffset()).toBe(SEEDED);
    // Non-zero exit so a supervisor/operator has a fact, per the card.
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
