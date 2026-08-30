/**
 * PostgreSQL message store (Schema v3) for every inbound and outbound
 * Telegram message.
 *
 * WHAT CHANGED IN v3, AND WHAT DID NOT. The engine moved off local files onto
 * the fleet's PostgreSQL server (standing directive, 2026-08-29 — no
 * exceptions). The TABLES did not change: same columns, same names, same
 * indexes, same `YYYY-MM-DD HH:MM:SS` UTC text timestamps. Anything reading a
 * row out of this store sees exactly what it saw before.
 *
 * WHAT CALLERS MUST NOTICE: every function here is now ASYNC. The previous
 * engine was synchronous and in-process; a network database cannot be. That is
 * the whole cost of the move, and it is paid once at each call site with an
 * `await`. Nothing else about the contract moved — `saveInbound` still returns
 * null on a duplicate rather than throwing, and a THROW here still means a
 * real persist failure, which is what tells the poller not to advance the
 * getUpdates offset past a message it failed to store.
 *
 * Poller restart-state (offset / poll heartbeat / coverage gap) lives in
 * store-meta.ts and is re-exported below, so every existing importer of
 * `./store.js` keeps working unchanged.
 */

import { getSql, resolveSchema } from "./pg.js";
import { log } from "./log.js";
import { ensureColumn, isConcurrentDdlRace } from "./store-migrations.js";
import { assertHermeticTestStore } from "./hermetic-guard.js";
import { initStoreMeta } from "./store-meta.js";
import { schemaSql, statements, type Statements } from "./store-schema.js";
export { ensureColumn, isConcurrentDdlRace } from "./store-migrations.js";
export {
  saveOffset,
  loadOffset,
  saveLastPollTs,
  loadLastPollTs,
  saveCoverageGap,
  loadCoverageGap,
  type CoverageGap,
} from "./store-meta.js";

/**
 * The schema version this code WRITES into meta.schema_version on init.
 *
 * Exported as the single source of truth so the health check
 * (lib/health-checks.ts::checkDbSchemaCurrent) compares against the same
 * constant instead of a drifting copy. Bumped to 3 by the storage-engine move:
 * a store still reporting 2 is a file-backed one that has not been carried
 * forward, and saying so is more useful than pretending the versions are
 * interchangeable.
 */
export const SCHEMA_VERSION = "3";

let stmt: Statements | null = null;
let activeSchema: string | null = null;

/** The namespace this process is bound to. Throws before {@link initStore}. */
export function storeSchema(): string {
  if (activeSchema === null) throw new Error("store not initialized");
  return activeSchema;
}

function ready(): Statements {
  if (!stmt) throw new Error("store not initialized");
  return stmt;
}

// ── Init ───────────────────────────────────────────────────────────────────

/**
 * Create this agent's namespace if absent, bring it forward, and bind the
 * statements. Idempotent, and safe when the MCP server and its poller run it
 * concurrently.
 */
export async function initStore(): Promise<void> {
  // FAIL LOUD before we touch a single row: a test run whose hermetic preload
  // did not load is about to open the LIVE production namespace. Silently
  // writing to the real bridge is the single most destructive thing this
  // process can do, and on 2026-07-14 it did exactly that (see
  // lib/hermetic-guard.ts). Guard the act, not the intention.
  const schema = resolveSchema();
  assertHermeticTestStore(process.env.NODE_ENV, schema);

  await applySchema(schema);

  const s = statements(schema);

  // ── Migration: forward_json column (added 2026-06) ──────────────────
  // CREATE TABLE IF NOT EXISTS does NOT alter existing tables when columns are
  // added to the schema, so this runs on every startup to bring older
  // namespaces forward without dropping data.
  await ensureColumn(schema, "messages", "forward_json", "TEXT");
  // ── Migration: pending_notification (added 2026-07) — lib/notify-relay.ts
  // cross-process live-push relay for interactive-CLI (!wakeEnabled()) mode.
  await ensureColumn(schema, "messages", "pending_notification", "TEXT");

  await getSql().unsafe(s.metaSeed, ["schema_version", SCHEMA_VERSION]);

  stmt = s;
  activeSchema = schema;
  initStoreMeta(s);

  log("store", `initialized in schema ${schema} (schema v${SCHEMA_VERSION})`);
}

