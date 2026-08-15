/**
 * One-time, startup-safe migration of the telegrammer state directory from the
 * OLD default location to the scitex-standard DEFAULT
 * (~/.scitex/claude-code-telegrammer/runtime/<agent-id>).
 *
 * WHY: an operator-declared incident — an agent's Telegram history GAPPED
 * because its DB path drifted across container restarts, so a fresh empty DB
 * opened at a new path and lost history. Making the default resolve
 * deterministically from the agent id eliminates the drift by construction
 * (see config.ts::resolveStateDir), but the switch MUST carry the existing
 * history forward — that is what this module does, once, at startup.
 *
 * DESIGN (data safety is paramount — this moves the operator's real history):
 *   - COPY, never move. The legacy dir is left intact as a backup.
 *   - Copy the SQLite trio together (db + -wal + -shm) so an un-checkpointed
 *     WAL is not lost, plus attachments/ and access.json when present.
 *   - Write a marker so it runs exactly once and a re-run is a no-op.
 *   - FAIL LOUD: if any copy step throws, do NOT write the marker and rethrow.
 *     A half-migration must be visible, never silently masked by a fresh DB.
 *   - CROSS-CONTAMINATION GUARD: a suffixed agent must NEVER read the bare
 *     ~/.claude-code-telegrammer dir (that is the lead/"telegram" bot's data).
 *     resolveOldDefaultDir mirrors the OLD default logic exactly, so only the
 *     "telegram"/default agent ever points at the bare dir.
 *
 * No-op when: the new DB already exists, OR the old DB is absent, OR an explicit
 * AGENT_STATE_DIR is set (that dir IS the state dir — nothing to migrate).
 */

import { homedir } from "os";
import { join } from "path";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  writeFileSync,
  symlinkSync,
} from "fs";
import { Database } from "bun:sqlite";
import { getenv } from "./env.js";
import { resolveStateDir, sanitizeAgentSegment } from "./config.js";
import { log as defaultLog } from "./log.js";

const NEW_DB = "claude-code-telegrammer.db";
const OLD_DB = "messages.db";
const MARKER_NEW = ".migrated-from"; // written in the NEW dir (authoritative)
const MARKER_OLD = ".migrated-to"; // written in the OLD dir (best-effort)

/**
 * Take a CONSISTENT snapshot of a live SQLite database.
 *
 * This replaces an earlier approach that copied the `.db`, `-wal` and `-shm`
 * as three independent `copyFileSync` calls. That was reaching for the right
 * guarantee — its comment said the sidecars travel along "so an un-checkpointed
 * WAL ... travel[s] with the base file" — but file-by-file copying cannot
 * deliver it, because a `.db` and its `-wal` are ONE logical database captured
 * at ONE instant. Copied at different instants from a source that is still
 * being written to, they form a pair that never coexisted:
 *
 *   - a row committed between the WAL copy and the .db copy is in NEITHER (it
 *     is in the live WAL after the snapshot, and not yet in main), and
 *   - a checkpoint landing in that window resets the WAL with fresh salts, so
 *     the already-copied WAL describes older page images than the .db copied
 *     next.
 *
 * That window is not theoretical: this runs at STARTUP from both
 * telegram-poller.ts and telegram-server.ts, while the poller writes
 * meta.last_poll_ts about every 30s and inbound messages can arrive — and the
 * attachments tree is copied inside the window. test/migrate-state-consistency
 * reproduces the loss.
 *
 * `VACUUM INTO` is SQLite's own answer: one atomic, internally consistent
 * snapshot taken against a live writer, written as a SINGLE self-contained file
 * with no sidecars to keep in sync.
 *
 * FAIL LOUD, never fall back. If the source will not open as a database, that
 * is a corrupt or non-SQLite artifact and the caller must hear about it — a
 * silent degrade to raw file copy would reintroduce exactly the inconsistency
 * this function exists to prevent.
 */
function vacuumInto(srcDb: string, dstDb: string): void {
  const db = new Database(srcDb);
  try {
    db.run("VACUUM INTO ?", [dstDb]);
  } finally {
    db.close();
  }
}

/**
 * Is this the "someone else already wrote the destination" error?
 *
 * `VACUUM INTO` refuses a destination that exists, so this is exactly what the
 * LOSER of a startup race sees. Matched on the message because SQLite reports
 * it as a generic SQLITE_ERROR with no distinguishing code — so this is a
 * prose match, which is normally the wrong thing to do (see the 409 branch in
 * poller.ts, which never ran for precisely that reason). It is acceptable here
 * only because the failure is BENIGN and the fallback is conservative: if the
 * match ever stops working we go back to throwing, which is the loud, current,
 * safe behaviour — not to silently swallowing something worse.
 */
function isDestinationExistsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /output file already exists/i.test(msg);
}

type LogFn = (
  component: string,
  msg: string,
  data?: Record<string, unknown>,
) => void;

