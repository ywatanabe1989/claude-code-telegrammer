<!-- SciTeX Convention: Header (logo, tagline, badges) -->
# claude-code-telegrammer

<p align="center">
  <a href="https://scitex.ai">
    <img src="docs/scitex-logo-blue-cropped.png" alt="SciTeX" width="400">
  </a>
</p>

<p align="center"><b>Screen-based auto-responder watchdog for Claude Code TUI</b></p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
</p>

---

<!-- SciTeX Convention: Problem & Solution -->
## Problem

Claude Code's TUI blocks on permission prompts (`y/n`, `y/y/n`) and goes idle after completing tasks. Running Claude Code as an autonomous agent -- for example, as a Telegram bot -- requires something to detect these states and respond automatically, or the agent stalls within seconds.

## Solution

claude-code-telegrammer polls a GNU Screen session, detects Claude Code's TUI state via pattern matching, and sends the appropriate keystrokes to keep the agent running unattended. No modifications to Claude Code itself -- just screen buffer inspection and keystroke injection.

```
Claude Code (in screen)
    |
    +-- telegrammer-watchdog polls screen buffer every 1.5s
    |       |
    |       +-- Detects "y/n" prompt  --> sends "1" (accept)
    |       +-- Detects "y/y/n" prompt --> sends "2" (accept all)
    |       +-- Detects idle/waiting   --> sends "/speak-and-call"
    |
    +-- telegrammer-guard ensures single instance via lock file
```

<!-- SciTeX Convention: Installation -->
## Installation

Requires Python >= 3.10 and GNU Screen.

```bash
pip install claude-code-telegrammer
```

Or install from source:

```bash
git clone https://github.com/ywatanabe1989/claude-code-telegrammer.git
cd claude-code-telegrammer
pip install -e .
```

<!-- SciTeX Convention: Quickstart -->
## Quickstart

```bash
# Start an agent from a YAML config
telegrammer start --config config/telegram-master.yaml

# Check status
telegrammer status

# Attach to the screen session to observe
screen -r cld-telegram    # Ctrl-A D to detach
```

<!-- Custom: Components (package-specific) -->
## Components

### telegrammer

Main CLI entry point. Manages the full lifecycle of a Claude Code Telegram agent in a screen session.

```bash
telegrammer start --config telegram-master.yaml
telegrammer stop
telegrammer status
telegrammer restart
```

### telegrammer-watchdog

The core auto-responder. Polls a screen session at a configurable interval, detects Claude Code's TUI state, and sends keystrokes.

```bash
telegrammer-watchdog --session cld-telegram --interval 1.5
telegrammer-watchdog --dry-run          # detect without responding
telegrammer-watchdog --self-test        # run built-in state detection tests
```

### telegrammer-guard

Lock/exclusivity guard. Ensures only one telegrammer instance controls a session at a time.

```bash
telegrammer-guard acquire --lock ~/.claude/channels/telegram/telegram.lock
telegrammer-guard release
telegrammer-guard status
telegrammer-guard check     # exit 0 if locked, 1 if not
telegrammer-guard force     # force-remove lock
```

### telegrammer-init

Sends startup commands to a running Claude Code screen session and optionally configures Telegram `access.json`.

```bash
telegrammer-init --session cld-telegram --config telegram-master.yaml
```

<!-- Custom: State Detection (package-specific) -->
## State Detection

The watchdog reads the screen buffer and matches against these patterns:

| State | Pattern | Response |
|-------|---------|----------|
| Permission prompt (y/n) | Claude asking for single approval | Send `1` (yes) |
| Permission prompt (y/y/n) | Claude asking with "yes to all" option | Send `2` (yes to all) |
| Idle / waiting | Agent completed task, waiting for input | Send `/speak-and-call` |

Responses are configurable via YAML or environment variables:

```bash
export TELEGRAMMER_RESP_Y_N="1"
export TELEGRAMMER_RESP_Y_Y_N="2"
export TELEGRAMMER_RESP_WAITING="/speak-and-call"
```

<!-- Custom: Configuration (package-specific) -->
## Configuration

```yaml
apiVersion: telegrammer/v1
kind: Agent
metadata:
  name: telegram-master
spec:
  model: opus[1m]
  channels:
    - plugin:telegram@claude-plugins-official
  flags:
    - --dangerously-skip-permissions
    - --continue
  workdir: ~/proj
  env:
    CLAUDE_AGENT_ROLE: telegram
    CLAUDE_AGENT_ID: telegram-master
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
    path: ~/.claude/channels/telegram/telegram.lock
  restart:
    enabled: false
    max_retries: 3
    backoff: exponential
```

<!-- SciTeX Convention: Ecosystem -->
## Part of SciTeX

claude-code-telegrammer is part of [**SciTeX**](https://scitex.ai). It is the low-level watchdog engine used by [scitex-agent-container](https://github.com/ywatanabe1989/scitex-agent-container) for higher-level agent lifecycle management.

```bash
pip install scitex-agent-container[telegram]
```

When used together, scitex-agent-container handles lifecycle management (health checks, restart policies, hooks) while claude-code-telegrammer handles the screen-level auto-response.

<!-- Custom: Role in Pipeline (package-specific) -->
## Role in the Agent Pipeline

The Telegrammer bot illustrates how credentials cascade through the SciTeX agent stack:

```
┌─────────────────────────────────────────────────────────┐
│ ~/.bash.d/secrets/                                      │
│  SCITEX_OROCHI_TELEGRAM_BOT_TOKEN="..."                 │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ scitex-orochi                                           │
│  agents/orochi-telegrammer.yaml                         │
│    bot_token_env: SCITEX_OROCHI_TELEGRAM_BOT_TOKEN      │
│    (YAML holds env var NAME, never the secret)          │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ scitex-agent-container                                  │
│  Reads YAML, resolves env var, injects into session     │
│  Manages lifecycle, health checks, restart policies     │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ claude-code-telegrammer  ◀── YOU ARE HERE               │
│  ✓ Polls screen buffer every 1.5s                       │
│  ✓ Detects TUI prompts (y/n, y/y/n, idle)              │
│  ✓ Sends keystrokes to unblock Claude Code              │
│  ✓ Manages lock file for single-instance                │
│  ✗ Does NOT manage, store, or handle bot tokens         │
│  ✗ Does NOT communicate with Telegram API               │
│  ✗ Does NOT know about YAML configs or orochi           │
└─────────────────────────────────────────────────────────┘
```

### Separation of Concerns

| Layer | Responsibility | Token Handling |
|-------|---------------|----------------|
| **scitex-orochi** | Defines agent configs, Telegram bridge, dashboard | Owns env var name in YAML |
| **scitex-agent-container** | Reads YAML, launches agent, injects env | Resolves and exports token |
| **claude-code-telegrammer** (this) | TUI automation, screen polling | Receives via env, never manages |

### What This Package Does NOT Do

- **Token management** -- handled by upstream (scitex-agent-container)
- **Telegram API calls** -- handled by Claude Code's built-in telegram plugin
- **Agent lifecycle** -- handled by scitex-agent-container
- **Orochi hub communication** -- handled by scitex-orochi

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
