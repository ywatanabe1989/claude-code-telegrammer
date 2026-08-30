/**
 * Ingestion-stall watchdog for the getUpdates poller (PR-A, 2026-07).
 *
 * Closes the failure mode liveness checks MISS: the poller PROCESS is
 * alive (kill-0 passes, the per-token pidfile records a live PID) yet no
 * messages are being ingested because the getUpdates call itself is
 * WEDGED — a network black-hole, a hung socket, or a long-poll whose
 * await never resolves. kill-0 says "healthy"; the operator's channel
 * goes silent. That silence must become LOUD.
 *
 * Two decoupled pieces:
 *
 *   1. HEARTBEAT — {@link recordSuccessfulPoll} stamps an in-process
 *      epoch-ms timestamp every time getUpdates RETURNS (throws or not is
 *      the caller's concern; a return of zero updates still counts — a
 *      healthy 30s long-poll returns at least that often). It also
 *      persists the stamp to the DB (best-effort) so an out-of-band probe
 *      can read poll-freshness later, mirroring how the offset persists.
 *
 *   2. WATCHDOG — {@link createStallWatchdog} builds a stateful checker
 *      whose `tick()` compares `now - lastSuccessfulPoll` against the
 *      threshold and, on a stall, LOGS it and fires the actuator (onStall)
 *      ONCE per stall episode. It does NOT message the operator — a
 *      self-healing stall is not actionable, and a stall-loop would flood him
 *      (see the rationale above stallDiagnostics). It re-arms automatically
 *      once a fresh poll advances the heartbeat, and never fires while the
 *      poller is shutting down (isPolling() === false). `now`, the heartbeat
 *      getter, and the onStall actuator are all injectable so the whole thing
 *      is unit-testable with no timers and no network.
 *
 * PR-A is DETECTION/ALARM ONLY. It deliberately does NOT add an
 * HTTP-level timeout to tgApi — that remains a noted follow-up.
 *
 * It DOES now auto-restart the bridge (2026-07-14): on stall the poller
 * self-terminates and lib/poller-supervisor.ts respawns it. The previous
 * behaviour — shout, then sit there wedged waiting for a human — is what made
 * this alarm ignorable. See selfTerminateForRespawn() below.
 */

import { log } from "./log.js";
import { BOT_TOKEN_HASH, STATE_DIR } from "./config.js";
import { saveLastPollTs } from "./store.js";
import { getenv } from "./env.js";
import { STALL_EXIT_CODE } from "./exit-codes.js";

/** Default stall threshold (seconds) — well above the 30s long-poll cap
 * plus the 3s error backoff margin, so a healthy loop never trips it. */
export const DEFAULT_STALL_SECONDS = 180;

/** Watchdog check cadence ceiling (ms). Actual cadence is
 * min(this, threshold/4) so a short threshold still gets ~4 checks. */
export const MAX_CHECK_INTERVAL_MS = 30_000;

// ── In-process heartbeat ────────────────────────────────────────────────────
//
// Module-level so the poll loop and the watchdog share it without
// threading a value through every call. Read via getLastSuccessfulPoll().
let lastSuccessfulPollMs = 0;

/**
 * Stamp "getUpdates just returned successfully" — call from the poll loop
 * right where a successful getUpdates resets consecutive409. Updates the
 * in-process heartbeat AND persists it (best-effort; a store error is
 * logged, never thrown — the poll loop must not die because a heartbeat
 * write failed).
 *
 * @param now Injectable epoch-ms clock (defaults to Date.now()).
 */
export async function recordSuccessfulPoll(
  now: number = Date.now(),
): Promise<void> {
  lastSuccessfulPollMs = now;
  try {
    await saveLastPollTs(now);
  } catch (err) {
    log("poller", "failed to persist last-poll heartbeat", {
      error: String(err),
    });
  }
}

/** Read the in-process heartbeat (epoch-ms of the last successful poll,
 * 0 if none yet). Exposed for the watchdog and for tests. */
export function getLastSuccessfulPoll(): number {
  return lastSuccessfulPollMs;
}

/** Test-only: reset the in-process heartbeat. */
export function _resetHeartbeat(): void {
  lastSuccessfulPollMs = 0;
}

/** Resolve the stall threshold (ms) from the env alias system.
 * `CCT_POLL_STALL_SECONDS` / `CLAUDE_CODE_TELEGRAMMER_POLL_STALL_SECONDS`;
 * empty/unset/invalid → {@link DEFAULT_STALL_SECONDS}. */
