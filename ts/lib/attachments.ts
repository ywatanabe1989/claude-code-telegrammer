/**
 * Background download queue for Telegram file attachments.
 * Rate-limited: max 1 download per 500ms.
 * On failure: log error, mark for retry on next restart (don't retry immediately).
 */

import { join } from "path";
import { mkdirSync } from "fs";
import { ATTACHMENT_DIR } from "./config.js";
import { markAttachmentDownloaded } from "./store.js";
import { getFile, downloadFile } from "./telegram-api.js";
import { log } from "./log.js";

interface QueueItem {
  messageRowId: number;
  fileId: string;
  kind: string;
  chatId: string;
}

const queue: QueueItem[] = [];
let processing = false;

// ── Public API ────────────────────────────────────────────────────────────

export function queueDownload(
  messageRowId: number,
  fileId: string,
  kind: string,
  chatId: string,
): void {
  queue.push({ messageRowId, fileId, kind, chatId });
  if (!processing) {
    void processQueue();
  }
}

/**
 * Immediately download a single file (bypasses queue).
 * Returns the local path on success.
 */
export async function downloadNow(
  fileId: string,
  chatId: string,
): Promise<string> {
  const { file_path } = await getFile(fileId);
  const now = new Date();
  const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const localDir = join(ATTACHMENT_DIR, chatId, monthDir);
  mkdirSync(localDir, { recursive: true });
  const localPath = await downloadFile(file_path, localDir);
  return localPath;
}

// ── Background loop ──────────────────────────────────────────────────────

async function processQueue(): Promise<void> {
  processing = true;
  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      const localPath = await downloadNow(item.fileId, item.chatId);

      // Record the completed download on the attachment row. This used to
      // open its own ad hoc database handle and re-spell the UPDATE by hand;
      // it now calls the store's own writer, so there is one statement to
      // keep correct instead of two that could drift.
      try {
        await markAttachmentDownloaded(
          item.messageRowId,
          item.fileId,
          localPath,
        );
      } catch (dbErr) {
        log("attachments", "failed to update the store after download", {
          error: String(dbErr),
          fileId: item.fileId,
        });
      }

      log("attachments", "downloaded", {
        fileId: item.fileId,
        localPath,
      });
    } catch (err) {
      log("attachments", "download failed (will retry on restart)", {
        error: String(err),
        fileId: item.fileId,
        kind: item.kind,
      });
    }

    // Rate limit: 500ms between downloads
    if (queue.length > 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  processing = false;
}
