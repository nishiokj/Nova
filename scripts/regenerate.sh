#!/usr/bin/env bash
set -euo pipefail
#
# regenerate.sh — Rebuild and relaunch headless.
#
# Called by the agent when it modifies its own codebase and needs the changes
# reflected in its running process. Spawns a detached rebuilder that survives
# the death of the current TUI, rebuilds everything, and starts the daemon
# headless. The session key is preserved for reconnection (TUI, Telegram, etc).
#
# Usage:
#   scripts/regenerate.sh <session-key>
#
# Flow:
#   1. Spawns fully detached rebuilder process
#   2. Kills the current TUI (graceful SIGTERM, session persists)
#   3. Rebuilder: bun run clean && bun run build
#   4. Rebuilder: starts daemon headless (--daemon-only --restart)
#   5. Reconnect with: bun run packages/apps/launcher/index.ts --session <key>
#

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$PROJECT_ROOT/.regenerate.log"

# ─── Rebuilder mode (detached, called with --rebuild) ────────────────────────

if [[ "${2:-}" == "--rebuild" ]]; then
    SESSION_KEY="$1"
    exec > "$LOG_FILE" 2>&1

    echo "[$(date)] Rebuilder started"
    echo "  Session: $SESSION_KEY"
    echo "  Project: $PROJECT_ROOT"

    # Wait for the TUI process tree to fully exit
    echo "[$(date)] Waiting for processes to exit..."
    sleep 5

    # Ensure old processes are dead
    pkill -f "packages/apps/launcher/index" 2>/dev/null || true
    pkill -f "packages/apps/tui/index" 2>/dev/null || true
    pkill -f "packages/infra/harness-daemon" 2>/dev/null || true
    sleep 2

    cd "$PROJECT_ROOT"

    echo "[$(date)] Cleaning..."
    bun run clean 2>&1

    echo "[$(date)] Building..."
    bun run build 2>&1

    echo "[$(date)] Starting daemon (headless)..."
    bun run packages/apps/launcher/index.ts --daemon-only &
    DAEMON_PID=$!

    echo "[$(date)] Done. Daemon PID: $DAEMON_PID"
    echo "[$(date)] Reconnect with:"
    echo "  bun run packages/apps/launcher/index.ts --session '$SESSION_KEY'"
    exit 0
fi

# ─── Main entry: called by the agent ─────────────────────────────────────────

SESSION_KEY="${1:?Usage: regenerate.sh <session-key>}"

# Spawn the rebuilder fully detached (survives parent death)
nohup bash "$0" "$SESSION_KEY" --rebuild </dev/null >"$LOG_FILE" 2>&1 &
disown 2>/dev/null || true

echo "Regeneration initiated."
echo "  Session: $SESSION_KEY"
echo "  Log:     $LOG_FILE"
echo ""
echo "Reconnect after rebuild:"
echo "  bun run packages/apps/launcher/index.ts --session '$SESSION_KEY'"
echo ""
echo "Shutting down..."

sleep 1

# Kill the TUI/launcher — our ancestor process.
# The detached rebuilder is already running independently.
pkill -TERM -f "packages/apps/launcher/index" 2>/dev/null || \
pkill -TERM -f "packages/apps/tui/index" 2>/dev/null || true
