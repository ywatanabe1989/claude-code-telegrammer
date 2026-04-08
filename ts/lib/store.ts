/**
 * SQLite message store (Schema v2) for persisting all inbound and outbound Telegram messages.
 * Uses bun:sqlite (built-in, zero dependencies).
 */

import { Database, Statement } from "bun:sqlite";
import { join } from "path";
import { STATE_DIR } from "./config.js";
import { log } from "./log.js";

const DB_PATH = join(STATE_DIR, "messages.db");

let db: Database | null = null;

// ── Cached prepared statements ─────────────────────────────────────────────

let stmtInsertInbound: Statement | null = null;
let stmtInsertOutbound: Statement | null = null;
let stmtMarkRead: Statement | null = null;
let stmtMarkAllRead: Statement | null = null;
let stmtGetUnreadAll: Statement | null = null;
let stmtGetUnreadChat: Statement | null = null;
let stmtGetHistory: Statement | null = null;
let stmtSaveOffset: Statement | null = null;
let stmtLoadOffset: Statement | null = null;
let stmtInsertAttachment: Statement | null = null;
let stmtSetRepliedAt: Statement | null = null;
let stmtSearchAll: Statement | null = null;
let stmtSearchChat: Statement | null = null;
let stmtContextChat: Statement | null = null;

// ── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    chat_id TEXT NOT NULL,
    message_id TEXT,
    user_id TEXT,
    username TEXT,
    text TEXT,
    telegram_ts TEXT,
    received_at TEXT DEFAULT (datetime('now')),
    read_at TEXT,
    replied_at TEXT,
    reply_to_message_id TEXT,
    reply_to_row_id INTEGER REFERENCES messages(id),
    host TEXT,
    project TEXT,
    agent_id TEXT,
    bot_token_hash TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_msg_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_msg_direction ON messages(direction, chat_id);
CREATE INDEX IF NOT EXISTS idx_msg_received_at ON messages(received_at);
CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(chat_id, read_at) WHERE read_at IS NULL AND direction = 'inbound';
CREATE INDEX IF NOT EXISTS idx_msg_unreplied ON messages(chat_id, replied_at) WHERE replied_at IS NULL AND direction = 'inbound';
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_dedup ON messages(chat_id, message_id, direction);
CREATE INDEX IF NOT EXISTS idx_msg_agent ON messages(host, project, agent_id);

CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_row_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_unique_id TEXT,
    file_name TEXT,
    mime_type TEXT,
    file_size INTEGER,
    local_path TEXT,
    downloaded_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_att_message ON attachments(message_row_id);
