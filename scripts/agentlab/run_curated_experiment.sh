#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER_BIN_DEFAULT="$ROOT_DIR/../Experiments/rust/target/release/lab-cli"
RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-$RUNNER_BIN_DEFAULT}"

EXPERIMENT_REL=".lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml"
EXPERIMENT_PATH="$ROOT_DIR/$EXPERIMENT_REL"

DATASET_V1="${AGENTLAB_DATASET_V1:-$ROOT_DIR/.lab/experiments/data/swebench_lite_curated.task_boundary_v1.jsonl}"
DATASET_V2="${AGENTLAB_DATASET_V2:-$ROOT_DIR/.lab/experiments/data/swebench_lite_curated.task_boundary_v2.jsonl}"
AGENT_ARTIFACT="${AGENTLAB_AGENT_ARTIFACT:-$ROOT_DIR/.lab/agents/rex-current.tar.gz}"
TASK_WORKSPACE="${AGENTLAB_TASK_WORKSPACE:-/testbed}"

EXECUTOR="${AGENTLAB_EXECUTOR:-local_docker}"
MATERIALIZE="${AGENTLAB_MATERIALIZE:-full}"
RUN_MODE="${AGENTLAB_RUN_MODE:-run}"

BUILD_EXPERIMENT="${AGENTLAB_BUILD_EXPERIMENT:-1}"
FREEZE_AGENT="${AGENTLAB_FREEZE_AGENT:-1}"
ENSURE_DATASET_V2="${AGENTLAB_ENSURE_DATASET_V2:-1}"
FORCE_DATASET_V2="${AGENTLAB_FORCE_DATASET_V2:-0}"
PREPULL_IMAGES="${AGENTLAB_PREPULL_IMAGES:-0}"

EXPERIMENT_LIMIT="${AGENTLAB_LIMIT:-}"
MAX_CONCURRENCY="${AGENTLAB_MAX_CONCURRENCY:-}"
PROGRESS_INTERVAL_SEC="${AGENTLAB_PROGRESS_INTERVAL_SEC:-15}"

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/run_curated_experiment.sh

Runs the curated SWE-bench Lite A/B experiment in per-task image mode.

Defaults:
  runner_bin      ../Experiments/rust/target/release/lab-cli
  experiment      .lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml
  dataset_v2      .lab/experiments/data/swebench_lite_curated.task_boundary_v2.jsonl
  agent_artifact  .lab/agents/rex-current.tar.gz
  executor        local_docker
  materialize     full
  run_mode        run

Environment overrides:
  AGENTLAB_RUNNER_BIN         Alternate runner binary path.
  AGENTLAB_EXECUTOR           local_docker | local_process | remote
  AGENTLAB_MATERIALIZE        none | metadata_only | outputs_only | full
  AGENTLAB_RUN_MODE           run (default) | run_dev
  AGENTLAB_BUILD_EXPERIMENT   1 rebuild experiment before run (default), 0 skip.
  AGENTLAB_FREEZE_AGENT       1 freeze runtime artifact before run (default), 0 skip.
  AGENTLAB_ENSURE_DATASET_V2  1 generate task_boundary_v2 dataset before run (default), 0 skip.
  AGENTLAB_FORCE_DATASET_V2   1 force rebuild of task_boundary_v2 dataset.
  AGENTLAB_PREPULL_IMAGES     1 pre-pull unique task images from dataset_v2.
  AGENTLAB_LIMIT              If rebuild enabled, pass --limit to builder.
  AGENTLAB_MAX_CONCURRENCY    If rebuild enabled, pass --max-concurrency to builder.
  AGENTLAB_AGENT_ARTIFACT     Artifact path used by freeze/build scripts.
  AGENTLAB_TASK_WORKSPACE     task.workspace value injected into dataset_v2 (default: /testbed).
  AGENTLAB_DATASET_V1         Source v1 dataset path for enrichment.
  AGENTLAB_DATASET_V2         Target v2 dataset path + builder dataset.
  AGENTLAB_PROGRESS_INTERVAL_SEC  Seconds between progress updates (default: 15).
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

if [[ "$RUN_MODE" != "run" && "$RUN_MODE" != "run_dev" ]]; then
  echo "invalid AGENTLAB_RUN_MODE: $RUN_MODE (expected run or run_dev)" >&2
  exit 1
fi

