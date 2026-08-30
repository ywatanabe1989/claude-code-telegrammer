/**
 * Cross-process poller supervisor for the MCP server process.
 *
 * Architecture fix (incident-cct-inbound-dies-silently-with-mcp-server-
 * 20260711 follow-up, 2026-07): the MCP server (ts/telegram-server.ts) no
 * longer runs the getUpdates poll loop on its own event loop — see
 * docs/architecture.md. Instead, at startup it calls ensurePollerRunning()
 * to check whether a standalone poller process (ts/telegram-poller.ts) is
 * already alive for this bot token (via the lib/takeover.ts per-token
 * pidfile) and, if not, spawns a fresh one DETACHED (stdio:"ignore",
 * detached:true) + unref()'d so the MCP server's own event loop never waits
 * on it. This is what makes the poller survive an MCP-server restart: an
 * MCP-child recycle (Claude Code restarting its own MCP child under host
 * load — the ORIGINAL incident) no longer tears down inbound Telegram
 * delivery, because the poller is a wholly separate OS process by then (see
 * telegram-server.ts's shutdown(), which no longer calls stopPolling() /
 * releaseAuthoritative() for exactly this reason).
 *
 * Every dependency is injectable so the conditional-spawn DECISION is unit-
 * testable without ever forking a real process — the same injectable-seam
 * pattern poller-batch.ts / poll-watchdog.ts already use for their own
 * network/timer/notification seams. The default spawn primitive is
 * Bun.spawn (this codebase is Bun-first throughout — Bun.SQL,
 * Bun.CryptoHasher, Bun.write — and has zero prior child_process usage to
 * follow instead), invoked via process.execPath (the actual bun binary
 * currently running us, resolved the same way the Python CLI wrapper's
 * _resolve_bun() avoids assuming "bun" is on PATH) rather than a bare
 * "bun" string.
 *
 * env is passed EXPLICITLY as `process.env` (empirically verified — see
 * ts/test/poller-supervisor.test.ts — NOT to be assumed): omitting the
 * `env` key entirely still inherits whatever was present in the OS
 * environment at THIS process's own startup, but does NOT reflect any
 * later runtime `process.env.X = ...` mutation, at least on Bun 1.3.11.
 * The realistic launch path (env vars set by the container/shell before
 * `bun run ts/telegram-server.ts` even starts) would have worked either
 * way, but making this explicit removes any doubt — this env is exactly
 * what scitex-agent-container's orphan reaper matches
 * SAC_NAME/SCITEX_AGENT_CONTAINER_NAME against (see lib/poller-teardown.ts)
 * to eventually reap this detached process on genuine agent teardown, so
 * "probably inherited" was not good enough here.
 */

import { openSync } from "fs";
import { newestCodeMtimeMs, pollerLogPath } from "./poller-paths.js";
import {
  pollerPidfilePath,
  readPidfile,
  isProcessMatching,
} from "./takeover.js";
import { log } from "./log.js";
import { broadcastSystemAlert } from "./loudfail.js";
import { STALL_EXIT_CODE, SIGTERM_EXIT } from "./exit-codes.js";
import {
  plannedRestartNote,
  standDownNote,
  crashAlarm,
  fatalAlarm,
} from "./supervisor-messages.js";

/** Minimal shape ensurePollerRunning needs from a spawned child handle —
 * satisfied by Bun.Subprocess, and trivially fakeable in tests. */
export interface SpawnedProcessHandle {
  pid: number;
  unref(): void;
  /** Resolves with the child's exit code once it exits — used for the
   * post-spawn grace-window death check (adversarial-review finding #4). */
  exited: Promise<number>;
}

/**
 * How long after a successful spawn() call an early exit is treated as a
 * POSSIBLE startup failure worth investigating (see the pidfile re-check
 * in the exit observer below — this window is NOT itself proof of a
 * crash). RECONCILED (round-2 adversarial review: two comments in this
 * file previously disagreed on this): a legitimate "newest wins" takeover
 * preemption (lib/takeover.ts::claimAuthoritative's SIGTERM) does NOT
 * happen "much later" — it happens as soon as a newer poller's own
 * startPolling() runs claimAuthoritative(), which is the FIRST thing that
 * function does, i.e. essentially immediately after that newer poller's
 * own process starts. Combined with the losing poller's own shutdown()
 * taking a fixed 2000ms (ts/telegram-poller.ts), a clean, correct
 * preemption routinely lands INSIDE this 3000ms window. That is exactly
 * why the exit observer below does not alert on aliveMs<graceMs alone.
 */
