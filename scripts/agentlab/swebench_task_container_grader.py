#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ADAPTER_ID_DEFAULT = "jesus.swebench_in_container"
ADAPTER_VERSION_DEFAULT = "v1"
PREFERRED_PATCH_KEYS = ("model_patch", "patch", "diff", "git_patch", "final_patch")
DIFF_MARKERS = ("diff --git ", "--- ", "Index: ", "@@ ")
EXCLUDED_REPO_PATH_PREFIXES = (".haiku", ".lab", ".agentlab")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise RuntimeError(f"expected JSON object at {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=True)
        handle.write("\n")


def run_checked(command: list[str], cwd: Path | None = None, stdin_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        input=stdin_text,
        text=True,
        capture_output=True,
        check=False,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Per-trial in-container SWE-bench grader. "
            "Writes benchmark_prediction_record_v1 and benchmark_score_record_v1 JSON objects."
        )
    )
    parser.add_argument("--benchmark-name", default="swebench_lite_curated")
    parser.add_argument("--benchmark-version", default="")
    parser.add_argument("--split", default="test")
    parser.add_argument("--workspace-repo-relpath", default="repo")
    parser.add_argument("--adapter-id", default=ADAPTER_ID_DEFAULT)
    parser.add_argument("--adapter-version", default=ADAPTER_VERSION_DEFAULT)
    parser.add_argument("--allow-answer-patch-fallback", action="store_true", default=True)
    parser.add_argument("--disable-answer-patch-fallback", action="store_true")
    args = parser.parse_args()
    repo_rel = Path(args.workspace_repo_relpath)
    if repo_rel.is_absolute() or ".." in repo_rel.parts:
        raise RuntimeError("--workspace-repo-relpath must be a safe relative path")
    if args.disable_answer_patch_fallback:
        args.allow_answer_patch_fallback = False
    return args


def has_patch_markers(text: str) -> bool:
    return any(marker in text for marker in DIFF_MARKERS)


def try_extract_patch_from_answer(payload: dict[str, Any]) -> tuple[str, str] | None:
    answer = payload.get("answer")
    candidates: list[tuple[str, str]] = []
    if isinstance(answer, str):
        candidates.append(("result.answer", answer))
    elif isinstance(answer, dict):
        for key in PREFERRED_PATCH_KEYS:
            value = answer.get(key)
            if isinstance(value, str):
                candidates.append((f"result.answer.{key}", value))

    ext = payload.get("ext")
    if isinstance(ext, dict):
        swebench = ext.get("swebench")
        if isinstance(swebench, dict):
            for key in PREFERRED_PATCH_KEYS:
                value = swebench.get(key)
                if isinstance(value, str):
                    candidates.append((f"result.ext.swebench.{key}", value))

    for source, candidate in candidates:
        cleaned = candidate.strip()
        if cleaned and has_patch_markers(cleaned):
            return cleaned, source
    return None


def is_excluded_repo_relpath(rel_path: str) -> bool:
    rel = Path(rel_path)
    if rel.is_absolute():
        return True
    first = rel.parts[0] if rel.parts else ""
    return first in EXCLUDED_REPO_PATH_PREFIXES


def git_patch_for_repo(repo_dir: Path) -> str:
    status = run_checked(["git", "-C", str(repo_dir), "status", "--porcelain"])
    if status.returncode != 0 or not status.stdout.strip():
        return ""

    diff_cmd = ["git", "-C", str(repo_dir), "diff", "--binary", "--no-color", "HEAD", "--", "."]
    for prefix in EXCLUDED_REPO_PATH_PREFIXES:
        diff_cmd.append(f":(exclude){prefix}/**")
    diff = run_checked(diff_cmd)
    patch_chunks = [diff.stdout] if diff.returncode in {0, 1} else []

    untracked = run_checked(["git", "-C", str(repo_dir), "ls-files", "--others", "--exclude-standard"])
    if untracked.returncode == 0:
        for rel in [line.strip() for line in untracked.stdout.splitlines() if line.strip()]:
            if is_excluded_repo_relpath(rel):
                continue
            rel_path = repo_dir / rel
            if not rel_path.exists() or not rel_path.is_file():
                continue
            patch = run_checked(
                ["git", "-C", str(repo_dir), "diff", "--no-index", "--binary", "--no-color", "/dev/null", rel],
            )
            if patch.returncode in {0, 1} and patch.stdout:
                patch_chunks.append(patch.stdout)

    normalized = []
    for chunk in patch_chunks:
        if chunk:
            normalized.append(chunk if chunk.endswith("\n") else f"{chunk}\n")
    return "".join(normalized)


