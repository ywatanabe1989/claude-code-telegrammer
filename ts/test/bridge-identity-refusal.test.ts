/**
 * The poller must REFUSE to start when the turn bridge belongs to someone else
 * — and must NOT refuse when it merely cannot tell.
 *
 * Driven as a CHILD PROCESS for the same reason as poller-refusals-exit.test.ts:
 * config.ts resolves TURN_URL / AGENT_ID once at module load and `bun test`
 * shares one module registry, so an in-process version would inherit whichever
 * file imported config first and silently test the wrong thing.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const LIB = join(import.meta.dir, "..", "lib");

async function runPoller(
  env: Record<string, string>,
  fetchStub: string,
): Promise<{ exitCode: number; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cct-bridge-id-"));
  const driver = join(dir, "driver.ts");
  writeFileSync(
    driver,
    `globalThis.fetch = (${fetchStub}) as typeof fetch;\n` +
      `const { initStore } = await import(${JSON.stringify(join(LIB, "store.ts"))});\n` +
      `initStore();\n` +
      `const { startPolling } = await import(${JSON.stringify(join(LIB, "poller.ts"))});\n` +
      `await startPolling();\n` +
      `process.exit(process.exitCode ?? 0);\n`,
  );
  const proc = Bun.spawn(["bun", "run", driver], {
    env: { ...process.env, CCT_STATE_DIR: dir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

const TOKEN = "444444:DDDD";
const baseEnv = {
  CCT_BOT_TOKEN: TOKEN,
  CLAUDE_CODE_TELEGRAMMER_BOT_TOKEN: TOKEN,
  // A usable allowlist, so any refusal can ONLY be the bridge-identity one.
  CCT_ALLOWED_USERS: "8379369979",
  CLAUDE_CODE_TELEGRAMMER_ALLOWED_USERS: "8379369979",
  CCT_AGENT_ID: "scitex-cards",
  CLAUDE_CODE_TELEGRAMMER_AGENT_ID: "scitex-cards",
  CCT_TURN_URL: "http://127.0.0.1:19003/v1/turn",
  CLAUDE_CODE_TELEGRAMMER_TURN_URL: "http://127.0.0.1:19003/v1/turn",
};

/** /health names a DIFFERENT agent — the live 2026-08-19 defect. */
const HEALTH_FOREIGN = `async (url: unknown) => {
  const u = String(url);
  if (u.endsWith("/health")) {
    return new Response(JSON.stringify({ status: "ok", agent: "scitex-agent-container" }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  // sendMessage is EXPECTED: the refusal alerts the operator, and outbound
  // never traverses the turn bridge. Anything on the INBOUND machinery is not.
  if (u.includes("/sendMessage")) {
    process.stderr.write("ALERTED_OPERATOR\\n");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  process.stderr.write("TOUCHED_INBOUND=" + u + "\\n");
  // 409 on getUpdates so the child TERMINATES even when the identity refusal
  // is absent — otherwise removing the refusal makes this test hang instead of
  // going red, and a gate whose failure mode is a timeout is a weaker gate.
  if (u.includes("/getUpdates")) {
    return new Response(JSON.stringify({ ok: false, error_code: 409, description: "Conflict" }),
      { status: 409, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, result: true }),
    { status: 200, headers: { "content-type": "application/json" } });
}`;

/** /health unreachable — an older bridge. Must NOT refuse. */
const HEALTH_DEAD = `async (url: unknown) => {
  const u = String(url);
  if (u.endsWith("/health")) throw new Error("ECONNREFUSED");
  if (u.includes("/getUpdates")) {
    process.stderr.write("REACHED_GETUPDATES\\n");
    return new Response(JSON.stringify({ ok: false, error_code: 409, description: "Conflict" }),
      { status: 409, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, result: true }),
    { status: 200, headers: { "content-type": "application/json" } });
}`;

describe("a turn bridge serving another agent stops the poller", () => {
  test("REFUSES, names both agents, and exits non-zero", async () => {
    const { exitCode, stderr } = await runPoller(baseEnv, HEALTH_FOREIGN);
    expect(stderr).toContain("REFUSING TO START: the turn bridge");
    expect(stderr).toContain("scitex-agent-container"); // who is squatting
    expect(stderr).toContain("scitex-cards"); // who we are
    // Refused before touching the INBOUND machinery — no deleteWebhook,
    // no getMe, no getUpdates. It does call sendMessage, and that is the
    // point: outbound bypasses the turn bridge, so unlike the empty-allowlist
    // refusal this one actually reaches the operator.
    expect(stderr).not.toContain("TOUCHED_INBOUND=");
    expect(stderr).toContain("ALERTED_OPERATOR");
    expect(exitCode).toBe(1);
  }, 60_000);
});

describe("UNKNOWN is not a refusal — an older bridge must keep working", () => {
  test("an unreachable /health proceeds to polling rather than stopping", async () => {
    const { stderr } = await runPoller(baseEnv, HEALTH_DEAD);
    // The identity refusal must NOT appear...
    expect(stderr).not.toContain("REFUSING TO START: the turn bridge");
    // ...and the poller must have gone on to actually poll.
    expect(stderr).toContain("REACHED_GETUPDATES");
  }, 60_000);
});
