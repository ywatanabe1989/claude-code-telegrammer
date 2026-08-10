/**
 * Configuration and constants for the Telegram MCP server.
 */

import { homedir, hostname } from "os";
import { join } from "path";
import { getenv, READ_PREFIXES } from "./env.js";

// Make an AGENT_ID safe as a single path segment: collapse any run of
// characters outside [A-Za-z0-9._-] (notably "/") to one "-" so an exotic id
// cannot inject a path separator and escape the home directory. Exported so the
// startup auto-migration (lib/migrate-state.ts) derives the OLD default dir with
// the identical sanitizer — the two paths must agree segment-for-segment.
export function sanitizeAgentSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Resolve the telegrammer state directory.
 *
 * Precedence:
 *   1. An explicit AGENT_STATE_DIR env (CCT_AGENT_STATE_DIR /
 *      CLAUDE_CODE_TELEGRAMMER_AGENT_STATE_DIR) is honoured verbatim. The name
 *      encodes that this state is PER-AGENT (its own bot/token → its own
 *      message/receipt state), not shared. The old ambiguous CCT_STATE_DIR /
 *      CLAUDE_CODE_TELEGRAMMER_STATE_DIR spellings were renamed and are now
 *      rejected fail-loud (findRenamedEnv) so a stale override is never silently
 *      ignored.
 *   2. Otherwise the DEFAULT is the scitex-standard, DETERMINISTIC per-agent
 *      path `~/.scitex/claude-code-telegrammer/runtime/<sanitized-agent-id>`
 *      (agent-id = AGENT_ID, default "telegram"). Deriving it from the agent id
 *      alone — with no launcher-supplied dir in the mix — makes the path STABLE
 *      across container restarts by construction, which eliminates the history-
 *      gap incident where a drifting default path opened a fresh empty DB and
 *      lost the operator's message history. A one-time startup auto-migration
 *      (lib/migrate-state.ts) carries any pre-existing history at the OLD default
 *      location forward into this path. Per-agent segmentation still prevents the
 *      poller-pidfile / DB collision that the newest-wins takeover (lib/takeover.ts)
 *      would otherwise resolve by letting only ONE agent hold the channel.
 */
export function resolveStateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = getenv("AGENT_STATE_DIR", undefined, env);
  if (explicit) return explicit;
  const agentId = getenv("AGENT_ID", undefined, env) ?? "telegram";
  return join(
    homedir(),
    ".scitex",
    "claude-code-telegrammer",
    "runtime",
    sanitizeAgentSegment(agentId),
  );
}

export const STATE_DIR = resolveStateDir();

export const ACCESS_FILE = join(STATE_DIR, "access.json");
export const LOCK_FILE = join(STATE_DIR, "claude-code-telegrammer-mcp.lock");

// Inbound-message channel source label — the fleet's SHORT sender-identity
// name for this bridge (operator naming agreement 2026-07-07, card
// fleet-channel-source-sender-identity-naming-20260707): sac / cct / stodo,
// with "daemon" reserved for daemon-origin messages (this bridge emits none —
// it only relays operator messages). Supersedes the earlier
// "claude-code-telegrammer-system" suffix: short labels read on a phone, and
// staying distinct from the CCT_AGENT_ID "claude-code-telegrammer" removes the
// bridge-origin vs that-agent-origin ambiguity. meta.source is a free
// attribution label decoupled from routing (verified empirically: the harness
// renders <channel source=X> for sources matching no registered server, and
// replies route via the MCP tool + chat/row ids, never via source). The
// generic platform label "telegram" stays banned — it hid WHICH integration
// delivered the message.
export const CHANNEL_SOURCE = "cct";
export const INBOX_DIR = join(STATE_DIR, "inbox");
export const ATTACHMENT_DIR =
  getenv("ATTACHMENT_DIR") ?? join(STATE_DIR, "attachments");

