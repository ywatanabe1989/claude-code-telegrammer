/**
 * A REAL Telegram Bot API server, on 127.0.0.1, for tests.
 *
 * Not a mock and not a monkey-patched `fetch`: this is an actual HTTP server
 * bound to a real loopback port, which the code under test reaches over a real
 * socket because `CCT_TELEGRAM_API_BASE` points at it (see lib/api-root.ts).
 * Everything it records is therefore an OBSERVED REQUEST — evidence about what
 * the process actually put on the wire, which is exactly the evidence this
 * repo has never been able to collect about its poller.
 *
 * It speaks both path shapes the package uses:
 *
 *   POST /bot<token>/<method>      — every Bot API method call
 *   GET  /file/bot<token>/<path>   — telegram-api::downloadFile
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * The double-polling failure mode is "two consumers, one bot token". Telegram
 * signals it with a 409 whose body carries `error_code: 409`. Reproducing that
 * against the real API is impossible in CI, and asserting on an injected fake
 * error is what let the last bug through: the classifier was tested, the wire
 * was not. `respondWith("getUpdates", conflictReply())` makes the real poll
 * loop meet a real 409 over a real socket.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   const fake = startFakeTelegram();
 *   try {
 *     // hand `fake.url` to the process/module under test as
 *     // CCT_TELEGRAM_API_BASE, then:
 *     const req = await fake.waitFor("getUpdates");
 *     expect(req.body?.timeout).toBe(30);
 *   } finally {
 *     await fake.stop();
 *   }
 *
 * Nothing here is Telegram-complete — it answers the handful of methods this
 * package calls, and `ok: true` to anything else, so a new call site cannot
 * wedge an unrelated test. Override any of it with `respondWith`.
 */

import type { Server } from "bun";

/** One request the server actually received. */
export interface RecordedRequest {
  /** Bot API method name, e.g. "getUpdates". `FILE_DOWNLOAD` for a file GET. */
  method: string;
  /** HTTP verb as received. */
  verb: string;
  /** Full request pathname, e.g. "/botseam:token/getUpdates". */
  pathname: string;
  /** The `<token>` segment the caller used — proves WHICH token was polled. */
  token: string;
  /** Parsed JSON body, or null for GET / non-JSON (e.g. multipart). */
  body: Record<string, unknown> | null;
  /** For FILE_DOWNLOAD: the path after `/file/bot<token>/`. */
  filePath?: string;
  /** Date.now() at receipt. */
  at: number;
}

/** Pseudo-method name recorded for `GET /file/bot<token>/<path>`. */
export const FILE_DOWNLOAD = "FILE_DOWNLOAD";

/** What a handler hands back. `json` is serialized; `body` is sent verbatim. */
export interface FakeReply {
  status?: number;
  json?: unknown;
  body?: string | Uint8Array;
  contentType?: string;
}

/** Return undefined to fall through to the built-in default for that method. */
export type MethodHandler = (
  req: RecordedRequest,
) => FakeReply | undefined | Promise<FakeReply | undefined>;

export interface FakeTelegramOptions {
  /** Bot username reported by getMe. Default "fake_seam_bot". */
  username?: string;
  /**
   * How long an empty getUpdates holds before answering `[]`, imitating a
   * long poll. Keeps a real poll loop from spinning hot in a test. Default
   * 150ms — long enough to be gentle, short enough not to slow a suite.
   */
  emptyPollMs?: number;
}

export interface FakeTelegram {
  /** The API ROOT to pass as CCT_TELEGRAM_API_BASE, e.g. "http://127.0.0.1:41234". */
  readonly url: string;
  readonly port: number;
  /** Every request received, in arrival order. */
  readonly requests: readonly RecordedRequest[];
  /** Requests for one Bot API method. */
  calls(method: string): RecordedRequest[];
  /** Resolves with the first matching request; rejects on timeout. */
  waitFor(
    method: string,
    opts?: { timeoutMs?: number; where?: (req: RecordedRequest) => boolean },
  ): Promise<RecordedRequest>;
  /** Queue updates for the next getUpdates to return. */
  enqueueUpdates(...updates: Array<Record<string, unknown>>): void;
  /** Install (or, with undefined, remove) a handler for one method. */
  respondWith(method: string, handler: MethodHandler | undefined): void;
  /** Bytes served for `GET /file/bot<token>/<path>`. Default "fake-file". */
  setFileBytes(bytes: string | Uint8Array): void;
  stop(): Promise<void>;
}

/**
 * The exact reply Telegram sends when a second consumer polls one bot token.
 * `error_code` is the load-bearing field — the description carries no digits,
 * which is what made a substring classifier miss 161 real conflicts.
 */
export function conflictReply(): MethodHandler {
  return () => ({
    status: 409,
    json: {
      ok: false,
      error_code: 409,
      description:
        "Conflict: terminated by other getUpdates request; make sure that " +
        "only one bot instance is running",
    },
  });
}

const BOT_PATH = /^\/bot([^/]+)\/([^/]+)$/;
const FILE_PATH = /^\/file\/bot([^/]+)\/(.+)$/;

