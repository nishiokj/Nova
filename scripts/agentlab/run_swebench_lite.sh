#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RUNNER_BIN_DEFAULT="/Users/jevinnishioka/Desktop/Experiments/rust/target/release/lab-cli"
RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-${RUNNER_BIN_DEFAULT}}"
EXECUTOR="${AGENTLAB_EXECUTOR:-local_docker}"
MATERIALIZE="${AGENTLAB_MATERIALIZE:-outputs_only}"

EXPERIMENT_REL=".lab/experiments/swebench_lite_v2_zero_glue_full_glm_vs_codex.yaml"
MODE_LABEL="full-glm-vs-codex"
EXTRA_ARGS=()

usage() {
  cat <<'EOF'
Usage: run_swebench_lite.sh [options] [-- <extra lab-cli args>]

Presets:
  --smoke             .lab/experiments/swebench_lite_v2_zero_glue.yaml
  --full              .lab/experiments/swebench_lite_v2_zero_glue_full_glm_vs_codex.yaml (default)
  --full-openai       .lab/experiments/swebench_lite_v2_zero_glue_full_openai.yaml

Options:
  --experiment <rel>  Explicit experiment path relative to repo root
  --runner-bin <path> Override lab-cli binary
  --executor <name>   Runner executor (default: local_docker)
  --materialize <m>   Materialize mode (default: outputs_only)
  --no-json           Do not pass --json to lab-cli
  -h, --help          Show help

Behavior:
  The script refreshes mapped task-boundary datasets before running:
  - smoke -> bench/agentlab/swebench_lite_smoke_1.jsonl
  - full* -> bench/agentlab/swebench_lite_curated.jsonl
EOF
}

USE_JSON=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --smoke)
      EXPERIMENT_REL=".lab/experiments/swebench_lite_v2_zero_glue.yaml"
      MODE_LABEL="smoke"
      shift
      ;;
    --full)
      EXPERIMENT_REL=".lab/experiments/swebench_lite_v2_zero_glue_full_glm_vs_codex.yaml"
      MODE_LABEL="full-glm-vs-codex"
      shift
      ;;
    --full-openai)
      EXPERIMENT_REL=".lab/experiments/swebench_lite_v2_zero_glue_full_openai.yaml"
      MODE_LABEL="full-openai"
      shift
      ;;
    --experiment)
      EXPERIMENT_REL="${2:-}"
      MODE_LABEL="custom"
      shift 2
      ;;
    --runner-bin)
      RUNNER_BIN="${2:-}"
      shift 2
      ;;
    --executor)
      EXECUTOR="${2:-}"
      shift 2
      ;;
    --materialize)
      MATERIALIZE="${2:-}"
      shift 2
      ;;
    --no-json)
      USE_JSON=0
      shift
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "${ROOT_DIR}"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${ZAI_CODER_API_KEY:-}" ]]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required to load ZAI_CODER_API_KEY from GraphD." >&2
    exit 1
  fi
  eval "$(bun scripts/agentlab/export_provider_env_from_graphd.mjs --provider z.ai-coder=ZAI_CODER_API_KEY)"
fi

DATASET_MAP_INPUT=""
DATASET_MAP_OUTPUT=""
DATASET_MAP_LIMIT_ARGS=()
case "${EXPERIMENT_REL}" in
  ".lab/experiments/swebench_lite_v2_zero_glue.yaml")
    DATASET_MAP_INPUT="bench/agentlab/swebench_lite_smoke_1.jsonl"
    DATASET_MAP_OUTPUT=".lab/experiments/data/swebench_lite_smoke_1.task_boundary_v1.jsonl"
    DATASET_MAP_LIMIT_ARGS=(--limit 1)
    ;;
  ".lab/experiments/swebench_lite_v2_zero_glue_full_glm_vs_codex.yaml"|".lab/experiments/swebench_lite_v2_zero_glue_full_openai.yaml")
    DATASET_MAP_INPUT="bench/agentlab/swebench_lite_curated.jsonl"
    DATASET_MAP_OUTPUT=".lab/experiments/data/swebench_lite_curated.task_boundary_v1.jsonl"
    ;;
esac

if [[ -n "${DATASET_MAP_INPUT}" ]]; then
  echo "refreshing mapped dataset:"
  echo "  input:  ${DATASET_MAP_INPUT}"
  echo "  output: ${DATASET_MAP_OUTPUT}"
  bun scripts/agentlab/map_swebench_lite_to_task_boundary.mjs \
    --input "${DATASET_MAP_INPUT}" \
    --output "${DATASET_MAP_OUTPUT}" \
    "${DATASET_MAP_LIMIT_ARGS[@]}"
  echo
fi

if [[ ! -x "${RUNNER_BIN}" ]]; then
  echo "Runner binary not found or not executable: ${RUNNER_BIN}" >&2
  echo "Set AGENTLAB_RUNNER_BIN or pass --runner-bin." >&2
  exit 1
fi

EXPERIMENT_PATH="${ROOT_DIR}/${EXPERIMENT_REL}"
if [[ ! -f "${EXPERIMENT_PATH}" ]]; then
  echo "Experiment file not found: ${EXPERIMENT_PATH}" >&2
  exit 1
fi

echo "mode: ${MODE_LABEL}"
echo "experiment: ${EXPERIMENT_PATH}"
echo "runner: ${RUNNER_BIN}"
echo "executor: ${EXECUTOR}"
echo "materialize: ${MATERIALIZE}"
echo

CMD=(
  "${RUNNER_BIN}"
  run
  "${EXPERIMENT_PATH}"
  --executor "${EXECUTOR}"
  --materialize "${MATERIALIZE}"
)
if [[ "${USE_JSON}" -eq 1 ]]; then
  CMD+=(--json)
fi
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  CMD+=("${EXTRA_ARGS[@]}")
fi

"${CMD[@]}"

echo
echo "Observe:"
echo "  bash scripts/agentlab/observe_run.sh --latest"