const SPAWN_GRACE_MS = 3000;

/**
 * How many times this MCP-server process will respawn a poller that died with
 * nobody taking over, before giving up LOUDLY.
 *
 * Bounded on purpose: a poller that crashes on every start (bad token, corrupt
 * DB, unwritable state dir) must not become a fork bomb. Five attempts absorbs
 * a transient crash; a genuinely broken poller stops and pages instead of
 * spinning in silence.
 */
const MAX_RESPAWNS = 5;

export interface EnsurePollerDeps {
  /** Absolute path to the standalone poller entrypoint script
   * (ts/telegram-poller.ts) to spawn when no live poller is found. */
  pollerScriptPath: string;
  stateDir: string;
  tokenHash: string;
  /** Injectable pidfile reader; defaults to the real lib/takeover.ts pidfile
   * at (stateDir, tokenHash). `startMs` is the incumbent's claim time, used
   * by the stale-code check below. */
  readPid?: (
    stateDir: string,
    tokenHash: string,
  ) => { pid: number; startMs?: number } | null;
  /** Injectable "when was the poller's code last modified" probe; defaults to
   * newestCodeMtimeMs(pollerScriptPath). Tests inject a fixed value rather
   * than touching real files. */
  codeMtimeMs?: () => number;
  /** Injectable liveness check; defaults to an IDENTITY-AWARE check
   * (lib/takeover.ts::isProcessMatching), not a bare kill(pid,0) — a stale
   * pidfile's PID can be reused by the OS for an unrelated process, which a
   * plain existence check can't tell apart from the real poller.
   *
   * NOTE (corrected): isProcessMatching checks BOTH the pollerScriptPath in
   * /proc/<pid>/cmdline AND the agent identity in /proc/<pid>/environ. The
   * cmdline alone is NOT agent-specific — an earlier comment claimed matching
   * "the full, agent-specific script path" closed the wrong-agent gap, but all
   * ~49 agents launch the SAME shared checkout, so every poller's cmdline is
   * identical. The reused pid could be ANOTHER agent's genuinely-running
   * poller; only the CCT_AGENT_ID/SAC_NAME environ match rules that out. */
  isAlive?: (pid: number) => boolean;
  /** Injectable spawn primitive; defaults to a detached Bun.spawn of
   * [process.execPath, "run", pollerScriptPath] with stderr appended to
   * logPath (so a dead poller can still say why it died). */
  spawn?: (cmd: string[], logPath?: string) => SpawnedProcessHandle;
  /** Injectable grace-window threshold (ms) for the post-spawn early-death
   * alert; defaults to SPAWN_GRACE_MS. Tests inject a tiny value instead
   * of waiting out the real 3s default. */
  graceMs?: number;
  logFn?: typeof log;
}

export type EnsurePollerResult =
  | { action: "already-running"; pid: number }
  | { action: "spawned"; pid: number }
  | { action: "spawn-failed"; error: string };

function defaultReadPid(
  stateDir: string,
  tokenHash: string,
): { pid: number; startMs: number } | null {
  return readPidfile(pollerPidfilePath(stateDir, tokenHash));
}

// Moved to lib/poller-paths.ts. Re-exported so existing importers (and their
// tests) keep resolving them from this module's public API. NOTE the shape:
// imported for THIS module's own callers below, and separately re-exported —
// a bare `export { x } from "./y.js"` would forward the name without binding
// it locally, leaving every internal call site undefined at runtime.
export { newestCodeMtimeMs, pollerLogPath };

