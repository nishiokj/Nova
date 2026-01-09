#!/bin/bash
# sias-launcher.sh - Frozen launcher for SIAS kernel

set -e

GRAPHD_URL="${GRAPHD_URL:-http://127.0.0.1:9444}"
UPGRADE_SIGNAL_FILE="${SIAS_UPGRADE_SIGNAL_FILE:-/tmp/sias-upgrade-signal}"
CURRENT_PID=""
LAST_GOOD_PATH=""
CONSECUTIVE_FAILURES=0
MAX_FAILURES=3

cleanup() {
  echo "[launcher] Shutting down..."
  if [ -n "$CURRENT_PID" ] && kill -0 "$CURRENT_PID" 2>/dev/null; then
    kill -TERM "$CURRENT_PID"
    wait "$CURRENT_PID" 2>/dev/null || true
  fi
  rm -f "$UPGRADE_SIGNAL_FILE"
  exit 0
}

trap cleanup SIGINT SIGTERM

start_kernel() {
  local kernel_path="$1"
  if [ ! -d "$kernel_path" ]; then
    echo "[launcher] ERROR: Kernel path does not exist: $kernel_path"
    return 1
  fi

  if [ ! -f "$kernel_path/sias-kernel.ts" ]; then
    echo "[launcher] ERROR: sias-kernel.ts not found in: $kernel_path"
    return 1
  fi

  if ! bun build "$kernel_path/sias-kernel.ts" --target bun --outfile /dev/null 2>/dev/null; then
    echo "[launcher] ERROR: Kernel failed syntax check"
    return 1
  fi

  echo "[launcher] Starting kernel from: $kernel_path"

  GRAPHD_URL="$GRAPHD_URL" bun --expose-gc run "$kernel_path/sias-kernel.ts" &
  CURRENT_PID=$!
  echo "[launcher] Kernel PID: $CURRENT_PID"

  sleep 5

  if ! kill -0 "$CURRENT_PID" 2>/dev/null; then
    echo "[launcher] Kernel crashed on startup"
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))

    if [ $CONSECUTIVE_FAILURES -ge $MAX_FAILURES ] && [ -n "$LAST_GOOD_PATH" ]; then
      echo "[launcher] Rolling back to: $LAST_GOOD_PATH"
      kernel_path="$LAST_GOOD_PATH"
      CONSECUTIVE_FAILURES=0
      start_kernel "$kernel_path"
      return
    fi
  else
    LAST_GOOD_PATH="$kernel_path"
    CONSECUTIVE_FAILURES=0
  fi
}

main() {
  local kernel_path="${1:-./sias-kernel}"

  rm -f "$UPGRADE_SIGNAL_FILE"
  start_kernel "$kernel_path"

  while true; do
    if ! kill -0 "$CURRENT_PID" 2>/dev/null; then
      echo "[launcher] Kernel died, restarting..."
      sleep 2
      start_kernel "$kernel_path"
    fi

    if [ -f "$UPGRADE_SIGNAL_FILE" ]; then
      new_path=$(cat "$UPGRADE_SIGNAL_FILE")
      echo "[launcher] Upgrade signal received: $new_path"

      kill -TERM "$CURRENT_PID" 2>/dev/null || true
      wait "$CURRENT_PID" 2>/dev/null || true

      kernel_path="$new_path"
      rm -f "$UPGRADE_SIGNAL_FILE"
      start_kernel "$kernel_path"
    fi

    sleep 1
  done
}

main "$@"
