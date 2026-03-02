#!/usr/bin/env python3
"""Standalone bench adapter for AgentLab benchmark protocol v1.

This adapter intentionally avoids external Python package imports so it can run
inside benchmark task images without extra dependency staging.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_LOG_CHARS = 4000


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required env var: {name}")
    return value


def _env_int(name: str, default: int, minimum: int | None = None) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    if minimum is not None and value < minimum:
        return default
    return value


def _read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write_json(path: str | Path, payload: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def _task_payload(raw: Any) -> Any:
    if isinstance(raw, dict) and isinstance(raw.get("task"), dict):
        return raw.get("task")
    return raw


def _task_id(task_payload: Any) -> str:
    if isinstance(task_payload, dict):
        candidate = task_payload.get("id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return "task_unknown"


def _trial_id() -> str:
    return os.environ.get("AGENTLAB_TRIAL_ID", "trial_unknown")


def _derive_schedule_idx(trial_id: str) -> int:
    match = re.fullmatch(r"trial_(\d+)", trial_id.strip())
    if not match:
        return 0
    value = int(match.group(1)) - 1
    return value if value >= 0 else 0


def _row_identity() -> dict[str, Any]:
    trial_id = _trial_id()
    schedule_idx = _env_int(
        "AGENTLAB_SCHEDULE_IDX", default=_derive_schedule_idx(trial_id), minimum=0
    )
    slot_commit_id = os.environ.get("AGENTLAB_SLOT_COMMIT_ID", "").strip()
    if not slot_commit_id:
        slot_commit_id = f"slot_pending_{trial_id}"
    return {
        "schedule_idx": schedule_idx,
        "slot_commit_id": slot_commit_id,
        "attempt": _env_int("AGENTLAB_ATTEMPT", default=1, minimum=1),
        "row_seq": _env_int("AGENTLAB_ROW_SEQ", default=0, minimum=0),
    }


def _ids(task_payload: Any) -> dict[str, Any]:
    return {
        "run_id": os.environ.get("AGENTLAB_RUN_ID", "run_unknown"),
        "trial_id": _trial_id(),
        "variant_id": os.environ.get("AGENTLAB_VARIANT_ID", "variant_unknown"),
        "task_id": os.environ.get("AGENTLAB_TASK_ID", _task_id(task_payload)),
        "repl_idx": _env_int("AGENTLAB_REPL_IDX", default=0, minimum=0),
    }


def _benchmark_spec(task_payload: Any) -> dict[str, str]:
    default = {
        "adapter_id": "bench_v0",
        "name": "bench",
        "split": "test",
    }
    if not isinstance(task_payload, dict):
        return default
    candidate = task_payload.get("benchmark")
    if not isinstance(candidate, dict):
        return default
    out = dict(default)
    for key in ("adapter_id", "name", "split"):
        value = candidate.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()
    return out


def _extract_patch_text(agent_result: Any) -> str | None:
    if not isinstance(agent_result, dict):
        return None

    for value in (agent_result.get("patch"), agent_result.get("prediction")):
        if isinstance(value, str) and value.strip():
            return value

    answer = agent_result.get("answer")
    if isinstance(answer, dict):
        value = answer.get("patch")
        if isinstance(value, str) and value.strip():
            return value
        value = answer.get("value")
        if isinstance(value, str) and value.strip().startswith("diff --git"):
            return value
    elif isinstance(answer, str) and answer.strip().startswith("diff --git"):
        return answer

    output = agent_result.get("output")
    if isinstance(output, dict):
        value = output.get("patch")
        if isinstance(value, str) and value.strip():
            return value
    return None


def _extract_answer_text(agent_result: Any) -> str:
    if not isinstance(agent_result, dict):
        return ""
    answer = agent_result.get("answer")
    if isinstance(answer, str):
        return answer
    if isinstance(answer, dict):
        value = answer.get("value")
        if isinstance(value, str):
            return value
    return ""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truncate_log(value: str) -> str:
    if len(value) <= MAX_LOG_CHARS:
        return value
    trimmed = value[-MAX_LOG_CHARS:]
    dropped = len(value) - len(trimmed)
    return f"[truncated {dropped} chars]\n{trimmed}"


def _resolve_timeout_seconds() -> int:
    override = _env_int("AGENTLAB_GRADER_TIMEOUT_SECONDS", default=0, minimum=1)
    if override > 0:
        return override
    timeout_ms = _env_int("AGENTLAB_TIMEOUT_MS", default=0, minimum=1)
    if timeout_ms > 0:
        seconds = timeout_ms // 1000
        return max(1, min(900, seconds))
    return 300


def _resolve_workspace(task_payload: Any) -> str:
    if isinstance(task_payload, dict):
        workspace = task_payload.get("workspace")
        if isinstance(workspace, str) and workspace.strip():
            return workspace.strip()
    env_workspace = os.environ.get("WORKSPACE", "").strip()
    if env_workspace:
        return env_workspace
    return "/workspace"


def _resolve_image_hidden_command(task_payload: Any) -> str:
    hidden_root = Path(os.environ.get("BENCH_HIDDEN_ROOT", "/opt/bench/hidden"))
    workspace = _resolve_workspace(task_payload)
    candidates = [
        (hidden_root / "runner.py", hidden_root / "cases.jsonl"),
        (hidden_root / _task_id(task_payload) / "runner.py", hidden_root / _task_id(task_payload) / "cases.jsonl"),
    ]
    for runner_path, cases_path in candidates:
        if runner_path.exists() and cases_path.exists():
            return f"python3 {runner_path} {workspace} {cases_path}"
    return ""


def _summarize_case_payload(payload: Any) -> dict[str, Any] | None:
    if isinstance(payload, dict):
        payload = [payload]
    if not isinstance(payload, list):
        return None

    total = 0
    passed = 0
    for row in payload:
        if not isinstance(row, dict) or "passed" not in row:
            continue
        total += 1
        if bool(row.get("passed")):
            passed += 1
    if total == 0:
        return None
    return {
        "cases_total": float(total),
        "cases_passed": float(passed),
        "all_passed": passed == total,
    }


def _extract_case_stats(stdout: str) -> dict[str, Any] | None:
    stripped = stdout.strip()
    if not stripped:
        return None

    # Common format: a single JSON array/object payload.
    try:
        decoded = json.loads(stripped)
        summary = _summarize_case_payload(decoded)
        if summary is not None:
            return summary
    except Exception:
        pass

    # Fallback: one JSON object per line.
    decoded_rows: list[Any] = []
    for line in stdout.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        try:
            decoded_rows.append(json.loads(candidate))
        except Exception:
            continue
    return _summarize_case_payload(decoded_rows)


def _run_command(command: str, cwd: Path, timeout_seconds: int) -> dict[str, Any]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            ["/bin/bash", "-lc", command],
            cwd=str(cwd),
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        return {
            "command": command,
            "exit_code": int(completed.returncode),
            "timed_out": False,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "stdout_tail": _truncate_log((completed.stdout or "").strip()),
            "stderr_tail": _truncate_log((completed.stderr or "").strip()),
            "case_stats": _extract_case_stats(completed.stdout or ""),
        }
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        return {
            "command": command,
            "exit_code": 124,
            "timed_out": True,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "stdout_tail": _truncate_log(stdout.strip()),
            "stderr_tail": _truncate_log(stderr.strip()),
            "case_stats": None,
        }
    except Exception as exc:  # pragma: no cover
        return {
            "command": command,
            "exit_code": 125,
            "timed_out": False,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "stdout_tail": "",
            "stderr_tail": str(exc),
            "case_stats": None,
        }


def _score_workspace(task_payload: Any) -> dict[str, Any]:
    timeout_seconds = _resolve_timeout_seconds()
    workspace_path = Path(_resolve_workspace(task_payload))
    public_command = (
        task_payload.get("public_command", "").strip()
        if isinstance(task_payload, dict) and isinstance(task_payload.get("public_command"), str)
        else ""
    )
    payload_hidden_command = (
        task_payload.get("hidden_command", "").strip()
        if isinstance(task_payload, dict) and isinstance(task_payload.get("hidden_command"), str)
        else ""
    )
    image_hidden_command = _resolve_image_hidden_command(task_payload)
    hidden_command = image_hidden_command
    hidden_command_source = "image_hidden_bundle" if image_hidden_command else "missing"

    diagnostics: dict[str, Any] = {
        "workspace": str(workspace_path),
        "timeout_seconds": timeout_seconds,
        "public_command": public_command or None,
        "hidden_command": hidden_command or None,
        "hidden_command_source": hidden_command_source,
        "payload_hidden_command_present": bool(payload_hidden_command),
    }

    if not workspace_path.exists():
        return {
            "verdict": "error",
            "resolved": 0.0,
            "metrics": {
                "resolved": 0.0,
                "hidden_cases_total": 0.0,
                "hidden_cases_passed": 0.0,
                "public_cases_total": 0.0,
                "public_cases_passed": 0.0,
            },
            "failure_label": "workspace_missing",
            "diagnostics": diagnostics,
            "error": {
                "error_type": "workspace_missing",
                "message": f"workspace does not exist: {workspace_path}",
            },
        }

    public_result = _run_command(public_command, workspace_path, timeout_seconds) if public_command else None
    hidden_result = _run_command(hidden_command, workspace_path, timeout_seconds) if hidden_command else None
    if public_result is not None:
        diagnostics["public_result"] = public_result
    if hidden_result is not None:
        diagnostics["hidden_result"] = hidden_result

    public_total = 1.0 if public_command else 0.0
    public_pass = (
        public_result is not None and not public_result["timed_out"] and public_result["exit_code"] == 0
    ) if public_command else True
    public_passed = 1.0 if (public_command and public_pass) else 0.0

    hidden_total = 1.0 if hidden_command else 0.0
    hidden_passed = 0.0
    hidden_pass = False
    if hidden_command and hidden_result is not None and not hidden_result["timed_out"]:
        hidden_case_stats = hidden_result.get("case_stats")
        if isinstance(hidden_case_stats, dict):
            hidden_total = float(hidden_case_stats.get("cases_total", 0.0))
            hidden_passed = float(hidden_case_stats.get("cases_passed", 0.0))
            hidden_pass = bool(hidden_case_stats.get("all_passed", False)) and hidden_result["exit_code"] == 0
        else:
            hidden_pass = hidden_result["exit_code"] == 0
            hidden_passed = 1.0 if hidden_pass else 0.0

    if not hidden_command:
        return {
            "verdict": "error",
            "resolved": 0.0,
            "metrics": {
                "resolved": 0.0,
                "hidden_cases_total": hidden_total,
                "hidden_cases_passed": hidden_passed,
                "public_cases_total": public_total,
                "public_cases_passed": public_passed,
            },
            "failure_label": "hidden_bundle_missing",
            "diagnostics": diagnostics,
            "error": {
                "error_type": "hidden_bundle_missing",
                "message": "hidden bundle is missing from image (expected runner.py + cases.jsonl)",
            },
        }

    resolved = 1.0 if (hidden_pass and public_pass) else 0.0
    if resolved == 1.0:
        verdict = "pass"
        failure_label = None
    else:
        verdict = "fail"
        if public_command and not public_pass:
            failure_label = "public_command_timeout" if public_result and public_result["timed_out"] else "public_command_failed"
        elif hidden_result and hidden_result["timed_out"]:
            failure_label = "hidden_command_timeout"
        else:
            failure_label = "hidden_command_failed"

    metrics = {
        "resolved": resolved,
        "hidden_cases_total": hidden_total,
        "hidden_cases_passed": hidden_passed,
        "public_cases_total": public_total,
        "public_cases_passed": public_passed,
    }
    return {
        "verdict": verdict,
        "resolved": resolved,
        "metrics": metrics,
        "failure_label": failure_label,
        "diagnostics": diagnostics,
        "error": None,
    }


def _prediction_record(task_payload: Any, patch_text: str | None, answer_text: str) -> dict[str, Any]:
    if patch_text is not None:
        prediction = {"kind": "patch", "value": patch_text}
    else:
        prediction = {"kind": "text", "value": answer_text}
    return {
        "schema_version": "benchmark_prediction_record_v1",
        **_row_identity(),
        "ts": _utc_now(),
        "ids": _ids(task_payload),
        "benchmark": _benchmark_spec(task_payload),
        "prediction": prediction,
        "ext": {"bench": {"has_patch": patch_text is not None}},
    }


def _score_record(task_payload: Any, agent_result: Any, patch_text: str | None) -> dict[str, Any]:
    score = _score_workspace(task_payload)
    record: dict[str, Any] = {
        "schema_version": "benchmark_score_record_v1",
        **_row_identity(),
        "ts": _utc_now(),
        "ids": _ids(task_payload),
        "benchmark": _benchmark_spec(task_payload),
        "verdict": score["verdict"],
        "primary_metric_name": "resolved",
        "primary_metric_value": score["resolved"],
        "metrics": score["metrics"],
        "evaluator": {"name": "bench_grader", "mode": "custom", "command": ["python3", "/opt/bench/bench_benchmark_adapter.py"]},
        "ext": {
            "bench": {
                "overall_pass": score["resolved"] == 1.0,
                "failure_label": score["failure_label"],
                "diagnostics": score["diagnostics"],
                "has_patch": patch_text is not None,
                "agent_outcome": agent_result.get("outcome") if isinstance(agent_result, dict) else None,
            }
        },
    }
    if score["error"] is not None:
        record["error"] = score["error"]
    return record


def main() -> int:
    task_path = _required_env("AGENTLAB_TASK_PATH")
    result_path = _required_env("AGENTLAB_RESULT_PATH")
    prediction_path = _required_env("AGENTLAB_BENCHMARK_PREDICTION_PATH")
    score_path = _required_env("AGENTLAB_BENCHMARK_SCORE_PATH")

    task_payload = _task_payload(_read_json(task_path))
    agent_result = _read_json(result_path)
    patch_text = _extract_patch_text(agent_result)
    answer_text = _extract_answer_text(agent_result)

    _write_json(prediction_path, _prediction_record(task_payload, patch_text, answer_text))
    _write_json(score_path, _score_record(task_payload, agent_result, patch_text))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover
        print(f"bench_benchmark_adapter.py error: {exc}", file=sys.stderr)
        raise SystemExit(1)
