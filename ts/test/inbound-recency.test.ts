/**
 * `inbound_recency` — the check whose absence cost four hand-run probes.
 *
 * On 2026-08-11 scitex-storage's store held no inbound row newer than
 * 2026-07-28 and the report read 14/14 ok, `ingestion_live` included
 * ("last successful poll 13s ago"). Working out whether that was an outage or
 * an idle channel took four separate manual queries: newest stored row,
 * per-day counts, the poller log, and finally the cursor arithmetic.
 *
 * It was an idle channel. The operator had said he was moving to cards one
 * message before the silence began, and offset == max_stored + 1 proved every
 * update Telegram ever sent was already in the store.
 *
 * That outcome is why this check is WARN-STYLE and why it refuses to name a
 * culprit. A check that announced "inbound is dead" on this signal would have
 * been wrong on the very agent whose silence motivated it. Its job is to put
 * three numbers where a reader sees them — newest stored age, poll age (from
 * ingestion_live), and the cursor — so the idle/lossy call takes one glance
 * instead of four queries.
 */

import { describe, test, expect } from "bun:test";
import { buildHealthReport, INBOUND_QUIET_WARN_MS } from "../lib/health.js";
import { healthyInputs, byName } from "./health-fixtures.js";
import { SCHEMA_VERSION } from "../lib/store.js";

const NOW = 1_786_400_000_000;
const DAY = 86_400_000;

/**
 * A DbProbe whose newest inbound row is `ageMs` old.
 * `offsetGap` shifts update_offset relative to max_stored+1: 0 = idle cursor,
 * >0 = updates acknowledged but never stored.
 */
function dbWithInbound(ageMs: number | null, offsetGap = 0) {
  const maxUpdateId = 104700678;
  return {
    exists: true as const,
    schemaVersion: SCHEMA_VERSION,
    updateOffset: maxUpdateId + 1 + offsetGap,
    maxUpdateId,
    inboundCount: 124,
    lastPollTs: NOW - 5_000,
    newestInboundMs: ageMs === null ? null : NOW - ageMs,
  };
}

function entryFor(db: ReturnType<typeof dbWithInbound>) {
  return byName(
    buildHealthReport({ ...healthyInputs(), db, now: NOW }),
    "inbound_recency",
  );
}

describe("inbound_recency reports the age of the newest stored message", () => {
  test("recent inbound passes and states the age and the cursor", () => {
    const entry = entryFor(dbWithInbound(2 * 60_000));
    expect(entry.ok).toBe(true);
    expect(entry.detail).toContain("newest stored inbound");
    expect(entry.detail).toContain("cursor idle");
  });

  test("a long quiet is reported with the age, not as a failure verdict", () => {
    const entry = entryFor(dbWithInbound(14 * DAY));
    expect(entry.ok).toBe(false);
    expect(entry.detail).toContain("14d");
    // The humility is the contract, not decoration: this check must never
    // claim the rail is dead from a signal that cannot distinguish the two.
    expect(entry.detail).toContain("CANNOT tell a quiet channel");
  });

  test("a long quiet NEVER flips the report's top-level ok", () => {
    const report = buildHealthReport({
      ...healthyInputs(),
      db: dbWithInbound(14 * DAY),
      now: NOW,
    });
    expect(byName(report, "inbound_recency").ok).toBe(false);
    // An agent whose operator simply has not written in a fortnight is
    // healthy. Measured 2026-08-11: this exact case, and it was innocent.
    expect(report.ok).toBe(true);
  });

  test("the threshold boundary does not warn", () => {
    expect(entryFor(dbWithInbound(INBOUND_QUIET_WARN_MS)).ok).toBe(true);
    expect(entryFor(dbWithInbound(INBOUND_QUIET_WARN_MS + 1)).ok).toBe(false);
  });
});

