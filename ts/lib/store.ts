/**
 * SQLite message store (Schema v2) for persisting all inbound and outbound Telegram messages.
 * Uses bun:sqlite (built-in, zero dependencies).
 */

import { Database, Statement } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { STATE_DIR } from "./config.js";
import { log } from "./log.js";
import { ensureColumn } from "./store-migrations.js";
import { assertHermeticTestStore } from "./hermetic-guard.js";
import { initStoreMeta } from "./store-meta.js";
export { ensureColumn } from "./store-migrations.js";
// Poller restart-state (offset / poll heartbeat / coverage gap) moved to
// store-meta.ts when this file hit the 512-line ceiling. Re-exported here so
// every existing `from "./store.js"` importer is unaffected.
export {
  saveOffset,
  loadOffset,
  saveLastPollTs,
  loadLastPollTs,
  saveCoverageGap,
  loadCoverageGap,
  type CoverageGap,
} from "./store-meta.js";

// Scitex-standard DB filename (was "messages.db"): self-describing in the
// ~/.scitex/claude-code-telegrammer runtime tree. SQLite derives the -wal/-shm
// sidecars from this stem; the startup auto-migration (lib/migrate-state.ts)
// copies a legacy messages.db onto this name once so history is never lost.
export const DB_PATH = join(STATE_DIR, "claude-code-telegrammer.db");

// The schema version this code WRITES into meta.schema_version on init.
// Exported as the single source of truth so the health check
// (lib/health-checks.ts::checkDbSchemaCurrent) compares against the same
// constant instead of a drifting copy.
export const SCHEMA_VERSION = "2";

let db: Database | null = null;

// ── Cached prepared statements ─────────────────────────────────────────────

let stmtInsertInbound: Statement | null = null;
let stmtInsertOutbound: Statement | null = null;
let stmtMarkRead: Statement | null = null;
let stmtMarkAllRead: Statement | null = null;
let stmtGetUnreadAll: Statement | null = null;
let stmtGetUnreadChat: Statement | null = null;
let stmtGetHistory: Statement | null = null;
let stmtInsertAttachment: Statement | null = null;
let stmtAttachmentsForRow: Statement | null = null;
let stmtAttachmentByFileId: Statement | null = null;
let stmtMarkAttachmentDownloaded: Statement | null = null;
let stmtSetRepliedAt: Statement | null = null;
let stmtSearchAll: Statement | null = null;
let stmtSearchChat: Statement | null = null;
let stmtContextChat: Statement | null = null;

// ── Schema ─────────────────────────────────────────────────────────────────

