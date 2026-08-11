/**
 * `ingestion_live` — the check whose ABSENCE let a month pass silently.
 *
 * scitex-hub's inbound Telegram rail stored nothing between 2026-07-08 and
 * 2026-08-11. Throughout, every existing signal read green:
 *
 *     poller_alive          ok   (kill-0 on a live pid)
 *     bot_token_valid       ok   (getMe answered)
 *     webhook_absent        ok
 *     state_dir_writable    ok
 *     wake_delivery_backlog ok
 *
 * All true, and all beside the point. The poller PROCESS was alive and
 * looping; what it was doing was losing a getUpdates race 161 times in four
 * hours. `recordSuccessfulPoll()` only stamps on a SUCCESSFUL poll, so the
 * persisted heartbeat (meta.last_poll_ts) sat frozen while the process stayed
 * up — the one number that would have said "this rail is deaf".
 *
 * Nothing read it. `poller_alive` answers "is the process there?", which is a
 * different question from "is anything arriving?", and the incident is
 * precisely the gap between them. So: a live poller whose heartbeat has gone
 * stale is now a LOUD failure.
 *
 * Deliberately three-valued. A dead poller is NOT this check's failure
 * (poller_alive owns it, and double-failing would make one fault look like
 * two), and "no heartbeat recorded yet" is a first run, not a fault.
 */

import { describe, test, expect } from "bun:test";
import { buildHealthReport } from "../lib/health.js";
import { healthyInputs, byName } from "./health-fixtures.js";
import { SCHEMA_VERSION } from "../lib/store.js";

const NOW = 1_786_400_000_000;
const MINUTE = 60_000;

/** A DbProbe with a heartbeat `ageMs` old (null ⇒ never stamped). */
function dbWithHeartbeat(ageMs: number | null) {
  return {
    exists: true as const,
    schemaVersion: SCHEMA_VERSION,
    updateOffset: 104702033,
    maxUpdateId: 104700678,
    inboundCount: 124,
    lastPollTs: ageMs === null ? null : NOW - ageMs,
  };
}

const DEAD_POLLER = {
  kind: "external" as const,
  lockPid: null,
  lockAlive: false,
  pidfilePid: 4242,
  pidfileAlive: false,
  pidfilePath: "/tmp/x/poller-abcd1234.pid",
};

describe("ingestion_live", () => {
  test("THE OUTAGE: process alive, heartbeat frozen → LOUD failure", () => {
    // The exact shape of 2026-08-10: pid up, polls failing, nothing arriving.
    const report = buildHealthReport(
      healthyInputs({
        now: NOW,
        poller: { kind: "self", pid: 113 },
        db: dbWithHeartbeat(240 * MINUTE),
      }),
    );
    const c = byName(report, "ingestion_live");

    expect(c.ok).toBe(false);
    expect(report.ok).toBe(false); // a real fault, not a warn
    expect(c.detail).toContain("240"); // says HOW stale, in minutes
    // The hint must name the cause that actually produced this, and say why
    // the green liveness check next to it is not reassuring.
    expect(c.hint).toContain("Conflict");
    expect(c.hint).toContain("kill-0");
  });

  test("a healthy long-poll keeps it green", () => {
    // A 30s long-poll stamps the heartbeat far more often than the threshold,
    // so an IDLE-but-healthy bridge must never trip this — an alarm that
    // fires on quiet is an alarm that gets muted.
    const c = byName(
      buildHealthReport(
        healthyInputs({
          now: NOW,
          poller: { kind: "self", pid: 113 },
          db: dbWithHeartbeat(20_000),
        }),
      ),
      "ingestion_live",
    );

    expect(c.ok).toBe(true);
  });

  test("a DEAD poller is not this check's failure", () => {
    // poller_alive owns that, and already fails on it. Reporting it twice
    // makes one fault look like two and buries which one to fix.
    const report = buildHealthReport(
      healthyInputs({
        now: NOW,
        poller: DEAD_POLLER,
        db: dbWithHeartbeat(240 * MINUTE),
      }),
    );

    expect(byName(report, "ingestion_live").ok).toBe(true);
    expect(byName(report, "poller_alive").ok).toBe(false); // the positive control
  });

  test("no heartbeat recorded yet → first run, not a fault", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({
          now: NOW,
          poller: { kind: "self", pid: 113 },
          db: dbWithHeartbeat(null),
        }),
      ),
      "ingestion_live",
    );

    expect(c.ok).toBe(true);
    expect(c.detail).toContain("no successful poll recorded");
  });

  test("a tokenless agent skips it (telegram disabled by design)", () => {
    const c = byName(
      buildHealthReport(
        healthyInputs({ now: NOW, tokenPresent: false, poller: null }),
      ),
      "ingestion_live",
    );

    expect(c.ok).toBe(true);
  });

  test("it appears in the report even when everything is fine", () => {
    // A check nobody can see is a check nobody acts on.
    const names = buildHealthReport(healthyInputs({ now: NOW })).checks.map(
      (c) => c.name,
    );
    expect(names).toContain("ingestion_live");
  });
});
