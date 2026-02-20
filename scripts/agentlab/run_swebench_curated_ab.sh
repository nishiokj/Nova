#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-/Users/jevinnishioka/Desktop/Experiments/rust/target/release/lab-cli}"
EXPERIMENT_PATH="${EXPERIMENT_PATH:-.lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml}"
DATASET_PATH="${DATASET_PATH:-.lab/experiments/data/swebench_lite_curated.task_boundary_v1.jsonl}"
IMAGE_TAG="${IMAGE_TAG:-rex-harness:swebench-lite}"
EXECUTOR="${EXECUTOR:-local_docker}"
MATERIALIZE="${MATERIALIZE:-outputs_only}"
LIMIT="${LIMIT:-1}"
SKIP_BUILD=0
DESCRIBE_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runner-bin)
      RUNNER_BIN="$2"
      shift 2
      ;;
    --experiment)
      EXPERIMENT_PATH="$2"
      shift 2
      ;;
    --dataset)
      DATASET_PATH="$2"
      shift 2
      ;;
    --image)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --executor)
      EXECUTOR="$2"
      shift 2
      ;;
    --materialize)
      MATERIALIZE="$2"
      shift 2
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --describe-only)
      DESCRIBE_ONLY=1
      shift
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

node scripts/agentlab/build_swebench_curated_ab_experiment.mjs \
  --dataset "$DATASET_PATH" \
  --output "$EXPERIMENT_PATH" \
  --image "$IMAGE_TAG" \
  --limit "$LIMIT"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  bash scripts/agentlab/build_agent_image.sh --tag "$IMAGE_TAG"
fi

mkdir -p .lab

echo "describe: ${EXPERIMENT_PATH}"
"$RUNNER_BIN" describe "$EXPERIMENT_PATH" --json | tee .lab/describe_glm_vs_codex.json

if [[ "$DESCRIBE_ONLY" -eq 1 ]]; then
  echo "describe-only complete"
  exit 0
fi

echo "run: ${EXPERIMENT_PATH} (executor=${EXECUTOR}, materialize=${MATERIALIZE})"
"$RUNNER_BIN" run "$EXPERIMENT_PATH" --executor "$EXECUTOR" --materialize "$MATERIALIZE" --json | tee .lab/full_run_glm_vs_codex.log
