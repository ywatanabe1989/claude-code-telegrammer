#!/usr/bin/env bun
/**
 * Standalone Telegram getUpdates poller — decoupled from the MCP server.
 *
 * Architecture fix (incident-cct-inbound-dies-silently-with-mcp-server-
 * 20260711): a prior incident found that inbound Telegram delivery died
 * silently whenever ts/telegram-server.ts's MCP stdio child process was
 * restarted (e.g. Claude Code recycling its own MCP child under host load) —
 * a recurring, cross-agent problem, NOT specific to this package's code
 * (other unrelated packages' MCP servers were seen dropping simultaneously
 * in sessions that never load this code at all). Root cause: before this
 * fix, the getUpdates poll loop ran `void`-started on the SAME event loop as
 * the MCP stdio transport, inside that ONE process — killing the MCP
 * process killed the poller too, with nothing surfacing the loss (the
 * global unhandledRejection/uncaughtException handler only logs, never
 * process.exit()s, so it did not even announce the death loudly).
 *
 * This file is the fix: the getUpdates long-poll now runs in ITS OWN
 * process, spawned + supervised by ts/telegram-server.ts (see
 * lib/poller-supervisor.ts::ensurePollerRunning) but otherwise fully
 * independent of it — no `mcp` / `Server` object anywhere in this file's
 * module graph, and no import of lib/tools.ts (which only makes sense with a
 * live MCP connection). An MCP-server restart no longer touches this
 * process at all (see telegram-server.ts's shutdown(), which no longer
 * calls stopPolling()/releaseAuthoritative()); conversely, this process
 * coordinates with whatever telegram-server.ts instance is currently
 * running via the SAME per-token pidfile lib/takeover.ts already used for
 * "newest wins" poller takeover.
 *
 * Bootstrap mirrors telegram-server.ts's pre-poller sequence exactly
 * (migrateLegacyStateDir -> ensureCctAlias -> initStore — deliberately
 * skipping acquireLock()/releaseLock(), which guard the MCP server's OWN
 * single-instance lock at LOCK_FILE; this poller's concurrency safety is
 * fully owned by lib/takeover.ts's independent per-token pidfile protocol,
 * exercised inside startPolling() itself), then runs the poll loop with no
 * `mcp` parameter at all (see lib/poller.ts, lib/handle-update.ts,
 * lib/poller-batch.ts, lib/poll-watchdog.ts — all migrated off `mcp` in the
 * same change; alarms that used to push an mcp.notification now broadcast
 * directly to Telegram via lib/loudfail.ts::broadcastSystemAlert, or reuse
 * the already mcp-independent /v1/turn wake POST, lib/wake.ts::wakeTurn).
 *
 * Env vars: identical to telegram-server.ts (see that file's header) — this
 * process reads the SAME CLAUDE_CODE_TELEGRAMMER_* / CCT_* variables (it is
 * normally spawned by ensurePollerRunning() inheriting telegram-server.ts's
 * own already-validated environment) so it resolves the SAME STATE_DIR / bot
 * token / agent identity.
 */

import {
  findUnexpandedEnv,
  findRenamedEnv,
  TOKEN,
  STATE_DIR,
  BOT_TOKEN_HASH,
} from "./lib/config.js";
import { log } from "./lib/log.js";
import { startPolling, stopPolling } from "./lib/poller.js";
import { initStore } from "./lib/store.js";
import { migrateLegacyStateDir, ensureCctAlias } from "./lib/migrate-state.js";
import { releaseAuthoritative } from "./lib/takeover.js";
import { shouldSelfTerminateOnTeardown } from "./lib/poller-teardown.js";

// ── Fail loud on unexpanded / renamed env ───────────────────────────────────
//
// Same guards telegram-server.ts applies at its own startup. Defensive for
// the case this entrypoint is launched directly (e.g. manual debugging)
// rather than spawned by ensurePollerRunning() — a spawn through that path
// inherits telegram-server.ts's own already-validated environment, so these
// guards are normally a no-op there, but a stray direct invocation must not
// silently mkdir a junk state dir literally named "${...}" the way the
// original incident this pattern guards against did.
const unexpanded = findUnexpandedEnv();
if (unexpanded.length > 0) {
  process.stderr.write(
    "telegram-poller: refusing to start — unexpanded ${...} placeholder(s) in env:\n" +
      unexpanded.map((line) => `    ${line}\n`).join("") +
      "  Relaunch via claude.sh so the ${SCITEX_..._*} vars resolve, or\n" +
      "  export CLAUDE_CODE_TELEGRAMMER_* directly before starting.\n",
  );
  process.exit(1);
}