export const TOKEN = getenv("BOT_TOKEN") ?? "";
export const API_BASE = `https://api.telegram.org/bot${TOKEN}`;
export const MAX_TEXT = 4096;

export const ENV_ALLOWED = (getenv("ALLOWED_USERS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Unexpanded-env guard ────────────────────────────────────────────────────
//
// Detect CLAUDE_CODE_TELEGRAMMER_* env vars whose value still contains a
// literal "${...}" — i.e. an unexpanded placeholder. The launchers declare the
// telegrammer env via "${SCITEX_LEAD_TELEGRAM_*}" (lead .mcp.json) and resolve
// it from the shell at MCP-launch. When the launcher starts without its backing
// .env sourced — e.g. a Claude resume that bypasses claude.sh — those shell
// vars are unset, so Claude Code passes the LITERAL "${SCITEX_LEAD_TELEGRAM_*}"
// string through. Unchecked, STATE_DIR becomes that literal (a relative path)
// and lib/lock.ts mkdir's a junk dir literally named "${...}" under the poller
// cwd, while TOKEN becomes a literal → every Telegram Bot API call 404s (a
// silent comms outage). This detector lets startup fail LOUD instead. Returns
// the offending "NAME=value" lines (empty array when all good). See the
// 2026-06-12 incident note for the full failure cascade.
export function findUnexpandedEnv(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        READ_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
        typeof value === "string" &&
        value.includes("${"),
    )
    .map(([name, value]) => `${name}=${value}`);
}

// ── Renamed-env guard ───────────────────────────────────────────────────────
//
// Env vars that were RENAMED (operator decision 2026-07-02): the state-dir
// override now says PER-AGENT in its name. Old spellings are NOT silently
// honoured OR ignored — startup fails LOUD (telegram-server.ts) so a stale
// override in a launcher/.envrc surfaces immediately instead of quietly
// resolving to a different dir than the operator intended. Both current
// spellings AND the deprecated legacy alias of the OLD name are rejected;
// their replacement is the single new AGENT_STATE_DIR spelling family.
//
// An EMPTY value ("") counts as ABSENT (same rule as env.ts getenv): a folded
// but unresolved `export CCT_STATE_DIR="$CCT_STATE_DIR"` self-reference must not
// trip the guard.
const RENAMED_ENV: ReadonlyArray<{ old: string; replacement: string }> = [
  { old: "CCT_STATE_DIR", replacement: "CCT_AGENT_STATE_DIR" },
  {
    old: "CLAUDE_CODE_TELEGRAMMER_STATE_DIR",
    replacement: "CLAUDE_CODE_TELEGRAMMER_AGENT_STATE_DIR",
  },
  {
    old: "CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR",
    replacement: "CLAUDE_CODE_TELEGRAMMER_AGENT_STATE_DIR",
  },
];

/**
 * Detect any RENAMED env var that is still set (non-empty). Returns an
 * actionable "OLD was renamed to NEW; unset the old var" line per offender
 * (empty array when clean) — the caller prints them and exits.
 */
export function findRenamedEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return RENAMED_ENV.filter(({ old }) => {
    const v = env[old];
    return typeof v === "string" && v !== "";
  }).map(
    ({ old, replacement }) =>
      `${old} was renamed to ${replacement}; unset the old var (its value is ignored).`,
  );
}

