/**
 * Per-token poller takeover ("newest wins").
 *
 * No mocks: real tmp dirs, real pidfiles, real fs syscalls. We exercise:
 *
 *   - pidfile path construction (token hash makes it per-bot)
 *   - pidfile read/write round-trip + parse
 *   - claimAuthoritative writes our PID and returns the outgoing snapshot
 *   - claimAuthoritative is idempotent when no prior claim exists
 *   - claimAuthoritative correctly OVERWRITES a previous claim
 *     (the central "newest wins" property — what previously was wrong)
 *   - isAuthoritative flips false after a newer poller's claim
 *   - releaseAuthoritative only unlinks when we still own the pidfile
 *     (must NOT tear down a successor's claim during our shutdown)
 *   - SIGTERM is NOT sent to a dead PID (avoid spurious EPERM-ish noise)
 *   - signalOutgoing=false skips the SIGTERM but still overwrites
 *
 * No process forking — we use signalOutgoing=false in tests that exercise
 * the overwrite path, and a separate isPidAlive-based test for liveness.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  agentIdFromEnviron,
  claimAuthoritative,
  isAuthoritative,
  isPidAlive,
  isProcessMatching,
  matchesAgentIdentity,
  pollerPidfilePath,
  readPidfile,
  releaseAuthoritative,
} from "../lib/takeover.js";

function freshStateDir(label: string): string {
  const dir = join(
    tmpdir(),
    `cct-takeover-${process.pid}-${Date.now()}-${label}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TOKEN_HASH = "deadbeef";

describe("takeover: pidfile path", () => {
  test("path is per-(stateDir, tokenHash)", () => {
    const a = pollerPidfilePath("/state/A", "abcd1234");
    const b = pollerPidfilePath("/state/A", "ffff0000");
    const c = pollerPidfilePath("/state/B", "abcd1234");
    expect(a).toBe("/state/A/poller-abcd1234.pid");
    expect(b).toBe("/state/A/poller-ffff0000.pid");
    expect(c).toBe("/state/B/poller-abcd1234.pid");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("takeover: readPidfile", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = freshStateDir("readpidfile");
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("returns null when pidfile is absent", () => {
    const path = pollerPidfilePath(stateDir, TOKEN_HASH);
    expect(readPidfile(path)).toBeNull();
  });

  test("returns null when pidfile contains garbage", () => {
    const path = pollerPidfilePath(stateDir, TOKEN_HASH);
    writeFileSync(path, "garbage-not-a-pid\n");
    expect(readPidfile(path)).toBeNull();
  });

  test("returns null when pid is 0 or negative", () => {
    const path = pollerPidfilePath(stateDir, TOKEN_HASH);
    writeFileSync(path, "0\n1234\n");
    expect(readPidfile(path)).toBeNull();
    writeFileSync(path, "-5\n1234\n");
    expect(readPidfile(path)).toBeNull();
  });

  test("parses (pid, startMs)", () => {
    const path = pollerPidfilePath(stateDir, TOKEN_HASH);
    writeFileSync(path, "12345\n1700000000000\n");
    const snap = readPidfile(path);
    expect(snap).not.toBeNull();
    expect(snap!.pid).toBe(12345);
    expect(snap!.startMs).toBe(1700000000000);
  });

  test("missing startMs defaults to 0", () => {
    const path = pollerPidfilePath(stateDir, TOKEN_HASH);
    writeFileSync(path, "12345\n");
    const snap = readPidfile(path);
    expect(snap).not.toBeNull();
    expect(snap!.pid).toBe(12345);
    expect(snap!.startMs).toBe(0);
  });
});

describe("takeover: claimAuthoritative", () => {
  test("does NOT signal a live pid that is not a poller (a stale record from a previous pid namespace)", () => {
    // The pidfile names THIS test process: alive, but its cmdline is the test
    // runner, not telegram-poller. Before the fix this SIGTERMed the caller of
    // the assertion below - i.e. the regression is loud, not silent.
    const dir = freshStateDir("stale-namespace");
    writeFileSync(pollerPidfilePath(dir, TOKEN_HASH), `${process.pid}\n1\n`);
    const verdicts: string[] = [];
    const outgoing = claimAuthoritative({
      stateDir: dir,
      tokenHash: TOKEN_HASH,
      pid: process.pid + 1,
      report: (verdict) => verdicts.push(verdict),
    });
    expect(outgoing?.pid).toBe(process.pid);
    expect(verdicts).toEqual(["stale-pid-not-a-poller"]);
    expect(readPidfile(pollerPidfilePath(dir, TOKEN_HASH))?.pid).toBe(process.pid + 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports a dead outgoing pid as dead, and still overwrites", () => {
    const dir = freshStateDir("dead-outgoing");
    // A pid no process can hold: above Linux's default pid_max is not
    // guaranteed, so use a child that has already exited instead.
    const child = Bun.spawnSync(["true"]);
    writeFileSync(pollerPidfilePath(dir, TOKEN_HASH), `${child.pid}\n1\n`);
    const verdicts: string[] = [];
    claimAuthoritative({
      stateDir: dir,
      tokenHash: TOKEN_HASH,
      pid: process.pid,
      report: (verdict) => verdicts.push(verdict),
    });
    expect(verdicts).toEqual(["dead"]);
    expect(readPidfile(pollerPidfilePath(dir, TOKEN_HASH))?.pid).toBe(process.pid);
    rmSync(dir, { recursive: true, force: true });
  });

  let stateDir: string;
  beforeEach(() => {
    stateDir = freshStateDir("claim");
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("creates stateDir if missing + writes pidfile + returns null outgoing on first claim", () => {
    const nested = join(stateDir, "does", "not", "exist", "yet");
    expect(existsSync(nested)).toBe(false);
    const outgoing = claimAuthoritative({
      stateDir: nested,
      tokenHash: TOKEN_HASH,
      pid: 4242,
      startMs: 1700000000000,
      signalOutgoing: false,
    });
    expect(outgoing).toBeNull();
    const path = pollerPidfilePath(nested, TOKEN_HASH);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("4242\n1700000000000\n");
  });

  test("first claim returns null outgoing; second claim returns the first snapshot", () => {
    const o1 = claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 1001,
      startMs: 1_000,
      signalOutgoing: false,
    });
    expect(o1).toBeNull();

    const o2 = claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 2002,
      startMs: 2_000,
      signalOutgoing: false,
    });
    expect(o2).not.toBeNull();
    expect(o2!.pid).toBe(1001);
    expect(o2!.startMs).toBe(1_000);

    // Pidfile now records the SECOND claimant — newest wins.
    const path = pollerPidfilePath(stateDir, TOKEN_HASH);
    const snap = readPidfile(path);
    expect(snap!.pid).toBe(2002);
    expect(snap!.startMs).toBe(2_000);
  });

  test("OVERWRITES previous live claim — newest wins (the core #37 property)", () => {
    // Simulate the operator-pain scenario: an orphaned older poller
    // (alive PID) holds the pidfile. A newer poller starts up and must
    // win — pidfile is rewritten to point to the NEW pid.
    const alivePid = process.pid; // guaranteed alive: us
    claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: alivePid,
      startMs: 1_000,
      signalOutgoing: false,
    });

    // New poller comes in:
    const outgoing = claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 9_999_001, // pretend a different new pid
      startMs: 2_000,
      signalOutgoing: false,
    });
    expect(outgoing!.pid).toBe(alivePid);

    const snap = readPidfile(pollerPidfilePath(stateDir, TOKEN_HASH));
    expect(snap!.pid).toBe(9_999_001);
    expect(snap!.startMs).toBe(2_000);
  });

  test("re-claim by the same PID is idempotent (no spurious churn)", () => {
    const o1 = claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 555,
      startMs: 1_000,
      signalOutgoing: false,
    });
    expect(o1).toBeNull();
    const o2 = claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 555,
      startMs: 1_500,
      signalOutgoing: false,
    });
    expect(o2).not.toBeNull();
    expect(o2!.pid).toBe(555);
    const snap = readPidfile(pollerPidfilePath(stateDir, TOKEN_HASH));
    expect(snap!.pid).toBe(555);
    expect(snap!.startMs).toBe(1_500);
  });

  test("isolation across tokens — claim for token A does not touch B", () => {
    claimAuthoritative({
      stateDir,
      tokenHash: "aaaaaaaa",
      pid: 100,
      startMs: 1,
      signalOutgoing: false,
    });
    claimAuthoritative({
      stateDir,
      tokenHash: "bbbbbbbb",
      pid: 200,
      startMs: 2,
      signalOutgoing: false,
    });
    expect(readPidfile(pollerPidfilePath(stateDir, "aaaaaaaa"))!.pid).toBe(100);
    expect(readPidfile(pollerPidfilePath(stateDir, "bbbbbbbb"))!.pid).toBe(200);
  });
});

describe("takeover: isAuthoritative", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = freshStateDir("isauth");
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("false when no pidfile exists", () => {
    expect(
      isAuthoritative({ stateDir, tokenHash: TOKEN_HASH, pid: 1234 }),
    ).toBe(false);
  });

  test("true immediately after our own claim", () => {
    claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 1234,
      startMs: 1,
      signalOutgoing: false,
    });
    expect(
      isAuthoritative({ stateDir, tokenHash: TOKEN_HASH, pid: 1234 }),
    ).toBe(true);
  });

  test("flips false after a NEWER claim by a different PID — incumbent learns it has been preempted", () => {
    // Incumbent claims
    claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 1234,
      startMs: 1,
      signalOutgoing: false,
    });
    expect(
      isAuthoritative({ stateDir, tokenHash: TOKEN_HASH, pid: 1234 }),
    ).toBe(true);

    // Successor claims
    claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 5678,
      startMs: 2,
      signalOutgoing: false,
    });

    // The incumbent's next poll-loop check finds: not me.
    expect(
      isAuthoritative({ stateDir, tokenHash: TOKEN_HASH, pid: 1234 }),
    ).toBe(false);
    // Successor IS authoritative.
    expect(
      isAuthoritative({ stateDir, tokenHash: TOKEN_HASH, pid: 5678 }),
    ).toBe(true);
  });
});

describe("takeover: releaseAuthoritative", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = freshStateDir("release");
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("unlinks pidfile when we still own it", () => {
    claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 1234,
      startMs: 1,
      signalOutgoing: false,
    });
    const path = pollerPidfilePath(stateDir, TOKEN_HASH);
    expect(existsSync(path)).toBe(true);
    releaseAuthoritative({ stateDir, tokenHash: TOKEN_HASH, pid: 1234 });
    expect(existsSync(path)).toBe(false);
  });

  test("DOES NOT tear down a successor's claim", () => {
    // Critical race: incumbent's shutdown handler must not delete the
    // successor's pidfile entry.
    claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 1234,
      startMs: 1,
      signalOutgoing: false,
    });
    claimAuthoritative({
      stateDir,
      tokenHash: TOKEN_HASH,
      pid: 5678,
      startMs: 2,
      signalOutgoing: false,
    });

    // Incumbent (1234) shuts down — must NOT unlink successor's pidfile.
    releaseAuthoritative({ stateDir, tokenHash: TOKEN_HASH, pid: 1234 });

    const path = pollerPidfilePath(stateDir, TOKEN_HASH);
    expect(existsSync(path)).toBe(true);
    const snap = readPidfile(path);
    expect(snap!.pid).toBe(5678);
  });

  test("no-op when pidfile is absent", () => {
    expect(() =>
      releaseAuthoritative({ stateDir, tokenHash: TOKEN_HASH, pid: 1234 }),
    ).not.toThrow();
  });
});

describe("takeover: isPidAlive", () => {
  test("true for our own PID", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("false for a PID that almost certainly does not exist", () => {
    // Linux's pid_max default is 2^22, but on most systems much lower.
    // 2^30 is comfortably beyond any allocated PID.
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});

describe("takeover: isProcessMatching (adversarial-review finding #2)", () => {
  test("false for a definitely-dead PID regardless of the substring", () => {
    expect(isProcessMatching(2 ** 30, "anything")).toBe(false);
  });

  test("false for our OWN (definitely alive) pid against a substring it does not have", () => {
    // This bun:test process's cmdline legitimately does not contain
    // "telegram-poller" — the exact case a reused PID would hit, and the
    // exact case that must NOT be trusted as "already running".
    expect(
      isProcessMatching(process.pid, "telegram-poller-definitely-not-this"),
    ).toBe(false);
  });

  test("true for our OWN (alive) pid against a substring its real cmdline DOES contain", () => {
    // Every invocation of this test runs via `bun test ...` (or `bun run
    // .../bunfig` under the hood) — "bun" is reliably present in argv[0].
    expect(isProcessMatching(process.pid, "bun")).toBe(true);
  });

  test("a real spawned child process is correctly matched via its actual script path", async () => {
    // End-to-end: spawn a REAL, short-lived, non-detached child whose
    // command line contains a distinctive marker, and confirm
    // isProcessMatching recognizes it WHILE it's alive.
    const child = Bun.spawn(
      [process.execPath, "-e", "setTimeout(() => {}, 2000)"],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      // Bun's own argv0 for a `-e` script is the bun binary path itself —
      // match on that rather than the inline script text, which does not
      // appear verbatim in /proc/<pid>/cmdline the same way a file path
      // spawn's script argument would.
      //
      // Poll briefly rather than asserting immediately: Bun.spawn() returns
      // as soon as fork() completes, but there is a short window before the
      // child's execve() replaces its process image — /proc/<pid>/cmdline
      // can be transiently inconsistent during that window (observed
      // empirically as an occasional flake asserting immediately).
      let matched = false;
      for (let i = 0; i < 20 && !matched; i++) {
        matched = isProcessMatching(child.pid, "bun");
        if (!matched) await new Promise((r) => setTimeout(r, 10));
      }
      expect(matched).toBe(true);
      expect(isProcessMatching(child.pid, "definitely-not-a-match-xyz")).toBe(
        false,
      );
    } finally {
      child.kill();
      await child.exited;
    }
  });
});

const NUL = "\0";

describe("takeover: agentIdFromEnviron (identity parse)", () => {
  test("extracts CCT_AGENT_ID", () => {
    expect(
      agentIdFromEnviron(`PATH=/bin${NUL}CCT_AGENT_ID=cct-abc${NUL}HOME=/h`),
    ).toBe("cct-abc");
  });

  test("prefers CCT_AGENT_ID over SAC_NAME when both are present", () => {
    expect(agentIdFromEnviron(`SAC_NAME=sac-x${NUL}CCT_AGENT_ID=cct-y`)).toBe(
      "cct-y",
    );
  });

  test("falls back to SAC_NAME when CCT_AGENT_ID is absent", () => {
    expect(agentIdFromEnviron(`SAC_NAME=sac-x${NUL}HOME=/h`)).toBe("sac-x");
  });

  test("returns empty string when no marker is present", () => {
    expect(agentIdFromEnviron(`PATH=/bin${NUL}HOME=/h`)).toBe("");
  });

  test("ignores an empty-valued CCT_AGENT_ID, still finds SAC_NAME", () => {
    expect(agentIdFromEnviron(`CCT_AGENT_ID=${NUL}SAC_NAME=sac-z`)).toBe(
      "sac-z",
    );
  });

  test("does not match a key that merely ENDS with the marker name", () => {
    expect(agentIdFromEnviron(`X_CCT_AGENT_ID=nope${NUL}HOME=/h`)).toBe("");
  });
});

/**
 * The wrong-agent gap this card closes: all ~49 agents share one checkout, so a
 * cmdline match cannot prove a reused pid is OUR poller — it could be another
 * agent's genuinely-running poller. matchesAgentIdentity is what rules that out.
 */
