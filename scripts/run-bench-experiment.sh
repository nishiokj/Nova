#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Load .env if present (provides ZAI_CODER_API_KEY, etc.)
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    source "$PROJECT_ROOT/.env"
    set +a
fi
EXPERIMENTS_ROOT="/Users/jevinnishioka/Desktop/Experiments"
LAB_CLI="$EXPERIMENTS_ROOT/rust/target/release/lab-cli"
EXPERIMENT="$PROJECT_ROOT/.lab/experiments/bench_v0_glm5_vs_codex_spark.yaml"
BENCH_IMAGE="bench-v0-workspace:latest"
REPO_SNAPSHOT="$EXPERIMENTS_ROOT/bench/benchmark/repos/jesus/src.tar.zst"
TASKS_DIR="$EXPERIMENTS_ROOT/bench/benchmark/tasks/v0"

usage() {
    cat <<'EOF'
Usage: run-bench-experiment.sh <command> [options]

Commands:
  build-image       Build the bench-v0 base Docker workspace image
  build-task-images Build per-task images (base + injection patch + public files)
  repair-artifact   Build Linux-compatible artifact copy if current one is macOS
  export            Re-export bench v0 tasks to JSONL (v2, container mode)
  preflight         Validate artifact, images, env vars, staged files before run
  describe          Validate and show resolved experiment plan
  run               Execute the experiment (runs preflight first)
  scoreboard        Live scoreboard (auto-picks latest run)

Options:
  --json       Machine-readable output (describe, run)
  --limit N    Override task limit for run
  --max-concurrency N Override design.max_concurrency for run
  --timeout-ms N Override runtime.policy.timeout_ms for run
  --run-id ID  Explicit run ID for scoreboard
  --interval N Refresh interval for scoreboard (default 2s)
  --once       Print one scoreboard snapshot and exit
  --native     Use lab-cli's built-in scoreboard renderer
EOF
    exit 0
}

ensure_cli() {
    if [ ! -x "$LAB_CLI" ]; then
        echo "lab-cli not found at $LAB_CLI"
        echo "Build: cd $EXPERIMENTS_ROOT/rust && cargo build -p lab-cli --release"
        exit 1
    fi
}

ensure_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "docker CLI not found in PATH."
        echo "Install a Docker runtime (OrbStack, Docker Engine, etc.) and retry."
        return 1
    fi
    if ! docker info >/dev/null 2>&1; then
        echo "Docker daemon is not reachable."
        echo "Start your Docker runtime (OrbStack, Docker Engine, etc.) and retry."
        return 1
    fi
}

