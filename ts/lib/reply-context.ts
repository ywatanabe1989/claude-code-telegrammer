/**
 * Reply-context extraction + rendering.
 *
 * WHY THIS EXISTS (operator incident 2026-08-11, message 8303 → 8293):
 * the operator replied to one of the BOT's messages with a single letter,
 * "A". The poller captured everything — the DB row carried
 * `reply_to_message_id = "8293"` AND the complete `reply_to_message` object
 * (416 chars of it) inside `raw_json` — but the block delivered into the
 * agent session was:
 *
 *     <channel source="cct" chat_id="…" message_id="…" row_id="…"
 *              user="…" user_id="…" ts="…">
 *     A
 *
 * No reply reference at all. The agent mapped "A" onto the wrong question
 * and started answering about a completely different decision. The
 * information existed one layer down and never crossed the boundary.
 *
 * TWO seams dropped it, and both are fixed:
 *
 *   1. lib/wake.ts::wakeText builds the <channel> envelope from a HARDCODED
 *      attribute list (source, chat_id, message_id, row_id, user, user_id).
 *      handle-update.ts had been setting `meta.reply_to_message_id` since
 *      forever — our own renderer threw it away. That list now includes it.
 *
 *   2. On the interactive-CLI path the Claude Code harness renders only its
 *      own whitelist of meta keys, so meta alone can never be trusted to
 *      arrive (the exact trap documented on `attachmentDescriptor` in
 *      forward.ts, live-verified 2026-07-07 when a real photo arrived as a
 *      bare "(photo)"). The CONTENT string is always rendered and is also
 *      the only payload the /v1/turn wake POST carries — so the reference
 *      AND the excerpt ride there, via `replyDescriptor`.
 *
 * A bare id would have been an improvement but not a fix: it forces the
 * agent to go and fetch history mid-conversation, the same round-trip an
 * opaque "#NNN" forces. The excerpt makes the common case answerable
 * without a second lookup.
 */

import { mediaPlaceholders } from "./forward.js";

/**
 * Maximum excerpt length, in Unicode code points.
 *
 * Chosen from the real corpus, not from taste. Over the 346 messages in the
 * live store on 2026-08-11:
 *
 *     inbound  (operator): n=138  median  66  p95 254  max 389
 *     outbound (bot)     : n=208  median 369  p95 484  max 509
 *
 * 512 sits just above the observed maximum (509), so every reply target in
 * the real corpus arrives COMPLETE and truncation never fires in practice —
 * the excerpt is a cap for the pathological case, not a routine amputation.
 * The bot's own messages cluster near 500 because they are written to be
 * read on a phone, and those are the messages the operator replies to, so
 * cutting below ~500 would have truncated the median bot message: exactly
 * the reply targets this feature exists to explain.
 *
 * The ceiling still matters: Telegram permits 4096 (config.MAX_TEXT), so an
 * unbounded excerpt could add 4096 characters to every delivered line. 512
 * caps that at one eighth, which is affordable per message.
 */
export const REPLY_EXCERPT_MAX = 512;

/** How the excerpt was obtained — the "no reply" vs "unresolved reply" axis. */
export type ReplyResolution =
  | "update" // Telegram's own reply_to_message carried the text
  | "quote" // the operator selected a FRAGMENT (Bot API 7.0 `quote`)
  | "store" // recovered from our local message DB by message_id
  | "unavailable"; // known target, no text anywhere — say so, never omit

export interface ReplyContext {
  /** The replied-to message's Telegram message_id. */
  message_id: string;
  /** Rendered sender label ("bot:@Foo", "@alice"), when known. */
  from?: string;
  /** One-line, whitespace-collapsed, length-capped excerpt. */
  excerpt?: string;
  /** Original length in code points — present only when truncated. */
  full_length?: number;
  truncated: boolean;
  resolution: ReplyResolution;
}

/** Code-point-safe prefix — never splits a surrogate pair or an emoji. */
function clip(text: string, max: number): { text: string; truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= max) return { text, truncated: false };
  return { text: points.slice(0, max).join(""), truncated: true };
}

/**
 * Collapse every whitespace run (newlines included) to a single space.
 *
 * The descriptor is ONE line, deterministic and greppable, exactly like
 * `attachmentDescriptor`. The replied-to message is routinely multi-line
 * (the real 8293 target was a five-item numbered list); interpolating it
 * raw would splatter the envelope across a dozen lines and make the
 * boundary between "quoted context" and "what the operator actually said"
 * impossible to see.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Escape the excerpt for embedding in a `text="…"` field.
 *
 * The excerpt is UNTRUSTED text (it is whatever was in the replied-to
 * message). Escaping backslash + double-quote means it cannot terminate its
 * own quoted field, so it cannot forge a trailing `text="…"` / `[attachment
 * …]` field or otherwise restructure the descriptor. `<channel>` envelope
 * tokens are NOT handled here on purpose — the whole delivered string is run
 * through sanitize.ts::neutralizeChannelEnvelope downstream (wake.ts::wakeText
 * and the notify-relay payload both do it), and doing it twice would
 * double-escape.
 */
