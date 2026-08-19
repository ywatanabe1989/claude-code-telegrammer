import { describe, expect, test } from "bun:test";
import {
  ensurePollerRunning,
  initialSupervisionState,
  superviseTick,
  MAX_SUPERVISION_SPAWNS,
  type EnsurePollerDeps,
  type EnsurePollerResult,
} from "../lib/poller-supervisor.js";

/**
 * Defect 4 of cct-refuse-to-start-on-token-contention-...-20260816:
 * "the watchdog exits for respawn and nothing respawns it."
 *
 * Measured on the host 2026-08-19: an ADOPTED poller's parent is `appinit`
 * (reaps, never respawns), there is no systemd unit and no crontab entry, and
 * ensurePollerRunning had exactly one call site. So a poller this MCP-server
 * incarnation did not spawn had no supervisor at all — and adoption is the
 * designed-normal case, since surviving MCP restarts is the point of the
 * detached poller.
 */

/** A fake world: one pidfile slot and a set of live pids. */
function world(opts: { codeMtimeMs?: number } = {}) {
  let pidfile: { pid: number; startMs: number } | null = null;
  const alive = new Set<number>();
  const spawns: number[] = [];
  let nextPid = 1000;

  const deps: EnsurePollerDeps = {
    stateDir: "/tmp/does-not-exist",
    tokenHash: "deadbeef",
    pollerScriptPath: "/tmp/telegram-poller.ts",
    readPid: () => pidfile,
    isAlive: (pid: number) => alive.has(pid),
    codeMtimeMs: () => opts.codeMtimeMs ?? 0,
    logFn: () => {},
    spawn: () => {
      const pid = nextPid++;
      spawns.push(pid);
      alive.add(pid);
      // A real poller claims the pidfile on start; startMs is therefore always
      // NEWER than the code that triggered the spawn.
      pidfile = { pid, startMs: Date.now() + 1_000_000 };
      return {
        pid,
        exited: new Promise<number>(() => {}), // never resolves in these tests
        unref: () => {},
      };
    },
  };

  return {
    deps,
    spawns,
    adopt(pid: number, startMs: number) {
      pidfile = { pid, startMs };
      alive.add(pid);
    },
    kill(pid: number) {
      alive.delete(pid);
    },
  };
}

describe("an adopted poller is supervised, not abandoned", () => {
  test("a poller we merely adopted is REPLACED when it dies", () => {
    const w = world();
    w.adopt(777, Date.now());

    // Tick 1: incumbent alive — adopt it, spawn nothing.
    expect(ensurePollerRunning(w.deps).action).toBe("already-running");
    expect(w.spawns).toHaveLength(0);

    // The adopted poller dies. Nothing on the host respawns it; before this
    // change nothing here did either, and inbound delivery stopped silently.
    w.kill(777);

    // Tick 2: the re-check notices and replaces it. THIS is the defect fix.
    expect(ensurePollerRunning(w.deps).action).toBe("spawned");
    expect(w.spawns).toHaveLength(1);
  });

  test("a healthy poller never approaches the give-up cap, however long it runs", () => {
    let state = initialSupervisionState();
    const healthy: EnsurePollerResult = { action: "already-running", pid: 42 };
    for (let i = 0; i < MAX_SUPERVISION_SPAWNS * 20; i++) {
      const r = superviseTick(state, healthy);
      state = r.state;
      expect(r.alert).toBeUndefined();
    }
    expect(state.consecutiveSpawns).toBe(0);
    expect(state.gaveUp).toBe(false);
  });
});

