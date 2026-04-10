#!/bin/bash
# test-state-detection.sh — Integration tests for state detection, auto-response, lock, and health
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

# shellcheck source=../lib/common.sh
source "${LIB_DIR}/common.sh"
# shellcheck source=../lib/state-detection.sh
source "${LIB_DIR}/state-detection.sh"
# shellcheck source=../lib/lock.sh
source "${LIB_DIR}/lock.sh"
# shellcheck source=../lib/auto-response.sh
source "${LIB_DIR}/auto-response.sh"

TMPDIR_TEST=$(mktemp -d /tmp/claude-code-telegrammer-test.XXXXXX)
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

assert_rc() {
    local desc="$1"
    local expected_rc="$2"
    local actual_rc="$3"

    ((TOTAL++)) || true
    if [[ "$actual_rc" == "$expected_rc" ]]; then
        printf "  PASS: %s\n" "$desc"
        ((PASS++)) || true
    else
        printf "  FAIL: %s (expected rc=%s got rc=%s)\n" "$desc" "$expected_rc" "$actual_rc"
        ((FAIL++)) || true
    fi
}

# ══════════════════════════════════════════════════════════════════════
# §1  State Detection Tests
# ══════════════════════════════════════════════════════════════════════
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

# ══════════════════════════════════════════════════════════════════════
# §2  Priority Tests (y_y_n should match before y_n)
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "=== Priority Tests ==="
echo ""

assert_state "priority: y_y_n wins over y_n" "y_y_n" \
    "❯ 1. Yes
  2. Yes, and don't ask again
  3. No"

# ══════════════════════════════════════════════════════════════════════
# §3  Edge Cases
# ══════════════════════════════════════════════════════════════════════
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

# ── Hardcopy binary fallback patterns ────────────────────────────────
assert_state "edge: hardcopy bypass permissions" "waiting" \
    "bypass permissions on"

assert_state "edge: hardcopy shift+tab" "waiting" \
    "shift+tab to cycle"

assert_state "edge: hardcopy tips" "waiting" \
    "Tips for getting"

# ── Fallback y_n without unicode ❯ ───────────────────────────────────
assert_state "edge: y_n fallback no unicode arrow" "y_n" \
    "Some context
1. Yes
3. No"

# ── All cooking-pun completion words ─────────────────────────────────
for word in Crunched Sautéed Cogitated "Whipped up" Brewed Cooked Marinated Stewed Baked Simmered Crafted Distilled; do
    assert_state "waiting: ${word}" "waiting" \
        "${word} for 1.0s
❯ "
done

# ══════════════════════════════════════════════════════════════════════
# §4  Lock Tests
# ══════════════════════════════════════════════════════════════════════
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

# Stale-empty lock (empty file)
touch "$TMPLOCK"
stale_result=$(check_stale "$TMPLOCK")
assert_eq "lock: stale-empty detection" "stale-empty" "$stale_result"
rm -f "$TMPLOCK"

# No-lock state
stale_result=$(check_stale "$TMPLOCK")
assert_eq "lock: no-lock detection" "no-lock" "$stale_result"

# Double acquire by same PID succeeds (stale self-lock recovery)
acquire_lock "$TMPLOCK"
# Simulate our own PID already in lock — acquire should see it as active and fail
local_rc=0
acquire_lock "$TMPLOCK" 2>/dev/null || local_rc=$?
assert_rc "lock: double acquire by same PID fails" "1" "$local_rc"
release_lock "$TMPLOCK"

# Release by non-owner is no-op
echo "99999998" >"$TMPLOCK"
# This PID doesn't exist, but release_lock checks ownership
release_lock "$TMPLOCK" 2>/dev/null
assert_eq "lock: non-owner release is no-op" "true" "$(test -f "$TMPLOCK" && echo true || echo false)"
rm -f "$TMPLOCK"

# ══════════════════════════════════════════════════════════════════════
# §5  Auto-Response Throttle Tests
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "=== Auto-Response Throttle Tests ==="
echo ""

# Reset internal state
_LAST_RESPONSE_TIME=0
_LAST_STATE=""
_LAST_STATE_TIME=0
_BURST_COUNT=0
_BURST_WINDOW_START=0

# Throttle: first call should pass
_LAST_RESPONSE_TIME=0
_throttle_check
assert_rc "throttle: first call passes" "0" "$?"

# Throttle: immediate second call should be throttled
_LAST_RESPONSE_TIME=$(_epoch_seconds)
local_rc=0
_throttle_check || local_rc=$?
assert_rc "throttle: immediate repeat is throttled" "1" "$local_rc"

# Throttle: after interval passes, should succeed
_LAST_RESPONSE_TIME=$(($(_epoch_seconds) - 5))
_throttle_check
assert_rc "throttle: passes after interval" "0" "$?"

# ── Burst limit ──────────────────────────────────────────────────────
_BURST_COUNT=0
_BURST_WINDOW_START=$(_epoch_seconds)
BURST_LIMIT=3
BURST_WINDOW=60

