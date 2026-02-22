#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS_DIR="$ROOT_DIR/scripts/agentlab"

RUNNER_BIN_DEFAULT="$ROOT_DIR/../Experiments/rust/target/release/lab-cli"
SWEBENCH_VENV_DEFAULT="$ROOT_DIR/.venv_swebench"

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/run_curated_experiment_one_shot.sh

One command wrapper that:
  1) points to the local lab-cli runner
  2) ensures SWE-bench evaluator venv exists (auto-setup by default)
  3) runs the curated experiment
  4) shows scoreboard for that run
  5) prints run_id as the last line

Environment overrides:
  AGENTLAB_RUNNER_BIN            Runner binary path.
  AGENTLAB_SWEBENCH_VENV         Evaluator venv path (default: .venv_swebench)
  AGENTLAB_SWEBENCH_PYTHON       Evaluator python path (default: <venv>/bin/python)
  AGENTLAB_AUTO_SETUP_SWEBENCH   1 to auto-bootstrap evaluator venv if missing (default), 0 to fail.
  AGENTLAB_AUTO_SCOREBOARD       1 to show scoreboard after run (default), 0 to skip.
  AGENTLAB_SCOREBOARD_WATCH      1 to start live scoreboard as soon as run_id appears (default: 1).

All AGENTLAB_* env vars consumed by run_curated_experiment.sh still apply.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

export AGENTLAB_RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-$RUNNER_BIN_DEFAULT}"
export AGENTLAB_SWEBENCH_VENV="${AGENTLAB_SWEBENCH_VENV:-$SWEBENCH_VENV_DEFAULT}"
export AGENTLAB_SWEBENCH_PYTHON="${AGENTLAB_SWEBENCH_PYTHON:-$AGENTLAB_SWEBENCH_VENV/bin/python}"
AUTO_SETUP="${AGENTLAB_AUTO_SETUP_SWEBENCH:-1}"
AUTO_SCOREBOARD="${AGENTLAB_AUTO_SCOREBOARD:-1}"
SCOREBOARD_WATCH="${AGENTLAB_SCOREBOARD_WATCH:-1}"

if [[ ! -x "$AGENTLAB_SWEBENCH_PYTHON" ]]; then
  if [[ "$AUTO_SETUP" != "1" ]]; then
    echo "missing evaluator python: $AGENTLAB_SWEBENCH_PYTHON" >&2
    echo "run: bash scripts/agentlab/setup_swebench_evaluator.sh" >&2
    exit 1
  fi
  bash "$SCRIPTS_DIR/setup_swebench_evaluator.sh"
fi

swebench_import_ok() {
  "$AGENTLAB_SWEBENCH_PYTHON" -c "import swebench" >/dev/null 2>&1
}

if [[ ! -x "$AGENTLAB_SWEBENCH_PYTHON" || ! swebench_import_ok ]]; then
  if [[ "$AUTO_SETUP" != "1" ]]; then
    echo "SWE-bench evaluator is not ready at: $AGENTLAB_SWEBENCH_PYTHON" >&2
    echo "run: bash scripts/agentlab/setup_swebench_evaluator.sh" >&2
    exit 1
  fi
  bash "$SCRIPTS_DIR/setup_swebench_evaluator.sh"
fi

if [[ ! -x "$AGENTLAB_SWEBENCH_PYTHON" || ! swebench_import_ok ]]; then
  echo "SWE-bench evaluator import failed for: $AGENTLAB_SWEBENCH_PYTHON" >&2
  "$AGENTLAB_SWEBENCH_PYTHON" -c "import swebench" 2>&1 || true
  exit 1
fi

RUN_LOG="$(mktemp -t agentlab-curated-one-shot-XXXXXX.log)"
RUN_ID=""
RUN_JOB_PID=""
SCOREBOARD_PID=""
SCOREBOARD_STARTED=0

cleanup() {
  if [[ -n "$SCOREBOARD_PID" ]]; then
    kill "$SCOREBOARD_PID" >/dev/null 2>&1 || true
    wait "$SCOREBOARD_PID" 2>/dev/null || true
  fi
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

bash "$SCRIPTS_DIR/run_curated_experiment.sh" "$@" 2>&1 | tee "$RUN_LOG" &
RUN_JOB_PID=$!

while kill -0 "$RUN_JOB_PID" >/dev/null 2>&1; do
  if [[ -z "$RUN_ID" ]]; then
    RUN_ID="$(grep -Eo 'run_[0-9]{8}_[0-9]{6}' "$RUN_LOG" | tail -n1 || true)"
    if [[ -n "$RUN_ID" && "$AUTO_SCOREBOARD" == "1" && "$SCOREBOARD_WATCH" == "1" && "$SCOREBOARD_STARTED" != "1" ]]; then
      echo
      echo "=== live scoreboard ($RUN_ID) ==="
      bash "$SCRIPTS_DIR/show_latest_scoreboard.sh" --run-id "$RUN_ID" --watch &
      SCOREBOARD_PID=$!
      SCOREBOARD_STARTED=1
    fi
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

if [[ -n "$SCOREBOARD_PID" ]]; then
  kill "$SCOREBOARD_PID" >/dev/null 2>&1 || true
  wait "$SCOREBOARD_PID" 2>/dev/null || true
  SCOREBOARD_PID=""
fi

if [[ "$AUTO_SCOREBOARD" == "1" ]]; then
  echo
  echo "=== final scoreboard ($RUN_ID) ==="
  bash "$SCRIPTS_DIR/show_latest_scoreboard.sh" --run-id "$RUN_ID"
fi

echo "$RUN_ID"
