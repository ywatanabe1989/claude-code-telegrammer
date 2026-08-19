/**
 * Auto-error-reply / loud-fail outbound message (#14, 2026-06-07).
 *
 * When wakeTurn cannot deliver to /v1/turn (agent down / 401 /
 * quota-capped / connection refused / timeout / 5xx / etc.), the bridge
 * sends a Telegram reply to the operator on that bot explaining the
 * failure. Every inbound then gets EITHER a reply from the agent
 * (success) OR a loud-fail reply from the bridge (failure).
 *
 * THOSE TWO BRANCHES ARE NOT EXHAUSTIVE, and this docstring used to claim
 * they were ("silence becomes impossible"). There is a third outcome:
 * DELIVERED SUCCESSFULLY, TO THE WRONG AGENT, SILENTLY.
 *
 * The turn bridge identifies its agent BY PORT NUMBER — its own route
 * table documents the bare route as "(the port identifies the agent)" —
 * so a bridge bound to a port that was since reallocated to someone else
 * accepts the POST and returns 200. wakeTurn sees {ok:true, status:200},
 * loudfail therefore never fires, and the agent the message was FOR never
 * hears about it. Neither branch above covers that, and the mechanism
 * built to make silence impossible is the one this case disables: the
 * failure produces the exact signature of success.
 *
 * MEASURED 2026-08-19 on scitex-compute-04: scitex-cards posted turns to
 * port 19003 while the bridge on 19003 was running scitex-agent-container's
 * spec, and three of the operator's messages surfaced in the wrong
 * session. A second instance (handyman-01 -> handyman-06 on 19000) was in
 * the same measurement. Neither raised a loud-fail, because from cct's
 * side both delivered fine.
 *
 * So read a 200 here as evidence of DELIVERY, never of delivery TO THE
 * INTENDED AGENT. Closing the gap needs the named route
 * (POST /agents/<name>/turn, which a foreign bridge 404s) plus a /health
 * identity preflight to tell "wrong agent" apart from "bridge too old to
 * serve that route" — both 404s otherwise. Tracked on card
 * cct-loudfail-invariant-has-an-unhandled-third-branch-20260819;
 * scitex-agent-container is removing the underlying port collision first.
 *
 * Wire shape (operator's revised spec 2026-06-07):
 *
 *     "⚠️ <agent_id> unavailable: <reason_phrase> — <retry_phrase>"
 *
 * The reason_phrase and retry_phrase are CATEGORY-DERIVED — they are
 * NOT a verbatim echo of the underlying wakeTurn error string. Per
 * lead's review (msg ab8d86e4 2026-06-07), the operator wants a fixed
 * actionable vocabulary so they can read failure-classes at a glance
 * without parsing stack-trace fragments. The raw error message lives
 * in the WARN log line for diagnostics; the Telegram reply stays
 * human-tier.
 *
 *   category            reason_phrase           retry_phrase
 *   ───────────────────────────────────────────────────────────────
 *   quota_capped        "<variant> quota cap"   "retry after <HH:MM>"  (when usage.json readable)
 *                       "quota cap"             "after the quota resets" (fallback)
 *   auth                "auth refresh needed"   "escalating to lead"
 *   connection_refused  "connection refused"    "retry in ~30s"
 *   timeout             "agent busy"            "retry shortly"
 *   server_error        "agent busy"            "retry shortly"
 *   client_error        "HTTP <status>"         "retry shortly"
 *   unknown             "<reason from result>"  "retry shortly"
 *
 * The outbound message-poster is injectable (setLoudFailSender) so
 * tests exercise the wiring without real network calls — same pattern
 * as receipts.ts::setReactionSender and wake.ts::setTurnPoster.
 *
 * Dedup: each (chat_id, message_id) gets at most one loud-fail reply
 * per process lifetime. The poller guarantees handleUpdate runs once
 * per message (saveInbound returns null on dedup), but a transient
 * within-process retry path could otherwise produce double-replies.
 *
 * Best-effort: a failed send is logged loudly and never thrown — must
 * not crash the relay or block subsequent deliveries.
 */

import { sendMessage } from "./telegram-api.js";
import { AGENT_ID, isLoudFailEnabled } from "./config.js";
import { log } from "./log.js";
import { formatResetTime, readQuotaReset } from "./usage.js";
import { loadAccess } from "./access.js";
import type { WakeFailCategory, WakeResult } from "./wake.js";