`;

// ── Init ───────────────────────────────────────────────────────────────────

export function initStore(): void {
  db = new Database(DB_PATH, { create: true });
  db.exec(SCHEMA_SQL);

  // Seed meta with schema version
  db.prepare(
    "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '2')",
  ).run();

  // Cache prepared statements
  stmtInsertInbound = db.prepare(`
    INSERT OR IGNORE INTO messages
      (direction, chat_id, message_id, user_id, username, text, telegram_ts, received_at, host, project, agent_id, bot_token_hash, raw_json)
    VALUES
      ('inbound', ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)
  `);

  stmtInsertOutbound = db.prepare(`
    INSERT INTO messages
      (direction, chat_id, message_id, text, reply_to_message_id, reply_to_row_id, host, project, agent_id, bot_token_hash, received_at, replied_at)
    VALUES
      ('outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  stmtSetRepliedAt = db.prepare(`
    UPDATE messages SET replied_at = datetime('now') WHERE id = ? AND direction = 'inbound'
  `);

  stmtMarkRead = db.prepare(`
    UPDATE messages SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL AND direction = 'inbound'
  `);

  stmtMarkAllRead = db.prepare(`
    UPDATE messages SET read_at = datetime('now') WHERE chat_id = ? AND read_at IS NULL AND direction = 'inbound'
  `);

  stmtGetUnreadAll = db.prepare(`
    SELECT * FROM messages WHERE read_at IS NULL AND direction = 'inbound' ORDER BY id
  `);

  stmtGetUnreadChat = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? AND read_at IS NULL AND direction = 'inbound' ORDER BY id
  `);

  stmtGetHistory = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC LIMIT ? OFFSET ?
  `);

  stmtSaveOffset = db.prepare(`
    INSERT INTO meta (key, value) VALUES ('update_offset', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  stmtLoadOffset = db.prepare(`
    SELECT value FROM meta WHERE key = 'update_offset'
  `);

  stmtInsertAttachment = db.prepare(`
    INSERT INTO attachments (message_row_id, kind, file_id, file_unique_id, file_name, mime_type, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmtSearchAll = db.prepare(`
    SELECT * FROM messages WHERE text LIKE ? ORDER BY id DESC LIMIT ?
  `);

  stmtSearchChat = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? AND text LIKE ? ORDER BY id DESC LIMIT ?
  `);

  stmtContextChat = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
  `);

  log("store", `initialized at ${DB_PATH} (schema v2)`);
}

// ── Inbound ────────────────────────────────────────────────────────────────

export function saveInbound(msg: {
  chat_id: string;
  message_id: string;
  user_id: string;
  username: string;
  text: string;
  telegram_ts: string;
  host: string;
  project: string;
  agent_id: string;
  bot_token_hash: string;
  raw_json: string;
}): number | null {
  if (!db || !stmtInsertInbound) throw new Error("store not initialized");
  const result = stmtInsertInbound.run(
    msg.chat_id,
    msg.message_id,
    msg.user_id,
    msg.username,
    msg.text,
    msg.telegram_ts,
    msg.host,
    msg.project,
    msg.agent_id,
    msg.bot_token_hash,
    msg.raw_json,
  );
  // INSERT OR IGNORE returns changes=0 on duplicate
  if (result.changes === 0) return null;
  return Number(result.lastInsertRowid);
}

// ── Outbound ───────────────────────────────────────────────────────────────

export function saveOutbound(
  chatId: string,
  text: string,
  messageId?: string,
  replyToRowId?: number,
  ctx?: {
    host: string;
    project: string;
    agent_id: string;
    bot_token_hash: string;
  },
): number {
  if (!db || !stmtInsertOutbound || !stmtSetRepliedAt)
    throw new Error("store not initialized");

  const result = stmtInsertOutbound.run(
    chatId,
    messageId ?? null,
    text,
    null, // reply_to_message_id (not used directly — we use row id)
    replyToRowId ?? null,
    ctx?.host ?? null,
    ctx?.project ?? null,
    ctx?.agent_id ?? null,
    ctx?.bot_token_hash ?? null,
  );

  // Mark the referenced inbound message as replied
  if (replyToRowId) {
    stmtSetRepliedAt.run(replyToRowId);
  }

  return Number(result.lastInsertRowid);
}

// ── Read status ────────────────────────────────────────────────────────────

export function markRead(id: number): void {
  if (!stmtMarkRead) throw new Error("store not initialized");
  stmtMarkRead.run(id);
}

export function markAllRead(chatId: string): void {
  if (!stmtMarkAllRead) throw new Error("store not initialized");
  stmtMarkAllRead.run(chatId);
}

// ── Queries ────────────────────────────────────────────────────────────────

export function getUnread(chatId?: string): Array<Record<string, unknown>> {
  if (!stmtGetUnreadAll || !stmtGetUnreadChat)
    throw new Error("store not initialized");
  if (chatId) {
    return stmtGetUnreadChat.all(chatId) as Array<Record<string, unknown>>;
  }
  return stmtGetUnreadAll.all() as Array<Record<string, unknown>>;
}

export function getHistory(
  chatId: string,
  limit: number = 20,
  offset: number = 0,
): Array<Record<string, unknown>> {
  if (!stmtGetHistory) throw new Error("store not initialized");
  return stmtGetHistory.all(chatId, limit, offset) as Array<
    Record<string, unknown>
  >;
}

// ── Offset persistence ─────────────────────────────────────────────────────

export function saveOffset(offset: number): void {
  if (!stmtSaveOffset) throw new Error("store not initialized");
  stmtSaveOffset.run(String(offset));
}

export function loadOffset(): number {
  if (!stmtLoadOffset) throw new Error("store not initialized");
  const row = stmtLoadOffset.get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

// ── Attachments ────────────────────────────────────────────────────────────

export function insertAttachment(
  messageRowId: number,
  attachment: {
    kind: string;
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  },
): void {
  if (!stmtInsertAttachment) throw new Error("store not initialized");
  stmtInsertAttachment.run(
    messageRowId,
    attachment.kind,
    attachment.file_id,
    attachment.file_unique_id ?? null,
    attachment.file_name ?? null,
    attachment.mime_type ?? null,
    attachment.file_size ?? null,
  );
}

// ── Search & Context ──────────────────────────────────────────────────────

export function searchMessages(
  query: string,
  chatId?: string,
  limit: number = 20,
): Array<Record<string, unknown>> {
  if (!stmtSearchAll || !stmtSearchChat)
    throw new Error("store not initialized");
  const pattern = `%${query}%`;
  if (chatId) {
    return stmtSearchChat.all(chatId, pattern, limit) as Array<
      Record<string, unknown>
    >;
  }
  return stmtSearchAll.all(pattern, limit) as Array<Record<string, unknown>>;
}

export function getConversationContext(
  chatId: string,
  maxMessages: number = 10,
): string {
  if (!stmtContextChat) throw new Error("store not initialized");
  const rows = stmtContextChat.all(chatId, maxMessages) as Array<
    Record<string, unknown>
  >;
  // Reverse to chronological order (query is DESC)
  rows.reverse();
  return rows
    .map((r) => {
      const dir = r.direction === "inbound" ? "user" : "bot";
      const who = r.username ?? r.user_id ?? dir;
      const ts = r.telegram_ts ?? r.received_at ?? "";
      return `[${ts}] ${who} (${dir}): ${r.text ?? ""}`;
    })
    .join("\n");
}
