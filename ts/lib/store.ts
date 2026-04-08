/**
 * SQLite message store for persisting all inbound and outbound Telegram messages.
 * Uses bun:sqlite (built-in, zero dependencies).
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { STATE_DIR } from "./config.js";
import { log } from "./log.js";

const DB_PATH = join(STATE_DIR, "messages.db");

let db: Database | null = null;

export function initStore(): void {
  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT,
      user_id TEXT,
      username TEXT,
      text TEXT,
      timestamp TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
  `);
  log(`message store initialized at ${DB_PATH}`);
}

export function saveInbound(msg: {
  chat_id: string;
  message_id: string;
  user_id: string;
  username: string;
  text: string;
  timestamp: string;
  metadata?: Record<string, string>;
}): number {
  if (!db) throw new Error("store not initialized");
  const stmt = db.prepare(`
    INSERT INTO messages (direction, chat_id, message_id, user_id, username, text, timestamp, metadata)
    VALUES ('inbound', ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    msg.chat_id,
    msg.message_id,
    msg.user_id,
    msg.username,
    msg.text,
    msg.timestamp,
    msg.metadata ? JSON.stringify(msg.metadata) : null,
  );
  return Number(result.lastInsertRowid);
}

export function saveOutbound(
  chatId: string,
  text: string,
  messageId?: string,
): number {
  if (!db) throw new Error("store not initialized");
  const stmt = db.prepare(`
    INSERT INTO messages (direction, chat_id, message_id, text, timestamp)
    VALUES ('outbound', ?, ?, ?, ?)
  `);
  const result = stmt.run(
    chatId,
    messageId ?? null,
    text,
    new Date().toISOString(),
  );
  return Number(result.lastInsertRowid);
}

export function getHistory(
  chatId: string,
  limit: number = 50,
): Array<Record<string, unknown>> {
  if (!db) throw new Error("store not initialized");
  const stmt = db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
  `);
  return stmt.all(chatId, limit) as Array<Record<string, unknown>>;
}
