#!/bin/bash
# enforce_background_subagents.sh — Hook to enforce subagent background execution
# Copy to ~/.claude/to_claude/hooks/ for use with Claude Code
set -euo pipefail

# This hook checks if a subagent is being spawned in foreground mode
# when the agent role is "telegram" and blocks it, requiring background mode.

if [[ "${CLAUDE_AGENT_ROLE:-}" != "telegram" ]]; then
    exit 0
fi

# Parse the hook input (passed as JSON on stdin if available)
INPUT=""
if [[ ! -t 0 ]]; then
    INPUT=$(cat)
fi

if [[ -z "$INPUT" ]]; then
    exit 0
fi

# Check if this is a subagent invocation
if echo "$INPUT" | grep -qF '"tool":"Agent"'; then
    # Check if background flag is set
    if ! echo "$INPUT" | grep -qF '"run_in_background":true'; then
        echo "BLOCKED: Telegram agent must run subagents in background mode." >&2
        echo "Add run_in_background: true to the Agent tool call." >&2
        exit 1
    fi
fi

exit 0