// ── Read receipts ──────────────────────────────────────────────────────────
//
// Automatic four-stage read-receipt reactions on inbound operator messages.
// Single reaction per message that ADVANCES through stages (Telegram replaces
// the bot's reaction on each setMessageReaction call; non-premium bots are
// capped at 1 reaction/message per the Bot API):
//
//   Stage 1  ⚡  delivered — bridge received the Telegram message (and POSTed
//                            it to the agent's /v1/turn if configured)
//   Stage 2  👀 received   — /v1/turn POST returned 2xx in SDK-runner mode
//                            (the agent runner accepted the message). In
//                            interactive-CLI mode (no TURN_URL), set when
//                            the MCP <channel> notification ack returns.
//   Stage 3  ✅ done       — agent finished processing the turn / produced
//                            its reply. Under current scitex-agent-container
//                            this collapses to the same wakeTurn ok=true
//                            instant as stage 2 (sac /v1/turn is case B:
//                            HTTP 200 returns AFTER turn completes). The
//                            design fires 👀 then ✅ in sequence so it stays
//                            forward-compatible if sac later splits the
//                            signals (enqueue-ack vs completed-turn).
//   Stage 4  👎 failed     — failure (agent down / 401 / connection refused /
//                            timeout / non-2xx). Final visible state until
//                            the operator retries.
//
// Every stage emoji MUST be in TELEGRAM_ALLOWED_REACTIONS below, and that is
// now CHECKED rather than asserted — see the note there. This comment used to
// read "All four emojis are on Telegram's fixed reaction whitelist"; two of
// them were not, and the claim outlived the truth because nothing tested it.
//
// Enabled by default. Set CLAUDE_CODE_TELEGRAMMER_READ_RECEIPTS to
// any of 0/false/no/off (case-insensitive) to disable without a code change.
export const READ_RECEIPTS_ENABLED: boolean = ![
  "0",
  "false",
  "no",
  "off",
].includes((getenv("READ_RECEIPTS") ?? "").trim().toLowerCase());

// Telegram's FIXED reaction allowlist for setMessageReaction. Anything not
// in here comes back `Bad Request: REACTION_INVALID` — always, not
// intermittently, so an emoji outside this set can never succeed.
//
// Measured 2026-08-10: RECEIPT_DONE was "✅" and RECEIPT_FAILED was "❌".
// NEITHER is on this list. Every inbound operator message logged
// "failed to set done receipt (✅) ... REACTION_INVALID" — 12 of 12 that
// day, 100%, while the message itself was delivered and read fine.
//
// So the operator saw NO acknowledgment on anything he sent, and worse, a
// FAILED turn was equally invisible: stage 4 could not render either. He
// has previously raised "agents are ignoring me" as an incident; a receipt
// that cannot be drawn is exactly what produces that impression.
//
// The failure was silent by construction: logged at WARNING in a per-agent
// file nobody tails, on a delivery path that otherwise succeeded, so every
// health check stayed green.
export const TELEGRAM_ALLOWED_REACTIONS: readonly string[] = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢",
  "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾",
  "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👀", "🎃", "🙈", "😇", "😨",
  "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘",
  "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷", "😡",
] as const;

export const RECEIPT_DELIVERED_EMOJI = "⚡"; // stage 1
export const RECEIPT_READ_EMOJI = "👀"; // stage 2 (a.k.a. "received")
export const RECEIPT_DONE_EMOJI = "👍"; // stage 3 (turn completed)
export const RECEIPT_FAILED_EMOJI = "👎"; // stage 4 (failure)

// Fail at STARTUP, not once per message forever. A receipt emoji that
// Telegram rejects is a configuration error, and the old code discovered it
// on every single inbound message and then carried on.
for (const [name, emoji] of [
  ["RECEIPT_DELIVERED_EMOJI", RECEIPT_DELIVERED_EMOJI],
  ["RECEIPT_READ_EMOJI", RECEIPT_READ_EMOJI],
  ["RECEIPT_DONE_EMOJI", RECEIPT_DONE_EMOJI],
  ["RECEIPT_FAILED_EMOJI", RECEIPT_FAILED_EMOJI],
] as const) {
  if (!TELEGRAM_ALLOWED_REACTIONS.includes(emoji)) {
    throw new Error(
      `${name}=${emoji} is not on Telegram's setMessageReaction allowlist, ` +
        `so every receipt at this stage would fail with REACTION_INVALID ` +
        `while the message itself delivered fine — an invisible break. ` +
        `Pick one of: ${TELEGRAM_ALLOWED_REACTIONS.join(" ")}`,
    );
  }
}

