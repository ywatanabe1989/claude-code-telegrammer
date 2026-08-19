/**
 * `ok` MUST MEAN EVALUATED-AND-PASSED.
 *
 * Measured during the 2026-08-16 scitex-hub incident, verbatim from `health`
 * while the operator's inbound channel was completely dead:
 *
 *     poller_alive      FAIL   "recorded poller pid 154 ... is NOT alive"
 *     ingestion_live    ok     "not evaluated — the poller process is not running"
 *     inbound_recency   ok     "newest stored inbound 45m ago; cursor idle"
 *     summary: "14/15 checks ok; FAILING: poller_alive"
 *
 * Two checks reported `ok` while saying, in their own detail string, that they
 * had not evaluated. The summary then counted them as passing. A reader sees
 * 14/15 green and one isolated failure, when the truth is that the two checks
 * which would have revealed the outage never ran.
 *
 * That is the constitution's three-valued collapse: "unknown" written as "ok".
 * The same package already fixed this shape on the READ path in v0.6.0
 * (coverage_gap: "no unread" vs "I cannot vouch for the window since T"); the
 * doctor had the identical collapse in a different module.
 *
 * A check whose PRECONDITION failed is UNKNOWN, not ok. Distinct from
 * `skipped: telegram disabled`, which is a deliberate configuration choice and
 * genuinely not-applicable rather than unmeasured.
 */

import { describe, test, expect } from "bun:test";
import { unknownCheck } from "../lib/health-checks.js";
import { summarise } from "../lib/health.js";

const entry = (name: string, ok: boolean) => ({
  entry: { name, ok, detail: "", hint: null },
  warn: false,
});

describe("unknown is not ok", () => {
  test("an unknown check does not read ok", () => {
    const u = unknownCheck("ingestion_live", "the poller process is not running");
    expect(u.entry.ok).toBe(false);
    expect(u.entry.evaluated).toBe(false);
    expect(u.entry.detail).toContain("not evaluated");
  });

  test("the summary counts unknown SEPARATELY, never as green", () => {
    const out = summarise([
      entry("a", true),
      entry("b", true),
      unknownCheck("ingestion_live", "the poller process is not running"),
      entry("poller_alive", false),
    ]);
    // 2 ok, 1 unknown, 1 fail — the unknown must be visible and must not be
    // absorbed into either pole.
    expect(out.summary).toContain("2/4 checks ok");
    expect(out.summary).toContain("unknown: ingestion_live");
    expect(out.summary).toContain("FAILING: poller_alive");
  });

  test("an unknown check is NOT reported as a failure either", () => {
    // It did not fail. Collapsing unknown into FAIL is the same error in the
    // other direction and would page someone for a check that never ran.
    const out = summarise([
      entry("a", true),
      unknownCheck("ingestion_live", "the poller process is not running"),
    ]);
    expect(out.summary).not.toContain("FAILING");
    expect(out.summary).toContain("unknown: ingestion_live");
  });

  test("all-evaluated-and-passing still reads clean", () => {
    const out = summarise([entry("a", true), entry("b", true)]);
    expect(out.summary).toBe("2/2 checks ok");
    expect(out.ok).toBe(true);
  });
});
