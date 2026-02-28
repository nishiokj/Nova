#!/usr/bin/env python3
"""Bench v0 grader for AgentLab benchmark protocol.

Bridges the AgentLab per-trial grading protocol to the bench grading pipeline
in the Experiments repo (installed as the `bench` package in the container).

Reads the agent's patch from $WORKSPACE/patch.diff, delegates to
bench.runner.grader_runner.grade_task(), and writes benchmark_prediction_record_v1
+ benchmark_score_record_v1 to the paths required by AgentLab.

Follows the swebench_task_container_grader.py protocol pattern, delegates to
grade_task() like Experiments/scripts/bench/bench_benchmark_adapter.py does.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bench.config import BenchConfig
from bench.runner.grader_runner import grade_task

ADAPTER_ID = "bench_v0"
ADAPTER_VERSION = "v1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required env var: {name}")
    return value


def _env_int(name: str, fallback: int = 0) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return fallback
    try:
        return int(raw)
    except ValueError:
        return fallback


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        value = json.load(f)
    if not isinstance(value, dict):
        raise RuntimeError(f"expected JSON object at {path}")
    return value


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=True)
        f.write("\n")


def _ids(task_payload: dict[str, Any]) -> dict[str, Any]:
    task = task_payload.get("task", task_payload)
    task_id = task.get("id", "task_unknown")
    return {
        "run_id": os.environ.get("AGENTLAB_RUN_ID", "run_unknown"),
        "trial_id": os.environ.get("AGENTLAB_TRIAL_ID", "trial_unknown"),
        "variant_id": os.environ.get("AGENTLAB_VARIANT_ID", "variant_unknown"),
        "task_id": os.environ.get("AGENTLAB_TASK_ID", task_id),
        "repl_idx": _env_int("AGENTLAB_REPL_IDX", 0),
    }


def _resolve_task_dir(task_payload: dict[str, Any], bench_root: Path) -> Path:
    """Resolve the bench task directory from the AgentLab task payload."""
    task = task_payload.get("task", task_payload)

    # Direct task_dir field.
    direct = task.get("task_dir")
    if isinstance(direct, str) and direct.strip():
        p = Path(direct.strip())
        return p if p.is_absolute() else bench_root / p

    # Nested under task.bench.task_dir.
    bench = task.get("bench")
    if isinstance(bench, dict):
        nested = bench.get("task_dir")
        if isinstance(nested, str) and nested.strip():
            p = Path(nested.strip())
            return p if p.is_absolute() else bench_root / p
        suite = bench.get("suite", "v0")
        if isinstance(suite, str) and suite.strip():
            task_id = task.get("id", "")
            return bench_root / "tasks" / suite.strip() / task_id

    # Fallback: tasks/v0/<task_id>.
    task_id = task.get("id", "")
    return bench_root / "tasks" / "v0" / task_id


def _read_patch(workspace: Path, result_path: Path | None) -> str | None:
    """Read the agent's patch. Prefer $WORKSPACE/patch.diff, fall back to result JSON."""
    # Primary: written by v0_workspace_setup_and_run.sh step 6.
    patch_file = workspace / "patch.diff"
    if patch_file.exists():
        text = patch_file.read_text(encoding="utf-8", errors="replace")
        if text.strip():
            return text

    # Fallback: extract from agent result JSON.
    if result_path and result_path.exists():
        try:
            result = _read_json(result_path)
        except Exception:
            return None
        answer = result.get("answer")
        if isinstance(answer, dict):
            candidate = answer.get("patch")
            if isinstance(candidate, str) and candidate.strip():
                return candidate
        elif isinstance(answer, str) and answer.strip():
            return answer

    return None


def _seed_agent_summary(run_dir: Path, task_id: str, task_dir: Path, patch_text: str | None) -> None:
    """Create the agent_run_summary.json that grade_task() expects."""
    summary = {
        "run_id": os.environ.get("AGENTLAB_TRIAL_ID", f"trial_{task_id}"),
        "task_id": task_id,
        "agent_command": ["agentlab", "v0_workspace_setup_and_run.sh"],
        "exit_code": _env_int("AGENTLAB_AGENT_EXIT_STATUS", 0),
        "wall_clock_s": 0.0,
        "timed_out": False,
        "failure_label": None,
        "has_patch": patch_text is not None,
        "has_trace": False,
        "task_dir": str(task_dir),
        "strict": True,
    }
    (run_dir / "agent_run_summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8"
    )


def _verdict_from_score(score: dict[str, Any] | None) -> str:
    if not isinstance(score, dict):
        return "error"
    if score.get("overall_pass") is True:
        return "pass"
    if score.get("failure_label") == "NO_PATCH":
        return "missing"
    return "fail"


def _benchmark_info() -> dict[str, str]:
    return {
        "adapter_id": ADAPTER_ID,
        "name": os.environ.get("BENCH_BENCHMARK_NAME", "bench"),
        "split": os.environ.get("BENCH_BENCHMARK_SPLIT", "test"),
    }


