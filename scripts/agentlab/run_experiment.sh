#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-$ROOT_DIR/../Experiments/rust/target/release/lab-cli}"

EXPERIMENT_REL=".lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml"
EXECUTOR="${AGENTLAB_EXECUTOR:-local_docker}"
MATERIALIZE="${AGENTLAB_MATERIALIZE:-full}"
RUN_MODE="${AGENTLAB_RUN_MODE:-run}"

# --- resolve runner ---
if [[ ! -x "$RUNNER_BIN" ]]; then
  if command -v lab-cli >/dev/null 2>&1; then
    RUNNER_BIN="$(command -v lab-cli)"
  elif command -v lab >/dev/null 2>&1; then
    RUNNER_BIN="$(command -v lab)"
  else
    echo "lab-cli not found. set AGENTLAB_RUNNER_BIN or build lab-cli." >&2
    exit 1
  fi
fi

# --- validate ---
if [[ "$EXECUTOR" == "local_docker" || "$RUN_MODE" == "run_dev" ]]; then
  if ! docker info >/dev/null 2>&1; then
    echo "docker daemon unavailable." >&2
    exit 1
  fi
fi

if [[ ! -f "$ROOT_DIR/$EXPERIMENT_REL" ]]; then
  echo "experiment yaml not found: $EXPERIMENT_REL" >&2
  echo "run build_experiment.sh first." >&2
  exit 1
fi

# --- preflight ---
(cd "$ROOT_DIR" && "$RUNNER_BIN" preflight "$EXPERIMENT_REL")

# --- run ---
cd "$ROOT_DIR"
if [[ "$RUN_MODE" == "run_dev" ]]; then
  exec "$RUNNER_BIN" run-dev "$EXPERIMENT_REL"
else
  exec "$RUNNER_BIN" run "$EXPERIMENT_REL" --executor "$EXECUTOR" --materialize "$MATERIALIZE"
fi
