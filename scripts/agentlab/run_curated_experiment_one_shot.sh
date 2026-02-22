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
  3) runs the curated experiment and prints run_id

Environment overrides:
  AGENTLAB_RUNNER_BIN            Runner binary path.
  AGENTLAB_SWEBENCH_VENV         Evaluator venv path (default: .venv_swebench)
  AGENTLAB_SWEBENCH_PYTHON       Evaluator python path (default: <venv>/bin/python)
  AGENTLAB_AUTO_SETUP_SWEBENCH   1 to auto-bootstrap evaluator venv if missing (default), 0 to fail.

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

if [[ ! -x "$AGENTLAB_SWEBENCH_PYTHON" ]]; then
  if [[ "$AUTO_SETUP" != "1" ]]; then
    echo "missing evaluator python: $AGENTLAB_SWEBENCH_PYTHON" >&2
    echo "run: bash scripts/agentlab/setup_swebench_evaluator.sh" >&2
    exit 1
  fi
  bash "$SCRIPTS_DIR/setup_swebench_evaluator.sh"
fi

if [[ ! -x "$AGENTLAB_SWEBENCH_PYTHON" ]]; then
  echo "evaluator python not executable after setup: $AGENTLAB_SWEBENCH_PYTHON" >&2
  exit 1
fi

exec bash "$SCRIPTS_DIR/run_curated_experiment.sh" "$@"