# Under limit
_BURST_COUNT=2
_burst_check
assert_rc "burst: under limit passes" "0" "$?"

# At limit
_BURST_COUNT=3
local_rc=0
_burst_check || local_rc=$?
assert_rc "burst: at limit is blocked" "1" "$local_rc"

# Window reset
_BURST_WINDOW_START=$(($(_epoch_seconds) - 61))
_BURST_COUNT=99
_burst_check
assert_rc "burst: resets after window" "0" "$?"

# Reset burst config
export BURST_LIMIT=10
export BURST_WINDOW=3

# ── Same-state delay ────────────────────────────────────────────────
_LAST_STATE=""
_LAST_STATE_TIME=0

# First call with new state should pass
_same_state_check "y_n"
assert_rc "same-state: new state passes" "0" "$?"

# Immediate repeat should be delayed
local_rc=0
_same_state_check "y_n" || local_rc=$?
assert_rc "same-state: immediate repeat is delayed" "1" "$local_rc"

# Different state should pass
_same_state_check "waiting"
assert_rc "same-state: different state passes" "0" "$?"

# After delay, same state should pass
_LAST_STATE_TIME=$(($(_epoch_seconds) - 5))
_same_state_check "waiting"
assert_rc "same-state: passes after delay" "0" "$?"

# ══════════════════════════════════════════════════════════════════════
# §6  Health Checker Tests
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "=== Health Checker Tests ==="
echo ""

HEALTH_TMPDIR="${TMPDIR_TEST}/health"
mkdir -p "$HEALTH_TMPDIR/.claude/plugins/cache"

# Override paths used by health check functions
HEALTH_SETTINGS="${HEALTH_TMPDIR}/settings.json"
HEALTH_INSTALLED="${HEALTH_TMPDIR}/installed_plugins.json"
HEALTH_CACHE="${HEALTH_TMPDIR}/.claude/plugins/cache/claude-plugins-official/telegram"

# Health check helpers that use our test paths
_h_check_not_enabled() {
    python3 -c "
import json, sys
with open('${HEALTH_SETTINGS}') as f:
    d = json.load(f)
v = d.get('enabledPlugins', {}).get('telegram@claude-plugins-official', False)
sys.exit(0 if not v else 1)
" 2>/dev/null && return 0 || return 1
}

_h_check_denied() {
    python3 -c "
import json, sys
with open('${HEALTH_SETTINGS}') as f:
    d = json.load(f)
deny = d.get('permissions', {}).get('deny', [])
has_deny = any('mcp__plugin_telegram' in r for r in deny)
sys.exit(0 if has_deny else 1)
" 2>/dev/null
}

_h_check_not_installed() {
    python3 -c "
import json, sys
with open('${HEALTH_INSTALLED}') as f:
    d = json.load(f)
has = 'telegram@claude-plugins-official' in d.get('plugins', {})
sys.exit(0 if not has else 1)
" 2>/dev/null
}

_h_check_no_cache() {
    [[ ! -d "$HEALTH_CACHE" ]]
}

_h_check_not_allowed() {
    python3 -c "
import json, sys
with open('${HEALTH_SETTINGS}') as f:
    d = json.load(f)
allow = d.get('permissions', {}).get('allow', [])
has_allow = any('mcp__plugin_telegram' in r for r in allow)
sys.exit(0 if not has_allow else 1)
" 2>/dev/null
}

# Create poisoned settings (plugin enabled, no deny, has allow)
cat >"${HEALTH_SETTINGS}" <<'JSON'
{
  "permissions": {
    "allow": ["mcp__plugin_telegram*"],
    "deny": []
  },
  "enabledPlugins": {
    "telegram@claude-plugins-official": true
  }
}
JSON

cat >"${HEALTH_INSTALLED}" <<'JSON'
{
  "version": 2,
  "plugins": {
    "telegram@claude-plugins-official": [
      {"scope": "local", "version": "0.0.4"}
    ]
  }
}
JSON

mkdir -p "$HEALTH_CACHE"

# Test: all violations detected
local_rc=0
_h_check_not_enabled || local_rc=1
assert_rc "health: detects enabled plugin" "1" "$local_rc"

local_rc=0
_h_check_denied || local_rc=1
assert_rc "health: detects missing deny rules" "1" "$local_rc"

local_rc=0
_h_check_not_installed || local_rc=1
assert_rc "health: detects installed plugin" "1" "$local_rc"

local_rc=0
_h_check_no_cache || local_rc=1
assert_rc "health: detects cache dir" "1" "$local_rc"

local_rc=0
_h_check_not_allowed || local_rc=1
assert_rc "health: detects allow rules" "1" "$local_rc"

# Now create clean settings
cat >"${HEALTH_SETTINGS}" <<'JSON2'
{
  "permissions": {
    "allow": [],
    "deny": ["mcp__plugin_telegram*"]
  },
  "enabledPlugins": {
    "telegram@claude-plugins-official": false
  }
}
JSON2

cat >"${HEALTH_INSTALLED}" <<'JSON3'
{
  "version": 2,
  "plugins": {}
}
JSON3

