#!/bin/bash
# common.sh — Shared utilities for telegrammer
set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────
export TELEGRAMMER_VERSION="0.1.0"
TELEGRAMMER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TELEGRAMMER_DIR
TELEGRAMMER_LOG_DIR="${TELEGRAMMER_LOG_DIR:-/tmp/telegrammer}"
TELEGRAMMER_CAPTURE_DIR="/tmp/telegrammer"

# ── Logging ────────────────────────────────────────────────────────────
log() {
    local level="$1"
    shift
    printf '[%s] [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$*" >&2
}

log_info() { log "INFO" "$@"; }
log_warn() { log "WARN" "$@"; }
log_error() { log "ERROR" "$@"; }
log_debug() {
    [[ "${TELEGRAMMER_DEBUG:-0}" == "1" ]] && log "DEBUG" "$@"
    return 0
}

# ── YAML parsing (simple key: value) ──────────────────────────────────
# Reads flat or dot-notation keys from a YAML file.
# Usage: yaml_get config.yaml "spec.screen.name"
yaml_get() {
    local file="$1"
    local key="$2"
    local default="${3:-}"

    if [[ ! -f "$file" ]]; then
        echo "$default"
        return
    fi

    # Try python3 first for nested keys
    if command -v python3 &>/dev/null; then
        local val
        val=$(python3 -c "
import yaml, sys, functools, operator
try:
    with open('$file') as f:
        d = yaml.safe_load(f)
    keys = '$key'.split('.')
    val = functools.reduce(operator.getitem, keys, d)
    if isinstance(val, list):
        print('\n'.join(str(v) for v in val))
    elif isinstance(val, bool):
        print('true' if val else 'false')
    elif val is not None:
        print(val)
    else:
        print('$default')
except Exception:
    print('$default')
" 2>/dev/null)
        echo "$val"
        return
    fi

    # Fallback: simple grep for flat keys
    local simple_key="${key##*.}"
    local val
    val=$(grep -E "^\s*${simple_key}:" "$file" 2>/dev/null | head -1 | sed 's/^[^:]*:\s*//' | sed 's/\s*$//' | sed 's/^["'"'"']//' | sed 's/["'"'"']$//')
    echo "${val:-$default}"
}

# ── YAML list parsing ─────────────────────────────────────────────────
# Returns items one per line
yaml_get_list() {
    local file="$1"
    local key="$2"

    if command -v python3 &>/dev/null; then
        python3 -c "
import yaml, sys, functools, operator
try:
    with open('$file') as f:
        d = yaml.safe_load(f)
    keys = '$key'.split('.')
    val = functools.reduce(operator.getitem, keys, d)
    if isinstance(val, list):
        for v in val:
            print(v)
except Exception:
    pass
" 2>/dev/null
    fi
}

# ── Ensure directories ────────────────────────────────────────────────
ensure_dirs() {
    mkdir -p "$TELEGRAMMER_CAPTURE_DIR"
    mkdir -p "$TELEGRAMMER_LOG_DIR"
}

# ── Screen helpers ────────────────────────────────────────────────────
screen_exists() {
    local name="$1"
    screen -ls 2>/dev/null | grep -qF ".$name"
}

screen_send() {
    local session="$1"
    local text="$2"
    screen -S "$session" -X stuff "${text}"
}

screen_send_enter() {
    local session="$1"
    local text="$2"
    screen -S "$session" -X stuff "${text}\r"
}

screen_capture() {
    local session="$1"
    local outfile="$2"
    screen -S "$session" -X hardcopy "$outfile"
}
