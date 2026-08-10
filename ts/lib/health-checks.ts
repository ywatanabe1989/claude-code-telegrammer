/**
 * Health check ("doctor") — ten of the twelve individual check builders
 * (the two wake-delivery checks live in health-checks-wake.ts — this file
 * was already near the repo's line cap).
 *
 * PURE functions with injected inputs (no network / fs / process inspection);
 * see lib/health.ts for the shared report contract, the probe input types,
 * and the assembly (`buildHealthReport`). Each builder returns a
 * `CheckOutcome`: the contract entry {name, ok, detail, hint} plus a `warn`
 * flag — warn-style outcomes are visible in the report but excluded from the
 * top-level `ok` AND (tokenless bot_token_present, env_legacy nudge).
 */

import {
  describeAccessGating,
  buildDisabledWarning,
  type TokenCheck,
  type AccessGatingInput,
} from "./startup-validate.js";
import { SCHEMA_VERSION } from "./store.js";
import type {
  HealthCheckEntry,
  WebhookProbe,
  PollerProbe,
  StateDirProbe,
  DbProbe,
} from "./health.js";

/** An entry plus whether it is warn-style (excluded from the top-level AND). */
export interface CheckOutcome {
  entry: HealthCheckEntry;
  warn: boolean;
}

/** Detail used for checks skipped because telegram is disabled (no token). */
export const SKIPPED_DISABLED_DETAIL = "skipped: telegram disabled (no token)";

/** Exported so health-checks-wake.ts (a separate gate: wake disabled, not
 *  token-absent) can reuse the same skipped-entry shape. */
export function skippedDisabled(name: string): CheckOutcome {
  return {
    entry: { name, ok: true, detail: SKIPPED_DISABLED_DETAIL, hint: null },
    warn: false,
  };
}

/** 1. env_unexpanded — no literal "${" left in any CCT_/CLAUDE_CODE_TELEGRAMMER_ value. */
export function checkEnvUnexpanded(lines: string[]): CheckOutcome {
  if (lines.length === 0) {
    return {
      entry: {
        name: "env_unexpanded",
        ok: true,
        detail:
          "no unexpanded ${...} placeholders in CCT_/CLAUDE_CODE_TELEGRAMMER_ env values",
        hint: null,
      },
      warn: false,
    };
  }
  return {
    entry: {
      name: "env_unexpanded",
      ok: false,
      detail: `unexpanded \${...} placeholder(s): ${lines.join("; ")}`,
      hint:
        "the launcher started without its backing .env sourced — relaunch via " +
        "claude.sh so the ${SCITEX_..._*} vars expand, or export the " +
        "CLAUDE_CODE_TELEGRAMMER_* / CCT_* vars directly before starting.",
    },
    warn: false,
  };
}

/** 2. env_renamed — no renamed/old env spelling still set. */
export function checkEnvRenamed(lines: string[]): CheckOutcome {
  if (lines.length === 0) {
    return {
      entry: {
        name: "env_renamed",
        ok: true,
        detail: "no renamed (old-spelling) env vars set",
        hint: null,
      },
      warn: false,
    };
  }
  // findRenamedEnv() lines already ARE the actionable fix ("OLD was renamed
  // to NEW; unset the old var") — reuse them verbatim as the hint.
  return {
    entry: {
      name: "env_renamed",
      ok: false,
      detail: `renamed env var(s) still set: ${lines.length}`,
      hint: lines.join(" "),
    },
    warn: false,
  };
}

/** 3. bot_token_present — WARN-style when absent (disabled by design). */
export function checkBotTokenPresent(
  tokenPresent: boolean,
  agentId: string,
): CheckOutcome {
  if (tokenPresent) {
    return {
      entry: {
        name: "bot_token_present",
        ok: true,
        detail: "CCT_BOT_TOKEN is set (raw token never printed)",
        hint: null,
      },
      warn: false,
    };
  }
  return {
    entry: {
      name: "bot_token_present",
      ok: false,
      detail:
        "CCT_BOT_TOKEN is empty — telegram is DISABLED for this agent " +
        "(universal channel; disabled state is by design, not a crash)",
      hint: buildDisabledWarning(agentId),
    },
    // Warn-style: a deliberately tokenless agent must not read as unhealthy.
    warn: true,
  };
}

