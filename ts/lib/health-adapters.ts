/**
 * Health check ("doctor") — THIN adapters over the real fs / network / sqlite.
 *
 * All classification lives in the pure lib/health.ts + lib/health-checks.ts;
 * this module only GATHERS the raw inputs and hands them over:
 *
 *   runHealth({ poller: "self" | "external" }) → Promise<HealthReport>
 *
 *   - "self"     : the MCP-tool variant, running INSIDE the server process —
 *                  that process IS the poller, so poller_alive reports its own
 *                  pid instead of the lockfile/pidfile round-trip.
 *   - "external" : the CLI variant (`bun run ts/telegram-server.ts health`) —
 *                  a fresh probe process that reads the lock file and the
 *                  per-token pidfile and kill-0s the recorded PID.
 *
 * Token hygiene: the raw bot token must NEVER appear in health output. The
 * probes themselves only pass URLs/PIDs/counters, but transport-level fetch
 * errors can embed the request URL (which contains the token) — so every
 * probe string is passed through redactToken(), and serializeHealthReport()
 * applies it once more to the final JSON as a belt-and-braces guarantee.
 */

import {
  existsSync,
  accessSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  constants,
} from "fs";
import { join, dirname } from "path";
import { connect } from "net";
import { Database } from "bun:sqlite";
import {
  STATE_DIR,
  ACCESS_FILE,
  LOCK_FILE,
  ENV_ALLOWED,
  AGENT_ID,
  TOKEN,
  TURN_URL,
  API_BASE,
  BOT_TOKEN_HASH,
  findUnexpandedEnv,
  findRenamedEnv,
} from "./config.js";
import { LEGACY_PREFIX } from "./env.js";
import { validateBotToken } from "./startup-validate.js";
import { getMeRaw } from "./telegram-api.js";
import { loadAccess } from "./access.js";
import { newestCodeMtimeMs } from "./poller-supervisor.js";
import type { CodeCurrencyProbe } from "./health-checks-code.js";
import {
  pollerPidfilePath,
  readPidfile,
  isProcessMatching,
  POLLER_CMDLINE_MARKER,
  SERVER_CMDLINE_MARKER,
} from "./takeover.js";
import { DB_PATH } from "./store.js";
import { wakeEnabled } from "./wake.js";
import { getWakeFailureState } from "./wake-health.js";
import {
  buildHealthReport,
  type HealthReport,
  type HealthInputs,
  type WebhookProbe,
  type PollerProbe,
  type StateDirProbe,
  type DbProbe,
  type WakeReachabilityProbe,
} from "./health.js";

/**
 * Replace every occurrence of the raw bot token with the literal placeholder
 * `<TOKEN>`. No-op when no token is set. Applied to every probe string that
 * could carry a URL (fetch error messages embed the request URL, which
 * contains the token) AND to the final serialized report.
 */
export function redactToken(s: string, token: string = TOKEN): string {
  if (!token) return s;
  return s.split(token).join("<TOKEN>");
}

/** Serialize a report to pretty JSON with the token redaction belt applied. */
export function serializeHealthReport(report: HealthReport): string {
  return redactToken(JSON.stringify(report, null, 2));
}

// ── Individual probes ───────────────────────────────────────────────────────

/**
 * Raw getWebhookInfo — same raw-fetch style as getMeRaw() (lib/telegram-api):
 * returns the parsed Telegram envelope on ANY HTTP response so the pure check
 * can classify ok/transient itself; a transport-level fetch reject folds into
 * a transport_error probe (with the token redacted out of the message).
 */
export async function probeWebhook(): Promise<WebhookProbe> {
  try {
    const res = await fetch(`${API_BASE}/getWebhookInfo`, { method: "POST" });
    const json = (await res.json()) as {
      ok: boolean;
      result?: { url?: string };
      error_code?: number;
      description?: string;
    };
    if (json.ok) {
      return { kind: "response", ok: true, url: json.result?.url ?? "" };
    }
    return {
      kind: "response",
      ok: false,
      url: "",
      error_code: json.error_code,
      description: redactToken(json.description ?? ""),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "transport_error", detail: redactToken(detail) };
  }
}

/**
 * Poller-liveness inputs. "self" short-circuits to our own pid (the MCP-tool
 * variant runs inside the server process, which IS the poller). "external"
 * reads the single-instance lock file + the per-token pidfile
 * (poller-<hash>.pid, lib/takeover.ts format) and verifies the recorded PIDs
 * via isProcessMatching (kill-0 PLUS a cmdline identity check — not `ps -p`,
 * because it survives PID-namespace boundaries; not a bare kill-0 either,
 * because a stale PID can be reused by the OS for an unrelated process,
 * which would otherwise read as a healthy poller — adversarial-review
 * finding #2).
 */