describe("takeover: matchesAgentIdentity", () => {
  test("no own identity -> true (dev/single-agent; must not regress)", () => {
    expect(matchesAgentIdentity("", `CCT_AGENT_ID=anything`)).toBe(true);
    expect(matchesAgentIdentity("", null)).toBe(true);
  });

  test("environ unreadable -> false (fail closed: unverifiable is not-ours)", () => {
    expect(matchesAgentIdentity("cct-me", null)).toBe(false);
  });

  test("same agent id -> true", () => {
    expect(
      matchesAgentIdentity("cct-me", `PATH=/b${NUL}CCT_AGENT_ID=cct-me`),
    ).toBe(true);
  });

  test("DIFFERENT agent id -> false (another agent's reused-pid poller)", () => {
    expect(matchesAgentIdentity("cct-me", `CCT_AGENT_ID=cct-someone-else`)).toBe(
      false,
    );
  });

  test("target carries no id -> true (cannot disprove; the cmdline stands)", () => {
    expect(matchesAgentIdentity("cct-me", `PATH=/b${NUL}HOME=/h`)).toBe(true);
  });
});

describe("takeover: isProcessMatching threads the identity check", () => {
  test("rejects a live, cmdline-matching pid whose agent id differs from expected", () => {
    // process.pid's environ carries THIS runner's identity (or none). Passing
    // our OWN id must still match; passing a DIFFERENT id must reject — which
    // proves the 3rd param actually reaches matchesAgentIdentity. Guarded so it
    // is deterministic whether or not the runner carries an id (CI often does
    // not, in which case there is no id to differ from).
    const selfId = agentIdFromEnviron(
      readFileSync(`/proc/${process.pid}/environ`, "utf8"),
    );
    expect(isProcessMatching(process.pid, "bun", selfId)).toBe(true);
    if (selfId) {
      expect(isProcessMatching(process.pid, "bun", `${selfId}-different`)).toBe(
        false,
      );
    }
  });
});
