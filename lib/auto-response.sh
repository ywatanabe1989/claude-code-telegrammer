#!/bin/bash
# auto-response.sh — Sends responses based on detected TUI state
# Sourced by telegrammer-watchdog
set -euo pipefail

# ── Configuration (overridable) ───────────────────────────────────────
RESPONSE_INTERVAL="${RESPONSE_INTERVAL:-1.5}"
SAME_STATE_DELAY="${SAME_STATE_DELAY:-1.5}"
BURST_LIMIT="${BURST_LIMIT:-10}"
BURST_WINDOW="${BURST_WINDOW:-3}"

# ── Internal state ────────────────────────────────────────────────────
_LAST_RESPONSE_TIME=0
_LAST_STATE=""
_LAST_STATE_TIME=0
_BURST_COUNT=0
_BURST_WINDOW_START=0

# ── Epoch seconds (portable) ─────────────────────────────────────────
_epoch_seconds() {
    date +%s
}

# ── Throttle check ────────────────────────────────────────────────────
# Returns 0 if OK to send, 1 if throttled
_throttle_check() {
    local now
    now=$(_epoch_seconds)
    local elapsed=$((now - _LAST_RESPONSE_TIME))

    # Minimum interval between any responses
    if [[ "$elapsed" -lt "${RESPONSE_INTERVAL%.*}" ]]; then
        return 1
    fi

    return 0
}

# ── Burst check ───────────────────────────────────────────────────────
# Returns 0 if OK, 1 if burst limit hit
_burst_check() {
    local now
    now=$(_epoch_seconds)
    local window_elapsed=$((now - _BURST_WINDOW_START))

    if [[ "$window_elapsed" -ge "${BURST_WINDOW}" ]]; then
        _BURST_COUNT=0
        _BURST_WINDOW_START="$now"
    fi

    if [[ "$_BURST_COUNT" -ge "$BURST_LIMIT" ]]; then
        return 1
    fi

    return 0
}

# ── Same-state delay ──────────────────────────────────────────────────
_same_state_check() {
    local state="$1"
    local now
    now=$(_epoch_seconds)

    if [[ "$state" == "$_LAST_STATE" ]]; then
        local elapsed=$((now - _LAST_STATE_TIME))
        if [[ "$elapsed" -lt "${SAME_STATE_DELAY%.*}" ]]; then
            return 1
        fi
    fi

    _LAST_STATE="$state"
    _LAST_STATE_TIME="$now"
    return 0
}

# ── Send response ─────────────────────────────────────────────────────
# Usage: send_response <session> <text> <state>
send_response() {
    local session="$1"
    local text="$2"
    local state="${3:-unknown}"

    # All checks
    if ! _throttle_check; then
        log_debug "Throttled: too soon since last response"
        return 0
    fi

    if ! _burst_check; then
        log_warn "Burst limit reached ($BURST_LIMIT in ${BURST_WINDOW}s), skipping"
        return 0
    fi

    if ! _same_state_check "$state"; then
        log_debug "Same state delay not met for: $state"
        return 0
    fi

    # Verify screen session exists
    if ! screen_exists "$session"; then
        log_error "Screen session '$session' not found, cannot send response"
        return 1
    fi

    # Send
    log_info "Responding to state=$state with: $text"
    screen -S "$session" -X stuff "${text}\r"

    _LAST_RESPONSE_TIME=$(_epoch_seconds)
    ((_BURST_COUNT++)) || true

    return 0
}