function quoteField(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** "bot:@ProjBot" / "@alice" / "Yusuke Watanabe" — undefined when unknown. */
function senderLabel(from: any): string | undefined {
  if (!from || typeof from !== "object") return undefined;
  const name =
    (typeof from.username === "string" && from.username && `@${from.username}`) ||
    [from.first_name, from.last_name]
      .filter((v) => typeof v === "string" && v)
      .join(" ") ||
    (from.id !== undefined ? String(from.id) : "");
  if (!name) return undefined;
  return from.is_bot ? `bot:${name}` : name;
}

/**
 * Extract reply context from a raw Telegram Message.
 *
 * Returns null when the message is NOT a reply — the "no reply" case, which
 * must stay distinguishable from "a reply I could not resolve" (that one
 * comes back with resolution="unavailable" and is rendered explicitly).
 *
 * Resolution order:
 *
 *   1. `msg.quote` (Bot API >=7.0) — the operator selected a SPECIFIC
 *      fragment of the target. That selection is the strongest possible
 *      statement of what he meant, so it wins over the full text.
 *   2. `msg.reply_to_message.text` / `.caption` — the ordinary path, and
 *      the one that covers a reply to a message the BOT sent (the common
 *      case: Telegram embeds the bot's own message verbatim, which is how
 *      all 416 characters of 8293 were sitting in row 333's raw_json).
 *   3. media placeholders — target is a photo/document/voice with no
 *      caption; "(photo)" is the honest excerpt.
 *   4. `lookup` — our local message DB, by message_id. Reaches targets
 *      Telegram did not inline (a reply carried only as `external_reply`,
 *      whose origin names a message id but ships no text).
 *   5. nothing worked → resolution="unavailable".
 *
 * `lookup` is injected rather than imported so this module stays free of
 * store.ts (and so the store-backed path can be exercised against a real
 * SQLite store instead of a stub).
 */
export function parseReplyContext(
  msg: any,
  lookup?: (messageId: string) => string | null | undefined,
): ReplyContext | null {
  if (!msg || typeof msg !== "object") return null;

  const target = msg.reply_to_message;
  const external = msg.external_reply;

  let messageId: string | undefined;
  if (target?.message_id !== undefined) {
    messageId = String(target.message_id);
  } else if (external?.origin?.message_id !== undefined) {
    // Reply to a message in ANOTHER chat: Telegram ships provenance but no
    // body. Still a reply — surface it and let resolution say what we know.
    messageId = String(external.origin.message_id);
  }
  if (!messageId) return null;

  const from = senderLabel(target?.from);

  const build = (
    raw: string,
    resolution: ReplyResolution,
  ): ReplyContext => {
    const flat = oneLine(raw);
    const { text, truncated } = clip(flat, REPLY_EXCERPT_MAX);
    return {
      message_id: messageId as string,
      from,
      excerpt: text,
      truncated,
      ...(truncated ? { full_length: Array.from(flat).length } : {}),
      resolution,
    };
  };

  // 1. An explicit quoted fragment beats the whole message.
  const quoted = msg.quote?.text;
  if (typeof quoted === "string" && quoted.trim()) return build(quoted, "quote");

  // 2. The inlined target's own body.
  const body = target?.text ?? target?.caption;
  if (typeof body === "string" && body.trim()) return build(body, "update");

  // 3. Media with no caption — the placeholder IS the content.
  if (target) {
    const placeholders = mediaPlaceholders(target).join(" ");
    if (placeholders) return build(placeholders, "update");
  }

  // 4. Our own history.
  const recovered = lookup?.(messageId);
  if (typeof recovered === "string" && recovered.trim())
    return build(recovered, "store");

  // 5. Known target, no text anywhere. NEVER omit the field — "no reply"
  //    and "reply I could not resolve" must not look identical.
  return {
    message_id: messageId,
    from,
    truncated: false,
    resolution: "unavailable",
  };
}

/**
 * Render the one-line descriptor prepended to the DELIVERED content.
 *
 * Resolved:
 *   [in-reply-to message_id=8293 from=bot:@ProjBot text="1. あなたの…"]
 *
 * Operator quoted a fragment (`quote=` instead of `text=`, so the agent
 * knows it is reading a SELECTION, not the whole message):
 *   [in-reply-to message_id=8293 from=@alice quote="案 B: バイト単位の同一性"]
 *
 * Truncated (marked, with the original size and the way to get the rest):
 *   [in-reply-to message_id=8293 text="…" truncated_from=1024 — call
 *    get_history(chat_id) for the full text]
 *
 * Unresolved (explicit, never silent):
 *   [in-reply-to message_id=8293 text=UNRESOLVED — not in this chat's local
 *    history; call get_history(chat_id) or search_messages to look it up]
 *
 * Prepended rather than appended (the attachment descriptor is appended)
 * because reply context FRAMES the message: reading "[in-reply-to …] A" in
 * that order is how a human reads a threaded reply, and a one-word body
 * after 500 characters of quoted context is easy to miss the other way
 * round.
 */
export function replyDescriptor(ctx: ReplyContext): string {
  const parts = [`message_id=${ctx.message_id}`];
  if (ctx.from) parts.push(`from=${ctx.from}`);

  if (ctx.resolution === "unavailable") {
    parts.push("text=UNRESOLVED");
    return `[in-reply-to ${parts.join(" ")} — not in this chat's local history; call get_history(chat_id) or search_messages to look it up]`;
  }

  const key = ctx.resolution === "quote" ? "quote" : "text";
  parts.push(`${key}="${quoteField(ctx.excerpt ?? "")}${ctx.truncated ? "…" : ""}"`);

  if (ctx.truncated) {
    parts.push(`truncated_from=${ctx.full_length}`);
    return `[in-reply-to ${parts.join(" ")} — call get_history(chat_id) for the full text]`;
  }
  return `[in-reply-to ${parts.join(" ")}]`;
}