/**
 * Run the DDL script, RETRYING when a concurrent starter wins a catalog race.
 *
 * A retry rather than a swallow, because the script is many statements run as
 * one batch: if statement three loses the race, statements four onward never
 * executed, and treating that as success would leave the namespace missing
 * tables. On the retry every object the winner made already exists, so the
 * IF NOT EXISTS clauses no-op and the batch completes.
 *
 * Three attempts, because more than one object can be contended in the same
 * batch (the schema, then a table, then an index) and each lost race costs
 * one attempt. A fourth would be indistinguishable from a real fault.
 */
async function applySchema(schema: string): Promise<void> {
  const sql = getSql();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sql.unsafe(schemaSql(schema)).simple();
      return;
    } catch (err) {
      if (attempt === 3 || !isConcurrentDdlRace(err)) throw err;
      log(
        "store",
        `schema DDL lost a startup race (attempt ${attempt}/3) — another ` +
          `process is creating the same namespace; retrying`,
        { schema },
      );
    }
  }
}

/** Test hook: forget the binding so the next initStore() re-resolves it. */
export function _resetStoreForTests(): void {
  stmt = null;
  activeSchema = null;
}


/**
 * Bring one message row back to the shape callers have always seen.
 *
 * `id` and `reply_to_row_id` are 64-bit in the database, and a 64-bit integer
 * does not fit a JavaScript number, so the driver hands them over as STRINGS
 * rather than silently rounding. That is the right call by the driver and the
 * wrong shape for us: these ids are returned verbatim to MCP callers by
 * get_history / get_unread, and an agent that has always read `id` as a number
 * would start seeing `"41"`. A row id in this store is bounded by the number
 * of Telegram messages one bridge ever receives, which is nowhere near the
 * safe-integer limit, so the conversion is lossless in practice — and doing it
 * HERE, once, is what keeps the change invisible to everything downstream.
 */
function normalizeMessageRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...row };
  if (typeof out.id === "string") out.id = Number(out.id);
  if (typeof out.reply_to_row_id === "string") {
    out.reply_to_row_id = Number(out.reply_to_row_id);
  }
  return out;
}

// ── Inbound ────────────────────────────────────────────────────────────────

export async function saveInbound(msg: {
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
}): Promise<number | null> {
  const rows = await getSql().unsafe(ready().insertInbound, [
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
  ]);
  // ON CONFLICT DO NOTHING returns no row on a duplicate — the same "already
  // durably stored, safe to advance the offset" signal the previous engine
  // gave through changes=0.
  const row = rows[0] as { id: string | number } | undefined;
  return row ? Number(row.id) : null;
}

// ── Outbound ───────────────────────────────────────────────────────────────

export async function saveOutbound(
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
): Promise<number> {
  const s = ready();
  const sql = getSql();
  const rows = await sql.unsafe(s.insertOutbound, [
    chatId,
    messageId ?? null,
    text,
    null, // reply_to_message_id (not used directly — we use row id)
    replyToRowId ?? null,
    ctx?.host ?? null,
    ctx?.project ?? null,
    ctx?.agent_id ?? null,
    ctx?.bot_token_hash ?? null,
  ]);

  // Mark the referenced inbound message as replied
  if (replyToRowId) {
    await sql.unsafe(s.setRepliedAt, [replyToRowId]);
  }

  return Number((rows[0] as { id: string | number }).id);
}

// ── Read status ────────────────────────────────────────────────────────────

export async function markRead(id: number): Promise<void> {
  await getSql().unsafe(ready().markRead, [id]);
}

export async function markAllRead(chatId: string): Promise<void> {
  await getSql().unsafe(ready().markAllRead, [chatId]);
}

// ── Queries ────────────────────────────────────────────────────────────────

export async function getUnread(
  chatId?: string,
): Promise<Array<Record<string, unknown>>> {
  const s = ready();
  const rows = chatId
    ? await getSql().unsafe(s.unreadChat, [chatId])
    : await getSql().unsafe(s.unreadAll, []);
  return (rows as Array<Record<string, unknown>>).map(normalizeMessageRow);
}

export async function getHistory(
  chatId: string,
  limit: number = 20,
  offset: number = 0,
): Promise<Array<Record<string, unknown>>> {
  const rows = await getSql().unsafe(ready().history, [chatId, limit, offset]);
  return (rows as Array<Record<string, unknown>>).map(normalizeMessageRow);
}