/**
 * Gather the inputs for the code_current check — "am I running the code that is
 * on disk?" (grant's detection-gap point, 2026-07-14).
 *
 * Reads the EXECUTING surface, never package metadata:
 *   - this process's own start time, derived from process.uptime();
 *   - the poller's pidfile claim time;
 *   - the newest mtime across the source those processes would have loaded.
 *
 * A version string would be the wrong instrument here: pyproject/package.json/
 * dist-info all report a number ABOUT the code, which can be baked, orphaned, or
 * simply older than the source beside it. This asks a question only the running
 * process can answer.
 */
export function probeCodeCurrency(): CodeCurrencyProbe {
  // process.uptime() is seconds since THIS process started — a property of the
  // running process itself, not a claim recorded anywhere.
  const serverStartMs = Date.now() - process.uptime() * 1000;

  const snap = readPidfile(pollerPidfilePath(STATE_DIR, BOT_TOKEN_HASH));
  const pollerStartMs = snap?.startMs && snap.startMs > 0 ? snap.startMs : null;

  // Resolved from import.meta.dir — i.e. relative to the module that is ACTUALLY
  // EXECUTING, not from a configured path that could point somewhere else. This
  // file lives in ts/lib/, the poller entrypoint one level up in ts/.
  const pollerScriptPath = join(import.meta.dir, "..", "telegram-poller.ts");

  // Same source-of-truth the supervisor acts on, so the check and the takeover
  // can never disagree about what "stale" means.
  const codeMtimeMs = newestCodeMtimeMs(pollerScriptPath);

  return { serverStartMs, pollerStartMs, codeMtimeMs };
}

export function probePoller(mode: "self" | "external"): PollerProbe {
  if (mode === "self") return { kind: "self", pid: process.pid };

  let lockPid: number | null = null;
  try {
    const raw = parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
    if (Number.isFinite(raw) && raw > 0) lockPid = raw;
  } catch {
    lockPid = null; // missing/unreadable lock file — reported as "not recorded"
  }

  const pidfilePath = pollerPidfilePath(STATE_DIR, BOT_TOKEN_HASH);
  const snap = readPidfile(pidfilePath);
  const pidfilePid = snap?.pid ?? null;

  return {
    kind: "external",
    lockPid,
    lockAlive:
      lockPid !== null && isProcessMatching(lockPid, SERVER_CMDLINE_MARKER),
    pidfilePid,
    pidfileAlive:
      pidfilePid !== null &&
      isProcessMatching(pidfilePid, POLLER_CMDLINE_MARKER),
    pidfilePath,
  };
}

/**
 * STATE_DIR existence/writability. When the dir exists: accessSync(W_OK) plus
 * a real create+unlink probe file (only inside an EXISTING dir — the probe
 * never mkdirs). When it does not exist: walk up to the nearest existing
 * ancestor and check that it is writable ("creatable").
 */
