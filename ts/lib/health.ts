/**
 * Health check ("doctor") — report shape, injected-probe types, and assembly.
 *
 * Contract (SHARED across sac / scitex-todo / claude-code-telegrammer — the
 * operator's standard health-checker per infra package; do not deviate):
 *
 *   { "package": "claude-code-telegrammer",
 *     "ok": bool,                      // AND of all non-warn checks
 *     "checks": [ { "name", "ok", "detail", "hint" } ],
 *     "summary": str }
 *
 *   - Every FAILING check carries an actionable `hint` naming the exact env
 *     var / file / fix. Passing checks have hint null (except explicit
 *     warn-style nudges like env_legacy, whose spec mandates a hint).
 *   - No silent pass: every check appears in the array with a real `detail`.
 *   - "Status as hints, fail-loud, no silent fallback" (operator directive,
 *     card cct-health-doctor-mcp-tool-20260702).
 *
 * Everything in this module (and lib/health-checks.ts + lib/health-checks-wake.ts,
 * which together hold the twelve individual check builders) is PURE — no
 * network, no filesystem, no process inspection. All probes are injected as
 * plain data (`HealthInputs`), gathered
 * by the thin adapters in lib/health-adapters.ts. That keeps every branch unit
 * -testable under `bun test` without mocking fetch/fs (same split as
 * lib/startup-validate.ts).
 *
 * WARN-style checks (excluded from the top-level `ok` AND):
 *   - bot_token_present when the token is ABSENT: telegram is DISABLED by
 *     design (universal channel in every agent spec) — the entry reports
 *     ok:false with the buildDisabledWarning() hint, but a deliberately
 *     tokenless agent must not read as unhealthy.
 *   - env_legacy: deprecated spellings still work; nudge, don't fail.
 * When the token is absent, the telegram-dependent checks (bot_token_valid,
 * webhook_absent, poller_alive, allowlist_nonempty) are emitted as
 * skipped-with-ok:true — the disabled state is already flagged loudly by
 * bot_token_present, and double-failing would make the honest disabled state
 * look broken.
 */

import type { TokenCheck, AccessGatingInput } from "./startup-validate.js";
import type { WakeFailureState } from "./wake-health.js";
import {
  checkEnvUnexpanded,
  checkEnvRenamed,
  checkBotTokenPresent,
  checkBotTokenValid,
  checkWebhookAbsent,
  checkPollerAlive,
  // (checkIngestionLive lives in its own module — see the import below.)
  checkAllowlistNonempty,
  checkStateDirWritable,
  checkDbSchemaCurrent,
  checkEnvLegacy,
  type CheckOutcome,
} from "./health-checks.js";
import {
  checkWakeTargetReachable,
  checkWakeDeliveryBacklog,
} from "./health-checks-wake.js";
import {
  checkCodeCurrent,
  type CodeCurrencyProbe,
} from "./health-checks-code.js";
import { checkIngestionLive } from "./health-checks-ingestion.js";
import { checkInboundRecency } from "./health-checks-inbound-recency.js";

// Re-export the builders + skip marker so callers/tests have one import surface.
export * from "./health-checks.js";
export * from "./health-checks-wake.js";
export * from "./health-checks-code.js";
export * from "./health-checks-ingestion.js";
export * from "./health-checks-inbound-recency.js";

// ── Report shape (shared contract) ──────────────────────────────────────────

export interface HealthCheckEntry {
  name: string;
  ok: boolean;
  detail: string;
  hint: string | null;
  /**
   * Did this check actually RUN? Absent means yes (every pre-existing check).
   *
   * `false` marks the third value: the precondition failed, so the check has
   * no opinion. It is neither ok nor failing. Measured 2026-08-16: two checks
   * returned `ok` whose own detail said "not evaluated", and the summary
   * counted them green while the operator's channel was dead.
   *
   * Distinct from `skipped: telegram disabled`, which is a deliberate config
   * choice and genuinely not-applicable rather than unmeasured.
   */
  evaluated?: boolean;
}

export interface HealthReport {
  package: "claude-code-telegrammer";
  ok: boolean;
  checks: HealthCheckEntry[];
  summary: string;
}

// ── Injected probe inputs ────────────────────────────────────────────────────

/** Raw getWebhookInfo outcome, gathered by the adapter (never the raw token). */
export type WebhookProbe =
  | {
      kind: "response";
      ok: boolean;
      /** result.url — empty string means "no webhook set". */
      url: string;
      error_code?: number;
      description?: string;
    }
  | { kind: "transport_error"; detail: string };