resolve_experiment_artifact() {
    local experiment_file="$1"
    local artifact
    artifact=$(grep '^\s*artifact:' "$experiment_file" 2>/dev/null | sed 's/.*artifact:\s*//' | xargs || true)
    if [ -z "$artifact" ]; then
        return 1
    fi
    if [[ "$artifact" != /* ]]; then
        artifact="$(dirname "$experiment_file")/$artifact"
    fi
    artifact=$(cd "$(dirname "$artifact")" && echo "$(pwd)/$(basename "$artifact")")
    echo "$artifact"
}

artifact_bun_file_info() {
    local artifact="$1"
    local bun_tmp
    bun_tmp=$(mktemp)
    if tar -xOf "$artifact" ./bin/bun >"$bun_tmp" 2>/dev/null; then
        file "$bun_tmp" 2>/dev/null || true
    fi
    rm -f "$bun_tmp"
}

artifact_needs_linux_repack() {
    local artifact="$1"
    local bun_info
    bun_info=$(artifact_bun_file_info "$artifact")
    [[ "$bun_info" == *"Mach-O"* ]]
}

linux_artifact_path_for() {
    local artifact="$1"
    if [[ "$artifact" == *.tar.gz ]]; then
        echo "${artifact%.tar.gz}.linux.tar.gz"
    else
        echo "${artifact}.linux"
    fi
}

build_linux_artifact_copy() {
    local source_artifact="$1"
    local target_artifact="$2"
    local source_dir source_name target_dir target_name
    source_dir=$(dirname "$source_artifact")
    source_name=$(basename "$source_artifact")
    target_dir=$(dirname "$target_artifact")
    target_name=$(basename "$target_artifact")
    mkdir -p "$target_dir"

    if ! docker run --rm \
        -v "$source_dir:/input:ro" \
        -v "$target_dir:/output" \
        oven/bun:1-debian \
        /bin/sh -lc "set -eu
work=\$(mktemp -d)
tar --warning=no-unknown-keyword -xzf \"/input/$source_name\" -C \"\$work\"
cp /usr/local/bin/bun \"\$work/bin/bun\"
chmod +x \"\$work/bin/bun\"
tar -czf \"/output/$target_name\" -C \"\$work\" .
rm -rf \"\$work\""; then
        echo "Failed to build Linux artifact: $target_artifact"
        return 1
    fi
}

ensure_linux_artifact_copy() {
    local source_artifact="$1"
    local target_artifact
    target_artifact=$(linux_artifact_path_for "$source_artifact")

    local rebuild=false
    if [ ! -f "$target_artifact" ]; then
        rebuild=true
    elif [ "$source_artifact" -nt "$target_artifact" ]; then
        rebuild=true
    else
        local target_info
        target_info=$(artifact_bun_file_info "$target_artifact")
        if [[ "$target_info" != *"ELF"* ]]; then
            rebuild=true
        fi
    fi

    if $rebuild; then
        ensure_docker || return 1
        echo "Building Linux-compatible artifact copy: $target_artifact" >&2
        build_linux_artifact_copy "$source_artifact" "$target_artifact" >&2
    fi

    echo "$target_artifact"
}

cmd_preflight() {
    local experiment_file="${1:-$EXPERIMENT}"
    local errors=0
    local dataset_abs=""

    echo "=== Preflight checks ==="

    # 1. lab-cli binary
    if [ -x "$LAB_CLI" ]; then
        echo "  [ok] lab-cli"
    else
        echo "  [FAIL] lab-cli not found: $LAB_CLI"
        errors=$((errors + 1))
    fi

    # 2. Experiment YAML
    if [ -f "$experiment_file" ]; then
        echo "  [ok] experiment YAML"
    else
        echo "  [FAIL] experiment YAML not found: $experiment_file"
        errors=$((errors + 1))
    fi

    # 3. Agent artifact (parse from YAML)
    local artifact
    artifact=$(resolve_experiment_artifact "$experiment_file" || true)
    if [ -z "$artifact" ]; then
        echo "  [FAIL] no artifact defined in experiment YAML"
        errors=$((errors + 1))
    else
        if [ -f "$artifact" ]; then
            local size
            size=$(du -h "$artifact" | cut -f1 | xargs)
            echo "  [ok] agent artifact: $artifact ($size)"
            local bun_info
            bun_info=$(artifact_bun_file_info "$artifact")
            if [[ "$bun_info" == *"Mach-O"* ]]; then
                echo "  [FAIL] agent artifact is macOS-only (Mach-O bun); benchmark containers are Linux"
                echo "         run: $0 repair-artifact"
                errors=$((errors + 1))
            elif [[ "$bun_info" == *"ELF"* ]]; then
                echo "  [ok] agent artifact runtime binary is Linux-compatible (ELF)"
            else
                echo "  [warn] could not verify artifact runtime binary format"
            fi
        else
            echo "  [FAIL] agent artifact not found: $artifact"
            errors=$((errors + 1))
        fi
    fi

    # 4. Dataset JSONL (parse from YAML)
    local dataset_path
    dataset_path=$(grep '^\s*path:' "$experiment_file" 2>/dev/null | head -1 | sed 's/.*path:\s*//' | xargs)
    if [ -n "$dataset_path" ]; then
        if [[ "$dataset_path" != /* ]]; then
            dataset_abs="$(dirname "$experiment_file")/$dataset_path"
        else
            dataset_abs="$dataset_path"
        fi
        if [ -f "$dataset_abs" ]; then
            local task_count
            task_count=$(wc -l < "$dataset_abs" | xargs)
            echo "  [ok] dataset JSONL: $task_count tasks"
        else
            echo "  [FAIL] dataset JSONL not found: $dataset_abs"
            errors=$((errors + 1))
        fi
    fi

    # 5. Per-task Docker images (check every image referenced in JSONL)
    if [ -f "$dataset_abs" ]; then
        if ensure_docker >/dev/null; then
            local missing_images=0
            while IFS= read -r image_name; do
                if ! docker image inspect "$image_name" &>/dev/null; then
                    echo "  [FAIL] Docker image missing: $image_name"
                    missing_images=$((missing_images + 1))
                fi
            done < <(python3 -c "
import json, sys
for line in open('$dataset_abs'):
    row = json.loads(line)
    img = row.get('task', {}).get('image', '')
    if img: print(img)
" 2>/dev/null | sort -u)

            if [ "$missing_images" -eq 0 ]; then
                echo "  [ok] all task Docker images present"
            else
                echo "  [FAIL] $missing_images task image(s) missing — run: $0 build-task-images"
                errors=$((errors + missing_images))
            fi
        else
            echo "  [FAIL] docker daemon unavailable; cannot verify task images"
            echo "         start Docker and re-run preflight"
            errors=$((errors + 1))
        fi
    fi

    # 6. Environment variables (parse env_from_host from YAML)
    local missing_env=0
    while IFS= read -r var; do
        var=$(echo "$var" | xargs | sed 's/^- //')
        [ -n "$var" ] || continue
        if [ -z "${!var:-}" ]; then
            echo "  [FAIL] env var not set: $var"
            missing_env=$((missing_env + 1))
        fi
    done < <(sed -n '/env_from_host:/,/^[^ ]/{ /^ *- /p }' "$experiment_file" 2>/dev/null)

    if [ "$missing_env" -eq 0 ]; then
        echo "  [ok] env vars"
    else
        errors=$((errors + missing_env))
    fi

    # 7. File staging sources
    while IFS= read -r staged_file; do
        staged_file=$(echo "$staged_file" | xargs)
        [ -n "$staged_file" ] || continue
        local required
        required=$(grep -A2 "$staged_file" "$experiment_file" | grep 'required:' | awk '{print $2}')
        if [ -f "$staged_file" ]; then
            echo "  [ok] staged file: $staged_file"
        elif [ "$required" = "true" ]; then
            echo "  [FAIL] required staged file missing: $staged_file"
            errors=$((errors + 1))
        else
            echo "  [warn] optional staged file missing: $staged_file"
        fi
    done < <(grep 'source_from_host:' "$experiment_file" 2>/dev/null | sed 's/.*source_from_host:\s*//')

    # 8. Benchmark adapter scripts (absolute paths referenced in YAML)
    while IFS= read -r script; do
        script=$(echo "$script" | xargs | sed 's/^- //')
        [[ "$script" == /* ]] || continue
        [[ "$script" == *.py || "$script" == *.sh ]] || continue
        if [[ "$script" == /agentlab/* || "$script" == /opt/* || "$script" == /workspace/* ]]; then
            echo "  [ok] adapter script (container path): $script"
            continue
        fi
        if [ -f "$script" ]; then
            echo "  [ok] adapter script: $script"
        else
            echo "  [FAIL] adapter script not found: $script"
            errors=$((errors + 1))
        fi
    done < <(grep -E '^\s+- /' "$experiment_file" 2>/dev/null || true)

    echo ""
    if [ "$errors" -eq 0 ]; then
        echo "All checks passed."
    else
        echo "$errors check(s) failed."
        return 1
    fi
}

cmd_repair_artifact() {
    local experiment_file="${1:-$EXPERIMENT}"
    local artifact
    artifact=$(resolve_experiment_artifact "$experiment_file" || true)
    if [ -z "$artifact" ]; then
        echo "No runtime.agent artifact found in: $experiment_file"
        exit 1
    fi
    if [ ! -f "$artifact" ]; then
        echo "Artifact not found: $artifact"
        exit 1
    fi

    local bun_info
    bun_info=$(artifact_bun_file_info "$artifact")
    if [[ "$bun_info" == *"ELF"* ]]; then
        echo "Artifact already Linux-compatible: $artifact"
        return 0
    fi
    if [[ "$bun_info" != *"Mach-O"* ]]; then
        echo "Could not identify artifact runtime binary format for: $artifact"
        return 1
    fi

    local linux_artifact
    linux_artifact=$(ensure_linux_artifact_copy "$artifact")
    echo "Linux-compatible artifact ready: $linux_artifact"
    echo "Run will automatically use this artifact copy."
}

cmd_build_image() {
    ensure_docker || exit 1

    if [ ! -f "$REPO_SNAPSHOT" ]; then
        echo "Repo snapshot not found: $REPO_SNAPSHOT"
        exit 1
    fi

    local ctx
    ctx=$(mktemp -d)
    trap "rm -rf '$ctx'" RETURN
    cp "$PROJECT_ROOT/.lab/docker/Dockerfile.bench-v0" "$ctx/Dockerfile"
    cp "$REPO_SNAPSHOT" "$ctx/src.tar.zst"

    echo "Building $BENCH_IMAGE ..."
    docker build -t "$BENCH_IMAGE" "$ctx"
    echo "Done: $BENCH_IMAGE"
}

cmd_build_task_images() {
    ensure_docker || exit 1

    # Verify base image exists
    if ! docker image inspect "$BENCH_IMAGE" &>/dev/null; then
        echo "Base image $BENCH_IMAGE not found. Run: $0 build-image"
        exit 1
    fi

    shopt -s nullglob
    local tasks=("$TASKS_DIR"/TASK*)
    shopt -u nullglob
    if [ ${#tasks[@]} -eq 0 ]; then
        echo "No tasks found in $TASKS_DIR"
        exit 1
    fi

    local built=0 failed=0
    for task_dir in "${tasks[@]}"; do
        [ -d "$task_dir" ] || continue
        local task_id
        task_id=$(basename "$task_dir")
        local task_id_lower
        task_id_lower=$(echo "$task_id" | tr '[:upper:]' '[:lower:]')
        local tag="bench-v0-workspace-${task_id_lower}:latest"

        echo "--- Building $tag ---"

        # Create a Dockerfile that layers on top of the base
        local ctx
        ctx=$(mktemp -d)
        trap "rm -rf '$ctx'" RETURN

        # Stage injection patch if present
        local has_patch=false
        if [ -f "$task_dir/injection.patch" ]; then
            cp "$task_dir/injection.patch" "$ctx/injection.patch"
            has_patch=true
        fi

        # Stage public files if present
        local has_public=false
        if [ -d "$task_dir/public" ] && [ "$(ls -A "$task_dir/public")" ]; then
            cp -r "$task_dir/public" "$ctx/public"
            has_public=true
        fi

        # Build the per-task Dockerfile
        {
            echo "FROM $BENCH_IMAGE"
            echo "WORKDIR /workspace"
            if $has_patch; then
                echo "COPY injection.patch /tmp/injection.patch"
                echo "RUN git apply /tmp/injection.patch && rm /tmp/injection.patch"
            fi
            if $has_public; then
                echo "COPY public/ .bench_public/"
            fi
            echo "RUN git add -A && git -c user.name=bench -c user.email=bench@bench commit -m 'task setup' --allow-empty"
        } > "$ctx/Dockerfile"

        if docker build -t "$tag" "$ctx" 2>&1; then
            echo "OK: $tag"
            built=$((built + 1))
        else
            echo "FAILED: $tag"
            failed=$((failed + 1))
        fi
        rm -rf "$ctx"
    done

    echo ""
    echo "Built: $built  Failed: $failed"
    [ "$failed" -eq 0 ] || exit 1
}

cmd_export() {
    cd "$EXPERIMENTS_ROOT"
    python3 -m bench.integration.agentlab.export_bench_suite_to_jsonl \
        --suite v0 \
        --image "$BENCH_IMAGE" \
        --workspace /workspace \
        --output "$PROJECT_ROOT/.lab/experiments/data/bench_v0.task_boundary_v2.jsonl" \
        "$@"
}

cmd_describe() {
    ensure_cli
    cd "$PROJECT_ROOT"
    "$LAB_CLI" describe "$EXPERIMENT" "$@"
}

cmd_run() {
    local limit=""
    local max_concurrency=""
    local timeout_ms=""
    local passthrough=()
    while [[ $# -gt 0 ]]; do
        case $1 in
            --limit)
                if [[ $# -lt 2 || -z "${2:-}" ]]; then
                    echo "--limit requires a value"
                    exit 1
                fi
                limit="$2"
                shift 2
                ;;
            --max-concurrency)
                if [[ $# -lt 2 || -z "${2:-}" ]]; then
                    echo "--max-concurrency requires a value"
                    exit 1
                fi
                max_concurrency="$2"
                shift 2
                ;;
            --timeout-ms)
                if [[ $# -lt 2 || -z "${2:-}" ]]; then
                    echo "--timeout-ms requires a value"
                    exit 1
                fi
                timeout_ms="$2"
                shift 2
                ;;
            *) passthrough+=("$1"); shift ;;
        esac
    done

    local run_experiment="$EXPERIMENT"
    local tmp_experiment=""
    local artifact
    artifact=$(resolve_experiment_artifact "$EXPERIMENT" || true)

    if [ -n "$artifact" ] && [ -f "$artifact" ] && artifact_needs_linux_repack "$artifact"; then
        local linux_artifact
        linux_artifact=$(ensure_linux_artifact_copy "$artifact")
        tmp_experiment=$(mktemp "${EXPERIMENT%.yaml}.tmp_XXXXXX.yaml")
        cp "$EXPERIMENT" "$tmp_experiment"
        sed -E "s|^    artifact: .*|    artifact: $linux_artifact|" "$tmp_experiment" >"${tmp_experiment}.next"
        mv "${tmp_experiment}.next" "$tmp_experiment"
        run_experiment="$tmp_experiment"
    fi

    if [ -n "$limit" ]; then
        if [ -z "$tmp_experiment" ]; then
            tmp_experiment=$(mktemp "${EXPERIMENT%.yaml}.tmp_XXXXXX.yaml")
            cp "$EXPERIMENT" "$tmp_experiment"
            run_experiment="$tmp_experiment"
        fi
        sed -E "s/^  limit: [0-9]+$/  limit: $limit/" "$run_experiment" >"${run_experiment}.next"
        mv "${run_experiment}.next" "$run_experiment"
    fi

    if [ -n "$max_concurrency" ]; then
        if [ -z "$tmp_experiment" ]; then
            tmp_experiment=$(mktemp "${EXPERIMENT%.yaml}.tmp_XXXXXX.yaml")
            cp "$EXPERIMENT" "$tmp_experiment"
            run_experiment="$tmp_experiment"
        fi
        sed -E "s/^  max_concurrency: [0-9]+$/  max_concurrency: $max_concurrency/" "$run_experiment" >"${run_experiment}.next"
        mv "${run_experiment}.next" "$run_experiment"
    fi

    if [ -n "$timeout_ms" ]; then
        if [ -z "$tmp_experiment" ]; then
            tmp_experiment=$(mktemp "${EXPERIMENT%.yaml}.tmp_XXXXXX.yaml")
            cp "$EXPERIMENT" "$tmp_experiment"
            run_experiment="$tmp_experiment"
        fi
        sed -E "s/^    timeout_ms: [0-9]+$/    timeout_ms: $timeout_ms/" "$run_experiment" >"${run_experiment}.next"
        mv "${run_experiment}.next" "$run_experiment"
    fi

    if [ -n "$tmp_experiment" ]; then
        trap "rm -f '$tmp_experiment'" EXIT
    fi

    cmd_preflight "$run_experiment" || exit 1
    echo ""
    cd "$PROJECT_ROOT"
    "$LAB_CLI" run "$run_experiment" "${passthrough[@]+"${passthrough[@]}"}"
}

cmd_scoreboard() {
    cd "$PROJECT_ROOT"

    local run_id="" interval=2 once=false native=false
    while [[ $# -gt 0 ]]; do
        case $1 in
            --run-id)
                if [[ $# -lt 2 || -z "${2:-}" ]]; then
                    echo "--run-id requires a value"
                    exit 1
                fi
                run_id="$2"
                shift 2
                ;;
            --interval)
                if [[ $# -lt 2 || -z "${2:-}" ]]; then
                    echo "--interval requires a value"
                    exit 1
                fi
                interval="$2"
                shift 2
                ;;
            --once)
                once=true
                shift
                ;;
            --native)
                native=true
                shift
                ;;
            *) echo "Unknown: $1"; exit 1 ;;
        esac
    done

    if [ -z "$run_id" ]; then
        run_id=$(ls -1t "$PROJECT_ROOT/.lab/runs/" 2>/dev/null | head -1)
        if [ -z "$run_id" ]; then
            echo "No runs found. Pass --run-id explicitly."
            exit 1
        fi
        echo "Using latest run: $run_id"
    fi

    if $native; then
        ensure_cli
        "$LAB_CLI" scoreboard "$run_id" --interval-seconds "$interval"
        return 0
    fi

    local run_dir="$PROJECT_ROOT/.lab/runs/$run_id"
    if [ ! -d "$run_dir" ]; then
        echo "Run directory not found: $run_dir"
        exit 1
    fi

    while true; do
        local now status updated active_count total_slots completed_slots next_idx
        now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        status=$(jq -r '.status // "unknown"' "$run_dir/runtime/run_control.json" 2>/dev/null || echo "unknown")
        updated=$(jq -r '.updated_at // "unknown"' "$run_dir/runtime/run_control.json" 2>/dev/null || echo "unknown")
        active_count=$(jq -r '(.active_trials | length) // 0' "$run_dir/runtime/run_control.json" 2>/dev/null || echo "0")
        total_slots=$(jq -r '.total_slots // 0' "$run_dir/runtime/schedule_progress.json" 2>/dev/null || echo "0")
        completed_slots=$(jq -r '(.completed_slots | length) // 0' "$run_dir/runtime/schedule_progress.json" 2>/dev/null || echo "0")
        next_idx=$(jq -r '.next_schedule_index // 0' "$run_dir/runtime/schedule_progress.json" 2>/dev/null || echo "0")

        echo "=== Bench Scoreboard ==="
        echo "snapshot_utc: $now"
        echo "run_id: $run_id"
        echo "status: $status"
        echo "updated_at: $updated"
        echo "progress: committed=$completed_slots / total=$total_slots (next_schedule_idx=$next_idx)"
        echo "active_trials: $active_count"
        if [ "$active_count" -gt 0 ]; then
            local stuck_with_result
            stuck_with_result=$(jq -r '.active_trials | keys[]?' "$run_dir/runtime/run_control.json" 2>/dev/null                 | while IFS= read -r tid; do
                    [ -n "$tid" ] || continue
                    if [ -f "$run_dir/trials/$tid/result.json" ] || [ -f "$run_dir/trials/$tid/out/result.json" ]; then
                        echo "$tid"
                    fi
                  done | wc -l | xargs)
            if [ "$stuck_with_result" -gt 0 ]; then
                echo "active_trials_with_result_files: $stuck_with_result (possible local-worker finalization issue)"
            fi
        fi

        echo ""
        echo "Variant Summary:"
        if [ -s "$run_dir/facts/trials.jsonl" ]; then
            jq -r '.variant_id + "\t" + (.outcome // "unknown")' "$run_dir/facts/trials.jsonl" 2>/dev/null \
                | awk -F'\t' '
                    {
                        v=$1; o=$2;
                        total[v] += 1;
                        if (o == "success") success[v] += 1;
                        if (o == "error" || o == "failed" || o == "aborted") failed[v] += 1;
                    }
                    END {
                        if (length(total) == 0) {
                            print "  (no committed trial rows yet)";
                        } else {
                            for (v in total) {
                                s = success[v] + 0;
                                f = failed[v] + 0;
                                printf "  %s: total=%d success=%d failed=%d\n", v, total[v], s, f;
                            }
                        }
                    }'
        else
            echo "  (no committed trial rows yet)"
        fi

        echo ""
        echo "Recent Trial Errors:"
        local found_error=false
        local trial_meta trial_dir trial_state_file result_file status_outcome result_outcome variant task msg
        while IFS= read -r trial_meta; do
            [ -n "$trial_meta" ] || continue
            trial_dir="$(dirname "$trial_meta")"
            trial_state_file="$trial_dir/trial_state.json"
            result_file="$trial_dir/result.json"
            [ -f "$result_file" ] || result_file="$trial_dir/out/result.json"

            status_outcome="unknown"
            if [ -f "$trial_state_file" ]; then
                status_outcome=$(jq -r '.status // "unknown"' "$trial_state_file" 2>/dev/null || echo "unknown")
            fi

            result_outcome=""
            if [ -f "$result_file" ]; then
                result_outcome=$(jq -r '.outcome // ""' "$result_file" 2>/dev/null || echo "")
            fi

            # Surface errors even when trial_state is stale "running" but result.json already says error.
            if [ "$status_outcome" != "failed" ] && [ "$result_outcome" != "error" ] && [ "$result_outcome" != "failed" ] && [ "$result_outcome" != "aborted" ]; then
                continue
            fi

            variant=$(jq -r '.ids.variant_id // "unknown_variant"' "$trial_meta" 2>/dev/null || echo "unknown_variant")
            task=$(jq -r '.ids.task_id // "unknown_task"' "$trial_meta" 2>/dev/null || echo "unknown_task")

            if [ -f "$result_file" ]; then
                msg=$(jq -r '.error.message // .message // empty' "$result_file" 2>/dev/null || true)
            else
                msg=""
            fi

            if [ -z "$msg" ]; then
                local stderr_file
                stderr_file="$trial_dir/harness_stderr.log"
                if [ -f "$stderr_file" ]; then
                    msg=$(tail -n 40 "$stderr_file" | rg -m1 'Fatal error|error:|Exception|Traceback|Codex API error|No configuration file found' -N || true)
                fi
            fi

            if [ -z "$msg" ]; then
                msg="no explicit error message found"
            fi

            echo "  $(basename "$trial_dir"): variant=$variant task=$task status=$status_outcome result=$result_outcome -> $msg"
            found_error=true
        done < <(ls -1 "$run_dir"/trials/trial_*/trial_metadata.json 2>/dev/null | sort -V | tail -n 12)

        if ! $found_error; then
            echo "  (no trial errors detected yet)"
        fi

        if $once || [[ "$status" == "completed" || "$status" == "failed" || "$status" == "preflight_failed" ]]; then
            break
        fi

        echo ""
        echo "refreshing in ${interval}s (Ctrl-C to stop)"
        sleep "$interval"
        echo ""
    done
}

case "${1:-help}" in
    build-image)       shift; cmd_build_image "$@" ;;
    build-task-images) shift; cmd_build_task_images "$@" ;;
    repair-artifact)   shift; cmd_repair_artifact "$@" ;;
    export)            shift; cmd_export "$@" ;;
    preflight)         shift; cmd_preflight "$@" ;;
    describe)    shift; cmd_describe "$@" ;;
    run)         shift; cmd_run "$@" ;;
    scoreboard)  shift; cmd_scoreboard "$@" ;;
    help|--help|-h) usage ;;
    *) echo "Unknown command: $1"; usage ;;
esac