export interface MigrateOptions {
  /** Environment to read (defaults to process.env; injectable for tests). */
  env?: Record<string, string | undefined>;
  /** Home directory (defaults to os.homedir(); injectable for tests). */
  home?: string;
  /** NEW state dir override (defaults to resolveStateDir(env)); tests point at a temp dir. */
  newDir?: string;
  /** OLD default dir override (defaults to resolveOldDefaultDir(env, home)). */
  oldDir?: string | null;
  /** Timestamp stamped into the markers (defaults to now); injectable for tests. */
  now?: Date;
  /** Single-file copy primitive (defaults to fs.copyFileSync); injectable to test fail-loud. */
  copyFile?: (src: string, dst: string) => void;
  /** Consistent DB snapshot primitive (defaults to VACUUM INTO); injectable to test fail-loud. */
  snapshotDb?: (srcDb: string, dstDb: string) => void;
  /** Recursive dir copy primitive (defaults to fs.cpSync). */
  copyDir?: (src: string, dst: string) => void;
  /** Log sink (defaults to lib/log.ts::log). */
  logFn?: LogFn;
}

export interface MigrateResult {
  migrated: boolean;
  /** Why migration ran or was skipped — for logs/tests. */
  reason:
    | "migrated"
    | "explicit-state-dir"
    | "new-db-exists"
    | "old-db-absent"
    | "already-migrated"
    /** Another process completed this same migration while we were copying. */
    | "raced-by-other-process";
  newDir: string;
  oldDir: string | null;
}

/**
 * Compute THIS agent's OWN OLD DEFAULT dir — exactly what the OLD default
 * resolution returned before the scitex-standard switch. Returns null when an
 * explicit AGENT_STATE_DIR is set (there is no legacy default to migrate from).
 *
 * The bare ~/.claude-code-telegrammer is reserved for the "telegram"/default
 * agent; a suffixed agent resolves to ~/.claude-code-telegrammer-<id> and must
 * NEVER read the bare dir (that belongs to the lead bot). This mirror is the
 * cross-contamination guard.
 */
export function resolveOldDefaultDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  if (getenv("AGENT_STATE_DIR", undefined, env)) return null;
  const base = join(home, ".claude-code-telegrammer");
  const agentId = getenv("AGENT_ID", undefined, env);
  if (agentId && agentId !== "telegram") {
    return `${base}-${sanitizeAgentSegment(agentId)}`;
  }
  return base;
}

/**
 * Run the one-time legacy → scitex-standard state-dir migration. Idempotent and
 * safe to call unconditionally at startup BEFORE the store opens. See the module
 * header for the full contract. Returns a structured result; throws (fail loud)
 * only if a copy step fails mid-migration.
 */
