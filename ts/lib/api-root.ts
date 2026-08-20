/**
 * The ONE place a Telegram API URL root is decided.
 *
 * Every Telegram HTTP call this package makes is built from this root, so
 * there is exactly one thing to redirect and no `getenv` sprinkled across call
 * sites. config.ts derives both bases from it:
 *
 *   API_BASE  = <root>/bot<token>       — the Bot API method base
 *                                         (telegram-api::tgApi / getMeRaw /
 *                                          sendDocument, health-adapters::
 *                                          probeWebhook)
 *   FILE_BASE = <root>/file/bot<token>  — the file-download base
 *                                         (telegram-api::downloadFile)
 *
 * FILE_BASE is derived here rather than left as its own literal because
 * downloadFile() used to build a SEPARATE hardcoded URL on a different path
 * shape: redirecting only the method base would have quietly left file
 * downloads pointed at the real api.telegram.org. A half-seam is worse than
 * none — it makes a test look green while half the traffic still leaves the
 * building.
 *
 * ── The override ────────────────────────────────────────────────────────────
 *
 * CCT_TELEGRAM_API_BASE (canonical spelling:
 * CLAUDE_CODE_TELEGRAMMER_TELEGRAM_API_BASE) replaces the default root. It
 * holds the ORIGIN — the part BEFORE "/bot<token>" — not a whole base. Unset,
 * the resolved strings are byte-identical to the literals they replaced.
 *
 * Two reasons it exists:
 *
 *   1. TESTS. Until this seam, NO test in this repo could observe what the
 *      poller actually puts on the wire — the base was a module-load-time
 *      const, so a test could only ever assert against injected fakes. That is
 *      how the poll loop's 409 / double-consumer branch shipped with zero
 *      coverage, and how a classification bug inside it survived a month in
 *      production: every poller test stayed green while two live consumers
 *      fought over one bot token, because no test could see the wire at all.
 *      Pointing a REAL poller process at a REAL 127.0.0.1 server is now
 *      possible, and the double-polling regression tests stand on it.
 *   2. A self-hosted Telegram Bot API server (telegram-bot-api) — a supported
 *      Telegram deployment speaking the same paths.
 *
 * ── Why it is loud ──────────────────────────────────────────────────────────
 *
 * A malformed value THROWS at import, naming the variable and the offending
 * value. An accepted override is LOGGED once at startup. Neither is optional:
 * this knob decides where the BOT TOKEN is sent, so quietly falling back to
 * the real API after being told to go elsewhere would put the operator's
 * traffic on a rail they did not choose and tell nobody — the exact silent
 * fallback this package refuses.
 */

import { aliases, getenv } from "./env.js";
import { log } from "./log.js";

export const DEFAULT_API_ROOT = "https://api.telegram.org";

/** Raised when the Telegram API-root override is set to something unusable. */
export class TelegramApiBaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramApiBaseError";
  }
}

/** "CCT_TELEGRAM_API_BASE / CLAUDE_CODE_TELEGRAMMER_TELEGRAM_API_BASE" */
export const API_ROOT_ENV_NAMES = aliases("TELEGRAM_API_BASE").join(" / ");

function rejectApiRoot(raw: string, why: string): never {
  throw new TelegramApiBaseError(
    `${API_ROOT_ENV_NAMES} is set to ${JSON.stringify(raw)}, which ${why}. ` +
      `Expected an absolute http(s) origin with no query, fragment or ` +
      `credentials — the part BEFORE "/bot<token>" — for example ` +
      `"http://127.0.0.1:8081" or "https://telegram.example.internal/api". ` +
      `Unset the variable to use the default ${DEFAULT_API_ROOT}. Refusing to ` +
      `start rather than falling back: silently using the real Telegram API ` +
      `would send this bot's token somewhere you did not ask for.`,
  );
}

/**
 * Resolve the Telegram API ROOT: `scheme://host[:port][/prefix]`, never with a
 * trailing slash — every call site appends `/<something>`, and a trailing
 * slash would produce `//getUpdates`.
 *
 * Pure and env-injectable, so the validation is testable without restarting a
 * process; `API_ROOT` below is this applied to `process.env` at import.
 */