/**
 * Look up ONE stored message by its Telegram (chat_id, message_id).
 *
 * The reply-target resolver (lib/reply-context.ts) uses this as its last
 * resort, for a reply Telegram did not inline the body of. Returns null when
 * the chat has no such message — which is a real, reportable answer
 * ("UNRESOLVED"), not an error to swallow.
 */
export async function getMessageByMessageId(
  chatId: string,
  messageId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await getSql().unsafe(ready().byMessageId, [chatId, messageId]);
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? normalizeMessageRow(row) : null;
}

// ── Attachments ────────────────────────────────────────────────────────────

export async function insertAttachment(
  messageRowId: number,
  attachment: {
    kind: string;
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  },
): Promise<void> {
  await getSql().unsafe(ready().insertAttachment, [
    messageRowId,
    attachment.kind,
    attachment.file_id,
    attachment.file_unique_id ?? null,
    attachment.file_name ?? null,
    attachment.mime_type ?? null,
    attachment.file_size ?? null,
  ]);
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
 * file_id + local_path per message).
 *
 * ONE round trip for the whole page, via an array parameter. The previous
 * engine looped a lookup per row because its prepared statements were
 * fixed-arity and the calls were free; across a network they are not, so a
 * 20-row history page is one query instead of twenty.
 */
export async function attachmentsForRows(
  rowIds: number[],
): Promise<AttachmentRow[]> {
  const s = ready();
  // Coerce here, not at the boundary: this is what makes the joined-string
  // parameter below carry digits and nothing else.
  const ids = rowIds.map(Number).filter(Number.isFinite);
  if (ids.length === 0) return [];
  const rows = await getSql().unsafe(s.attachmentsForRow, [ids.join(",")]);
  return (rows as AttachmentRow[]).map(normalizeAttachment);
}

/** Same 64-bit-arrives-as-a-string rule as normalizeMessageRow, for the
 * attachment join: `message_row_id` is compared against a row id, and
 * `file_size` is rendered to the operator. */
function normalizeAttachment(row: AttachmentRow): AttachmentRow {
  const out: AttachmentRow & { file_size?: unknown } = {
    ...row,
    message_row_id: Number(row.message_row_id),
  };
  if (typeof out.file_size === "string") out.file_size = Number(out.file_size);
  return out;
}

/**
 * Newest attachment row for a Telegram file_id (or null if the file_id
 * was never stored — e.g. a caller passing an id from another bot).
 * Used by download_attachment to short-circuit to an existing
 * local_path before hitting the network.
 */
export async function findAttachmentByFileId(
  fileId: string,
): Promise<AttachmentRow | null> {
  const rows = await getSql().unsafe(ready().attachmentByFileId, [fileId]);
  const row = rows[0] as AttachmentRow | undefined;
  return row ? normalizeAttachment(row) : null;
}

/**
 * Record a completed download on the attachment row so later
 * download_attachment calls (and get_history/get_unread consumers) see
 * the local_path. Same UPDATE the background queue in attachments.ts
 * performs — kept here too so the on-demand path is equally durable.
 */
export async function markAttachmentDownloaded(
  messageRowId: number,
  fileId: string,
  localPath: string,
): Promise<void> {
  await getSql().unsafe(ready().markAttachmentDownloaded, [
    localPath,
    messageRowId,
    fileId,
  ]);
}

// ── Search & Context ──────────────────────────────────────────────────────

export async function searchMessages(
  query: string,
  chatId?: string,
  limit: number = 20,
): Promise<Array<Record<string, unknown>>> {
  const s = ready();
  const pattern = `%${query}%`;
  const rows = chatId
    ? await getSql().unsafe(s.searchChat, [chatId, pattern, limit])
    : await getSql().unsafe(s.searchAll, [pattern, limit]);
  return (rows as Array<Record<string, unknown>>).map(normalizeMessageRow);
}

export async function getConversationContext(
  chatId: string,
  maxMessages: number = 10,
): Promise<string> {
  const rows = (await getSql().unsafe(ready().contextChat, [
    chatId,
    maxMessages,
  ])) as Array<Record<string, unknown>>;
  // Reverse to chronological order (query is DESC)
  const chronological = [...rows].reverse();
  return chronological
    .map((r) => {
      const dir = r.direction === "inbound" ? "user" : "bot";
      const who = r.username ?? r.user_id ?? dir;
      const ts = r.telegram_ts ?? r.received_at ?? "";
      return `[${ts}] ${who} (${dir}): ${r.text ?? ""}`;
    })
    .join("\n");
}
