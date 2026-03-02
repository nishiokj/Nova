#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXPERIMENTS_ROOT="/Users/jevinnishioka/Desktop/Experiments"
LAB_CLI="$EXPERIMENTS_ROOT/rust/target/release/lab-cli"
EXPERIMENT="$PROJECT_ROOT/.lab/experiments/bench_v0_glm5_vs_codex_spark.yaml"
BENCH_IMAGE="bench-v0-workspace:latest"
REPO_SNAPSHOT="$EXPERIMENTS_ROOT/bench/benchmark/repos/jesus/src.tar.zst"

usage() {
    cat <<'EOF'
Usage: run-bench-experiment.sh <command> [options]

Commands:
  build-image  Build the bench-v0 Docker workspace image
  export       Re-export bench v0 tasks to JSONL (v2, container mode)
  describe     Validate and show resolved experiment plan
  run          Execute the experiment
  scoreboard   Live scoreboard (auto-picks latest run)

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
    build-image) shift; cmd_build_image "$@" ;;
    export)      shift; cmd_export "$@" ;;
    describe)    shift; cmd_describe "$@" ;;
    run)         shift; cmd_run "$@" ;;
    scoreboard)  shift; cmd_scoreboard "$@" ;;
    help|--help|-h) usage ;;
    *) echo "Unknown command: $1"; usage ;;
esac