export function resolveStallThresholdMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = getenv("POLL_STALL_SECONDS", undefined, env);
  const secs = raw !== undefined ? Number(raw) : NaN;
  const eff = Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_STALL_SECONDS;
  return eff * 1000;
}

// ── Watchdog ────────────────────────────────────────────────────────────────

export interface StallWatchdogDeps {
  /** Epoch-ms clock (injectable for tests; defaults to Date.now). */
  now?: () => number;
  /** Heartbeat getter (defaults to the module in-process stamp). */
  getLastPoll?: () => number;
  /** True while the poller is actively polling; when false the watchdog
   * stays silent (clean shutdown / preemption must not alarm). */
  isPolling: () => boolean;
  /** Stall threshold in ms. */
  thresholdMs: number;
  /**
   * ACTUATOR — what to DO about a stall. This is the watchdog's ONLY output
   * besides the log line: there is no operator-message seam (see the rationale
   * block above stallDiagnostics — a self-healing stall must not reach the
   * phone). onStall self-terminates so the supervisor respawns.
   *
   * Defaults to a NO-OP on purpose: this factory is pure and unit-tested, and
   * a default that terminated the process would kill the test runner itself.
   * The production wiring is injected by startStallWatchdog() below, which is
   * the only caller that should ever be able to end the process.
   */
  onStall?: () => void;
}

export interface StallWatchdog {
  /** Run one stall check. Idempotent per episode: fires the alarm at most
   * once until a fresh poll re-arms it. */
  tick(): void;
}

/**
 * There is DELIBERATELY no operator-facing stall message anymore.
 *
 * A self-healing stall needs NO action from the operator — the watchdog
 * self-terminates (onStall) and lib/poller-supervisor.ts respawns. The
 * operator's rule, 2026-07-18, holding a screenshot of 8 of these in 6 minutes
 * (「こんなゴミみたいなメッセージが来ても困る」): 「対応不要なら送るべきでない」 —
 * if no action is needed, do not send. A stall that fixes itself is by
 * definition not actionable, so it must not reach his phone AT ALL, let alone
 * once per respawn.
 *
 * WHY THIS WAS SPAM: a stall-LOOP (the poller cannot recover — e.g. a token
 * contention 409ing every getUpdates) exits, respawns, and the fresh poller's
 * watchdog fires again ~one cycle later. The old code broadcast one "recovering
 * by itself" line per respawn, so an unrecoverable loop flooded the operator.
 * The watchdog now only LOGS (stallDiagnostics below) and acts; it has no
 * Telegram path at all — note there is no `emit` in StallWatchdogDeps and no
 * broadcastSystemAlert import in this file. The ONLY Telegram message about
 * stalls comes from the SUPERVISOR, which is bounded (#92): N silent respawns,
 * then ONE FATAL "died N times, not recovering, restart the MCP server" — the
 * single message that IS actionable. This fixes the SPAMMING alarm the way #92
 * fixed the FALSE alarm; both erode the one channel a real outage needs.
 */

/** The full diagnosis — for the poller log, not the operator's phone. */
function stallDiagnostics(stallMs: number, thresholdMs: number): object {
  return {
    stallMs,
    thresholdMs,
    tokenHash: BOT_TOKEN_HASH,
    stateDir: STATE_DIR,
    note:
      "process ALIVE but not polling; a liveness/kill-0 check would still " +
      "pass. Likely: network black-hole, hung socket, or a wedged long-poll " +
      "(the getUpdates await never resolved). Self-terminating for respawn.",
  };
}

/**
 * Re-exported for the poller's own use. The number itself, and the contract it
 * carries, live in lib/exit-codes.ts — the supervisor in the OTHER process
 * reads the same constant, which is the only thing that makes this exit code
 * mean anything. It used to be a private const here whose doc-comment claimed
 * it "distinguishes a watchdog self-terminate from a crash in the supervisor's
 * log" — while the supervisor never actually read it (#92).
 */
export { STALL_EXIT_CODE };

/**
 * Let the Telegram alert above actually leave the process before we exit.
 * Terminating in the same tick would kill the very send that explains why.
 * Matches the poller's own shutdown() grace.
 */
const STALL_EXIT_DELAY_MS = 2000;

