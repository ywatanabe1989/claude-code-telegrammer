#!/bin/bash
# lock.sh — Lock file management for telegrammer
# Sourced by other scripts; also runnable with --self-test
set -euo pipefail

DEFAULT_LOCK_PATH="${TELEGRAM_STATE_DIR:-${HOME}/.scitex/agent-container/telegram}/telegram.lock"

# ── Acquire lock ──────────────────────────────────────────────────────
# Creates a lock file with the current PID.
# Returns 0 on success, 1 if already locked by another process.
acquire_lock() {
    local lock_path="${1:-$DEFAULT_LOCK_PATH}"
    local lock_dir
    lock_dir=$(dirname "$lock_path")
    mkdir -p "$lock_dir"

    # Check for existing lock
    if [[ -f "$lock_path" ]]; then
        local existing_pid
        existing_pid=$(cat "$lock_path" 2>/dev/null || echo "")
        if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
            log_error "Lock held by PID $existing_pid ($lock_path)"
            return 1
        else
            log_warn "Removing stale lock (PID $existing_pid no longer running)"
            rm -f "$lock_path"
        fi
    fi

    echo "$$" >"$lock_path"
    log_info "Lock acquired: $lock_path (PID $$)"
    return 0
}

# ── Release lock ──────────────────────────────────────────────────────
release_lock() {
    local lock_path="${1:-$DEFAULT_LOCK_PATH}"

    if [[ ! -f "$lock_path" ]]; then
        log_debug "No lock file to release: $lock_path"
        return 0
    fi

    local lock_pid
    lock_pid=$(cat "$lock_path" 2>/dev/null || echo "")

    # Only release if we own it
    if [[ "$lock_pid" == "$$" ]]; then
        rm -f "$lock_path"
        log_info "Lock released: $lock_path"
    else
        log_warn "Lock owned by PID $lock_pid, not releasing (we are $$)"
    fi

    return 0
}

# ── Check if locked ──────────────────────────────────────────────────
is_locked() {
    local lock_path="${1:-$DEFAULT_LOCK_PATH}"

    if [[ ! -f "$lock_path" ]]; then
        return 1
    fi

    local lock_pid
    lock_pid=$(cat "$lock_path" 2>/dev/null || echo "")

    if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
        return 0
    fi

    return 1
}

# ── Check for stale lock ─────────────────────────────────────────────
check_stale() {
    local lock_path="${1:-$DEFAULT_LOCK_PATH}"

    if [[ ! -f "$lock_path" ]]; then
        echo "no-lock"
        return 0
    fi

    local lock_pid
    lock_pid=$(cat "$lock_path" 2>/dev/null || echo "")

    if [[ -z "$lock_pid" ]]; then
        echo "stale-empty"
        return 0
    fi

    if kill -0 "$lock_pid" 2>/dev/null; then
        echo "active"
    else
        echo "stale"
    fi
}

# ── Self-test ─────────────────────────────────────────────────────────
lock_self_test() {
    local tmplock
    tmplock=$(mktemp /tmp/telegrammer-lock-test.XXXXXX)
    rm -f "$tmplock" # Start clean

    local pass=0
    local fail=0

    assert_eq() {
        local desc="$1" expected="$2" got="$3"
        if [[ "$got" == "$expected" ]]; then
            printf "  PASS: %s\n" "$desc"
            ((pass++)) || true
        else
            printf "  FAIL: %s (expected=%s got=%s)\n" "$desc" "$expected" "$got"
            ((fail++)) || true
        fi
    }

    echo "lock self-test"
    echo "=============="

    # Not locked initially
    if ! is_locked "$tmplock"; then
        assert_eq "not locked initially" "ok" "ok"
    else
        assert_eq "not locked initially" "not-locked" "locked"
    fi

    # Acquire
    acquire_lock "$tmplock"
    if is_locked "$tmplock"; then
        assert_eq "locked after acquire" "ok" "ok"
    else
        assert_eq "locked after acquire" "locked" "not-locked"
    fi

    # Stale check on active lock
    local stale_result
    stale_result=$(check_stale "$tmplock")
    assert_eq "active lock detected" "active" "$stale_result"

    # Release
    release_lock "$tmplock"
    if ! is_locked "$tmplock"; then
        assert_eq "unlocked after release" "ok" "ok"
    else
        assert_eq "unlocked after release" "not-locked" "locked"
    fi

    # Stale lock detection
    echo "99999999" >"$tmplock"
    stale_result=$(check_stale "$tmplock")
    assert_eq "stale lock detected" "stale" "$stale_result"

    rm -f "$tmplock"
    echo "=============="
    printf "Results: %d passed, %d failed\n" "$pass" "$fail"
    return "$fail"
}

if [[ "${1:-}" == "--self-test" ]]; then
    # Need logging stubs when running standalone
    if ! declare -f log_info &>/dev/null; then
        log_info() { echo "[INFO]  $*"; }
        log_warn() { echo "[WARN]  $*"; }
        log_error() { echo "[ERROR] $*"; }
        log_debug() { :; }
    fi
    lock_self_test
fi