rm -rf "$HEALTH_CACHE"

# Test: all clean
_h_check_not_enabled
assert_rc "health: clean — not enabled" "0" "$?"

_h_check_denied
assert_rc "health: clean — deny rules present" "0" "$?"

_h_check_not_installed
assert_rc "health: clean — not installed" "0" "$?"

_h_check_no_cache
assert_rc "health: clean — no cache" "0" "$?"

_h_check_not_allowed
assert_rc "health: clean — not in allow" "0" "$?"

# ══════════════════════════════════════════════════════════════════════
# §7  Orochi Relay Self-Tests (delegate to built-in)
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "=== Orochi Relay Tests ==="
echo ""

source "${LIB_DIR}/orochi-relay.sh"

# Test: orochi_health with mocked 200
curl() { echo "200"; }
export -f curl
result=$(orochi_health)
assert_eq "orochi: health 200 = healthy" "healthy" "$result"
unset -f curl

# Test: orochi_health with mocked 503
curl() { echo "503"; }
export -f curl
local_rc=0
result=$(orochi_health) || local_rc=$?
assert_eq "orochi: health 503 = unreachable" "unreachable (HTTP 503)" "$result"
assert_rc "orochi: health 503 exits 1" "1" "$local_rc"
unset -f curl

# Test: orochi_health with mocked timeout
curl() {
    echo "000"
    return 1
}
export -f curl
local_rc=0
result=$(orochi_health) || local_rc=$?
assert_eq "orochi: health timeout = unreachable" "unreachable (HTTP 000)" "$result"
assert_rc "orochi: health timeout exits 1" "1" "$local_rc"
unset -f curl

# Test: orochi_relay REST success
curl() {
    # Distinguish between -o /dev/null (relay) and plain (health/who)
    if [[ "$*" == *"-o /dev/null"* ]]; then
        echo "200"
    else
        echo "200"
    fi
}
export -f curl
# Mock screen to fail (no session)
screen() { return 1; }
export -f screen
result=$(orochi_relay "test message" "#test")
local_rc=$?
assert_eq "orochi: relay REST OK" "rest:OK screen:FAIL(no-session)" "$result"
assert_rc "orochi: relay partial success exits 0" "0" "$local_rc"
unset -f curl
unset -f screen

# Test: orochi_relay both fail
curl() {
    echo "000"
    return 1
}
export -f curl
screen() { return 1; }
export -f screen
local_rc=0
result=$(orochi_relay "test message" "#test") || local_rc=$?
assert_rc "orochi: relay all fail exits 1" "1" "$local_rc"
unset -f curl
unset -f screen

# Test: orochi_who with mocked response
curl() { echo '[{"name":"agent1"}]'; }
export -f curl
result=$(orochi_who)
assert_eq "orochi: who returns agent list" '[{"name":"agent1"}]' "$result"
unset -f curl

# ══════════════════════════════════════════════════════════════════════
# §8  common.sh yaml_get Tests
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "=== YAML Parsing Tests ==="
echo ""

YAML_TEST="${TMPDIR_TEST}/test.yaml"
cat >"$YAML_TEST" <<'YAML'
spec:
  screen:
    name: claude-code-telegrammer
  watchdog:
    enabled: true
    interval: 1.5
  telegram:
    auto_connect: true
    allowed_users:
      - 12345
      - 67890
    bot_token_env: MY_BOT_TOKEN
  nested:
    deep:
      value: hello-world
YAML

assert_eq "yaml: flat key" "claude-code-telegrammer" "$(yaml_get "$YAML_TEST" "spec.screen.name")"
assert_eq "yaml: boolean true" "true" "$(yaml_get "$YAML_TEST" "spec.watchdog.enabled")"
assert_eq "yaml: float" "1.5" "$(yaml_get "$YAML_TEST" "spec.watchdog.interval")"
assert_eq "yaml: string" "MY_BOT_TOKEN" "$(yaml_get "$YAML_TEST" "spec.telegram.bot_token_env")"
assert_eq "yaml: deep nested" "hello-world" "$(yaml_get "$YAML_TEST" "spec.nested.deep.value")"
assert_eq "yaml: missing key returns default" "fallback" "$(yaml_get "$YAML_TEST" "spec.nonexistent" "fallback")"
assert_eq "yaml: missing file returns default" "fallback" "$(yaml_get "/nonexistent/file.yaml" "key" "fallback")"

# yaml_get_list
list_result=$(yaml_get_list "$YAML_TEST" "spec.telegram.allowed_users")
assert_eq "yaml: list first item" "12345" "$(echo "$list_result" | head -1)"
assert_eq "yaml: list second item" "67890" "$(echo "$list_result" | tail -1)"
assert_eq "yaml: list count" "2" "$(echo "$list_result" | wc -l | tr -d ' ')"

# ══════════════════════════════════════════════════════════════════════
#  Summary
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
printf "Total: %d | Passed: %d | Failed: %d\n" "$TOTAL" "$PASS" "$FAIL"
echo "========================================"

if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
exit 0
