/**
 * Migration safety: confirm the forward_json column can be added to
 * a pre-existing (legacy-schema) messages table WITHOUT losing data,
 * and that the migration is idempotent across re-runs.
 *
 * Exercises the same ensureColumn helper initStore() uses on every
 * startup. No mocks — a real PostgreSQL server, a real ALTER TABLE, in a
 * throwaway namespace created and dropped by this file.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { getSql, quoteSchema } from "../lib/pg.js";
import { ensureColumn } from "../lib/store.js";

/**
 * Its own namespace, not the suite's shared one: this file DELIBERATELY builds
 * a table missing a column the real schema has, and dropping that mess into the
 * namespace every other test file shares would corrupt them. The `cct_test_`
 * prefix keeps it inside what the preload's stale-namespace sweep will clean up
 * if this process dies before afterAll runs.
 */
const SCHEMA = `cct_test_${Date.now()}_mig_${process.pid}`;
const S = quoteSchema(SCHEMA);

afterAll(async () => {
  await getSql().unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
});

async function columnNames(table: string): Promise<string[]> {
  const rows = (await getSql().unsafe(
    "SELECT column_name FROM information_schema.columns" +
      " WHERE table_schema = $1 AND table_name = $2",
    [SCHEMA, table],
  )) as Array<{ column_name: string }>;
  return rows.map((r) => r.column_name);
}

describe("ensureColumn migration helper", () => {
  test("adds forward_json TEXT to a legacy messages table and preserves data", async () => {
    const sql = getSql();

    // 1) Build legacy schema (no forward_json) + insert a real row.
    await sql
      .unsafe(
        `CREATE SCHEMA ${S};
         CREATE TABLE ${S}.messages (
           id BIGSERIAL PRIMARY KEY,
           direction TEXT NOT NULL,
           chat_id TEXT NOT NULL,
           message_id TEXT,
           text TEXT
         );`,
      )
      .simple();
    await sql.unsafe(
      `INSERT INTO ${S}.messages (direction, chat_id, message_id, text)` +
        ` VALUES ('inbound', 'legacy-chat', 'legacy-1', 'pre-migration body')`,
    );

    expect(await columnNames("messages")).not.toContain("forward_json");

    // 2) Run the migration — adds forward_json column.
    await ensureColumn(SCHEMA, "messages", "forward_json", "TEXT");

    expect(await columnNames("messages")).toContain("forward_json");

    // 3) Legacy row survives + forward_json is NULL on it (the default for
    //    ADD COLUMN without a DEFAULT clause).
    const [row] = (await sql.unsafe(
      `SELECT * FROM ${S}.messages WHERE chat_id = 'legacy-chat'`,
    )) as Array<Record<string, unknown>>;
    expect(row.text).toBe("pre-migration body");
    expect(row.forward_json).toBeNull();

    // 4) Re-run is idempotent — must NOT throw "duplicate column".
    await ensureColumn(SCHEMA, "messages", "forward_json", "TEXT");
    expect(
      (await columnNames("messages")).filter((c) => c === "forward_json"),
    ).toHaveLength(1);

    // 5) New rows can persist non-null forward_json after migration.
    await sql.unsafe(
      `INSERT INTO ${S}.messages (direction, chat_id, message_id, text, forward_json)` +
        ` VALUES ('inbound', 'legacy-chat', 'post-1', 'after migration', $1)`,
      [JSON.stringify({ kind: "user", from_name: "X" })],
    );
    const [postRow] = (await sql.unsafe(
      `SELECT * FROM ${S}.messages WHERE message_id = 'post-1'`,
    )) as Array<Record<string, unknown>>;
    expect(typeof postRow.forward_json).toBe("string");
  });

  // The identifiers reaching this DDL are code-supplied, and the helper
  // enforces that rather than trusting it. A caller that gets a table or
  // column name from anywhere else must be stopped at the door, not escaped
  // and executed.
  test("refuses an identifier that could carry SQL", async () => {
    await expect(
      ensureColumn(SCHEMA, 'messages"; DROP TABLE x; --', "c", "TEXT"),
    ).rejects.toThrow(/refusing to build DDL/i);
  });
});
