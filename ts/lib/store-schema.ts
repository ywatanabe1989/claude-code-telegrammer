/**
 * The store's data definition, and the one place its SQL text is built.
 *
 * Split out of store.ts for this repo's per-file line cap, the same way
 * store-meta.ts and store-migrations.ts already were. It has a second job
 * though: the schema name cannot travel in a parameter slot, so every
 * statement in this package is assembled ONCE, here, with the namespace
 * spliced in through {@link quoteSchema}. Keeping that splice in a single file
 * means there is exactly one place to audit for injection rather than fifty
 * call sites.
 *
 * ON THE COLUMN TYPES. `received_at` / `created_at` / `downloaded_at` are TEXT
 * holding `YYYY-MM-DD HH:MM:SS` in UTC, not `timestamptz`, and that is
 * deliberate. Those strings are read back by the MCP tools, rendered into the
 * conversation context an agent sees, and parsed by the health probe — all of
 * which already agree on that exact shape. Changing the wire format of a value
 * the operator reads, in the same change that moves the storage engine, would
 * fold two risks into one commit for no gain. {@link NOW_UTC_TEXT} produces
 * byte-identical output to what wrote these rows before.
 */

import { quoteSchema } from "./pg.js";

/**
 * UTC wall-clock as `YYYY-MM-DD HH:MM:SS`.
 *
 * Byte-identical to what the previous engine's `datetime('now')` produced,
 * which is what every existing reader (and every stored row) expects.
 */
export const NOW_UTC_TEXT = `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

/**
 * Full DDL for one agent's namespace. Idempotent: safe on every startup, and
 * safe when two processes (the MCP server and its poller) run it at once.
 */
export function schemaSql(schema: string): string {
  const s = quoteSchema(schema);
  return `
CREATE SCHEMA IF NOT EXISTS ${s};

CREATE TABLE IF NOT EXISTS ${s}.meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${s}.messages (
    id BIGSERIAL PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    chat_id TEXT NOT NULL,
    message_id TEXT,
    user_id TEXT,
    username TEXT,
    text TEXT,
    telegram_ts TEXT,
    received_at TEXT DEFAULT ${NOW_UTC_TEXT},
    read_at TEXT,
    replied_at TEXT,
    reply_to_message_id TEXT,
    reply_to_row_id BIGINT REFERENCES ${s}.messages(id),
    forward_json TEXT,
    host TEXT,
    project TEXT,
    agent_id TEXT,
    bot_token_hash TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT ${NOW_UTC_TEXT}
);

CREATE INDEX IF NOT EXISTS idx_msg_chat_id ON ${s}.messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_msg_direction ON ${s}.messages(direction, chat_id);
CREATE INDEX IF NOT EXISTS idx_msg_received_at ON ${s}.messages(received_at);
CREATE INDEX IF NOT EXISTS idx_msg_unread ON ${s}.messages(chat_id, read_at) WHERE read_at IS NULL AND direction = 'inbound';
CREATE INDEX IF NOT EXISTS idx_msg_unreplied ON ${s}.messages(chat_id, replied_at) WHERE replied_at IS NULL AND direction = 'inbound';
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_dedup ON ${s}.messages(chat_id, message_id, direction);
CREATE INDEX IF NOT EXISTS idx_msg_agent ON ${s}.messages(host, project, agent_id);

CREATE TABLE IF NOT EXISTS ${s}.attachments (
    id BIGSERIAL PRIMARY KEY,
    message_row_id BIGINT NOT NULL REFERENCES ${s}.messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_unique_id TEXT,
    file_name TEXT,
    mime_type TEXT,
    file_size BIGINT,
    local_path TEXT,
    downloaded_at TEXT,
    created_at TEXT DEFAULT ${NOW_UTC_TEXT}
);

