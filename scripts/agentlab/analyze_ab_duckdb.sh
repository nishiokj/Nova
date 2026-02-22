#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER_BIN_DEFAULT="$ROOT_DIR/../Experiments/rust/target/release/lab-cli"

BASELINE_RUN_ID=""
TREATMENT_RUN_ID=""
BASELINE_LABEL="baseline"
TREATMENT_LABEL="treatment"
RUNNER_BIN="${AGENTLAB_RUNNER_BIN:-$RUNNER_BIN_DEFAULT}"
JSON=0

usage() {
  cat <<USAGE
Usage: bash scripts/agentlab/analyze_ab_duckdb.sh --baseline-run-id <run_id> --treatment-run-id <run_id> [options]

Options:
  --baseline-run-id <id>      Baseline run id (required)
  --treatment-run-id <id>     Treatment run id (required)
  --baseline-label <label>    Baseline display label (default: baseline)
  --treatment-label <label>   Treatment display label (default: treatment)
  --runner-bin <path>         lab-cli binary path (default: ../Experiments/rust/target/release/lab-cli)
  --json                      Emit lab-cli query output as JSON
  -h, --help                  Show this help

Notes:
  - "metrics.success" comes from harness response success (not benchmark grading).
  - Benchmark grading is reported separately from benchmark/scores.jsonl when available.
  - Runner trial status is separate (completed/failed + exit_reason).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline-run-id)
      BASELINE_RUN_ID="$2"
      shift 2
      ;;
    --treatment-run-id)
      TREATMENT_RUN_ID="$2"
      shift 2
      ;;
    --baseline-label)
      BASELINE_LABEL="$2"
      shift 2
      ;;
    --treatment-label)
      TREATMENT_LABEL="$2"
      shift 2
      ;;
    --runner-bin)
      RUNNER_BIN="$2"
      shift 2
      ;;
    --json)
      JSON=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BASELINE_RUN_ID" || -z "$TREATMENT_RUN_ID" ]]; then
  echo "--baseline-run-id and --treatment-run-id are required" >&2
  usage >&2
  exit 1
fi

if [[ ! -x "$RUNNER_BIN" ]]; then
  echo "runner not executable: $RUNNER_BIN" >&2
  exit 1
fi

BASELINE_DIR="$ROOT_DIR/.lab/runs/$BASELINE_RUN_ID"
TREATMENT_DIR="$ROOT_DIR/.lab/runs/$TREATMENT_RUN_ID"

if [[ ! -d "$BASELINE_DIR" ]]; then
  echo "baseline run dir not found: $BASELINE_DIR" >&2
  exit 1
fi
if [[ ! -d "$TREATMENT_DIR" ]]; then
  echo "treatment run dir not found: $TREATMENT_DIR" >&2
  exit 1
fi

# lab-cli query needs an anchor run that has analysis tables.
if [[ -d "$TREATMENT_DIR/analysis/tables" ]]; then
  ANCHOR_DIR="$TREATMENT_DIR"
elif [[ -d "$BASELINE_DIR/analysis/tables" ]]; then
  ANCHOR_DIR="$BASELINE_DIR"
else
  echo "neither run has analysis/tables; need at least one completed-materialized run" >&2
  exit 1
fi

sql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

run_query() {
  local sql="$1"
  if [[ "$JSON" -eq 1 ]]; then
    "$RUNNER_BIN" query "$ANCHOR_DIR" "$sql" --json
  else
    "$RUNNER_BIN" query "$ANCHOR_DIR" "$sql"
  fi
}

B_RESULTS_GLOB="$(sql_quote "$BASELINE_DIR/trials/*/out/result.json")"
T_RESULTS_GLOB="$(sql_quote "$TREATMENT_DIR/trials/*/out/result.json")"
B_STATE_GLOB="$(sql_quote "$BASELINE_DIR/trials/*/trial_state.json")"
T_STATE_GLOB="$(sql_quote "$TREATMENT_DIR/trials/*/trial_state.json")"
B_BENCHMARK_SCORES="$(sql_quote "$BASELINE_DIR/benchmark/scores.jsonl")"
T_BENCHMARK_SCORES="$(sql_quote "$TREATMENT_DIR/benchmark/scores.jsonl")"
B_LABEL_SQL="$(sql_quote "$BASELINE_LABEL")"
T_LABEL_SQL="$(sql_quote "$TREATMENT_LABEL")"

# Quick duckdb sanity check.
if ! "$RUNNER_BIN" query "$ANCHOR_DIR" "select 1 as ok" >/dev/null 2>&1; then
  echo "lab-cli DuckDB query failed on anchor run: $ANCHOR_DIR" >&2
  echo "If needed, rebuild with: CXXFLAGS='-Wno-missing-template-arg-list-after-template-kw' cargo build -p lab-cli --release --features lab-analysis/duckdb_engine" >&2
  exit 1
fi

echo "# A/B DuckDB Analysis"
echo "baseline:  $BASELINE_RUN_ID ($BASELINE_LABEL)"
echo "treatment: $TREATMENT_RUN_ID ($TREATMENT_LABEL)"
echo "anchor:    $ANCHOR_DIR"
echo

