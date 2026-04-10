/**
 * Tests for single-instance lock file logic (lock.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We need to test acquireLock/releaseLock with a custom STATE_DIR/LOCK_FILE.
// Since lock.ts imports from config.ts which reads env at module level,
// and preload.ts already sets the env vars, we can import directly.
import { acquireLock, releaseLock } from "../lib/lock.js";
import { LOCK_FILE, STATE_DIR } from "../lib/config.js";

describe("lock", () => {
  beforeEach(() => {
    // Ensure clean state
    try {
      rmSync(LOCK_FILE);
    } catch {}
  });

  afterEach(() => {
    try {
      rmSync(LOCK_FILE);
    } catch {}
  });

  test("acquireLock creates lock file with current PID", () => {
    acquireLock();
    expect(existsSync(LOCK_FILE)).toBe(true);
    const content = readFileSync(LOCK_FILE, "utf8").trim();
    expect(content).toBe(String(process.pid));
  });

  test("releaseLock removes the lock file", () => {
    acquireLock();
    expect(existsSync(LOCK_FILE)).toBe(true);
    releaseLock();
    expect(existsSync(LOCK_FILE)).toBe(false);
  });

  test("releaseLock does not throw when no lock file exists", () => {
    expect(() => releaseLock()).not.toThrow();
  });

  test("acquireLock removes stale lock file (dead PID)", () => {
    // Write a lock file with a PID that almost certainly does not exist
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, "999999999", { mode: 0o600 });

    // Should not exit, should overwrite with current PID
    acquireLock();
    const content = readFileSync(LOCK_FILE, "utf8").trim();
    expect(content).toBe(String(process.pid));
  });

  test("acquireLock removes lock file with invalid content", () => {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, "not-a-pid", { mode: 0o600 });

    acquireLock();
    const content = readFileSync(LOCK_FILE, "utf8").trim();
    expect(content).toBe(String(process.pid));
  });
});
