#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

DATASET_V1="${AGENTLAB_DATASET_V1:-$ROOT_DIR/.lab/experiments/data/swebench_lite_curated.task_boundary_v1.jsonl}"
DATASET_V2="${AGENTLAB_DATASET_V2:-$ROOT_DIR/.lab/experiments/data/swebench_lite_curated.task_boundary_v2.jsonl}"
AGENT_ARTIFACT="${AGENTLAB_AGENT_ARTIFACT:-$ROOT_DIR/.lab/agents/nova-current.tar.gz}"
TASK_WORKSPACE="${AGENTLAB_TASK_WORKSPACE:-/testbed}"
EXPERIMENT_YAML="$ROOT_DIR/.lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml"

ENSURE_DATASET_V2="${AGENTLAB_ENSURE_DATASET_V2:-1}"
FORCE_DATASET_V2="${AGENTLAB_FORCE_DATASET_V2:-0}"
FREEZE_AGENT="${AGENTLAB_FREEZE_AGENT:-1}"
EXPERIMENT_LIMIT="${AGENTLAB_LIMIT:-}"
MAX_CONCURRENCY="${AGENTLAB_MAX_CONCURRENCY:-}"

# --- enrich dataset v1 → v2 ---
if [[ "$ENSURE_DATASET_V2" == "1" ]]; then
  if [[ ! -f "$DATASET_V1" ]]; then
    echo "source v1 dataset not found: $DATASET_V1" >&2
    exit 1
  fi
  ENRICH_CMD=(node scripts/agentlab/enrich_dataset_v2.mjs "$DATASET_V1" "$DATASET_V2" --workspace "$TASK_WORKSPACE")
  if [[ "$FORCE_DATASET_V2" == "1" ]]; then
    ENRICH_CMD+=(--force)
  fi
  (cd "$ROOT_DIR" && "${ENRICH_CMD[@]}")
fi

# --- freeze agent artifact ---
if [[ "$FREEZE_AGENT" == "1" ]]; then
  (cd "$ROOT_DIR" && bash scripts/agentlab/freeze_agent.sh "$AGENT_ARTIFACT")
fi

# --- build experiment yaml ---
BUILD_CMD=(
  node scripts/agentlab/build_swebench_curated_ab_experiment.mjs
  --dataset "$DATASET_V2"
  --agent-artifact "$AGENT_ARTIFACT"
)
if [[ -n "$EXPERIMENT_LIMIT" ]]; then
  BUILD_CMD+=(--limit "$EXPERIMENT_LIMIT")
fi
if [[ -n "$MAX_CONCURRENCY" ]]; then
  BUILD_CMD+=(--max-concurrency "$MAX_CONCURRENCY")
fi
(cd "$ROOT_DIR" && "${BUILD_CMD[@]}")