/** 4. bot_token_valid — getMe classification via validateBotToken(). */
export function checkBotTokenValid(check: TokenCheck | null): CheckOutcome {
  if (check === null) return skippedDisabled("bot_token_valid");
  if (check.ok) {
    const who = check.username ? `@${check.username}` : "unknown username";
    const id = check.id !== undefined ? ` (id ${check.id})` : "";
    return {
      entry: {
        name: "bot_token_valid",
        ok: true,
        detail: `getMe ok: ${who}${id}`,
        hint: null,
      },
      warn: false,
    };
  }
  if (check.kind === "invalid_token") {
    return {
      entry: {
        name: "bot_token_valid",
        ok: false,
        detail: "Telegram positively rejected the bot token (getMe 401/404)",
        hint: check.message,
      },
      warn: false,
    };
  }
  // Transient (network / 429 / 5xx): NOT a token verdict — the check passes
  // but the detail says loudly that validity is unverifiable right now.
  return {
    entry: {
      name: "bot_token_valid",
      ok: true,
      detail: `transient/unverifiable: ${check.message}`,
      hint: null,
    },
    warn: false,
  };
}

/** 5. webhook_absent — a set webhook starves getUpdates polling completely. */
export function checkWebhookAbsent(probe: WebhookProbe | null): CheckOutcome {
  if (probe === null) return skippedDisabled("webhook_absent");
  if (probe.kind === "transport_error") {
    return {
      entry: {
        name: "webhook_absent",
        ok: true,
        detail: `unverifiable (transient network error): ${probe.detail}`,
        hint: null,
      },
      warn: false,
    };
  }
  if (!probe.ok) {
    return {
      entry: {
        name: "webhook_absent",
        ok: true,
        detail:
          `unverifiable (getWebhookInfo ${probe.error_code ?? "?"}: ` +
          `${probe.description ?? "no description"}) — transient`,
        hint: null,
      },
      warn: false,
    };
  }
  if (probe.url === "") {
    return {
      entry: {
        name: "webhook_absent",
        ok: true,
        detail: "no webhook set — getUpdates long-polling is the delivery path",
        hint: null,
      },
      warn: false,
    };
  }
  // The literal placeholder <TOKEN> is printed on purpose — the raw token
  // must never appear in any health output.
  return {
    entry: {
      name: "webhook_absent",
      ok: false,
      detail:
        `a webhook is SET (${probe.url}) — getUpdates polling receives ` +
        "NOTHING while a webhook is registered",
      hint:
        "delete it: curl https://api.telegram.org/bot<TOKEN>/deleteWebhook " +
        "(substitute your bot token for the literal <TOKEN>)",
    },
    warn: false,
  };
}

/** 6. poller_alive — recorded poller PID is alive (kill-0, PID-ns safe). */
export function checkPollerAlive(probe: PollerProbe | null): CheckOutcome {
  if (probe === null) return skippedDisabled("poller_alive");
  if (probe.kind === "self") {
    return {
      entry: {
        name: "poller_alive",
        ok: true,
        detail: `self: this server process (pid ${probe.pid}) is the poller`,
        hint: null,
      },
      warn: false,
    };
  }
  const restartHint =
    "restart the agent/bridge (e.g. `sac agent restart <agent>` or relaunch " +
    "the MCP server) so a live poller re-claims the per-token pidfile.";
  // Prefer the per-token pidfile (the authoritative "newest wins" record,
  // lib/takeover.ts); fall back to the single-instance lock file.
  if (probe.pidfilePid !== null) {
    if (probe.pidfileAlive) {
      return {
        entry: {
          name: "poller_alive",
          ok: true,
          detail: `poller pid ${probe.pidfilePid} (from ${probe.pidfilePath}) is alive (kill-0)`,
          hint: null,
        },
        warn: false,
      };
    }
    return {
      entry: {
        name: "poller_alive",
        ok: false,
        detail:
          `recorded poller pid ${probe.pidfilePid} (from ${probe.pidfilePath}) ` +
          "is NOT alive (kill-0 failed)",
        hint: restartHint,
      },
      warn: false,
    };
  }
  if (probe.lockPid !== null) {
    return {
      entry: {
        name: "poller_alive",
        ok: probe.lockAlive,
        detail: probe.lockAlive
          ? `server pid ${probe.lockPid} (from the lock file) is alive (kill-0); no per-token pidfile yet`
          : `recorded server pid ${probe.lockPid} (from the lock file) is NOT alive (kill-0 failed)`,
        hint: probe.lockAlive ? null : restartHint,
      },
      warn: false,
    };
  }
  return {
    entry: {
      name: "poller_alive",
      ok: false,
      detail: "no poller recorded (no lock file and no per-token pidfile)",
      hint: restartHint,
    },
    warn: false,
  };
}

