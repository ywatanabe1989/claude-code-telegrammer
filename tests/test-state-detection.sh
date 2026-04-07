#!/bin/bash
# test-state-detection.sh — Integration tests for state detection and auto-response
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# shellcheck source=../lib/common.sh
source "${LIB_DIR}/common.sh"
# shellcheck source=../lib/state-detection.sh
source "${LIB_DIR}/state-detection.sh"
# shellcheck source=../lib/lock.sh
source "${LIB_DIR}/lock.sh"

TMPDIR_TEST=$(mktemp -d /tmp/telegrammer-test.XXXXXX)
PASS=0
FAIL=0
TOTAL=0

cleanup() {
    rm -rf "$TMPDIR_TEST"
}
trap cleanup EXIT

# ── Test helpers ──────────────────────────────────────────────────────
assert_state() {
    local desc="$1"
    local expected="$2"
    local input="$3"
    local tmpfile="${TMPDIR_TEST}/state-input.txt"

    ((TOTAL++)) || true
    echo "$input" >"$tmpfile"
    local got
    got=$(detect_state "$tmpfile")
    if [[ "$got" == "$expected" ]]; then
        printf "  PASS: %s\n" "$desc"
        ((PASS++)) || true
    else
        printf "  FAIL: %s (expected=%s got=%s)\n" "$desc" "$expected" "$got"
        ((FAIL++)) || true
    fi
}

assert_eq() {
    local desc="$1"
    local expected="$2"
    local got="$3"

    ((TOTAL++)) || true
    if [[ "$got" == "$expected" ]]; then
        printf "  PASS: %s\n" "$desc"
        ((PASS++)) || true
    else
        printf "  FAIL: %s (expected=%s got=%s)\n" "$desc" "$expected" "$got"
        ((FAIL++)) || true
    fi
}

# ── State Detection Tests ─────────────────────────────────────────────
echo ""
echo "=== State Detection Tests ==="
echo ""

# Running states
assert_state "running: esc to interrupt" "running" \
    "Processing...
(esc to interrupt)"

assert_state "running: token counter" "running" \
    "Analyzing code  45.2k tokens · 8.3s"

assert_state "running: unicode ellipsis" "running" \
    "Writing…"

assert_state "running: reading ellipsis" "running" \
    "Reading…"

# y/y/n states
assert_state "y_y_n: yes and don't ask" "y_y_n" \
    "Claude wants to run: rm -rf /tmp/test
❯ 1. Yes
  2. Yes, and don't ask again for this tool
  3. No"

assert_state "y_y_n: yes allow" "y_y_n" \
    "Permission required
❯ 1. Yes
  2. Yes, allow for this session
  3. No"

assert_state "y_y_n: yes don't ask" "y_y_n" \
    "Execute command?
❯ 1. Yes
  2. Yes, don't ask again
  3. No"

# y/n states
assert_state "y_n: simple prompt" "y_n" \
    "Run this command?
❯ 1. Yes
  2. No"

assert_state "y_n: with context" "y_n" \
    "Some output above
More output
❯ 1. Yes
  2. No"

# Waiting states
assert_state "waiting: crunched" "waiting" \
    "Crunched for 2.1s
❯ "

assert_state "waiting: crafted" "waiting" \
    "Crafted for 5.0s
❯ "

assert_state "waiting: simmered" "waiting" \
    "Simmered for 12.3s

❯ "

assert_state "waiting: brewed" "waiting" \
    "Brewed for 0.8s
❯ "

assert_state "waiting: empty prompt only" "waiting" \
    "Some completed output here
❯ "

# Unknown states
assert_state "unknown: empty" "unknown" ""

assert_state "unknown: random text" "unknown" "Just some random text here"

assert_state "unknown: no patterns" "unknown" \
    "Line 1
Line 2
Line 3"

# ── Priority tests (y_y_n should match before y_n) ───────────────────
echo ""
echo "=== Priority Tests ==="
echo ""

assert_state "priority: y_y_n wins over y_n" "y_y_n" \
    "❯ 1. Yes
  2. Yes, and don't ask again
  3. No"

# ── Edge cases ────────────────────────────────────────────────────────
echo ""
echo "=== Edge Case Tests ==="
echo ""

assert_state "edge: file does not exist" "unknown" ""

# User typing (not waiting)
assert_state "edge: user typing at prompt" "unknown" \
    "Previous output
❯ some partial input"

assert_state "edge: running with long output" "running" \
    "Line 1
Line 2
Line 3
Line 4
Line 5
(esc to interrupt)"

# ── Lock Tests ────────────────────────────────────────────────────────
echo ""
echo "=== Lock Tests ==="
echo ""

TMPLOCK="${TMPDIR_TEST}/test.lock"

# Initially not locked
if ! is_locked "$TMPLOCK"; then
    assert_eq "lock: not locked initially" "ok" "ok"
else
    assert_eq "lock: not locked initially" "not-locked" "locked"
fi

# Acquire
acquire_lock "$TMPLOCK"
assert_eq "lock: file created" "true" "$(test -f "$TMPLOCK" && echo true || echo false)"

lock_pid=$(cat "$TMPLOCK")
assert_eq "lock: contains our PID" "$$" "$lock_pid"

if is_locked "$TMPLOCK"; then
    assert_eq "lock: is locked after acquire" "ok" "ok"
else
    assert_eq "lock: is locked after acquire" "locked" "not-locked"
fi

# Release
release_lock "$TMPLOCK"
assert_eq "lock: file removed" "false" "$(test -f "$TMPLOCK" && echo true || echo false)"

# Stale lock
echo "99999999" >"$TMPLOCK"
stale_result=$(check_stale "$TMPLOCK")
assert_eq "lock: stale detection" "stale" "$stale_result"

# Re-acquire after stale
acquire_lock "$TMPLOCK"
assert_eq "lock: acquired after stale" "$$" "$(cat "$TMPLOCK")"
release_lock "$TMPLOCK"

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo "========================================"
printf "Total: %d | Passed: %d | Failed: %d\n" "$TOTAL" "$PASS" "$FAIL"
echo "========================================"

if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
exit 0
