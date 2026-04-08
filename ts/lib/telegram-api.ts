/**
 * Thin wrapper around the Telegram Bot API (raw fetch, no grammy).
 */

import { API_BASE, MAX_TEXT } from "./config.js";

export async function tgApi(
  method: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as any;
  if (!json.ok) {
    throw new Error(
      `Telegram API ${method} failed: ${json.description ?? res.status}`,
    );
  }
  return json.result;
}

export function splitText(text: string, limit: number = MAX_TEXT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const para = rest.lastIndexOf("\n\n", limit);
    const line = rest.lastIndexOf("\n", limit);
    const space = rest.lastIndexOf(" ", limit);
    const cut =
      para > limit / 2
        ? para
        : line > limit / 2
          ? line
          : space > 0
            ? space
            : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export async function sendMessage(
  chatId: string,
  text: string,
  replyTo?: number,
): Promise<number> {
  const chunks = splitText(text);
  let lastMsgId = 0;
  for (let i = 0; i < chunks.length; i++) {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
    };
    if (replyTo && i === 0) {
      params.reply_parameters = { message_id: replyTo };
    }
    const result = await tgApi("sendMessage", params);
    lastMsgId = result.message_id;
  }
  return lastMsgId;
}