/**
 * The ACTUATOR (grant, 2026-07-14 — the sharpest review note of the day).
 *
 * The alarm used to say "ACTION: restart the bridge to recover" and then leave
 * the bridge wedged, waiting for a human. grant put the problem exactly:
 *
 *     "an alarm with no actuator, that shouts and then leaves the bridge wedged
 *      for a human, will still get ignored eventually — not because it lies,
 *      but because it is not actionable by the agent that receives it."
 *
 * A wedged poller cannot fix itself in place: the getUpdates await will never
 * resolve, so there is nothing to retry from inside. But it CAN die — and
 * lib/poller-supervisor.ts (#82) already respawns a poller that exits with
 * nobody holding the pidfile, and now persists its stderr so the next one is
 * explainable.
 *
 * Detector we already had. Actuator we already had. This is the wire between
 * them, and it is the whole fix.
 */
function selfTerminateForRespawn(): void {
  setTimeout(() => process.exit(STALL_EXIT_CODE), STALL_EXIT_DELAY_MS);
}

/**
 * Create a stateful stall watchdog. Re-arm semantics live entirely in the
 * heartbeat value: each tick remembers the last heartbeat it saw; when a
 * newer heartbeat appears (a poll resumed) the "already alarmed" latch is
 * cleared, so a later stall alarms again. No coupling to the heartbeat
 * writer is needed.
 */
export function createStallWatchdog(deps: StallWatchdogDeps): StallWatchdog {
  const now = deps.now ?? Date.now;
  const getLastPoll = deps.getLastPoll ?? getLastSuccessfulPoll;
  const { isPolling, thresholdMs } = deps;

  const onStall = deps.onStall ?? (() => {});

  let alreadyAlarmed = false;
  let lastSeenPoll = getLastPoll();

  return {
    tick(): void {
      const lastPoll = getLastPoll();
      // A fresh poll advanced the heartbeat → the stall (if any) is over;
      // re-arm so a FUTURE stall alarms again.
      if (lastPoll > lastSeenPoll) {
        alreadyAlarmed = false;
      }
      lastSeenPoll = lastPoll;

      // Clean shutdown / preemption: never alarm once polling stops.
      if (!isPolling()) return;

      const stallMs = now() - lastPoll;
      if (stallMs > thresholdMs && !alreadyAlarmed) {
        // LOG the stall (with full diagnostics) and ACT — never message the
        // operator. A self-healing stall is not actionable by him, and a
        // stall-LOOP would flood his phone one line per respawn. The only
        // Telegram message about stalls is the supervisor's bounded FATAL when
        // recovery genuinely fails. See the rationale above stallDiagnostics.
        log("poll-watchdog", "INGESTION STALL — self-terminating for respawn", {
          ...stallDiagnostics(stallMs, thresholdMs),
        });
        alreadyAlarmed = true;
        // ...and then ACT. Detecting and doing nothing is what made the old
        // alarm ignorable in the first place (see onStall's docstring).
        onStall();
      }
    },
  };
}

export interface WatchdogHandle {
  /** Stop the interval so it can't leak or alarm after shutdown. */
  stop(): void;
}

/**
 * Production entry point: seed the heartbeat to "now" (so the first
 * threshold window starts at poll start, not epoch 0), start the
 * setInterval watchdog, and return a handle whose stop() clears it.
 * Called by startPolling; its stop() runs on every poll-loop exit path.
 */
export function startStallWatchdog(isPolling: () => boolean): WatchdogHandle {
  const thresholdMs = resolveStallThresholdMs();
  const checkIntervalMs = Math.min(MAX_CHECK_INTERVAL_MS, thresholdMs / 4);

  // Seed so the watchdog does not fire before the first getUpdates has had
  // a chance to return (heartbeat starts at 0 = "1970", which would look
  // like an infinite stall on the very first tick).
  recordSuccessfulPoll();

  const watchdog = createStallWatchdog({
    isPolling,
    thresholdMs,
    // The ONLY place the real actuator is wired. createStallWatchdog defaults
    // onStall to a no-op so no unit test can ever terminate the test runner.
    // There is no emit: the watchdog logs and acts, it does not message the
    // operator (see the rationale above stallDiagnostics).
    onStall: selfTerminateForRespawn,
  });

  log(
    "poller",
    `ingestion-stall watchdog armed (threshold ${Math.round(
      thresholdMs / 1000,
    )}s, checking every ${Math.round(checkIntervalMs / 1000)}s)`,
  );

  const handle = setInterval(() => watchdog.tick(), checkIntervalMs);
  // Do not keep the process alive solely for this timer.
  if (typeof handle === "object" && handle && "unref" in handle) {
    (handle as { unref: () => void }).unref();
  }

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
