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

import type { Database, Statement } from "bun:sqlite";

let stmtSaveOffset: Statement | null = null;
let stmtLoadOffset: Statement | null = null;
let stmtSaveLastPollTs: Statement | null = null;
let stmtLoadLastPollTs: Statement | null = null;
let stmtSaveCoverageGap: Statement | null = null;
let stmtLoadCoverageGap: Statement | null = null;

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

/** Prepare the meta statements. Called by store.ts::initStore with its db. */
export function initStoreMeta(db: Database): void {
  const upsert = (key: string) =>
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('${key}', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  const read = (key: string) =>
    db.prepare(`SELECT value FROM meta WHERE key = '${key}'`);

  stmtSaveOffset = upsert("update_offset");
  stmtLoadOffset = read("update_offset");
  stmtSaveLastPollTs = upsert("last_poll_ts");
  stmtLoadLastPollTs = read("last_poll_ts");
  stmtSaveCoverageGap = upsert("coverage_gap");
  stmtLoadCoverageGap = read("coverage_gap");
}

function readInt(stmt: Statement | null): number {
  if (!stmt) throw new Error("store not initialized");
  const row = stmt.get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function saveOffset(offset: number): void {
  if (!stmtSaveOffset) throw new Error("store not initialized");
  stmtSaveOffset.run(String(offset));
}

export function loadOffset(): number {
  return readInt(stmtLoadOffset);
}

export function saveLastPollTs(epochMs: number): void {
  if (!stmtSaveLastPollTs) throw new Error("store not initialized");
  stmtSaveLastPollTs.run(String(epochMs));
}

export function loadLastPollTs(): number {
  return readInt(stmtLoadLastPollTs);
}

/**
 * Record a discontinuity. Last-one-wins on purpose: the read path needs "has
 * this store ever failed to be continuous, and when" — not an audit log. The
 * full detail is in the poller log line emitted alongside this write.
 */
export function saveCoverageGap(gap: CoverageGap): void {
  if (!stmtSaveCoverageGap) throw new Error("store not initialized");
  stmtSaveCoverageGap.run(JSON.stringify(gap));
}

/**
 * The most recent recorded gap, or null when none has EVER been observed —
 * which is not the same as "there was none", and the caller is told so by
 * ingestion-coverage.ts rather than being handed a bare false.
 *
 * A malformed row returns null rather than throwing: a corrupt diagnostic
 * must never take down the read path it exists to annotate.
 */
export function loadCoverageGap(): CoverageGap | null {
  if (!stmtLoadCoverageGap) throw new Error("store not initialized");
  const row = stmtLoadCoverageGap.get() as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<CoverageGap>;
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
