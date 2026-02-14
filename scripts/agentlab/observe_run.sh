#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUN_ID=""
ONCE=0
INTERVAL="${AGENTLAB_WATCH_INTERVAL:-2}"

usage() {
  cat <<'EOF'
Usage: observe_run.sh [options]

Options:
  --run-id <id>      Observe a specific run (e.g. run_20260214_051636)
  --latest           Observe latest run (default)
  --interval <sec>   Refresh interval in seconds (default: 2)
  --once             Print one snapshot and exit
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --latest)
      RUN_ID=""
      shift
      ;;
    --interval)
      INTERVAL="${2:-2}"
      shift 2
      ;;
    --once)
      ONCE=1
      shift
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

resolve_run_dir() {
  if [[ -n "${RUN_ID}" ]]; then
    echo "${ROOT_DIR}/.lab/runs/${RUN_ID}"
    return
  fi
  ls -1dt "${ROOT_DIR}"/.lab/runs/run_* 2>/dev/null | head -n 1 || true
}

print_trial_status_counts() {
  local run_dir="$1"
  local trials_dir="${run_dir}/trials"
  if [[ ! -d "${trials_dir}" ]]; then
    echo "trials: none"
    return
  fi

  mapfile -t state_files < <(find "${trials_dir}" -mindepth 2 -maxdepth 2 -name trial_state.json 2>/dev/null | sort -V)
  if [[ ${#state_files[@]} -eq 0 ]]; then
    echo "trials: no trial_state.json files yet"
    return
  fi

  echo "trials:"
  jq -r '.status // "unknown"' "${state_files[@]}" \
    | sort \
    | uniq -c \
    | awk '{printf "  - %s: %s\n", $2, $1}'
}

print_recent_trial_outputs() {
  local run_dir="$1"
  mapfile -t output_files < <(find "${run_dir}/trials" -mindepth 2 -maxdepth 2 -name trial_output.json 2>/dev/null | sort -V | tail -n 6)
  if [[ ${#output_files[@]} -eq 0 ]]; then
    echo "recent outputs: none"
    return
  fi
  echo "recent outputs:"
  for out in "${output_files[@]}"; do
    local trial
    trial="$(basename "$(dirname "${out}")")"
    local line
    line="$(jq -r '[.ids.variant_id // "-", .ids.task_id // "-", .outcome // "unknown", (.metrics.success // "null"), (.error.message // "")] | @tsv' "${out}")"
    local variant
    local task_id
    local outcome
    local success
    local err
    variant="$(printf '%s' "${line}" | cut -f1)"
    task_id="$(printf '%s' "${line}" | cut -f2)"
    outcome="$(printf '%s' "${line}" | cut -f3)"
    success="$(printf '%s' "${line}" | cut -f4)"
    err="$(printf '%s' "${line}" | cut -f5-)"
    if [[ -n "${err}" ]]; then
      printf '  - %s: variant=%s task=%s %s (success=%s) | %s\n' "${trial}" "${variant}" "${task_id}" "${outcome}" "${success}" "${err}"
    else
      printf '  - %s: variant=%s task=%s %s (success=%s)\n' "${trial}" "${variant}" "${task_id}" "${outcome}" "${success}"
    fi
  done
}

print_active_trial_details() {
  local run_dir="$1"
  local trial_id="$2"
  local trial_dir="${run_dir}/trials/${trial_id}"
  local trial_state="${trial_dir}/trial_state.json"
  local events="${trial_dir}/state/events.jsonl"
  local output="${trial_dir}/trial_output.json"
  local trial_meta="${trial_dir}/trial_metadata.json"
  local trial_input="${trial_dir}/trial_input.json"

  if [[ ! -d "${trial_dir}" ]]; then
    echo "active trial directory missing: ${trial_dir}"
    return
  fi

  echo
  echo "active trial: ${trial_id}"

  local variant_id="-"
  local task_id="-"
  local repl_idx="-"
  if [[ -f "${trial_meta}" ]]; then
    variant_id="$(jq -r '.ids.variant_id // "-"' "${trial_meta}")"
    task_id="$(jq -r '.ids.task_id // "-"' "${trial_meta}")"
    repl_idx="$(jq -r '.ids.repl_idx // "-"' "${trial_meta}")"
  fi

  local model_provider="-"
  local model_name="-"
  local reasoning="-"
  if [[ -f "${trial_input}" ]]; then
    model_provider="$(jq -r '.bindings.model_provider // "-"' "${trial_input}")"
    model_name="$(jq -r '.bindings.model // "-"' "${trial_input}")"
    reasoning="$(jq -r '.bindings.reasoning // "-"' "${trial_input}")"
  fi
  echo "identity: variant=${variant_id} task=${task_id} repl=${repl_idx} model=${model_provider}/${model_name} reasoning=${reasoning}"

  if [[ -f "${trial_state}" ]]; then
    jq -r '"state=" + (.status // "unknown")
      + (if .exit_reason then " | exit_reason=" + .exit_reason else "" end)
      + (if .updated_at then " | updated_at=" + .updated_at else "" end)' "${trial_state}"
  else
    echo "state file missing: ${trial_state}"
  fi

  if [[ -f "${events}" ]]; then
    local event_count
    event_count="$(wc -l < "${events}" | tr -d ' ')"
    echo "events: ${events} (${event_count} lines)"

    echo "last events:"
    tail -n 50 "${events}" \
      | jq -Rr '
        fromjson? | select(. != null) |
        [(.seq // "-"), (.event_type // "-"), (.outcome.status // "-"), ((.tool.name // .model.identity // "-"))] | @tsv
      ' \
      | tail -n 8 \
      | awk -F'\t' '{printf "  - seq=%s type=%s status=%s subject=%s\n", $1, $2, $3, $4}'

    echo "recent model calls:"
    tail -n 500 "${events}" \
      | jq -Rr '
        fromjson? | select(.event_type=="model_call_end") |
        [(.turn_index // "-"), (.model.identity // "-"), (.usage.tokens_in // 0), (.usage.tokens_out // 0), (.outcome.status // "-")] | @tsv
      ' \
      | tail -n 5 \
      | awk -F'\t' '{printf "  - turn=%s model=%s in=%s out=%s status=%s\n", $1, $2, $3, $4, $5}'

    echo "recent tool errors:"
    local tool_errs
    tool_errs="$(tail -n 1000 "${events}" \
      | jq -Rr '
        fromjson? | select(.event_type=="tool_call_end" and (.outcome.status // "ok") != "ok") |
        [(.seq // "-"), (.tool.name // "-"), (.outcome.status // "-")] | @tsv
      ' | tail -n 5 || true)"
    if [[ -n "${tool_errs}" ]]; then
      printf '%s\n' "${tool_errs}" | awk -F'\t' '{printf "  - seq=%s tool=%s status=%s\n", $1, $2, $3}'
    else
      echo "  - none"
    fi
  else
    echo "events missing: ${events}"
  fi

  if [[ -f "${output}" ]]; then
    echo "trial output:"
    jq -r '"  - outcome=" + (.outcome // "unknown")
      + " | success=" + ((.metrics.success // "null")|tostring)
      + (if .metrics.latency_ms then " | latency_ms=" + (.metrics.latency_ms|tostring) else "" end)
      + (if .error and .error.message then " | error=" + .error.message else "" end)' "${output}"
    local answer
    answer="$(jq -r '.answer // empty' "${output}" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c1-240)"
    if [[ -n "${answer}" ]]; then
      echo "  - answer preview: ${answer}"
    fi
  fi

  local hstderr="${trial_dir}/harness_stderr.log"
  if [[ -f "${hstderr}" ]]; then
    echo "harness stderr (tail):"
    tail -n 6 "${hstderr}" | sed 's/^/  /'
  fi
}

print_container_state() {
  local run_id="$1"
  echo
  echo "containers:"
  if ! command -v docker >/dev/null 2>&1; then
    echo "  - docker not found"
    return
  fi
  local lines
  lines="$(docker ps --format '{{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}' 2>/dev/null | rg "rex-harness|agentlab|${run_id}" || true)"
  if [[ -z "${lines}" ]]; then
    echo "  - none"
  else
    printf '%s\n' "${lines}" | awk -F'\t' '{printf "  - %s | %s | %s | %s\n", $1, $2, $3, $4}'
  fi
}

snapshot() {
  local run_dir
  run_dir="$(resolve_run_dir)"
  if [[ -z "${run_dir}" ]]; then
    echo "No runs found under ${ROOT_DIR}/.lab/runs"
    return 0
  fi
  if [[ ! -d "${run_dir}" ]]; then
    echo "Run not found: ${run_dir}"
    return 0
  fi

  local run_id
  run_id="$(basename "${run_dir}")"
  local control="${run_dir}/runtime/run_control.json"

  echo "timestamp: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "run: ${run_id}"
  echo "path: ${run_dir}"

  if [[ ! -f "${control}" ]]; then
    echo "missing run_control.json: ${control}"
    return 0
  fi

  local run_status active_trial updated_at
  run_status="$(jq -r '.status // "unknown"' "${control}")"
  active_trial="$(jq -r '.active_trial_id // ""' "${control}")"
  updated_at="$(jq -r '.updated_at // ""' "${control}")"
  echo "run_control: status=${run_status} active_trial=${active_trial:-none} updated_at=${updated_at:-n/a}"

  print_trial_status_counts "${run_dir}"
  print_recent_trial_outputs "${run_dir}"

  if [[ -n "${active_trial}" ]]; then
    print_active_trial_details "${run_dir}" "${active_trial}"
  fi
  print_container_state "${run_id}"
}

if [[ "${ONCE}" -eq 1 ]]; then
  snapshot
  exit 0
fi

while true; do
  clear
  snapshot
  sleep "${INTERVAL}"
done
