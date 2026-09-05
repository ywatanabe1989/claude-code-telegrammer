/**
 * Per-bot-token "newest wins" poller takeover.
 *
 * Background (operator pain, 2026-06-07):
 *   Restarting an agent's container does NOT reliably kill the previous
 *   `bun run telegram-server.ts` poller — Apptainer + tini leave it as an
 *   orphan attached to the host. The next start spawns a NEW poller for
 *   the same bot token; Telegram's getUpdates only allows ONE consumer
 *   per token, so both end up in a 409 conflict loop and the operator's
 *   messages are silently dropped (no 👀 reaction, no reply).
 *
 *   The previous behaviour ("oldest wins" — old poller holds the lock,
 *   new one exits) makes this WORSE: the live, current process loses to
 *   a dead-parent zombie that nothing will ever clean up.
 *
 * Fix:
 *   This module implements "newest wins" via a per-token pidfile.
 *
 *     - claimAuthoritative()  : write our (pid, startMs) into the
 *                               pidfile, atomically replacing whatever
 *                               was there. Best-effort SIGTERM the
 *                               outgoing PID so it can shut down cleanly
 *                               instead of waiting for its next poll
 *                               iteration to notice.
 *     - isAuthoritative()     : read the pidfile and return true iff our
 *                               pid is still the one recorded.
 *     - releaseAuthoritative(): unlink the pidfile (only if we still own
 *                               it; never tear down someone else's
 *                               claim).
 *
 *   The polling loop (poller.ts) calls isAuthoritative() every iteration.
 *   When a newer poller starts up, it overwrites the pidfile; the
 *   incumbent's NEXT loop tick sees its pid is no longer recorded and
 *   exits cleanly — no 409 storm, no orphan.
 *
 *   SIGTERM is best-effort because the incumbent may live in a different
 *   PID namespace (apptainer container vs host vs sibling container);
 *   the pidfile-polling-loop fallback works regardless of namespace as
 *   long as the filesystem path is bind-mounted into both.
 *
 * Pidfile format (newline-separated, plaintext, ASCII):
 *     <pid>
 *     <startMs>
 *
 *   startMs is Date.now() at claim time. Used purely for observability
 *   ("how old is the current claim?") — the takeover protocol itself
 *   only needs the pid line.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

/** Result of reading the pidfile. null when no pidfile / unparseable. */
export interface PidfileSnapshot {
  pid: number;
  startMs: number;
}

/**
 * Compute the canonical pidfile path for a given (stateDir, tokenHash).
 * Public so tests can exercise the path-construction rule directly.
 */
export function pollerPidfilePath(stateDir: string, tokenHash: string): string {
  return join(stateDir, `poller-${tokenHash}.pid`);
}

/**
 * Read the pidfile at `path`. Returns null when:
 *   - the file does not exist,
 *   - the file content is not a parseable (pid, startMs) pair,
 *   - any other read error occurs (best-effort).
 */
export function readPidfile(path: string): PidfileSnapshot | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 1) return null;
  const pid = parseInt(lines[0]!.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const startMs = lines[1] !== undefined ? parseInt(lines[1].trim(), 10) : 0;
  return {
    pid,
    startMs: Number.isFinite(startMs) ? startMs : 0,
  };
}

/**
 * Returns true iff `pid` exists. Throws nothing — best-effort.
 *
 * "I ASKED AND GOT NOTHING" IS NOT "DEAD" (sac, 2026-07-14, after their health
 * watchdog killed a healthy daemon for exactly this). kill(pid, 0) has two
 * distinct failure modes and the old bare `catch` swallowed both:
 *
 *   ESRCH — no such process.                      -> genuinely DEAD.
 *   EPERM — the process EXISTS, we may not signal  -> ALIVE, just not ours.
 *
 * Reporting EPERM as dead is a lie about the world, and here it is a dangerous
 * one: a "dead" verdict makes checkAuthority() return `stale`, which makes the
 * poll loop RE-CLAIM the pidfile — so a second poller would start against a bot
 * token that already has a live consumer, and Telegram answers that with a 409
 * Conflict storm (getUpdates is single-consumer).
 *
 * HONESTY ABOUT SCOPE: this is LATENT, not a bug I reproduced. Every cct process
 * runs as the same user, and I could not provoke an EPERM here (even root-owned
 * pid 1 is signalable in this container). isProcessMatching() also verifies
 * /proc/<pid>/cmdline, which independently rejects a foreign process. So nothing
 * is known to be broken today.
 *
 * It is fixed anyway because a bare `catch` that collapses a distinguishable
 * error into a wrong answer is a silent fallback on the liveness check that
 * guards the operator's only channel — and today proved, three times over, what
 * collapsing distinct states into one bit costs.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it IS there. Anything else (ESRCH, and any exotic errno we
    // cannot interpret) is treated as gone — the fail-safe direction, since a
    // false "alive" only delays a takeover, while a false "dead" duplicates a
    // poller.
    return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/**
 * Distinctive cmdline substrings for identity verification beyond plain
 * PID existence (see isProcessMatching). Chosen to match what scitex-
 * agent-container's own orphan reaper
 * (_lifecycle/_orphan_mcp_cleanup.py::kill_orphan_mcp_children) already
 * looks for in a process's cmdline — one shared source of truth for
 * "is this really ours", not two different heuristics maintained
 * separately.
 */
