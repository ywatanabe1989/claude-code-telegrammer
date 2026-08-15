---
name: claude-code-telegrammer
description: Telegram bridge MCP server for Claude Code — relay messages between an operator on Telegram and a Claude Code agent via MCP tools (reply, get_history, react, send_document, health, and more). Use this when wiring an agent up to Telegram, debugging why Telegram messages aren't reaching an agent (or replies aren't arriving), configuring per-agent bot tokens/state dirs, or working on the ts/telegram-server.ts MCP server itself.
version: 0.5.0
---

# claude-code-telegrammer

A TypeScript/Bun MCP server (`ts/telegram-server.ts`) that bridges a Telegram
bot to a Claude Code agent. It long-polls the Telegram Bot API directly
(`getUpdates`) over stdio — no screen-scraping, no TUI watchdog, no
`y/n`-prompt auto-clicking. Inbound Telegram messages arrive as MCP channel
notifications; the agent replies by calling MCP tools.

Registered MCP server name: `claude-code-telegrammer` (matches
`CHANNEL_SOURCE` in `ts/lib/config.ts`, so every inbound stimulus is
attributed to this exact channel).

## What it is NOT

There is no bash "TUI watchdog" that polls a screen buffer, no
`claude-code-telegrammer-watchdog` / `-guard` / `-relay` binaries, and no
1.5s poll loop reading terminal output. That legacy design is gone. The
current bridge talks to the Telegram Bot API directly and knows nothing
about screen buffers.

## MCP tools (11)

Defined in `ts/lib/tools.ts`:

| Tool | Purpose |
|------|---------|
| `reply` | Send a Telegram reply; pass `chat_id` (+ optional `reply_to`/`row_id`) from the inbound message |
| `react` | Add an emoji reaction to a Telegram message (Telegram's fixed whitelist only) |
| `edit_message` | Edit a message the bot previously sent (no push notification) |
| `get_history` | Read past messages (both directions) for a chat from the local SQLite DB |
| `get_unread` | List unread inbound messages, optionally filtered by `chat_id` |
| `mark_read` | Mark messages read, by `chat_id` (all) or `message_ids` (specific rows) |
| `download_attachment` | Download a Telegram file by `file_id`, returns the local path |
| `send_document` | Upload a local file to a Telegram chat |
| `search_messages` | LIKE-text search across all stored messages |
| `get_context` | Recent conversation formatted as compact text for LLM context |
| `health` | Run the health check ("doctor") — env hygiene, token validity, webhook absence, poller liveness, allowlist, state dir, DB schema/offset |

## Environment variables

Every var accepts three spellings, read via `ts/lib/env.ts::getenv()`, short
wins over canonical, both are aliases and must agree if both are set:
`CCT_<SUFFIX>` (preferred short form) › `CLAUDE_CODE_TELEGRAMMER_<SUFFIX>`
(canonical) › `CLAUDE_CODE_TELEGRAMMER_TELEGRAM_<SUFFIX>` (deprecated legacy,
still honoured with a warning).

| Suffix | Purpose |
|--------|---------|
| `BOT_TOKEN` | The Telegram bot token. Empty ⇒ MCP connects but stays disabled (no poller), not a hard failure — every agent spec carries this channel universally. |
| `AGENT_ID` | Identifies this bridge instance; also derives the per-agent state dir when set to something other than the default `telegram`. |
| `ALLOWED_USERS` | Comma-separated Telegram user IDs for the DM allowlist (`access.json` is the other source). |
| `AGENT_STATE_DIR` | Per-agent state directory override (SQLite DB, access.json, lock file, attachments). Renamed from the old `..._STATE_DIR` (PR #35) — the old name is now rejected fail-loud, not silently ignored. |

`CHANNEL_SOURCE` (a fixed constant, not env-configurable) is
`"claude-code-telegrammer"`.

## CLI entrypoint

`src/claude_code_telegrammer/_cli.py` is a thin Python launcher that `execv`s
`bun run ts/telegram-server.ts` — all real logic (env resolution, the MCP
server, the poller) lives in TypeScript, never reimplemented in Python.

```
claude-code-telegrammer mcp [start]   # start the MCP server + poller (default)
claude-code-telegrammer config [--check]  # print resolved config as JSON, no server/poller started
claude-code-telegrammer health        # run the health check (doctor), print JSON report, no server started
claude-code-telegrammer --version     # print the package version
```

`bin/claude-code-telegrammer-init` and `bin/claude-code-telegrammer-hook` are
separate shell helpers used by scitex-agent-container's agent lifecycle hooks
(`pre-start`/`post-start`/`pre-stop`) to write `access.json`/`.env`/per-agent
`.mcp.json` and send configured startup commands to a screen session — they
predate and sit alongside the MCP server, not inside it.

## Where to look

- `ts/telegram-server.ts` — server bootstrap, startup fail-loud guards, `health`/`config` probe subcommands
- `ts/lib/tools.ts` — MCP tool definitions/handlers
- `ts/lib/config.ts`, `ts/lib/env.ts` — env var resolution
- `docs/architecture.md`, `docs/interfaces.md`, `docs/configuration.md` — full reference docs