def main() -> int:
    task_path = Path(_required_env("AGENTLAB_TASK_PATH"))
    prediction_path = Path(_required_env("AGENTLAB_BENCHMARK_PREDICTION_PATH"))
    score_path = Path(_required_env("AGENTLAB_BENCHMARK_SCORE_PATH"))

    result_path_raw = os.environ.get("AGENTLAB_RESULT_PATH", "").strip()
    result_path = Path(result_path_raw) if result_path_raw else None

    workspace = Path(os.environ.get("WORKSPACE", "/workspace")).resolve()
    bench_root = Path(os.environ.get("BENCH_ROOT", "/opt/bench")).resolve()

    task_payload = _read_json(task_path)
    ids = _ids(task_payload)
    task = task_payload.get("task", task_payload)
    task_id = task.get("id", "task_unknown")
    task_dir = _resolve_task_dir(task_payload, bench_root)
    benchmark = _benchmark_info()

    patch_text = _read_patch(workspace, result_path)

    # ── Grade via bench pipeline ─────────────────────────────────────────────
    score: dict[str, Any] | None = None
    grade_error: str | None = None

    if not task_dir.exists():
        grade_error = f"task directory not found: {task_dir}"
    else:
        cfg = BenchConfig.from_root(bench_root)
        with tempfile.TemporaryDirectory(prefix=f"agentlab_bench_grade_{task_id}_") as tmp:
            run_dir = Path(tmp)
            _seed_agent_summary(run_dir, task_id, task_dir, patch_text)
            if patch_text is not None:
                (run_dir / "patch.diff").write_text(patch_text, encoding="utf-8")
            try:
                score = grade_task(run_dir=run_dir, task_dir=task_dir, config=cfg)
            except Exception as exc:
                grade_error = str(exc)

    # ── Build prediction record ──────────────────────────────────────────────
    prediction: dict[str, Any] = {
        "schema_version": "benchmark_prediction_record_v1",
        "ts": _now_iso(),
        "ids": ids,
        "benchmark": benchmark,
        "prediction": {
            "kind": "patch",
            "value": patch_text or "",
        },
        "metrics": {
            "has_patch": 1.0 if patch_text else 0.0,
            "patch_bytes": len((patch_text or "").encode("utf-8")),
        },
        "ext": {
            "bench": {
                "task_id": task_id,
                "task_dir": str(task_dir),
            }
        },
    }

    # ── Build score record ───────────────────────────────────────────────────
    verdict = _verdict_from_score(score)
    resolved = 1.0 if verdict == "pass" else 0.0

    metrics: dict[str, Any] = {"resolved": resolved, "has_patch": 1.0 if patch_text else 0.0}
    if isinstance(score, dict):
        metrics["public_pass"] = bool(score.get("public_pass", False))
        metrics["hidden_pass"] = bool(score.get("hidden_pass", False))
        metrics["policy_pass"] = bool(score.get("policy_pass", False))
        failure_label = score.get("failure_label")
        if isinstance(failure_label, str):
            metrics["failure_label"] = failure_label
        raw_metrics = score.get("metrics")
        if isinstance(raw_metrics, dict):
            for key in ("hidden_cases_total", "hidden_cases_passed"):
                val = raw_metrics.get(key)
                if isinstance(val, int):
                    metrics[key] = float(val)

    agent_exit_status = _env_int("AGENTLAB_AGENT_EXIT_STATUS", -1)
    if agent_exit_status >= 0:
        metrics["agent_exit_status"] = float(agent_exit_status)

    score_record: dict[str, Any] = {
        "schema_version": "benchmark_score_record_v1",
        "ts": _now_iso(),
        "ids": ids,
        "benchmark": benchmark,
        "verdict": verdict,
        "primary_metric_name": "resolved",
        "primary_metric_value": resolved,
        "metrics": metrics,
        "evaluator": {
            "name": "bench_v0_grader",
            "mode": "custom",
            "version": ADAPTER_VERSION,
            "command": [sys.executable or "python3", *sys.argv],
        },
        "ext": {
            "bench": {
                "task_id": task_id,
                "failure_label": score.get("failure_label") if isinstance(score, dict) else None,
                "overall_pass": score.get("overall_pass") if isinstance(score, dict) else None,
            }
        },
    }

    if grade_error:
        score_record["error"] = {
            "error_type": "BENCH_GRADER_ERROR",
            "message": grade_error,
        }

    _write_json(prediction_path, prediction)
    _write_json(score_path, score_record)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        # Best-effort fallback so runner always gets a score row.
        prediction_out = os.environ.get("AGENTLAB_BENCHMARK_PREDICTION_PATH")
        score_out = os.environ.get("AGENTLAB_BENCHMARK_SCORE_PATH")
        ids = {
            "run_id": os.environ.get("AGENTLAB_RUN_ID", "unknown_run"),
            "trial_id": os.environ.get("AGENTLAB_TRIAL_ID", "unknown_trial"),
            "variant_id": os.environ.get("AGENTLAB_VARIANT_ID", "unknown_variant"),
            "task_id": os.environ.get("AGENTLAB_TASK_ID", "unknown_task"),
            "repl_idx": _env_int("AGENTLAB_REPL_IDX", 0),
        }
        benchmark = {"adapter_id": ADAPTER_ID, "name": "bench", "split": "test"}
        if prediction_out:
            _write_json(
                Path(prediction_out),
                {
                    "schema_version": "benchmark_prediction_record_v1",
                    "ts": _now_iso(),
                    "ids": ids,
                    "benchmark": benchmark,
                    "prediction": {"kind": "patch", "value": ""},
                    "metrics": {"has_patch": 0.0},
                },
            )
        if score_out:
            _write_json(
                Path(score_out),
                {
                    "schema_version": "benchmark_score_record_v1",
                    "ts": _now_iso(),
                    "ids": ids,
                    "benchmark": benchmark,
                    "verdict": "error",
                    "primary_metric_name": "resolved",
                    "primary_metric_value": 0.0,
                    "metrics": {"resolved": 0.0, "has_patch": 0.0},
                    "evaluator": {
                        "name": "bench_v0_grader",
                        "mode": "custom",
                        "command": [sys.executable or "python3", *sys.argv],
                    },
                    "error": {
                        "error_type": "grader_exception",
                        "message": str(exc),
                    },
                },
            )
        print(str(exc), file=sys.stderr)
        raise SystemExit(0)
