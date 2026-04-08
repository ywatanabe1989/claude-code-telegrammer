/**
 * Thin wrapper around the Telegram Bot API (raw fetch, no grammy).
 */

import { API_BASE, TOKEN, MAX_TEXT } from "./config.js";
import { mkdirSync, readFileSync } from "fs";
import { join, basename, extname } from "path";

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

// ── File operations ─────────────────────────────────────────────────────────

export async function getFile(fileId: string): Promise<{ file_path: string }> {
  const result = await tgApi("getFile", { file_id: fileId });
  return { file_path: result.file_path };
}

export async function downloadFile(
  filePath: string,
  localDir: string,
  fileName?: string,
): Promise<string> {
  const url = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);
  }
  mkdirSync(localDir, { recursive: true });
  const name = fileName ?? basename(filePath);
  const dest = join(localDir, name);
  const buf = Buffer.from(await res.arrayBuffer());
  await Bun.write(dest, buf);
  return dest;
}

export async function sendDocument(
  chatId: string,
  filePath: string,
  caption?: string,
): Promise<number> {
  const fileBytes = readFileSync(filePath);
  const fileName = basename(filePath);

  // Determine mime type from extension
  const ext = extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".txt": "text/plain",
    ".json": "application/json",
    ".zip": "application/zip",
  };
  const mime = mimeMap[ext] ?? "application/octet-stream";

  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", new Blob([fileBytes], { type: mime }), fileName);
  if (caption) {
    formData.append("caption", caption);
  }

  const res = await fetch(`${API_BASE}/sendDocument`, {
    method: "POST",
    body: formData,
  });
  const json = (await res.json()) as any;
  if (!json.ok) {
    throw new Error(
      `Telegram API sendDocument failed: ${json.description ?? res.status}`,
    );
  }
  return json.result.message_id;
}
