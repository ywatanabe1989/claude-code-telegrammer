/**
 * Tests for lib/wake-health.ts — the consecutive-wake-failure tracker
 * (incident incident-cct-inbound-dies-silently-with-mcp-server-20260711).
 *
 * Cross-process persistence (architecture-fix follow-up, 2026-07): the
 * getUpdates poller now runs in its own standalone process
 * (ts/telegram-poller.ts), so recordWakeFailure/recordWakeSuccess (called
 * from lib/handle-update.ts, which only runs in the poller process) and
 * getWakeFailureState (called from the `health` MCP tool, which runs in the
 * SEPARATE MCP-server process) can no longer share in-process module state.
 * The second describe block below pins the persistence half of that fix,
 * mirroring how ts/test/poll-watchdog.test.ts pins saveLastPollTs/
 * loadLastPollTs for the poll heartbeat.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  beforeAll,
  afterEach,
  afterAll,
} from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import {
  recordWakeFailure,
  recordWakeSuccess,
  getWakeFailureState,
  _resetWakeFailureState,
  _setPersistAttempt,
  _resetPersistAttempt,
} from "../lib/wake-health.js";
import { initStore } from "../lib/store.js";
import { query } from "./helpers/store-access.js";
import {
  setSystemAlertSender,
  _resetSystemAlertSender,
} from "../lib/loudfail.js";
import { _resetCache } from "../lib/access.js";
import { ACCESS_FILE, STATE_DIR } from "../lib/config.js";

describe("wake failure tracker", () => {
  beforeEach(async () => {
    await _resetWakeFailureState();
  });

  test("starts at count 0, everything else null", async () => {
    const s = await getWakeFailureState();
    expect(s.count).toBe(0);
    expect(s.lastCategory).toBeNull();
    expect(s.lastReason).toBeNull();
    expect(s.lastAtMs).toBeNull();
  });

  test("one failure → count 1, records category/reason/timestamp", async () => {
    await recordWakeFailure("connection_refused", "connect ECONNREFUSED", 1000);
    const s = await getWakeFailureState();
    expect(s.count).toBe(1);
    expect(s.lastCategory).toBe("connection_refused");
    expect(s.lastReason).toBe("connect ECONNREFUSED");
    expect(s.lastAtMs).toBe(1000);
  });

  test("consecutive failures increment the count and overwrite last-seen fields", async () => {
    await recordWakeFailure("connection_refused", "connect ECONNREFUSED", 1000);
    await recordWakeFailure("timeout", "network timeout", 2000);
    await recordWakeFailure("server_error", "HTTP 500", 3000);
    const s = await getWakeFailureState();
    expect(s.count).toBe(3);
    expect(s.lastCategory).toBe("server_error");
    expect(s.lastReason).toBe("HTTP 500");
    expect(s.lastAtMs).toBe(3000);
  });

  test("a success resets the counter to zero and clears last-seen fields", async () => {
    await recordWakeFailure("connection_refused", "connect ECONNREFUSED", 1000);
    await recordWakeFailure("connection_refused", "connect ECONNREFUSED", 2000);
    await recordWakeSuccess();
    const s = await getWakeFailureState();
    expect(s.count).toBe(0);
    expect(s.lastCategory).toBeNull();
    expect(s.lastReason).toBeNull();
    expect(s.lastAtMs).toBeNull();
  });

  test("failure after a success starts a fresh count of 1, not a continuation", async () => {
    await recordWakeFailure("connection_refused", "a", 1000);
    await recordWakeSuccess();
    await recordWakeFailure("timeout", "b", 2000);
    const s = await getWakeFailureState();
    expect(s.count).toBe(1);
    expect(s.lastCategory).toBe("timeout");
  });

  test("defaults `now` to Date.now() when not injected", async () => {
    const before = Date.now();
    await recordWakeFailure("unknown", "x");
    const after = Date.now();
    const s = await getWakeFailureState();
    expect(s.lastAtMs).not.toBeNull();
    expect(s.lastAtMs!).toBeGreaterThanOrEqual(before);
    expect(s.lastAtMs!).toBeLessThanOrEqual(after);
  });
});

describe("wake failure tracker: cross-process persistence", () => {
  beforeAll(async () => {
    await initStore();
  });
  beforeEach(async () => {
    await _resetWakeFailureState();
  });

  async function persistedState(): Promise<unknown> {
    const rows = await query<{ value: string }>(
      "SELECT value FROM ${SCHEMA}.meta WHERE key = 'wake_failure_state'",
    );
    expect(rows[0]).toBeDefined();
    return JSON.parse(rows[0].value);
  }

  test("recordWakeFailure persists the state to the shared store", async () => {
    await recordWakeFailure("connection_refused", "connect ECONNREFUSED", 1000);

    // Read back with a plain query against the same row a SEPARATE process
    // (the MCP server, post-split) would read — not through the module's own
    // getter, which could hand back its in-process copy and prove nothing.
    expect(await persistedState()).toEqual({
      count: 1,
      lastCategory: "connection_refused",
      lastReason: "connect ECONNREFUSED",
      lastAtMs: 1000,
    });
  });

  test("recordWakeSuccess persists the cleared state", async () => {
    await recordWakeFailure("timeout", "t", 1);
    await recordWakeSuccess();

    expect(await persistedState()).toEqual({
      count: 0,
      lastCategory: null,
      lastReason: null,
      lastAtMs: null,
    });
  });

  test("getWakeFailureState prefers the persisted value over stale in-process vars — the cross-process case", async () => {
    // In THIS process's own view: one failure recorded.
    await recordWakeFailure("timeout", "in-process view", 1000);

    // Simulate a DIFFERENT process (the real poller, post-split) having
    // written a DIFFERENT value directly to the shared store — exactly the
    // situation the MCP-server process is in: its own in-process vars only
    // reflect what IT called record*() with (normally nothing, since only
    // the poller process ever does), but the store reflects what the poller
    // process actually saw.
    await query(
      "INSERT INTO ${SCHEMA}.meta (key, value) VALUES ('wake_failure_state', $1)" +
        " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [
        JSON.stringify({
          count: 7,
          lastCategory: "server_error",
          lastReason: "cross-process write",
          lastAtMs: 9999,
        }),
      ],
    );

    expect(await getWakeFailureState()).toEqual({
      count: 7,
      lastCategory: "server_error",
      lastReason: "cross-process write",
      lastAtMs: 9999,
    });
  });

  test("_resetWakeFailureState clears the persisted value too (no stale leak into the next test)", async () => {
    await recordWakeFailure("auth", "x", 1);
    await _resetWakeFailureState();

    expect(await persistedState()).toEqual({
      count: 0,
      lastCategory: null,
      lastReason: null,
      lastAtMs: null,
    });
  });
});

describe("persist(): retry + loud-alert-on-exhaustion (adversarial-review finding #5)", () => {
  const ALERT_RECIPIENT = "wake-health-alert-recipient";
  let alerts: string[] = [];

  beforeAll(() => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      ACCESS_FILE,
      JSON.stringify({ allowFrom: [ALERT_RECIPIENT] }),
    );
    _resetCache();
  });

  afterAll(() => {
    rmSync(ACCESS_FILE, { force: true });
    _resetCache();
  });

  beforeEach(async () => {
    alerts = [];
    setSystemAlertSender(async (_chatId, text) => {
      alerts.push(text);
      return { ok: true };
    });
    await _resetWakeFailureState();
    alerts = []; // _resetWakeFailureState's own persist() may itself alert
  });

  afterEach(() => {
    _resetPersistAttempt();
    _resetSystemAlertSender();
  });

  // WHAT THIS CASE NO LONGER ASSERTS, AND WHY. It used to also pin the two
  // busy-timeout values handed to each attempt ([2000, 500]). Those numbers
  // described a whole-file lock that a second connection could block on, and
  // they were tuned because the block ran on the same thread whose job is
  // staying responsive to Telegram polling. A single-row upsert on a server
  // does not queue that way, so persistAttempt takes no timeout argument any
  // more and asserting on one would be asserting on nothing. The retry COUNT
  // and the loud alert are what the finding was actually about, and both are
  // still pinned.
  test("a persist that fails every attempt is retried 2 times total, then broadcasts a loud alert", async () => {
    let attempts = 0;
    _setPersistAttempt(async () => {
      attempts += 1;
      throw new Error("simulated store outage");
    });

    await recordWakeFailure("server_error", "HTTP 500", 12345);

    expect(attempts).toBe(2);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("FATAL");
    expect(alerts[0]).toContain("2 attempts");
    expect(alerts[0]).toContain("simulated store outage");
  });

  test("a persist that fails once then succeeds does NOT alert (transient recovery)", async () => {
    let attempts = 0;
    _setPersistAttempt(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient blip");
      // second attempt: succeeds (a no-op stand-in is enough — persist()
      // only cares whether persistAttempt() throws, not what it does).
    });

    await recordWakeSuccess();
    expect(attempts).toBe(2);
    expect(alerts.length).toBe(0);
  });

  test("a fully healthy persist never retries and never alerts", async () => {
    // Uses the REAL persistAttempt against the real store.
    _resetPersistAttempt();
    await recordWakeFailure("timeout", "t", 1);
    expect(alerts.length).toBe(0);
  });
});