export const POLLER_CMDLINE_MARKER = "telegram-poller";
export const SERVER_CMDLINE_MARKER = "telegram-server";

// Cached once at module load: does this host even have /proc? Avoids a
// syscall per check on platforms where /proc never exists (e.g. macOS).
const HAS_PROC = existsSync("/proc");

/**
 * Read one process's fleet agent-identity marker from /proc/<pid>/environ.
 * Returns "" if the process carries no marker. Same resolution order as
 * {@link ownAgentId}: CCT_AGENT_ID first, then SAC_NAME (the marker
 * lib/poller-teardown.ts already keys on). Split out as a pure parser so the
 * decision logic and the syscall are testable apart.
 */
export function agentIdFromEnviron(environ: string): string {
  let sacName = "";
  for (const entry of environ.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const val = entry.slice(eq + 1);
    if (key === "CCT_AGENT_ID" && val) return val; // preferred, short-circuit
    if (key === "SAC_NAME" && val) sacName = val; // fallback if no CCT_AGENT_ID
  }
  return sacName;
}

/** This process's own agent identity, or "" if it has none (dev / single-agent
 * / not sac-launched). Same resolution order as agentIdFromEnviron. */
function ownAgentId(): string {
  return process.env.CCT_AGENT_ID || process.env.SAC_NAME || "";
}

/**
 * Decide whether a live, cmdline-matching pid is OUR agent's poller, given our
 * own identity and the target's environ blob (null = unreadable).
 *
 * This exists because the cmdline check ALONE is not enough on this fleet: all
 * ~49 agents launch the SAME shared checkout, so every agent's poller has an
 * IDENTICAL cmdline. A cmdline match therefore does NOT prove the pid is ours —
 * a stale pidfile whose pid the OS reused for ANOTHER agent's poller would pass
 * it, and the supervisor/health would report "alive & ours" while OUR inbound
 * is dead. (The old comment claimed the script path was "agent-specific" and
 * closed this gap; the path is fleet-wide and closed nothing.)
 *
 * Bias unchanged from isProcessMatching: a false-negative is cheap (one extra
 * bounded respawn, self-heals via newest-wins), a false "alive & ours" is the
 * silent outage. So:
 *   - no own identity     -> true  (cannot verify; do not regress dev/single-agent)
 *   - environ unreadable  -> false (fail closed: unverifiable is treated as not-ours)
 *   - target carries no id -> true (cannot disprove ownership; the cmdline stands)
 *   - target id present   -> must equal ours, else false (the gap this closes)
 */
export function matchesAgentIdentity(
  expectedAgentId: string,
  targetEnviron: string | null,
): boolean {
  if (!expectedAgentId) return true;
  if (targetEnviron === null) return false;
  const theirId = agentIdFromEnviron(targetEnviron);
  if (!theirId) return true;
  return theirId === expectedAgentId;
}

/**
 * Identity-aware liveness check beyond isPidAlive's plain existence test.
 *
 * Two independent reasons a live pid might NOT be our poller, both checked:
 *   1. PID REUSE: a stale pidfile's PID gets recycled by the OS for an
 *      unrelated process. The /proc/<pid>/cmdline check rejects that.
 *   2. WRONG AGENT: because all ~49 agents run the SAME checkout, a cmdline
 *      match is fleet-wide, not agent-specific — the recycled pid could be
 *      ANOTHER agent's (genuinely-running) poller. The agent-identity check
 *      (matchesAgentIdentity, via /proc/<pid>/environ) rejects that. Without
 *      it, the supervisor and health-adapters (both call this ONE function)
 *      would report our inbound "alive" off another agent's process.
 *
 * Biased toward FALSE NEGATIVES on purpose: concluding "not ours" merely
 * triggers a bounded respawn (self-heals via the newest-wins protocol below);
 * concluding "alive and ours" wrongly is the silent, unrecoverable-until-
 * restart outage this exists to prevent. Unreadable cmdline/environ, or a
 * mismatched identity, therefore returns false — never "assume it's fine".
 *
 * `expectedAgentId` defaults to this process's own identity; injectable for
 * tests. On a platform with no /proc (checked once at module load), falls back
 * to the plain existence check rather than making non-Linux hosts distrust
 * their own processes.
 */