function defaultSpawn(
  cmd: string[],
  logPath?: string,
): SpawnedProcessHandle {
  // detached:true (POSIX setsid) so the child survives this process exiting
  // /restarting; env:process.env EXPLICITLY (not omitted — see the module
  // header) so the spawned poller reliably carries SAC_NAME/
  // SCITEX_AGENT_CONTAINER_NAME and every CCT_*/CLAUDE_CODE_TELEGRAMMER_* var
  // this MCP-server process itself resolved from.
  //
  // STDERR IS NO LONGER DISCARDED (2026-07-14). It used to be "ignore", which
  // meant the poller's only channel for explaining itself went to /dev/null —
  // so when it died, the FATAL alert could only ever say "check the poller's
  // logs" about logs that did not exist. We hit exactly that today: the poller
  // vanished after 37 minutes and its cause of death was, by construction,
  // unrecoverable. lib/log.ts writes every entry to stderr, so appending it to
  // a file is the whole fix. stdin/stdout stay ignored: nothing reads them, and
  // an inherited pipe nobody drains is its own hang risk.
  let stderr: "ignore" | number = "ignore";
  if (logPath) {
    try {
      stderr = openSync(logPath, "a");
    } catch {
      // An unwritable log path must NOT stop the poller from starting —
      // degraded observability beats no inbound delivery at all.
      stderr = "ignore";
    }
  }

  return Bun.spawn(cmd, {
    stdio: ["ignore", "ignore", stderr],
    detached: true,
    env: process.env,
  });
}

/**
 * Ensure a standalone poller process is running for (stateDir, tokenHash).
 *
 * If the takeover.ts pidfile already records a live PID, this is a no-op —
 * an external poller is already running (most commonly: a PREVIOUS
 * telegram-server.ts incarnation's spawn, still alive across this MCP-server
 * restart, which is precisely the property this whole architecture change
 * exists to provide). Otherwise spawns a fresh detached poller process and
 * returns immediately without awaiting or otherwise waiting on it — the
 * newly-spawned poller performs its own "newest wins" takeover claim inside
 * startPolling() (lib/poller.ts, unchanged), so even a missed-liveness race
 * here (TOCTOU between the read and the spawn) self-heals: at worst two
 * pollers briefly race and the older one is preempted, never both running
 * forever.
 *
 * NOTED, NOT ACTED ON (adversarial review, follow-up pass): the SAME
 * TOCTOU also applies between two SEPARATE ensurePollerRunning() calls
 * (e.g. two near-simultaneous MCP-server starts) both reading "no live
 * poller" and both deciding to spawn. Reviewed and assessed as benign in
 * practice — the DB-level dedup (takeover.ts's pidfile "newest wins"
 * claim) plus the poll loop's own per-iteration isAuthoritative() check
 * already resolve it the same way, self-healing rather than silent. Left
 * as documented behaviour rather than adding a redundant guard here.
 */