describe("the cursor is conclusive one way only", () => {
  test("offset == max_stored + 1 reads as idle", () => {
    expect(entryFor(dbWithInbound(14 * DAY, 0)).detail).toContain(
      "cursor idle",
    );
  });

  test("offset ahead of max_stored reports the gap without calling it loss", () => {
    const detail = entryFor(dbWithInbound(14 * DAY, 7)).detail;
    expect(detail).toContain("cursor AHEAD by 7");
    // The number is worth showing. The conclusion was never ours to draw:
    // update_id advances for reactions, edits, and non-allowlisted senders,
    // none of which becomes a stored row.
    expect(detail).toContain("expected");
    expect(detail).not.toContain("acknowledged but not stored");
  });

  /**
   * REGRESSION GUARD, and the reason this file changed.
   *
   * The hint is the text someone follows mid-incident, and it used to say a
   * gap "is loss, and it is the one that needs you" — contradicting
   * db_schema_current in the same report, which had already measured that
   * false positive on scitex-hub (gap 1355, ingestion demonstrably live) and
   * recorded that acting on it re-delivers 24h of already-read backlog.
   *
   * These assertions fail against develop. That is the point: a green suite
   * that cannot see a wrong hint is how the wrong hint survived.
   */
  test("the quiet-channel hint never presents a gap as evidence of loss", () => {
    const entry = entryFor(dbWithInbound(INBOUND_QUIET_WARN_MS + 1, 7));
    const hint = entry.hint ?? "";
    expect(hint).toContain("proves NOTHING on its own");
    expect(hint).not.toContain("that is loss");
  });

  test("the hint warns against the remedy that re-delivers read backlog", () => {
    const hint = entryFor(dbWithInbound(INBOUND_QUIET_WARN_MS + 1, 7)).hint ?? "";
    expect(hint).toContain("Do NOT reset update_offset");
    expect(hint).toContain("24h");
  });

  test("the hint still states what the idle cursor DOES settle", () => {
    // Narrowing the gap claim must not cost the half that was measured and
    // correct — offset == max_stored+1 is what resolved 2026-08-11 in a glance.
    const hint = entryFor(dbWithInbound(INBOUND_QUIET_WARN_MS + 1, 0)).hint ?? "";
    expect(hint).toContain("CONCLUSIVE");
    expect(hint).toContain("scitex-storage");
  });

  test("offset behind max_stored is reported rather than silently ignored", () => {
    expect(entryFor(dbWithInbound(60_000, -3)).detail).toContain(
      "cursor BEHIND by 3",
    );
  });

  test("an uncomparable cursor says so instead of guessing", () => {
    const db = { ...dbWithInbound(60_000), maxUpdateId: null };
    expect(entryFor(db).detail).toContain("cursor not comparable");
  });
});

describe("inbound_recency is three-valued about its own inputs", () => {
  test("no inbound row ever stored is a first run, not a fault", () => {
    const entry = entryFor(dbWithInbound(null));
    expect(entry.ok).toBe(true);
    expect(entry.detail).toContain("first run");
  });

  test("an absent probe field skips rather than failing the report", () => {
    // Absent ⇔ nobody asked; null ⇔ asked and there is no row. Collapsing
    // those two is the bug this whole module exists to avoid.
    const db = dbWithInbound(60_000);
    delete (db as { newestInboundMs?: number | null }).newestInboundMs;
    const entry = entryFor(db);
    expect(entry.ok).toBe(true);
    expect(entry.detail).toContain("did not report inbound recency");
  });

  test("an unreadable store is UNKNOWN, deferring to db_schema_current", () => {
    // Deferring is still right — db_schema_current owns the read failure. But
    // a disk I/O error means we genuinely CANNOT know inbound recency, and
    // saying ok would have reported a dead channel as green.
    const entry = byName(
      buildHealthReport({
        ...healthyInputs(),
        db: { exists: true, error: "disk I/O error" },
        now: NOW,
      }),
      "inbound_recency",
    );
    expect(entry.ok).toBe(false);
    expect(entry.evaluated).toBe(false);
    expect(entry.detail).toContain("db_schema_current");
  });

  test("no token means no poller, so the check skips like its siblings", () => {
    const entry = byName(
      buildHealthReport({
        ...healthyInputs(),
        poller: null,
        db: dbWithInbound(14 * DAY),
        now: NOW,
      }),
      "inbound_recency",
    );
    expect(entry.ok).toBe(true);
    expect(entry.detail).toContain("skipped");
  });
});
