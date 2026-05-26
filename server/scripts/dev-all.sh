#!/usr/bin/env bash
# Run API + queue worker; Ctrl+C stops both quickly (no long cooperative job waits).
set -euo pipefail

cd "$(dirname "$0")/.."

API_PID=""
WORKER_PID=""

stop_children() {
    local signal="${1:-INT}"
    if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
        kill "-$signal" "$API_PID" 2>/dev/null || true
    fi
    if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
        kill "-$signal" "$WORKER_PID" 2>/dev/null || true
    fi
}

on_signal() {
    if [[ "${STOPPING:-}" == "1" ]]; then
        echo ""
        echo "Force stopping…"
        stop_children KILL
        exit 130
    fi
    STOPPING=1
    stop_children INT
    wait "$API_PID" "$WORKER_PID" 2>/dev/null || true
    exit 0
}

trap on_signal INT TERM

node --watch src/index.js &
API_PID=$!
node --watch src/worker/queueWorker.js &
WORKER_PID=$!

wait "$API_PID" "$WORKER_PID"