export function migrateLegacyStateDir(
  opts: MigrateOptions = {},
): MigrateResult {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const log = opts.logFn ?? defaultLog;
  const copyFile = opts.copyFile ?? copyFileSync;
  const snapshotDb = opts.snapshotDb ?? vacuumInto;
  const copyDir =
    opts.copyDir ??
    ((s: string, d: string) => cpSync(s, d, { recursive: true }));

  const newDir = opts.newDir ?? resolveStateDir(env);
  const oldDir =
    opts.oldDir !== undefined ? opts.oldDir : resolveOldDefaultDir(env, home);

  const newDb = join(newDir, NEW_DB);

  // EVERY return path below funnels through `summarize`, which emits ONE
  // structured line naming the resolved paths, whether each DB existed, and
  // the chosen reason. A NO-OP is therefore never silent: during an incident
  // the operator can see WHY nothing migrated and WHERE it looked, instead of
  // an empty log (constitution §2: fail loud, no silent, give the next step).
  const summarize = (
    reason: MigrateResult["reason"],
    oldDb: string | null,
    newDbExists: boolean,
    oldDbExists: boolean,
  ): MigrateResult => {
    log("migrate-state", "state-dir migration check", {
      newDir,
      oldDir: oldDir ?? "none",
      newDb,
      oldDb: oldDb ?? "none",
      newDbExists,
      oldDbExists,
      reason,
    });
    return { migrated: reason === "migrated", reason, newDir, oldDir };
  };

  // Explicit AGENT_STATE_DIR → that dir IS the state dir; nothing to migrate.
  if (oldDir === null || getenv("AGENT_STATE_DIR", undefined, env)) {
    return summarize("explicit-state-dir", null, existsSync(newDb), false);
  }

  const oldDb = join(oldDir, OLD_DB);
  const newDbExists = existsSync(newDb);
  const oldDbExists = existsSync(oldDb);

  // Already on the new path (or a previous migration completed) → no-op.
  if (newDbExists) {
    return summarize("new-db-exists", oldDb, newDbExists, oldDbExists);
  }
  if (existsSync(join(newDir, MARKER_NEW))) {
    return summarize("already-migrated", oldDb, newDbExists, oldDbExists);
  }
  // Nothing to carry forward.
  if (!oldDbExists) {
    return summarize("old-db-absent", oldDb, newDbExists, oldDbExists);
  }

  log("migrate-state", "migrating legacy telegrammer state forward", {
    from: oldDir,
    to: newDir,
  });

  mkdirSync(newDir, { recursive: true });

  // Copy phase — any failure here rethrows WITHOUT writing a marker, so a
  // half-migration is visible and the operator never sees a silent fresh DB.
  //
  // ORDER MATTERS: the database is written LAST. The newDb-exists guard above
  // treats the presence of the new .db as "migration fully complete", so the
  // .db must be the FINAL artifact written — a crash mid-copy (e.g. disk full
  // while copying attachments) then leaves newDb ABSENT, and the next startup
  // re-runs the whole migration cleanly instead of skipping on a stray new .db
  // and permanently stranding the un-copied attachments/access.json. The
  // attachment/access copies are overwrite/merge-safe, so a re-run is
  // idempotent.
  //
  // Writing the DB last ALSO makes the snapshot the freshest possible: it is
  // taken after the slow attachment copy rather than before it, so the window
  // between "what we captured" and "what the source holds" is as small as we
  // can make it. Under the old sidecar-copy scheme that same ordering was the
  // bug — the WAL was captured before the window and the .db after it — which
  // is why the fix is a single atomic snapshot rather than a re-ordering.
  try {
    const oldAttachments = join(oldDir, "attachments");
    if (existsSync(oldAttachments)) {
      copyDir(oldAttachments, join(newDir, "attachments"));
    }
    const oldAccess = join(oldDir, "access.json");
    if (existsSync(oldAccess)) {
      copyFile(oldAccess, join(newDir, "access.json"));
    }
    // Final step: ONE consistent snapshot of the database. Its existence is the
    // "fully complete" sentinel, and being a single self-contained file it
    // cannot be half-present the way a .db/-wal/-shm trio could.
    //
    // LOSING A RACE HERE IS NOT A FAILURE. This function is called BARE, at top
    // level with no try/catch, from BOTH ts/telegram-poller.ts and
    // ts/telegram-server.ts, which can start together. The `existsSync(newDb)`
    // guard above is a check-then-act, and the attachments copy sits inside its
    // window — so the loser arrives here after the winner has written newDb, and
    // `VACUUM INTO` refuses an existing destination.
    //
    // Rethrowing that would abort the poller's top-level bootstrap. JS cannot
    // resume top-level execution after an uncaught exception, so startPolling()
    // would never run and the poller would go SILENTLY INERT — the process
    // stays alive, the uncaughtException handler only logs, and
    // ensurePollerRunning's fire-and-forget spawn never checks back. That is
    // the worst outcome available: inbound delivery dies quietly, on a failure
    // that MEANS the work we wanted was already done by someone else.
    //
    // So treat it as the success it is — and SAY SO, because a swallowed error
    // with no log is the silent fallback §2 forbids. Every other failure still
    // throws.
    try {
      snapshotDb(oldDb, newDb);
    } catch (err) {
      if (!isDestinationExistsError(err)) throw err;
      log(
        "migrate-state",
        "another process completed this migration while we were copying — carrying on (NOT an error; the destination is already populated)",
        { from: oldDir, to: newDir, newDb },
      );
      return summarize("raced-by-other-process", oldDb, true, oldDbExists);
    }
  } catch (err) {
    log("migrate-state", "MIGRATION FAILED — leaving legacy state untouched", {
      from: oldDir,
      to: newDir,
      error: String(err),
    });
    throw err;
  }

  // Markers — the new-dir marker is authoritative (idempotency also holds via
  // the newDb-exists check above); the old-dir marker is best-effort.
  const at = (opts.now ?? new Date()).toISOString();
  writeFileSync(
    join(newDir, MARKER_NEW),
    JSON.stringify({ from: oldDir, at }) + "\n",
  );
  try {
    writeFileSync(
      join(oldDir, MARKER_OLD),
      JSON.stringify({ to: newDir, at }) + "\n",
    );
  } catch (err) {
    // The legacy dir may be read-only; the new-dir marker already records the
    // completed migration, so this is non-fatal.
    log("migrate-state", "could not stamp legacy-dir marker (non-fatal)", {
      dir: oldDir,
      error: String(err),
    });
  }

  log("migrate-state", "migration complete — history carried forward", {
    from: oldDir,
    to: newDir,
  });

  // newDb now exists (just written as the final copy step); report the uniform
  // summary line so the migrated outcome shares the same shape as every no-op.
  return summarize("migrated", oldDb, true, oldDbExists);
}

/**
 * PART 3 (best-effort convenience): ensure ~/.scitex/cct → claude-code-telegrammer
 * so the runtime tree has a short alias. NEVER throws — wrapped in try/catch and
 * logged on failure. A no-op when the alias already exists.
 */
export function ensureCctAlias(
  home: string = homedir(),
  logFn: LogFn = defaultLog,
): void {
  try {
    const scitex = join(home, ".scitex");
    const alias = join(scitex, "cct");
    if (!existsSync(scitex)) return; // don't create ~/.scitex just for the alias
    if (existsSync(alias)) return;
    // Relative target so the symlink stays valid if ~/.scitex moves.
    symlinkSync("claude-code-telegrammer", alias);
    logFn("migrate-state", "created convenience alias ~/.scitex/cct", {
      alias,
    });
  } catch (err) {
    logFn("migrate-state", "could not create ~/.scitex/cct alias (non-fatal)", {
      error: String(err),
    });
  }
}