// ── Loud-fail outbound reply (#14, 2026-06-07) ──────────────────────────────
//
// When wakeTurn fails (agent down / 401 / quota-capped / timeout / 5xx),
// the bridge posts an outbound Telegram reply to the operator explaining
// the failure, so silence is impossible: every inbound either gets a
// reply from the agent (success) or a loud-fail reply from the bridge
// (failure). The reply text is:
//
//   "⚠️ <agent_id> unavailable: <reason> — retry <when>"
//
// (rendered by lib/loudfail.ts::buildLoudFailMessage with the matching
// WakeFailCategory). Posted via tgApi("sendMessage") with
// reply_parameters pointing back to the inbound, so the operator's
// thread stays coherent. Each inbound (chat_id, message_id) gets at
// most one loud-fail reply per process lifetime (sentLoudFailReplies
// dedup set).
//
// Enabled by default. Set CLAUDE_CODE_TELEGRAMMER_LOUD_FAIL
// to any of 0/false/no/off (case-insensitive) to suppress the outbound
// reply without a code change (the ❌ receipt still fires; only the
// text message is suppressed).
export function isLoudFailEnabled(): boolean {
  const v = (getenv("LOUD_FAIL") ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

// ── Wake-on-push (idle SDK-runner sessions) ─────────────────────────────────
//
// Inbound delivery via `notifications/claude/channel` renders a <channel> tag
// for an ACTIVE turn, but does NOT advance an IDLE session — the standard
// Claude Code CLI has a live event loop that picks it up, but an SDK-runner
// session (e.g. a scitex-agent-container apptainer agent) is parked on its
// inbox queue and never sees the notification.
//
// When TURN_URL is set, each qualifying inbound message is additionally
// POSTed to that endpoint (the agent's own /v1/turn) so the runner enqueues
// it onto the persistent SDK conversation and drives a turn at once — push
// behaves like the lead's interactive Telegram channel. Unset (the default)
// preserves the notification-only path for the interactive CLI.
//
// This mirrors scitex-agent-container's `sac mcp channel --turn-url` wake
// primitive (runtimes/_mcp/_channel_wake.py::_wake_turn).
export const TURN_URL = getenv("TURN_URL") ?? "";
// Optional bearer for the /v1/turn POST (sent as Authorization: Bearer ...).
export const TURN_BEARER = getenv("TURN_BEARER") ?? "";

// ── Agent identity ─────────────────────────────────────────────────────────

export const HOST_NAME = getenv("HOST_NAME") ?? hostname();
export const PROJECT = getenv("PROJECT") ?? process.cwd();
export const AGENT_ID = getenv("AGENT_ID") ?? "telegram";

export const BOT_TOKEN_HASH: string = TOKEN
  ? new Bun.CryptoHasher("sha256").update(TOKEN).digest("hex").slice(0, 8)
  : "";

// ── Outbound signature toggle + account-quota enrichment ───────────────────
//
// The outbound-agent-signature feature (PR #18) unconditionally appends a
// trailing line `— <agent> (<cwd>@<hostname>)` to every Telegram message so a
// human (and downstream parsers) can attribute a message to a specific
// agent/host/checkout. Two follow-ups operator-requested 2026-06-02:
//
//   1. Kill-switch — sometimes the operator wants a clean message body (for
//      example when another layer is also signing, to avoid double-signing).
//      A single env flag toggles the entire append off. Mirrors the
//      READ_RECEIPTS_ENABLED pattern.
//
//   2. Account + remaining quota — the human-facing line should also show
//      WHICH Claude account is talking and HOW MUCH 5h / 7d quota that
//      account has left. Operator's wire example:
//          — lead (wyusuuke 5h:9 percent 7d:2 percent | /work@ywata-note-win)
//      Data lives in <quotaCachePath()>/quota-cache.json — a host cron
//      refreshes the file every 10 min, so we re-read on every send. The
//      cwd@host suffix from PR #18 is preserved as a `|`-separated tail so
//      we keep BOTH signals on one line (single append, no double-signing).
//
// Both behaviours are runtime-toggleable via env — buildSignature() /
// appendSignature() consult these getters on every call, not module load,
// so the operator can flip a flag without restarting the bridge. This is
// also why the existing module-load constants (AGENT_ID/PROJECT/HOST_NAME)
// stay as-is: identity is fixed for the lifetime of a bun process, but
// signature ON/OFF + the quota numbers genuinely change at runtime.

/**
 * Returns true iff the outbound text signature should be appended. Opt-IN
 * (task #82): default OFF. Enable by setting
 * CLAUDE_CODE_TELEGRAMMER_SIGNATURE to one of `1|true|yes|on`
 * (case-insensitive, trimmed). Any other value (including unset, empty
 * string, `0`, `off`) leaves the signature OFF. The auto text-signature is
 * abolished in favour of the /status command; the audio signature stays.
 */
export function isSignatureEnabled(): boolean {
  const v = (getenv("SIGNATURE") ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(v);
}

/**
 * Path to the host-maintained quota-cache.json. Defaults to the operator-
 * specified canonical location `/home/ywatanabe/.scitex/quota-cache.json`
 * (host cron writes there every 10 min). Override with
 * CLAUDE_CODE_TELEGRAMMER_QUOTA_CACHE_PATH — primarily for tests
 * that point at a fixture file.
 */
export function quotaCachePath(): string {
  return (
    getenv("QUOTA_CACHE_PATH") ?? "/home/ywatanabe/.scitex/quota-cache.json"
  );
}

/**
 * Path to the per-account usage.json the host writes after each turn
 * completes. Operator-specified canonical location (2026-06-07):
 *   ~/.scitex/agent-container/accounts/<acct>/usage.json
 *
 * Distinct from quota-cache.json (which is a single host-wide file with
 * percentages): usage.json carries ABSOLUTE reset timestamps (epoch
 * seconds OR ISO-8601 strings) under the keys `reset_at_5h` and
 * `reset_at_7d` — used by lib/loudfail.ts to render
 * "⚠️ <agent> unavailable: 5h quota cap — retry after HH:MM" so the
 * operator sees when the quota wall actually lifts.
 *
 * Override with CLAUDE_CODE_TELEGRAMMER_USAGE_JSON_PATH —
 * primarily for tests pointing at a fixture file. When the override is
 * unset, accountDirname() supplies the <acct> segment; an empty
 * accountDirname yields an empty path → the reader returns null
 * (loud-fail falls back to "after the quota resets").
 */
export function usageJsonPath(): string {
  const override = getenv("USAGE_JSON_PATH");
  if (override) return override;
  const acct = accountDirname();
  if (!acct) return "";
  return `${homedir()}/.scitex/agent-container/accounts/${acct}/usage.json`;
}

/**
 * Account directory-name for THIS bridge (e.g. `wyusuuke-gmail-com`,
 * `ywatanabe-scitex-ai`). Used to look up the matching entry in
 * quota-cache.json — we match by the `short` field, which is the email
 * local-part (first dash-segment of the dirname).
 *
 * Resolution order:
 *   1. CLAUDE_CODE_TELEGRAMMER_ACCOUNT — telegrammer-scoped
 *      override (lead-host use, or tests).
 *   2. CLAUDE_AGENT_ACCOUNT — injected by SAC into every agent container
 *      (see scitex-agent-container `config/_loaders.py`).
 *   3. "" — empty means "no account known"; the signature gracefully
 *      omits the enriched parenthetical and falls back to the
 *      `(cwd@host)` form that PR #18 shipped.
 */
export function accountDirname(): string {
  return getenv("ACCOUNT") ?? process.env.CLAUDE_AGENT_ACCOUNT ?? "";
}
