#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER_BIN_DEFAULT="$ROOT_DIR/../Experiments/rust/target/release/lab-cli"
RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-$RUNNER_BIN_DEFAULT}"
EXPERIMENT_REL=".lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml"
EXPERIMENT_PATH="$ROOT_DIR/$EXPERIMENT_REL"
IMAGE_TAG="${AGENTLAB_IMAGE_TAG:-rex-harness:swebench-lite}"
EXECUTOR="${AGENTLAB_EXECUTOR:-local_docker}"
MATERIALIZE="${AGENTLAB_MATERIALIZE:-full}"
BUILD_EXPERIMENT="${AGENTLAB_BUILD_EXPERIMENT:-1}"
EXPERIMENT_LIMIT="${AGENTLAB_LIMIT:-}"

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/run_curated_experiment.sh

Runs the curated paired SWE-bench experiment and prints the run id.

Defaults:
  runner_bin    ../Experiments/rust/target/release/lab-cli
  experiment    .lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml
  executor      local_docker
  materialize   full

Environment overrides:
  AGENTLAB_RUNNER_BIN       Alternate runner binary path.
  AGENTLAB_EXECUTOR         local_docker | local_process | remote
  AGENTLAB_MATERIALIZE      none | metadata_only | outputs_only | full
  AGENTLAB_IMAGE_TAG        Docker image tag to require before run.
  AGENTLAB_BUILD_EXPERIMENT 1 to rebuild experiment before run (default), 0 to skip.
  AGENTLAB_LIMIT            If rebuild is enabled, pass --limit to the builder.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

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

if ! command -v docker >/dev/null 2>&1; then
  echo "missing required command: docker" >&2
  exit 1
fi

if [[ ! -f "$EXPERIMENT_PATH" ]]; then
  echo "experiment file not found: $EXPERIMENT_PATH" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "docker image not found: $IMAGE_TAG" >&2
  echo "build it first: bash scripts/agentlab/build_agent_image.sh --tag $IMAGE_TAG" >&2
  exit 1
fi

if [[ "$BUILD_EXPERIMENT" == "1" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "missing required command: node (needed to rebuild experiment)" >&2
    exit 1
  fi
  BUILD_CMD=(node scripts/agentlab/build_swebench_curated_ab_experiment.mjs)
  if [[ -n "$EXPERIMENT_LIMIT" ]]; then
    BUILD_CMD+=(--limit "$EXPERIMENT_LIMIT")
  fi
  (
    cd "$ROOT_DIR"
    "${BUILD_CMD[@]}"
  ) >/dev/null
fi

RUN_OUTPUT_LOG="$(mktemp -t lab-run-XXXXXX.log)"
cleanup() {
  rm -f "$RUN_OUTPUT_LOG"
}
trap cleanup EXIT

RUN_CMD_MODE="positional"
if ! "$RUNNER_BIN" run --help 2>&1 | grep -q "<EXPERIMENT>"; then
  RUN_CMD_MODE="flag"
fi

set +e
(
  cd "$ROOT_DIR"
  if [[ "$RUN_CMD_MODE" == "positional" ]]; then
    "$RUNNER_BIN" run "$EXPERIMENT_REL" \
      --executor "$EXECUTOR" \
      --materialize "$MATERIALIZE"
  else
    "$RUNNER_BIN" run \
      --experiment "$EXPERIMENT_REL" \
      --executor "$EXECUTOR" \
      --materialize "$MATERIALIZE"
  fi
) 2>&1 | tee "$RUN_OUTPUT_LOG"
RUN_STATUS=${PIPESTATUS[0]}
set -e

if [[ $RUN_STATUS -ne 0 ]]; then
  echo "lab run failed with status $RUN_STATUS" >&2
  exit "$RUN_STATUS"
fi

RUN_ID="$(grep -Eo 'run_[0-9]{8}_[0-9]{6}' "$RUN_OUTPUT_LOG" | tail -n1 || true)"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(find "$ROOT_DIR/.lab/runs" -maxdepth 1 -type d -name 'run_*' -print 2>/dev/null | xargs -r ls -1dt | head -n1 | xargs -r basename)"
fi

if [[ -z "$RUN_ID" ]]; then
  echo "unable to determine run_id from lab output" >&2
  exit 1
fi

echo "$RUN_ID"
