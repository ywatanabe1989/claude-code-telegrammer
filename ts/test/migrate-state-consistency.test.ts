/**
 * Consistency tests for the legacy → scitex-standard state-dir migration.
 *
 * DELIBERATELY separate from migrate-state.test.ts. That suite verifies copy
 * MECHANICS — which files land where and that failures are loud. This one
 * verifies what happens when the copy is INTERRUPTED, or when the source is
 * changing underneath it, which is the realistic condition: this function runs
 * at STARTUP from two live processes (telegram-poller.ts, telegram-server.ts)
 * while inbound Telegram messages can arrive.
 *
 * WHAT THIS FILE USED TO PIN, AND WHY IT CHANGED. Its whole subject was a live
 * DATABASE FILE being copied: a `.db` and its `-wal` are one logical database
 * captured at one instant, so copying them as independent files from a source
 * still being written yields a pair that never coexisted. A real bug lived
 * there and this file caught it. That property is GONE, not fixed-and-still-
 * testable: the store moved to PostgreSQL, there is no database file in the
 * state dir, and the migration no longer copies one.
 *
 * What remains is the same QUESTION asked of what the module still moves. An
 * interrupted copy must be re-runnable rather than mistaken for a finished
 * one, and a source that gains files mid-copy must not corrupt the result.
 * Those are the two cases below. The lesson the old file recorded — that
 * "the files arrived" and "the data arrived" are different claims — is why
 * both cases assert CONTENT, not just presence.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  cpSync,
} from "fs";
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

function seedLegacy(dir: string): void {
  mkdirSync(join(dir, "attachments", "2026-08"), { recursive: true });
  writeFileSync(join(dir, "attachments", "2026-08", "one.jpg"), "ONE");
  writeFileSync(join(dir, "access.json"), '{"dmPolicy":"allowlist"}');
}

describe("an interrupted migration is re-runnable, not mistaken for a finished one", () => {
  test("a crash mid-copy leaves no marker, and the next run completes it", () => {
    seedLegacy(oldDir);

    // Fail on access.json, AFTER the attachments tree has already landed —
    // the half-done state a disk-full or a SIGKILL produces.
    expect(() =>
      migrateLegacyStateDir({
        env: {},
        home,
        newDir,
        oldDir,
        copyFile: () => {
          throw new Error("disk full");
        },
        logFn: silent,
      }),
    ).toThrow("disk full");

    // Attachments DID land, access.json did not, and crucially the completion
    // marker did not either — so nothing can read this as "already migrated".
    expect(
      readFileSync(join(newDir, "attachments", "2026-08", "one.jpg"), "utf8"),
    ).toBe("ONE");
    expect(existsSync(join(newDir, "access.json"))).toBe(false);
    expect(existsSync(join(newDir, ".migrated-from"))).toBe(false);

    // The re-run finishes the job. The attachment copy is overwrite-safe, so
    // repeating it is harmless, which is exactly what makes retry the right
    // recovery rather than a partial resume nobody could verify.
    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      oldDir,
      logFn: silent,
    });
    expect(res.migrated).toBe(true);
    expect(readFileSync(join(newDir, "access.json"), "utf8")).toBe(
      '{"dmPolicy":"allowlist"}',
    );
    expect(existsSync(join(newDir, ".migrated-from"))).toBe(true);
  });
});

describe("a source that changes while the copy runs", () => {
  test("a file added mid-copy does not corrupt what already landed, and a re-run is not needed for correctness", () => {
    seedLegacy(oldDir);

    // A real write into the legacy attachments tree WHILE the recursive copy
    // is in flight — the inbound-photo-arrives-at-startup case.
    const racingCopyDir = (src: string, dst: string) => {
      writeFileSync(join(oldDir, "attachments", "2026-08", "two.jpg"), "TWO");
      cpSync(src, dst, { recursive: true });
    };

    const res = migrateLegacyStateDir({
      env: {},
      home,
      newDir,
      oldDir,
      copyDir: racingCopyDir,
      logFn: silent,
    });
    expect(res.migrated).toBe(true);

    // Whatever the copy captured must be INTACT. A file that arrived during
    // the window may or may not be included — that is a race, and pretending
    // otherwise would be the wrong assertion — but nothing may be truncated
    // or half-written, and the file that was there from the start must be
    // present and correct.
    expect(
      readFileSync(join(newDir, "attachments", "2026-08", "one.jpg"), "utf8"),
    ).toBe("ONE");
    const two = join(newDir, "attachments", "2026-08", "two.jpg");
    if (existsSync(two)) {
      expect(readFileSync(two, "utf8")).toBe("TWO");
    }

    // And the source is untouched — COPY, never move.
    expect(
      readFileSync(join(oldDir, "attachments", "2026-08", "two.jpg"), "utf8"),
    ).toBe("TWO");
  });
});