/** 7. allowlist_nonempty — fail-closed empty allowlist makes the bot look dead. */
export function checkAllowlistNonempty(
  input: AccessGatingInput | null,
): CheckOutcome {
  if (input === null) return skippedDisabled("allowlist_nonempty");
  const gating = describeAccessGating(input);
  if (gating.level === "warn") {
    return {
      entry: {
        name: "allowlist_nonempty",
        ok: false,
        detail:
          "effective allow list is EMPTY (fail-closed) — every DM is rejected",
        hint: gating.message,
      },
      warn: false,
    };
  }
  return {
    entry: {
      name: "allowlist_nonempty",
      ok: true,
      detail: gating.message,
      hint: null,
    },
    warn: false,
  };
}

/** 8. state_dir_writable — STATE_DIR exists (or is creatable) + writable. */
export function checkStateDirWritable(probe: StateDirProbe): CheckOutcome {
  const hint =
    "check CCT_AGENT_STATE_DIR (a.k.a. CLAUDE_CODE_TELEGRAMMER_AGENT_STATE_DIR) " +
    "— or the default derivation ~/.claude-code-telegrammer-<CCT_AGENT_ID> — " +
    "points at a writable location.";
  if (probe.exists && probe.writable) {
    return {
      entry: {
        name: "state_dir_writable",
        ok: true,
        detail: `state dir ${probe.path} exists and is writable (probe file created+unlinked)`,
        hint: null,
      },
      warn: false,
    };
  }
  if (!probe.exists && probe.writable) {
    return {
      entry: {
        name: "state_dir_writable",
        ok: true,
        detail: `state dir ${probe.path} does not exist yet, but is creatable (parent writable); created on first start`,
        hint: null,
      },
      warn: false,
    };
  }
  return {
    entry: {
      name: "state_dir_writable",
      ok: false,
      detail:
        `state dir ${probe.path} is ${probe.exists ? "NOT writable" : "missing and NOT creatable"}` +
        (probe.detail ? `: ${probe.detail}` : ""),
      hint,
    },
    warn: false,
  };
}

/**
 * Offset-gap thresholds. The gap is `meta.update_offset` minus the largest
 * update_id among STORED INBOUND ROWS — a number that drifts upward on its
 * own, because most Telegram update types never become a stored row.
 *
 * Below EXPLAINABLE: quiet. Between the two: ambiguous, and reported as such
 * rather than as a fault. At or above POISONED: no real update volume
 * explains it, so it is a fault.
 */
const EXPLAINABLE_OFFSET_GAP = 1000;
const POISONED_OFFSET_GAP = 1_000_000;

