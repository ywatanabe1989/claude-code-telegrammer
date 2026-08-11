/**
 * Handler bodies for the message-query MCP tools: get_history,
 * get_unread, download_attachment.
 *
 * Extracted from tools.ts (incident cct-inbound-images-20260707) for two
 * reasons: (1) tools.ts sits near the repo's 512-line .ts cap and these
 * handlers grew (attachments join, row_id download path); (2) exporting
 * the bodies makes them unit-testable without standing up an MCP server
 * — the download dependency is injectable so tests can prove the
 * local_path short-circuit never touches the network. Registration
 * (schemas + dispatch) stays in tools.ts.
 */

import { existsSync } from "fs";
import { assertAllowedChat } from "./access.js";
import {
  getHistory,
  getUnread,
  attachmentsForRows,
  findAttachmentByFileId,
  markAttachmentDownloaded,
  loadLastPollTs,
  loadCoverageGap,
  type AttachmentRow,
} from "./store.js";
import {
  buildCoverage,
  assertValidCoverage,
  type IngestionCoverage,
} from "./ingestion-coverage.js";
import { downloadNow } from "./attachments.js";
import { log } from "./log.js";

/** Shape of an MCP CallTool result (the subset these handlers produce). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function textResult(text: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

/**
 * Join stored attachments onto message rows: each row that has any gets
 * an `attachments` array ({message_row_id, kind, file_id, file_name,
 * mime_type, local_path, downloaded_at, chat_id}); rows without stay
 * untouched (no empty-array noise). This is how an agent maps an
 * inbound "(photo) [attachment …]" line back to a file_id / local_path
 * from the DB instead of digging through raw_json.
 */
export function withAttachments(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const ids = rows
    .map((r) => Number(r.id))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) return rows;
  const byRow = new Map<number, AttachmentRow[]>();
  for (const att of attachmentsForRows(ids)) {
    const list = byRow.get(att.message_row_id) ?? [];
    list.push(att);
    byRow.set(att.message_row_id, list);
  }
  if (byRow.size === 0) return rows;
  return rows.map((r) => {
    const list = byRow.get(Number(r.id));
    return list ? { ...r, attachments: list } : r;
  });
}

/**
 * Read the store's own statement about whether it can vouch for what it just
 * returned. Best-effort: if the coverage probe itself fails, the caller still
 * gets its messages, with the failure stated (never a silent "covered").
 */
export function currentCoverage(): IngestionCoverage {
  try {
    const gap = loadCoverageGap();
    const coverage = buildCoverage({
      lastPollTs: loadLastPollTs(),
      lastGapAt: gap?.at ?? null,
      lastGapMissedUpdates: gap?.missedUpdates ?? null,
    });
    assertValidCoverage(coverage);
    return coverage;
  } catch (err) {
    log("tools", "coverage probe failed", { error: String(err) });
    return {
      verdict: "unverifiable",
      lastPollTs: null,
      pollStaleMs: null,
      stalenessThresholdMs: 0,
      lastGapAt: null,
      lastGapMissedUpdates: null,
      reason:
        `The coverage probe itself failed (${String(err)}), so this store` +
        " cannot say whether the result below is complete. Treat an empty" +
        " result as UNKNOWN, not as 'nothing was sent'.",
    };
  }
}

/**
 * Every message read answers in ONE shape: `{coverage, count, messages}`.
 *
 * It used to answer with a bare array, which made `[]` mean both "the
 * operator said nothing" and "this store recorded nothing for that window" —
 * the exact ambiguity that let 8h35m of scitex-dev's conversation read as a
 * quiet inbox on 2026-08-10. The fleet restart protocol tells every agent to
 * check this tool and NOT to assume a quiet inbox means nothing was sent; the
 * tool now carries the evidence needed to honour that instruction.
 */
function messagesResult(rows: Array<Record<string, unknown>>): ToolResult {
  return jsonResult({
    coverage: currentCoverage(),
    count: rows.length,
    messages: withAttachments(rows),
  });
}

export function handleGetHistory(args: Record<string, unknown>): ToolResult {
  const chatId = args.chat_id as string;
  const limit = (args.limit as number) ?? 20;
  const offset = (args.offset as number) ?? 0;
  assertAllowedChat(chatId);
  return messagesResult(getHistory(chatId, limit, offset));
}

export function handleGetUnread(args: Record<string, unknown>): ToolResult {
  const chatId = args.chat_id as string | undefined;
  if (chatId) assertAllowedChat(chatId);
  return messagesResult(getUnread(chatId));
}

/**
 * download_attachment: accepts EITHER file_id OR row_id (the row_id from
 * the inbound <channel> meta / get_history — no raw_json digging).
 *
 * Resolution order:
 *   1. row_id → the message row's attachment record (clear error when
 *      the row has none — e.g. a plain-text message).
 *   2. file_id → the newest matching attachment record when one exists
 *      (an unknown file_id still downloads; it just can't short-circuit).
 * If the resolved record already has a local_path AND the file is still
 * on disk (auto-download completed, nothing pruned it), return that path
 * immediately — no network. Otherwise download and record the path so
 * the next call short-circuits.
 *
 * `download` is injectable for tests (defaults to the real downloadNow).
 */
export async function handleDownloadAttachment(
  args: Record<string, unknown>,
  download: (fileId: string, chatId: string) => Promise<string> = downloadNow,
): Promise<ToolResult> {
  const fileIdArg = args.file_id as string | undefined;
  const rowIdArg = args.row_id != null ? Number(args.row_id) : undefined;
  if (!fileIdArg && rowIdArg == null) {
    return textResult(
      "provide file_id or row_id (row_id comes from the inbound message's meta / get_history)",
      true,
    );
  }

  let att: AttachmentRow | null = null;
  if (rowIdArg != null) {
    att = attachmentsForRows([rowIdArg])[0] ?? null;
    if (!att) {
      return textResult(
        `no attachment recorded for row_id ${rowIdArg} — that message has no stored attachment. ` +
          "Check get_history for rows carrying an attachments array, or pass file_id directly.",
        true,
      );
    }
  } else if (fileIdArg) {
    att = findAttachmentByFileId(fileIdArg);
  }

  if (att?.local_path && existsSync(att.local_path)) {
    return textResult(`downloaded to: ${att.local_path}`);
  }

  const fileId = fileIdArg ?? att!.file_id;
  const chatId = (args.chat_id as string) ?? att?.chat_id ?? "unknown";
  const localPath = await download(fileId, chatId);
  if (att) {
    // Persist so the next call (and get_history consumers) short-circuit.
    // Log-only on failure: the download itself succeeded and the caller
    // must still get the path.
    try {
      markAttachmentDownloaded(att.message_row_id, att.file_id, localPath);
    } catch (err) {
      log("tools", "failed to record download on attachment row", {
        error: String(err),
        fileId: att.file_id,
      });
    }
  }
  return textResult(`downloaded to: ${localPath}`);
}
