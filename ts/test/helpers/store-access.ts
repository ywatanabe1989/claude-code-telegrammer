/**
 * Raw store access for tests, against a REAL PostgreSQL server.
 *
 * Not a mock and not an in-memory stand-in: these helpers hand a test the same
 * pooled connection and the same namespace the code under test uses, so a test
 * that seeds a row or reads one back is making a genuine round trip. The
 * namespace is the throwaway one ts/test/preload.ts created for this process,
 * which is also what lib/hermetic-guard.ts checks before the store will open at
 * all — so a test cannot reach production through here even by mistake.
 *
 * Tests used to reach the store by opening a second handle onto its file. That
 * is not available across a network, and it was never a good idea: a second
 * handle is a second opinion about the schema. One connection, one namespace.
 */

import { getSql, quoteSchema, resolveSchema } from "../../lib/pg.js";
import { statements } from "../../lib/store-schema.js";

/** The throwaway namespace this test process owns. */
export function schema(): string {
  return resolveSchema();
}

/** `"cct_test_…"`, quoted for splicing into a statement. */
export function qs(): string {
  return quoteSchema(schema());
}

/** The same statement set the store itself issues, bound to this namespace. */
export function stmts() {
  return statements(schema());
}

/**
 * Run one statement in the test namespace and return its rows.
 *
 * `sql` may contain `${SCHEMA}`, which is replaced by the quoted namespace —
 * so a test can write `SELECT * FROM ${SCHEMA}.messages` and stay readable.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const text = sql.replaceAll("${SCHEMA}", qs());
  return (await getSql().unsafe(text, params)) as T[];
}

/** Insert one row and return its id — the common "seed a fixture row" case. */
export async function insertRow(
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const rows = await query<{ id: string | number }>(sql, params);
  return Number(rows[0].id);
}

/** Remove every row from this namespace's tables. Attachments cascade. */
export async function truncateAll(): Promise<void> {
  await query("TRUNCATE ${SCHEMA}.attachments, ${SCHEMA}.messages CASCADE");
  await query("DELETE FROM ${SCHEMA}.meta");
}
