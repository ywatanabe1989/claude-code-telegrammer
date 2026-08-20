/**
 * Thin wrapper around the Telegram Bot API (raw fetch, no grammy).
 */

import { API_BASE, FILE_BASE, MAX_TEXT } from "./config.js";
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

/** The `ok:false` envelope Telegram returns on every API failure. */
export interface TelegramErrorEnvelope {
  ok: boolean;
  error_code?: number;
  description?: string;
}

/**
 * A Telegram API failure that KEEPS its envelope.
 *
 * This used to be a bare `new Error("Telegram API <m> failed: <description>")`,
 * which threw away `error_code` — and since Telegram always sends a
 * description, the numeric code never appeared in the message either. Callers
 * were left pattern-matching prose to recover a number the response had
 * handed us and we dropped.
 *
 * That cost scitex-hub a month of inbound Telegram. The poll loop branched on
 * `errMsg.includes("409")`; a real 409 arrives as
 * `description: "Conflict: terminated by other getUpdates request…"` with no
 * digits, so the conflict branch — including its operator alert — was
 * unreachable in production while the log filled with 161 conflicts. See
 * test/conflict-classification.test.ts for the measured outage.
 *
 * Every signal is now its own named, three-valued field: `errorCode` is the
 * number, or `undefined` for "the envelope did not say" — never a stand-in
 * value that some caller will mistake for a real code.
 */
export class TelegramApiError extends Error {
  readonly method: string;
  readonly errorCode?: number;
  readonly description?: string;

  constructor(
    method: string,
    errorCode: number | undefined,
    description: string | undefined,
    fallbackStatus?: number,
  ) {
    // The message keeps BOTH parts: the code that classification needs and
    // the description a human reads. Any legacy substring reader now finds
    // the number that used to be missing.
    const code = errorCode ?? fallbackStatus;
    const detail = description ?? (code !== undefined ? String(code) : "unknown error");
    super(
      `Telegram API ${method} failed` +
        (code !== undefined ? ` (error_code ${code})` : "") +
        `: ${detail}`,
    );
    this.name = "TelegramApiError";
    this.method = method;
    this.errorCode = errorCode;
    this.description = description;
  }

  /** Build from a parsed `ok:false` response body. */
  static fromEnvelope(
    method: string,
    envelope: TelegramErrorEnvelope,
    fallbackStatus?: number,
  ): TelegramApiError {
    return new TelegramApiError(
      method,
      envelope.error_code,
      envelope.description,
      fallbackStatus,
    );
  }
}

/**
 * Telegram's own conflict marker: the description ALWAYS opens with this
 * literal when two consumers race one bot token. Anchored at the start so
 * the ordinary English word "conflict" appearing in someone else's error
 * (a git message, say) cannot impersonate it.
 */
const CONFLICT_PREFIX = /^Conflict:/;

/**
 * Is this failure "another consumer is already polling this bot token"?
 *
 * Structural first — `error_code === 409` is the fact Telegram states, and it
 * survives any future rewording of the prose. The description check is only a
 * fallback for paths that still flatten the envelope into a plain Error.
 *
 * Deliberately NOT a substring search for "409": the code lives in the
 * envelope, and matching digits in free text is what broke this before.
 */
export function isConflictError(err: unknown): boolean {
  if (err instanceof TelegramApiError) {
    if (err.errorCode === 409) return true;
    return err.description !== undefined && CONFLICT_PREFIX.test(err.description);
  }
  if (err instanceof Error) {
    // A flattened message from an older build reads
    // "Telegram API getUpdates failed: Conflict: terminated by …".
    return /: Conflict: /.test(err.message);
  }
  return false;
}

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
    throw TelegramApiError.fromEnvelope(method, json, res.status);
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
  // FILE_BASE, not a second hardcoded literal: file downloads use a different
  // path shape from the method base, and building it here is how the API-root
  // override (lib/api-root.ts) ended up covering only 4 of 5 egress sites in
  // every earlier sketch of this seam.
  const url = `${FILE_BASE}/${filePath}`;
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
    // Same typed error as tgApi — this path builds its own multipart request
    // but must not have its own error shape.
    throw TelegramApiError.fromEnvelope("sendDocument", json, res.status);
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
