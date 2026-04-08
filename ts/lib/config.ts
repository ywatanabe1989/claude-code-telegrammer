/**
 * Configuration and constants for the Telegram MCP server.
 */

import { homedir } from "os";
import { join } from "path";

export const STATE_DIR =
  process.env.TELEGRAM_STATE_DIR ??
  join(homedir(), ".scitex", "agent-container", "telegram");

export const ACCESS_FILE = join(STATE_DIR, "access.json");
export const LOCK_FILE = join(STATE_DIR, "telegram-mcp.lock");
export const INBOX_DIR = join(STATE_DIR, "inbox");

export const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
export const API_BASE = `https://api.telegram.org/bot${TOKEN}`;
export const MAX_TEXT = 4096;

export const ENV_ALLOWED = (process.env.TELEGRAM_ALLOWED_USERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
