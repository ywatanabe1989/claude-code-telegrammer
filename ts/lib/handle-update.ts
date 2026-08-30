/**
 * Per-update inbound handling for the getUpdates poller.
 *
 * Extracted from poller.ts (durability fix PR-B, 2026-07). The only
 * behavioural change over the old in-poller version is that handleUpdate
 * now RETURNS an UpdateStatus so the polling loop can distinguish a
 * successfully-persisted / duplicate / non-persisting update (all safe to
 * advance the getUpdates offset past) from a REAL persist failure
 * (saveInbound threw → must NOT advance, so Telegram redelivers it).
 */

import { tgApi } from "./telegram-api.js";
import { isAllowed } from "./access.js";
import { log } from "./log.js";
import {
  HOST_NAME,
  PROJECT,
  AGENT_ID,
  BOT_TOKEN_HASH,
  CHANNEL_SOURCE,
} from "./config.js";
import {
  saveInbound,
  insertAttachment,
  getMessageByMessageId,
} from "./store.js";
import { queueDownload } from "./attachments.js";
import {
  markDelivered,
  markReceived,
  markDone,
  markFailed,
} from "./receipts.js";
import { wakeTurn, wakeEnabled } from "./wake.js";
import {
  parseForward,
  buildInboundText,
  attachmentDescriptor,
} from "./forward.js";
import {
  parseReplyContext,
  replyDescriptor,
  replyTargetMessageId,
} from "./reply-context.js";
import { sendLoudFailReply } from "./loudfail.js";
import { recordWakeFailure, recordWakeSuccess } from "./wake-health.js";
import { neutralizeChannelEnvelope } from "./sanitize.js";
import {
  savePendingNotification,
  isNotificationPending,
} from "./notify-relay.js";

/**
 * Outcome of handling ONE inbound update, consumed by the poller batch
 * loop (poller-batch.ts) to decide whether the persisted getUpdates
 * offset may advance past it:
 *
 *   "ok"           — persisted, OR a non-persisting update (reaction,
 *                    allowlist-rejected, no-text). Safe to advance.
 *   "duplicate"    — saveInbound returned null = already stored. The
 *                    message is durably in the DB, so safe to advance.
 *   "persistError" — saveInbound THREW. The message is NOT in the DB;
 *                    the offset must NOT advance past it so Telegram
 *                    redelivers it on the next poll (Telegram retains
 *                    undelivered updates ~24h).
 *
 * ONLY saveInbound throwing is a persistError. A null return (duplicate)
 * is explicitly NOT — the row is already durable.
 */
export type UpdateStatus = "ok" | "duplicate" | "persistError";

export async function handleReaction(update: any): Promise<void> {
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
    source: CHANNEL_SOURCE,
    type: "reaction",
  };

  const text = `(reaction: ${emojis} on message ${reaction.message_id})`;
  log("poller", `delivering reaction from ${userId} in ${chatId}`, { emojis });

  // Post-split (incident incident-cct-inbound-dies-silently-with-mcp-
  // server-20260711): this runs in the standalone poller process (ts/
  // telegram-poller.ts), which has no mcp/Server object — the
  // `mcp.notification(...)` push this used to do is categorically
  // impossible from a separate OS process (it required being co-located
  // with the live MCP stdio transport). Mirror how a regular inbound
  // message reaches an idle/SDK-runner agent: the /v1/turn wake POST
  // (mcp-independent, plain HTTP — see lib/wake.ts). Reactions were
  // already a best-effort, non-persisted, fire-and-forget signal (no
  // saveInbound row, no receipts) — reusing wakeTurn preserves that exact
  // risk profile, it just swaps the transport.
  //
  // Deliberately NOT routed through lib/loudfail.ts's operator-facing
  // broadcastSystemAlert: a reaction is agent-directed context
  // (informational, "the user reacted"), not an operator alarm — echoing
  // "(reaction: 👍 on message 123)" back to the operator as a brand-new
  // Telegram message would be confusing self-referential noise, not a fix.
  if (wakeEnabled()) {
    void wakeTurn(text, meta);
  } else {
    // Interactive-CLI (no TURN_URL): there is no live-push path left once
    // the poller is a separate process from the MCP stdio transport, and
    // reactions have no durable store to fall back on either (never
    // persisted). Known, accepted consequence of decoupling the poller
    // from the MCP server — logged (never silent), never guessed at
    // further. See docs/architecture.md.
    log(
      "poller",
      "reaction not delivered — wake disabled and no mcp connection available from the standalone poller (interactive-CLI mode)",
    );
  }
}

