/**
 * THE POLLER'S REFUSALS, ASSERTED ON A REAL PROCESS — card verification 1 & 3.
 *
 * cct-refuse-to-start-...-20260816 asks for two things this file provides:
 *
 *   1. "Start a second poller against a token already held. Assert it EXITS
 *      non-zero with a message naming the holder. A run that happens to win
 *      the race is not evidence."
 *   3. "Unset the allowlist and start. Assert refusal, and assert the stored
 *      offset is UNCHANGED afterwards."
 *
 * WHY A SUBPROCESS, and not an in-process import. config.ts resolves STATE_DIR,
 * the token and the allowlist ONCE at module load. Inside `bun test` the whole
 * suite shares a module registry, so whichever test file imports config first
 * freezes those values for every file after it — an in-process version of this
 * test passed alone and failed in the suite, refusing for the ALLOWLIST reason
 * while claiming to test the 409 reason. It only failed loudly because it also
 * asserted "pidfile=", a string unique to the 409 refusal; without that control
 * it would have PASSED FOR THE WRONG REASON, which is the exact defect this
 * card exists to punish.
 *
 * A child process has its own registry and its own env, so each case gets the
 * config it declares. It is also a more faithful reading of the card: "assert
 * it EXITS non-zero" is a statement about a process, and only a process has an
 * exit code.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const LIB = join(import.meta.dir, "..", "lib");

/** Run a poller in a child process with `env`, returning its exit + stderr. */
async function runPoller(
  env: Record<string, string>,
  fetchStub: string,
): Promise<{ exitCode: number; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cct-refusal-"));
  const driver = join(dir, "driver.ts");
  writeFileSync(
    driver,
    `globalThis.fetch = (${fetchStub}) as typeof fetch;\n` +
      `const { startPolling } = await import(${JSON.stringify(join(LIB, "poller.ts"))});\n` +
      `const { initStore } = await import(${JSON.stringify(join(LIB, "store.ts"))});\n` +
      `await initStore();\n` +
      `if (process.env.SEED_OFFSET) {\n` +
      `  const m = await import(${JSON.stringify(join(LIB, "store-meta.ts"))});\n` +
      `  await m.saveOffset(Number(process.env.SEED_OFFSET));\n` +
      `}\n` +
      `await startPolling();\n` +
      `if (process.env.SEED_OFFSET) {\n` +
      `  const m = await import(${JSON.stringify(join(LIB, "store-meta.ts"))});\n` +
      `  process.stderr.write("FINAL_OFFSET=" + (await m.loadOffset()) + "\\n");\n` +
      `}\n` +
      `process.exit(process.exitCode ?? 0);\n`,
  );

  const proc = Bun.spawn(["bun", "run", driver], {
    // Its own namespace: this child seeds a getUpdates offset, and the shared
    // suite namespace has tests asserting on that exact key. The cct_test_
    // prefix keeps lib/hermetic-guard.ts satisfied, and the epoch in third
    // position is what the preload's stale-namespace sweep reads.
    env: {
      ...process.env,
      CCT_STATE_DIR: dir,
      CCT_STORE_SCHEMA: `cct_test_${Date.now()}_refusal_${process.pid}`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

// Setup calls succeed; every getUpdates conflicts, so there is no race to win.
const ALWAYS_409 = `async (url: unknown) => {
  const u = String(url);
  const body = u.includes("/getUpdates")
    ? { ok: false, error_code: 409, description: "Conflict" }
    : u.includes("/getMe")
      ? { ok: true, result: { username: "testbot" } }
      : { ok: true, result: true };
  return new Response(JSON.stringify(body), {
    status: u.includes("/getUpdates") ? 409 : 200,
    headers: { "content-type": "application/json" },
  });
}`;

// Any call at all is a failure for the allowlist case, so record and refuse.
const FORBID_ALL = `async (url: unknown) => {
  process.stderr.write("UNEXPECTED_FETCH=" + String(url) + "\\n");
  return new Response("{}", { status: 200 });
}`;

describe("a startup 409 with no displaced predecessor is a refusal", () => {
  test("exits non-zero naming the token, state dir and pidfile", async () => {
    const { exitCode, stderr } = await runPoller(
      {
        CCT_BOT_TOKEN: "222222:BBBB",
        CLAUDE_CODE_TELEGRAMMER_BOT_TOKEN: "222222:BBBB",
        // A usable allowlist, so a refusal here can ONLY be the 409 one.
        CCT_ALLOWED_USERS: "8379369979",
        CLAUDE_CODE_TELEGRAMMER_ALLOWED_USERS: "8379369979",
      },
      ALWAYS_409,
    );

    expect(stderr).toContain("REFUSING TO START");
    expect(stderr).toContain("409");
    // "Naming the holder" is the card's requirement — a bare failure is not it.
    expect(stderr).toContain("token=");
    expect(stderr).toContain("state_dir=");
    expect(stderr).toContain("pidfile=");
    expect(exitCode).toBe(1);
  }, 60_000);
});

describe("an empty allowlist refuses before consuming anything", () => {
  test("makes ZERO Telegram calls and leaves the stored offset untouched", async () => {
    const { exitCode, stderr } = await runPoller(
      {
        CCT_BOT_TOKEN: "333333:CCCC",
        CLAUDE_CODE_TELEGRAMMER_BOT_TOKEN: "333333:CCCC",
        CCT_ALLOWED_USERS: "",
        CLAUDE_CODE_TELEGRAMMER_ALLOWED_USERS: "",
        SEED_OFFSET: "4242",
      },
      FORBID_ALL,
    );

    expect(stderr).toContain("REFUSING TO START: the allow list is empty");
    // Zero HTTP is the strongest form of "consumed nothing": the offset can
    // only move after getUpdates returns updates. It also catches a refusal
    // placed after deleteWebhook, which is where this one used to sit.
    expect(stderr).not.toContain("UNEXPECTED_FETCH=");
    expect(stderr).toContain("FINAL_OFFSET=4242");
    expect(exitCode).toBe(1);
  }, 60_000);
});
