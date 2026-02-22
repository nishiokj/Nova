#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV_PATH="${AGENTLAB_SWEBENCH_VENV:-$ROOT_DIR/.venv_swebench}"

python_is_supported() {
  local candidate="$1"
  "$candidate" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
}

resolve_python_bin() {
  if [[ -n "${AGENTLAB_SWEBENCH_BOOTSTRAP_PYTHON:-}" ]]; then
    echo "$AGENTLAB_SWEBENCH_BOOTSTRAP_PYTHON"
    return 0
  fi

  local candidate
  for candidate in python3.11 python3.10 python3; do
    if ! command -v "$candidate" >/dev/null 2>&1; then
      continue
    fi
    if python_is_supported "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/setup_swebench_evaluator.sh

Creates a host-side Python venv for the official SWE-bench evaluator and installs:
  - swebench

Environment overrides:
  AGENTLAB_SWEBENCH_VENV             Venv path (default: .venv_swebench)
  AGENTLAB_SWEBENCH_BOOTSTRAP_PYTHON Python used to create the venv (must be Python 3.10+)
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! PYTHON_BIN="$(resolve_python_bin)"; then
  echo "no supported python found (need Python 3.10+)." >&2
  echo "set AGENTLAB_SWEBENCH_BOOTSTRAP_PYTHON to a 3.10+ interpreter (e.g. python3.10)." >&2
  exit 1
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "python not found: $PYTHON_BIN" >&2
  exit 1
fi
if ! python_is_supported "$PYTHON_BIN"; then
  echo "unsupported python for swebench: $PYTHON_BIN (requires Python 3.10+)" >&2
  exit 1
fi

rm -rf "$VENV_PATH"
"$PYTHON_BIN" -m venv "$VENV_PATH"
source "$VENV_PATH/bin/activate"

python -m pip install --upgrade pip wheel setuptools
python -m pip install swebench

echo "installed SWE-bench evaluator in: $VENV_PATH"
echo "set this before running experiments:"
echo "  export AGENTLAB_SWEBENCH_PYTHON=\"$VENV_PATH/bin/python\""
