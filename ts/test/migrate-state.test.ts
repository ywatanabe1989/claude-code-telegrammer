/**
 * Tests for the one-time legacy → scitex-standard state-dir migration
 * (lib/migrate-state.ts).
 *
 * Data safety is the whole point of this module, so these exercise the real fs
 * with TEMP dirs — no mocks, no writes under the real ~. Every case injects
 * `env` / `home` / `newDir` / `oldDir` so nothing touches the developer's
 * actual state dir.
 *
 * WHAT THE STORAGE-ENGINE MOVE CHANGED. The state dir used to hold two kinds
 * of thing: the message DATABASE, and ordinary FILES (downloaded attachments,
 * access.json). The database moved to PostgreSQL, where a namespace is keyed
 * by agent id and cannot drift with a directory — so the bug class this module
 * exists to repair no longer applies to it. The FILES did not move, and they
 * are what these cases now pin.
 *
 * A LEGACY DATABASE FILE IS ANNOUNCED, NOT COPIED, and that is itself a
 * data-safety promise with a test of its own below: an operator whose history
 * predates the move must be TOLD, not left to discover a gap.
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
} from "fs";
import {
  migrateLegacyStateDir,
  resolveOldDefaultDir,
  findStrandedDbFiles,
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

/** Populate a legacy state dir with the files this module still carries. */
function seedLegacy(dir: string): void {
  mkdirSync(join(dir, "attachments", "photos"), { recursive: true });
  writeFileSync(join(dir, "attachments", "photos", "a.jpg"), "IMG");
  writeFileSync(join(dir, "access.json"), '{"dmPolicy":"allowlist"}');
}

/** Add a leftover database file from a pre-PostgreSQL release. */
function seedLegacyDbFile(dir: string, name = "messages.db"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "OPERATOR-HISTORY-BYTES");
  return path;
}

describe("migrateLegacyStateDir", () => {
  test("(1) old-exists + new-absent copies attachments+access and writes markers", () => {
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
    expect(
      readFileSync(join(oldDir, "attachments", "photos", "a.jpg"), "utf8"),
    ).toBe("IMG");
  });

  test("(2) idempotent — a second run is a no-op and does not re-copy", () => {
    const oldDir = join(home, ".claude-code-telegrammer");
    seedLegacy(oldDir);

    migrateLegacyStateDir({ env: {}, home, newDir, now: FIXED, logFn: silent });
    // Mutate legacy so a (buggy) re-copy would be detectable.
    writeFileSync(join(oldDir, "access.json"), '{"dmPolicy":"CHANGED"}');

    const res2 = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      logFn: silent,
    });
    expect(res2.migrated).toBe(false);
    expect(res2.reason).toBe("already-migrated");
    // The already-migrated dir is untouched — it must NOT have picked up the
    // edit made to the legacy dir after the migration completed.
    expect(readFileSync(join(newDir, "access.json"), "utf8")).toBe(
      '{"dmPolicy":"allowlist"}',
    );
  });

  test("(3) nothing to carry → no-op", () => {
    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      logFn: silent,
    });
    expect(res.migrated).toBe(false);
    expect(res.reason).toBe("nothing-to-migrate");
    expect(existsSync(join(newDir, ".migrated-from"))).toBe(false);
  });

  test("(3b) a no-op is NOT silent — it logs the outcome + resolved paths + reason", () => {
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

    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      logFn: spy,
    });
    expect(res.reason).toBe("nothing-to-migrate");

    const summary = calls.find((c) => c.data?.reason === "nothing-to-migrate");
    expect(summary).toBeDefined();
    expect(summary!.component).toBe("migrate-state");
    // The resolved decision inputs are all present + actionable.
    expect(summary!.data!.newDir).toBe(newDir);
    expect(summary!.data!.oldDir).toBe(join(home, ".claude-code-telegrammer"));
    expect(summary!.data!.strandedDbFiles).toEqual([]);
  });

  test("(4) explicit AGENT_STATE_DIR set → migration skipped entirely", () => {
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
    expect(existsSync(join(newDir, ".migrated-from"))).toBe(false);
  });

  test("(5) cross-contamination guard: a suffixed agent NEVER reads the bare dir", () => {
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
    expect(res.reason).toBe("nothing-to-migrate");
    expect(res.oldDir).toBe(join(home, ".claude-code-telegrammer-orochi"));
    // The lead's bare dir is untouched (no forward marker, files intact).
    expect(existsSync(join(bare, ".migrated-to"))).toBe(false);
    expect(
      readFileSync(join(bare, "attachments", "photos", "a.jpg"), "utf8"),
    ).toBe("IMG");
  });

  test("(6) a copy failure leaves NO marker and surfaces the error", () => {
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
    // silently believing a half-migration succeeded. The marker is the ONLY
    // completion sentinel now, which is exactly why it is written last.
    expect(existsSync(join(newDir, ".migrated-from"))).toBe(false);
  });
});

describe("a legacy database file is ANNOUNCED, never touched", () => {
  // THE DATA-SAFETY PROMISE OF THE ENGINE MOVE. The operator's message history
  // predating PostgreSQL is not carried forward by this path. Proceeding past
  // it in silence is the history-gap incident this whole module was written
  // for, arriving through a new door — so the file must be named in the
  // result, named in the log, and left byte-identical on disk.
  test("it is reported, logged, and still on disk afterwards", () => {
    const oldDir = join(home, ".claude-code-telegrammer");
    seedLegacy(oldDir);
    const dbPath = seedLegacyDbFile(oldDir);

    const calls: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      now: FIXED,
      logFn: (_c, msg, data) => calls.push({ msg, data }),
    });

    expect(res.strandedDbFiles).toEqual([dbPath]);

    const announcement = calls.find((c) =>
      c.msg.includes("was NOT carried forward"),
    );
    expect(announcement).toBeDefined();
    expect(announcement!.msg).toContain("PostgreSQL");
    expect(announcement!.msg).toContain("docs/adr/");
    expect(announcement!.data!.files).toEqual([dbPath]);

    // UNTOUCHED. Not moved, not renamed, not opened.
    expect(readFileSync(dbPath, "utf8")).toBe("OPERATOR-HISTORY-BYTES");
    // And it was NOT copied into the new dir under either name.
    expect(existsSync(join(newDir, "messages.db"))).toBe(false);
    expect(existsSync(join(newDir, "claude-code-telegrammer.db"))).toBe(false);
  });

  test("both legacy filenames are recognised", () => {
    const dir = join(root, "legacydir");
    const a = seedLegacyDbFile(dir, "messages.db");
    const b = seedLegacyDbFile(dir, "claude-code-telegrammer.db");
    expect(findStrandedDbFiles(dir).sort()).toEqual([a, b].sort());
  });

  test("a dir with no legacy database reports none", () => {
    const dir = join(root, "cleandir");
    mkdirSync(dir, { recursive: true });
    expect(findStrandedDbFiles(dir)).toEqual([]);
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
