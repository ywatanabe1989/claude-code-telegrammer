/**
 * Consistency tests for the legacy → scitex-standard state-dir migration.
 *
 * These are DELIBERATELY separate from migrate-state.test.ts. That suite seeds
 * the legacy dir with string literals ("MAIN-DB-BYTES", "WAL-BYTES") and so
 * verifies file-copy MECHANICS — which files land where, in what order, and
 * that failures are loud. It is structurally incapable of catching a database
 * CONSISTENCY bug, because it never opens a database.
 *
 * These tests use a REAL SQLite database in WAL mode, because the property
 * under test is one that only a real database has: a `.db` and its `-wal` are
 * ONE logical database captured at ONE instant. Copying them as independent
 * files, at different instants, from a source that is still being written to,
 * yields a pair that never coexisted.
 *
 * That matters here specifically because migrateLegacyStateDir() runs at
 * STARTUP from two live processes (telegram-poller.ts, telegram-server.ts)
 * while the poller is writing meta.last_poll_ts roughly every 30 seconds, and
 * while inbound Telegram messages can arrive.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { migrateLegacyStateDir } from "../lib/migrate-state.js";

const silent = () => {};

let root: string;
let home: string;
let newDir: string;
let oldDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `cct-migconsist-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  home = join(root, "home");
  newDir = join(root, "newstate");
  oldDir = join(root, "oldstate");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Open a REAL SQLite database in WAL mode at the legacy location and leave the
 * handle OPEN, so the un-checkpointed WAL stays on disk exactly as it does for
 * a running poller. Callers must close it.
 */
function openLiveLegacyDb(dir: string): Database {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "messages.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  // Do NOT enable auto-checkpointing surprises mid-test; we drive it by hand.
  db.exec("PRAGMA wal_autocheckpoint = 0;");
  db.exec(
    "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT);",
  );
  return db;
}

function insert(db: Database, text: string): void {
  db.prepare("INSERT INTO messages (text) VALUES (?)").run(text);
}

/** Read a migrated store the way production does: open it and query. */
function readTexts(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT text FROM messages ORDER BY id")
      .all()
      .map((r: { text: string }) => r.text);
  } finally {
    db.close();
  }
}

describe("migration consistency against a LIVE source database", () => {
  test("rows committed while the migration is copying are NOT lost", () => {
    const db = openLiveLegacyDb(oldDir);
    insert(db, "before-1");
    insert(db, "before-2");
    // Everything so far lives in the -wal; main .db is still effectively empty.
    // This is the normal steady state for these stores (~4 MB of un-checkpointed
    // WAL was measured on every live store on 2026-08-15).

    // Attachments exist so the copyDir step runs BETWEEN the sidecar copy and
    // the main-DB copy — that interval is the window under test, and in
    // production it is as long as the attachments tree takes to copy.
    mkdirSync(join(oldDir, "attachments"), { recursive: true });
    writeFileSync(join(oldDir, "attachments", "a.jpg"), "IMG");

    const result = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      oldDir,
      logFn: silent,
      // A live writer commits DURING the copy — exactly what the poller does.
      copyDir: (src, dst) => {
        insert(db, "during-migration");
        // Default recursive copy, inlined so we do not depend on cpSync import
        // ordering in the module under test.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("fs").cpSync(src, dst, { recursive: true });
      },
    });

    expect(result.migrated).toBe(true);
    db.close();

    const migrated = join(newDir, "claude-code-telegrammer.db");
    expect(existsSync(migrated)).toBe(true);

    // The whole point: a message that arrived while we were migrating must not
    // vanish. Copying -wal first and .db last means a row committed in between
    // is in NEITHER copy — it is in the live WAL after the WAL snapshot, and
    // not yet in main when main is snapshotted.
    expect(readTexts(migrated)).toEqual([
      "before-1",
      "before-2",
      "during-migration",
    ]);
  });

  test("a checkpoint during the copy window does not roll the store back", () => {
    const db = openLiveLegacyDb(oldDir);
    insert(db, "row-1");
    insert(db, "row-2");

    mkdirSync(join(oldDir, "attachments"), { recursive: true });
    writeFileSync(join(oldDir, "attachments", "a.jpg"), "IMG");

    const result = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      oldDir,
      logFn: silent,
      copyDir: (src, dst) => {
        // A checkpoint moves WAL frames into main and RESETS the WAL with fresh
        // salt values. The already-copied -wal is now a stale file whose frames
        // describe older page images than the main .db that gets copied next.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        insert(db, "row-3-after-checkpoint");
        require("fs").cpSync(src, dst, { recursive: true });
      },
    });

    expect(result.migrated).toBe(true);
    db.close();

    const migrated = join(newDir, "claude-code-telegrammer.db");
    const texts = readTexts(migrated);

    // Nothing committed before the migration may disappear, and stale WAL
    // frames must never shadow newer pages in the copied main file.
    expect(texts).toContain("row-1");
    expect(texts).toContain("row-2");
    expect(texts).toContain("row-3-after-checkpoint");
  });

  test("the migrated store carries no stale sidecars alongside it", () => {
    const db = openLiveLegacyDb(oldDir);
    insert(db, "only-row");
    const result = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      oldDir,
      logFn: silent,
    });
    expect(result.migrated).toBe(true);
    db.close();

    const migrated = join(newDir, "claude-code-telegrammer.db");
    expect(readTexts(migrated)).toEqual(["only-row"]);

    // A snapshot is self-contained. Shipping a -wal/-shm next to it re-creates
    // the very ambiguity this migration is supposed to resolve: a reader cannot
    // tell whether those sidecars belong to this file or to the source it came
    // from.
    expect(existsSync(migrated + "-wal")).toBe(false);
    expect(existsSync(migrated + "-shm")).toBe(false);
  });
});