/** 9. db_schema_current — schema version matches + persisted offset plausible. */
export function checkDbSchemaCurrent(probe: DbProbe): CheckOutcome {
  if (!probe.exists) {
    return {
      entry: {
        name: "db_schema_current",
        ok: true,
        detail: "not yet created (first run)",
        hint: null,
      },
      warn: false,
    };
  }
  if (probe.error !== undefined) {
    return {
      entry: {
        name: "db_schema_current",
        ok: false,
        detail: `could not read claude-code-telegrammer.db: ${probe.error}`,
        hint:
          "check claude-code-telegrammer.db permissions in the state dir; if " +
          "corrupt, move it aside while the poller is stopped and restart.",
      },
      warn: false,
    };
  }
  if (probe.schemaVersion !== SCHEMA_VERSION) {
    return {
      entry: {
        name: "db_schema_current",
        ok: false,
        detail: `meta.schema_version=${probe.schemaVersion ?? "(missing)"} but this code writes ${SCHEMA_VERSION}`,
        hint:
          "claude-code-telegrammer.db was written by a different code version " +
          "— back it up / move it aside while the poller is stopped, then " +
          "restart the bridge to recreate it at the current schema.",
      },
      warn: false,
    };
  }
  // ── The offset-vs-stored-rows gap ──────────────────────────────────────
  //
  // What this CAN see: meta.update_offset, and the largest update_id among
  // STORED INBOUND MESSAGE ROWS. What it CANNOT see: every other update type
  // Telegram counts — reactions, edits, chat-member changes, and anything
  // from a non-allowlisted sender. All of those advance update_id and none
  // becomes a row, so on a quiet-but-reacted-to chat the gap grows on its own.
  //
  // So a moderate gap is genuinely AMBIGUOUS: it is what a poisoned offset
  // looks like AND what an ordinary month of reactions looks like. Measured
  // 2026-08-11 on scitex-hub: gap 1355, reported "implausible", ingestion
  // demonstrably live. Reporting that as a failure cried wolf on a healthy
  // rail — and the old hint ("DELETE the update_offset row") would have made
  // getUpdates re-fetch Telegram's 24h backlog and re-deliver messages the
  // operator had already read. A check must not answer "unknown" with
  // "broken", and must never open with a destructive step.
  //
  // A gap of MILLIONS is different in kind: no volume of reactions explains
  // it, so the 10-day-outage class (card cct-python-cli-wrap-pip-installable
  // — the poller asked for updates beyond anything real and getUpdates
  // returned [] forever) still fails hard, which is what this check is for.
  const gap =
    probe.updateOffset !== null && probe.maxUpdateId !== null
      ? probe.updateOffset - probe.maxUpdateId
      : null;

  if (probe.inboundCount > 0 && gap !== null && gap >= POISONED_OFFSET_GAP) {
    return {
      entry: {
        name: "db_schema_current",
        ok: false,
        detail:
          `meta.update_offset=${probe.updateOffset} is ${gap} beyond the largest ` +
          `stored update_id (${probe.maxUpdateId}, ${probe.inboundCount} inbound rows) — ` +
          "too far for any real update volume to explain",
        hint:
          "likely a poisoned persisted offset (getUpdates will return [] " +
          "forever). FIRST confirm inbound is actually dead — send yourself a " +
          "message and check whether a new row lands, and read the poller log " +
          "for Conflict errors, which cause the same silence for a different " +
          "reason. ONLY if inbound is confirmed dead, and while the poller " +
          "is stopped, reset the cursor with\n" +
          "  sqlite3 <state-dir>/claude-code-telegrammer.db \"DELETE FROM meta WHERE key='update_offset'\"\n" +
          "and expect it to re-deliver up to 24h of Telegram's backlog (you " +
          "will see already-read messages arrive again).",
      },
      warn: false,
    };
  }

  const offsetNote =
    probe.updateOffset === null
      ? "update_offset unset"
      : gap !== null && gap > EXPLAINABLE_OFFSET_GAP
        ? `update_offset=${probe.updateOffset}, ${gap} beyond the newest stored ` +
          "message — normal for a chat with reactions/edits (they advance " +
          "Telegram's counter without storing a row), so not diagnostic either way"
        : `update_offset=${probe.updateOffset} plausible`;
  return {
    entry: {
      name: "db_schema_current",
      ok: true,
      detail: `schema_version=${SCHEMA_VERSION}; ${offsetNote}`,
      hint: null,
    },
    warn: false,
  };
}

/** 10. env_legacy — deprecated *_TELEGRAM_* spellings: nudge, never fail. */
export function checkEnvLegacy(names: string[]): CheckOutcome {
  if (names.length === 0) {
    return {
      entry: {
        name: "env_legacy",
        ok: true,
        detail: "no deprecated CLAUDE_CODE_TELEGRAMMER_TELEGRAM_* vars set",
        hint: null,
      },
      warn: false,
    };
  }
  return {
    entry: {
      name: "env_legacy",
      ok: true,
      detail: `deprecated legacy env var(s) still set: ${names.join(", ")}`,
      hint:
        "rename to the CCT_* (or CLAUDE_CODE_TELEGRAMMER_*) spelling — the " +
        "legacy *_TELEGRAM_* form still works but is deprecated.",
    },
    warn: true,
  };
}
