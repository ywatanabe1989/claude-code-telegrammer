/**
 * Refuse to open a PRODUCTION store from inside a test run.
 *
 * WHAT HAPPENED (2026-07-14, and it was me):
 *
 * Bun reads bunfig.toml from the CURRENT WORKING DIRECTORY. The only bunfig
 * lived in ts/, so:
 *
 *     cd ts && bun test                 -> preload APPLIES -> hermetic
 *     bun test ts/test/...  (repo root) -> preload NEVER LOADS
 *
 * ts/test/preload.ts is correct and thorough — it deletes every CCT_* /
 * CLAUDE_CODE_TELEGRAMMER_* var and points the store at a throwaway namespace.
 * But when it does not run, the suite silently inherits the real environment of
 * whatever shell invoked it. On an agent host that resolves to the LIVE bridge
 * store, and the tests write to PRODUCTION.
 *
 * ts/test/store.test.ts calls `saveOffset(99999)`. Run that way, it executed
 * against the operator's real bridge and overwrote the live Telegram
 * getUpdates watermark (348318289 -> 99999) plus the wake-health state. Nothing
 * warned. It just worked, against the wrong database — while I spent hours
 * hunting a "mysterious" poller failure that I was very likely causing.
 *
 * A repo-root bunfig.toml removes the cwd dependency. THIS removes the silence:
 * losing the preload must be LOUD, because the failure mode is destroying
 * production and being told nothing.
 *
 * WHAT THE STORAGE-ENGINE MOVE CHANGED HERE. The guard used to compare the
 * state DIRECTORY against the temp dir, because the store was a file under it.
 * The store is now a PostgreSQL namespace, so the same question — "is this the
 * real one?" — is asked of the SCHEMA instead. The protection is identical in
 * force and identical in trigger; only the noun changed. Losing the preload
 * still means resolving the live agent's own namespace, and that is still
 * refused.
 *
 * `bun test` sets NODE_ENV="test" (verified empirically on Bun 1.3.11 — not
 * assumed). So: if we are in a test and the schema we are about to open is NOT
 * a throwaway one, the preload did not run, and we must abort rather than
 * write.
 */

/** Every namespace a test run is allowed to touch begins with this. */
export const TEST_SCHEMA_PREFIX = "cct_test_";

/**
 * Throws when a test run is about to open a store outside a test namespace.
 *
 * Pure and fully injectable so it can be tested without touching env or a real
 * database — the same seam pattern the rest of lib/ uses.
 *
 * @param nodeEnv process.env.NODE_ENV ("test" under `bun test`)
 * @param schema  the resolved schema the store is about to open
 */
export function assertHermeticTestStore(
  nodeEnv: string | undefined,
  schema: string,
): void {
  if (nodeEnv !== "test") return; // production: nothing to police
  if (schema.startsWith(TEST_SCHEMA_PREFIX)) return; // the preload ran

  throw new Error(
    `REFUSING TO OPEN THE STORE: NODE_ENV=test, but the resolved schema is ` +
      `not a test namespace.\n` +
      `  schema          = ${schema}\n` +
      `  required prefix = ${TEST_SCHEMA_PREFIX}\n` +
      `\n` +
      `The hermetic test preload (ts/test/preload.ts) did NOT run, so this ` +
      `test process inherited a real environment and is about to WRITE TO A ` +
      `LIVE PRODUCTION STORE.\n` +
      `\n` +
      `Cause: Bun reads bunfig.toml from the CURRENT WORKING DIRECTORY. Run ` +
      `the suite from the repo root or from ts/ (both now carry a bunfig), ` +
      `never from a directory without one.\n` +
      `\n` +
      `This is not hypothetical: on 2026-07-14 a run without the preload ` +
      `overwrote the live Telegram getUpdates offset on the operator's own ` +
      `bridge (store.test.ts calls saveOffset(99999)).`,
  );
}
