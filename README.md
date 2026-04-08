<!-- ---
!-- Timestamp: 2026-04-08 18:06:35
!-- Author: ywatanabe
!-- File: /home/ywatanabe/proj/claude-code-telegrammer/README.md
!-- --- -->

<!-- SciTeX Convention: Header (logo, tagline, badges) -->
# claude-code-telegrammer

<p align="center">
  <a href="https://scitex.ai">
    <img src="docs/scitex-logo-blue-cropped.png" alt="SciTeX" width="400">
  </a>
</p>

<p align="center"><b>Custom Telegram MCP server + TUI auto-responder for running Claude Code as an autonomous Telegram agent</b></p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
</p>

---

## What This Does

Turns Claude Code into a fully autonomous Telegram bot. Two subsystems work together:

1. **Custom Telegram MCP Server** (`ts/`) -- A self-contained MCP server that replaces the broken official `plugin:telegram@claude-plugins-official`. Handles all Telegram Bot API communication, message persistence, attachment handling, and access control.

2. **TUI Watchdog** (`bin/`, `lib/`) -- Polls a GNU Screen session, detects Claude Code's TUI state via pattern matching, and sends keystrokes to keep the agent running unattended (auto-accepts permission prompts, re-engages on idle).

## Architecture

```
User (Telegram)
    |
    |  Bot API (getUpdates long-polling)
    v
┌──────────────────────────────────────────────────────────────┐
│  Custom Telegram MCP Server (ts/telegram-server.ts)          │
│    Bun + @modelcontextprotocol/sdk                           │
│                                                              │
│    ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌────────────┐    │
│    │ Poller  │  │  Store  │  │  Tools   │  │ Attachments│    │
│    │ (long   │  │ (SQLite │  │ (10 MCP  │  │ (download  │    │
│    │  poll)  │  │  WAL)   │  │  tools)  │  │  queue)    │    │
│    └─────────┘  └─────────┘  └──────────┘  └────────────┘    │
│    ┌─────────┐  ┌─────────┐  ┌──────────┐                    │
│    │ Access  │  │  Config │  │   Lock   │                    │
│    │ (allow- │  │ (env    │  │ (PID     │                    │
│    │  list)  │  │  vars)  │  │  file)   │                    │
│    └─────────┘  └─────────┘  └──────────┘                    │
└──────────────────────┬───────────────────────────────────────┘
                       │ MCP stdio
                       v
┌──────────────────────────────────────────────────────────────┐
│  Claude Code (in GNU Screen session)                         │
│    --channels or --mcp-config points to the MCP server       │
└──────────────────────┬───────────────────────────────────────┘
                       │ screen buffer
                       v
┌──────────────────────────────────────────────────────────────┐
│  Watchdog (bin/telegrammer-watchdog)                         │
│    Polls screen buffer every 1.5s                            │
│    Detects: y/n prompt -> "1", y/y/n -> "2", idle -> cmd     │
│    Throttled: burst limit, same-state delay, min interval    │
└──────────────────────────────────────────────────────────────┘
```

## Why Custom? (Official Plugin Issues)

The official `plugin:telegram@claude-plugins-official` has several unresolved issues that make it unusable for production:

