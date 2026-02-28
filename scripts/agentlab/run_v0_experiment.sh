#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPERIMENTS_DIR="${AGENTLAB_EXPERIMENTS_DIR:-$ROOT_DIR/../Experiments}"
RUNNER_BIN_DEFAULT="$EXPERIMENTS_DIR/rust/target/release/lab-cli"
RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-$RUNNER_BIN_DEFAULT}"

EXPERIMENT_REL=".lab/experiments/bench_v0_glm5_vs_codex_spark.yaml"
EXPERIMENT_PATH="$ROOT_DIR/$EXPERIMENT_REL"

DATASET="${AGENTLAB_DATASET:-$ROOT_DIR/.lab/experiments/data/bench_v0.task_boundary_v1.jsonl}"
AGENT_ARTIFACT="${AGENTLAB_AGENT_ARTIFACT:-$ROOT_DIR/.lab/agents/nova-current.tar.gz}"
V0_IMAGE="${AGENTLAB_V0_IMAGE:-bench-v0:latest}"

EXECUTOR="${AGENTLAB_EXECUTOR:-local_docker}"
MATERIALIZE="${AGENTLAB_MATERIALIZE:-full}"
RUN_MODE="${AGENTLAB_RUN_MODE:-run}"

BUILD_IMAGE="${AGENTLAB_BUILD_IMAGE:-1}"
EXPORT_DATASET="${AGENTLAB_EXPORT_DATASET:-1}"
BUILD_EXPERIMENT="${AGENTLAB_BUILD_EXPERIMENT:-1}"
FREEZE_AGENT="${AGENTLAB_FREEZE_AGENT:-1}"

EXPERIMENT_LIMIT="${AGENTLAB_LIMIT:-}"
MAX_CONCURRENCY="${AGENTLAB_MAX_CONCURRENCY:-}"
PROGRESS_INTERVAL_SEC="${AGENTLAB_PROGRESS_INTERVAL_SEC:-15}"
AUTO_PRUNE_DOCKER="${AGENTLAB_AUTO_PRUNE_DOCKER:-1}"
DOCKER_PRUNE_TIMEOUT_SEC="${AGENTLAB_DOCKER_PRUNE_TIMEOUT_SEC:-90}"

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/run_v0_experiment.sh

Runs the bench v0 A/B experiment in global-image mode.

Defaults:
  experiments_dir ../Experiments
  runner_bin      ../Experiments/rust/target/release/lab-cli
  experiment      .lab/experiments/bench_v0_glm5_vs_codex_spark.yaml
  dataset         .lab/experiments/data/bench_v0.task_boundary_v1.jsonl
  agent_artifact  .lab/agents/nova-current.tar.gz
  image           bench-v0:latest
  executor        local_docker
  materialize     full
  run_mode        run

Environment overrides:
  AGENTLAB_EXPERIMENTS_DIR    Path to the Experiments repo (default: ../Experiments).
  AGENTLAB_RUNNER_BIN         Alternate runner binary path.
  AGENTLAB_EXECUTOR           local_docker | local_process | remote
  AGENTLAB_MATERIALIZE        none | metadata_only | outputs_only | full
  AGENTLAB_RUN_MODE           run (default) | run_dev
  AGENTLAB_BUILD_IMAGE        1 build bench-v0 image (default), 0 skip.
  AGENTLAB_EXPORT_DATASET     1 export v0 dataset (default), 0 skip.
  AGENTLAB_BUILD_EXPERIMENT   1 rebuild experiment YAML (default), 0 skip.
  AGENTLAB_FREEZE_AGENT       1 freeze agent artifact (default), 0 skip.
  AGENTLAB_LIMIT              Pass --limit to experiment builder.
  AGENTLAB_MAX_CONCURRENCY    Pass --max-concurrency to experiment builder.
  AGENTLAB_V0_IMAGE           Container image name (default: bench-v0:latest).
  AGENTLAB_DATASET            Path to exported v0 dataset JSONL.
  AGENTLAB_AGENT_ARTIFACT     Agent artifact path.
  AGENTLAB_PROGRESS_INTERVAL_SEC  Seconds between progress updates (default: 15).
  AGENTLAB_AUTO_PRUNE_DOCKER  1 (default) runs safe Docker GC after run; 0 skip.
  AGENTLAB_DOCKER_PRUNE_TIMEOUT_SEC  Timeout per docker prune command (default: 90).
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