echo "## Metrics Aggregate (from result.json)"
run_query "
with baseline as (
  select '${B_LABEL_SQL}' as variant,
         metrics.success::double as success,
         metrics.latency_ms::double as latency_ms,
         metrics.total_tokens::double as total_tokens
  from read_json_auto('${B_RESULTS_GLOB}', union_by_name=true)
), treatment as (
  select '${T_LABEL_SQL}' as variant,
         metrics.success::double as success,
         metrics.latency_ms::double as latency_ms,
         metrics.total_tokens::double as total_tokens
  from read_json_auto('${T_RESULTS_GLOB}', union_by_name=true)
), combined as (
  select * from baseline
  union all
  select * from treatment
)
select variant,
       count(*) as n,
       round(avg(success), 4) as success_rate,
       round(avg(latency_ms), 2) as avg_latency_ms,
       round(quantile_cont(latency_ms, 0.5), 2) as p50_latency_ms,
       round(avg(total_tokens), 2) as avg_total_tokens
from combined
group by 1
order by 1
"
echo

if [[ -f "$BASELINE_DIR/benchmark/scores.jsonl" || -f "$TREATMENT_DIR/benchmark/scores.jsonl" ]]; then
  BENCH_COMBINED_SQL=""
  if [[ -f "$BASELINE_DIR/benchmark/scores.jsonl" ]]; then
    BENCH_COMBINED_SQL="select '${B_LABEL_SQL}' as variant, verdict, primary_metric_value::double as primary_metric_value from read_json_auto('${B_BENCHMARK_SCORES}', union_by_name=true)"
  fi
  if [[ -f "$TREATMENT_DIR/benchmark/scores.jsonl" ]]; then
    if [[ -n "$BENCH_COMBINED_SQL" ]]; then
      BENCH_COMBINED_SQL="$BENCH_COMBINED_SQL union all "
    fi
    BENCH_COMBINED_SQL="$BENCH_COMBINED_SQL select '${T_LABEL_SQL}' as variant, verdict, primary_metric_value::double as primary_metric_value from read_json_auto('${T_BENCHMARK_SCORES}', union_by_name=true)"
  fi

  echo "## Benchmark Aggregate (from benchmark/scores.jsonl)"
  run_query "
with combined as (
  ${BENCH_COMBINED_SQL}
)
select variant,
       count(*) as n,
       round(avg(case when verdict = 'pass' then 1.0 else 0.0 end), 4) as pass_rate,
       round(avg(primary_metric_value), 4) as avg_primary_metric,
       sum(case when verdict = 'missing' then 1 else 0 end) as missing_n,
       sum(case when verdict = 'error' then 1 else 0 end) as error_n
from combined
group by 1
order by 1
"
  echo
else
  echo "## Benchmark Aggregate (from benchmark/scores.jsonl)"
  echo "benchmark scores not found in either run directory."
  echo
fi

echo "## Trial Status Counts (from trial_state.json)"
run_query "
with baseline_state as (
  select '${B_LABEL_SQL}' as variant,
         status,
         coalesce(exit_reason, '') as exit_reason
  from read_json_auto('${B_STATE_GLOB}', union_by_name=true)
), treatment_state as (
  select '${T_LABEL_SQL}' as variant,
         status,
         coalesce(exit_reason, '') as exit_reason
  from read_json_auto('${T_STATE_GLOB}', union_by_name=true)
), combined as (
  select * from baseline_state
  union all
  select * from treatment_state
)
select variant, status, exit_reason, count(*) as n
from combined
group by 1, 2, 3
order by 1, 2, 3
"
echo

echo "## Per-Trial Reconciliation (status vs metrics.success)"
run_query "
with baseline_results as (
  select '${B_LABEL_SQL}' as variant,
         regexp_extract(filename, 'trial_[0-9]+') as trial_id,
         try_cast(json_extract(to_json(metrics), '$.success') AS double) as metric_success,
         json_extract_string(to_json(metrics), '$.status_code') as status_code,
         try_cast(json_extract(to_json(metrics), '$.latency_ms') AS double) as latency_ms,
         try_cast(json_extract(to_json(metrics), '$.total_tokens') AS double) as total_tokens
  from read_json_auto('${B_RESULTS_GLOB}', union_by_name=true, filename=true)
), treatment_results as (
  select '${T_LABEL_SQL}' as variant,
         regexp_extract(filename, 'trial_[0-9]+') as trial_id,
         try_cast(json_extract(to_json(metrics), '$.success') AS double) as metric_success,
         json_extract_string(to_json(metrics), '$.status_code') as status_code,
         try_cast(json_extract(to_json(metrics), '$.latency_ms') AS double) as latency_ms,
         try_cast(json_extract(to_json(metrics), '$.total_tokens') AS double) as total_tokens
  from read_json_auto('${T_RESULTS_GLOB}', union_by_name=true, filename=true)
), baseline_state as (
  select '${B_LABEL_SQL}' as variant,
         trial_id,
         status,
         coalesce(exit_reason, '') as exit_reason
  from read_json_auto('${B_STATE_GLOB}', union_by_name=true)
), treatment_state as (
  select '${T_LABEL_SQL}' as variant,
         trial_id,
         status,
         coalesce(exit_reason, '') as exit_reason
  from read_json_auto('${T_STATE_GLOB}', union_by_name=true)
), results_union as (
  select * from baseline_results
  union all
  select * from treatment_results
), state_union as (
  select * from baseline_state
  union all
  select * from treatment_state
)
select s.variant,
       s.trial_id,
       s.status,
       s.exit_reason,
       r.metric_success,
       r.status_code,
       r.latency_ms,
       r.total_tokens
from state_union s
left join results_union r
  on r.variant = s.variant and r.trial_id = s.trial_id
order by s.variant, s.trial_id
"