if [[ "$EXECUTOR" == "local_docker" || "$RUN_MODE" == "run_dev" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "missing required command: docker" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "docker daemon unavailable or permission denied." >&2
    echo "fix docker access (daemon running + socket permissions), then retry." >&2
    exit 1
  fi
fi

if [[ -n "$MAX_CONCURRENCY" ]]; then
  if ! [[ "$MAX_CONCURRENCY" =~ ^[0-9]+$ ]] || [[ "$MAX_CONCURRENCY" -le 0 ]]; then
    echo "invalid AGENTLAB_MAX_CONCURRENCY: $MAX_CONCURRENCY (expected positive integer)" >&2
    exit 1
  fi
fi

if [[ "$ENSURE_DATASET_V2" == "1" ]]; then
  if [[ ! -f "$DATASET_V1" ]]; then
    echo "source v1 dataset not found: $DATASET_V1" >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "missing required command: node (needed for dataset enrichment)" >&2
    exit 1
  fi
  ENRICH_CMD=(
    node
    scripts/agentlab/enrich_dataset_v2.mjs
    "$DATASET_V1"
    "$DATASET_V2"
    --workspace
    "$TASK_WORKSPACE"
  )
  if [[ "$FORCE_DATASET_V2" == "1" ]]; then
    ENRICH_CMD+=(--force)
  fi
  (
    cd "$ROOT_DIR"
    "${ENRICH_CMD[@]}"
  )
fi

if [[ "$FREEZE_AGENT" == "1" ]]; then
  (
    cd "$ROOT_DIR"
    bash scripts/agentlab/freeze_agent.sh "$AGENT_ARTIFACT"
  )
fi

if [[ "$PREPULL_IMAGES" == "1" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "missing required command: docker (needed for AGENTLAB_PREPULL_IMAGES=1)" >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "missing required command: node (needed for AGENTLAB_PREPULL_IMAGES=1)" >&2
    exit 1
  fi
  if [[ ! -f "$DATASET_V2" ]]; then
    echo "dataset_v2 not found for pre-pull: $DATASET_V2" >&2
    exit 1
  fi
  (
    cd "$ROOT_DIR"
    node - "$DATASET_V2" <<'NODE' | while IFS= read -r image; do
const fs = require('node:fs');
const datasetPath = process.argv[2];
const lines = fs.readFileSync(datasetPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const images = new Set();
for (const line of lines) {
  const row = JSON.parse(line);
  const image = row?.task?.image;
  if (typeof image === 'string' && image.trim().length > 0) {
    images.add(image.trim());
  }
}
for (const image of Array.from(images).sort()) {
  process.stdout.write(`${image}\n`);
}
NODE
      [[ -z "$image" ]] && continue
      echo "pre-pull: $image"
      docker pull "$image"
    done
  )
fi

if [[ "$BUILD_EXPERIMENT" == "1" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "missing required command: node (needed to rebuild experiment)" >&2
    exit 1
  fi
  BUILD_CMD=(
    node
    scripts/agentlab/build_swebench_curated_ab_experiment.mjs
    --dataset
    "$DATASET_V2"
    --agent-artifact
    "$AGENT_ARTIFACT"
  )
  if [[ -n "$EXPERIMENT_LIMIT" ]]; then
    BUILD_CMD+=(--limit "$EXPERIMENT_LIMIT")
  fi
  if [[ -n "$MAX_CONCURRENCY" ]]; then
    BUILD_CMD+=(--max-concurrency "$MAX_CONCURRENCY")
  fi
  (
    cd "$ROOT_DIR"
    "${BUILD_CMD[@]}"
  )
fi

if [[ ! -f "$EXPERIMENT_PATH" ]]; then
  echo "experiment file not found: $EXPERIMENT_PATH" >&2
  exit 1
fi

RUN_OUTPUT_LOG="$(mktemp -t lab-run-XXXXXX.log)"
RUN_PID=""
TAIL_PID=""
cleanup_done=0

collect_descendant_pids() {
  local parent_pid="$1"
  local child_pid
  while IFS= read -r child_pid; do
    [[ -z "$child_pid" ]] && continue
    echo "$child_pid"
    collect_descendant_pids "$child_pid"
  done < <(ps -Ao pid=,ppid= | awk -v p="$parent_pid" '$2 == p { print $1 }')
}

kill_run_process_tree() {
  local root_pid="$1"
  if [[ -z "$root_pid" ]]; then
    return 0
  fi

  local -a descendants=()
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    descendants+=("$pid")
  done < <(collect_descendant_pids "$root_pid" | awk '!seen[$0]++')

  if [[ ${#descendants[@]} -gt 0 ]]; then
    kill "${descendants[@]}" >/dev/null 2>&1 || true
  fi
  kill "$root_pid" >/dev/null 2>&1 || true

  sleep 1

  local -a still_running=()
  for pid in "${descendants[@]}" "$root_pid"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if kill -0 "$pid" >/dev/null 2>&1; then
      still_running+=("$pid")
    fi
  done
  if [[ ${#still_running[@]} -gt 0 ]]; then
    kill -9 "${still_running[@]}" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  if [[ "$cleanup_done" == "1" ]]; then
    return 0
  fi
  cleanup_done=1
  if [[ -n "$TAIL_PID" ]]; then
    kill "$TAIL_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$RUN_PID" ]]; then
    kill_run_process_tree "$RUN_PID"
  fi
  rm -f "$RUN_OUTPUT_LOG"
}
trap cleanup EXIT

on_interrupt() {
  echo "interrupt received; stopping run..." >&2
  exit 130
}
trap on_interrupt INT TERM

declare -A EXISTING_RUN_IDS=()
if [[ -d "$ROOT_DIR/.lab/runs" ]]; then
  while IFS= read -r existing_dir; do
    EXISTING_RUN_IDS["$(basename "$existing_dir")"]=1
  done < <(find "$ROOT_DIR/.lab/runs" -maxdepth 1 -mindepth 1 -type d -name 'run_*' -print 2>/dev/null)
fi

detect_run_id_from_fs() {
  if [[ ! -d "$ROOT_DIR/.lab/runs" ]]; then
    return 1
  fi
  while IFS= read -r run_dir; do
    local run_id
    run_id="$(basename "$run_dir")"
    if [[ -z "${EXISTING_RUN_IDS[$run_id]:-}" ]]; then
      echo "$run_id"
      return 0
    fi
  done < <(find "$ROOT_DIR/.lab/runs" -maxdepth 1 -mindepth 1 -type d -name 'run_*' -print 2>/dev/null | xargs -r ls -1dt)
  return 1
}

extract_progress_field() {
  local file_path="$1"
  local sed_expr="$2"
  if [[ ! -f "$file_path" ]]; then
    echo ""
    return 0
  fi
  sed -n "$sed_expr" "$file_path" | head -n1
}

extract_completed_slots() {
  local progress_file="$1"
  if [[ ! -f "$progress_file" ]]; then
    echo "0"
    return 0
  fi
  grep -c '"schedule_index"' "$progress_file" 2>/dev/null || echo "0"
}

progress_line_for_run() {
  local run_id="$1"
  local progress_file="$ROOT_DIR/.lab/runs/$run_id/runtime/schedule_progress.json"
  local control_file="$ROOT_DIR/.lab/runs/$run_id/runtime/run_control.json"
  local completed total status active_trial
  completed="$(extract_completed_slots "$progress_file")"
  total="$(extract_progress_field "$progress_file" 's/.*"total_slots":[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  status="$(extract_progress_field "$control_file" 's/.*"status":[[:space:]]*"\([^"]*\)".*/\1/p')"
  active_trial="$(extract_progress_field "$control_file" 's/.*"active_trial_id":[[:space:]]*"\([^"]*\)".*/\1/p')"

  if [[ -z "$total" ]]; then total="?"; fi
  if [[ -z "$status" ]]; then status="starting"; fi
  if [[ -z "$active_trial" ]]; then active_trial="-"; fi
  echo "progress run_id=$run_id status=$status active_trial=$active_trial completed=$completed/$total"
}

touch "$RUN_OUTPUT_LOG"
tail -n +1 -f "$RUN_OUTPUT_LOG" &
TAIL_PID=$!

(
  cd "$ROOT_DIR"
  if [[ "$RUN_MODE" == "run_dev" ]]; then
    "$RUNNER_BIN" run-dev "$EXPERIMENT_REL"
  else
    "$RUNNER_BIN" run "$EXPERIMENT_REL" \
      --executor "$EXECUTOR" \
      --materialize "$MATERIALIZE"
  fi
) >"$RUN_OUTPUT_LOG" 2>&1 &
RUN_PID=$!

RUN_ID=""
LAST_PROGRESS_LINE=""
while kill -0 "$RUN_PID" >/dev/null 2>&1; do
  if [[ -z "$RUN_ID" ]]; then
    RUN_ID="$(grep -Eo 'run_[0-9]{8}_[0-9]{6}' "$RUN_OUTPUT_LOG" | tail -n1 || true)"
    if [[ -z "$RUN_ID" ]]; then
      RUN_ID="$(detect_run_id_from_fs || true)"
    fi
    if [[ -n "$RUN_ID" ]]; then
      echo "run_id=$RUN_ID"
    fi
  fi

  if [[ -n "$RUN_ID" ]]; then
    LINE="$(progress_line_for_run "$RUN_ID")"
    if [[ "$LINE" != "$LAST_PROGRESS_LINE" ]]; then
      echo "$LINE"
      LAST_PROGRESS_LINE="$LINE"
    fi
  fi
  sleep "$PROGRESS_INTERVAL_SEC"
done

wait "$RUN_PID"
RUN_STATUS=$?

if [[ -n "$TAIL_PID" ]]; then
  kill "$TAIL_PID" >/dev/null 2>&1 || true
  wait "$TAIL_PID" 2>/dev/null || true
  TAIL_PID=""
fi
if [[ $RUN_STATUS -ne 0 ]]; then
  echo "lab run failed with status $RUN_STATUS" >&2
  exit "$RUN_STATUS"
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(grep -Eo 'run_[0-9]{8}_[0-9]{6}' "$RUN_OUTPUT_LOG" | tail -n1 || true)"
fi
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(detect_run_id_from_fs || true)"
fi
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(find "$ROOT_DIR/.lab/runs" -maxdepth 1 -type d -name 'run_*' -print 2>/dev/null | xargs -r ls -1dt | head -n1 | xargs -r basename)"
fi

if [[ -z "$RUN_ID" ]]; then
  echo "unable to determine run_id from lab output" >&2
  exit 1
fi

echo "$RUN_ID"
