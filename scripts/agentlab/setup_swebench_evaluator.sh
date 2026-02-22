#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_PATH="${AGENTLAB_SWEBENCH_VENV:-$ROOT_DIR/.venv_swebench}"
PYTHON_BIN="${AGENTLAB_SWEBENCH_BOOTSTRAP_PYTHON:-python3}"

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/setup_swebench_evaluator.sh

Creates a host-side Python venv for the official SWE-bench evaluator and installs:
  - swebench

Environment overrides:
  AGENTLAB_SWEBENCH_VENV             Venv path (default: .venv_swebench)
  AGENTLAB_SWEBENCH_BOOTSTRAP_PYTHON Python used to create the venv (default: python3)
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "python not found: $PYTHON_BIN" >&2
  exit 1
fi

"$PYTHON_BIN" -m venv "$VENV_PATH"
source "$VENV_PATH/bin/activate"

python -m pip install --upgrade pip wheel setuptools
python -m pip install swebench

echo "installed SWE-bench evaluator in: $VENV_PATH"
echo "set this before running experiments:"
echo "  export AGENTLAB_SWEBENCH_PYTHON=\"$VENV_PATH/bin/python\""
