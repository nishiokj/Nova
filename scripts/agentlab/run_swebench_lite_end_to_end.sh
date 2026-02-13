#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

EXPERIMENT_PATH="${EXPERIMENT_PATH:-.lab/experiments/swebench_lite_sdk_single_container.yaml}"
DATASET_PATH="${DATASET_PATH:-bench/agentlab/swebench_lite_smoke_1.jsonl}"
LIMIT="${LIMIT:-1}"
RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-lab}"
SKIP_DESCRIBE="${SKIP_DESCRIBE:-0}"

resolve_runner_bin() {
  local runner="$1"
  if [[ "$runner" == */* ]]; then
    if [[ ! -x "$runner" ]]; then
      echo "Runner binary is not executable: $runner" >&2
      return 1
    fi
    printf '%s' "$runner"
    return 0
  fi
  if ! command -v "$runner" >/dev/null 2>&1; then
    echo "Runner binary not found in PATH: $runner" >&2
    return 1
  fi
  printf '%s' "$runner"
}

extract_json_field() {
  local log_path="$1"
  local field="$2"
  node -e '
const fs = require("node:fs");
const logPath = process.argv[1];
const field = process.argv[2];
const lines = fs.readFileSync(logPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0);
let payload = null;
for (let i = lines.length - 1; i >= 0; i -= 1) {
  try {
    const parsed = JSON.parse(lines[i]);
    if (parsed && typeof parsed === "object") {
      payload = parsed;
      break;
    }
  } catch {}
}
if (!payload) {
  console.error(`Could not find JSON payload in ${logPath}`);
  process.exit(1);
}
const parts = field.split(".");
let cursor = payload;
for (const part of parts) {
  if (cursor == null || typeof cursor !== "object" || !(part in cursor)) {
    console.error(`Missing JSON field: ${field}`);
    process.exit(1);
  }
  cursor = cursor[part];
}
if (typeof cursor === "string" || typeof cursor === "number" || typeof cursor === "boolean") {
  process.stdout.write(String(cursor));
} else {
  process.stdout.write(JSON.stringify(cursor));
}
' "$log_path" "$field"
}

RUNNER="$(resolve_runner_bin "$RUNNER_BIN")"
GENERATOR="scripts/agentlab/run_swebench_lite_experiment_sdk.mjs"

if [[ ! -f "$GENERATOR" ]]; then
  echo "Missing generator script: $GENERATOR" >&2
  exit 1
fi

if [[ ! -f "$DATASET_PATH" ]]; then
  echo "Dataset not found: $DATASET_PATH" >&2
  exit 1
fi

echo "[1/3] Generating experiment config..."
node "$GENERATOR" \
  --experiment "$EXPERIMENT_PATH" \
  --dataset "$DATASET_PATH" \
  --limit "$LIMIT"

desc_log="$(mktemp)"
run_log="$(mktemp)"
cleanup() {
  rm -f "$desc_log" "$run_log"
}
trap cleanup EXIT

if [[ "$SKIP_DESCRIBE" != "1" ]]; then
  echo "[2/3] Describing planned run..."
  "$RUNNER" describe "$EXPERIMENT_PATH" --json | tee "$desc_log"
  planned_trials="$(extract_json_field "$desc_log" "summary.total_trials")"
  echo "Planned trials: $planned_trials"
fi

echo "[3/3] Running experiment end-to-end..."
"$RUNNER" run "$EXPERIMENT_PATH" --json | tee "$run_log"

run_id="$(extract_json_field "$run_log" "run.run_id")"
run_dir="$(extract_json_field "$run_log" "run.run_dir")"

echo
echo "Run complete"
echo "run_id: $run_id"
echo "run_dir: $run_dir"
echo
echo "Benchmark artifacts:"
echo "  $run_dir/benchmark/adapter_manifest.json"
echo "  $run_dir/benchmark/predictions.jsonl"
echo "  $run_dir/benchmark/scores.jsonl"
echo "  $run_dir/benchmark/summary.json"
echo
echo "Analysis artifacts:"
echo "  $run_dir/analysis/summary.json"
echo "  $run_dir/analysis/comparisons.json"
echo "  $run_dir/analysis/tables/trials.jsonl"
echo "  $run_dir/analysis/tables/metrics_long.jsonl"
echo "  $run_dir/analysis/tables/load_duckdb.sql"
echo
echo "DuckDB load command:"
echo "  duckdb \"$run_dir/analysis/agentlab.duckdb\" < \"$run_dir/analysis/tables/load_duckdb.sql\""
