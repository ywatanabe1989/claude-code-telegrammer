/**
 * A LOST MIGRATION RACE MUST NOT KILL THE POLLER.
 *
 * migrateLegacyStateDir() is called BARE, at top level, with no try/catch, from
 * two separate processes:
 *
 *   ts/telegram-poller.ts:118   migrateLegacyStateDir();
 *   ts/telegram-server.ts:368   migrateLegacyStateDir();
 *
 * Both can start at once. The idempotency guard is `existsSync(newDb)` — a
 * check-then-act with a real window between the check and the write, and the
 * attachments tree is copied inside that window.
 *
 * So the losing racer reaches the final snapshot AFTER the winner has already
 * written newDb. `VACUUM INTO` refuses a destination that already exists
 * (measured: `SQLiteError: output file already exists`), migrateLegacyStateDir
 * rethrows, and at the poller's top level nothing catches it. JS cannot resume
 * top-level execution after an uncaught exception, so startPolling() never runs
 * and the poller goes SILENTLY INERT — the global uncaughtException handler
 * only logs. Nothing notices: ensurePollerRunning's spawn is fire-and-forget.
 *
 * That is the same silent-inert-poller failure class documented in
 * store-migration-race.test.ts for a DIFFERENT code path (store.ts::ensureColumn).
 * That test does not cover this one, and its existence should not be mistaken
 * for coverage here.
 *
 * Losing this race is BENIGN by definition — it means another process already
 * completed the very migration we were attempting. The correct behaviour is to
 * notice that and carry on, NOT to abort startup. Genuine failures (disk full,
 * unreadable source, corrupt database) must still be loud.
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { migrateLegacyStateDir } from "../lib/migrate-state.js";

const silent = () => {};

function makeRoot(tag: string): string {
  const root = join(
    tmpdir(),
    `cct-migrace-${tag}-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  mkdirSync(join(root, "home"), { recursive: true });
  return root;
}

/** A real legacy store with one row, plus attachments so copyDir runs. */
function seedLegacy(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "messages.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT);");
  db.prepare("INSERT INTO messages (text) VALUES (?)").run("legacy-row");
  db.close();
  mkdirSync(join(dir, "attachments"), { recursive: true });
  writeFileSync(join(dir, "attachments", "a.jpg"), "IMG");
}

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

describe("migrateLegacyStateDir — losing the startup race", () => {
  test("a racer that loses does NOT throw (losing means the work is already done)", () => {
    const root = makeRoot("lose");
    const home = join(root, "home");
    const newDir = join(root, "newstate");
    const oldDir = join(root, "oldstate");
    seedLegacy(oldDir);
    try {
      // Simulate the WINNER finishing inside our copy window: by the time we
      // reach the final snapshot, newDir already holds a complete store. This
      // is exactly what a concurrent poller/server startup produces.
      const winnerWrites = (src: string, dst: string) => {
        const w = new Database(join(oldDir, "messages.db"));
        try {
          w.run("VACUUM INTO ?", [join(newDir, "claude-code-telegrammer.db")]);
        } finally {
          w.close();
        }
        require("fs").cpSync(src, dst, { recursive: true });
      };

      const result = migrateLegacyStateDir({
        env: {},
        home,
        newDir,
        oldDir,
        logFn: silent,
        copyDir: winnerWrites,
      });

      // MUST NOT THROW. Reaching this line at all is the point of the test:
      // a throw here is an uncaught exception at the poller's top level.
      expect(result).toBeDefined();

      // And the store the winner wrote must be intact and readable.
      const migrated = join(newDir, "claude-code-telegrammer.db");
      expect(existsSync(migrated)).toBe(true);
      expect(readTexts(migrated)).toEqual(["legacy-row"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a GENUINE snapshot failure is still loud", () => {
    const root = makeRoot("loud");
    const home = join(root, "home");
    const newDir = join(root, "newstate");
    const oldDir = join(root, "oldstate");
    seedLegacy(oldDir);
    try {
      // Swallowing the benign race must not turn into swallowing everything.
      expect(() =>
        migrateLegacyStateDir({
          env: {},
          home,
          newDir,
          oldDir,
          logFn: silent,
          snapshotDb: () => {
            throw new Error("disk full");
          },
        }),
      ).toThrow("disk full");

      // Fail loud means fail VISIBLY: no success marker, no half-migrated DB
      // that would make the next startup skip on new-db-exists.
      expect(existsSync(join(newDir, ".migrated-from"))).toBe(false);
      expect(existsSync(join(newDir, "claude-code-telegrammer.db"))).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