// busy_timeout FIRST (concurrency fix — see ts/test/multiprocess-sqlite.test.ts):
const SCHEMA_SQL = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
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
    forward_json TEXT,
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
  // FAIL LOUD before we touch a single byte: a test run whose hermetic preload
  // did not load is about to open the LIVE production database. Silently
  // writing to the real bridge is the single most destructive thing this
  // process can do, and on 2026-07-14 it did exactly that (see
  // lib/hermetic-guard.ts). Guard the act, not the intention.
  assertHermeticTestStore(process.env.NODE_ENV, STATE_DIR, tmpdir());

  db = new Database(DB_PATH, { create: true });
  db.exec(SCHEMA_SQL);

  // Seed meta with schema version
  db.prepare(
    "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(SCHEMA_VERSION);

  // ── Migration: forward_json column (added 2026-06) ──────────────────
  // CREATE TABLE IF NOT EXISTS does NOT alter existing tables, so older
  // databases need an explicit ALTER. Guarded by table_info check so
  // it's idempotent and safe to re-run on every startup.
  ensureColumn(db, "messages", "forward_json", "TEXT");
  // ── Migration: pending_notification (added 2026-07) — lib/notify-relay.ts
  // cross-process live-push relay for interactive-CLI (!wakeEnabled()) mode.
  ensureColumn(db, "messages", "pending_notification", "TEXT");

  // Cache prepared statements
  stmtInsertInbound = db.prepare(`
    INSERT OR IGNORE INTO messages
      (direction, chat_id, message_id, user_id, username, text, telegram_ts, received_at, reply_to_message_id, forward_json, host, project, agent_id, bot_token_hash, raw_json)
    VALUES
      ('inbound', ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
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

  // Poller restart-state (update_offset / last_poll_ts / coverage_gap) lives
  // in store-meta.ts — same `meta` table, its own responsibility.
  initStoreMeta(db);

  stmtInsertAttachment = db.prepare(`
    INSERT INTO attachments (message_row_id, kind, file_id, file_unique_id, file_name, mime_type, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Attachment queries (incident cct-inbound-images-20260707): the join
  // onto messages carries chat_id along so download_attachment(row_id)
  // can route the download into the right per-chat directory without a
  // second lookup.
  stmtAttachmentsForRow = db.prepare(`
    SELECT a.message_row_id, a.kind, a.file_id, a.file_name, a.mime_type,
           a.local_path, a.downloaded_at, m.chat_id
    FROM attachments a JOIN messages m ON m.id = a.message_row_id
    WHERE a.message_row_id = ? ORDER BY a.id
  `);

  stmtAttachmentByFileId = db.prepare(`
    SELECT a.message_row_id, a.kind, a.file_id, a.file_name, a.mime_type,
           a.local_path, a.downloaded_at, m.chat_id
    FROM attachments a JOIN messages m ON m.id = a.message_row_id
    WHERE a.file_id = ? ORDER BY a.id DESC LIMIT 1
  `);

  stmtMarkAttachmentDownloaded = db.prepare(`
    UPDATE attachments SET local_path = ?, downloaded_at = datetime('now')
    WHERE message_row_id = ? AND file_id = ?
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

  log("store", `initialized at ${DB_PATH} (schema v${SCHEMA_VERSION})`);
}

// ── Inbound ────────────────────────────────────────────────────────────────

export function saveInbound(msg: {
  chat_id: string;
  message_id: string;
  user_id: string;
  username: string;
  text: string;
  telegram_ts: string;
  reply_to_message_id?: string;
  forward_json?: string;
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
    msg.reply_to_message_id ?? null,
    msg.forward_json ?? null,
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

/**
 * One row of the attachments table, joined with the owning message's
 * chat_id. `local_path` / `downloaded_at` are null until the background
 * auto-download (attachments.ts) or an explicit download_attachment call
 * completes.
 */
export interface AttachmentRow {
  message_row_id: number;
  kind: string;
  file_id: string;
  file_name: string | null;
  mime_type: string | null;
  local_path: string | null;
  downloaded_at: string | null;
  chat_id: string;
}

/**
 * Attachments for a set of message row ids (incident
 * cct-inbound-images-20260707 — lets get_history / get_unread expose
 * file_id + local_path per message). Loops one indexed lookup per row
 * instead of a dynamic IN (…) because prepared statements are fixed-arity
 * and a history page is ≤ ~20 rows — N tiny idx_att_message hits.
 */
export function attachmentsForRows(rowIds: number[]): AttachmentRow[] {
  if (!stmtAttachmentsForRow) throw new Error("store not initialized");
  const out: AttachmentRow[] = [];
  for (const id of rowIds) {
    out.push(...(stmtAttachmentsForRow.all(id) as AttachmentRow[]));
  }
  return out;
}

/**
 * Newest attachment row for a Telegram file_id (or null if the file_id
 * was never stored — e.g. a caller passing an id from another bot).
 * Used by download_attachment to short-circuit to an existing
 * local_path before hitting the network.
 */
export function findAttachmentByFileId(fileId: string): AttachmentRow | null {
  if (!stmtAttachmentByFileId) throw new Error("store not initialized");
  return (stmtAttachmentByFileId.get(fileId) as AttachmentRow) ?? null;
}

/**
 * Record a completed download on the attachment row so later
 * download_attachment calls (and get_history/get_unread consumers) see
 * the local_path. Same UPDATE the background queue in attachments.ts
 * performs — kept here too so the on-demand path is equally durable.
 */
export function markAttachmentDownloaded(
  messageRowId: number,
  fileId: string,
  localPath: string,
): void {
  if (!stmtMarkAttachmentDownloaded) throw new Error("store not initialized");
  stmtMarkAttachmentDownloaded.run(localPath, messageRowId, fileId);
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
