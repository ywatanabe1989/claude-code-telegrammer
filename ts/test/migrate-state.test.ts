/**
 * Tests for the one-time legacy → scitex-standard state-dir migration
 * (lib/migrate-state.ts).
 *
 * Data safety is the whole point of this module (it moves the operator's real
 * Telegram history), so these exercise the real fs with TEMP dirs — no mocks,
 * no writes under the real ~. Every case injects `env` / `home` / `newDir` /
 * `oldDir` so nothing touches the developer's actual state dir.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  copyFileSync,
} from "fs";
import { Database } from "bun:sqlite";
import {
  migrateLegacyStateDir,
  resolveOldDefaultDir,
} from "../lib/migrate-state.js";

const silent = () => {};
const FIXED = new Date("2026-07-09T00:00:00.000Z");

let root: string;
let home: string;
let newDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `cct-migtest-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  home = join(root, "home");
  newDir = join(root, "newstate");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Populate a legacy state dir with a full complement of files.
 *
 * The database is a REAL SQLite file. It used to be the string literal
 * "MAIN-DB-BYTES" with "WAL-BYTES"/"SHM-BYTES" sidecars, which made these
 * cases readable but meant the whole suite never once opened a database — so
 * it could verify WHICH FILES moved and never WHETHER THE DATA SURVIVED. A
 * live-source consistency bug sat under that blind spot; see
 * migrate-state-consistency.test.ts, which is what caught it.
 *
 * Keep it a real database. These cases are about copy mechanics, but they can
 * only stay honest if the thing being copied is the thing production copies.
 */
function seedLegacy(dir: string, marker = "LEGACY-ROW"): void {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "messages.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT);");
  db.prepare("INSERT INTO messages (text) VALUES (?)").run(marker);
  db.close();
  mkdirSync(join(dir, "attachments", "photos"), { recursive: true });
  writeFileSync(join(dir, "attachments", "photos", "a.jpg"), "IMG");
  writeFileSync(join(dir, "access.json"), '{"dmPolicy":"allowlist"}');
}