def patch_reverse_applies(repo_dir: Path, patch: str) -> tuple[bool, str | None]:
    if not patch.strip():
        return False, "empty patch"
    check = run_checked(
        ["git", "-C", str(repo_dir), "apply", "--check", "--reverse", "--whitespace=nowarn", "-"],
        stdin_text=patch,
    )
    if check.returncode == 0:
        return True, None
    detail = check.stderr.strip() or check.stdout.strip() or f"exit={check.returncode}"
    return False, detail


def extract_ids(task_payload: dict[str, Any]) -> dict[str, Any]:
    ids = task_payload.get("ids")
    if not isinstance(ids, dict):
        ids = {}
    run_id = str(ids.get("run_id") or require_env("AGENTLAB_RUN_ID"))
    trial_id = str(ids.get("trial_id") or require_env("AGENTLAB_TRIAL_ID"))
    variant_id = str(ids.get("variant_id") or require_env("AGENTLAB_VARIANT_ID"))
    task_id = str(ids.get("task_id") or require_env("AGENTLAB_TASK_ID"))
    repl_raw = ids.get("repl_idx", require_env("AGENTLAB_REPL_IDX"))
    repl_idx = int(repl_raw)
    return {
        "run_id": run_id,
        "trial_id": trial_id,
        "variant_id": variant_id,
        "task_id": task_id,
        "repl_idx": repl_idx,
    }


