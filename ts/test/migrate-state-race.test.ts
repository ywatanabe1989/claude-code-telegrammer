/**
 * A LOST MIGRATION RACE MUST NOT KILL THE POLLER.
 *
 * migrateLegacyStateDir() is called BARE, at top level, with no try/catch, from
 * two separate processes:
 *
 *   ts/telegram-poller.ts   migrateLegacyStateDir();
 *   ts/telegram-server.ts   migrateLegacyStateDir();
 *
 * Both can start at once, and the idempotency guard is a check-then-act with a
 * real window between the check and the write. If the loser throws, nothing
 * catches it: JS cannot resume top-level execution after an uncaught
 * exception, so startPolling() never runs and the poller goes SILENTLY INERT —
 * the global uncaughtException handler only logs, and ensurePollerRunning's
 * spawn is fire-and-forget, so nothing notices.
 *
 * That is the same silent-inert-poller failure class documented in
 * store-migration-race.test.ts for a DIFFERENT code path
 * (store.ts::ensureColumn). That test does not cover this one, and its
 * existence should not be mistaken for coverage here.
 *
 * WHAT THE STORAGE-ENGINE MOVE CHANGED. The old loser died on `VACUUM INTO`
 * refusing an existing destination — a database-file operation that no longer
 * happens here at all, because the store moved to PostgreSQL and this module
 * copies only attachments and access.json. Both of those copies are
 * overwrite-safe, so the specific throw is gone.
 *
 * THE TEST IS NOT. "The loser does not throw" is the property the poller's
 * liveness depends on, it does not follow from the new implementation by
 * inspection, and a future change here could reintroduce the failure. Losing
 * this race is BENIGN by definition — it means another process already did the
 * work. Genuine failures (disk full, unreadable source) must still be loud,
 * and the second case pins that the tolerance did not widen into swallowing
 * everything.
 */

import { describe, test, expect } from "bun:test";
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

function seedLegacy(dir: string): void {
  mkdirSync(join(dir, "attachments", "photos"), { recursive: true });
  writeFileSync(join(dir, "attachments", "photos", "a.jpg"), "IMG");
  writeFileSync(join(dir, "access.json"), '{"dmPolicy":"allowlist"}');
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
      // return from copying attachments, newDir already holds a complete
      // migration, marker and all. This is exactly what a concurrent
      // poller/server startup produces.
      const winnerFinishesFirst = (src: string, dst: string) => {
        cpSync(src, dst, { recursive: true });
        writeFileSync(join(newDir, "access.json"), '{"dmPolicy":"allowlist"}');
        writeFileSync(
          join(newDir, ".migrated-from"),
          JSON.stringify({ from: oldDir, at: "2026-07-09T00:00:00.000Z" }) +
            "\n",
        );
      };

      const result = migrateLegacyStateDir({
        env: {},
        home,
        newDir,
        oldDir,
        logFn: silent,
        copyDir: winnerFinishesFirst,
      });

      // MUST NOT THROW. Reaching this line at all is the point of the test:
      // a throw here is an uncaught exception at the poller's top level.
      expect(result).toBeDefined();

      // And what the winner wrote must be intact — the loser must not have
      // clobbered a completed migration on its way past.
      expect(readFileSync(join(newDir, "access.json"), "utf8")).toBe(
        '{"dmPolicy":"allowlist"}',
      );
      expect(
        readFileSync(join(newDir, "attachments", "photos", "a.jpg"), "utf8"),
      ).toBe("IMG");
      expect(existsSync(join(newDir, ".migrated-from"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a GENUINE copy failure is still loud", () => {
    const root = makeRoot("loud");
    const home = join(root, "home");
    const newDir = join(root, "newstate");
    const oldDir = join(root, "oldstate");
    seedLegacy(oldDir);
    try {
      // Tolerating the benign race must not turn into swallowing everything.
      expect(() =>
        migrateLegacyStateDir({
          env: {},
          home,
          newDir,
          oldDir,
          logFn: silent,
          copyDir: () => {
            throw new Error("disk full");
          },
        }),
      ).toThrow("disk full");

      // Fail loud means fail VISIBLY: no success marker, so the next startup
      // re-runs instead of skipping on a marker it never earned.
      expect(existsSync(join(newDir, ".migrated-from"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