CREATE INDEX IF NOT EXISTS idx_att_message ON ${s}.attachments(message_row_id);
`;
}

/**
 * Every statement the message store issues, bound to one namespace.
 *
 * Built as an object of strings rather than driver-prepared handles: the
 * previous engine cached prepared statements because it was synchronous and
 * in-process, whereas the pooled client prepares and caches per connection on
 * its own. What we keep is the property that mattered — the SQL text exists in
 * exactly one place and cannot drift between callers.
 */
export function statements(schema: string) {
  const s = quoteSchema(schema);
  return {
    insertInbound: `
      INSERT INTO ${s}.messages
        (direction, chat_id, message_id, user_id, username, text, telegram_ts,
         received_at, reply_to_message_id, forward_json, host, project,
         agent_id, bot_token_hash, raw_json)
      VALUES
        ('inbound', $1, $2, $3, $4, $5, $6, ${NOW_UTC_TEXT}, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT DO NOTHING
      RETURNING id`,

    insertOutbound: `
      INSERT INTO ${s}.messages
        (direction, chat_id, message_id, text, reply_to_message_id,
         reply_to_row_id, host, project, agent_id, bot_token_hash,
         received_at, replied_at)
      VALUES
        ('outbound', $1, $2, $3, $4, $5, $6, $7, $8, $9, ${NOW_UTC_TEXT}, ${NOW_UTC_TEXT})
      RETURNING id`,

    setRepliedAt: `
      UPDATE ${s}.messages SET replied_at = ${NOW_UTC_TEXT}
      WHERE id = $1 AND direction = 'inbound'`,

    markRead: `
      UPDATE ${s}.messages SET read_at = ${NOW_UTC_TEXT}
      WHERE id = $1 AND read_at IS NULL AND direction = 'inbound'`,

    markAllRead: `
      UPDATE ${s}.messages SET read_at = ${NOW_UTC_TEXT}
      WHERE chat_id = $1 AND read_at IS NULL AND direction = 'inbound'`,

    unreadAll: `
      SELECT * FROM ${s}.messages
      WHERE read_at IS NULL AND direction = 'inbound' ORDER BY id`,

    unreadChat: `
      SELECT * FROM ${s}.messages
      WHERE chat_id = $1 AND read_at IS NULL AND direction = 'inbound' ORDER BY id`,

    history: `
      SELECT * FROM ${s}.messages WHERE chat_id = $1 ORDER BY id ASC LIMIT $2 OFFSET $3`,

    // Reply-target lookup (lib/reply-context.ts). Deliberately NOT filtered by
    // direction: the message an operator replies to is usually one the BOT
    // sent, so an inbound-only lookup would miss the common case entirely.
    // Newest row wins — (chat_id, message_id, direction) is unique, so the only
    // way to get two is an inbound and an outbound sharing an id.
    byMessageId: `
      SELECT * FROM ${s}.messages WHERE chat_id = $1 AND message_id = $2
      ORDER BY id DESC LIMIT 1`,

    insertAttachment: `
      INSERT INTO ${s}.attachments
        (message_row_id, kind, file_id, file_unique_id, file_name, mime_type, file_size)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,

    // The join onto messages carries chat_id along so download_attachment(row_id)
    // can route the download into the right per-chat directory without a
    // second lookup (incident cct-inbound-images-20260707).
    //
    // The id list travels as ONE comma-joined string that the SERVER expands
    // into an array, rather than as an array parameter. Measured: the driver
    // flattens a one-element JS array to a scalar, and Postgres answers
    // `malformed array literal: "9"` — so a history page containing exactly
    // one attachment failed while a page with two worked. A joined string has
    // the same wire shape at every arity, which removes the arity-dependent
    // bug rather than special-casing it. The caller coerces each id with
    // Number() first, so nothing but digits can reach the string.
    attachmentsForRow: `
      SELECT a.message_row_id, a.kind, a.file_id, a.file_name, a.mime_type,
             a.local_path, a.downloaded_at, m.chat_id
      FROM ${s}.attachments a JOIN ${s}.messages m ON m.id = a.message_row_id
      WHERE a.message_row_id = ANY(string_to_array($1, ',')::bigint[])
      ORDER BY a.id`,

    attachmentByFileId: `
      SELECT a.message_row_id, a.kind, a.file_id, a.file_name, a.mime_type,
             a.local_path, a.downloaded_at, m.chat_id
      FROM ${s}.attachments a JOIN ${s}.messages m ON m.id = a.message_row_id
      WHERE a.file_id = $1 ORDER BY a.id DESC LIMIT 1`,

    markAttachmentDownloaded: `
      UPDATE ${s}.attachments SET local_path = $1, downloaded_at = ${NOW_UTC_TEXT}
      WHERE message_row_id = $2 AND file_id = $3`,

    searchAll: `
      SELECT * FROM ${s}.messages WHERE text LIKE $1 ORDER BY id DESC LIMIT $2`,

    searchChat: `
      SELECT * FROM ${s}.messages WHERE chat_id = $1 AND text LIKE $2
      ORDER BY id DESC LIMIT $3`,

    contextChat: `
      SELECT * FROM ${s}.messages WHERE chat_id = $1 ORDER BY id DESC LIMIT $2`,

    metaUpsert: `
      INSERT INTO ${s}.meta (key, value) VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`,

    metaSeed: `
      INSERT INTO ${s}.meta (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING`,

    metaRead: `SELECT value FROM ${s}.meta WHERE key = $1`,

    // ── Health-doctor probes ────────────────────────────────────────────
    //
    // Aggregates are cast to text and parsed in TS rather than trusted as
    // numbers off the wire: COUNT and MAX over bigint arrive as driver-
    // dependent shapes, and a probe that silently yields a string where the
    // pure check expects a number reports a false verdict rather than an
    // error.
    probeAggregate: `
      SELECT MAX((raw_json::jsonb ->> 'update_id')::bigint)::text AS max_id,
             COUNT(*)::text AS n
      FROM ${s}.messages
      WHERE direction = 'inbound' AND raw_json IS NOT NULL`,

    // Age of the newest inbound row — the "did anything ARRIVE?" signal that
    // last_poll_ts cannot give (a successful poll returning zero updates looks
    // exactly like a healthy quiet channel). Converted to epoch seconds in SQL
    // rather than parsed in TS: received_at is UTC wall-clock with no zone
    // suffix, and `new Date()` on that string reads it as LOCAL time.
    probeNewestInbound: `
      SELECT MAX(EXTRACT(EPOCH FROM received_at::timestamp))::text AS s
      FROM ${s}.messages
      WHERE direction = 'inbound' AND received_at IS NOT NULL`,

    // Does this namespace hold a store yet? A brand-new agent has a schema
    // with nothing in it, which is a normal first run — distinct from a store
    // we could not reach at all.
    tablePresent: `SELECT to_regclass($1) IS NOT NULL AS present`,

    setPendingNotification: `
      UPDATE ${s}.messages SET pending_notification = $1 WHERE id = $2`,

    readPendingNotification: `
      SELECT pending_notification FROM ${s}.messages WHERE id = $1`,

    pendingNotifications: `
      SELECT id, pending_notification FROM ${s}.messages
      WHERE pending_notification IS NOT NULL ORDER BY id`,

    clearPendingNotification: `
      UPDATE ${s}.messages SET pending_notification = NULL WHERE id = $1`,
  };
}

export type Statements = ReturnType<typeof statements>;