def extract_swebench_meta(task_payload: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    task = task_payload.get("task")
    if not isinstance(task, dict):
        return None, None, None
    swebench = task.get("swebench")
    if not isinstance(swebench, dict):
        return None, None, None
    swebench_input = swebench.get("input")
    if not isinstance(swebench_input, dict):
        return None, None, None
    instance_id = swebench_input.get("instance_id")
    repo = swebench_input.get("repo")
    base_commit = swebench_input.get("base_commit")
    return (
        instance_id if isinstance(instance_id, str) and instance_id.strip() else None,
        repo if isinstance(repo, str) and repo.strip() else None,
        base_commit if isinstance(base_commit, str) and base_commit.strip() else None,
    )


def parse_agent_exit_status() -> int | None:
    raw = os.environ.get("AGENTLAB_AGENT_EXIT_STATUS", "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def shell_command_invocation() -> list[str]:
    executable = sys.executable or "python3"
    return [executable, *sys.argv]


def main() -> int:
    args = parse_args()

    task_path = Path(require_env("AGENTLAB_TASK_PATH"))
    result_path = Path(require_env("AGENTLAB_RESULT_PATH"))
    prediction_path = Path(require_env("AGENTLAB_BENCHMARK_PREDICTION_PATH"))
    score_path = Path(require_env("AGENTLAB_BENCHMARK_SCORE_PATH"))

    benchmark_info: dict[str, Any] = {
        "adapter_id": args.adapter_id,
        "name": args.benchmark_name,
        "split": args.split or "test",
    }
    if args.benchmark_version:
        benchmark_info["version"] = args.benchmark_version

    task_payload = read_json(task_path)
    ids = extract_ids(task_payload)
    instance_id, repo, base_commit = extract_swebench_meta(task_payload)
    agent_exit_status = parse_agent_exit_status()

    workspace_root = Path(os.environ.get("AGENTLAB_WORKSPACE_ROOT", "/agentlab/workspace"))
    repo_dir = workspace_root / args.workspace_repo_relpath

    patch = ""
    patch_source = ""
    no_patch_reason = None
    patch_reverse_ok = False
    patch_reverse_reason = None

    if repo_dir.exists():
        patch = git_patch_for_repo(repo_dir)
        if patch:
            patch_source = f"workspace/{args.workspace_repo_relpath}:git_diff"
            patch_reverse_ok, patch_reverse_reason = patch_reverse_applies(repo_dir, patch)
        else:
            no_patch_reason = f"empty workspace diff at workspace/{args.workspace_repo_relpath}"
    else:
        no_patch_reason = f"missing workspace repo: workspace/{args.workspace_repo_relpath}"

    if not patch and args.allow_answer_patch_fallback and result_path.exists():
        result_payload = read_json(result_path)
        extracted = try_extract_patch_from_answer(result_payload)
        if extracted is not None:
            patch, patch_source = extracted
            no_patch_reason = None
        elif no_patch_reason is None:
            no_patch_reason = "no patch markers in result.answer/ext fallback"

    if not patch and no_patch_reason is None:
        no_patch_reason = "no patch extracted"

    prediction_row: dict[str, Any] = {
        "schema_version": "benchmark_prediction_record_v1",
        "ts": now_iso(),
        "ids": ids,
        "benchmark": benchmark_info,
        "prediction": {
            "kind": "patch",
            "value": patch,
            "metadata": {
                "instance_id": instance_id,
                "repo": repo,
                "base_commit": base_commit,
                "patch_source": patch_source,
                "no_patch_reason": no_patch_reason,
            },
        },
        "metrics": {
            "patch_bytes": len(patch.encode("utf-8")),
            "has_patch": 1.0 if patch else 0.0,
            "patch_reverse_applies": 1.0 if patch_reverse_ok else 0.0,
            "agent_exit_status": float(agent_exit_status) if agent_exit_status is not None else None,
        },
        "ext": {
            "swebench": {
                "instance_id": instance_id,
                "repo": repo,
                "base_commit": base_commit,
            }
        },
    }

    verdict = "error"
    error_message = None
    if instance_id is None:
        verdict = "error"
        error_message = "missing swebench instance_id in AGENTLAB_TASK_PATH payload"
    elif not patch:
        verdict = "missing"
    elif agent_exit_status is not None and agent_exit_status != 0:
        verdict = "fail"
    elif patch_reverse_ok:
        verdict = "pass"
    else:
        verdict = "fail"

    resolved_proxy = 1.0 if verdict == "pass" else 0.0
    score_row: dict[str, Any] = {
        "schema_version": "benchmark_score_record_v1",
        "ts": now_iso(),
        "ids": ids,
        "benchmark": benchmark_info,
        "verdict": verdict,
        "primary_metric_name": "resolved_proxy",
        "primary_metric_value": resolved_proxy,
        "metrics": {
            "resolved_proxy": resolved_proxy,
            "has_patch": 1.0 if patch else 0.0,
            "patch_reverse_applies": 1.0 if patch_reverse_ok else 0.0,
            "agent_exit_status": float(agent_exit_status) if agent_exit_status is not None else None,
        },
        "evaluator": {
            "name": "swebench.in_container_proxy",
            "mode": "custom",
            "version": args.adapter_version,
            "command": shell_command_invocation(),
        },
        "ext": {
            "instance_id": instance_id,
            "patch_source": patch_source,
            "no_patch_reason": no_patch_reason,
            "patch_reverse_reason": patch_reverse_reason,
        },
    }
    if error_message:
        score_row["error"] = {
            "error_type": "grader_input_error",
            "message": error_message,
        }

    write_json(prediction_path, prediction_row)
    write_json(score_path, score_row)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        # Best-effort fallback so runner always gets a score row instead of a hard grader crash.
        prediction_out = os.environ.get("AGENTLAB_BENCHMARK_PREDICTION_PATH")
        score_out = os.environ.get("AGENTLAB_BENCHMARK_SCORE_PATH")
        run_id = os.environ.get("AGENTLAB_RUN_ID", "unknown_run")
        trial_id = os.environ.get("AGENTLAB_TRIAL_ID", "unknown_trial")
        variant_id = os.environ.get("AGENTLAB_VARIANT_ID", "unknown_variant")
        task_id = os.environ.get("AGENTLAB_TASK_ID", "unknown_task")
        repl_raw = os.environ.get("AGENTLAB_REPL_IDX", "0")
        try:
            repl_idx = int(repl_raw)
        except ValueError:
            repl_idx = 0
        ids = {
            "run_id": run_id,
            "trial_id": trial_id,
            "variant_id": variant_id,
            "task_id": task_id,
            "repl_idx": repl_idx,
        }
        benchmark = {
            "adapter_id": ADAPTER_ID_DEFAULT,
            "name": "swebench_lite_curated",
            "split": "test",
        }
        if prediction_out:
            write_json(
                Path(prediction_out),
                {
                    "schema_version": "benchmark_prediction_record_v1",
                    "ts": now_iso(),
                    "ids": ids,
                    "benchmark": benchmark,
                    "prediction": {"kind": "patch", "value": ""},
                    "metrics": {"has_patch": 0.0},
                },
            )
        if score_out:
            write_json(
                Path(score_out),
                {
                    "schema_version": "benchmark_score_record_v1",
                    "ts": now_iso(),
                    "ids": ids,
                    "benchmark": benchmark,
                    "verdict": "error",
                    "primary_metric_name": "resolved_proxy",
                    "primary_metric_value": 0.0,
                    "metrics": {"resolved_proxy": 0.0, "has_patch": 0.0},
                    "evaluator": {
                        "name": "swebench.in_container_proxy",
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