- **[#851](https://github.com/anthropics/claude-code/issues/851)** -- `STATE_DIR` not respected; access.json path hardcoded
- **[#1075](https://github.com/anthropics/claude-code/issues/1075)** -- 409 Conflict errors when multiple instances poll the same bot
- **[#1146](https://github.com/anthropics/claude-code/issues/1146)** -- Zombie CPU consumption after session ends

This custom MCP server fixes all three: configurable state directory via `TELEGRAM_STATE_DIR`, PID-based single-instance lock, and clean shutdown on stdin close/SIGTERM.

## Components

### Custom Telegram MCP Server (`ts/`)

A Bun-based MCP server that communicates with the Telegram Bot API directly via `fetch` (no grammy dependency). Connects to Claude Code over stdio using `@modelcontextprotocol/sdk`.

Key files:
- `ts/telegram-server.ts` -- Entry point, MCP server setup, shutdown handling
- `ts/lib/poller.ts` -- `getUpdates` long-polling loop with offset persistence
- `ts/lib/store.ts` -- SQLite message store (schema v2)
- `ts/lib/tools.ts` -- All 10 MCP tool definitions and handlers
- `ts/lib/attachments.ts` -- Background download queue (rate-limited, 500ms between downloads)
- `ts/lib/access.ts` -- Allowlist-based access control with mtime-cached `access.json`
- `ts/lib/config.ts` -- All configuration constants from environment variables
- `ts/lib/lock.ts` -- PID-based single-instance enforcement
- `ts/lib/telegram-api.ts` -- Raw Bot API wrapper
- `ts/lib/log.ts` -- Structured JSON logging to stderr

### Watchdog (`bin/telegrammer-watchdog`)

Polls a GNU Screen session at a configurable interval, detects Claude Code's TUI state via pattern matching, and sends keystrokes.

```bash
telegrammer-watchdog --session cld-telegram --interval 1.5
telegrammer-watchdog --dry-run          # detect without responding
telegrammer-watchdog --self-test        # run built-in state detection tests
```

### Hook (`bin/telegrammer-hook`)

Entry point for scitex-agent-container integration. Called by agent-container's lifecycle hooks:

```bash
telegrammer-hook pre-start     # Write access.json, .env, MCP config JSON
telegrammer-hook post-start    # Start watchdog + send startup commands
telegrammer-hook pre-stop      # Stop watchdog
```

The `pre-start` hook handles: bot token mapping (`bot_token_env` -> `TELEGRAM_BOT_TOKEN`), writing `access.json` from YAML `allowed_users`, generating MCP config for `--mcp-config` and `.mcp.json`.

### Init (`bin/telegrammer-init`)

Sends startup commands to a running Claude Code screen session and configures `access.json`.

```bash
telegrammer-init --session cld-telegram --config telegram-master.yaml
```

### Guard (`bin/telegrammer-guard`)

Lock/exclusivity guard. Ensures only one telegrammer instance controls a session.

```bash
telegrammer-guard acquire --lock ~/.scitex/agent-container/telegram/telegram.lock
telegrammer-guard release
telegrammer-guard status
telegrammer-guard check     # exit 0 if locked, 1 if not
telegrammer-guard force     # force-remove lock
```

### Main CLI (`bin/telegrammer`)

Full lifecycle management of a Claude Code Telegram agent in a screen session.

```bash
telegrammer start config/telegram-master.yaml
telegrammer stop
telegrammer status
telegrammer attach
telegrammer logs
```

## MCP Tools (10)

All tools are exposed via the MCP server and available to Claude Code during a session:

| Tool | Description |
|------|-------------|
| `reply` | Reply on Telegram. Supports threading (`reply_to`), auto-marks inbound as read, persists outbound to DB. |
| `react` | Add an emoji reaction to a message. Telegram's fixed whitelist applies. |
| `edit_message` | Edit a previously sent bot message. Edits don't trigger push notifications. |
| `get_history` | Retrieve message history (both directions) for a chat from local SQLite. |
| `get_unread` | List unread inbound messages, optionally filtered by `chat_id`. |
| `mark_read` | Mark messages as read by `chat_id` (all) or `message_ids` (specific rows). |
| `download_attachment` | Download a Telegram file by `file_id`, returns local path. |
| `send_document` | Upload a local file to a Telegram chat via `sendDocument`. |
| `search_messages` | Text search across stored messages using `LIKE %query%`. |
| `get_context` | Recent conversation formatted as compact text for LLM context. |

## SQLite Schema (v2)

All messages are persisted in `$TELEGRAM_STATE_DIR/messages.db` using WAL mode.

### `messages` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment row ID |
| `direction` | TEXT | `'inbound'` or `'outbound'` |
| `chat_id` | TEXT | Telegram chat ID |
| `message_id` | TEXT | Telegram message ID |
| `user_id` | TEXT | Sender's Telegram user ID |
| `username` | TEXT | Sender's username |
| `text` | TEXT | Message content |
| `telegram_ts` | TEXT | Original Telegram timestamp (ISO 8601) |
| `received_at` | TEXT | When this server received the message |
| `read_at` | TEXT | When marked as read (NULL = unread) |
| `replied_at` | TEXT | When replied to (NULL = unreplied) |
| `reply_to_message_id` | TEXT | Telegram message ID being replied to |
| `reply_to_row_id` | INTEGER FK | DB row of inbound message being replied to |
| `host` | TEXT | Hostname of the machine running the server |
| `project` | TEXT | Working directory / project path |
| `agent_id` | TEXT | Agent identifier |
| `bot_token_hash` | TEXT | First 8 chars of SHA-256 of bot token |
| `raw_json` | TEXT | Full Telegram update JSON (inbound only) |
| `created_at` | TEXT | Row creation timestamp |

Key indexes: dedup on `(chat_id, message_id, direction)`, unread index, unreplied index, agent identity index.

### `attachments` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `message_row_id` | INTEGER FK | References `messages(id)` with CASCADE delete |
| `kind` | TEXT | `photo`, `document`, `voice`, `audio`, `video` |
| `file_id` | TEXT | Telegram file ID |
| `file_unique_id` | TEXT | Telegram file unique ID |
| `file_name` | TEXT | Original filename |
| `mime_type` | TEXT | MIME type |
| `file_size` | INTEGER | Size in bytes |
| `local_path` | TEXT | Local download path (NULL until downloaded) |
| `downloaded_at` | TEXT | When download completed |

### `meta` table

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT PK | e.g., `'schema_version'`, `'update_offset'` |
| `value` | TEXT | Stored value |

## Configuration

### Environment Variables (MCP Server)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | -- | Telegram Bot API token |
| `TELEGRAM_STATE_DIR` | No | `~/.scitex/agent-container/telegram` | Directory for SQLite DB, access.json, lock file |
| `TELEGRAM_ALLOWED_USERS` | No | -- | Comma-separated Telegram user IDs for DM allowlist |
| `TELEGRAM_HOST_NAME` | No | `os.hostname()` | Hostname stored with each message |
| `TELEGRAM_PROJECT` | No | `process.cwd()` | Project path stored with each message |
| `TELEGRAM_AGENT_ID` | No | `'telegram'` | Agent identifier stored with each message |
| `TELEGRAM_ATTACHMENT_DIR` | No | `$TELEGRAM_STATE_DIR/attachments` | Directory for downloaded attachments |

### Environment Variables (Watchdog)

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAMMER_SESSION` | `cld-telegram` | GNU Screen session name |
| `TELEGRAMMER_WATCHDOG_INTERVAL` | `1.5` | Poll interval in seconds |
| `TELEGRAMMER_RESP_Y_N` | `1` | Response for y/n prompts |
| `TELEGRAMMER_RESP_Y_Y_N` | `2` | Response for y/y/n prompts |
| `TELEGRAMMER_RESP_WAITING` | `/speak-and-call` | Response when idle/waiting |

## State Detection

The watchdog reads the screen buffer and matches against these patterns:

| State | Pattern | Response |
|-------|---------|----------|
| `running` | `(esc to interrupt)`, `tokens ·`, `ing...` | No action |
| `y_n` | `1. Yes` + `3. No` (two-choice prompt) | Send `1` (accept) |
| `y_y_n` | `2. Yes, and...` / `2. Yes, allow...` / `2. Yes, don't ask...` | Send `2` (accept all) |
| `waiting` | Cooking puns (`Crafted for`, etc.), empty `>` prompt, idle hints | Send configurable command |

Response throttling: minimum interval between responses, burst limit (10 in 3s window), same-state delay.

## Integration with scitex-agent-container

Add a `telegram` section and `hooks` to your agent YAML:

```yaml
apiVersion: telegrammer/v1
kind: Agent
metadata:
  name: telegram-master
spec:
  model: opus[1m]
  flags:
    - --dangerously-skip-permissions
    - --strict-mcp-config
    - "--mcp-config /tmp/scitex-agent-container/mcp-{agent-name}.json"
    - "--dangerously-load-development-channels server:telegram"
  workdir: ~/proj
  env:
    CLAUDE_AGENT_ROLE: telegram
    CLAUDE_AGENT_ID: telegram-master
  telegram:
    bot_token_env: SCITEX_OROCHI_TELEGRAM_BOT_TOKEN
    auto_connect: true
    allowed_users:
      - 123456789
  screen:
    name: cld-telegram
  watchdog:
    enabled: true
    interval: 1.5
    responses:
      y_n: "1"
      y_y_n: "2"
      waiting: "/speak-and-call"
  lock:
    path: ~/.scitex/agent-container/telegram/telegram.lock
  hooks:
    pre_start: telegrammer-hook pre-start
    post_start: telegrammer-hook post-start
    pre_stop: telegrammer-hook pre-stop
```

The `telegrammer-hook pre-start` phase generates MCP config JSON so Claude Code can discover the custom server via `--mcp-config` or `.mcp.json`.

## Installation

### Prerequisites

- Python >= 3.10 and GNU Screen (for watchdog/CLI)
- [Bun](https://bun.sh/) >= 1.0 (for the MCP server)

### Install

```bash
pip install claude-code-telegrammer
```

Or from source:

```bash
git clone https://github.com/ywatanabe1989/claude-code-telegrammer.git
cd claude-code-telegrammer
pip install -e .

# Install TypeScript dependencies for the MCP server
cd ts && bun install
```

## Quick Start

```bash
# 1. Export your bot token
export TELEGRAM_BOT_TOKEN="123456789:AAH..."

# 2. Start the MCP server standalone (for testing)
bun run ts/telegram-server.ts

# 3. Or start a full agent with watchdog from a YAML config
telegrammer start config/telegram-master.yaml

# 4. Check status
telegrammer status

# 5. Attach to the screen session to observe
screen -r cld-telegram    # Ctrl-A D to detach
```

## Access Control

Access is managed via `access.json` in `$TELEGRAM_STATE_DIR`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["123456789"],
  "groups": {
    "-100123456": {
      "requireMention": true,
      "allowFrom": ["123456789"]
    }
  }
}
```

The allowlist is merged with `TELEGRAM_ALLOWED_USERS` env var at runtime. Mtime-based caching means edits to `access.json` take effect without restart.

<!-- SciTeX Convention: Ecosystem -->
## Part of SciTeX

claude-code-telegrammer is part of [**SciTeX**](https://scitex.ai). It provides the Telegram communication layer and TUI watchdog used by [scitex-agent-container](https://github.com/ywatanabe1989/scitex-agent-container) for autonomous agent operation.

```
┌─────────────────────────────────────────────────────────┐
│ scitex-orochi         — agent definitions, dashboard    │
└──────────────────────────┬──────────────────────────────┘
                           v
┌─────────────────────────────────────────────────────────┐
│ scitex-agent-container  — lifecycle, health, restart    │
└──────────────────────────┬──────────────────────────────┘
                           v
┌─────────────────────────────────────────────────────────┐
│ claude-code-telegrammer  <-- YOU ARE HERE               │
│   MCP server: Telegram API, message DB, 10 tools        │
│   Watchdog: TUI auto-response, screen polling           │
└─────────────────────────────────────────────────────────┘
```

<!-- SciTeX Convention: Footer (Four Freedoms + icon) -->
>Four Freedoms for Research
>
>0. The freedom to **run** your research anywhere -- your machine, your terms.
>1. The freedom to **study** how every step works -- from raw data to final manuscript.
>2. The freedom to **redistribute** your workflows, not just your papers.
>3. The freedom to **modify** any module and share improvements with the community.
>
>AGPL-3.0 -- because we believe research infrastructure deserves the same freedoms as the software it runs on.

---

<p align="center">
  <a href="https://scitex.ai" target="_blank"><img src="docs/scitex-icon-navy-inverted.png" alt="SciTeX" width="40"/></a>
</p>

<!-- EOF -->