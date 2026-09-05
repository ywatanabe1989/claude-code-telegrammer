/**
 * Single-instance lock for the telegram-mcp process at STATE_DIR scope.
 *
 * Semantics: "NEWEST WINS" (#37, 2026-06-07).
 *
 *   Previous behaviour was "oldest wins" — if the lockfile already
 *   recorded a live PID, the new process exited and the old one kept
 *   running. That made the operator-pain case worse: when an agent's
 *   container restarted, Apptainer+tini left the previous bun poller
 *   orphaned on the host; the new poller would exit on lock-acquire and
 *   the dead-parent zombie kept the bot stuck. Operator sees no 👀,
 *   no reply, 409 storms in the logs.
 *
 *   The fix is symmetric to lib/takeover.ts at the per-token layer:
 *     1. read the existing lockfile (capture outgoing PID),
 *     2. if outgoing is alive AND not us, send SIGTERM (best-effort —
 *        the outgoing telegram-server.ts SIGTERM handler is wired to
 *        a clean shutdown(), so it releases the lock + exits voluntarily),
 *     3. briefly wait for the outgoing PID to disappear (poll kill -0),
 *     4. overwrite the lockfile with our PID and proceed.
 *
 *   SIGTERM is best-effort. If the outgoing process lives in a different
 *   PID namespace (apptainer container vs host, sibling container) the
 *   signal goes nowhere — we just take the lock anyway and the per-token
 *   pidfile poll-loop in takeover.ts handles the takeover at the next
 *   Telegram getUpdates iteration.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { STATE_DIR, LOCK_FILE } from "./config.js";
import { isProcessMatching, SERVER_CMDLINE_MARKER } from "./takeover.js";
import { log } from "./log.js";

/** ms between kill(pid,0) probes while waiting for the outgoing process to exit. */
const TAKEOVER_POLL_INTERVAL_MS = 50;
/** Max total wait for outgoing to exit voluntarily after SIGTERM. */
const TAKEOVER_GRACE_TOTAL_MS = 2000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sleep up to `ms` ms, bounded. Uses Atomics.wait so we don't busy-spin. */
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

/**
 * Acquire the STATE_DIR-scoped single-instance lock.
 *
 * @param opts.signalOutgoing  When `true` (default), send SIGTERM to the
 *   previous live owner before overwriting the lockfile. Tests should
 *   pass `false` to verify the overwrite path WITHOUT actually signalling
 *   (e.g. when the test runs in the same process tree as the test
 *   runner and a SIGTERM to a real PID would kill the test orchestrator
 *   or some other innocent process).
 */
export function acquireLock(opts: { signalOutgoing?: boolean } = {}): void {
  const signalOutgoing = opts.signalOutgoing ?? true;
  mkdirSync(STATE_DIR, { recursive: true });

  if (existsSync(LOCK_FILE)) {
    let outgoingPid: number | null = null;
    let readErr: unknown;
    try {
      outgoingPid = parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (!Number.isFinite(outgoingPid) || outgoingPid <= 0) {
        outgoingPid = null;
      }
    } catch (err) {
      outgoingPid = null;
      readErr = err;
    }

    if (readErr !== undefined) {
      // readFileSync itself threw (e.g. EACCES, or the file vanished in
      // a race) — that is NOT the same evidence as "we read the content
      // and it wasn't a valid pid", so don't claim "unparseable content"
      // without a basis; report the raw error instead.
      log("lock", "could not read lockfile — proceeding to (re)claim it", {
        error: String(readErr),
      });
    } else if (outgoingPid === null) {
      log("lock", "removing lockfile with unparseable content");
    } else if (outgoingPid === process.pid) {
      // Already ours (re-acquire is a no-op).
      log("lock", "lockfile already records our pid — no-op");
      return;
    } else if (!isPidAlive(outgoingPid)) {
      log("lock", "removing stale lock file", { outgoingPid });
    } else if (!isProcessMatching(outgoingPid, SERVER_CMDLINE_MARKER)) {
      // The pid is ALIVE but it is not a telegram MCP server of this agent.
      // Measured 2026-09-05 (scitex-compute-04): this lockfile lives in the
      // state dir, which survives a container restart; the pid namespace does
      // not, and a restarted container reissues low pids within seconds. So
      // the recorded pid now belongs to whatever the new burst spawned there -
      // a sibling MCP server, the poller, a hook. Signalling it is how the
      // per-token pidfile's twin of this branch killed the MCP server at
      // start. A live-but-foreign pid is a STALE record: overwrite, no signal.
      log(
        "lock",
        "lockfile names a live pid that is NOT a telegram MCP server of this agent (recycled pid) — treating as stale, no signal",
        { outgoingPid, ourPid: process.pid },
      );
    } else {
      // NEWEST WINS: take over from the live incumbent.
      log(
        "lock",
        "lockfile held by another live PID — taking over (newest wins)",
        { outgoingPid, ourPid: process.pid, signalOutgoing },
      );
      if (signalOutgoing) {
        try {
          process.kill(outgoingPid, "SIGTERM");
        } catch {
          // best-effort — outgoing may be in another PID namespace
        }
        // Brief grace period so the outgoing's shutdown() handler runs
        // and releases the lock cleanly. If it doesn't exit (cross-
        // namespace, signal didn't reach), we still overwrite below.
        const deadline = Date.now() + TAKEOVER_GRACE_TOTAL_MS;
        while (Date.now() < deadline && isPidAlive(outgoingPid)) {
          sleepSync(TAKEOVER_POLL_INTERVAL_MS);
        }
        if (isPidAlive(outgoingPid)) {
          log(
            "lock",
            "outgoing PID still alive after grace — overwriting lockfile anyway",
            { outgoingPid },
          );
        } else {
          log("lock", "outgoing PID exited cleanly within grace", {
            outgoingPid,
          });
        }
      }
    }
  }

  writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
}

export function releaseLock(): void {
  try {
    // Only unlink if we still own the lockfile — never tear down a
    // successor's claim during our shutdown.
    if (existsSync(LOCK_FILE)) {
      const heldBy = parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (heldBy === process.pid) {
        unlinkSync(LOCK_FILE);
      }
    }
  } catch {
    // best-effort
  }
}