describe("a crash loop pages a human instead of respawning forever", () => {
  test("consecutive spawns hit the cap, alert, and then stop acting", () => {
    let state = initialSupervisionState();
    const died: EnsurePollerResult = { action: "spawned", pid: 5 };
    let alert: string | undefined;

    for (let i = 0; i < MAX_SUPERVISION_SPAWNS; i++) {
      const r = superviseTick(state, died);
      state = r.state;
      alert = r.alert ?? alert;
    }

    expect(state.gaveUp).toBe(true);
    expect(alert).toBeTruthy();
    expect(alert).toContain("GIVING UP");
    // The operator must be told delivery is down, not just that a retry failed.
    expect(alert).toContain("Inbound Telegram delivery is DOWN");

    // Having given up, further ticks are inert — no alert storm.
    const after = superviseTick(state, died);
    expect(after.alert).toBeUndefined();
    expect(after.state.gaveUp).toBe(true);
  });

  test("a spawn that fails outright counts toward the cap and names the error", () => {
    let state = initialSupervisionState();
    const failed: EnsurePollerResult = {
      action: "spawn-failed",
      error: "EACCES writing poller log",
    };
    let alert: string | undefined;
    for (let i = 0; i < MAX_SUPERVISION_SPAWNS; i++) {
      const r = superviseTick(state, failed);
      state = r.state;
      alert = r.alert ?? alert;
    }
    expect(alert).toContain("EACCES writing poller log");
  });

  test("one healthy observation forgives an earlier stumble", () => {
    let state = initialSupervisionState();
    state = superviseTick(state, { action: "spawned", pid: 1 }).state;
    state = superviseTick(state, { action: "spawned", pid: 2 }).state;
    expect(state.consecutiveSpawns).toBe(2);

    state = superviseTick(state, { action: "already-running", pid: 2 }).state;
    expect(state.consecutiveSpawns).toBe(0);
  });
});

describe("periodic re-checks do not re-trigger the stale-code takeover", () => {
  // The stale-code branch's comment used to rest on "ensurePollerRunning runs
  // once per MCP-server start". This change removes that premise, so the
  // convergence has to be asserted rather than assumed.
  test("stale code triggers exactly ONE takeover, not one per tick", () => {
    const codeMtimeMs = 5_000_000;
    const w = world({ codeMtimeMs });
    // Incumbent started BEFORE the current code was written → stale.
    w.adopt(777, codeMtimeMs - 1000);

    const first = ensurePollerRunning(w.deps);
    expect(first.action).toBe("spawned");
    expect(w.spawns).toHaveLength(1);

    // Every subsequent tick must adopt the fresh poller, not replace it again.
    for (let i = 0; i < 10; i++) {
      expect(ensurePollerRunning(w.deps).action).toBe("already-running");
    }
    expect(w.spawns).toHaveLength(1);
  });
});

describe("supervision actually RE-checks (the gate that fails without this change)", () => {
  // The tests above drive ensurePollerRunning by hand, so they would pass on
  // the old one-shot code too — the defect was never that ensurePollerRunning
  // did the wrong thing, it was that NOTHING CALLED IT AGAIN. This is the test
  // that fails without startPollerSupervision, and so it is the real gate.
  test("the supervisor calls ensurePollerRunning more than once, unprompted", async () => {
    const { startPollerSupervision } = await import(
      "../lib/poller-supervisor.js"
    );
    const calls: number[] = [];
    const handle = startPollerSupervision(
      {
        stateDir: "/tmp/nope",
        tokenHash: "deadbeef",
        pollerScriptPath: "/tmp/telegram-poller.ts",
        logFn: () => {},
      },
      {
        intervalMs: 5,
        ensure: () => {
          calls.push(Date.now());
          return { action: "already-running", pid: 1 };
        },
      },
    );

    try {
      // The first call is synchronous (boot parity with the old one-shot).
      expect(calls).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 60));
      // A one-shot supervisor is still at 1 here. This is the whole defect.
      expect(calls.length).toBeGreaterThan(1);
    } finally {
      handle.stop();
    }
  });

  test("stop() ends supervision — no ticks leak past teardown", async () => {
    const { startPollerSupervision } = await import(
      "../lib/poller-supervisor.js"
    );
    let calls = 0;
    const handle = startPollerSupervision(
      {
        stateDir: "/tmp/nope",
        tokenHash: "deadbeef",
        pollerScriptPath: "/tmp/telegram-poller.ts",
        logFn: () => {},
      },
      {
        intervalMs: 5,
        ensure: () => {
          calls++;
          return { action: "already-running", pid: 1 };
        },
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    handle.stop();
    const settled = calls;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(settled);
  });
});
