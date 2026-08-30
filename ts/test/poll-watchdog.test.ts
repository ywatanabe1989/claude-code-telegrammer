/**
 * Ingestion-stall watchdog: the getUpdates poller can stay ALIVE
 * (process up, kill-0 passes, pidfile records a live PID) yet stop
 * ingesting because getUpdates itself is WEDGED — a hung socket / network
 * black-hole / long-poll whose await never resolves. kill-0 liveness
 * checks miss it; this watchdog detects the silent stall, LOGS it, and
 * fires the actuator (onStall self-terminates so the supervisor respawns).
 * It does NOT message the operator — a self-healing stall is not actionable
 * and a stall-loop would flood him (2026-07-18 spam incident).
 *
 * These tests drive poll-watchdog.ts::createStallWatchdog directly — the
 * stateful checker that owns the "actuate vs stay silent" decision. The clock
 * (`now`), the heartbeat getter (`getLastPoll`), the polling predicate
 * (`isPolling`) and the actuator (`onStall`) are all injected, so the
 * actuate / re-arm / shutdown logic is exercised with NO timers and NO
 * network. There is no operator-message seam to inject — its absence is the
 * spam fix.
 */

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import {
  createStallWatchdog,
  resolveStallThresholdMs,
  recordSuccessfulPoll,
  getLastSuccessfulPoll,
  _resetHeartbeat,
  DEFAULT_STALL_SECONDS,
} from "../lib/poll-watchdog.js";
import { initStore, loadLastPollTs } from "../lib/store.js";

const THRESHOLD_MS = 180_000;

/**
 * A watchdog driven by a virtual clock + heartbeat. `poll()` stamps the
 * heartbeat to "now" (a successful getUpdates return); `advance()` moves
 * the clock forward WITHOUT a poll (the stall); `stop()` flips the
 * polling predicate false (clean shutdown).
 */
function harness() {
  let clock = 0;
  let lastPoll = 0;
  let polling = true;
  let actuations = 0;
  const wd = createStallWatchdog({
    now: () => clock,
    getLastPoll: () => lastPoll,
    isPolling: () => polling,
    thresholdMs: THRESHOLD_MS,
    // The watchdog's only observable output besides its log line. There is no
    // `emit`/operator seam anymore — a self-healing stall must not reach the
    // phone (2026-07-18 spam incident). These tests observe the ACTUATOR.
    onStall: () => {
      actuations += 1;
    },
  });
  return {
    wd,
    actuations: () => actuations,
    advance: (ms: number) => {
      clock += ms;
    },
    poll: () => {
      lastPoll = clock;
    },
    stop: () => {
      polling = false;
    },
  };
}

describe("createStallWatchdog — actuates once per stall episode", () => {
  test("(a) no actuation while polls stay fresh", () => {
    const h = harness();
    h.poll(); // initial successful poll at t=0
    // Ten healthy long-poll cycles: advance ~30s then poll each time.
    for (let i = 0; i < 10; i++) {
      h.advance(30_000);
      h.poll();
      h.wd.tick();
    }
    expect(h.actuations()).toBe(0);
  });

  test("(b) EXACTLY ONE actuation once the stall threshold is crossed", () => {
    const h = harness();
    h.poll(); // last successful poll at t=0
    // No further polls — getUpdates has wedged. Cross the threshold.
    h.advance(THRESHOLD_MS + 5_000);
    h.wd.tick(); // actuate (request respawn)

    // Keep ticking while still stalled — must NOT re-fire this episode.
    h.advance(30_000);
    h.wd.tick();
    h.advance(30_000);
    h.wd.tick();

    // Exactly one respawn request per episode — and NO operator message: the
    // watchdog logs and acts, it has no emit seam (2026-07-18). The message the
    // operator used to get here was the spam this change removes.
    expect(h.actuations()).toBe(1);
  });

  test("no actuation just BELOW the threshold", () => {
    const h = harness();
    h.poll();
    h.advance(THRESHOLD_MS - 1_000); // still under threshold
    h.wd.tick();
    expect(h.actuations()).toBe(0);
  });

  test("(c) the watchdog RE-ARMS after a fresh poll, then actuates again", () => {
    const h = harness();
    h.poll();
    h.advance(THRESHOLD_MS + 5_000);
    h.wd.tick(); // actuate #1
    expect(h.actuations()).toBe(1);

    // A successful poll resumes → heartbeat advances → re-arm.
    h.advance(10_000);
    h.poll();
    h.wd.tick(); // fresh again: no actuation
    expect(h.actuations()).toBe(1);

    // A LATER stall must actuate again (proves the latch reset).
    h.advance(THRESHOLD_MS + 5_000);
    h.wd.tick(); // actuate #2
    expect(h.actuations()).toBe(2);
  });

  test("(d) no actuation after shutdown / preemption (isPolling false)", () => {
    const h = harness();
    h.poll();
    h.stop(); // poller released authority / clean shutdown
    h.advance(THRESHOLD_MS + 60_000); // long stall AFTER shutdown
    h.wd.tick();
    h.wd.tick();
    expect(h.actuations()).toBe(0);
  });
});

describe("resolveStallThresholdMs — env alias + default", () => {
  test("unset → default", () => {
    expect(resolveStallThresholdMs({})).toBe(DEFAULT_STALL_SECONDS * 1000);
  });

  test("empty string is treated as absent → default", () => {
    expect(resolveStallThresholdMs({ CCT_POLL_STALL_SECONDS: "" })).toBe(
      DEFAULT_STALL_SECONDS * 1000,
    );
  });

  test("short alias CCT_POLL_STALL_SECONDS wins", () => {
    expect(resolveStallThresholdMs({ CCT_POLL_STALL_SECONDS: "60" })).toBe(
      60_000,
    );
  });

  test("canonical CLAUDE_CODE_TELEGRAMMER_POLL_STALL_SECONDS resolves", () => {
    expect(
      resolveStallThresholdMs({
        CLAUDE_CODE_TELEGRAMMER_POLL_STALL_SECONDS: "90",
      }),
    ).toBe(90_000);
  });

  test("invalid / non-positive value → default", () => {
    expect(resolveStallThresholdMs({ CCT_POLL_STALL_SECONDS: "abc" })).toBe(
      DEFAULT_STALL_SECONDS * 1000,
    );
    expect(resolveStallThresholdMs({ CCT_POLL_STALL_SECONDS: "0" })).toBe(
      DEFAULT_STALL_SECONDS * 1000,
    );
  });
});

describe("recordSuccessfulPoll — in-process + persisted heartbeat", () => {
  beforeAll(async () => {
    await initStore();
  });
  beforeEach(() => {
    _resetHeartbeat();
  });

  test("stamps the in-process heartbeat and persists it to the DB", async () => {
    const t = 1_720_500_000_000;
    await recordSuccessfulPoll(t);
    expect(getLastSuccessfulPoll()).toBe(t);
    // Persisted so an out-of-band health probe can read poll-freshness.
    expect(await loadLastPollTs()).toBe(t);
  });

  test("a later poll advances both the in-process and persisted stamps", async () => {
    await recordSuccessfulPoll(1_000);
    await recordSuccessfulPoll(2_000);
    expect(getLastSuccessfulPoll()).toBe(2_000);
    expect(await loadLastPollTs()).toBe(2_000);
  });
});
