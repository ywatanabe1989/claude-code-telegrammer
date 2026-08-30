/**
 * The poller's key/value state, extracted from store.ts.
 *
 * store.ts owns MESSAGES (rows the operator can read back). This file owns
 * the small set of scalars the poll loop needs to survive a restart, each a
 * single row in the `meta` table:
 *
 *   update_offset  — the getUpdates offset it is safe to resume from.
 *   last_poll_ts   — epoch-ms of the most recent getUpdates RETURN. Persisted
 *                    (not just in-process) so an out-of-band probe can read
 *                    poll-freshness after the fact; a wedged-but-alive poller
 *                    (process up, kill-0 passes, getUpdates never returns) is
 *                    otherwise invisible to a liveness check.
 *   coverage_gap   — the most recent observed DISCONTINUITY in Telegram's
 *                    update_id sequence: proof that updates Telegram counted
 *                    never reached this store. See ingestion-coverage.ts.
 *
 * WHY A SEPARATE FILE: store.ts had reached the repo's 512-line ceiling, and
 * these three are one coherent responsibility (poller restart-state) rather
 * than three-quarters of a message store. store.ts re-exports every function
 * below, so existing importers keep importing from ./store.js unchanged.
 */

import { getSql } from "./pg.js";
import type { Statements } from "./store-schema.js";

let stmt: Statements | null = null;

/**
 * A recorded discontinuity: at {@link at} (epoch-ms) we asked Telegram for
 * updates from offset N and it answered starting at N+{@link missedUpdates},
 * so that many update_ids were consumed by someone else — or dropped by
 * Telegram's ~24h retention — and will never be written here.
 */
export interface CoverageGap {
  at: number;
  missedUpdates: number;
}

/** Bind the meta statements. Called by store.ts::initStore with its schema. */
export function initStoreMeta(statements: Statements): void {
  stmt = statements;
}

function ready(): Statements {
  if (!stmt) throw new Error("store not initialized");
  return stmt;
}

async function writeKey(key: string, value: string): Promise<void> {
  await getSql().unsafe(ready().metaUpsert, [key, value]);
}

async function readKey(key: string): Promise<string | null> {
  const rows = await getSql().unsafe(ready().metaRead, [key]);
  const row = rows[0] as { value: string } | undefined;
  return row ? row.value : null;
}

async function readInt(key: string): Promise<number> {
  const value = await readKey(key);
  return value === null ? 0 : parseInt(value, 10);
}

export async function saveOffset(offset: number): Promise<void> {
  await writeKey("update_offset", String(offset));
}

export async function loadOffset(): Promise<number> {
  return readInt("update_offset");
}

export async function saveLastPollTs(epochMs: number): Promise<void> {
  await writeKey("last_poll_ts", String(epochMs));
}

export async function loadLastPollTs(): Promise<number> {
  return readInt("last_poll_ts");
}

/**
 * Record a discontinuity. Last-one-wins on purpose: the read path needs "has
 * this store ever failed to be continuous, and when" — not an audit log. The
 * full detail is in the poller log line emitted alongside this write.
 */
export async function saveCoverageGap(gap: CoverageGap): Promise<void> {
  await writeKey("coverage_gap", JSON.stringify(gap));
}

/**
 * The most recent recorded gap, or null when none has EVER been observed —
 * which is not the same as "there was none", and the caller is told so by
 * ingestion-coverage.ts rather than being handed a bare false.
 *
 * A malformed row returns null rather than throwing: a corrupt diagnostic
 * must never take down the read path it exists to annotate.
 */
export async function loadCoverageGap(): Promise<CoverageGap | null> {
  const value = await readKey("coverage_gap");
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CoverageGap>;
    if (
      typeof parsed.at !== "number" ||
      typeof parsed.missedUpdates !== "number"
    ) {
      return null;
    }
    return { at: parsed.at, missedUpdates: parsed.missedUpdates };
  } catch {
    return null;
  }
}
