/**
 * Tests for configuration module (config.ts).
 *
 * Because config.ts evaluates env vars at import time and preload.ts
 * sets them before any imports, we test the values that preload established.
 */

import { describe, test, expect } from "bun:test";
import { tmpdir, hostname } from "os";
import { join } from "path";
import {
  STATE_DIR,
  ACCESS_FILE,
  LOCK_FILE,
  INBOX_DIR,
  ATTACHMENT_DIR,
  TOKEN,
  API_BASE,
  MAX_TEXT,
  ENV_ALLOWED,
  HOST_NAME,
  PROJECT,
  AGENT_ID,
  BOT_TOKEN_HASH,
} from "../lib/config.js";

describe("config", () => {
  test("STATE_DIR reads from env var", () => {
    // preload.ts sets CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR to a tmp dir
    expect(STATE_DIR).toContain("cct-test-");
    expect(STATE_DIR.startsWith(tmpdir())).toBe(true);
  });

  test("ACCESS_FILE is under STATE_DIR", () => {
    expect(ACCESS_FILE).toBe(join(STATE_DIR, "access.json"));
  });

  test("LOCK_FILE is under STATE_DIR", () => {
    expect(LOCK_FILE).toBe(join(STATE_DIR, "claude-code-telegrammer-mcp.lock"));
  });

  test("INBOX_DIR is under STATE_DIR", () => {
    expect(INBOX_DIR).toBe(join(STATE_DIR, "inbox"));
  });

  test("ATTACHMENT_DIR defaults to STATE_DIR/attachments", () => {
    expect(ATTACHMENT_DIR).toBe(join(STATE_DIR, "attachments"));
  });

  test("TOKEN reads from env var", () => {
    // preload.ts sets CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN = "fake:token"
    expect(TOKEN).toBe("fake:token");
  });

  test("API_BASE includes token", () => {
    expect(API_BASE).toBe("https://api.telegram.org/botfake:token");
  });

  test("MAX_TEXT is 4096", () => {
    expect(MAX_TEXT).toBe(4096);
  });

  test("ENV_ALLOWED parses comma-separated users", () => {
    // preload.ts sets CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS = ""
    expect(ENV_ALLOWED).toEqual([]);
  });

  test("HOST_NAME defaults to os.hostname()", () => {
    // Not set in preload, so should fall back to hostname()
    expect(HOST_NAME).toBe(hostname());
  });

  test("PROJECT defaults to cwd", () => {
    // Not set in preload, so should fall back to process.cwd()
    expect(PROJECT).toBe(process.cwd());
  });

  test("AGENT_ID defaults to 'telegram'", () => {
    expect(AGENT_ID).toBe("telegram");
  });

  test("BOT_TOKEN_HASH is 8-char hex from token", () => {
    expect(BOT_TOKEN_HASH).toMatch(/^[0-9a-f]{8}$/);
  });
});
