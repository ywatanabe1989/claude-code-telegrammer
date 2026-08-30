/**
 * Schema-migration helpers for lib/store.ts. Extracted to its own module to
 * keep store.ts under this repo's per-file line cap (the same "extract for
 * the line cap" pattern already used for lib/handle-update.ts /
 * lib/poller-batch.ts / lib/tools-messages.ts).
 */

import { getSql, quoteSchema } from "./pg.js";
import { log } from "./log.js";

/**
 * Is this the "someone else created it at the same instant" error?
 *
 * `IF NOT EXISTS` reads like it settles concurrency and does not: PostgreSQL
 * documents it as a check-then-create with a race, and the loser gets a
 * catalog unique-violation rather than a quiet no-op. MEASURED, not
 * theorised — two real processes calling initStore() against the same fresh
 * namespace, and the loser died with `duplicate key value violates unique
 * constraint "pg_namespace_nspname_index"`.
 *
 * That pairing matters here more than anywhere else in this codebase. The MCP
 * server and its poller start TOGETHER and both call initStore(), so first
 * boot is exactly when they collide — and a throw out of initStore() lands at
 * top level, where JavaScript cannot resume, so the poller would go SILENTLY
 * INERT: process alive, pidfile fresh, nothing ingesting. That is the
 * 2026-07 incident this codebase already paid for once under the previous
 * engine, arriving through a different door.
 *
 * Matched on SQLSTATE, not on prose. The old engine's equivalent guard had to
 * match an error MESSAGE because it reported no distinguishing code, and its
 * comment said plainly that a prose match is normally the wrong thing to do.
 * Here there are real codes, so the guard uses them.
 */
export function isConcurrentDdlRace(err: unknown): boolean {
  const code = (err as { errno?: string; code?: string } | null)?.errno;
  // 23505 unique_violation (a catalog row), 42P07 duplicate_table,
  // 42710 duplicate_object, 42P06 duplicate_schema.
  if (code && ["23505", "42P07", "42710", "42P06"].includes(code)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists|duplicate key|tuple concurrently updated/i.test(msg);
}

/** Column names are code-supplied, never user input — enforce that. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to build DDL with the identifier "${name}"`);
  }
  return `"${name}"`;
}

/**
 * Idempotent ALTER TABLE ADD COLUMN.
 *
 * CREATE TABLE IF NOT EXISTS does NOT update existing tables when columns are
 * added to the schema, so store.ts::initStore() calls this on every startup to
 * bring older namespaces forward without dropping data.
 *
 * WHAT THE ENGINE MOVE RETIRED, AND WHAT IT DID NOT. The previous engine had
 * no `IF NOT EXISTS` here, so this function had to read the table's columns
 * and then ALTER — a check-then-act whose window two concurrently-starting
 * processes (an MCP server and its freshly-spawned poller both calling
 * initStore()) really did hit, leaving the loser with a fatal "duplicate
 * column name" that killed the poller's top-level bootstrap silently. That
 * race is gone: the statement below is a single atomic one, and it takes the
 * table lock for its whole duration, so the loser observes the column already
 * present and does nothing.
 *
 * The TOLERANT CATCH stays anyway. Concurrent DDL on one table can still lose
 * a catalog race ("tuple concurrently updated") under contention, and the
 * consequence of treating that as fatal is unchanged from the incident this
 * guard was written for: a poller that goes inert with nothing to notice.
 * Losing this race means the column exists either way, so it is an expected
 * outcome, not an error — and it is LOGGED rather than swallowed.
 */
export async function ensureColumn(
  schema: string,
  table: string,
  column: string,
  decl: string,
): Promise<void> {
  const target = `${quoteSchema(schema)}.${quoteIdent(table)}`;
  try {
    await getSql().unsafe(
      `ALTER TABLE ${target} ADD COLUMN IF NOT EXISTS ${quoteIdent(column)} ${decl}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isConcurrentDdlRace(err) && !/duplicate column/i.test(msg)) throw err;
    log(
      "store",
      `ensureColumn: lost the race adding ${table}.${column} — another ` +
        `process already added it concurrently; treating as success`,
    );
  }
}
