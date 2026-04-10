/**
 * Tests for access control (access.ts)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { loadAccess, isAllowed, _resetCache } from "../lib/access.js";
import { ACCESS_FILE } from "../lib/config.js";

const TEST_DIR = (globalThis as any).__CCT_TEST_DIR as string;

describe("access control", () => {
  beforeEach(() => {
    _resetCache();
    delete process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS;
    try {
      unlinkSync(ACCESS_FILE);
    } catch {}
  });

  afterEach(() => {
    try {
      unlinkSync(ACCESS_FILE);
    } catch {}
  });

  test("rejects all when no access.json and no env allowlist", () => {
    const access = loadAccess();
    expect(access.allowFrom).toEqual([]);
    expect(isAllowed("12345", "12345", "private")).toBe(false);
  });

  test("loads allowlist from access.json", () => {
    writeFileSync(
      ACCESS_FILE,
      JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["999"] }),
    );
    const access = loadAccess();
    expect(access.allowFrom).toContain("999");
    expect(isAllowed("999", "999", "private")).toBe(true);
    expect(isAllowed("000", "000", "private")).toBe(false);
  });

  test("rejects unknown user in private chat", () => {
    writeFileSync(
      ACCESS_FILE,
      JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["111"] }),
    );
    expect(isAllowed("111", "111", "private")).toBe(true);
    expect(isAllowed("999", "999", "private")).toBe(false);
  });

  test("handles group policy", () => {
    writeFileSync(
      ACCESS_FILE,
      JSON.stringify({
        dmPolicy: "allowlist",
        allowFrom: ["111"],
        groups: {
          "-100123": { requireMention: true, allowFrom: ["111"] },
        },
      }),
    );
    expect(isAllowed("111", "-100123", "group")).toBe(true);
    expect(isAllowed("999", "-100123", "group")).toBe(false);
    expect(isAllowed("111", "-100999", "group")).toBe(false);
  });

  test("rejects group message when no group policy exists", () => {
    writeFileSync(
      ACCESS_FILE,
      JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["111"] }),
    );
    expect(isAllowed("111", "-100123", "group")).toBe(false);
  });

  test("handles malformed access.json gracefully", () => {
    writeFileSync(ACCESS_FILE, "NOT JSON");
    const access = loadAccess();
    expect(access.dmPolicy).toBe("allowlist");
    expect(access.allowFrom).toEqual([]);
  });

  test("caches access.json and only re-reads on mtime change", () => {
    writeFileSync(
      ACCESS_FILE,
      JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["111"] }),
    );
    const a1 = loadAccess();
    const a2 = loadAccess();
    // Same reference = cached
    expect(a1).toBe(a2);
  });
});
