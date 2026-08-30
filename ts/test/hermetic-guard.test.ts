/**
 * The guard that would have stopped me destroying the operator's bridge.
 *
 * On 2026-07-14 I ran `bun test ts/test/...` from the repo root. Bun reads
 * bunfig.toml from the CURRENT WORKING DIRECTORY, the only bunfig lived in ts/,
 * so the hermetic preload never loaded. The suite inherited my real agent
 * environment, resolved the store to the LIVE bridge, and store.test.ts's
 * `saveOffset(99999)` overwrote the operator's real Telegram getUpdates
 * watermark (348318289 -> 99999) plus his wake-health state.
 *
 * It printed nothing. It just worked, against the wrong database — while I
 * spent hours hunting a "mysterious" poller failure I was very likely causing.
 *
 * A repo-root bunfig removes the cwd dependency. This removes the SILENCE.
 *
 * WHAT THE STORAGE-ENGINE MOVE CHANGED. The guard used to compare the state
 * DIRECTORY against the temp dir, because the store was a file underneath it.
 * The store is a PostgreSQL namespace now, so the same question is asked of the
 * SCHEMA. Same force, same trigger, different noun — and the case below is
 * still the case: a test run that resolves the live agent's own namespace is
 * refused before it can write a single row.
 */

import { describe, test, expect } from "bun:test";
import {
  assertHermeticTestStore,
  TEST_SCHEMA_PREFIX,
} from "../lib/hermetic-guard.js";

/** What a lost preload resolves to: this agent's real, live namespace. */
const LIVE = "cct_scitex_agent_container";
const HERMETIC = `${TEST_SCHEMA_PREFIX}1788000000000_1234`;

describe("assertHermeticTestStore", () => {
  // THE CASE. Everything else is bookkeeping.
  test("THROWS when a test run would open a live production store", () => {
    expect(() => assertHermeticTestStore("test", LIVE)).toThrow();
  });

  test("the message names the cause and the fix, not just the symptom", () => {
    let msg = "";
    try {
      assertHermeticTestStore("test", LIVE);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain("LIVE PRODUCTION STORE");
    expect(msg).toContain("preload");
    expect(msg).toContain("bunfig.toml"); // the actual cause
    expect(msg).toContain(LIVE); // the actual namespace it refused
    expect(msg).toContain(TEST_SCHEMA_PREFIX); // what it wanted instead
  });

  test("allows a hermetic test store (the preload ran)", () => {
    expect(() => assertHermeticTestStore("test", HERMETIC)).not.toThrow();
  });

  // A near-miss must still be refused. The prefix is the whole discriminator,
  // so a name that merely CONTAINS it — the shape a careless override or a
  // string-concatenation slip produces — has to fail, or the guard degrades
  // into "looks vaguely test-ish" without anyone noticing.
  test("a namespace that only CONTAINS the prefix is still refused", () => {
    expect(() =>
      assertHermeticTestStore("test", `cct_live_${TEST_SCHEMA_PREFIX}shadow`),
    ).toThrow();
  });

  // The guard must be INERT in production. The real poller and MCP server open
  // the live store on purpose, every time they start — if this ever fired
  // there, it would take down the bridge it exists to protect.
  test("is inert outside a test run — production opens the live store on purpose", () => {
    expect(() => assertHermeticTestStore(undefined, LIVE)).not.toThrow();
    expect(() => assertHermeticTestStore("production", LIVE)).not.toThrow();
  });
});
