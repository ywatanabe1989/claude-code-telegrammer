/**
 * Test preload — sets env vars BEFORE any module imports.
 *
 * Two jobs. The first is unchanged: strip every telegrammer var the operator's
 * shell might be exporting, so the suite sees only the canonical test values.
 * The second is what the storage-engine move made necessary — point the store
 * at a THROWAWAY PostgreSQL namespace, which is what lib/hermetic-guard.ts
 * checks for before it will let a test run write anything at all.
 */

import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";

const TEST_DIR = join(tmpdir(), `cct-test-${process.pid}`);
mkdirSync(TEST_DIR, { recursive: true });

// Hermetic env: drop any telegrammer vars inherited from the operator's shell
// (e.g. a real CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN / CCT_* export) so
// getenv()'s conflict detection sees ONLY the canonical test values set below,
// not an ambient legacy value that disagrees with them.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("CCT_") || name.startsWith("CLAUDE_CODE_TELEGRAMMER_")) {
    delete process.env[name];
  }
}

process.env.CLAUDE_CODE_TELEGRAMMER_AGENT_STATE_DIR = TEST_DIR;
process.env.CLAUDE_CODE_TELEGRAMMER_BOT_TOKEN = "fake:token";
process.env.CLAUDE_CODE_TELEGRAMMER_ALLOWED_USERS = "";
process.env.CLAUDE_CODE_TELEGRAMMER_TURN_URL = "http://fake.localhost/v1/turn";

/**
 * The namespace this test process owns.
 *
 * The prefix is what hermetic-guard.ts requires, so a run that loses this
 * preload resolves the LIVE agent's namespace instead and is refused rather
 * than allowed to write to the operator's real bridge.
 *
 * The creation time is IN THE NAME on purpose. A test process that is killed
 * mid-run never gets to drop its namespace, and there is no catalog column
 * recording when a schema was made — so the timestamp travels in the only
 * place a later sweep can read it. See dropStaleTestSchemas().
 */
const TEST_SCHEMA = `cct_test_${Date.now()}_${process.pid}`;
process.env.CCT_STORE_SCHEMA = TEST_SCHEMA;

// Export for tests to reference
(globalThis as any).__CCT_TEST_DIR = TEST_DIR;
(globalThis as any).__CCT_TEST_SCHEMA = TEST_SCHEMA;

/** Namespaces abandoned by an earlier run are dropped after this long. */
const STALE_TEST_SCHEMA_MS = 2 * 60 * 60 * 1000;

/**
 * Best-effort cleanup, run once when the test process is finishing.
 *
 * Drops THIS run's namespace, then any older abandoned one. Never throws and
 * never fails the suite: leaving a scratch namespace behind is untidy, whereas
 * turning a green run red over cleanup would be a lie about the code.
 */
async function cleanupTestSchemas(): Promise<void> {
  try {
    const { getSql, closeSql, quoteSchema } = await import("../lib/pg.js");
    const sql = getSql();
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteSchema(TEST_SCHEMA)} CASCADE`);

    const cutoff = Date.now() - STALE_TEST_SCHEMA_MS;
    const rows = (await sql.unsafe(
      "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'cct\\_test\\_%'",
    )) as Array<{ nspname: string }>;
    for (const { nspname } of rows) {
      const stamp = Number(nspname.split("_")[2]);
      if (Number.isFinite(stamp) && stamp < cutoff) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteSchema(nspname)} CASCADE`);
      }
    }
    await closeSql();
  } catch {
    // No server configured, or it went away. Nothing to clean, nothing to say.
  }
}

let cleaning = false;
process.on("beforeExit", () => {
  if (cleaning) return;
  cleaning = true;
  void cleanupTestSchemas();
});
