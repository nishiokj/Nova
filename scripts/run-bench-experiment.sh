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
  export            Re-export bench v0 tasks to JSONL (v2, container mode)
  describe          Validate and show resolved experiment plan
  run               Execute the experiment
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
    ensure_cli
    cd "$PROJECT_ROOT"

    local limit=""
    local passthrough=()
    while [[ $# -gt 0 ]]; do
        case $1 in
            --limit) limit="$2"; shift 2 ;;
            *) passthrough+=("$1"); shift ;;
        esac
    done

    if [ -n "$limit" ]; then
        tmp=$(mktemp "${EXPERIMENT%.yaml}.tmp_XXXXXX.yaml")
        trap "rm -f '$tmp'" EXIT
        sed "s/^  limit: 20$/  limit: $limit/" "$EXPERIMENT" > "$tmp"
        "$LAB_CLI" run "$tmp" "${passthrough[@]+"${passthrough[@]}"}"
    else
        "$LAB_CLI" run "$EXPERIMENT" "${passthrough[@]+"${passthrough[@]}"}"
    fi
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
    export)            shift; cmd_export "$@" ;;
    describe)    shift; cmd_describe "$@" ;;
    run)         shift; cmd_run "$@" ;;
    scoreboard)  shift; cmd_scoreboard "$@" ;;
    help|--help|-h) usage ;;
    *) echo "Unknown command: $1"; usage ;;
esac