/** Read the seeded marker row back out of a store — proves the DATA travelled. */
function readMarker(dbPath: string): string[] {
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

describe("migrateLegacyStateDir", () => {
  test("(1) old-exists + new-absent snapshots the db + copies attachments+access, renames to the new db, writes markers", () => {
    // "telegram"/default agent → its OLD default is the bare dir.
    const oldDir = join(home, ".claude-code-telegrammer");
    seedLegacy(oldDir);

    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      now: FIXED,
      logFn: silent,
    });

    expect(res.migrated).toBe(true);
    expect(res.reason).toBe("migrated");

    // Renamed onto the scitex-standard filename, DATA intact — read back
    // through SQLite, because "the file arrived" and "the rows arrived" are
    // different claims and only the second one matters.
    expect(readMarker(join(newDir, "claude-code-telegrammer.db"))).toEqual([
      "LEGACY-ROW",
    ]);
    // A VACUUM INTO snapshot is a SINGLE self-contained file. Sidecars are not
    // copied any more and must not appear: shipping a -wal next to a snapshot
    // recreates the ambiguity of a .db and a -wal captured at different
    // instants, which is the bug this migration path had.
    expect(
      existsSync(join(newDir, "claude-code-telegrammer.db-wal")),
    ).toBe(false);
    expect(
      existsSync(join(newDir, "claude-code-telegrammer.db-shm")),
    ).toBe(false);
    // Attachments copied recursively + access.json copied.
    expect(
      readFileSync(join(newDir, "attachments", "photos", "a.jpg"), "utf8"),
    ).toBe("IMG");
    expect(readFileSync(join(newDir, "access.json"), "utf8")).toBe(
      '{"dmPolicy":"allowlist"}',
    );

    // Marker in the NEW dir records the old path + timestamp.
    const marker = JSON.parse(
      readFileSync(join(newDir, ".migrated-from"), "utf8"),
    );
    expect(marker.from).toBe(oldDir);
    expect(marker.at).toBe(FIXED.toISOString());
    // Marker in the OLD dir points forward.
    expect(existsSync(join(oldDir, ".migrated-to"))).toBe(true);

    // COPY, not move — the legacy dir is left intact as a backup.
    expect(readMarker(join(oldDir, "messages.db"))).toEqual(["LEGACY-ROW"]);
  });

  test("(2) idempotent — a second run is a no-op and does not overwrite", () => {
    const oldDir = join(home, ".claude-code-telegrammer");
    seedLegacy(oldDir);

    migrateLegacyStateDir({ env: {}, home, newDir, now: FIXED, logFn: silent });
    // Mutate legacy so a (buggy) re-copy would be detectable.
    const legacy = new Database(join(oldDir, "messages.db"));
    legacy
      .prepare("INSERT INTO messages (text) VALUES (?)")
      .run("CHANGED-AFTER-MIGRATION");
    legacy.close();

    const res2 = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      logFn: silent,
    });
    expect(res2.migrated).toBe(false);
    expect(res2.reason).toBe("new-db-exists");
    // The already-migrated new DB is untouched — it must NOT have picked up the
    // row written to the legacy store after the migration completed.
    expect(readMarker(join(newDir, "claude-code-telegrammer.db"))).toEqual([
      "LEGACY-ROW",
    ]);
  });

  test("(3) new-db-exists → no-op (never clobbers an existing new DB)", () => {
    const oldDir = join(home, ".claude-code-telegrammer");
    seedLegacy(oldDir);
    mkdirSync(newDir, { recursive: true });
    writeFileSync(
      join(newDir, "claude-code-telegrammer.db"),
      "EXISTING-NEW-DB",
    );

    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      logFn: silent,
    });
    expect(res.migrated).toBe(false);
    expect(res.reason).toBe("new-db-exists");
    expect(
      readFileSync(join(newDir, "claude-code-telegrammer.db"), "utf8"),
    ).toBe("EXISTING-NEW-DB");
  });

  test("(4) old-absent → no-op (nothing to carry forward)", () => {
    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      logFn: silent,
    });
    expect(res.migrated).toBe(false);
    expect(res.reason).toBe("old-db-absent");
    expect(existsSync(join(newDir, "claude-code-telegrammer.db"))).toBe(false);
  });

  test("(4b) a no-op is NOT silent — it logs the outcome + resolved paths + reason", () => {
    // Regression guard: a live incident was hard to diagnose because the no-op
    // return paths logged NOTHING. Every outcome must now emit one structured
    // line carrying the reason and the exact paths it inspected.
    const calls: Array<{
      component: string;
      msg: string;
      data?: Record<string, unknown>;
    }> = [];
    const spy = (
      component: string,
      msg: string,
      data?: Record<string, unknown>,
    ) => {
      calls.push({ component, msg, data });
    };

    // old-db-absent: nothing to carry forward, but it must say so out loud.
    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      logFn: spy,
    });
    expect(res.reason).toBe("old-db-absent");

    const summary = calls.find((c) => c.data?.reason === "old-db-absent");
    expect(summary).toBeDefined();
    expect(summary!.component).toBe("migrate-state");
    // The resolved decision inputs are all present + actionable.
    expect(summary!.data!.newDir).toBe(newDir);
    expect(summary!.data!.oldDir).toBe(join(home, ".claude-code-telegrammer"));
    expect(summary!.data!.oldDb).toBe(
      join(home, ".claude-code-telegrammer", "messages.db"),
    );
    expect(summary!.data!.newDbExists).toBe(false);
    expect(summary!.data!.oldDbExists).toBe(false);
  });

  test("(5) explicit AGENT_STATE_DIR set → migration skipped entirely", () => {
    // Even with a full legacy dir present, an explicit state dir means "this
    // dir IS the state dir" — nothing to migrate.
    const oldDir = join(home, ".claude-code-telegrammer");
    seedLegacy(oldDir);

    const res = migrateLegacyStateDir({
      env: { CCT_AGENT_STATE_DIR: join(root, "explicit") },
      home,
      newDir,
      logFn: silent,
    });
    expect(res.migrated).toBe(false);
    expect(res.reason).toBe("explicit-state-dir");
    expect(res.oldDir).toBeNull();
    expect(existsSync(join(newDir, "claude-code-telegrammer.db"))).toBe(false);
  });

  test("(6) cross-contamination guard: a suffixed agent NEVER reads the bare dir", () => {
    // resolveOldDefaultDir must return the SUFFIXED dir for a non-telegram
    // agent — the bare dir belongs to the lead/"telegram" bot.
    expect(resolveOldDefaultDir({ CCT_AGENT_ID: "orochi" }, home)).toBe(
      join(home, ".claude-code-telegrammer-orochi"),
    );

    // Seed the BARE dir (the lead's data). A suffixed agent must not touch it.
    const bare = join(home, ".claude-code-telegrammer");
    seedLegacy(bare);

    const res = migrateLegacyStateDir({
      env: { CCT_AGENT_ID: "orochi" },
      home,
      newDir,
      logFn: silent,
    });
    // Its own suffixed old dir is absent → nothing migrates.
    expect(res.migrated).toBe(false);
    expect(res.reason).toBe("old-db-absent");
    expect(res.oldDir).toBe(join(home, ".claude-code-telegrammer-orochi"));
    // The lead's bare dir is untouched (no new db, no forward marker).
    expect(existsSync(join(newDir, "claude-code-telegrammer.db"))).toBe(false);
    expect(existsSync(join(bare, ".migrated-to"))).toBe(false);
  });

  test("(7) a copy failure leaves NO marker and surfaces the error", () => {
    const oldDir = join(home, ".claude-code-telegrammer");
    seedLegacy(oldDir);

    const boom = () => {
      throw new Error("disk full");
    };
    expect(() =>
      migrateLegacyStateDir({
        env: {},
        home,
        newDir,
        copyFile: boom,
        logFn: silent,
      }),
    ).toThrow("disk full");

    // Fail loud: no success marker written, so a later run retries rather than
    // silently believing a half-migration succeeded.
    expect(existsSync(join(newDir, ".migrated-from"))).toBe(false);
    // The main DB is copied LAST, so a failure leaves the new DB ABSENT — its
    // presence is the "fully complete" sentinel. This guarantees the next
    // startup re-runs the whole migration instead of skipping on new-db-exists.
    expect(existsSync(join(newDir, "claude-code-telegrammer.db"))).toBe(false);
  });

  test("(7b) a failure AFTER the DB copy but the DB present still re-runs cleanly (order sentinel)", () => {
    // Prove the sentinel property end-to-end: fail on the FINAL db snapshot,
    // then a re-run (with a working snapshot) completes the migration.
    const oldDir = join(home, ".claude-code-telegrammer");
    seedLegacy(oldDir);

    let calls = 0;
    const countCopies = (src: string, dst: string) => {
      calls++;
      copyFileSync(src, dst);
    };
    // The DB no longer travels through copyFile — it is a VACUUM INTO snapshot,
    // so the failure is injected on that step instead.
    const failOnSnapshot = () => {
      throw new Error("disk full");
    };
    expect(() =>
      migrateLegacyStateDir({
        env: {},
        home,
        newDir,
        copyFile: countCopies,
        snapshotDb: failOnSnapshot,
        logFn: silent,
      }),
    ).toThrow("disk full");
    expect(calls).toBeGreaterThan(0); // access.json copy DID run first
    expect(existsSync(join(newDir, "claude-code-telegrammer.db"))).toBe(false);
    expect(existsSync(join(newDir, ".migrated-from"))).toBe(false);

    // Re-run with a working copyFile completes cleanly.
    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      now: FIXED,
      logFn: silent,
    });
    expect(res.migrated).toBe(true);
    expect(readMarker(join(newDir, "claude-code-telegrammer.db"))).toEqual([
      "LEGACY-ROW",
    ]);
  });
});

describe("resolveOldDefaultDir", () => {
  test("null when an explicit AGENT_STATE_DIR is set", () => {
    expect(
      resolveOldDefaultDir({ CCT_AGENT_STATE_DIR: "/tmp/x" }, "/home/u"),
    ).toBeNull();
  });

  test("bare dir for the default 'telegram' agent", () => {
    expect(resolveOldDefaultDir({}, "/home/u")).toBe(
      "/home/u/.claude-code-telegrammer",
    );
    expect(resolveOldDefaultDir({ CCT_AGENT_ID: "telegram" }, "/home/u")).toBe(
      "/home/u/.claude-code-telegrammer",
    );
  });

  test("suffixed dir for a named agent (sanitized)", () => {
    expect(resolveOldDefaultDir({ CCT_AGENT_ID: "../evil" }, "/home/u")).toBe(
      "/home/u/.claude-code-telegrammer-..-evil",
    );
  });
});
