/**
 * lib/health-adapters.ts::probePoller — "external" mode identity-aware
 * liveness (adversarial-review finding #2, follow-up to the poller/MCP-
 * server decoupling PR). No direct test coverage existed for probePoller
 * before this file.
 *
 * probePoller reads the GLOBAL STATE_DIR/LOCK_FILE/BOT_TOKEN_HASH
 * constants (lib/config.ts, fixed for the whole test process by
 * ts/test/preload.ts) rather than accepting them as parameters, so these
 * tests write directly into that shared state dir (cleaning up after
 * themselves in afterEach) rather than pointing probePoller at an
 * isolated temp dir.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  writeFileSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { probePoller } from "../lib/health-adapters.js";
import { STATE_DIR, LOCK_FILE, BOT_TOKEN_HASH } from "../lib/config.js";
import { pollerPidfilePath } from "../lib/takeover.js";

const PIDFILE_PATH = pollerPidfilePath(STATE_DIR, BOT_TOKEN_HASH);

function cleanup(): void {
  for (const p of [LOCK_FILE, PIDFILE_PATH]) {
    try {
      unlinkSync(p);
    } catch {
      // absent — fine
    }
  }
}

afterEach(cleanup);

describe("probePoller('self')", () => {
  test("returns our own pid unconditionally", () => {
    expect(probePoller("self")).toEqual({ kind: "self", pid: process.pid });
  });
});

/**
 * Wait until the spawned child's cmdline actually carries `marker`.
 *
 * Bun.spawn RETURNS BEFORE THE CHILD HAS EXEC'D. Until it does,
 * /proc/<pid>/cmdline is empty or still the parent's, so a probe that reads it
 * immediately sees no marker and reports the process NOT alive — a failure
 * about scheduling, not about the code under test.
 *
 * Measured on the unchanged branch, same host: both cases in this file pass
 * when the file runs alone and fail intermittently in a full-suite run, which
 * is exactly the load-dependent signature of this race. Waiting for the
 * precondition makes the test assert what it means to assert.
 */
async function waitForCmdline(pid: number, marker: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (raw.includes(marker)) return;
    } catch {
      // The child may not have a /proc entry yet — keep waiting.
    }
    await Bun.sleep(10);
  }
  throw new Error(
    `child ${pid} never exec'd with a cmdline containing "${marker}" ` +
      `within 5s — the fixture, not the probe, is what failed`,
  );
}

describe("probePoller('external')", () => {
  test("neither lock file nor pidfile present -> both null/not-alive", () => {
    cleanup();
    const p = probePoller("external");
    expect(p).toMatchObject({
      kind: "external",
      lockPid: null,
      lockAlive: false,
      pidfilePid: null,
      pidfileAlive: false,
    });
  });

  test("lock/pidfile record OUR OWN (alive, non-matching) pid -> reported NOT alive (identity mismatch, adversarial-review finding #2)", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, String(process.pid));
    writeFileSync(PIDFILE_PATH, `${process.pid}\n${Date.now()}\n`);

    const p = probePoller("external");
    expect(p.lockPid).toBe(process.pid);
    // This bun:test process is alive (kill-0 would pass) but its cmdline
    // does NOT contain "telegram-server" — must NOT read as a healthy
    // server, exactly the reused-PID failure mode this fix closes.
    expect(p.lockAlive).toBe(false);
    expect(p.pidfilePid).toBe(process.pid);
    expect(p.pidfileAlive).toBe(false);
  });

  test("pidfile records a real process whose cmdline DOES match the poller marker -> pidfileAlive:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cct-health-adapters-"));
    const fixture = join(dir, "telegram-poller-marker-fixture.ts");
    writeFileSync(fixture, "setTimeout(() => {}, 5000);\n");
    const child = Bun.spawn([process.execPath, "run", fixture], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitForCmdline(child.pid, "telegram-poller-marker-fixture");
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(PIDFILE_PATH, `${child.pid}\n${Date.now()}\n`);

      const p = probePoller("external");
      expect(p.pidfilePid).toBe(child.pid);
      expect(p.pidfileAlive).toBe(true);
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lock file records a real process whose cmdline DOES match the server marker -> lockAlive:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cct-health-adapters-"));
    const fixture = join(dir, "telegram-server-marker-fixture.ts");
    writeFileSync(fixture, "setTimeout(() => {}, 5000);\n");
    const child = Bun.spawn([process.execPath, "run", fixture], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await waitForCmdline(child.pid, "telegram-server-marker-fixture");
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(LOCK_FILE, String(child.pid));

      const p = probePoller("external");
      expect(p.lockPid).toBe(child.pid);
      expect(p.lockAlive).toBe(true);
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
