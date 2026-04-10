<!-- ---
!-- Timestamp: 2026-04-10 18:13:14
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
  <a href="https://badge.fury.io/py/claude-code-telegrammer"><img src="https://badge.fury.io/py/claude-code-telegrammer.svg" alt="PyPI version"></a>
  <a href="https://claude-code-telegrammer.readthedocs.io/"><img src="https://readthedocs.org/projects/claude-code-telegrammer/badge/?version=latest" alt="Documentation"></a>
  <a href="https://github.com/ywatanabe1989/claude-code-telegrammer/actions/workflows/test.yml"><img src="https://github.com/ywatanabe1989/claude-code-telegrammer/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
</p>

<p align="center">
  <a href="https://claude-code-telegrammer.readthedocs.io/">Documentation</a> ·
  <code>pip install claude-code-telegrammer</code>
</p>

---

## Problem

The official `plugin:telegram@claude-plugins-official` has several unresolved issues that make it unusable for production autonomous agents:

- **[#851](https://github.com/anthropics/claude-code/issues/851)** -- `STATE_DIR` not respected; access.json path hardcoded
- **[#1075](https://github.com/anthropics/claude-code/issues/1075)** -- 409 Conflict errors when multiple instances poll the same bot
- **[#1146](https://github.com/anthropics/claude-code/issues/1146)** -- Zombie CPU consumption after session ends

Additionally, Claude Code sessions running unattended will stall at permission prompts or idle states with no way to recover.

## Solution

Two subsystems that replace and extend the official plugin:

1. **Custom Telegram MCP Server** (`ts/`) -- A self-contained MCP server that fixes all three official plugin issues: configurable state directory via `CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR`, PID-based single-instance lock, and clean shutdown on stdin close/SIGTERM. Provides 10 MCP tools (vs 3 in the official plugin), SQLite message persistence, allowlist-based access control, and inbound reaction (`message_reaction`) delivery. Incoming messages are acknowledged with a 📩 reaction.

2. **TUI Watchdog** (`lib/`) -- Polls a GNU Screen session, detects Claude Code's TUI state via pattern matching, and sends keystrokes to keep the agent running unattended (auto-accepts permission prompts, re-engages on idle). Throttled with burst limits to prevent runaway responses. Orchestration and lifecycle management is handled by [scitex-agent-container](https://github.com/ywatanabe1989/scitex-agent-container).

<details>
<summary><strong>MCP Tools (10)</strong></summary>

| Tool | Description |
|------|-------------|
| `reply` | Reply on Telegram. Supports threading (`reply_to`), auto-marks inbound as read. Inbound reply-to-message references are tracked and forwarded. |
| `react` | Add an emoji reaction to a message. Inbound reactions (`message_reaction`) are also delivered as channel notifications. |
| `edit_message` | Edit a previously sent bot message. |
| `get_history` | Retrieve message history for a chat from local SQLite. |
| `get_unread` | List unread inbound messages, optionally filtered by `chat_id`. |
| `mark_read` | Mark messages as read by `chat_id` or `message_ids`. |
| `download_attachment` | Download a Telegram file by `file_id`, returns local path. |
| `send_document` | Upload a local file to a Telegram chat. |
| `search_messages` | Text search across stored messages. |
| `get_context` | Recent conversation formatted as compact text for LLM context. |

</details>

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

## Quickstart

### Get a Telegram Bot Token

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, then enter a name (e.g., `Claude Code Telegrammer`) and a username (e.g., `ClaudeCodeTelegrammerBot`)
3. BotFather replies with your token: `123456789:AAH...`
4. Verify your token works:
   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
   # Should return {"ok":true,"result":{"is_bot":true,...}}
   ```
5. Open your bot (e.g., [t.me/ClaudeCodeTelegrammerBot](https://t.me/ClaudeCodeTelegrammerBot)) and send any message to start a conversation

### Register MCP Server with Claude Code

Copy the example and fill in your values (`.mcp.json` is gitignored):

```json
{
  "mcpServers": {
    "claude-code-telegrammer": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/path/to/claude-code-telegrammer/ts/telegram-server.ts"],
      "env": {
        "CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN": "123456789:AAH...",
        "CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS": "YOUR_TELEGRAM_USER_ID",
        "CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR": "~/.claude-code-telegrammer"
      }
    }
  }
}
```

```bash
cp .mcp.json.example .mcp.json
# Edit .mcp.json with your token, user ID, and paths
```

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

### Run

```bash
claude \
    --dangerously-skip-permissions \
    --dangerously-load-development-channels server:claude-code-telegrammer
```

For full agent orchestration (screen sessions, watchdog, YAML configs), see [scitex-agent-container](https://github.com/ywatanabe1989/scitex-agent-container).

## Interfaces

<details>
<summary><strong>MCP Server -- for AI Agents</strong></summary>

Start command:
```bash
bun run ts/telegram-server.ts
```

10 tools exposed via MCP stdio protocol. See [MCP Tools](#solution) above. The server's MCP instructions include a responsiveness policy that directs the agent to acknowledge messages immediately and delegate heavy work to background subagents.

</details>

<details>
<summary><strong>Skills -- for AI Agent Discovery</strong></summary>

Skills are bundled at `src/claude_code_telegrammer/_skills/claude-code-telegrammer/SKILL.md`.

</details>

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
│    --mcp-config points to the custom MCP server              │
└──────────────────────┬───────────────────────────────────────┘
                       │ screen buffer
                       v
┌──────────────────────────────────────────────────────────────┐
│  Watchdog (claude-code-telegrammer-watchdog)                 │
│    Polls screen buffer every 1.5s                            │
│    Detects: y/n prompt -> "1", y/y/n -> "2", idle -> cmd     │
│    Throttled: burst limit, same-state delay, min interval    │
└──────────────────────────────────────────────────────────────┘
```

<details>
<summary><strong>State Detection</strong></summary>

| State | Pattern | Response |
|-------|---------|----------|
| `running` | `(esc to interrupt)`, `tokens ·`, `ing...` | No action |
| `y_n` | `1. Yes` + `3. No` (two-choice prompt) | Send `1` (accept) |
| `y_y_n` | `2. Yes, and...` / `2. Yes, allow...` / `2. Yes, don't ask...` | Send `2` (accept all) |
| `waiting` | Cooking puns (`Crafted for`, etc.), empty `>` prompt, idle hints | Send configurable command |

Response throttling: minimum interval between responses, burst limit (10 in 3s window), same-state delay.

</details>

<details>
<summary><strong>Configuration (Environment Variables)</strong></summary>

**MCP Server:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAUDE_CODE_TELEGRAMMER_TELEGRAM_BOT_TOKEN` | Yes | -- | Telegram Bot API token |
| `CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR` | No | `~/.claude-code-telegrammer` | Directory for SQLite DB, access.json, lock file |
| `CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS` | No | -- | Comma-separated Telegram user IDs for DM allowlist |
| `CLAUDE_CODE_TELEGRAMMER_TELEGRAM_HOST_NAME` | No | `os.hostname()` | Hostname stored with each message |
| `CLAUDE_CODE_TELEGRAMMER_TELEGRAM_PROJECT` | No | `process.cwd()` | Project path stored with each message |
| `CLAUDE_CODE_TELEGRAMMER_TELEGRAM_AGENT_ID` | No | `'telegram'` | Agent identifier stored with each message |

**Watchdog:**

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_CODE_TELEGRAMMER_SESSION` | `claude-code-telegrammer` | GNU Screen session name |
| `CLAUDE_CODE_TELEGRAMMER_WATCHDOG_INTERVAL` | `1.5` | Poll interval in seconds |
| `CLAUDE_CODE_TELEGRAMMER_RESP_Y_N` | `1` | Response for y/n prompts |
| `CLAUDE_CODE_TELEGRAMMER_RESP_Y_Y_N` | `2` | Response for y/y/n prompts |
| `CLAUDE_CODE_TELEGRAMMER_RESP_WAITING` | `/speak-and-call` | Response when idle/waiting |

</details>

<details>
<summary><strong>SQLite Schema (v2)</strong></summary>

All messages persisted in `$CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR/messages.db` using WAL mode.

**messages table:** direction, chat_id, message_id, user_id, username, text, timestamps (telegram_ts, received_at, read_at, replied_at), threading (reply_to_message_id, reply_to_row_id), identity (host, project, agent_id, bot_token_hash), raw_json.

**attachments table:** message_row_id (FK), kind, file_id, file_name, mime_type, file_size, local_path, downloaded_at.

**meta table:** key-value store for schema_version, update_offset.

</details>

<details>
<summary><strong>Integration with scitex-agent-container</strong></summary>

For YAML-based agent orchestration (screen sessions, watchdog lifecycle, restart policies), see [scitex-agent-container](https://github.com/ywatanabe1989/scitex-agent-container).

</details>

<details>
<summary><strong>Access Control</strong></summary>

Managed via `access.json` in `$CLAUDE_CODE_TELEGRAMMER_TELEGRAM_STATE_DIR`:

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

Merged with `CLAUDE_CODE_TELEGRAMMER_TELEGRAM_ALLOWED_USERS` env var at runtime. Mtime-based caching means edits take effect without restart.

</details>

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

## References

- [Claude Code Channels](https://docs.anthropic.com/en/docs/claude-code/channels) -- Official documentation for Claude Code's channel system
- [Official Telegram Plugin](https://github.com/anthropics/claude-code/tree/main/plugins/telegram) -- The `plugin:telegram@claude-plugins-official` source code
- [#851: STATE_DIR not respected](https://github.com/anthropics/claude-code/issues/851) -- Hardcoded access.json path
- [#1075: 409 Conflict errors](https://github.com/anthropics/claude-code/issues/1075) -- Multiple instances polling the same bot
- [#1146: Zombie CPU consumption](https://github.com/anthropics/claude-code/issues/1146) -- Runaway process after session ends
- [Telegram BotFather](https://t.me/BotFather) -- Create and manage Telegram bots
- [Telegram Bot API](https://core.telegram.org/bots/api) -- Official Bot API documentation
- [MCP Specification](https://modelcontextprotocol.io/) -- Model Context Protocol standard
- [claude-code-telegrammer Issues](https://github.com/ywatanabe1989/claude-code-telegrammer/issues) -- Bug reports and feature requests
- [claude-code-telegrammer Pull Requests](https://github.com/ywatanabe1989/claude-code-telegrammer/pulls) -- Contributions

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