export function resolveApiRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  // getenv() already treats "" as ABSENT for every spelling.
  const raw = getenv("TELEGRAM_API_BASE", undefined, env);
  if (raw === undefined) return DEFAULT_API_ROOT;

  const trimmed = raw.trim();
  if (trimmed === "") rejectApiRoot(raw, "is blank");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    rejectApiRoot(raw, "is not a parseable absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    rejectApiRoot(
      raw,
      `uses the "${url.protocol}" scheme (only http and https speak the Bot API)`,
    );
  }
  if (!url.hostname) rejectApiRoot(raw, "has no host");
  if (url.username || url.password) {
    rejectApiRoot(raw, "embeds credentials in the URL");
  }
  if (url.search) {
    rejectApiRoot(
      raw,
      "carries a query string, which would land in the middle of the request path",
    );
  }
  if (url.hash) {
    rejectApiRoot(raw, "carries a #fragment, which is never sent to a server");
  }
  if (/(^|\/)bot[^/]*$/.test(url.pathname)) {
    rejectApiRoot(
      raw,
      'already ends in a "/bot<token>" segment — pass only the ROOT, and ' +
        '"/bot<token>" is appended for you',
    );
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * Loopback is the only place plaintext http is unremarkable: the bytes never
 * leave the machine. A LAN address, a VPN peer or a public host all put them
 * on a wire something else can be sitting on.
 *
 * Exported and pure for the same reason resolveApiRoot is: it decides a
 * security-relevant log line, and a decision like that must be testable
 * without setting an env var and restarting a process.
 */
export function isLoopbackHost(hostname: string): boolean {
  // WHATWG URL returns IPv6 hosts BRACKETED — new URL("http://[::1]").hostname
  // is "[::1]", not "::1" — so strip them before comparing.
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true; // RFC 6761
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1 — 127.5.5.5 is equally
  // local, and a test server bound there is equally unremarkable.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** How exposed a resolved root leaves the bot token. */
export type ApiRootExposure =
  | "default" //             the real Telegram API, https
  | "encrypted" //           an override, but https
  | "loopback-plaintext" //  http to this machine — the test / self-host case
  | "remote-plaintext"; //   http to somewhere else — the token is in the clear

/**
 * Three-valued rather than a boolean "is it safe": "loopback-plaintext" is the
 * case this seam EXISTS to serve (a real poller pointed at a real 127.0.0.1
 * server), so collapsing it together with remote plaintext would make the
 * warning fire on every test run and be switched off within a week.
 */
export function apiRootExposure(root: string): ApiRootExposure {
  if (root === DEFAULT_API_ROOT) return "default";
  let url: URL;
  try {
    url = new URL(root);
  } catch {
    // resolveApiRoot already refuses unparseable roots, so reaching here means
    // the value came from somewhere that did not go through it. Report the
    // worst case rather than a reassuring one.
    return "remote-plaintext";
  }
  if (url.protocol === "https:") return "encrypted";
  return isLoopbackHost(url.hostname)
    ? "loopback-plaintext"
    : "remote-plaintext";
}

export const API_ROOT = resolveApiRoot();

// One line, at startup, only when the override is actually in force. A
// redirect of the operator's Telegram traffic must never have to be
// discovered by reading a packet capture.
if (API_ROOT !== DEFAULT_API_ROOT) {
  log(
    "config",
    `Telegram API root OVERRIDDEN via ${API_ROOT_ENV_NAMES} — all Telegram ` +
      `traffic (and this bot's token) goes to ${API_ROOT}, NOT ` +
      `${DEFAULT_API_ROOT}`,
    { apiRoot: API_ROOT },
  );
}

// A SECOND line, for the ONE case the line above cannot distinguish. That one
// says WHERE the token is going; this one says it is going there IN THE CLEAR.
// Those are different facts, and a reader who needs the second must not have to
// infer it from a scheme buried in a URL they are being shown for another
// reason. Only remote plaintext warns: loopback plaintext is the case this seam
// was built for, and a warning that fires on every test run gets switched off.
if (apiRootExposure(API_ROOT) === "remote-plaintext") {
  log(
    "config",
    `WARNING: the Telegram API root is UNENCRYPTED http:// to a NON-LOOPBACK ` +
      `host (${API_ROOT}). The bot token travels in the REQUEST PATH — ` +
      `"/bot<token>/<method>" — so it sits in the request line itself, where ` +
      `proxies, caches and access logs along that route RECORD it. This is ` +
      `not only a passive-listener risk. Use https, or a loopback address, ` +
      `unless every hop on this network is one you trust with a credential ` +
      `that controls this bot.`,
    { apiRoot: API_ROOT, exposure: "remote-plaintext" },
  );
}
