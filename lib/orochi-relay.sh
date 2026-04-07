#!/bin/bash
# orochi-relay.sh — Relay messages from telegrammer to Orochi hub
# Primary: REST API, Fallback: screen stuff (with explanation)

# Configuration (from env or defaults)
OROCHI_HOST="${SCITEX_OROCHI_HOST:-192.168.0.102}"
OROCHI_DASHBOARD_PORT="${SCITEX_OROCHI_DASHBOARD_PORT:-8559}"
OROCHI_CHANNEL="${TELEGRAMMER_OROCHI_CHANNEL:-#telegram}"
OROCHI_MASTER_SCREEN="${TELEGRAMMER_OROCHI_MASTER_SCREEN:-orochi-agent:master}"

# Send message to Orochi
# Returns: "rest" if REST succeeded, "screen" if fell back to screen, "failed" if both failed
orochi_relay() {
    local message="$1"
    local channel="${2:-$OROCHI_CHANNEL}"

    # Try REST API first
    local response
    response=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "http://${OROCHI_HOST}:${OROCHI_DASHBOARD_PORT}/api/messages" \
        -H "Content-Type: application/json" \
        -d "{\"channel\": \"${channel}\", \"content\": \"${message}\", \"sender\": \"telegrammer\"}" \
        --connect-timeout 3 --max-time 5 2>/dev/null) || response="000"

    if [[ "$response" =~ ^2 ]]; then
        echo "rest"
        return 0
    fi

    # REST failed — try screen stuff with explanation
    local fallback_msg="[WARNING: Orochi REST unavailable (HTTP ${response}), sending via screen] ${message}"

    if screen -ls "$OROCHI_MASTER_SCREEN" 2>/dev/null | grep -q "$OROCHI_MASTER_SCREEN"; then
        screen -S "$OROCHI_MASTER_SCREEN" -X stuff "${fallback_msg}\r"
        echo "screen"
        return 0
    fi

    # Both failed
    echo "failed"
    return 1
}

# Check if Orochi is reachable
orochi_health() {
    local response
    response=$(curl -s -o /dev/null -w "%{http_code}" \
        "http://${OROCHI_HOST}:${OROCHI_DASHBOARD_PORT}/api/stats" \
        --connect-timeout 3 --max-time 5 2>/dev/null) || response="000"

    if [[ "$response" =~ ^2 ]]; then
        echo "healthy"
        return 0
    else
        echo "unreachable (HTTP ${response})"
        return 1
    fi
}

# Get connected agents from Orochi
orochi_who() {
    curl -s "http://${OROCHI_HOST}:${OROCHI_DASHBOARD_PORT}/api/agents" \
        --connect-timeout 3 --max-time 5 2>/dev/null || echo "[]"
}

# Self-test with mocked curl
orochi_self_test() {
    local pass=0
    local fail=0

    echo "=== orochi-relay self-test ==="

    # Test 1: orochi_relay healthy case (mock curl returning 200)
    echo -n "Test 1: REST relay (mocked 200)... "
    curl() { echo "200"; }
    export -f curl
    local result
    result=$(orochi_relay "test message" "#test")
    unset -f curl
    if [[ "$result" == "rest" ]]; then
        echo "PASS"
        ((pass++))
    else
        echo "FAIL (got: $result, expected: rest)"
        ((fail++))
    fi

    # Test 2: orochi_relay fallback case (mock curl failing, no screen)
    echo -n "Test 2: Both unavailable... "
    curl() { echo "000"; return 1; }
    export -f curl
    screen() { return 1; }
    export -f screen
    result=$(orochi_relay "test message" "#test")
    local rc=$?
    unset -f curl
    unset -f screen
    if [[ "$result" == "failed" && "$rc" -eq 1 ]]; then
        echo "PASS"
        ((pass++))
    else
        echo "FAIL (got: $result rc=$rc, expected: failed rc=1)"
        ((fail++))
    fi

    # Test 3: orochi_health healthy case
    echo -n "Test 3: Health check (mocked 200)... "
    curl() { echo "200"; }
    export -f curl
    result=$(orochi_health)
    unset -f curl
    if [[ "$result" == "healthy" ]]; then
        echo "PASS"
        ((pass++))
    else
        echo "FAIL (got: $result, expected: healthy)"
        ((fail++))
    fi

    # Test 4: orochi_health unreachable case
    echo -n "Test 4: Health check (mocked 503)... "
    curl() { echo "503"; }
    export -f curl
    result=$(orochi_health)
    local rc=$?
    unset -f curl
    if [[ "$result" == "unreachable (HTTP 503)" && "$rc" -eq 1 ]]; then
        echo "PASS"
        ((pass++))
    else
        echo "FAIL (got: '$result' rc=$rc)"
        ((fail++))
    fi

    echo "=== Results: ${pass} passed, ${fail} failed ==="
    [[ "$fail" -eq 0 ]] && return 0 || return 1
}

# Run self-test if invoked directly (not sourced) with --self-test
if [[ "${BASH_SOURCE[0]}" == "${0}" && "${1:-}" == "--self-test" ]]; then
    orochi_self_test
fi
