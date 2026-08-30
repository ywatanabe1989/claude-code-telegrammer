/**
 * One-time, startup-safe migration of the telegrammer state directory from the
 * OLD default location to the scitex-standard DEFAULT
 * (~/.scitex/claude-code-telegrammer/runtime/<agent-id>).
 *
 * WHY: an operator-declared incident — an agent's Telegram history GAPPED
 * because its state path drifted across container restarts, so a fresh empty
 * store opened at a new path and lost history. Making the default resolve
 * deterministically from the agent id eliminates the drift by construction
 * (see config.ts::resolveStateDir), but the switch MUST carry the existing
 * state forward — that is what this module does, once, at startup.
 *
 * WHAT THIS MODULE CARRIES, AND WHAT IT NO LONGER CAN. The state directory
 * used to hold two different kinds of thing: the message DATABASE, and
 * ordinary FILES (downloaded attachments, access.json). The database moved to
 * PostgreSQL, where the path this module exists to repair does not apply at
 * all — a namespace is keyed by agent id, so it cannot drift with a directory.
 * The FILES did not move, and they are what this module still carries.
 *
 * A LEGACY DATABASE FILE IS THEREFORE ANNOUNCED, NOT COPIED. If one is sitting
 * in the old directory, this module says so, loudly, once, naming the file and
 * pointing at the import procedure — and leaves it exactly where it is. That
 * is deliberate: silently proceeding past an old store full of the operator's
 * history, leaving him to discover the gap himself, is the incident this whole
 * module was written for. Announcing it is the honest alternative, and the
 * untouched file remains fully re-readable.
 *
 * DESIGN (data safety is paramount — this moves the operator's real state):
 *   - COPY, never move. The legacy dir is left intact as a backup.
 *   - Write a marker so it runs exactly once and a re-run is a no-op.
 *   - FAIL LOUD: if any copy step throws, do NOT write the marker and rethrow.
 *     A half-migration must be visible, never silently masked.
 *   - CROSS-CONTAMINATION GUARD: a suffixed agent must NEVER read the bare
 *     ~/.claude-code-telegrammer dir (that is the lead/"telegram" bot's data).
 *     resolveOldDefaultDir mirrors the OLD default logic exactly, so only the
 *     "telegram"/default agent ever points at the bare dir.
 *
 * No-op when: the marker is already there, OR the old dir holds nothing to
 * carry, OR an explicit AGENT_STATE_DIR is set (that dir IS the state dir —
 * nothing to migrate).
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
import { getenv } from "./env.js";
import { resolveStateDir, sanitizeAgentSegment } from "./config.js";
import { log as defaultLog } from "./log.js";

const MARKER_NEW = ".migrated-from"; // written in the NEW dir (authoritative)
const MARKER_OLD = ".migrated-to"; // written in the OLD dir (best-effort)

/**
 * Database files a previous, file-backed release may have left behind.
 *
 * Named so the operator is TOLD one is there rather than left to find the gap.
 * Nothing here is opened, copied, or altered.
 */
const LEGACY_DB_FILES = [
  "messages.db",
  "claude-code-telegrammer.db",
] as const;

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
    | "already-migrated"
    | "nothing-to-migrate";
  newDir: string;
  oldDir: string | null;
  /**
   * Legacy database files found in the old dir and deliberately left there.
   * Empty for every agent that never ran a file-backed release.
   */
  strandedDbFiles: string[];
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

/** Legacy database files present in `dir` (never opened — just named). */
export function findStrandedDbFiles(dir: string): string[] {
  return LEGACY_DB_FILES.filter((name) => existsSync(join(dir, name))).map(
    (name) => join(dir, name),
  );
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
  const copyDir =
    opts.copyDir ??
    ((s: string, d: string) => cpSync(s, d, { recursive: true }));

  const newDir = opts.newDir ?? resolveStateDir(env);
  const oldDir =
    opts.oldDir !== undefined ? opts.oldDir : resolveOldDefaultDir(env, home);

  // EVERY return path below funnels through `summarize`, which emits ONE
  // structured line naming the resolved paths and the chosen reason. A NO-OP is
  // therefore never silent: during an incident the operator can see WHY nothing
  // migrated and WHERE it looked, instead of an empty log (constitution §2:
  // fail loud, no silent, give the next step).
  const summarize = (
    reason: MigrateResult["reason"],
    strandedDbFiles: string[],
  ): MigrateResult => {
    log("migrate-state", "state-dir migration check", {
      newDir,
      oldDir: oldDir ?? "none",
      reason,
      strandedDbFiles,
    });
    if (strandedDbFiles.length > 0) {
      // LOUD, and it says what to do. An old store full of the operator's
      // history that nobody mentions is exactly how a history gap becomes his
      // problem to discover.
      log(
        "migrate-state",
        "a legacy file-backed message store is present and was NOT carried " +
          "forward — this bridge now stores messages in PostgreSQL. The file " +
          "is untouched and fully re-readable; importing its rows is a " +
          "separate, operator-run step (docs/adr/0001-postgres-message-store.md). " +
          "Message history recorded before the move will not appear in " +
          "get_history until that import runs.",
        { files: strandedDbFiles },
      );
    }
    return { migrated: reason === "migrated", reason, newDir, oldDir, strandedDbFiles };
  };

  // Explicit AGENT_STATE_DIR → that dir IS the state dir; nothing to migrate.
  if (oldDir === null || getenv("AGENT_STATE_DIR", undefined, env)) {
    return summarize("explicit-state-dir", []);
  }

  const stranded = existsSync(oldDir) ? findStrandedDbFiles(oldDir) : [];

  // A previous migration completed → no-op.
  if (existsSync(join(newDir, MARKER_NEW))) {
    return summarize("already-migrated", stranded);
  }

  const oldAttachments = join(oldDir, "attachments");
  const oldAccess = join(oldDir, "access.json");
  const hasAttachments = existsSync(oldAttachments);
  const hasAccess = existsSync(oldAccess);
  if (!hasAttachments && !hasAccess) {
    return summarize("nothing-to-migrate", stranded);
  }

  log("migrate-state", "migrating legacy telegrammer state forward", {
    from: oldDir,
    to: newDir,
  });

  mkdirSync(newDir, { recursive: true });

  // Copy phase — any failure here rethrows WITHOUT writing a marker, so a
  // half-migration is visible and the operator never sees a silent fresh state
  // dir. Both copies are overwrite/merge-safe, so a re-run after a crash is
  // idempotent, and two processes racing each other (the MCP server and its
  // poller start together) converge on the same content rather than colliding.
  try {
    if (hasAttachments) {
      copyDir(oldAttachments, join(newDir, "attachments"));
    }
    if (hasAccess) {
      copyFile(oldAccess, join(newDir, "access.json"));
    }
  } catch (err) {
    log("migrate-state", "MIGRATION FAILED — leaving legacy state untouched", {
      from: oldDir,
      to: newDir,
      error: String(err),
    });
    throw err;
  }

  // Markers — the new-dir marker is authoritative; the old-dir one is
  // best-effort. Written LAST so a crash mid-copy re-runs the whole thing.
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

  log("migrate-state", "migration complete — attachments/access carried forward", {
    from: oldDir,
    to: newDir,
  });

  return summarize("migrated", stranded);
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
