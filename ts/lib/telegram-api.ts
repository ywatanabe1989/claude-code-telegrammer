/**
 * Thin wrapper around the Telegram Bot API (raw fetch, no grammy).
 */

import { API_BASE, TOKEN, MAX_TEXT } from "./config.js";
import { appendSignature } from "./signature.js";
import { mkdirSync, readFileSync } from "fs";
import { join, basename, extname } from "path";

/**
 * Wall-clock bound for the STARTUP token check.
 *
 * MEASURED 2026-08-03. `getMeRaw()` is awaited at telegram-server.ts:222,
 * BEFORE `mcp.connect()` at :367 — so until Telegram answers, this MCP server
 * has not announced its tool list. That fetch was unbounded, so when the
 * network black-holes (packets dropped, no RST — an ordinary transient
 * WSL2/NAT/DNS hiccup) it did not fail fast: it sat in the kernel's TCP SYN
 * backoff. With tcp_syn_retries=6 that is 1+2+4+8+16+32+64 = 127s, measured at
 * 133.7 / 133.6 / 135.1 s across three trials against a black-holed address.
 *
 * Claude Code's MCP startup timeout is BELOW that (30s default; 120s as
 * configured on the fleet). So the client gave up ~14s before this server
 * would have recovered on its own — and the recovery was real, because
 * validateBotToken() treats a transport-level rejection as TRANSIENT and
 * proceeds to connect anyway. The server never errored and never crashed; it
 * was still inside this await when the client stopped waiting. The agent then
 * had NO telegram tools and no way to know: an absent MCP tool is
 * indistinguishable from an absent message, with no error to log.
 *
 * That is how scitex-hub silently lost the operator's inbound rail for hours
 * on 2026-08-03 while every health signal read green.
 *
 * 5s is far above a healthy call (measured 254-258ms warm, 805ms cold DNS+TLS)
 * and far below every MCP startup timeout, so a stall now lands in the
 * transient branch instead of outliving the client's patience.
 */
const STARTUP_FETCH_TIMEOUT_MS = 5000;

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

/**
 * Raw getMe that returns the PARSED Telegram JSON ({ok, result?, error_code?,
 * description?}) instead of tgApi()'s unwrapped `result`. tgApi() throws a
 * generic Error on ok:false that LOSES the error_code, so a caller cannot tell
 * an invalid-token 401/404 from a transient 429/5xx. Startup token validation
 * (lib/startup-validate.ts) needs that distinction, so this variant does NOT
 * throw on ok:false — it hands back the full envelope. It still REJECTS on a
 * transport-level fetch failure (DNS/connect/reset), which validateBotToken()
 * classifies as transient.
 */
export async function getMeRaw(): Promise<{
  ok: boolean;
  result?: { id?: number; username?: string; [k: string]: unknown };
  error_code?: number;
  description?: string;
}> {
  const res = await fetch(`${API_BASE}/getMe`, {
    method: "POST",
    // BOUNDED on purpose -- see STARTUP_FETCH_TIMEOUT_MS. An AbortSignal
    // rejection is a transport-level failure, which is exactly the case the
    // docstring above says validateBotToken() classifies as TRANSIENT, so a
    // stalled network now yields "could not check the token, carry on and
    // connect" in ~5s instead of holding the MCP handshake past the client's
    // timeout. No ordering changes: getMe still runs before acquireLock(), so
    // a known-bad token still never takes the lock.
    signal: AbortSignal.timeout(STARTUP_FETCH_TIMEOUT_MS),
  });
  return (await res.json()) as {
    ok: boolean;
    result?: { id?: number; username?: string; [k: string]: unknown };
    error_code?: number;
    description?: string;
  };
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
  // Sign BEFORE splitting: appendSignature is idempotent, and signing the
  // whole text first means the splitter naturally keeps the signature on
  // the tail chunk regardless of where the body cuts. This avoids the
  // "double-sign on a split message" failure mode the operator called out
  // (we never sign per-chunk).
  const signed = appendSignature(text);
  const chunks = splitText(signed);
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
  // Always attach a signed caption — even when no user caption was passed,
  // we want the agent-signature line to identify which bot sent the file.
  // appendSignature("") returns the bare signature; idempotent on re-send.
  formData.append("caption", appendSignature(caption ?? ""));

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

/**
 * Edit a message the bot previously sent. Applies the agent signature to
 * the new text so an edited message stays attributed to its sender — the
 * idempotent appendSignature avoids double-signing when the previous text
 * (which the agent might pass through unchanged) already carries it.
 */
export async function editMessageText(
  chatId: string,
  messageId: number,
  text: string,
): Promise<{ message_id: number }> {
  const signed = appendSignature(text);
  return tgApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: signed,
  });
}
