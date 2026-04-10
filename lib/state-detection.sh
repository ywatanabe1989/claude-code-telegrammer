#!/bin/bash
# state-detection.sh — Pattern matching for Claude Code TUI states
# Sourced by claude-code-telegrammer-watchdog; also runnable standalone with --self-test
set -euo pipefail

# Detect the current state of Claude Code from captured screen text.
# Returns one of: running, y_y_n, y_n, waiting, unknown
detect_state() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        echo "unknown"
        return
    fi

    local content
    # Try tr first (preserves unicode), fall back to strings (for binary hardcopy)
    content=$(tr -d '\0' < "$file" 2>/dev/null || cat "$file")
    # Also get strings-only version for hardcopy binary data
    local content_strings
    content_strings=$(strings "$file" 2>/dev/null || true)

    # Empty capture
    if [[ -z "$content" ]]; then
        echo "unknown"
        return
    fi

    # ── :running — Claude is actively working ─────────────────────────
    if echo "$content" | grep -qF "(esc to interrupt"; then
        echo "running"
        return
    fi
    if echo "$content" | grep -qF "tokens ·"; then
        echo "running"
        return
    fi
    # Unicode ellipsis patterns (e.g., "Reading…", "Writing…")
    if echo "$content" | grep -q "ing…"; then
        echo "running"
        return
    fi

    # ── :y/y/n — Three-choice permission prompt ──────────────────────
    # Must check BEFORE y/n since y/y/n menus also contain "Yes"
    if echo "$content" | grep -qF "2. Yes, and"; then
        echo "y_y_n"
        return
    fi
    if echo "$content" | grep -qF "2. Yes, allow"; then
        echo "y_y_n"
        return
    fi
    if echo "$content" | grep -qF "2. Yes, don't ask"; then
        echo "y_y_n"
        return
    fi

    # ── :y/n — Two-choice permission prompt ──────────────────────────
    if echo "$content" | grep -qF "❯ 1. Yes"; then
        echo "y_n"
        return
    fi
    # Screen hardcopy may strip unicode ❯, fallback pattern
    if echo "$content" | grep -qF "1. Yes"; then
        if echo "$content" | grep -qF "3. No"; then
            echo "y_n"
            return
        fi
    fi

    # ── :waiting — Claude finished, waiting for user input ───────────
    # Cooking-pun completion messages
    if echo "$content" | grep -qE "(Crunched|Sautéed|Cogitated|Whipped up|Brewed|Cooked|Marinated|Stewed|Baked|Simmered|Crafted|Distilled) for"; then
        echo "waiting"
        return
    fi

    # Empty prompt line (cursor at prompt with nothing typed)
    if echo "$content" | grep -qF "❯ "; then
        local last_prompt_line
        last_prompt_line=$(echo "$content" | grep "❯ " | tail -1 | sed 's/[[:space:]]*$//')
        if [[ "$last_prompt_line" == "❯" || "$last_prompt_line" == "❯ " ]]; then
            echo "waiting"
            return
        fi
    fi

    # Screen hardcopy patterns (binary data, use strings-extracted content)
    # Claude Code idle screen shows these patterns
    if echo "$content_strings" | grep -qF "bypass permissions on"; then
        echo "waiting"
        return
    fi
    if echo "$content_strings" | grep -qF "shift+tab to cycle"; then
        echo "waiting"
        return
    fi
    if echo "$content_strings" | grep -qF "Tips for getting"; then
        echo "waiting"
        return
    fi

    echo "unknown"
}

# ── Self-test ─────────────────────────────────────────────────────────
state_detection_self_test() {
    local tmpfile
    tmpfile=$(mktemp)
    local pass=0
    local fail=0

    run_test() {
        local desc="$1"
        local expected="$2"
        local input="$3"

        echo "$input" >"$tmpfile"
        local got
        got=$(detect_state "$tmpfile")
        if [[ "$got" == "$expected" ]]; then
            printf "  PASS: %s\n" "$desc"
            ((pass++)) || true
        else
            printf "  FAIL: %s (expected=%s got=%s)\n" "$desc" "$expected" "$got"
            ((fail++)) || true
        fi
    }

    echo "state-detection self-test"
    echo "========================="

    run_test "running: esc to interrupt" "running" \
        "Some output here
(esc to interrupt)"

    run_test "running: tokens counter" "running" \
        "Processing request  12.3k tokens · 2.1s"

    run_test "running: unicode ellipsis" "running" \
        "Reading…"

    run_test "y_y_n: Yes, and" "y_y_n" \
        "Allow this action?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No"

    run_test "y_y_n: Yes, allow" "y_y_n" \
        "Permission needed
❯ 1. Yes
  2. Yes, allow for this session
  3. No"

    run_test "y_y_n: Yes, don't ask" "y_y_n" \
        "Run this command?
❯ 1. Yes
  2. Yes, don't ask again for this tool
  3. No"

    run_test "y_n: simple yes/no" "y_n" \
        "Run command: ls -la
❯ 1. Yes
  2. No"

    run_test "waiting: cooking pun" "waiting" \
        "Crafted for 3.2s
❯ "

    run_test "waiting: empty prompt" "waiting" \
        "Some previous output
❯ "

    run_test "unknown: empty file" "unknown" ""

    run_test "unknown: random text" "unknown" "Hello world"

    rm -f "$tmpfile"
    echo "========================="
    printf "Results: %d passed, %d failed\n" "$pass" "$fail"
    return "$fail"
}

if [[ "${1:-}" == "--self-test" ]]; then
    state_detection_self_test
fi