export async function handleUpdate(update: any): Promise<UpdateStatus> {
  // Reactions have no saveInbound persistence — always "ok", always
  // advance (PR-B requirement 4).
  if (update.message_reaction) {
    await handleReaction(update);
    return "ok";
  }

  const msg = update.message;
  if (!msg?.from) return "ok";

  const userId = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const chatType = msg.chat.type;

  if (!isAllowed(userId, chatId, chatType)) {
    log(
      "poller",
      `REJECTED: message from user ${userId} in chat ${chatId} (type=${chatType}) — not in allowlist. Set CLAUDE_CODE_TELEGRAMMER_ALLOWED_USERS or create access.json`,
      { userId, chatId, chatType },
    );
    return "ok";
  }

  // Build the text the agent sees. buildInboundText handles:
  //   - text vs caption (for media messages with a caption)
  //   - placeholder strings for media without a caption ("(photo)" etc.)
  //   - prepending "[forwarded from <whom>, <when>]" when forwarded
  // Caption + attachment file_id survive together; forward banner sits
  // on top of any caption/placeholder so provenance is always visible.
  const text = buildInboundText(msg);
  if (!text) return "ok";

  // Capture forward metadata (Bot API >=7.0 forward_origin OR legacy
  // forward_from / forward_from_chat / forward_sender_name). null when
  // the message is not a forward.
  const forwardInfo = parseForward(msg);
  const forwardJson = forwardInfo ? JSON.stringify(forwardInfo) : undefined;

  const ts = new Date((msg.date ?? 0) * 1000).toISOString();
  const replyToMessageId = msg.reply_to_message
    ? String(msg.reply_to_message.message_id)
    : undefined;

  // Persist to the store before acking. A THROW here is a real persist
  // failure — return "persistError" so the poller does NOT advance the
  // getUpdates offset past this update (Telegram will redeliver it).
  let rowId: number | null = null;
  try {
    rowId = await saveInbound({
      chat_id: chatId,
      message_id: String(msg.message_id),
      user_id: userId,
      username: msg.from.username ?? userId,
      text,
      telegram_ts: ts,
      reply_to_message_id: replyToMessageId,
      forward_json: forwardJson,
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
    return "persistError";
  }

  // saveInbound returned null → DUPLICATE (already durably stored). Skip
  // reaction + notification, but it IS safe to advance the offset.
  if (rowId === null) return "duplicate";

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
        await insertAttachment(rowId, {
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

  // Stage 1 + Stage 2 receipts fire UNCONDITIONALLY here (#41,
  // operator 2026-06-07):
  //
  //   ⚡ markDelivered — relay received + persisted the message.
  //   👀 markReceived  — relay accepted ownership and is now driving
  //                      delivery (MCP notification + wake POST).
  //
  // Previous behaviour gated 👀 on either MCP-notification ack OR
  // wakeTurn 2xx. That meant a dead/down agent never reached 👀 — the
  // operator confirmed in 2026-06-07 they prefer "👀 means the BRIDGE
  // has the message" over "👀 means the AGENT has the message",
  // because the absence of 👀 in the old contract was indistinguishable
  // from a poller crash / 409 loss / silent drop (the operator's
  // single most painful failure mode this week).
  //
  // The advancing reaction sequence is now:
  //
  //     ⚡ → 👀 → ✅  (live agent, /v1/turn ok)
  //     ⚡ → 👀 → ❌  (down agent, /v1/turn non-2xx or unreachable)
  //     ⚡ → 👀       (interactive CLI, no TURN_URL — no further stages)
  //
  // The operator can still tell "agent down" from "agent live": the
  // FINAL state is ❌ vs ✅. The intermediate 👀 reassures them the
  // bridge itself is alive. The "no reaction" state can now only mean
  // the poller is dead (no PID claim on the token, can't issue a
  // setMessageReaction) — which together with the #37 newest-wins
  // takeover protocol means "silence == infra problem", never a logic
  // problem in the bridge.
  //
  // Both calls are idempotent (per-(chat, msg, stage) dedupe in
  // receipts.ts) and best-effort (errors logged at warning, never
  // thrown). Safe to fire eagerly.
  void markDelivered(chatId, String(msg.message_id));
  void markReceived(chatId, String(msg.message_id));

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
    source: CHANNEL_SOURCE,
  };
  if (replyToMessageId) {
    meta.reply_to_message_id = replyToMessageId;
  }

  // Forward provenance — exposed on meta so downstream consumers
  // (audit, signature, /v1/turn payload) can distinguish a forwarded
  // message from one the user typed themselves. The banner is already
  // prepended to text; these fields make the structured metadata
  // available without re-parsing.
  if (forwardInfo) {
    meta.forward_kind = forwardInfo.kind;
    meta.forward_from = forwardInfo.from_name;
    meta.forward_date = forwardInfo.date_iso;
    if (forwardInfo.from_id) meta.forward_from_id = forwardInfo.from_id;
    if (forwardInfo.from_username)
      meta.forward_from_username = forwardInfo.from_username;
    if (forwardInfo.original_message_id)
      meta.forward_original_message_id = forwardInfo.original_message_id;
    if (forwardInfo.signature) meta.forward_signature = forwardInfo.signature;
  }

  // Add attachment metadata to channel notification AND append the
  // bracketed descriptor to the DELIVERED content line (incident
  // cct-inbound-images-20260707). The meta keys are kept for
  // forward-compat, but the Claude Code harness renders only a
  // whitelist of meta keys into the <channel> tag — arbitrary meta is
  // dropped (live-verified: a real photo rendered as bare "(photo)"
  // despite attachment_file_id in meta). Only the content string is
  // always rendered — and it is ALSO the only payload the /v1/turn
  // wake POST carries — so kind + file_id + the retrieval instruction
  // must ride there. One attachment per message is the current model
  // (see the attachments array above), hence the `break`.
  let deliveredText = text;
  for (const { kind, obj } of attachments) {
    if (obj) {
      meta.attachment_kind = kind;
      meta.attachment_file_id = obj.file_id;
      if (obj.file_name) meta.attachment_name = obj.file_name;
      if (obj.mime_type) meta.attachment_mime = obj.mime_type;
      deliveredText = `${text} ${attachmentDescriptor(kind, obj)}`;
      break;
    }
  }

  // REPLY CONTEXT (operator incident 2026-08-11, message 8303 → 8293).
  //
  // A reply whose target never reaches the agent is worse than no context:
  // the operator's one-letter "A" was mapped onto an entirely different
  // question. meta.reply_to_message_id above is necessary but NOT sufficient
  // — on the interactive-CLI path the harness renders only its own whitelist
  // of meta keys, so the CONTENT string is the only carrier guaranteed to
  // arrive (the same reason attachmentDescriptor rides in the content).
  //
  // Prepended, not appended: the context FRAMES the body, and a one-word
  // body is easy to lose after a long quotation.
  //
  // The store lookup is the last resort inside parseReplyContext — used only
  // when Telegram did not inline the target's body — and it must never be
  // able to break delivery, hence the swallow-and-log.
  //
  // The lookup is resolved BEFORE parseReplyContext runs, because that
  // function is pure and synchronous and must stay that way — it is the piece
  // with the interesting branching, and the tests that pin its behaviour
  // exercise it with a plain function. So the one row it might ask for is
  // fetched here and handed over as an already-resolved value.
  const replyTargetId = replyTargetMessageId(msg);
  let replyTargetText: string | null = null;
  if (replyTargetId !== null) {
    try {
      const row = await getMessageByMessageId(chatId, replyTargetId);
      replyTargetText = typeof row?.text === "string" ? row.text : null;
    } catch (err) {
      log("poller", "reply-target lookup failed", { error: String(err) });
    }
  }
  const replyCtx = parseReplyContext(msg, () => replyTargetText);
  if (replyCtx) {
    // Also covers the external_reply case, where the id comes from the
    // reply's ORIGIN rather than from an inlined reply_to_message and so was
    // never seen by the replyToMessageId assignment above.
    meta.reply_to_message_id = replyCtx.message_id;
    meta.reply_to_resolution = replyCtx.resolution;
    deliveredText = `${replyDescriptor(replyCtx)}\n${deliveredText}`;
  }

  log("poller", `delivering message from ${userId} in ${chatId}`, {
    text: text.slice(0, 50),
    row_id: rowId,
  });

  // Notification path — renders <channel> in an ACTIVE turn (interactive
  // Claude Code CLI). Does NOT advance an IDLE SDK-runner session. The
  // 👀 receipt has already fired above; the notification ack is no
  // longer the trigger (it never was a reliable signal in SDK-runner
  // mode anyway, since a dead agent's MCP server can still ack).
  //
  // GATED on !wakeEnabled(): when TURN_URL is set (sac TUI + SDK agents),
  // the /v1/turn wake POST below is the SINGLE delivery — it advances an
  // idle session, and once the session is active this channel notification
  // would ALSO render, DOUBLE-delivering the same message (the "sent twice"
  // the operator reported, 2026-06-18), so the notification is dropped. Both
  // paths now carry source=CHANNEL_SOURCE ("claude-code-telegrammer"), so the
  // attribution is identical either way — every inbound stimulus names the
  // exact channel that delivered it, never the generic platform "telegram".
  // Interactive CLI (no TURN_URL) keeps the notification — its live event
  // loop surfaces it, and there is no wake to duplicate.
  if (!wakeEnabled()) {
    // Post-split (incident incident-cct-inbound-dies-silently-with-mcp-
    // server-20260711): this handler now runs in the standalone poller
    // process (ts/telegram-poller.ts), which has no mcp/Server object — a
    // DIRECT `mcp.notification(...)` call requires being co-located with
    // the live MCP stdio transport, impossible from a separate OS process.
    // Adversarial-review finding #3: rather than leaving this a documented
    // gap, the payload is persisted on the message's own row
    // (messages.pending_notification) and relayed by the MCP-server
    // process itself — see lib/notify-relay.ts for the full cross-process
    // design (mirrors lib/wake-health.ts's own pattern). The MCP server
    // polls for pending rows (default every 1s) and calls
    // mcp.notification() when it finds one, so the interactive-CLI session
    // still sees inbound messages live — with a short relay delay instead
    // of an immediate push, the necessary cost of crossing a process
    // boundary via disk instead of a function call.
    await savePendingNotification(rowId, {
      content: neutralizeChannelEnvelope(deliveredText),
      meta,
    });
  }

  // Wake-on-push — when CLAUDE_CODE_TELEGRAMMER_TURN_URL is set
  // (SDK-runner agents), POST the message to the agent's own /v1/turn.
  // The outcome advances the reaction past 👀 to the FINAL stage:
  //
  //   wakeTurn result.ok=true  → ✅ done   (stage 3)
  //   wakeTurn result.ok=false → ❌ failed (stage 4) + LOUD-FAIL REPLY (#14)
  //
  // Under current scitex-agent-container, sac /v1/turn is case (B):
  // the POST returns 2xx only AFTER the turn completes. So ok=true is
  // simultaneously "agent received" and "agent finished" — we advance
  // straight from 👀 (already fired unconditionally above per #41) to
  // ✅. This sequence is forward-compatible if sac ever splits the
  // signals (enqueue-ack vs completed-turn): an explicit
  // "agent received" stage can be reintroduced between 👀 and ✅
  // without re-architecting.
  //
  // A dead / stopped agent (connection refused, timeout, 401, any non-
  // 2xx) yields ok=false; we set ❌ AND post a loud-fail reply to the
  // operator (#14, 2026-06-07):
  //
  //   "⚠️ <agent_id> unavailable: <reason> — retry <when>"
  //
  // The wakeTurn return shape carries a categorised reason (HTTP status,
  // ECONNREFUSED, timeout, quota cap, …) so the operator knows WHY the
  // agent is down without sshing into the host. Sent via
  // tgApi("sendMessage") with reply_parameters pointing back to the
  // inbound message so the thread stays coherent. Dedup at the
  // loudfail.ts layer guards against double-send on any future retry
  // path; suppressible via the
  // CLAUDE_CODE_TELEGRAMMER_LOUD_FAIL=0 env kill-switch (the
  // ❌ reaction still fires regardless — only the text reply is gated).
  //
  // The pre-#41 operator saw ⚡ → ❌ and never 👀. Post-#41 they see
  // ⚡ → 👀 → ❌; the FINAL state ❌ + the loud-fail reply text answer
  // both "is the bridge alive?" (yes, 👀 fired) and "why didn't the
  // agent reply?" (the categorised reason).
  if (wakeEnabled()) {
    void wakeTurn(deliveredText, meta).then(async (result) => {
      if (result.ok) {
        await recordWakeSuccess();
        void markDone(chatId, String(msg.message_id));
      } else {
        await recordWakeFailure(result.category, result.reason);

        // FALLBACK (incident-cct-operator-messages-not-arriving-20260714).
        //
        // The wake POST goes to sac's a2a sidecar. Until now a failed wake
        // ended right here: the message was marked ❌, the operator got a
        // loud-fail, and the message itself was DROPPED — the getUpdates
        // offset had already advanced, so nothing would ever redeliver it and
        // he had to notice and resend by hand. sac's sidecar is therefore a
        // single point of failure on the operator's ONLY channel to the fleet.
        //
        // Persisting the payload here hands it to the notify relay in the MCP
        // server process (lib/notify-relay.ts), which reaches an attached
        // session over the MCP stdio transport WITHOUT going through sac. The
        // two paths fail independently, which is the whole point. If the MCP
        // server is also down the row simply stays pending and the relay
        // drains it on its next tick, so the message survives rather than
        // evaporating.
        //
        // Only on FAILURE — never on the ok path. A successful wake must not
        // also queue a notification or the operator gets the message twice
        // (the "sent twice" he reported 2026-06-18, which is exactly why the
        // notification above is gated on !wakeEnabled()).
        await savePendingNotification(rowId, {
          content: neutralizeChannelEnvelope(deliveredText),
          meta,
        });

        // Let the independent notify-relay path have a chance to deliver
        // before we alarm the operator — it almost always wins.
        setTimeout(() => {
          void isNotificationPending(rowId).then((stillPending) => {
            if (!stillPending) return;
            void markFailed(chatId, String(msg.message_id));
            void sendLoudFailReply(chatId, Number(msg.message_id), result);
          });
        }, 15000);
      }
    });
  }

  return "ok";
}
