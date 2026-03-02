# Postmortem: `run_20260302_204623` Grader Schema And Scoring Failure

Date: 2026-03-02  
Run ID: `run_20260302_204623`  
Status: Closed with immediate mitigation, follow-up hardening required

## Summary

The run completed with 40/40 trials marked as grading errors (`score_record_invalid`), while view aggregation still showed `glm_5` at `35%` success. This produced contradictory output: benchmark scoring failed, but variant summary looked partially successful.

The failure came from a broken grader adapter contract:

1. The staged grader output did not satisfy `benchmark_score_record_v1` schema requirements.
2. The grader used agent self-reported `outcome` as score (`resolved`) instead of running benchmark evaluation commands.

## Impact

- Benchmark score records were rejected for every trial.
- `benchmark/scores.jsonl` remained empty.
- `benchmark/summary.json` reported zero scored trials.
- Dashboard/view consumers could still interpret trial-level `success` as primary metric, showing misleading non-zero performance (`0.35` for `glm_5`).
- Confidence in run correctness was invalidated.

## Timeline (UTC)

- `2026-03-02T20:46:23.357035+00:00`: Run created (`manifest.json`).
- `2026-03-02T20:46:29.579754+00:00`: Run manifest written (`facts/run_manifest.json`).
- `2026-03-02T20:57:39.116036+00:00`: All 40 schedule slots committed as `failed` (`runtime/schedule_progress.json`).
- `2026-03-02T20:57:39.176441+00:00`: Run marked `completed` (`runtime/run_control.json`).
- Post-run analysis: `grade_error=true` for all trials with identical schema failure class.

## What Happened

For every trial, `out/benchmark_score.json` was written by `.lab/experiments/bench_benchmark_adapter_standalone.py` without required top-level identity fields:

- `schedule_idx`
- `slot_commit_id`
- `attempt`
- `row_seq`

The runner validates the score record against `benchmark_score_record_v1.jsonschema` before row annotation/commit and rejected all score rows.

At the same time, trial records retained `primary_metric_name=success` and `primary_metric_value` from execution outcome, so `variant_summary` displayed non-zero success rate despite total grading failure.

## Root Cause

1. Contract mismatch between grader output and required score schema.
2. Grader implementation scored from agent `result.outcome` instead of benchmark commands (`hidden_command` / `public_command`), making grading behavior non-benchmark and vulnerable to misleading outputs.

## Contributing Factors

1. Wrapper preflight (`scripts/run-bench-experiment.sh preflight`) checks infra readiness only; it does not execute a grading contract/schema smoke test.
2. Native `lab-cli preflight` currently does not run a synthetic adapter output schema check for this contract path.
3. View layer can still show non-zero `primary_metric_mean` from trial-level success when benchmark score stream is empty.

## Detection Gaps

1. No fail-fast gate on "all score rows invalid/missing" before declaring run success semantics in views.
2. No mandatory check that `scores.jsonl` row count matches committed trial count for graded benchmark runs.

## Immediate Mitigation Implemented

Added tracked grader at `benchmark/grader/bench_benchmark_adapter.py` and wired runtime to execute grader from task image path `/opt/bench/bench_benchmark_adapter.py`.

Implemented scorer behavior in grader to:

1. Emit schema-valid `benchmark_prediction_record_v1` and `benchmark_score_record_v1` fields, including identity keys required by schema.
2. Compute score by executing benchmark commands in workspace:
   - `public_command` (if present)
   - `hidden_command` (required for resolved pass/fail)
3. Set `resolved=1.0` only when required command checks pass.
4. Emit explicit failure labels (`hidden_command_failed`, `hidden_command_timeout`, etc.) and command diagnostics in `ext.bench`.
5. Stop using agent self-reported `outcome` as the benchmark score.

Also implemented wrapper hardening in `scripts/run-bench-experiment.sh`:

1. Preflight now runs a benchmark adapter smoke test that:
   - executes grader against fixtures
   - asserts required score identity fields are present
   - asserts score follows command outcomes (not agent self-report)
2. `run`/`describe` now rewrite experiment command paths to task-image grader (`/opt/bench/bench_benchmark_adapter.py`).
3. Task-image build now copies tracked grader into image (`build-task-images`).

## Corrective Actions (Follow-up)

1. Add run-finalization invariant:
   - for graded runs, fail run status or mark run invalid when score rows are missing/invalid for committed slots
2. Update view logic/invariants:
   - if graded run has zero valid score rows, do not surface trial `success` as benchmark metric
3. Add automated regression test for this exact failure mode (missing score identity keys + fallback to self-reported success).

## Evidence

- `facts/metrics_long.jsonl`: `grade_error=true` for all 40 trials, reason `score_record_invalid`.
- `benchmark/scores.jsonl`: 0 rows.
- `benchmark/summary.json`: `trials=0`.
- `facts/trials.jsonl`: `primary_metric_name=success`, yielding `glm_5` mean `0.35`.
- `runtime/schedule_progress.json`: all committed slots marked `failed`.
