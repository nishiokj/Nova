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
  --run-id ID  Explicit run ID for scoreboard
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
        /bin/sh -lc "set -euo pipefail
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
        echo "Building Linux-compatible artifact copy: $target_artifact" >&2
        build_linux_artifact_copy "$source_artifact" "$target_artifact" >&2
    fi

    echo "$target_artifact"
}

cmd_preflight() {
    local experiment_file="${1:-$EXPERIMENT}"
    local errors=0

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
        local dataset_abs
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
    fi

    # 6. Environment variables (parse env_from_host from YAML)
    local missing_env=0
    while IFS= read -r var; do
        var=$(echo "$var" | xargs | sed 's/^- //')
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
    # Verify base image exists
    if ! docker image inspect "$BENCH_IMAGE" &>/dev/null; then
        echo "Base image $BENCH_IMAGE not found. Run: $0 build-image"
        exit 1
    fi

    local tasks=("$TASKS_DIR"/TASK*)
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
    local passthrough=()
    while [[ $# -gt 0 ]]; do
        case $1 in
            --limit) limit="$2"; shift 2 ;;
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

    if [ -n "$tmp_experiment" ]; then
        trap "rm -f '$tmp_experiment'" EXIT
    fi

    cmd_preflight "$run_experiment" || exit 1
    echo ""
    cd "$PROJECT_ROOT"
    "$LAB_CLI" run "$run_experiment" "${passthrough[@]+"${passthrough[@]}"}"
}

cmd_scoreboard() {
    ensure_cli
    cd "$PROJECT_ROOT"

    local run_id="" interval=2
    while [[ $# -gt 0 ]]; do
        case $1 in
            --run-id) run_id="$2"; shift 2 ;;
            --interval) interval="$2"; shift 2 ;;
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

    "$LAB_CLI" scoreboard "$run_id" --interval-seconds "$interval"
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