export function probeStateDir(dir: string = STATE_DIR): StateDirProbe {
  if (existsSync(dir)) {
    try {
      accessSync(dir, constants.W_OK);
      const probeFile = join(dir, `.health-probe-${process.pid}`);
      writeFileSync(probeFile, "ok");
      unlinkSync(probeFile);
      return { path: dir, exists: true, writable: true };
    } catch (err) {
      return {
        path: dir,
        exists: true,
        writable: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // Not created yet (first run) — find the nearest existing ancestor.
  let ancestor = dirname(dir);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    accessSync(ancestor, constants.W_OK);
    return { path: dir, exists: false, writable: true };
  } catch (err) {
    return {
      path: dir,
      exists: false,
      writable: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * messages.db probe — READONLY open (never mutates; safe against the live
 * poller's WAL). Missing DB is a normal first-run state, reported as such.
 * The max stored update_id is extracted from inbound raw_json (the poller
 * persists the whole Telegram update, update_id included) so the pure check
 * can flag a poisoned meta.update_offset.
 */
export function probeDb(dbPath: string = DB_PATH): DbProbe {
  if (!existsSync(dbPath)) return { exists: false };
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
    // busy_timeout is per-CONNECTION, not inherited from the file's WAL-
    // mode schema (adversarial-review finding #6) — this ad hoc handle had
    // none, meaning zero tolerance for lock contention against the live
    // poller's own writes.
    db.exec("PRAGMA busy_timeout = 5000;");
  } catch (err) {
    return {
      exists: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const ver = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    const off = db
      .prepare("SELECT value FROM meta WHERE key = 'update_offset'")
      .get() as { value: string } | undefined;
    const agg = db
      .prepare(
        "SELECT MAX(CAST(json_extract(raw_json, '$.update_id') AS INTEGER)) AS max_id, " +
          "COUNT(*) AS n FROM messages WHERE direction = 'inbound' AND raw_json IS NOT NULL",
      )
      .get() as { max_id: number | null; n: number };
    // The heartbeat recordSuccessfulPoll() persists. Read here so
    // checkIngestionLive can separate "the poller process exists" from
    // "messages are arriving" — the distinction a month of silence hid.
    const poll = db
      .prepare("SELECT value FROM meta WHERE key = 'last_poll_ts'")
      .get() as { value: string } | undefined;
    // Age of the newest inbound row — the "did anything ARRIVE?" signal that
    // last_poll_ts cannot give (a successful poll returning zero updates looks
    // exactly like a healthy quiet channel). Converted to epoch-ms in SQL
    // rather than parsed in TS: received_at is written by SQLite's
    // datetime('now'), which is UTC without a zone suffix, and `new Date()`
    // on that string reads it as LOCAL time.
    const newest = db
      .prepare(
        "SELECT MAX(strftime('%s', received_at)) AS s FROM messages " +
          "WHERE direction = 'inbound' AND received_at IS NOT NULL",
      )
      .get() as { s: string | null };
    const parsedOffset = off ? parseInt(off.value, 10) : NaN;
    const parsedPoll = poll ? parseInt(poll.value, 10) : NaN;
    const parsedNewest =
      newest.s === null ? NaN : parseInt(newest.s, 10) * 1000;
    return {
      exists: true,
      schemaVersion: ver?.value ?? null,
      updateOffset: Number.isFinite(parsedOffset) ? parsedOffset : null,
      maxUpdateId: agg.max_id ?? null,
      inboundCount: agg.n,
      lastPollTs: Number.isFinite(parsedPoll) ? parsedPoll : null,
      newestInboundMs: Number.isFinite(parsedNewest) ? parsedNewest : null,
    };
  } catch (err) {
    return {
      exists: true,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db.close();
  }
}

/** Names of deprecated CLAUDE_CODE_TELEGRAMMER_TELEGRAM_* vars set (non-empty). */
export function probeLegacyEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith(LEGACY_PREFIX) && env[name] !== "")
    .sort();
}

/**
 * Reachability probe for the configured wake target — a raw TCP connect,
 * NEVER an HTTP request, so probing can never itself trigger a real turn
 * on the target agent. Skips entirely when wake is disabled (no TURN_URL),
 * a gate independent of tokenPresent (a tokenful interactive-CLI agent
 * commonly has a bot token but no TURN_URL at all).
 */
export function probeWakeReachability(
  timeoutMs: number = 2000,
): Promise<WakeReachabilityProbe> {
  return new Promise((resolve) => {
    if (!wakeEnabled()) {
      resolve({ kind: "disabled" });
      return;
    }
    let url: URL;
    try {
      url = new URL(TURN_URL);
    } catch (err) {
      resolve({
        kind: "invalid_url",
        url: redactToken(TURN_URL),
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const host = url.hostname;
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    const socket = connect({ host, port, timeout: timeoutMs });
    const finish = (result: WakeReachabilityProbe) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish({ kind: "reachable", host, port }));
    socket.once("timeout", () =>
      finish({
        kind: "unreachable",
        host,
        port,
        detail: `connect timed out after ${timeoutMs}ms`,
      }),
    );
    socket.once("error", (err) =>
      finish({ kind: "unreachable", host, port, detail: err.message }),
    );
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Gather every probe and build the report. Telegram-dependent probes
 * (getMe, getWebhookInfo, poller, access gating) are skipped (null inputs →
 * skipped-ok entries) when no token is set — the disabled state is already
 * flagged by bot_token_present, and without a token there is no bot, no
 * poller, and no DMs to gate.
 */
export async function runHealth(opts: {
  poller: "self" | "external";
}): Promise<HealthReport> {
  const tokenPresent = TOKEN.length > 0;

  let tokenCheck: HealthInputs["tokenCheck"] = null;
  let webhook: WebhookProbe | null = null;
  let poller: PollerProbe | null = null;
  let access: HealthInputs["access"] = null;
  if (tokenPresent) {
    [tokenCheck, webhook] = await Promise.all([
      validateBotToken(getMeRaw),
      probeWebhook(),
    ]);
    if (!tokenCheck.ok) {
      tokenCheck = { ...tokenCheck, message: redactToken(tokenCheck.message) };
    }
    poller = probePoller(opts.poller);
    access = {
      accessFileExists: existsSync(ACCESS_FILE),
      envAllowedCount: ENV_ALLOWED.length,
      dmPolicy: loadAccess().dmPolicy,
      accessFilePath: ACCESS_FILE,
    };
  }

  const wakeReachability = await probeWakeReachability();
  const wakeBacklog = wakeEnabled() ? getWakeFailureState() : null;

  return buildHealthReport({
    agentId: AGENT_ID,
    stateDir: STATE_DIR,
    tokenPresent,
    unexpandedEnvLines: findUnexpandedEnv(),
    renamedEnvLines: findRenamedEnv(),
    legacyEnvNames: probeLegacyEnv(),
    tokenCheck,
    webhook,
    poller,
    access,
    stateDirProbe: probeStateDir(),
    db: probeDb(),
    wakeReachability,
    wakeBacklog,
    codeCurrency: probeCodeCurrency(),
  });
}