export function isProcessMatching(
  pid: number,
  cmdlineSubstring: string,
  expectedAgentId: string = ownAgentId(),
): boolean {
  if (!isPidAlive(pid)) return false;
  if (!HAS_PROC) return true;
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return false;
  }
  if (!cmdline.includes(cmdlineSubstring)) return false;
  // cmdline is fleet-wide identical (shared checkout) — verify AGENT IDENTITY
  // before trusting this pid as ours. See matchesAgentIdentity.
  let environ: string | null;
  try {
    environ = readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch {
    environ = null;
  }
  return matchesAgentIdentity(expectedAgentId, environ);
}

/**
 * Atomically (best-effort) claim authoritativeness for `tokenHash` from
 * inside `stateDir`. Returns a snapshot of the OUTGOING claim (the
 * record that was in the pidfile before we wrote ours), or null if the
 * pidfile was absent / unparseable.
 *
 * Side effects:
 *   1. mkdir -p stateDir
 *   2. read pidfile (capture outgoing snapshot for the caller)
 *   3. if outgoing.pid is alive AND outgoing.pid !== our pid → send
 *      SIGTERM to it (best-effort; ignores ESRCH / EPERM / namespace
 *      isolation). The outgoing poller's signal handler shuts it down
 *      cleanly.
 *   4. write our pidfile (overwriting any previous content) with our
 *      pid on line 1 and the supplied startMs on line 2.
 *
 * `startMs` defaults to Date.now(). Tests pass a deterministic value.
 * `signalOutgoing` defaults to true; tests can pass false to verify the
 * pidfile is rewritten even when no signal is sent.
 */
export type ClaimOutgoingVerdict =
  | "signalled" // a live poller of this agent held the pidfile: SIGTERMed
  | "stale-pid-not-a-poller" // the pid exists but is some other process: NOT signalled
  | "dead"; // nothing at that pid

export function claimAuthoritative(opts: {
  stateDir: string;
  tokenHash: string;
  pid?: number;
  startMs?: number;
  signalOutgoing?: boolean;
  /** Observability seam: told what became of the outgoing record. */
  report?: (verdict: ClaimOutgoingVerdict, outgoing: PidfileSnapshot) => void;
}): PidfileSnapshot | null {
  const pid = opts.pid ?? process.pid;
  const startMs = opts.startMs ?? Date.now();
  const signal = opts.signalOutgoing ?? true;
  const path = pollerPidfilePath(opts.stateDir, opts.tokenHash);

  mkdirSync(opts.stateDir, { recursive: true });

  const outgoing = readPidfile(path);

  // IDENTITY, NOT EXISTENCE, decides whether the outgoing pid gets a signal.
  // Measured 2026-09-05 on scitex-compute-04 (agent scitex-cards, three
  // container restarts in one day): this pidfile lives in the agent's state
  // dir, which SURVIVES a container restart, while the container's pid
  // namespace does not. A restarted container hands its low pids out again
  // within seconds, in the same burst that spawns the MCP servers and their
  // pollers - so the stale pid in the file was reassigned to the telegram MCP
  // SERVER itself, spawned a few pids before its own poller. The old check
  // here (isPidAlive: kill(pid, 0)) saw "exists" and SIGTERMed it: the poller
  // killed its own parent ~1 s after start, and the session reported
  // CONNECTION_CLOSED. Two restarts died that way (stale 182, stale 179); the
  // one that survived had read a stale pid (256) above the burst. This is the
  // "recycled pid" hypothesis in telegram-server.ts's shutdown() comment, with
  // the container twist that makes it deterministic rather than rare.
  //
  // isProcessMatching already does the right thing - alive AND cmdline is a
  // poller AND environ carries our agent id - and was simply not consulted on
  // this path. A pid that fails it is a stale record to overwrite silently,
  // never a process to signal.
  if (signal && outgoing && outgoing.pid !== pid) {
    if (!isPidAlive(outgoing.pid)) {
      opts.report?.("dead", outgoing);
    } else if (!isProcessMatching(outgoing.pid, POLLER_CMDLINE_MARKER)) {
      opts.report?.("stale-pid-not-a-poller", outgoing);
    } else {
      try {
        process.kill(outgoing.pid, "SIGTERM");
      } catch {
        // best-effort - outgoing may be in another PID namespace
      }
      opts.report?.("signalled", outgoing);
    }
  }

  // Atomic-ish overwrite: write tmp + rename. Same-filesystem rename is
  // atomic on POSIX, so a reader either sees the old or the new pidfile,
  // never a partial write.
  const tmp = `${path}.tmp.${pid}.${startMs}`;
  writeFileSync(tmp, `${pid}\n${startMs}\n`, { mode: 0o600 });
  renameSync(tmp, path);

  return outgoing;
}

