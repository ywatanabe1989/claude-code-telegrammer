#!/usr/bin/env bun
/**
 * Fixture process for ts/test/multiprocess-store.test.ts.
 *
 * NOT a test file itself (no `.test.` in the name — bun test's default file
 * discovery skips it) and not run directly by `bun test`; it is spawned as
 * a REAL, separate OS process by that test to exercise genuine multi-process
 * write concurrency against lib/store.ts's schema.
 *
 * Usage: bun run concurrent-writer-fixture.ts <workerId> <count>
 * Env: CCT_STORE_SCHEMA must already name the shared namespace when this
 * process starts, and NODE_ENV must be "test" (both set by the parent test
 * via Bun.spawn's `env` option). This process is started with `bun run`, not
 * `bun test`, so it gets no preload of its own — those two variables are the
 * whole of its hermetic configuration, and the namespace name must carry the
 * cct_test_ prefix or lib/hermetic-guard.ts refuses to open the store.
 *
 * Calls initStore() — the exact schema-init path every real poller / MCP-
 * server process uses — then performs `count` real saveInbound() calls
 * tagged with this workerId, each on its own message_id so no two workers'
 * rows collide on the (chat_id, message_id, direction) dedup unique index;
 * this test is about concurrent-write SAFETY, not dedup behaviour (already
 * covered elsewhere — ts/test/store.test.ts).
 */

import { initStore, saveInbound } from "../../lib/store.js";

const [, , workerIdArg, countArg] = process.argv;
const workerId = workerIdArg ?? "0";
const count = Number(countArg ?? "50");

await initStore();

for (let i = 0; i < count; i++) {
  await saveInbound({
    chat_id: "concurrency-test",
    message_id: `w${workerId}-${i}`,
    user_id: workerId,
    username: `worker${workerId}`,
    text: `message ${i} from worker ${workerId}`,
    telegram_ts: new Date().toISOString(),
    host: "test-host",
    project: "test-project",
    agent_id: `worker-${workerId}`,
    bot_token_hash: "testhash",
    raw_json: JSON.stringify({ worker: workerId, i }),
  });
}

process.stdout.write(`worker ${workerId} wrote ${count} rows\n`);
process.exit(0);
