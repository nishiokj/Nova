# AgentLab Script Map

This folder now uses a role-based layout.

## Folder Layout

- `entrypoints (top-level)`
  - `run_curated_experiment.sh` — SWE-bench Lite curated (per-task images)
  - `run_v0_experiment.sh` — bench v0 (global image)
- `data/`
  - `benchmark_profiles.mjs`
  - `build_swebench_curated_ab_experiment.mjs`
  - `build_bench_v0_ab_experiment.mjs`
  - `enrich_dataset_v2.mjs`
- `docker/`
  - `bench-v0.Dockerfile` — bench v0 container (Experiments repo as build context)
- `runtime/`
  - `freeze_agent.sh`
  - `v0_workspace_setup_and_run.sh` — per-trial workspace setup + agent run for bench v0
- `graders/`
  - `swebench_task_container_grader.py`
  - `bench_v0_grader.py` — bench v0 grading via bench.runner.grader_runner.grade_task()
- `ops/`
  - `show_latest_scoreboard.sh`
  - `analyze_ab_duckdb.sh`
- `legacy/`
  - `build_task_images.sh`

## Active Run Commands

- Curated SWE-bench Lite:
  - `bash scripts/agentlab/run_curated_experiment.sh`
- Bench v0:
  - `bash scripts/agentlab/run_v0_experiment.sh`

## Script Ownership

| Script | Benchmark / Scope | Called By |
|---|---|---|
| `run_curated_experiment.sh` | SWE-bench Lite curated | user entrypoint |
| `run_v0_experiment.sh` | bench v0 | user entrypoint |
| `data/enrich_dataset_v2.mjs` | curated dataset v1 -> v2 (`task.image`) | curated runner |
| `data/build_swebench_curated_ab_experiment.mjs` | curated experiment YAML rebuild | curated runner |
| `data/build_bench_v0_ab_experiment.mjs` | bench v0 experiment YAML rebuild | v0 runner |
| `docker/bench-v0.Dockerfile` | bench v0 container image | v0 runner |
| `runtime/freeze_agent.sh` | runtime artifact pack | curated/v0 runner |
| `runtime/v0_workspace_setup_and_run.sh` | per-trial workspace + agent | v0 experiment YAML |
| `graders/swebench_task_container_grader.py` | curated benchmark grading | curated experiment YAML |
| `graders/bench_v0_grader.py` | bench v0 grading (grade_task) | v0 experiment YAML |
| `ops/show_latest_scoreboard.sh` | scoreboard helper | manual |
| `ops/analyze_ab_duckdb.sh` | post-run analysis helper | manual |
| `legacy/build_task_images.sh` | manual SWE-bench image prebuild utility | not auto-called |

## Legacy Note

`legacy/build_task_images.sh` is curated SWE-bench specific and is intentionally not part of the default run path.
