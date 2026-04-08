#!/bin/bash
# orochi-relay.sh — Relay messages from telegrammer to Orochi hub
# Multi-route: tries all available routes, reports results honestly (no silent fallbacks)

# Configuration (from env or defaults)
OROCHI_HOST="${SCITEX_OROCHI_HOST:-192.168.0.102}"
OROCHI_DASHBOARD_PORT="${SCITEX_OROCHI_DASHBOARD_PORT:-8559}"
OROCHI_CHANNEL="${TELEGRAMMER_OROCHI_CHANNEL:-#telegram}"
OROCHI_MASTER_SCREEN="${TELEGRAMMER_OROCHI_MASTER_SCREEN:-orochi-agent:master}"

# Send message to Orochi via all available routes
# Returns JSON-like status: "rest:OK screen:OK" / "rest:FAIL(503) screen:OK" / etc.
# No silent fallbacks — every route's result is reported
orochi_relay() {
    local message="$1"
    local channel="${2:-$OROCHI_CHANNEL}"
    local results=""

    # Route 1: REST API
    local rest_response
    rest_response=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "http://${OROCHI_HOST}:${OROCHI_DASHBOARD_PORT}/api/messages" \
        -H "Content-Type: application/json" \
        -d "{\"channel\": \"${channel}\", \"content\": \"${message}\", \"sender\": \"telegrammer\"}" \
        --connect-timeout 3 --max-time 5 2>/dev/null) || rest_response="000"

    if [[ "$rest_response" =~ ^2 ]]; then
        results="rest:OK"
    else
        results="rest:FAIL(${rest_response})"
    fi

    # Route 2: Screen stuff
    if screen -ls "$OROCHI_MASTER_SCREEN" 2>/dev/null | grep -q "$OROCHI_MASTER_SCREEN"; then
        screen -S "$OROCHI_MASTER_SCREEN" -X stuff "${message}\r"
        results="${results} screen:OK"
    else
        results="${results} screen:FAIL(no-session)"
    fi

    echo "$results"

    # Return success if at least one route worked
    if echo "$results" | grep -q "OK"; then
        return 0
    fi
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

    # Test 1: REST relay (mocked 200, screen unavailable)
    echo -n "Test 1: REST success... "
    curl() { echo "200"; }
    export -f curl
    local result
    result=$(orochi_relay "test message" "#test")
    local rc=$?
    unset -f curl
    if echo "$result" | grep -q "rest:OK" && [[ "$rc" -eq 0 ]]; then
        echo "PASS"
        ((pass++))
    else
        echo "FAIL (got: $result rc=$rc)"
        ((fail++))
    fi

    # Test 2: Both unavailable
    echo -n "Test 2: Both unavailable... "
    curl() { echo "000"; return 1; }
    export -f curl
    screen() { return 1; }
    export -f screen
    result=$(orochi_relay "test message" "#test")
    rc=$?
    unset -f curl
    unset -f screen
    if echo "$result" | grep -q "rest:FAIL" && [[ "$rc" -eq 1 ]]; then
        echo "PASS"
        ((pass++))
    else
        echo "FAIL (got: $result rc=$rc)"
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