/**
 * Pair of strings that compose the loud-fail message body for one
 * category, before agent-id prefixing. Pure data — buildLoudFailMessage
 * concatenates them with " — " in the wire format.
 */
export interface FailPhrases {
  reason: string;
  retry: string;
}

/**
 * Resolve the (reason, retry) pair for a wakeTurn failure. Reads
 * usage.json for quota_capped (best-effort; falls back to a static
 * "after the quota resets" string when the file is missing/unreadable).
 *
 * Pure-ish: the only side effect is one best-effort fs read for the
 * quota_capped branch; every other branch is a pure mapping.
 */
export function resolveFailPhrases(
  result: Extract<WakeResult, { ok: false }>,
): FailPhrases {
  switch (result.category) {
    case "quota_capped": {
      const reset = readQuotaReset();
      if (reset) {
        return {
          reason: `${reset.variant} quota cap`,
          retry: `retry after ${formatResetTime(reset.resetAt)}`,
        };
      }
      return {
        reason: "quota cap",
        retry: "after the quota resets",
      };
    }
    case "auth":
      return {
        reason: "auth refresh needed",
        retry: "escalating to lead",
      };
    case "connection_refused":
      return {
        reason: "connection refused",
        retry: "retry in ~30s",
      };
    case "timeout":
      return {
        reason: "agent busy",
        retry: "retry shortly",
      };
    case "server_error":
      return {
        reason: "agent busy",
        retry: "retry shortly",
      };
    case "client_error":
      return {
        reason:
          result.status != null ? `HTTP ${result.status}` : "client error",
        retry: "retry shortly",
      };
    case "unknown":
      return {
        reason: result.reason || "unknown error",
        retry: "retry shortly",
      };
  }
}

/** Back-compat alias (older code may import retrySuggestion directly). */
export function retrySuggestion(category: WakeFailCategory): string {
  return resolveFailPhrases({
    ok: false,
    reason: "",
    category,
  }).retry;
}

/**
 * Render the loud-fail message body. Pure function — no I/O beyond the
 * one best-effort fs read in resolveFailPhrases() for the quota_capped
 * branch (the read still returns null on any failure, so even there the
 * function never throws). Exported so tests can pin the wire-format
 * directly without going through the network seam.
 *
 *     "⚠️ <agentId> unavailable: <reason> — <retry>"
 */
export function buildLoudFailMessage(
  result: Extract<WakeResult, { ok: false }>,
  agentId: string = AGENT_ID,
): string {
  const { reason, retry } = resolveFailPhrases(result);
  return `⚠️ ${agentId} unavailable: ${reason} — ${retry}`;
}

/**
 * Low-level sender for the loud-fail message. Overridable in tests via
 * setLoudFailSender so the path can be exercised without real Telegram
 * calls. The contract: send (chat_id, text) reply-attached to
 * replyToMessageId. Returns whatever the underlying sender returns
 * (typically the outbound message id from the Bot API).
 */
type LoudFailSender = (
  chatId: string,
  text: string,
  replyToMessageId: number,
) => Promise<unknown>;

let loudFailSender: LoudFailSender = (chatId, text, replyToMessageId) =>
  sendMessage(chatId, text, replyToMessageId);

/** Test-only: override the loud-fail sender. Returns the previous sender. */
export function setLoudFailSender(sender: LoudFailSender): LoudFailSender {
  const prev = loudFailSender;
  loudFailSender = sender;
  return prev;
}

// Tracks which (chat_id, message_id) have already received a loud-fail
// reply this process lifetime, so a retry path can't double-send.
const sentLoudFailReplies = new Set<string>();