export function startFakeTelegram(
  opts: FakeTelegramOptions = {},
): FakeTelegram {
  const username = opts.username ?? "fake_seam_bot";
  const emptyPollMs = opts.emptyPollMs ?? 150;

  const requests: RecordedRequest[] = [];
  const handlers = new Map<string, MethodHandler>();
  const pendingUpdates: Array<Record<string, unknown>> = [];
  interface Waiter {
    method: string;
    where?: (req: RecordedRequest) => boolean;
    resolve: (req: RecordedRequest) => void;
  }
  const waiters: Waiter[] = [];
  let fileBytes: string | Uint8Array = "fake-file";
  let stopped = false;
  let nextMessageId = 1000;

  const notifyWaiters = (rec: RecordedRequest): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (w.method === rec.method && (!w.where || w.where(rec))) {
        waiters.splice(i, 1);
        w.resolve(rec);
      }
    }
  };

  const defaultReply = async (rec: RecordedRequest): Promise<FakeReply> => {
    switch (rec.method) {
      case "getMe":
        return {
          json: {
            ok: true,
            result: {
              id: 4242,
              is_bot: true,
              first_name: "Fake Seam",
              username,
            },
          },
        };
      case "getUpdates": {
        if (pendingUpdates.length === 0) {
          // Imitate the long poll: hold briefly, then answer empty.
          await new Promise((r) => setTimeout(r, emptyPollMs));
          return { json: { ok: true, result: [] } };
        }
        const batch = pendingUpdates.splice(0, pendingUpdates.length);
        return { json: { ok: true, result: batch } };
      }
      case "getWebhookInfo":
        return { json: { ok: true, result: { url: "" } } };
      case "sendMessage":
      case "sendDocument":
      case "editMessageText":
        return {
          json: { ok: true, result: { message_id: nextMessageId++ } },
        };
      case "getFile":
        return {
          json: { ok: true, result: { file_path: "documents/file_1.bin" } },
        };
      case FILE_DOWNLOAD:
        return { body: fileBytes, contentType: "application/octet-stream" };
      default:
        // deleteWebhook, setMessageReaction, sendChatAction, anything new.
        return { json: { ok: true, result: true } };
    }
  };

  const toResponse = (reply: FakeReply): Response => {
    const status = reply.status ?? 200;
    if (reply.json !== undefined) {
      return new Response(JSON.stringify(reply.json), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(reply.body ?? "", {
      status,
      headers: {
        "Content-Type": reply.contentType ?? "application/octet-stream",
      },
    });
  };

  const server: Server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const botMatch = BOT_PATH.exec(url.pathname);
      const fileMatch = botMatch ? null : FILE_PATH.exec(url.pathname);
      if (!botMatch && !fileMatch) {
        // Record the miss too — an unexpected shape is evidence, not noise.
        const rec: RecordedRequest = {
          method: "UNMATCHED",
          verb: req.method,
          pathname: url.pathname,
          token: "",
          body: null,
          at: Date.now(),
        };
        requests.push(rec);
        notifyWaiters(rec);
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 404,
            description: `fake-telegram: unrecognised path ${url.pathname}`,
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      let body: Record<string, unknown> | null = null;
      if (botMatch && req.method !== "GET") {
        // sendDocument posts multipart; a JSON parse failure is expected there
        // and must not fail the request.
        try {
          const text = await req.text();
          body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        } catch {
          body = null;
        }
      }

      const rec: RecordedRequest = botMatch
        ? {
            method: botMatch[2]!,
            verb: req.method,
            pathname: url.pathname,
            token: botMatch[1]!,
            body,
            at: Date.now(),
          }
        : {
            method: FILE_DOWNLOAD,
            verb: req.method,
            pathname: url.pathname,
            token: fileMatch![1]!,
            body: null,
            filePath: fileMatch![2]!,
            at: Date.now(),
          };
      requests.push(rec);
      notifyWaiters(rec);

      const override = handlers.get(rec.method);
      const reply = (await override?.(rec)) ?? (await defaultReply(rec));
      return toResponse(reply);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    requests,
    calls(method) {
      return requests.filter((r) => r.method === method);
    },
    waitFor(method, o = {}) {
      const timeoutMs = o.timeoutMs ?? 10_000;
      const already = requests.find(
        (r) => r.method === method && (!o.where || o.where(r)),
      );
      if (already) return Promise.resolve(already);
      return new Promise<RecordedRequest>((resolve, reject) => {
        const entry: Waiter = {
          method,
          where: o.where,
          resolve: () => {},
        };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          reject(
            new Error(
              `fake-telegram on 127.0.0.1:${server.port}: no "${method}" ` +
                `request arrived within ${timeoutMs}ms. Received so far: ` +
                (requests.length === 0
                  ? "(nothing at all)"
                  : requests.map((r) => r.method).join(", ")),
            ),
          );
        }, timeoutMs);
        entry.resolve = (rec: RecordedRequest) => {
          clearTimeout(timer);
          resolve(rec);
        };
        waiters.push(entry);
      });
    },
    enqueueUpdates(...updates) {
      pendingUpdates.push(...updates);
    },
    respondWith(method, handler) {
      if (handler) handlers.set(method, handler);
      else handlers.delete(method);
    },
    setFileBytes(bytes) {
      fileBytes = bytes;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop(true);
    },
  };
}
