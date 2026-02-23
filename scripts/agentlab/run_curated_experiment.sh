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
MAX_CONCURRENCY="${AGENTLAB_MAX_CONCURRENCY:-}"
PROGRESS_INTERVAL_SEC="${AGENTLAB_PROGRESS_INTERVAL_SEC:-15}"
RUN_MODE="${AGENTLAB_RUN_MODE:-run_dev}"
SETUP_CMD_DEFAULT="/bin/bash /opt/rex/scripts/agentlab/setup_swebench_trial_workspace.sh"
SETUP_CMD="${AGENTLAB_SETUP_COMMAND:-$SETUP_CMD_DEFAULT}"

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
  AGENTLAB_MAX_CONCURRENCY  If rebuild is enabled, pass --max-concurrency to the builder.
  AGENTLAB_PROGRESS_INTERVAL_SEC Seconds between progress updates (default: 15).
  AGENTLAB_RUN_MODE         run_dev (default, enables setup command) | run
  AGENTLAB_SETUP_COMMAND    Setup command passed to lab-cli run-dev --setup.
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

if [[ "$RUN_MODE" != "run_dev" && "$RUN_MODE" != "run" ]]; then
  echo "invalid AGENTLAB_RUN_MODE: $RUN_MODE (expected run_dev or run)" >&2
  exit 1
fi

if [[ ! -f "$EXPERIMENT_PATH" ]]; then
  echo "experiment file not found: $EXPERIMENT_PATH" >&2
  exit 1
fi

if [[ -n "$MAX_CONCURRENCY" ]]; then
  if ! [[ "$MAX_CONCURRENCY" =~ ^[0-9]+$ ]] || [[ "$MAX_CONCURRENCY" -le 0 ]]; then
    echo "invalid AGENTLAB_MAX_CONCURRENCY: $MAX_CONCURRENCY (expected positive integer)" >&2
    exit 1
  fi
fi

if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "docker image not found: $IMAGE_TAG" >&2
  echo "build it first: bash scripts/agentlab/build_agent_image.sh --tag $IMAGE_TAG" >&2
  exit 1
fi

if [[ "$RUN_MODE" == "run_dev" && "$SETUP_CMD" == "$SETUP_CMD_DEFAULT" ]]; then
  if ! docker run --rm --entrypoint /bin/sh "$IMAGE_TAG" -lc "test -x /opt/rex/scripts/agentlab/setup_swebench_trial_workspace.sh"; then
    echo "image $IMAGE_TAG does not contain setup_swebench_trial_workspace.sh" >&2
    echo "rebuild image: bash scripts/agentlab/build_agent_image.sh --tag $IMAGE_TAG" >&2
    exit 1
  fi
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
  if [[ -n "$MAX_CONCURRENCY" ]]; then
    BUILD_CMD+=(--max-concurrency "$MAX_CONCURRENCY")
  fi
  (
    cd "$ROOT_DIR"
    "${BUILD_CMD[@]}"
  ) >/dev/null
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

RUN_CMD_MODE="positional"
if ! "$RUNNER_BIN" run --help 2>&1 | grep -q "<EXPERIMENT>"; then
  RUN_CMD_MODE="flag"
fi

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
    "$RUNNER_BIN" run-dev "$EXPERIMENT_REL" --setup "$SETUP_CMD"
  else
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