/**
 * Poller-liveness probe. "self" is the MCP-tool variant: the health tool runs
 * INSIDE the server process, and that process IS the poller — no pidfile
 * round-trip needed. "external" is the CLI variant: a fresh probe process
 * reads the state dir's lock file + per-token pidfile (lib/takeover.ts format)
 * and checks the recorded PID via process.kill(pid, 0) — NOT `ps -p`, because
 * PID-namespace boundaries (apptainer vs host) make `ps -p` lie while kill-0
 * survives them.
 */
export type PollerProbe =
  | { kind: "self"; pid: number }
  | {
      kind: "external";
      lockPid: number | null;
      lockAlive: boolean;
      pidfilePid: number | null;
      pidfileAlive: boolean;
      pidfilePath: string;
    };

export interface StateDirProbe {
  path: string;
  exists: boolean;
  /** exists=true → dir itself is writable; exists=false → dir is CREATABLE
   *  (nearest existing ancestor is writable). */
  writable: boolean;
  /** fs error detail on failure. */
  detail?: string;
}

export type DbProbe =
  | { exists: false }
  | { exists: true; error: string }
  | {
      exists: true;
      error?: undefined;
      schemaVersion: string | null;
      updateOffset: number | null;
      /** MAX(update_id) extracted from stored inbound raw_json; null when no
       *  inbound rows carry one. */
      maxUpdateId: number | null;
      inboundCount: number;
      /**
       * meta.last_poll_ts — epoch-ms of the last SUCCESSFUL getUpdates
       * (recordSuccessfulPoll persists it). null ⇔ never stamped.
       *
       * This is the number that separates "the poller process exists" from
       * "inbound is actually flowing"; see checkIngestionLive. Optional so
       * existing callers/fixtures stay valid — absent ⇔ the check skips
       * rather than failing the report.
       */
      lastPollTs?: number | null;
      /**
       * Epoch-ms of the newest STORED inbound row (MAX(received_at)).
       *
       * last_poll_ts says polling works; this says something ARRIVED. A poll
       * that succeeds with zero updates is identical to a healthy quiet
       * channel, so ingestion_live cannot separate the two — see
       * checkInboundRecency. Optional so existing callers/fixtures stay
       * valid. Absent ⇔ nobody asked; null ⇔ asked and no inbound row exists.
       */
      newestInboundMs?: number | null;
    };

/**
 * Reachability probe for the configured wake target (TURN_URL). A raw TCP
 * connect attempt — never an HTTP request — so probing can never itself
 * trigger a real turn on the target agent. "disabled" mirrors the other
 * skipped-when-no-token probes: wake has its own independent gate
 * (TURN_URL empty), orthogonal to whether a bot token is set at all.
 */
export type WakeReachabilityProbe =
  | { kind: "disabled" }
  | { kind: "reachable"; host: string; port: number }
  | { kind: "unreachable"; host: string; port: number; detail: string }
  | { kind: "invalid_url"; url: string; detail: string };

/** Everything buildHealthReport needs, as plain injected data. */
export interface HealthInputs {
  agentId: string;
  stateDir: string;
  tokenPresent: boolean;
  /** findUnexpandedEnv() lines ("NAME=value" with a literal ${...}). */
  unexpandedEnvLines: string[];
  /** findRenamedEnv() lines (already actionable "OLD was renamed to NEW…"). */
  renamedEnvLines: string[];
  /** Names of deprecated CLAUDE_CODE_TELEGRAMMER_TELEGRAM_* vars still set. */
  legacyEnvNames: string[];
  /** validateBotToken(getMeRaw) result; null ⇔ skipped (no token). */
  tokenCheck: TokenCheck | null;
  /** getWebhookInfo probe; null ⇔ skipped (no token). */
  webhook: WebhookProbe | null;
  /** Poller-liveness probe; null ⇔ skipped (no token → poller never starts). */
  poller: PollerProbe | null;
  /** describeAccessGating() inputs; null ⇔ skipped (no token). */
  access: AccessGatingInput | null;
  stateDirProbe: StateDirProbe;
  db: DbProbe;
  /** TCP reachability of the configured wake target. */
  wakeReachability: WakeReachabilityProbe;
  /** Consecutive-wake-failure counter; null ⇔ skipped (wake disabled). */
  wakeBacklog: WakeFailureState | null;
  /**
   * Process start times vs source mtime — "am I running the code on disk?".
   * Optional so existing callers/fixtures stay valid; absent ⇔ the check skips
   * rather than failing the report.
   */
  codeCurrency?: CodeCurrencyProbe;
  /**
   * Epoch-ms clock, injectable so ingestion_live is unit-testable without
   * timers. Absent ⇔ Date.now().
   */
  now?: number;
}