function loudFailKey(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** Test-only: clear the dedup cache. */
export function _resetLoudFail(): void {
  sentLoudFailReplies.clear();
}

/**
 * Post the loud-fail reply for a wakeTurn failure. No-op when:
 *   - isLoudFailEnabled() returns false (operator kill-switch), OR
 *   - we have already sent a loud-fail reply for this (chat_id, msg_id).
 *
 * Best-effort: any send failure is logged at warning, never thrown. The
 * caller (poller.ts handleUpdate) `void`s the returned promise.
 */
export async function sendLoudFailReply(
  chatId: string,
  replyToMessageId: number,
  result: Extract<WakeResult, { ok: false }>,
  agentId: string = AGENT_ID,
): Promise<void> {
  if (!isLoudFailEnabled()) return;

  const key = loudFailKey(chatId, replyToMessageId);
  if (sentLoudFailReplies.has(key)) return;
  // Mark before awaiting so concurrent calls for the same message don't
  // double-fire.
  sentLoudFailReplies.add(key);

  const text = buildLoudFailMessage(result, agentId);
  try {
    await loudFailSender(chatId, text, replyToMessageId);
    log("loudfail", "sent loud-fail reply", {
      chat_id: chatId,
      message_id: String(replyToMessageId),
      category: result.category,
      reason: result.reason,
    });
  } catch (err) {
    log("loudfail", "WARNING: failed to send loud-fail reply", {
      level: "warning",
      chat_id: chatId,
      message_id: String(replyToMessageId),
      category: result.category,
      reason: result.reason,
      error: String(err),
    });
  }
}

// ── System-level alarms (no anchoring inbound message) ──────────────────────
//
// Architecture fix (incident-cct-inbound-dies-silently-with-mcp-server-
// 20260711 follow-up, 2026-07): the getUpdates poller now runs in its own
// standalone process (ts/telegram-poller.ts), decoupled from the MCP server.
// Three system-level alarms (batch persist-failure in poller-batch.ts, the
// 409-conflict-exhausted alarm in poller.ts, and the ingestion-stall alarm in
// poll-watchdog.ts) used to push an `mcp.notification(...)` — impossible now
// that the poller has no mcp/Server object at all (that requires being
// co-located with the live MCP stdio transport). Unlike sendLoudFailReply
// above, these alarms have no anchoring (chat_id, message_id) of their own —
// they are systemic (a persistence failure, a 409 storm, a wedged long-poll),
// not tied to one inbound update — so there is nothing to "reply" to.
//
// broadcastSystemAlert sends the alarm text directly to Telegram (bypassing
// mcp entirely, same "must work when the mcp/agent side is unreachable"
// contract as sendLoudFailReply) to every chat_id in the CURRENT allowlist
// (access.ts loadAccess().allowFrom) — the exact set of Telegram identities
// already trusted to DM this bot, which in the overwhelmingly common single-
// operator deployment IS the operator. This also fixes a latent gap for
// wake-enabled (SDK-runner/fleet) agents: the old mcp.notification path never
// advanced an IDLE session (see handle-update.ts), so these alarms were
// already invisible to a parked fleet agent even BEFORE this split — routing
// them straight to Telegram makes them reach the operator regardless of
// whether the agent's own process is idle, busy, or its MCP server is dead.

type SystemAlertSender = (chatId: string, text: string) => Promise<unknown>;

let systemAlertSender: SystemAlertSender = (chatId, text) =>
  sendMessage(chatId, text);

/** Test-only: override the system-alert sender. Returns the previous sender. */
export function setSystemAlertSender(
  sender: SystemAlertSender,
): SystemAlertSender {
  const prev = systemAlertSender;
  systemAlertSender = sender;
  return prev;
}

/** Test-only: restore the default (real sendMessage-backed) sender. */
export function _resetSystemAlertSender(): void {
  systemAlertSender = (chatId, text) => sendMessage(chatId, text);
}

/**
 * Broadcast a system-level alarm to every allowlisted chat_id. Best-effort
 * per recipient — one recipient's send failure is logged and does not block
 * delivery to the others. NEVER throws or rejects (every branch is caught),
 * so callers may fire-and-forget with a bare `void broadcastSystemAlert(...)`
 * exactly like sendLoudFailReply's callers do. Respects the same
 * CLAUDE_CODE_TELEGRAMMER_LOUD_FAIL kill-switch sendLoudFailReply honours —
 * an operator who muted loud-fail replies has also opted out of these.
 * No-op (logged) when the allowlist is empty — there is nobody to tell.
 */
export async function broadcastSystemAlert(
  text: string,
  recipients: string[] = loadAccess().allowFrom,
): Promise<void> {
  if (!isLoudFailEnabled()) return;

  if (recipients.length === 0) {
    log(
      "loudfail",
      "system alert has no recipients (empty allowlist) — dropped",
      { text: text.slice(0, 200) },
    );
    return;
  }

  await Promise.all(
    recipients.map(async (chatId) => {
      try {
        await systemAlertSender(chatId, text);
        log("loudfail", "broadcast system alert", { chat_id: chatId });
      } catch (err) {
        log("loudfail", "WARNING: failed to broadcast system alert", {
          level: "warning",
          chat_id: chatId,
          error: String(err),
        });
      }
    }),
  );
}
