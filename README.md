# claude-code-telegrammer

Screen-based auto-responder watchdog for Claude Code TUI. Runs Claude Code as an autonomous Telegram agent with just GNU Screen and Bash.

## What It Does

Claude Code's TUI blocks on permission prompts (`y/n`, `y/y/n`) and goes idle after completing tasks. claude-code-telegrammer polls the screen session, detects these states via pattern matching, and sends the appropriate keystrokes to keep the agent running unattended.

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

## Quick Start

1. Start Claude Code in a screen session manually, or use the CLI:

```bash
telegrammer start --config config/telegram-master.yaml
```

2. The watchdog begins polling automatically. Check status:

```bash
telegrammer status
```

3. Attach to the session to observe:

```bash
screen -r cld-telegram    # Ctrl-A D to detach
```

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

## Configuration

YAML config file (all fields under `spec`):

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

## Integration with scitex-agent-container

claude-code-telegrammer is the low-level watchdog engine. [scitex-agent-container](https://github.com/ywatanabe1989/scitex-agent-container) provides the higher-level orchestration layer:

```bash
pip install scitex-agent-container[telegram]
```

When used together, scitex-agent-container handles lifecycle management (health checks, restart policies, hooks) while claude-code-telegrammer handles the screen-level auto-response.

## License

AGPL-3.0

<!-- EOF -->
