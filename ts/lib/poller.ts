/**
 * Telegram getUpdates long-polling loop with inbound message delivery.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { tgApi } from "./telegram-api.js";
import { isAllowed, loadAccess } from "./access.js";
import { log } from "./log.js";
import { HOST_NAME, PROJECT, AGENT_ID, BOT_TOKEN_HASH } from "./config.js";
import {
  saveInbound,
  saveOffset,
  loadOffset,
  insertAttachment,
} from "./store.js";
import { queueDownload } from "./attachments.js";

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

  // Check allowlist at startup — fail loud if empty
  const access = loadAccess();
  if (
    access.allowFrom.length === 0 &&
    Object.keys(access.groups).length === 0
  ) {
    log(
      "poller",
      "ERROR: allowlist is empty — all messages will be rejected. Set CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS or create access.json in CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR",
    );
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
        allowed_updates: ["message", "message_reaction"],
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

async function handleReaction(mcp: Server, update: any): Promise<void> {
  const reaction = update.message_reaction;
  if (!reaction?.user || !reaction?.new_reaction) return;

  const userId = String(reaction.user.id);
  const chatId = String(reaction.chat.id);
  const chatType = reaction.chat.type;

  if (!isAllowed(userId, chatId, chatType)) {
    log(
      "poller",
      `REJECTED: reaction from user ${userId} in chat ${chatId} — not in allowlist`,
    );
    return;
  }

  const emojis = reaction.new_reaction
    .filter((r: any) => r.type === "emoji" && r.emoji)
    .map((r: any) => r.emoji)
    .join("");

  if (!emojis) return;

  const ts = new Date((reaction.date ?? 0) * 1000).toISOString();
  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: String(reaction.message_id),
    user_id: userId,
    user: reaction.user.username ?? userId,
    ts,
    source: "telegram",
    type: "reaction",
  };

  const text = `(reaction: ${emojis} on message ${reaction.message_id})`;
  log("poller", `delivering reaction from ${userId} in ${chatId}`, { emojis });
  mcp
    .notification({
      method: "notifications/claude/channel",
      params: { content: text, meta },
    })
    .catch((err) => {
      log("poller", "failed to deliver reaction to Claude", {
        error: String(err),
      });
    });
}

async function handleUpdate(mcp: Server, update: any): Promise<void> {
  if (update.message_reaction) {
    await handleReaction(mcp, update);
    return;
  }

  const msg = update.message;
  if (!msg?.from) return;

  const userId = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const chatType = msg.chat.type;

  if (!isAllowed(userId, chatId, chatType)) {
    log(
      "poller",
      `REJECTED: message from user ${userId} in chat ${chatId} (type=${chatType}) — not in allowlist. Set CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS or create access.json`,
      { userId, chatId, chatType },
    );
    return;
  }

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
  const replyToMessageId = msg.reply_to_message
    ? String(msg.reply_to_message.message_id)
    : undefined;

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
      reply_to_message_id: replyToMessageId,
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
        queueDownload(rowId, obj.file_id, kind, chatId);
      } catch (err) {
        log("poller", "failed to insert attachment", {
          error: String(err),
          kind,
        });
      }
    }
  }

  // Ack: react with "received" after SQLite insert succeeds
  tgApi("setMessageReaction", {
    chat_id: chatId,
    message_id: msg.message_id,
    reaction: [{ type: "emoji", emoji: "\uD83D\uDCE9" }],
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
  if (replyToMessageId) {
    meta.reply_to_message_id = replyToMessageId;
  }

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