export function ensurePollerRunning(
  deps: EnsurePollerDeps,
): EnsurePollerResult {
  const readPid = deps.readPid ?? defaultReadPid;
  // isProcessMatching verifies BOTH the script path (/proc/<pid>/cmdline) AND
  // the agent identity (/proc/<pid>/environ CCT_AGENT_ID/SAC_NAME). The path is
  // NOT agent-specific — all ~49 agents share one checkout, so a reused pid on
  // ANOTHER agent's genuinely-running poller matches the cmdline; only the
  // identity check rules it out. (An earlier comment credited the script path
  // with closing that gap; it did not — the path is fleet-wide.)
  const isAlive =
    deps.isAlive ??
    ((pid: number) => isProcessMatching(pid, deps.pollerScriptPath));
  const spawn = deps.spawn ?? defaultSpawn;
  const graceMs = deps.graceMs ?? SPAWN_GRACE_MS;
  const logFn = deps.logFn ?? log;

  const snap = readPid(deps.stateDir, deps.tokenHash);
  if (snap && isAlive(snap.pid)) {
    // STALE-CODE TAKEOVER (incident-cct-operator-messages-not-arriving-
    // 20260714). Surviving an MCP-server restart is the whole point of the
    // detached poller — but it means the poller ALSO survives a code update,
    // so "restart the server to deploy" silently does nothing to it. Every
    // agent on this host launches the SAME checkout
    // (/home/ywatanabe/proj/claude-code-telegrammer), so a `git pull` would
    // otherwise leave 49 pollers running pre-pull code indefinitely, with a
    // freshly-updated MCP server sitting next to each one and no signal that
    // the two disagree. That is exactly the drift that produced this incident
    // (v0.5.6 was released, merged and NEVER running).
    //
    // If any poller source file was modified after the incumbent claimed the
    // pidfile, it cannot have loaded that code. Fall through and spawn: the
    // new poller's claimAuthoritative() wins the pidfile and the incumbent
    // stands down on its next per-iteration isAuthoritative() check
    // (lib/poller.ts), which is the takeover path this design already has.
    //
    // FAIL-SAFE, deliberately: only when we can positively establish
    // staleness (both timestamps known, code strictly newer). A failed stat
    // (0) or an unparseable startMs (0) leaves the incumbent ALONE — an
    // unnecessary respawn of a healthy poller is worse than a late deploy.
    // This cannot loop, though no longer because the call is one-shot:
    // startPollerSupervision() below re-runs it on an interval. It converges
    // instead — the takeover spawn's pidfile startMs is newer than the code
    // mtime that triggered it, so the next tick reads isStale=false. Asserted
    // in test/poller-supervision.test.ts, not merely reasoned about here.
    const codeMtimeMs = (
      deps.codeMtimeMs ?? (() => newestCodeMtimeMs(deps.pollerScriptPath))
    )();
    const startMs = snap.startMs ?? 0;
    const isStale = codeMtimeMs > 0 && startMs > 0 && codeMtimeMs > startMs;

    if (!isStale) {
      logFn(
        "poller-supervisor",
        "external poller already running — not spawning a new one",
        { pid: snap.pid },
      );
      return { action: "already-running", pid: snap.pid };
    }

    logFn(
      "poller-supervisor",
      "live poller is running STALE code (its source was modified after it " +
        "started) — spawning a replacement to take over the pidfile",
      {
        stale_pid: String(snap.pid),
        poller_started_at: new Date(startMs).toISOString(),
        code_modified_at: new Date(codeMtimeMs).toISOString(),
      },
    );
  }

  // The spawn call itself can throw (missing binary, exhausted process
  // limits, bad script path, ...) — this must be LOUD, not silent
  // (adversarial-review finding #4): fire-and-forget was previously wired
  // with no try/catch anywhere in the chain, so a failed spawn would
  // vanish until the next MCP-server restart with nobody the wiser.
  let child: SpawnedProcessHandle;
  try {
    child = spawn(
      [process.execPath, "run", deps.pollerScriptPath],
      pollerLogPath(deps.stateDir, deps.tokenHash),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const msg =
      `FATAL: failed to spawn the standalone poller process ` +
      `(${deps.pollerScriptPath}): ${errMsg} — inbound Telegram delivery ` +
      `is NOT running.`;
    logFn("poller-supervisor", msg);
    void broadcastSystemAlert(msg);
    return { action: "spawn-failed", error: errMsg };
  }
  child.unref();
  logFn("poller-supervisor", "spawned standalone poller process", {
    pid: child.pid,
    script: deps.pollerScriptPath,
  });

  // Grace-window death check: a child that exits within SPAWN_GRACE_MS of
  // being spawned is a POSSIBLE sign of an immediate startup failure (e.g.
  // issue #1's migration race, before it was fixed, or any other early
  // crash) — but NOT proof of one. A legitimate "newest wins" takeover
  // preemption (claimAuthoritative()'s SIGTERM, lib/takeover.ts) routinely
  // lands inside this same window (see SPAWN_GRACE_MS's docstring above —
  // it does NOT happen "much later" as an earlier version of this comment
  // wrongly claimed). Round-2 adversarial review finding #2: alerting on
  // aliveMs<graceMs ALONE would cry wolf on that entirely correct,
  // self-healing outcome (a newer poller is alive and driving delivery
  // just fine under a different PID) — exactly the kind of false alarm
  // that undercuts trust in every OTHER alert this PR adds. So before
  // alerting, re-read the pidfile: if it now names a DIFFERENT, live PID,
  // that's the signature of a legitimate takeover, not a crash — log it
  // quietly and do not page anyone. Best-effort throughout: logged +
  // alerted (or not), never thrown — this must not crash the caller.
  const spawnedAt = Date.now();
  observePollerExit(child, spawnedAt, deps, {
    readPid,
    isAlive,
    spawn,
    graceMs,
    logFn,
  });

  return { action: "spawned", pid: child.pid };
}

/** Resolved deps, threaded through the exit observer so it can respawn. */
interface ResolvedDeps {
  readPid: (
    stateDir: string,
    tokenHash: string,
  ) => { pid: number; startMs?: number } | null;
  isAlive: (pid: number) => boolean;
  spawn: (cmd: string[]) => SpawnedProcessHandle;
  graceMs: number;
  logFn: typeof log;
}

/**
 * Watch a spawned poller FOR ITS WHOLE LIFE, and heal it if it dies.
 *
 * THE BUG THIS REPLACES (found the hard way, 2026-07-14 — it fired live while
 * the incident it belongs to was still open):
 *
 *     if (aliveMs >= graceMs) return; // ordinary lifecycle — nothing to check
 *
 * Any poller death more than 3 seconds after spawn was silently ignored. A
 * poller that ran for 37 minutes and then died was "ordinary lifecycle". It was
 * not: inbound Telegram delivery simply STOPPED, with
 *
 *   - no alarm      (this early-return),
 *   - no log        (the poller is spawned stdio:"ignore", so its stderr — the
 *                    only place it explains itself — goes to /dev/null),
 *   - no watchdog   (poll-watchdog.ts runs INSIDE the poller, so it dies with
 *                    the very process it exists to watch),
 *   - no respawn    (ensurePollerRunning only runs at MCP-server startup).
 *
 * Four independent safety nets, all downstream of the process being alive. The
 * operator saw silence and had no way to tell it from us having nothing to say —
 * which is the ENTIRE incident this file was written for, recurring in a new
 * shape after the first fix.
 *
 * The age gate bought nothing anyway: the thing that actually distinguishes a
 * crash from a legitimate "newest wins" takeover is whether a DIFFERENT live
 * poller now holds the pidfile, and that question is just as answerable at 37
 * minutes as at 300ms. So ask it at any age.
 *
 * "...and treat every other exit as what it is — an outage." That is what this
 * comment used to say, and it was a boolean over three states. An exit is a
 * TAKEOVER (someone else holds the pidfile), a PLANNED restart (STALL_EXIT_CODE
 * — the watchdog asking to be respawned, having already told the operator so),
 * or a CRASH. Collapsing the middle into "outage" made every successful
 * self-heal page the operator with a contradiction and a falsehood — the exact
 * false alarm the takeover branch below already knew to avoid (#92).
 */
function observePollerExit(
  child: SpawnedProcessHandle,
  spawnedAt: number,
  deps: EnsurePollerDeps,
  r: ResolvedDeps,
  respawnsSoFar = 0,
): void {
  void child.exited
    .then((code) => {
      const aliveMs = Date.now() - spawnedAt;

      // A DIFFERENT live poller holds the pidfile ⇒ legitimate newest-wins
      // takeover (claimAuthoritative()'s preemption, or a stale-code takeover
      // that can preempt an incumbent hours old). Delivery is still running
      // under another PID. Do not page anyone — a false alarm here is what
      // teaches people to ignore the alarm that matters.
      const current = r.readPid(deps.stateDir, deps.tokenHash);
      if (current && current.pid !== child.pid && r.isAlive(current.pid)) {
        r.logFn(
          "poller-supervisor",
          "poller exited but a DIFFERENT live poller now holds the pidfile — " +
            "legitimate newest-wins takeover, not a crash; delivery is still " +
            "running",
          {
            exitedPid: child.pid,
            currentPid: current.pid,
            aliveMs,
            exitCode: code,
          },
        );
        return;
      }

      // Nobody took over. Four exits now — see lib/exit-codes.ts and
      // lib/supervisor-messages.ts.
      const lived = aliveMs < r.graceMs ? `only ${aliveMs}ms` : `${aliveMs}ms`;

      // DELIBERATE STOP: SIGTERM(143) + no successor = sac stopping this poller
      // on purpose (contract: SIGTERM means stay dead, sac owns the restart —
      // SIGTERM_EXIT in lib/exit-codes.ts). Stand down; respawning would fight
      // the terminator and loop against a reaper. BEFORE the crash/MAX paths: a
      // deliberate stop wins regardless of respawnsSoFar. SIGKILL(137) is
      // involuntary and falls through to the crash path (respawn + page).
      if (code === SIGTERM_EXIT) {
        r.logFn("poller-supervisor", standDownNote(child.pid, lived), {
          exitedPid: child.pid,
          exitCode: code,
          successorHeldPidfile: false,
          decision: "stand-down",
        });
        return;
      }

      if (respawnsSoFar >= MAX_RESPAWNS) {
        const msg = fatalAlarm(child.pid, code, lived, respawnsSoFar);
        r.logFn("poller-supervisor", msg);
        void broadcastSystemAlert(msg);
        return;
      }

      // PLANNED: the poller's own stall watchdog exits STALL_EXIT_CODE to ASK
      // for this respawn, and it has already told the operator it is recovering
      // by itself. Respawn and stay off his channel — a second message calling
      // the same event an outage would contradict the first, and it would be
      // false besides: the respawn is right below.
      if (code === STALL_EXIT_CODE) {
        r.logFn("poller-supervisor", plannedRestartNote(child.pid, lived), {
          exitedPid: child.pid,
          aliveMs,
          exitCode: code,
          respawnsSoFar,
        });
      } else {
        const msg = crashAlarm(
          child.pid,
          code,
          lived,
          respawnsSoFar + 1,
          MAX_RESPAWNS,
        );
        r.logFn("poller-supervisor", msg);
        void broadcastSystemAlert(msg);
      }

      // Self-heal. Bounded: a poller that crashes on every start must not turn
      // into a fork bomb, so give up loudly after MAX_RESPAWNS rather than
      // retrying forever in silence.
      let replacement: SpawnedProcessHandle;
      try {
        replacement = r.spawn(
          [process.execPath, "run", deps.pollerScriptPath],
          pollerLogPath(deps.stateDir, deps.tokenHash),
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failMsg =
          `FATAL: failed to RESPAWN the poller after it died ` +
          `(${deps.pollerScriptPath}): ${errMsg} — inbound Telegram delivery ` +
          `is NOT running.`;
        r.logFn("poller-supervisor", failMsg);
        void broadcastSystemAlert(failMsg);
        return;
      }
      replacement.unref();
      r.logFn("poller-supervisor", "respawned the standalone poller", {
        pid: replacement.pid,
        attempt: respawnsSoFar + 1,
      });
      observePollerExit(replacement, Date.now(), deps, r, respawnsSoFar + 1);
    })
    .catch((err) => {
      // .exited itself rejecting is exotic but must not go unnoticed either.
      r.logFn("poller-supervisor", "failed to observe spawned poller exit", {
        pid: child.pid,
        error: String(err),
      });
    });
}

// ── Periodic supervision ─────────────────────────────────────────────────
//
// ensurePollerRunning() above runs ONCE per MCP-server start. That is enough to
// supervise a poller THIS incarnation spawned: observePollerExit() holds its
// `exited` handle and respawns it up to MAX_RESPAWNS. It is NOT enough for the
// poller we ADOPT on the "already-running" path — that branch returns with no
// handle and no observer — and adoption is the designed-NORMAL case, because
// surviving an MCP-server restart is the entire point of the detached poller
// (see ts/telegram-poller.ts). Every MCP restart after the first therefore
// hands us a poller nobody is watching.
//
// MEASURED on this host 2026-08-19, rather than inferred from the code:
//   - a live poller's parent is `appinit`, the apptainer container init. It
//     reaps children; it never respawns them.
//   - no systemd unit and no crontab entry matches telegram/cct.
//   - ensurePollerRunning has exactly one call site (ts/telegram-server.ts).
// So when an adopted poller dies, NOTHING replaces it: inbound Telegram
// delivery stops and stays stopped until a human restarts the MCP server. That
// is the "exits for respawn, nothing respawns it" defect.
//
// Re-asking on an interval is what closes it. The pidfile probe
// ensurePollerRunning already performs IS the liveness question; asking it
// repeatedly costs one /proc read per tick and needs no new component. The
// alternative — an external supervisor — would itself be a thing that must be
// verified alive at startup, which is the same problem one level up.
export const SUPERVISION_INTERVAL_MS = 30_000;

/**
 * How many consecutive ticks may end in a spawn before supervision stops and
 * pages instead.
 *
 * A healthy tick observes "already-running" and RESETS this counter, so a
 * steady-state poller never approaches the cap however long it runs. Only a
 * poller that dies faster than the interval can climb it — i.e. a crash loop —
 * and that must page a human rather than respawn forever. Same reasoning, and
 * same number, as MAX_RESPAWNS.
 */
export const MAX_SUPERVISION_SPAWNS = 5;

export interface SupervisionState {
  /** Consecutive ticks that had to spawn (reset by any healthy observation). */
  consecutiveSpawns: number;
  /** Once true, supervision has paged and stops acting. */
  gaveUp: boolean;
}

export function initialSupervisionState(): SupervisionState {
  return { consecutiveSpawns: 0, gaveUp: false };
}

/**
 * Fold one ensurePollerRunning() result into the supervision state.
 *
 * Pure and separate from the timer on purpose — this is the DECISION, and it is
 * unit-testable without waiting 30 real seconds, matching how the conditional
 * spawn above is already factored.
 */
export function superviseTick(
  state: SupervisionState,
  result: EnsurePollerResult,
  maxSpawns: number = MAX_SUPERVISION_SPAWNS,
): { state: SupervisionState; alert?: string } {
  if (state.gaveUp) return { state };

  // A live poller is the healthy outcome whether we adopted it or our own
  // previous tick produced it. Either way the rail is up: forget the history.
  if (result.action === "already-running") {
    return { state: { consecutiveSpawns: 0, gaveUp: false } };
  }

  const consecutiveSpawns = state.consecutiveSpawns + 1;
  if (consecutiveSpawns >= maxSpawns) {
    const why =
      result.action === "spawn-failed"
        ? `the last spawn failed outright (${result.error})`
        : "each spawned poller died before the next check";
    return {
      state: { consecutiveSpawns, gaveUp: true },
      alert:
        `GIVING UP ON THE POLLER: ${consecutiveSpawns} consecutive supervision ticks had to start one and ` +
        `${why}. Inbound Telegram delivery is DOWN and this process will stop trying — ` +
        "a crash loop must page a human, not respawn forever. Check the poller log, then restart the MCP server.",
    };
  }
  return { state: { consecutiveSpawns, gaveUp: false } };
}

/**
 * Start supervising the standalone poller for the life of this MCP server.
 *
 * Replaces the old one-shot ensurePollerRunning() call: the FIRST check still
 * runs immediately, so boot behaviour and start latency are unchanged, and only
 * the re-checks are new.
 *
 * Convergence with the STALE-CODE TAKEOVER branch above deserves a word, since
 * that branch's comment used to rely on "this cannot loop: ensurePollerRunning
 * runs once per MCP-server start" — a premise this function removes. It still
 * cannot loop, for a different reason: a stale incumbent is replaced by a spawn
 * whose pidfile startMs is NEWER than the code mtime that triggered it, so the
 * very next tick reads isStale=false and takes the already-running path. One
 * takeover, not one per tick. That is asserted by test, not by this paragraph.
 */
export function startPollerSupervision(
  deps: EnsurePollerDeps,
  opts: {
    intervalMs?: number;
    maxSpawns?: number;
    ensure?: (d: EnsurePollerDeps) => EnsurePollerResult;
  } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? SUPERVISION_INTERVAL_MS;
  const ensure = opts.ensure ?? ensurePollerRunning;
  const logFn = deps.logFn ?? log;
  let state = initialSupervisionState();

  const tick = (): void => {
    if (state.gaveUp) return;
    const next = superviseTick(state, ensure(deps), opts.maxSpawns);
    state = next.state;
    if (next.alert) {
      logFn("poller-supervisor", next.alert);
      void broadcastSystemAlert(next.alert);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  // Never hold the process open on supervision's account — the MCP stdio
  // connection owns lifetime here, and a live interval would outlive it.
  (timer as unknown as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
}