/**
 * Returns true iff the pidfile still records `pid` as the authoritative
 * owner. The polling loop calls this once per iteration; a newer poller
 * having overwritten the pidfile flips this to false and the incumbent
 * exits cleanly without producing a 409 storm.
 */
export function isAuthoritative(opts: {
  stateDir: string;
  tokenHash: string;
  pid?: number;
}): boolean {
  const pid = opts.pid ?? process.pid;
  const path = pollerPidfilePath(opts.stateDir, opts.tokenHash);
  const snap = readPidfile(path);
  if (!snap) return false;
  return snap.pid === pid;
}

/**
 * Why the pidfile does not name us — the distinction isAuthoritative() throws
 * away, and the one that cost the operator his inbound channel repeatedly on
 * 2026-07-14.
 *
 *   "ours"      — the pidfile records us. Keep polling.
 *   "preempted" — it records a DIFFERENT pid. A newer poller genuinely won the
 *                 race; stand down immediately so we never issue another
 *                 getUpdates and start a 409 storm against the new incumbent.
 *   "vacant"    — there is NO pidfile. Nobody preempted us. Nobody owns it.
 *
 * isAuthoritative() collapses "vacant" and "preempted" into a single `false`,
 * and the poll loop then logged "preempted by newer poller" and killed itself.
 * But a file that VANISHED is not a successor. Deleting a file must never kill
 * a healthy process — and it did: the log shows a poller exiting "cleanly"
 * while its replacement started up finding "no prior poller recorded", i.e.
 * nobody had taken over at all. Inbound Telegram delivery just stopped.
 */
export type AuthorityState =
  | { kind: "ours" }
  | { kind: "vacant" }
  | { kind: "stale"; byPid: number }
  | { kind: "preempted"; byPid: number };

export function checkAuthority(opts: {
  stateDir: string;
  tokenHash: string;
  pid?: number;
  /** Injectable liveness probe (tests); defaults to a kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
}): AuthorityState {
  const pid = opts.pid ?? process.pid;
  const alive = opts.isAlive ?? isPidAlive;

  const snap = readPidfile(pollerPidfilePath(opts.stateDir, opts.tokenHash));
  if (!snap) return { kind: "vacant" };
  if (snap.pid === pid) return { kind: "ours" };

  // A pidfile naming a DEAD process is not a successor either.
  //
  // This is the same mistake as "vacant", wearing a disguise. The record exists,
  // so it LOOKS like someone took over — but the process it names is gone. It is
  // a stale claim, and standing down for it hands the bot token to nobody and
  // takes inbound Telegram delivery with it.
  //
  // This is exactly how it happened on 2026-07-14: a test run whose hermetic
  // preload had not loaded (see lib/hermetic-guard.ts) resolved STATE_DIR to the
  // LIVE bridge and called claimAuthoritative() against it, stamping the live
  // pidfile with the TEST process's pid. The test exited seconds later. The real,
  // healthy poller then read a pidfile naming a pid that no longer existed,
  // concluded it had been preempted, and killed itself. The operator's channel
  // died for a corpse.
  //
  // Preemption is only real if the preemptor is ALIVE.
  if (!alive(snap.pid)) return { kind: "stale", byPid: snap.pid };

  return { kind: "preempted", byPid: snap.pid };
}

/**
 * Release our claim by unlinking the pidfile — but ONLY if we still own
 * it. If a newer poller has overwritten it, we must NOT delete their
 * record. Best-effort; failures are silent.
 */
export function releaseAuthoritative(opts: {
  stateDir: string;
  tokenHash: string;
  pid?: number;
}): void {
  const pid = opts.pid ?? process.pid;
  const path = pollerPidfilePath(opts.stateDir, opts.tokenHash);
  const snap = readPidfile(path);
  if (!snap) return;
  if (snap.pid !== pid) return; // someone else owns it now
  try {
    unlinkSync(path);
  } catch {
    // ignore — best-effort
  }
}
