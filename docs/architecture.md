# Architecture

How claude-code-telegrammer wires an autonomous Claude Code agent to a Telegram
bot. For the top-level diagram see the [README](../README.md#architecture); this
document covers the internals.

## Components

**Two cooperating processes**, coordinated via the state dir (architecture fix,
incident `incident-cct-inbound-dies-silently-with-mcp-server-20260711`, 2026-07):
a prior single-process design meant that when Claude Code recycled its MCP
stdio child (e.g. under host load), the getUpdates poll loop died with it —
silently, since inbound Telegram delivery had no process of its own. Now:

| Process | Entrypoint | Responsibility |
|---------|------------|----------------|
| MCP server | `ts/telegram-server.ts` | MCP stdio transport, the 11 tools, ensures a poller is running |
| Poller | `ts/telegram-poller.ts` | Telegram `getUpdates` long-poll, inbound delivery — fully independent of the MCP server |

The MCP server does not run the poll loop itself. At startup (and on every
restart) it checks the per-token pidfile (`lib/takeover.ts`) for a live poller
PID; if none is found, it spawns `ts/telegram-poller.ts` **detached**
(`lib/poller-supervisor.ts::ensurePollerRunning`) and does not wait on it. The
poller then runs on regardless of what happens to the MCP server afterwards —
an MCP-child restart no longer touches inbound delivery at all. Conversely the
MCP server's own shutdown releases only its own single-instance lock, never
the poller's pidfile. The two processes share internal modules (`ts/lib/`):

| Module | Responsibility |
|--------|----------------|
| `poller` | Telegram `getUpdates` long-poll loop (runs only in the poller process) |
| `poller-supervisor` | MCP-server-side: spawn-if-not-already-running decision (testable, injectable) |
| `handle-update` / `poller-batch` / `poll-watchdog` | Per-update handling, batch/durability retry, ingestion-stall alarm — all mcp-independent |
| `notify-relay` | Cross-process inbound live-push relay for interactive-CLI (`!wakeEnabled()`) mode — poller writes, MCP server reads+delivers |
| `loudfail` | Direct-Telegram-API alarms/replies that must work whether or not the agent/mcp side is reachable |
| `store` | SQLite (WAL) message persistence + dedup + read/replied tracking; opened independently by both processes |
| `tools` | The 11 MCP tools (see [interfaces](interfaces.md)) — MCP-server process only |
| `attachments` | Background download queue for inbound files |
| `access` | Allowlist gating (`access.json` + `CCT_ALLOWED_USERS`), mtime-cached |
| `config` / `env` | Env-var resolution (see [configuration](configuration.md)) |
| `lock` / `takeover` | Single-instance MCP-server PID lock + newest-wins per-token poller takeover |

An optional **TUI Watchdog** (`lib/`, shell) keeps an interactive CLI session
alive; SDK-runner agents use the [wake path](configuration.md#wake-on-push-turn_url)
instead. Lifecycle orchestration is handled by
[scitex-agent-container](https://github.com/ywatanabe1989/scitex-agent-container).
Whether sac's stop path reaps the now-detached poller process was an open
question tracked in scitex-todo card `cct-mcp-server-periodic-drop-20260712`
— now RESOLVED: sac's stop is single-PID SIGTERM only (would miss a detached
process), but sac already reaps orphans of exactly this shape via their own
env+cmdline-matching cleanup, being wired into their `agent_stop` path too —
so `lib/poller-teardown.ts`'s `shouldSelfTerminateOnTeardown()` stays a
PERMANENT safe-default stub (always false); this repo needs no active
teardown-detection logic.

## Data flow

**Inbound:** Telegram `getUpdates` → poller process → allowlist gate → (if
`TURN_URL` is set) `/v1/turn` wake POST to the agent — mcp-independent, plain
HTTP, works regardless of which process is up — **or** (interactive-CLI, no
`TURN_URL`) a relayed MCP channel notification: the poller process (no `mcp`
object) persists the fully-built notification on the message's own row
(`messages.pending_notification`), and the MCP-server process — which still
holds the live `mcp` object throughout the session — polls for pending rows
(default every 1s) and delivers them (`lib/notify-relay.ts`). This is a short
relay delay, not an immediate push, but it is *not* zero/best-effort-only:
every pending row is eventually delivered once the MCP server is up, same as
before the poller/MCP-server split (just no longer instantaneous). System-
level alarms (batch persist-failure, 409-exhausted, ingestion-stall) and
reactions never depend on the MCP server at all — they go straight to
Telegram (`loudfail.ts`) or through the same wake POST (reactions have no
durable row to relay from, so they use the wake POST only, logging in
interactive-CLI mode — see `lib/handle-update.ts::handleReaction`).
**Outbound:** Claude Code calls the `reply` / `react` /
`send_document` tools (MCP-server process) → `sendMessage` → Telegram → operator.

Each agent is a self-contained unit: its own bot token, its own state directory,
its own poller. See [per-agent identity](configuration.md#per-agent-identity).

## Startup fail-loud guards

The server refuses to start (loud, actionable stderr) rather than run degraded —
every failure names the exact env var and the fix:

1. **Unexpanded `${…}` placeholder** in any telegrammer env var — the launcher
   started without its `.env` sourced, so a literal `${VAR}` came through. Abort
   before touching state.
2. **Invalid/revoked token** — a `getMe` call at startup classifies `401`/`404`
   as fatal (re-issue via @BotFather) vs. a transient network/`429`/`5xx` error
   (warn + continue; a Telegram outage must not permanently kill a valid poller).
3. **Renamed env var still set** — the old `CCT_STATE_DIR` /
   `CLAUDE_CODE_TELEGRAMMER_STATE_DIR` name is rejected; use
   `CCT_AGENT_STATE_DIR` (see [configuration](configuration.md)).

Every failure message names the exact env var and the fix — the failed status is
itself the hint (no generic errors).

**Missing/empty token is NOT a failure.** `server:claude-code-telegrammer` is a
universal channel in every agent spec, so an agent with no bot yet must load as
*connected-but-disabled*, not `✘ failed`. An empty `CCT_BOT_TOKEN` emits a loud,
actionable `[WARN]` (naming the agent + the secrets file to define
`CCT_BOT_TOKEN_<NAME>`), then the MCP still connects but skips `getMe` and the
poller. Honest status, no silent fallback, no crash.

The `config` identity probe (`bun run ts/telegram-server.ts config [--check]`)
resolves and prints the config as JSON without starting the server — used to
preflight per-agent bot identity and detect two agents on the same token.

## Bot token exclusivity

The server **must be the sole consumer** of its bot token: the Telegram Bot API
allows only one `getUpdates` long-poll per token.

| Scenario | Symptom | Detection |
|----------|---------|-----------|
| Two pollers start simultaneously | One gets 409, the other wins | Loser logs `409 Conflict` |
| Two pollers start sequentially | Only one receives messages | **No error** — the other gets empty responses forever |
| Webhook active + poller | Poller gets nothing | **No error** — Telegram ignores `getUpdates` when a webhook is set |

**Why 409 detection alone is insufficient:** Telegram does not reliably 409 for
sequential (non-overlapping) polls — both connections succeed, one just gets no
messages. A `timeout=3` startup preflight catches overlapping polls, not the
sequential case. Two same-token pollers of OURS resolve via the **newest-wins
takeover**: a fresh poller records its PID in the per-token pidfile and preempts
the predecessor, instead of both 409-looping forever.

**If messages aren't arriving:**
1. Another poller on the token? `ps aux | grep telegram-server`
2. A webhook set? `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
3. Give each component/agent its own bot token (see
   [per-agent identity](configuration.md#per-agent-identity)).

**Webhook alternative:** [scitex-orochi](https://github.com/ywatanabe1989/scitex-orochi)
supports Telegram webhook mode (`POST /webhook/telegram/`), eliminating polling
conflicts (`SCITEX_OROCHI_TELEGRAM_WEBHOOK_URL`).

## TUI watchdog state detection

The watchdog polls the GNU Screen buffer and sends keystrokes to keep an
interactive session moving:

| State | Pattern | Response |
|-------|---------|----------|
| `running` | `(esc to interrupt)`, `tokens ·`, `ing...` | No action |
| `y_n` | `1. Yes` + `3. No` | Send `1` (accept) |
| `y_y_n` | `2. Yes, and…` / `2. Yes, allow…` / `2. Yes, don't ask…` | Send `2` (accept all) |
| `waiting` | idle hints, empty `>` prompt | Send configurable command |

Throttled: minimum inter-response interval, burst limit (10 in 3s), same-state delay.

## SQLite schema (v2)

All messages persist in
`$CLAUDE_CODE_TELEGRAMMER_AGENT_STATE_DIR/claude-code-telegrammer.db` (WAL
mode). The file was renamed from the original `messages.db` when the state dir
moved under `~/.scitex/`; `lib/migrate-state.ts` copies a legacy `messages.db`
onto the new name once, at startup, so history is carried forward.

- **messages** — direction, chat_id, message_id, user_id, username, text,
  timestamps (telegram_ts, received_at, read_at, replied_at), threading
  (reply_to_message_id, reply_to_row_id), identity (host, project, agent_id,
  bot_token_hash), raw_json, forward_json, pending_notification (cross-process
  live-push relay payload — see `notify-relay` above; NULL once delivered or
  when wake-enabled, since that mode never populates it).
- **attachments** — message_row_id (FK), kind, file_id, file_name, mime_type,
  file_size, local_path, downloaded_at.
- **meta** — key-value store for schema_version, update_offset, last_poll_ts
  (poll-freshness heartbeat), wake_failure_state (cross-process wake-delivery
  backlog counter the `health` tool reads — see [poller decoupling](#components)).

## Part of the SciTeX agent stack

```
scitex-orochi          — agent definitions, dashboard
        ↓
scitex-agent-container — lifecycle, health, restart, per-agent .envrc + .mcp.json
        ↓
claude-code-telegrammer — MCP server (Telegram API, message DB, 11 tools)
                          + standalone poller process + TUI watchdog
```
