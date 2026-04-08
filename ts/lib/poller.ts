/**
 * Telegram getUpdates long-polling loop with inbound message delivery.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { tgApi } from "./telegram-api.js";
import { isAllowed } from "./access.js";
import { log } from "./log.js";
import { HOST_NAME, PROJECT, AGENT_ID, BOT_TOKEN_HASH } from "./config.js";
import {
  saveInbound,
  saveOffset,
  loadOffset,
  insertAttachment,
} from "./store.js";

let updateOffset = 0;
let polling = true;

export function stopPolling(): void {
  polling = false;
}

export async function startPolling(mcp: Server): Promise<void> {
  log("poller", "starting getUpdates polling...");

  // Restore persisted offset from DB
  try {
    updateOffset = loadOffset();
    if (updateOffset > 0) {
      log("poller", `resumed from persisted offset ${updateOffset}`);
    }
  } catch (err) {
    log("poller", "failed to load offset from DB, starting from 0", {
      error: String(err),
    });
  }

  try {
    const me = await tgApi("getMe");
    log("poller", `polling as @${me.username}`);
  } catch (err) {
    log("poller", `getMe failed: ${err}`);
  }

  while (polling) {
    try {
      const updates = await tgApi("getUpdates", {
        offset: updateOffset,
        timeout: 30,
        allowed_updates: ["message"],
      });
      if (!Array.isArray(updates)) continue;
      for (const update of updates) {
        updateOffset = update.update_id + 1;
        try {
          await handleUpdate(mcp, update);
        } catch (err) {
          log("poller", `error handling update ${update.update_id}`, {
            error: String(err),
          });
        }
      }
      // Persist offset after each batch
      if (updates.length > 0) {
        try {
          saveOffset(updateOffset);
        } catch (err) {
          log("poller", "failed to persist offset", { error: String(err) });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("409")) {
        log("poller", "409 Conflict — another instance polling. Waiting 5s...");
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        log("poller", `getUpdates error: ${errMsg}. Retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}

async function handleUpdate(mcp: Server, update: any): Promise<void> {
  const msg = update.message;
  if (!msg?.from) return;

  const userId = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const chatType = msg.chat.type;

  if (!isAllowed(userId, chatId, chatType)) return;

  let text = msg.text ?? msg.caption ?? "";
  if (msg.photo) text = text || "(photo)";
  if (msg.document)
    text = text || `(document: ${msg.document.file_name ?? "file"})`;
  if (msg.voice) text = text || "(voice message)";
  if (msg.audio) text = text || "(audio)";
  if (msg.video) text = text || "(video)";
  if (msg.sticker) {
    const emoji = msg.sticker.emoji ? ` ${msg.sticker.emoji}` : "";
    text = text || `(sticker${emoji})`;
  }
  if (!text) return;

  const ts = new Date((msg.date ?? 0) * 1000).toISOString();

  // Persist to SQLite before acking
  let rowId: number | null = null;
  try {
    rowId = saveInbound({
      chat_id: chatId,
      message_id: String(msg.message_id),
      user_id: userId,
      username: msg.from.username ?? userId,
      text,
      telegram_ts: ts,
      host: HOST_NAME,
      project: PROJECT,
      agent_id: AGENT_ID,
      bot_token_hash: BOT_TOKEN_HASH,
      raw_json: JSON.stringify(update),
    });
  } catch (err) {
    log("poller", "failed to save inbound message to store", {
      error: String(err),
    });
  }

  // If saveInbound returned null, it's a duplicate — skip reaction + notification
  if (rowId === null) return;

  // Extract and persist attachments
  const attachments: Array<{ kind: string; obj: any }> = [
    { kind: "photo", obj: msg.photo?.[msg.photo.length - 1] },
    { kind: "document", obj: msg.document },
    { kind: "voice", obj: msg.voice },
    { kind: "audio", obj: msg.audio },
    { kind: "video", obj: msg.video },
  ];
  for (const { kind, obj } of attachments) {
    if (obj) {
      try {
        insertAttachment(rowId, {
          kind,
          file_id: obj.file_id,
          file_unique_id: obj.file_unique_id,
          file_name: obj.file_name,
          mime_type: obj.mime_type,
          file_size: obj.file_size,
        });
      } catch (err) {
        log("poller", "failed to insert attachment", {
          error: String(err),
          kind,
        });
      }
    }
  }

  // Ack: react with eyes only after SQLite insert succeeds
  tgApi("setMessageReaction", {
    chat_id: chatId,
    message_id: msg.message_id,
    reaction: [{ type: "emoji", emoji: "\uD83D\uDC40" }],
  }).catch(() => {});

  // Fire-and-forget typing indicator
  tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(
    () => {},
  );

  // Build meta for channel notification
  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: String(msg.message_id),
    row_id: String(rowId),
    user: msg.from.username ?? userId,
    user_id: userId,
    ts,
    source: "telegram",
  };

  // Add attachment metadata to channel notification
  for (const { kind, obj } of attachments) {
    if (obj) {
      meta.attachment_kind = kind;
      meta.attachment_file_id = obj.file_id;
      if (obj.file_name) meta.attachment_name = obj.file_name;
      if (obj.mime_type) meta.attachment_mime = obj.mime_type;
      break;
    }
  }

  log("poller", `delivering message from ${userId} in ${chatId}`, {
    text: text.slice(0, 50),
    row_id: rowId,
  });
  mcp
    .notification({
      method: "notifications/claude/channel",
      params: { content: text, meta },
    })
    .catch((err) => {
      log("poller", "failed to deliver inbound to Claude", {
        error: String(err),
      });
    });
}
