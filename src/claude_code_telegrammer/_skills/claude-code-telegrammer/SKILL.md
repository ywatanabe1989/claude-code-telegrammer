---
name: claude-code-telegrammer
description: TUI watchdog for Claude Code — screen polling, auto-response, lock management. Bottom layer of the SciTeX agent stack.
version: 0.3.0
---

# claude-code-telegrammer

TUI watchdog that keeps Claude Code sessions alive by auto-responding to prompts.

## Credential Cascade

```
ENV (SCITEX_OROCHI_TELEGRAM_BOT_TOKEN)
  ▼
scitex-orochi
  agents/orochi-telegrammer.yaml (bot_token_env references env var)
  ▼
scitex-agent-container
  Reads YAML, injects env into session
  ▼
claude-code-telegrammer  ◀── YOU ARE HERE
  ✓ Polls screen buffer every 1.5s
  ✓ Detects TUI prompts (y/n, y/y/n, idle)
  ✓ Sends keystrokes to unblock
  ✗ Does NOT manage tokens
  ✗ Does NOT call Telegram API
  ✗ Does NOT know about YAML configs
```

## Components

| Binary | Purpose |
|--------|---------|
| telegrammer | Main CLI orchestrator |
| claude-code-telegrammer-watchdog | Screen-based auto-responder |
| claude-code-telegrammer-guard | Lock file manager |
| claude-code-telegrammer-init | Session initializer |
| claude-code-telegrammer-relay | Orochi relay |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| CLAUDE_CODE_TELEGRAMMER_SESSION | claude-code-telegrammer | Screen session name |
| CLAUDE_CODE_TELEGRAMMER_WATCHDOG_INTERVAL | 1.5 | Poll interval (seconds) |
| CLAUDE_CODE_TELEGRAMMER_RESP_Y_N | 1 | Response to y/n prompt |
| CLAUDE_CODE_TELEGRAMMER_RESP_Y_Y_N | 2 | Response to y/y/n prompt |
| CLAUDE_CODE_TELEGRAMMER_RESP_WAITING | /speak-and-call | Command when idle |
