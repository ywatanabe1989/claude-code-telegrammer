#!/usr/bin/env bun
/**
 * Fixture for ts/test/store-migration-race.test.ts (adversarial-review
 * finding #1). Races ONLY store.ts::ensureColumn itself against an
 * ALREADY-EXISTING (but not yet migrated) namespace — deliberately isolated
 * from the rest of initStore()'s schema-creation statements, which otherwise
 * tend to serialize/desynchronize two racing processes well before they ever
 * reach the migration, making the narrow race hard to trigger via realistic
 * full-initStore() timing.
 *
 * Usage: bun run ensure-column-race-fixture.ts <workerId> <schema> <startAtEpochMs>
 */

import { closeSql } from "../../lib/pg.js";
import { ensureColumn } from "../../lib/store.js";

const [, , workerId, schema, startAtArg] = process.argv;
const startAt = Number(startAtArg);

while (Date.now() < startAt) {
  // deliberate short-lived busy-wait — synchronizes sibling processes
}

try {
  await ensureColumn(schema, "messages", "forward_json", "TEXT");
  process.stdout.write(`worker ${workerId} ensureColumn ok\n`);
  await closeSql();
  process.exit(0);
} catch (err) {
  process.stderr.write(
    `worker ${workerId} FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  await closeSql();
  process.exit(1);
}