# ── Resolve runner ───────────────────────────────────────────────────────────
if [[ ! -x "$RUNNER_BIN" ]]; then
  if command -v lab-cli >/dev/null 2>&1; then
    RUNNER_BIN="$(command -v lab-cli)"
  elif command -v lab >/dev/null 2>&1; then
    RUNNER_BIN="$(command -v lab)"
  else
    echo "runner not found. set AGENTLAB_RUNNER_BIN or build lab-cli in Experiments." >&2
    exit 1
  fi
fi

if [[ "$RUN_MODE" != "run" && "$RUN_MODE" != "run_dev" ]]; then
  echo "invalid AGENTLAB_RUN_MODE: $RUN_MODE (expected run or run_dev)" >&2
  exit 1
fi

# ── Docker check ─────────────────────────────────────────────────────────────
if [[ "$EXECUTOR" == "local_docker" || "$RUN_MODE" == "run_dev" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "missing required command: docker" >&2
    exit 1
  fi
  DOCKER_OK=0
  docker info >/dev/null 2>&1 &
  DOCKER_CHECK_PID=$!
  for _ in 1 2 3 4 5; do
    if ! kill -0 "$DOCKER_CHECK_PID" 2>/dev/null; then
      wait "$DOCKER_CHECK_PID" 2>/dev/null && DOCKER_OK=1
      break
    fi
    sleep 1
  done
  if [[ "$DOCKER_OK" != "1" ]]; then
    kill "$DOCKER_CHECK_PID" 2>/dev/null; wait "$DOCKER_CHECK_PID" 2>/dev/null || true
    echo "docker daemon unavailable (not running or timed out)." >&2
    exit 1
  fi
fi

if [[ -n "${MAX_CONCURRENCY:-}" ]]; then
  if ! [[ "$MAX_CONCURRENCY" =~ ^[0-9]+$ ]] || [[ "$MAX_CONCURRENCY" -le 0 ]]; then
    echo "invalid AGENTLAB_MAX_CONCURRENCY: $MAX_CONCURRENCY (expected positive integer)" >&2
    exit 1
  fi
fi

# ── 1. Export dataset ────────────────────────────────────────────────────────
if [[ "$EXPORT_DATASET" == "1" ]]; then
  if [[ ! -d "$EXPERIMENTS_DIR" ]]; then
    echo "experiments dir not found: $EXPERIMENTS_DIR" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$DATASET")"
  EXPORT_CMD=(
    python3
    scripts/bench/export_bench_suite_to_jsonl.py
    --suite v0
    --output "$DATASET"
  )
  if [[ -n "$EXPERIMENT_LIMIT" ]]; then
    EXPORT_CMD+=(--limit "$EXPERIMENT_LIMIT")
  fi
  echo "exporting bench v0 dataset..."
  (cd "$EXPERIMENTS_DIR" && "${EXPORT_CMD[@]}")
fi

if [[ ! -f "$DATASET" ]]; then
  echo "dataset not found: $DATASET" >&2
  exit 1
fi

# ── 2. Build container image ────────────────────────────────────────────────
if [[ "$BUILD_IMAGE" == "1" ]]; then
  echo "building bench-v0 container image..."
  docker build \
    -f "$ROOT_DIR/scripts/agentlab/docker/bench-v0.Dockerfile" \
    -t "$V0_IMAGE" \
    "$EXPERIMENTS_DIR"
fi

# ── 3. Freeze agent artifact ────────────────────────────────────────────────
if [[ "$FREEZE_AGENT" == "1" ]]; then
  (
    cd "$ROOT_DIR"
    bash scripts/agentlab/runtime/freeze_agent.sh "$AGENT_ARTIFACT"
  )
fi

# ── 4. Build experiment YAML ────────────────────────────────────────────────
if [[ "$BUILD_EXPERIMENT" == "1" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "missing required command: node (needed to rebuild experiment)" >&2
    exit 1
  fi
  BUILD_CMD=(
    node
    scripts/agentlab/data/build_bench_v0_ab_experiment.mjs
    --dataset "$DATASET"
    --agent-artifact "$AGENT_ARTIFACT"
    --image "$V0_IMAGE"
  )
  if [[ -n "$EXPERIMENT_LIMIT" ]]; then
    BUILD_CMD+=(--limit "$EXPERIMENT_LIMIT")
  fi
  if [[ -n "${MAX_CONCURRENCY:-}" ]]; then
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

# ── 5. Run experiment ───────────────────────────────────────────────────────

RUN_OUTPUT_LOG="$(mktemp -t lab-run-v0-XXXXXX.log)"
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
  if [[ -z "$root_pid" ]]; then return 0; fi
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
  if [[ "$cleanup_done" == "1" ]]; then return 0; fi
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
  if [[ ! -d "$ROOT_DIR/.lab/runs" ]]; then return 1; fi
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

detect_latest_run_id() {
  find "$ROOT_DIR/.lab/runs" -maxdepth 1 -type d -name 'run_*' -print 2>/dev/null | xargs -r ls -1dt | head -n1 | xargs -r basename
}

LAST_RUN_ID_FILE="$ROOT_DIR/.lab/last_run_id"
RECORDED_RUN_ID=""
record_run_id() {
  local run_id="$1"
  [[ -z "$run_id" ]] && return 0
  if [[ "$run_id" != "$RECORDED_RUN_ID" ]]; then
    mkdir -p "$(dirname "$LAST_RUN_ID_FILE")"
    printf '%s\n' "$run_id" > "$LAST_RUN_ID_FILE"
    echo "run_id=$run_id"
    RECORDED_RUN_ID="$run_id"
  fi
}

extract_progress_field() {
  local file_path="$1"
  local sed_expr="$2"
  if [[ ! -f "$file_path" ]]; then echo ""; return 0; fi
  sed -n "$sed_expr" "$file_path" | head -n1
}

extract_completed_slots() {
  local progress_file="$1"
  if [[ ! -f "$progress_file" ]]; then echo "0"; return 0; fi
  grep -c '"schedule_index"' "$progress_file" 2>/dev/null || echo "0"
}

run_with_timeout_quiet() {
  local timeout_s="$1"; shift
  "$@" >/dev/null 2>&1 &
  local cmd_pid=$!
  local waited=0
  while kill -0 "$cmd_pid" >/dev/null 2>&1; do
    if [[ "$waited" -ge "$timeout_s" ]]; then
      kill "$cmd_pid" >/dev/null 2>&1 || true
      wait "$cmd_pid" >/dev/null 2>&1 || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$cmd_pid"
}

safe_docker_gc() {
  if [[ "$AUTO_PRUNE_DOCKER" != "1" ]]; then
    echo "skipping docker GC (AGENTLAB_AUTO_PRUNE_DOCKER=0)"
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not available; skipping docker GC"
    return 0
  fi
  echo "running safe docker GC (builder cache + dangling images)"
  if run_with_timeout_quiet "$DOCKER_PRUNE_TIMEOUT_SEC" docker builder prune -f; then
    echo "docker builder cache prune complete"
  else
    echo "docker builder prune skipped/timeout"
  fi
  if run_with_timeout_quiet "$DOCKER_PRUNE_TIMEOUT_SEC" docker image prune -f; then
    echo "docker dangling image prune complete"
  else
    echo "docker image prune skipped/timeout"
  fi
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
    record_run_id "$RUN_ID"
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

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(grep -Eo 'run_[0-9]{8}_[0-9]{6}' "$RUN_OUTPUT_LOG" | tail -n1 || true)"
fi
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(detect_run_id_from_fs || true)"
fi
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(detect_latest_run_id || true)"
fi
record_run_id "$RUN_ID"

if [[ -z "$RUN_ID" ]]; then
  echo "unable to determine run_id from lab output/filesystem" >&2
  exit 1
fi

if [[ $RUN_STATUS -ne 0 ]]; then
  echo "lab run failed with status $RUN_STATUS (run_id=$RUN_ID)" >&2
  exit "$RUN_STATUS"
fi

safe_docker_gc

echo "$RUN_ID"