// ── Report assembly ─────────────────────────────────────────────────────────

/**
 * Assemble the full HealthReport from injected inputs. Pure and synchronous —
 * every network/fs probe already happened in the adapter layer.
 */
export function buildHealthReport(inputs: HealthInputs): HealthReport {
  const outcomes: CheckOutcome[] = [
    checkEnvUnexpanded(inputs.unexpandedEnvLines),
    checkEnvRenamed(inputs.renamedEnvLines),
    checkBotTokenPresent(inputs.tokenPresent, inputs.agentId),
    checkBotTokenValid(inputs.tokenCheck),
    checkWebhookAbsent(inputs.webhook),
    checkPollerAlive(inputs.poller),
    // Right after poller_alive on purpose: "the process exists" and "messages
    // are arriving" are different questions, and a month of silence lived in
    // the gap between them. See health-checks-ingestion.ts.
    checkIngestionLive(inputs.db, inputs.poller, inputs.now ?? Date.now()),
    // Directly after ingestion_live, because it is the NEXT question and the
    // one ingestion_live cannot answer: polls succeeding and messages
    // arriving are different facts, and a successful poll returning zero
    // updates looks identical to a healthy quiet channel. See
    // health-checks-inbound-recency.ts.
    checkInboundRecency(inputs.db, inputs.poller, inputs.now ?? Date.now()),
    checkAllowlistNonempty(inputs.access),
    checkStateDirWritable(inputs.stateDirProbe),
    checkDbSchemaCurrent(inputs.db),
    checkEnvLegacy(inputs.legacyEnvNames),
    checkWakeTargetReachable(inputs.wakeReachability),
    checkWakeDeliveryBacklog(inputs.wakeBacklog),
    checkCodeCurrent(inputs.codeCurrency),
  ];

  return summarise(outcomes);
}

/**
 * Turn check outcomes into the report, keeping THREE values apart.
 *
 * Extracted and exported so the counting itself is testable — the 2026-08-16
 * defect was not in any individual check but in how they were tallied.
 *
 *   ok       evaluated and passed
 *   unknown  did not evaluate (precondition failed) — no opinion
 *   FAILING  evaluated and failed
 *
 * An unknown is deliberately NOT folded into either pole. Counting it green
 * hides an outage (what happened); counting it red pages someone about a check
 * that never ran. It gets its own place in the summary so a reader cannot
 * mistake "we did not look" for "we looked and it was fine".
 */
export function summarise(outcomes: CheckOutcomeLike[]): HealthReport {
  const checks = outcomes.map((o) => o.entry);
  const isUnknown = (e: HealthCheckEntry) => e.evaluated === false;

  // Top-level ok = AND of all NON-warn checks (shared contract). Warn-style
  // entries (tokenless bot_token_present, env_legacy nudge) are visible in
  // `checks` but never flip the aggregate. Unknowns never flip it either —
  // they are not failures.
  const failing = outcomes
    .filter((o) => !o.warn && !o.entry.ok && !isUnknown(o.entry))
    .map((o) => o.entry.name);
  const unknown = outcomes.filter((o) => isUnknown(o.entry)).map((o) => o.entry.name);
  const warned = outcomes
    .filter((o) => o.warn && (o.entry.hint !== null || !o.entry.ok))
    .map((o) => o.entry.name);
  const ok = failing.length === 0;

  const passed = checks.filter((c) => c.ok).length;
  const parts = [`${passed}/${checks.length} checks ok`];
  if (unknown.length > 0) parts.push(`unknown: ${unknown.join(", ")}`);
  if (failing.length > 0) parts.push(`FAILING: ${failing.join(", ")}`);
  if (warned.length > 0) parts.push(`warnings: ${warned.join(", ")}`);

  return {
    package: "claude-code-telegrammer",
    ok,
    checks,
    summary: parts.join("; "),
  };
}

/** Structural shape of a check outcome (avoids a cycle with health-checks.ts). */
export interface CheckOutcomeLike {
  entry: HealthCheckEntry;
  warn: boolean;
}
