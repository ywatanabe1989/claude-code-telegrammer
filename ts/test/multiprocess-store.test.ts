/**
 * Genuine multi-process concurrency against the shared message store.
 *
 * Explicitly called out in the architecture-fix task (incident-cct-inbound-
 * dies-silently-with-mcp-server-20260711 follow-up, 2026-07): once the poller
 * and the MCP server are two independent OS processes sharing one store, the
 * "many independent writers, one store" shape this codebase relies on needed
 * to be verified for REAL, genuinely concurrent writers across PROCESS
 * boundaries — not just concurrent async calls within one process, which is
 * all any other test exercises. This spawns two REAL separate `bun` processes
 * (ts/test/fixtures/concurrent-writer-fixture.ts) that both call initStore()
 * and write into the SAME namespace concurrently, then asserts every row from
 * both workers survived, distinct and complete.
 *
 * WHAT THE ENGINE MOVE CHANGED HERE, HONESTLY. The old version also asserted
 * `PRAGMA integrity_check` — a file-format check with no equivalent worth
 * running here, because a server enforcing ACID does not hand back a
 * half-written page for a client to detect. What is NOT dropped is the part
 * that was always the real question and is still answerable: did both writers
 * survive, did every row land, and is each one distinct. Those three are what
 * a torn concurrent write would break, and they are asserted below.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { join } from "path";
import { getSql, quoteSchema } from "../lib/pg.js";

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "concurrent-writer-fixture.ts",
);
const ROWS_PER_WORKER = 50;

/** Its own namespace so 100 fixture rows never reach the shared suite one. */
const SCHEMA = `cct_test_${Date.now()}_mp_${process.pid}`;
const S = quoteSchema(SCHEMA);

afterAll(async () => {
  await getSql().unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
});

describe("multi-process concurrent writers against the shared store", () => {
  test("two real bun processes writing concurrently produce zero errors and every row lands", async () => {
    const spawnWorker = (workerId: string) =>
      Bun.spawn(
        [process.execPath, "run", FIXTURE, workerId, String(ROWS_PER_WORKER)],
        {
          env: {
            ...process.env,
            // The child runs under `bun run`, so it gets NO test preload —
            // both of these have to be handed over explicitly, and the
            // cct_test_ prefix is what keeps lib/hermetic-guard.ts satisfied
            // that this is not production.
            NODE_ENV: "test",
            CCT_STORE_SCHEMA: SCHEMA,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

    // Spawn BOTH before awaiting either — this is the whole point:
    // genuinely overlapping, concurrent writers, not sequential ones.
    const w1 = spawnWorker("1");
    const w2 = spawnWorker("2");

    const [exit1, exit2, stdout1, stdout2, stderr1, stderr2] =
      await Promise.all([
        w1.exited,
        w2.exited,
        new Response(w1.stdout as ReadableStream).text(),
        new Response(w2.stdout as ReadableStream).text(),
        new Response(w1.stderr as ReadableStream).text(),
        new Response(w2.stderr as ReadableStream).text(),
      ]);

    // Both workers must exit 0. stderr is NOT expected to be empty — the
    // fixture's own initStore() call logs a normal, benign
    // `{"component":"store","msg":"initialized in schema ..."}` line there
    // (see lib/log.ts: "Structured JSON logging to stderr" is this
    // codebase's deliberate convention, stdout stays reserved for MCP stdio
    // / CLI-probe JSON). A serialization failure, a deadlock or a constraint
    // collision would instead surface as an UNCAUGHT exception (the fixture
    // does not catch saveInbound errors) — a non-zero exit code AND a stack
    // trace on stderr, neither of which is present here.
    const errorIndicators =
      /deadlock|could not serialize|duplicate key|Uncaught|unhandled/i;
    expect(exit1).toBe(0);
    expect(stderr1).not.toMatch(errorIndicators);
    expect(exit2).toBe(0);
    expect(stderr2).not.toMatch(errorIndicators);
    expect(stdout1).toContain(`worker 1 wrote ${ROWS_PER_WORKER} rows`);
    expect(stdout2).toContain(`worker 2 wrote ${ROWS_PER_WORKER} rows`);

    // Read back through a THIRD, independent connection — the exact shape
    // the real MCP-server + poller processes use — and verify full row
    // survival from BOTH workers.
    const sql = getSql();
    const [total] = (await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM ${S}.messages WHERE chat_id = 'concurrency-test'`,
    )) as Array<{ n: number }>;
    expect(total.n).toBe(ROWS_PER_WORKER * 2);

    const perWorker = (await sql.unsafe(
      `SELECT user_id, COUNT(*)::int AS n FROM ${S}.messages
         WHERE chat_id = 'concurrency-test'
         GROUP BY user_id ORDER BY user_id`,
    )) as Array<{ user_id: string; n: number }>;
    expect(perWorker).toEqual([
      { user_id: "1", n: ROWS_PER_WORKER },
      { user_id: "2", n: ROWS_PER_WORKER },
    ]);

    // No duplicate/collided message_ids — every row from both workers is
    // distinct and present.
    const [distinct] = (await sql.unsafe(
      `SELECT COUNT(DISTINCT message_id)::int AS n FROM ${S}.messages WHERE chat_id = 'concurrency-test'`,
    )) as Array<{ n: number }>;
    expect(distinct.n).toBe(ROWS_PER_WORKER * 2);
  }, 60_000); // generous: two real bun process spawns + 100 real round trips
});
