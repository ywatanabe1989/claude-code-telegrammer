/**
 * Telegram getUpdates long-polling loop with inbound message delivery.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { tgApi } from "./telegram-api.js";
import { isAllowed } from "./access.js";
import { log } from "./log.js";
import { saveInbound, markRead } from "./store.js";

let updateOffset = 0;
let polling = true;

export function stopPolling(): void {
  polling = false;
}

export async function startPolling(mcp: Server): Promise<void> {
  log("starting getUpdates polling...");
  try {
    const me = await tgApi("getMe");
    log(`polling as @${me.username}`);
  } catch (err) {
    log(`getMe failed: ${err}`);
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
          log(`error handling update ${update.update_id}: ${err}`);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("409")) {
        log("409 Conflict — another instance polling. Waiting 5s...");
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        log(`getUpdates error: ${errMsg}. Retrying in 3s...`);
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

  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: String(msg.message_id),
    user: msg.from.username ?? userId,
    user_id: userId,
    ts: new Date((msg.date ?? 0) * 1000).toISOString(),
  };

  // Attachment metadata
  const attachments: [string, any][] = [
    ["photo", msg.photo?.[msg.photo.length - 1]],
    ["document", msg.document],
    ["voice", msg.voice],
    ["audio", msg.audio],
    ["video", msg.video],
  ];
  for (const [kind, obj] of attachments) {
    if (obj) {
      meta.attachment_kind = kind;
      meta.attachment_file_id = obj.file_id;
      if (obj.file_name) meta.attachment_name = obj.file_name;
      if (obj.mime_type) meta.attachment_mime = obj.mime_type;
      break;
    }
  }

  meta.source = "telegram";

  // Persist to SQLite before acking
  const ts = new Date((msg.date ?? 0) * 1000).toISOString();
  let rowId: number | null = null;
  try {
    rowId = saveInbound({
      chat_id: chatId,
      message_id: String(msg.message_id),
      user_id: userId,
      username: msg.from.username ?? userId,
      text,
      timestamp: ts,
      metadata: meta,
    });
  } catch (err) {
    log(`failed to save inbound message to store: ${err}`);
  }

  // Ack: react with 👀 only after SQLite insert succeeds
  tgApi("setMessageReaction", {
    chat_id: chatId,
    message_id: msg.message_id,
    reaction: [{ type: "emoji", emoji: "👀" }],
  }).catch(() => {});

  // Fire-and-forget typing indicator
  tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(
    () => {},
  );

  log(`delivering message from ${userId} in ${chatId}: "${text.slice(0, 50)}"`);
  mcp
    .notification({
      method: "notifications/claude/channel",
      params: { content: text, meta },
    })
    .catch((err) => {
      log(`failed to deliver inbound to Claude: ${err}`);
    });
}
