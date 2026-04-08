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
      chat_id TEXT NOT NULL,
      message_id TEXT,
      user_id TEXT,
      username TEXT,
      received_contents TEXT,
      replied_contents TEXT,
      metadata TEXT,
      received_at TEXT DEFAULT (datetime('now')),
      read_at TEXT,
      replied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_received_at ON messages(received_at);
    CREATE INDEX IF NOT EXISTS idx_unread ON messages(read_at) WHERE read_at IS NULL;
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
    INSERT INTO messages (chat_id, message_id, user_id, username, received_contents, metadata, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    msg.chat_id,
    msg.message_id,
    msg.user_id,
    msg.username,
    msg.text,
    msg.metadata ? JSON.stringify(msg.metadata) : null,
    msg.timestamp,
  );
  return Number(result.lastInsertRowid);
}

export function saveOutbound(
  chatId: string,
  text: string,
  messageId?: string,
): void {
  if (!db) throw new Error("store not initialized");
  // Update the most recent unread inbound message with the reply
  const updated = db
    .prepare(
      "UPDATE messages SET replied_contents = ?, replied_at = datetime('now') WHERE chat_id = ? AND replied_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .run(text, chatId);
  // If no unread message to attach to, insert as standalone outbound
  if (updated.changes === 0) {
    db.prepare(
      "INSERT INTO messages (chat_id, message_id, replied_contents, received_at, replied_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
    ).run(chatId, messageId ?? null, text);
  }
}

export function markRead(id: number): void {
  if (!db) throw new Error("store not initialized");
  db.prepare(
    "UPDATE messages SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL",
  ).run(id);
}

export function markAllRead(chatId: string): void {
  if (!db) throw new Error("store not initialized");
  db.prepare(
    "UPDATE messages SET read_at = datetime('now') WHERE chat_id = ? AND read_at IS NULL",
  ).run(chatId);
}

export function markReplied(chatId: string): void {
  if (!db) throw new Error("store not initialized");
  db.prepare(
    "UPDATE messages SET replied_at = datetime('now') WHERE chat_id = ? AND replied_at IS NULL",
  ).run(chatId);
}

export function getUnread(chatId?: string): Array<Record<string, unknown>> {
  if (!db) throw new Error("store not initialized");
  if (chatId) {
    return db
      .prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND read_at IS NULL ORDER BY id",
      )
      .all(chatId) as Array<Record<string, unknown>>;
  }
  return db
    .prepare("SELECT * FROM messages WHERE read_at IS NULL ORDER BY id")
    .all() as Array<Record<string, unknown>>;
}

export function getHistory(
  chatId: string,
  limit: number = 50,
): Array<Record<string, unknown>> {
  if (!db) throw new Error("store not initialized");
  return db
    .prepare(
      "SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(chatId, limit) as Array<Record<string, unknown>>;
}