const renamed = findRenamedEnv();
if (renamed.length > 0) {
  process.stderr.write(
    "telegram-poller: refusing to start — renamed env var(s) still set:\n" +
      renamed.map((line) => `    ${line}\n`).join("") +
      "  Update your .envrc / .mcp.json to the new AGENT_STATE_DIR name.\n",
  );
  process.exit(1);
}

// No bot token → nothing to poll. telegram-server.ts's ensurePollerRunning()
// only spawns this process when a token is present, so this branch only
// fires on a direct/manual invocation without one configured — exit clean
// (0), matching the "disabled, not failed" posture telegram-server.ts
// itself takes for a tokenless agent (buildDisabledWarning).
if (!TOKEN) {
  process.stderr.write(
    "telegram-poller: CCT_BOT_TOKEN is empty — nothing to poll, exiting.\n",
  );
  process.exit(0);
}

// ── Safety net ───────────────────────────────────────────────────────────
//
// Log-only, matching telegram-server.ts's own established posture exactly
// (see that file: "only logs, never process.exit()s"). Changing that
// posture is a separate, out-of-scope concern from this architecture split.
process.on("unhandledRejection", (err) =>
  log("poller", `unhandled rejection: ${err}`),
);
process.on("uncaughtException", (err) =>
  log("poller", `uncaught exception: ${err}`),
);

// ── Bootstrap (mirrors telegram-server.ts's pre-poller sequence) ──────────
migrateLegacyStateDir();
ensureCctAlias();
await initStore();

// ── Shutdown ────────────────────────────────────────────────────────────
//
// The poller now owns its OWN lifecycle — this moved OUT of
// telegram-server.ts's shutdown(), which no longer tears the poller down on
// MCP-server exit (that decoupling is the entire point of this split; see
// docs/architecture.md). Release the per-token pidfile only if we still own
// it: claimAuthoritative() is idempotent and never tears down a successor's
// claim, so a SIGTERM raced by a newer poller during our own startup will
// not lose its record — the same invariant telegram-server.ts's old
// shutdown() relied on for this exact pidfile.
// `trigger` is a parameter for the same reason as in telegram-server.ts: this
// function has THREE call sites (SIGTERM, SIGINT, and the teardown self-check
// below) and the log named none of them. The poller is the INBOUND rail — when
// it stops, messages stop being recorded at all — so "why did it stop" is the
// first question anyone will ask, and until now the log could not answer it.
let shuttingDown = false;
function shutdown(trigger: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("poller", `standalone poller shutting down (trigger=${trigger} pid=${process.pid})`);
  stopPolling();
  releaseAuthoritative({ stateDir: STATE_DIR, tokenHash: BOT_TOKEN_HASH });
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Teardown-vs-restart stub (scitex-todo card cct-mcp-server-periodic-
// drop-20260712) ────────────────────────────────────────────────────────
//
// See lib/poller-teardown.ts for the full rationale. RESOLVED (not merely
// pending): sac confirmed their stop path is single-PID SIGTERM only (would
// miss this detached process), but sac ALREADY reaps exactly this shape of
// orphan via `_lifecycle/_orphan_mcp_cleanup.py::kill_orphan_mcp_children`
// (env + cmdline match), being wired into their agent_stop too — so this
// repo needs zero teardown-detection logic, contingent only on inherited
// env + a cmdline containing telegrammer/mcp/bun, both true by construction
// for this spawn. shouldSelfTerminateOnTeardown is therefore a PERMANENT
// safe-default (always resolves false), wired here as a periodic, unref'd
// self-check (rather than left as a dangling unused export) so the
// extension point stays visible rather than becoming dead code, in case a
// future sac change ever needs this repo to cooperate more actively.
const teardownCheck = setInterval(() => {
  void shouldSelfTerminateOnTeardown().then((should) => {
    if (should) shutdown("teardown-self-check");
  });
}, 60_000);
if (
  typeof teardownCheck === "object" &&
  teardownCheck &&
  "unref" in teardownCheck
) {
  (teardownCheck as { unref: () => void }).unref();
}

// ── Main ────────────────────────────────────────────────────────────────
void startPolling();
