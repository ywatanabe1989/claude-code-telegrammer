/**
 * store.ts::ensureColumn under a genuine two-process race.
 *
 * WHAT THIS USED TO CATCH. The previous engine had no `ADD COLUMN IF NOT
 * EXISTS`, so ensureColumn had to read the table's columns and then ALTER —
 * a check-then-act whose window two concurrently-starting processes really
 * did hit. The loser got a FATAL "duplicate column name", and because that
 * throw escaped initStore() at top level, the poller went silently inert:
 * process alive, nothing polling, nothing to notice.
 *
 * WHAT IS TRUE NOW. The statement is a single atomic `ADD COLUMN IF NOT
 * EXISTS` that holds the table lock for its whole duration, so the loser
 * observes the column present and does nothing. The old window is closed by
 * construction rather than by a catch.
 *
 * WHY THIS FILE SURVIVES ANYWAY. The property worth pinning was never "that
 * specific error string does not appear" — it was BOTH PROCESSES SURVIVE AND
 * THE COLUMN EXISTS ONCE. That is still exactly what a startup race has to
 * produce, it is still what the poller's liveness depends on, and it is still
 * only provable with two real processes. Concurrent DDL can also lose a
 * catalog race ("tuple concurrently updated"), which ensureColumn tolerates
 * for the same reason the old code tolerated the duplicate-column error, so
 * the failure mode has moved rather than vanished.
 *
 * No mocks: two real spawned processes against one real server.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { join } from "path";
import { getSql, quoteSchema } from "../lib/pg.js";

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "ensure-column-race-fixture.ts",
);
const ATTEMPTS = 10;

const created: string[] = [];

afterAll(async () => {
  for (const schema of created) {
    await getSql().unsafe(`DROP SCHEMA IF EXISTS ${quoteSchema(schema)} CASCADE`);
  }
});

interface AttemptResult {
  exit1: number;
  exit2: number;
  stderr1: string;
  stderr2: string;
  forwardJsonColumns: number;
}

async function raceOnce(index: number): Promise<AttemptResult> {
  const sql = getSql();
  // A fresh namespace per attempt, so every race starts from the exact
  // precondition the migration exists to handle: a `messages` table that
  // exists and does NOT yet have forward_json.
  const schema = `cct_test_${Date.now()}_race_${process.pid}_${index}`;
  created.push(schema);
  const s = quoteSchema(schema);
  await sql
    .unsafe(
      `CREATE SCHEMA ${s};
       CREATE TABLE ${s}.messages (id BIGSERIAL PRIMARY KEY);`,
    )
    .simple();

  const startAt = Date.now() + 100;
  const spawnWorker = (workerId: string) =>
    Bun.spawn(
      [process.execPath, "run", FIXTURE, workerId, schema, String(startAt)],
      { stdout: "pipe", stderr: "pipe" },
    );

  const w1 = spawnWorker("1");
  const w2 = spawnWorker("2");

  const [exit1, exit2, stderr1, stderr2] = await Promise.all([
    w1.exited,
    w2.exited,
    new Response(w1.stderr as ReadableStream).text(),
    new Response(w2.stderr as ReadableStream).text(),
  ]);

  const cols = (await sql.unsafe(
    "SELECT column_name FROM information_schema.columns" +
      " WHERE table_schema = $1 AND table_name = 'messages'" +
      " AND column_name = 'forward_json'",
    [schema],
  )) as unknown[];

  return {
    exit1,
    exit2,
    stderr1,
    stderr2,
    forwardJsonColumns: cols.length,
  };
}

describe("store.ts::ensureColumn — multi-process migration race", () => {
  test(`${ATTEMPTS} independent two-process race attempts against fresh namespaces both survive and add the column exactly once`, async () => {
    const results: AttemptResult[] = [];
    for (let i = 0; i < ATTEMPTS; i++) {
      results.push(await raceOnce(i));
    }

    const failures = results
      .map((r, i) => ({ i, ...r }))
      .filter((r) => r.exit1 !== 0 || r.exit2 !== 0);

    expect(
      failures,
      `${failures.length}/${ATTEMPTS} attempts failed:\n` +
        failures
          .map(
            (f) =>
              `  attempt ${f.i}: exit1=${f.exit1} exit2=${f.exit2}\n    stderr1=${f.stderr1.trim()}\n    stderr2=${f.stderr2.trim()}`,
          )
          .join("\n"),
    ).toEqual([]);

    // The other half of the property: surviving is not enough if the racing
    // pair left the schema wrong.
    expect(results.map((r) => r.forwardJsonColumns)).toEqual(
      Array(ATTEMPTS).fill(1),
    );
  }, 60_000);
});
