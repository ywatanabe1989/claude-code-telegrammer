/**
 * Ingestion coverage: an empty answer must say whether it MEANS anything.
 *
 * Regression target — incident 2026-08-10 (scitex-dev's bridge): the store's
 * last row was 16:01:22 and the next was 00:36:26, 8h35m later, while the
 * operator and the agent exchanged ~19 messages in between. `get_unread`
 * returned `[]` for that window, identical to the `[]` it returns when
 * nothing was sent, and the poller log for those hours was completely empty
 * because the stall watchdog's heartbeat is stamped on every getUpdates
 * RETURN — including the empty ones a stolen batch produces.
 */

import { describe, expect, test } from "bun:test";
import {
  buildCoverage,
  assertValidCoverage,
  DEFAULT_POLL_STALENESS_MS,
} from "../lib/ingestion-coverage.js";
import { detectCoverageGap } from "../lib/poller-batch.js";
import type { CoverageGap } from "../lib/store-meta.js";

const NOW = 1_760_000_000_000;

describe("buildCoverage verdict", () => {
  test("a fresh poll heartbeat vouches for an empty result", () => {
    const c = buildCoverage({
      lastPollTs: NOW - 5_000,
      lastGapAt: null,
      lastGapMissedUpdates: null,
      now: NOW,
    });
    expect(c.verdict).toBe("covered");
    expect(c.pollStaleMs).toBe(5_000);
    expect(c.reason).toContain("does mean nothing arrived");
    assertValidCoverage(c);
  });

  test("a STALE heartbeat makes the same empty result unverifiable", () => {
    const c = buildCoverage({
      lastPollTs: NOW - DEFAULT_POLL_STALENESS_MS - 1,
      lastGapAt: null,
      lastGapMissedUpdates: null,
      now: NOW,
    });
    expect(c.verdict).toBe("unverifiable");
    expect(c.reason).toContain("NOT");
    // The whole point: it must not read as a clean inbox.
    expect(c.reason).not.toContain("does mean nothing arrived");
    assertValidCoverage(c);
  });

  test("never having polled is unverifiable, not covered", () => {
    const c = buildCoverage({
      lastPollTs: 0,
      lastGapAt: null,
      lastGapMissedUpdates: null,
      now: NOW,
    });
    expect(c.verdict).toBe("unverifiable");
    expect(c.lastPollTs).toBeNull();
    expect(c.pollStaleMs).toBeNull();
    assertValidCoverage(c);
  });

  test("a recorded gap is reported as a permanent hole WITHOUT making a live bridge unverifiable", () => {
    const c = buildCoverage({
      lastPollTs: NOW - 1_000,
      lastGapAt: NOW - 86_400_000,
      lastGapMissedUpdates: 52,
      now: NOW,
    });
    // Ingestion is live NOW, so the verdict stays honest about the present...
    expect(c.verdict).toBe("covered");
    // ...while the historical hole is still surfaced, with its size.
    expect(c.lastGapMissedUpdates).toBe(52);
    expect(c.reason).toContain("52 update(s)");
    expect(c.reason).toContain("hole");
    assertValidCoverage(c);
  });
});

describe("assertValidCoverage fails where the answer is BUILT", () => {
  test("rejects a bogus verdict", () => {
    expect(() =>
      assertValidCoverage({
        verdict: "probably" as unknown as "covered",
        lastPollTs: NOW,
        pollStaleMs: 0,
        stalenessThresholdMs: 1,
        lastGapAt: null,
        lastGapMissedUpdates: null,
        reason: "x",
      }),
    ).toThrow(/verdict invalid/);
  });

  test("rejects pollStaleMs that disagrees with lastPollTs", () => {
    expect(() =>
      assertValidCoverage({
        verdict: "covered",
        lastPollTs: null,
        pollStaleMs: 5,
        stalenessThresholdMs: 1,
        lastGapAt: null,
        lastGapMissedUpdates: null,
        reason: "x",
      }),
    ).toThrow(/null exactly when/);
  });

  test("rejects an empty reason", () => {
    expect(() =>
      assertValidCoverage({
        verdict: "unverifiable",
        lastPollTs: null,
        pollStaleMs: null,
        stalenessThresholdMs: 1,
        lastGapAt: null,
        lastGapMissedUpdates: null,
        reason: "",
      }),
    ).toThrow(/must say WHY/);
  });
});

describe("detectCoverageGap — the signal the heartbeat cannot carry", () => {
  function capture(updates: any[], startOffset: number): CoverageGap[] {
    const seen: CoverageGap[] = [];
    detectCoverageGap(
      updates,
      startOffset,
      (g) => seen.push(g),
      () => NOW,
    );
    return seen;
  }

  test("records the gap when Telegram answers ABOVE the offset we asked for", () => {
    const seen = capture([{ update_id: 882957080 }], 882957028);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ at: NOW, missedUpdates: 52 });
  });

  test("a contiguous batch records nothing", () => {
    expect(capture([{ update_id: 100 }, { update_id: 101 }], 100)).toEqual([]);
  });

  test("the FIRST poll (offset 0) can never report a gap", () => {
    expect(capture([{ update_id: 882957080 }], 0)).toEqual([]);
  });

  test("an empty batch records nothing", () => {
    expect(capture([], 100)).toEqual([]);
  });

  test("a recorder that throws does not break ingestion", () => {
    expect(() =>
      detectCoverageGap(
        [{ update_id: 200 }],
        100,
        () => {
          throw new Error("disk full");
        },
        () => NOW,
      ),
    ).not.toThrow();
  });
});
