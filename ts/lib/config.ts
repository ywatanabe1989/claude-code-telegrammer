/**
 * Configuration and constants for the Telegram MCP server.
 */

import { homedir, hostname } from "os";
import { join } from "path";

export const STATE_DIR =
  process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR ??
  join(homedir(), ".claude-code-telegrammer");

export const ACCESS_FILE = join(STATE_DIR, "access.json");
export const LOCK_FILE = join(STATE_DIR, "claude-code-telegrammer-mcp.lock");
export const INBOX_DIR = join(STATE_DIR, "inbox");
export const ATTACHMENT_DIR =
  process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ATTACHMENT_DIR ??
  join(STATE_DIR, "attachments");

export const TOKEN =
  process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN ?? "";
export const API_BASE = `https://api.telegram.org/bot${TOKEN}`;
export const MAX_TEXT = 4096;

export const ENV_ALLOWED = (
  process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Agent identity ─────────────────────────────────────────────────────────

export const HOST_NAME =
  process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_HOST_NAME ?? hostname();
export const PROJECT =
  process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_PROJECT ?? process.cwd();
export const AGENT_ID =
  process.env.CLAUDE_CODE_TELEGRAMMER_TELEGRAM_AGENT_ID ?? "telegram";

export const BOT_TOKEN_HASH: string = TOKEN
  ? new Bun.CryptoHasher("sha256").update(TOKEN).digest("hex").slice(0, 8)
  : "";
