/**
 * Tests for single-instance lock file logic (lock.ts).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We need to test acquireLock/releaseLock with a custom STATE_DIR/LOCK_FILE.
// Since lock.ts imports from config.ts which reads env at module level,
// and preload.ts already sets the env vars, we can import directly.
import { acquireLock, releaseLock } from "../lib/lock.js";
import { LOCK_FILE, STATE_DIR } from "../lib/config.js";

describe("lock", () => {
  test("a live pid that is NOT a telegram MCP server is a stale record: overwritten, never signalled", () => {
    // Measured 2026-09-05: the lockfile survives a container restart, the pid
    // namespace does not, so the recorded pid is reissued to some other
    // process within seconds. Stand in for that process with a `sleep` child:
    // alive, and its cmdline is not telegram-server. The OLD branch SIGTERMed
    // it; the new one must leave it running and just take the lock.
    mkdirSync(STATE_DIR, { recursive: true });
    const bystander = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(LOCK_FILE, String(bystander.pid));
      acquireLock();
      expect(readFileSync(LOCK_FILE, "utf8").trim()).toBe(String(process.pid));
      // Still alive: a SIGTERMed sleep would have exited by now.
      let alive = true;
      try {
        process.kill(bystander.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
    } finally {
      bystander.kill();
      releaseLock();
    }
  });

  beforeEach(() => {
    // Ensure clean state
    try {
      rmSync(LOCK_FILE);
    } catch {}
  });

  afterEach(() => {
    try {
      rmSync(LOCK_FILE);
    } catch {}
  });

  test("acquireLock creates lock file with current PID", () => {
    acquireLock();
    expect(existsSync(LOCK_FILE)).toBe(true);
    const content = readFileSync(LOCK_FILE, "utf8").trim();
    expect(content).toBe(String(process.pid));
  });

  test("releaseLock removes the lock file", () => {
    acquireLock();
    expect(existsSync(LOCK_FILE)).toBe(true);
    releaseLock();
    expect(existsSync(LOCK_FILE)).toBe(false);
  });

  test("releaseLock does not throw when no lock file exists", () => {
    expect(() => releaseLock()).not.toThrow();
  });

  test("acquireLock removes stale lock file (dead PID)", () => {
    // Write a lock file with a PID that almost certainly does not exist
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, "999999999", { mode: 0o600 });

    // Should not exit, should overwrite with current PID
    acquireLock();
    const content = readFileSync(LOCK_FILE, "utf8").trim();
    expect(content).toBe(String(process.pid));
  });

  test("acquireLock removes lock file with invalid content", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, "not-a-pid", { mode: 0o600 });

    acquireLock();
    const content = readFileSync(LOCK_FILE, "utf8").trim();
    expect(content).toBe(String(process.pid));
  });

  // Regression test for the evidence-derived-catch-blocks fix: a bare
  // read failure (readFileSync itself throwing) must NOT be reported as
  // "unparseable content" — that claim is only earned when the content
  // was actually read and just wasn't a valid pid. Force the read to
  // throw by pointing LOCK_FILE at a DIRECTORY (portable — no
  // chmod/permission tricks, which behave differently or not at all when
  // running as root).
  //
  // Note: acquireLock() unconditionally (re)writes the lockfile at the
  // very end, and that write ALSO fails here (can't write a file over an
  // existing directory), so the call still throws overall. That's fine —
  // the log call under test fires before that final write, so we can
  // assert on it and still expect the throw.
  test("logs 'could not read lockfile' (not 'unparseable content') when the lockfile itself can't be read", () => {
    mkdirSync(LOCK_FILE, { recursive: true });

    const writeSpy = spyOn(process.stderr, "write");
    try {
      expect(() => acquireLock()).toThrow();

      const logged = writeSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(logged).toContain(
        "could not read lockfile — proceeding to (re)claim it",
      );
      expect(logged).not.toContain(
        "removing lockfile with unparseable content",
      );
    } finally {
      writeSpy.mockRestore();
      rmSync(LOCK_FILE, { recursive: true, force: true });
    }
  });

  // ── NEWEST WINS (#37) ──────────────────────────────────────────────
  //
  // Previously acquireLock() exited when a LIVE PID held the lockfile
  // (oldest wins). After agent restarts that left bun pollers as orphans
  // attached to PID 1, the new poller would exit on lock-acquire and
  // the dead-parent zombie kept the bot stuck. Operator-pain bug.
  //
  // New semantic: acquireLock TAKES OVER the lockfile from a live
  // incumbent — best-effort SIGTERM (the incumbent's shutdown handler
  // releases voluntarily) then overwrite. The polling loop's
  // isAuthoritative() check (see lib/takeover.ts) handles the cross-
  // namespace case where SIGTERM doesn't reach.

  test("acquireLock takes over a lockfile held by a LIVE different PID (newest wins)", () => {
    // Use our PARENT pid as the "live other PID" — guaranteed alive
    // while bun-test runs us, and definitely not equal to our own pid.
    // We pass signalOutgoing=false so we DO NOT actually SIGTERM the
    // test runner (which would kill the suite with exit code 144).
    // The point of this test is the LOCKFILE OVERWRITE behaviour;
    // the SIGTERM-grace path is covered separately by a test that
    // spawns its own subprocess.
    const liveOtherPid = process.ppid;
    expect(liveOtherPid).not.toBe(process.pid);
    expect(liveOtherPid).toBeGreaterThan(0);

    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, String(liveOtherPid), { mode: 0o600 });

    // Old semantic would process.exit(1) here. New semantic: returns
    // normally and our PID owns the lockfile.
    acquireLock({ signalOutgoing: false });
    const content = readFileSync(LOCK_FILE, "utf8").trim();
    expect(content).toBe(String(process.pid));
  });

  test("acquireLock SIGTERMs the live incumbent and waits for it to exit (own subprocess)", async () => {
    // Spawn a sleep we control, write its PID into the lockfile, then
    // run acquireLock with the default (signalOutgoing=true). The
    // subprocess receives SIGTERM and exits inside the grace window;
    // acquireLock returns; the lockfile is ours; the subprocess is
    // dead. This is the integration test for the SIGTERM-grace path
    // without endangering the test orchestrator.
    //
    // The incumbent must LOOK like a telegram MCP server now: acquireLock
    // signals only a pid whose cmdline is telegram-server (a live pid with
    // any other cmdline is a recycled pid from a previous container and is
    // treated as stale - see the test above). `exec -a` sets argv[0], so
    // /proc/<pid>/cmdline reads "telegram-server" while the process is a
    // plain sleep with the default SIGTERM disposition.
    const child = Bun.spawn(["bash", "-c", "exec -a telegram-server sleep 30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const childPid = child.pid;
    expect(childPid).toBeGreaterThan(0);
    expect(childPid).not.toBe(process.pid);

    // Give the subprocess a moment to install its default signal
    // handler so the SIGTERM definitely terminates it.
    await new Promise((r) => setTimeout(r, 50));

    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, String(childPid), { mode: 0o600 });

    acquireLock(); // default signalOutgoing=true

    const content = readFileSync(LOCK_FILE, "utf8").trim();
    expect(content).toBe(String(process.pid));

    // After the grace window the subprocess should be dead.
    await child.exited; // waits at most a few ms more
    expect(
      child.exitCode === null ||
        child.exitCode !== 0 ||
        child.signalCode === "SIGTERM",
    ).toBe(true);
  });

  test("releaseLock does NOT unlink a lockfile held by a successor (preempted-then-shutdown)", () => {
    // We acquired the lock, then a newer poller wrote its own PID into
    // the lockfile (simulating successor takeover). Our shutdown
    // handler now runs — it must NOT unlink the successor's lockfile,
    // or the new process loses its single-instance guarantee.
    acquireLock();
    expect(readFileSync(LOCK_FILE, "utf8").trim()).toBe(String(process.pid));

    const successorPid = process.pid + 100000;
    writeFileSync(LOCK_FILE, String(successorPid), { mode: 0o600 });

    releaseLock();
    expect(existsSync(LOCK_FILE)).toBe(true);
    expect(readFileSync(LOCK_FILE, "utf8").trim()).toBe(String(successorPid));
  });
});
