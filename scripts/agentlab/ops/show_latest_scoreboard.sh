#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER_BIN_DEFAULT="$ROOT_DIR/../Experiments/rust/target/release/lab-cli"
RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-$RUNNER_BIN_DEFAULT}"

RUN_ID=""
WATCH=0
SCOREBOARD_ARGS=()

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/ops/show_latest_scoreboard.sh [--run-id <run_id>] [--watch] [scoreboard options]

Shows scoreboard for the latest run in .lab/runs by default.

Options:
  --run-id <id>    Show scoreboard for a specific run id instead of latest.
  --watch          Keep refreshing scoreboard (omit --once).
  -h, --help       Show help.

Examples:
  bash scripts/agentlab/ops/show_latest_scoreboard.sh
  bash scripts/agentlab/ops/show_latest_scoreboard.sh --run-id run_20260222_205502
  bash scripts/agentlab/ops/show_latest_scoreboard.sh --watch --metric-limit 12
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --watch)
      WATCH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      SCOREBOARD_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ ! -x "$RUNNER_BIN" ]]; then
  if command -v lab-cli >/dev/null 2>&1; then
    RUNNER_BIN="$(command -v lab-cli)"
  elif command -v lab >/dev/null 2>&1; then
    RUNNER_BIN="$(command -v lab)"
  else
    echo "runner not found. set AGENTLAB_RUNNER_BIN or build lab-cli in ../Experiments." >&2
    exit 1
  fi
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(find "$ROOT_DIR/.lab/runs" -maxdepth 1 -type d -name 'run_*' -print 2>/dev/null | xargs -r ls -1dt | head -n1 | xargs -r basename)"
fi

if [[ -z "$RUN_ID" ]]; then
  echo "no run id found under $ROOT_DIR/.lab/runs" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/.lab/runs/$RUN_ID" ]]; then
  echo "run dir not found: $ROOT_DIR/.lab/runs/$RUN_ID" >&2
  exit 1
fi

CMD=("$RUNNER_BIN" scoreboard "$RUN_ID" --no-clear)
if [[ "$WATCH" != "1" ]]; then
  CMD+=(--once)
fi
CMD+=("${SCOREBOARD_ARGS[@]}")

"${CMD[@]}"
