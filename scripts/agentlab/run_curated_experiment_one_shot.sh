#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS_DIR="$ROOT_DIR/scripts/agentlab"

RUNNER_BIN_DEFAULT="$ROOT_DIR/../Experiments/rust/target/release/lab-cli"

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/run_curated_experiment_one_shot.sh

One command wrapper that:
  1) points to the local lab-cli runner
  2) runs the curated experiment
  3) optionally shows final scoreboard for that run
  4) prints run_id as the last line

Environment overrides:
  AGENTLAB_RUNNER_BIN            Runner binary path.
  AGENTLAB_AUTO_SCOREBOARD       1 to show final scoreboard after run (default), 0 to skip.
  AGENTLAB_LIMIT                 Task cap passed to builder (default: 50; full curated set).
  AGENTLAB_MAX_CONCURRENCY       If experiment rebuild is enabled, sets builder --max-concurrency (default: 4).

All AGENTLAB_* env vars consumed by run_curated_experiment.sh still apply.

This is the main entrypoint for the curated AgentLab run.

USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

export AGENTLAB_RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-$RUNNER_BIN_DEFAULT}"
export AGENTLAB_LIMIT="${AGENTLAB_LIMIT:-50}"
export AGENTLAB_MAX_CONCURRENCY="${AGENTLAB_MAX_CONCURRENCY:-4}"
AUTO_SCOREBOARD="${AGENTLAB_AUTO_SCOREBOARD:-1}"

RUN_LOG="$(mktemp -t agentlab-curated-one-shot-XXXXXX.log)"
RUN_ID=""
RUN_JOB_PID=""

cleanup() {
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

bash "$SCRIPTS_DIR/run_curated_experiment.sh" "$@" 2>&1 | tee "$RUN_LOG" &
RUN_JOB_PID=$!

while kill -0 "$RUN_JOB_PID" >/dev/null 2>&1; do
  if [[ -z "$RUN_ID" ]]; then
    RUN_ID="$(grep -Eo 'run_[0-9]{8}_[0-9]{6}' "$RUN_LOG" | tail -n1 || true)"
  fi
  sleep 1
done

set +e
wait "$RUN_JOB_PID"
RUN_STATUS=$?
set -e

if [[ $RUN_STATUS -ne 0 ]]; then
  exit "$RUN_STATUS"
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(grep -Eo 'run_[0-9]{8}_[0-9]{6}' "$RUN_LOG" | tail -n1 || true)"
fi
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(find "$ROOT_DIR/.lab/runs" -maxdepth 1 -type d -name 'run_*' -print 2>/dev/null | xargs -r ls -1dt | head -n1 | xargs -r basename)"
fi
if [[ -z "$RUN_ID" ]]; then
  echo "unable to determine run_id after run" >&2
  exit 1
fi

if [[ "$AUTO_SCOREBOARD" == "1" ]]; then
  echo
  echo "=== final scoreboard ($RUN_ID) ==="
  bash "$SCRIPTS_DIR/show_latest_scoreboard.sh" --run-id "$RUN_ID"
fi

echo "$RUN_ID"
