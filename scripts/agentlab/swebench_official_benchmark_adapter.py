#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ADAPTER_ID = "jesus.swebench_official"
ADAPTER_VERSION = "v1"
PREFERRED_PATCH_KEYS = ("model_patch", "patch", "diff", "git_patch", "final_patch")
DIFF_MARKERS = ("diff --git ", "--- ", "Index: ", "@@ ")
EXCLUDED_REPO_PATH_PREFIXES = (".haiku", ".lab", ".agentlab")


class AdapterError(RuntimeError):
    pass


@dataclass
class TrialPrediction:
    ids: dict[str, Any]
    trial_dir: Path | None
    trial_input_path: Path | None
    trial_output_path: Path | None
    instance_id: str | None
    repo: str | None
    base_commit: str | None
    model_name_or_path: str
    patch: str
    patch_source: str
    no_patch_reason: str | None


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return token.strip("_") or "unknown"


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise AdapterError(f"missing required environment variable: {name}")
    return value


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise AdapterError(f"expected JSON object at {path}")
    return payload


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise AdapterError(f"invalid JSONL at {path}:{line_no}: {exc}") from exc
            if not isinstance(row, dict):
                raise AdapterError(f"expected object row at {path}:{line_no}")
            rows.append(row)
    return rows


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":"), ensure_ascii=True))
            handle.write("\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "AgentLab benchmark adapter that maps trial evidence to SWE-bench predictions "
            "and invokes the official swebench evaluator."
        )
    )
    parser.add_argument("--benchmark-name", default="swebench_lite_curated")
    parser.add_argument("--benchmark-version", default="")
    parser.add_argument("--dataset-name", default="princeton-nlp/SWE-bench_Lite")
    parser.add_argument("--split", default="")
    parser.add_argument("--python-bin", default=os.environ.get("AGENTLAB_SWEBENCH_PYTHON", "python3"))
    parser.add_argument("--max-workers", type=int, default=int(os.environ.get("AGENTLAB_SWEBENCH_MAX_WORKERS", "1")))
    parser.add_argument(
        "--extra-eval-args",
        default=os.environ.get("AGENTLAB_SWEBENCH_EXTRA_EVAL_ARGS", ""),
        help="Extra args appended to swebench.harness.run_evaluation.",
    )
    parser.add_argument(
        "--soft-fail",
        action="store_true",
        default=os.environ.get("AGENTLAB_SWEBENCH_SOFT_FAIL", "").strip() in {"1", "true", "yes"},
        help="Emit error verdicts instead of failing the adapter when evaluator invocation fails.",
    )
    parser.add_argument(
        "--workspace-repo-relpath",
        default=os.environ.get("AGENTLAB_SWEBENCH_REPO_RELPATH", "repo"),
        help="Relative path under trial workspace that contains the task repository checkout.",
    )
    parser.add_argument(
        "--allow-answer-patch-fallback",
        action="store_true",
        default=os.environ.get("AGENTLAB_SWEBENCH_ALLOW_ANSWER_PATCH_FALLBACK", "").strip().lower()
        in {"1", "true", "yes"},
        help="Allow patch extraction from trial output answer/ext when workspace repo diff is unavailable.",
    )
    args = parser.parse_args()
    if args.max_workers <= 0:
        raise AdapterError("--max-workers must be > 0")
    repo_relpath = Path(args.workspace_repo_relpath)
    if repo_relpath.is_absolute() or ".." in repo_relpath.parts:
        raise AdapterError("--workspace-repo-relpath must be a safe relative path")
    return args


def has_patch_markers(text: str) -> bool:
    for marker in DIFF_MARKERS:
        if marker in text:
            return True
    return False


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
        if not cleaned:
            continue
        if has_patch_markers(cleaned):
            return cleaned, source
    return None


def run_checked(
    command: list[str],
    cwd: Path | None = None,
    check: bool = False,
    stdin_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        text=True,
        input=stdin_text,
        capture_output=True,
        check=check,
    )


def is_excluded_repo_relpath(rel_path: str) -> bool:
    rel = Path(rel_path)
    if rel.is_absolute():
        return True
    first = rel.parts[0] if rel.parts else ""
    return first in EXCLUDED_REPO_PATH_PREFIXES


def git_patch_for_repo(repo_dir: Path) -> str:
    status = run_checked(["git", "-C", str(repo_dir), "status", "--porcelain"], check=False)
    if status.returncode != 0:
        return ""
    if not status.stdout.strip():
        return ""

    diff_cmd = ["git", "-C", str(repo_dir), "diff", "--binary", "--no-color", "HEAD", "--", "."]
    for prefix in EXCLUDED_REPO_PATH_PREFIXES:
        diff_cmd.append(f":(exclude){prefix}/**")
    diff = run_checked(diff_cmd, check=False)
    patch_chunks = [diff.stdout] if diff.returncode in {0, 1} else []

    untracked = run_checked(
        ["git", "-C", str(repo_dir), "ls-files", "--others", "--exclude-standard"],
        check=False,
    )
    if untracked.returncode == 0:
        for rel in [line.strip() for line in untracked.stdout.splitlines() if line.strip()]:
            if is_excluded_repo_relpath(rel):
                continue
            rel_path = repo_dir / rel
            if not rel_path.exists() or not rel_path.is_file():
                continue
            patch = run_checked(
                ["git", "-C", str(repo_dir), "diff", "--no-index", "--binary", "--no-color", "/dev/null", rel],
                check=False,
            )
            if patch.returncode in {0, 1} and patch.stdout:
                patch_chunks.append(patch.stdout)

    normalized_chunks: list[str] = []
    for chunk in patch_chunks:
        if not chunk:
            continue
        normalized_chunks.append(chunk if chunk.endswith("\n") else f"{chunk}\n")
    return "".join(normalized_chunks)


def patch_reverse_applies(repo_dir: Path, patch: str) -> tuple[bool, str | None]:
    if not patch.strip():
        return False, "empty patch"
    check = run_checked(
        ["git", "-C", str(repo_dir), "apply", "--check", "--reverse", "--whitespace=nowarn", "-"],
        check=False,
        stdin_text=patch,
    )
    if check.returncode == 0:
        return True, None
    detail = check.stderr.strip() or check.stdout.strip() or f"exit={check.returncode}"
    return False, detail


def try_extract_patch_from_workspace(
    trial_dir: Path | None,
    workspace_repo_relpath: str,
) -> tuple[str, str, str | None]:
    if trial_dir is None:
        return "", "", "missing trial_dir for workspace patch extraction"
    workspace_dir = trial_dir / "workspace"
    if not workspace_dir.exists():
        return "", "", f"missing workspace directory: {workspace_dir}"

    repo_dir = workspace_dir / workspace_repo_relpath
    if not repo_dir.exists():
        return "", "", f"missing workspace repo boundary path: workspace/{workspace_repo_relpath}"
    if not (repo_dir / ".git").exists():
        return "", "", f"workspace repo boundary is not a git repository: workspace/{workspace_repo_relpath}"

    patch = git_patch_for_repo(repo_dir)
    if not patch:
        return "", "", f"no git diff found under workspace/{workspace_repo_relpath}"
    if not has_patch_markers(patch):
        return "", "", "workspace git diff did not produce recognized patch markers"
    valid, validation_error = patch_reverse_applies(repo_dir, patch)
    if not valid:
        return "", "", f"workspace git diff failed git-apply validation: {validation_error}"
    return patch, f"workspace.git_diff:{workspace_repo_relpath}", None


def parse_trial_paths(run_dir: Path, record: dict[str, Any]) -> tuple[Path | None, Path | None, Path | None]:
    paths = record.get("paths")
    if not isinstance(paths, dict):
        return None, None, None

    trial_dir: Path | None = None
    trial_dir_raw = paths.get("trial_dir")
    if isinstance(trial_dir_raw, str) and trial_dir_raw.strip():
        trial_dir = run_dir / trial_dir_raw

    trial_input_path: Path | None = None
    trial_input_raw = paths.get("trial_input")
    if isinstance(trial_input_raw, str) and trial_input_raw.strip():
        trial_input_path = run_dir / trial_input_raw
    elif trial_dir is not None:
        trial_input_path = trial_dir / "trial_input.json"

    trial_output_path: Path | None = None
    trial_output_raw = paths.get("trial_output")
    if isinstance(trial_output_raw, str) and trial_output_raw.strip():
        trial_output_path = run_dir / trial_output_raw
    elif trial_dir is not None:
        trial_output_path = trial_dir / "result.json"

    return trial_dir, trial_input_path, trial_output_path


def extract_trial_prediction(run_dir: Path, record: dict[str, Any], args: argparse.Namespace) -> TrialPrediction:
    ids = record.get("ids")
    if not isinstance(ids, dict):
        raise AdapterError("evidence record missing /ids object")

    trial_dir, trial_input_path, trial_output_path = parse_trial_paths(run_dir, record)

    task_id = str(ids.get("task_id", ""))
    variant_id = str(ids.get("variant_id", ""))
    repl_idx = ids.get("repl_idx", 0)
    model_name = "unknown/unknown"

    instance_id = None
    repo = None
    base_commit = None
    no_patch_reason = None
    patch = ""
    patch_source = ""

    trial_input: dict[str, Any] | None = None
    if trial_input_path is not None and trial_input_path.exists():
        trial_input = read_json(trial_input_path)
        bindings = trial_input.get("bindings")
        if isinstance(bindings, dict):
            provider = str(bindings.get("model_provider") or bindings.get("provider") or "unknown")
            model = str(bindings.get("model") or "unknown")
            model_name = f"{provider}/{model}"

        task = trial_input.get("task")
        if isinstance(task, dict):
            swebench = task.get("swebench")
            if isinstance(swebench, dict):
                swebench_input = swebench.get("input")
                if isinstance(swebench_input, dict):
                    if isinstance(swebench_input.get("instance_id"), str):
                        instance_id = swebench_input["instance_id"]
                    if isinstance(swebench_input.get("repo"), str):
                        repo = swebench_input["repo"]
                    if isinstance(swebench_input.get("base_commit"), str):
                        base_commit = swebench_input["base_commit"]

            task_input = task.get("input")
            if isinstance(task_input, dict) and instance_id is None:
                if isinstance(task_input.get("instance_id"), str):
                    instance_id = task_input["instance_id"]

    workspace_patch, workspace_patch_source, workspace_patch_reason = try_extract_patch_from_workspace(
        trial_dir,
        args.workspace_repo_relpath,
    )
    if workspace_patch:
        patch, patch_source = workspace_patch, workspace_patch_source
    else:
        no_patch_reason = workspace_patch_reason

    if not patch and args.allow_answer_patch_fallback and trial_output_path is not None and trial_output_path.exists():
        try:
            trial_output = read_json(trial_output_path)
            extracted = try_extract_patch_from_answer(trial_output)
            if extracted is not None:
                patch, patch_source = extracted
                no_patch_reason = None
            elif no_patch_reason is None:
                no_patch_reason = "no workspace git diff and no patch-like trial output answer"
        except Exception as exc:  # pragma: no cover - defensive
            if no_patch_reason is None:
                no_patch_reason = f"failed to parse trial output patch: {exc}"

    if not patch:
        patch = ""
        patch_source = ""
        if no_patch_reason is None:
            no_patch_reason = "no patch extracted from workspace boundary"

    if not instance_id:
        no_patch_reason = no_patch_reason or "missing swebench instance_id in trial input"

    return TrialPrediction(
        ids={
            "run_id": str(ids.get("run_id") or ""),
            "trial_id": str(ids.get("trial_id") or ""),
            "variant_id": variant_id,
            "task_id": task_id,
            "repl_idx": int(repl_idx or 0),
        },
        trial_dir=trial_dir,
        trial_input_path=trial_input_path,
        trial_output_path=trial_output_path,
        instance_id=instance_id,
        repo=repo,
        base_commit=base_commit,
        model_name_or_path=model_name,
        patch=patch,
        patch_source=patch_source,
        no_patch_reason=no_patch_reason,
    )


def ensure_swebench_installed(python_bin: str) -> None:
    probe = run_checked([python_bin, "-c", "import swebench"], check=False)
    if probe.returncode == 0:
        return
    raise AdapterError(
        "official SWE-bench evaluator is unavailable. "
        f"Failed command: {python_bin} -c 'import swebench'. "
        "Install it in the host environment and/or set AGENTLAB_SWEBENCH_PYTHON."
    )


def evaluator_command(
    args: argparse.Namespace,
    predictions_path: Path,
    eval_run_id: str,
    include_split: bool,
) -> list[str]:
    cmd = [
        args.python_bin,
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        args.dataset_name,
        "--predictions_path",
        str(predictions_path),
        "--max_workers",
        str(args.max_workers),
        "--run_id",
        eval_run_id,
    ]
    if include_split and args.split:
        cmd.extend(["--split", args.split])
    if args.extra_eval_args:
        cmd.extend(shlex.split(args.extra_eval_args))
    return cmd


def find_eval_report(work_dir: Path, eval_run_id: str) -> Path:
    exact = sorted(work_dir.glob(f"*.{eval_run_id}.json"))
    if exact:
        return exact[-1]
    fuzzy = sorted(work_dir.glob(f"*{eval_run_id}*.json"))
    if fuzzy:
        return fuzzy[-1]
    raise AdapterError(f"unable to locate evaluator report JSON for run_id={eval_run_id} in {work_dir}")


def verdict_map_from_report(report: dict[str, Any]) -> dict[str, str]:
    resolved = set(str(v) for v in report.get("resolved_ids", []) if isinstance(v, str))
    unresolved = set(str(v) for v in report.get("unresolved_ids", []) if isinstance(v, str))
    errors = set(str(v) for v in report.get("error_ids", []) if isinstance(v, str))
    empty_patch = set(str(v) for v in report.get("empty_patch_ids", []) if isinstance(v, str))
    incomplete = set(str(v) for v in report.get("incomplete_ids", []) if isinstance(v, str))

    verdicts: dict[str, str] = {}
    for instance_id in resolved:
        verdicts[instance_id] = "pass"
    for instance_id in unresolved:
        verdicts[instance_id] = "fail"
    for instance_id in empty_patch:
        verdicts[instance_id] = "missing"
    for instance_id in incomplete:
        verdicts[instance_id] = "error"
    for instance_id in errors:
        verdicts[instance_id] = "error"
    return verdicts


def score_record(
    trial: TrialPrediction,
    benchmark_info: dict[str, Any],
    verdict: str,
    evaluator_cmd: list[str],
    error_message: str | None = None,
) -> dict[str, Any]:
    resolved = 1.0 if verdict == "pass" else 0.0
    row: dict[str, Any] = {
        "schema_version": "benchmark_score_record_v1",
        "ts": iso_now(),
        "ids": trial.ids,
        "benchmark": benchmark_info,
        "verdict": verdict,
        "primary_metric_name": "resolved",
        "primary_metric_value": resolved,
        "metrics": {
            "resolved": resolved,
            "has_patch": 1.0 if trial.patch else 0.0,
        },
        "evaluator": {
            "name": "swebench.harness.run_evaluation",
            "mode": "official",
            "command": evaluator_cmd,
        },
        "ext": {
            "instance_id": trial.instance_id,
            "patch_source": trial.patch_source,
            "no_patch_reason": trial.no_patch_reason,
        },
    }
    if error_message:
        row["error"] = {
            "error_type": "evaluator_error",
            "message": error_message,
        }
    return row


def main() -> int:
    args = parse_args()

    run_id = require_env("AGENTLAB_RUN_ID")
    run_dir = Path(require_env("AGENTLAB_RUN_DIR"))
    evidence_records_path = Path(require_env("AGENTLAB_EVIDENCE_RECORDS_PATH"))
    benchmark_tasks_path = Path(require_env("AGENTLAB_BENCHMARK_TASKS_PATH"))
    evaluator_logs_dir = Path(require_env("AGENTLAB_EVALUATOR_LOGS_DIR"))
    manifest_path = Path(require_env("AGENTLAB_ADAPTER_MANIFEST_PATH"))
    predictions_path = Path(require_env("AGENTLAB_PREDICTIONS_PATH"))
    scores_path = Path(require_env("AGENTLAB_SCORES_PATH"))

    evaluator_logs_dir.mkdir(parents=True, exist_ok=True)
    benchmark_tasks_path.parent.mkdir(parents=True, exist_ok=True)

    benchmark_info = {
        "adapter_id": ADAPTER_ID,
        "name": args.benchmark_name,
        "split": args.split or "test",
    }
    if args.benchmark_version:
        benchmark_info["version"] = args.benchmark_version

    eval_cmd_template = evaluator_command(
        args,
        Path("<predictions_path>"),
        "<run_id>",
        include_split=bool(args.split),
    )

    manifest = {
        "schema_version": "benchmark_adapter_manifest_v1",
        "created_at": iso_now(),
        "adapter_id": ADAPTER_ID,
        "adapter_version": ADAPTER_VERSION,
        "benchmark": {
            "name": args.benchmark_name,
            "split": args.split or "test",
            "version": args.benchmark_version or args.dataset_name,
            "source": args.dataset_name,
        },
        "execution_mode": "predict_then_score",
        "record_schemas": {
            "prediction": "benchmark_prediction_record_v1",
            "score": "benchmark_score_record_v1",
        },
        "evaluator": {
            "name": "swebench.harness.run_evaluation",
            "mode": "official",
            "command": eval_cmd_template,
        },
        "capabilities": {
            "supports_official_evaluator": True,
            "supports_containerized_scoring": True,
            "requires_network_for_scoring": True,
            "deterministic_scoring": False,
        },
        "patch_extraction": {
            "strategy": "workspace_repo_git_diff",
            "workspace_repo_relpath": args.workspace_repo_relpath,
            "answer_patch_fallback_enabled": bool(args.allow_answer_patch_fallback),
            "excluded_path_prefixes": list(EXCLUDED_REPO_PATH_PREFIXES),
        },
    }
    write_json(manifest_path, manifest)

    records = read_jsonl(evidence_records_path)
    trials: list[TrialPrediction] = []
    for record in records:
        try:
            trials.append(extract_trial_prediction(run_dir, record, args))
        except Exception as exc:
            ids = record.get("ids", {})
            fallback = TrialPrediction(
                ids={
                    "run_id": str(ids.get("run_id") or run_id),
                    "trial_id": str(ids.get("trial_id") or ""),
                    "variant_id": str(ids.get("variant_id") or ""),
                    "task_id": str(ids.get("task_id") or ""),
                    "repl_idx": int(ids.get("repl_idx") or 0),
                },
                trial_dir=None,
                trial_input_path=None,
                trial_output_path=None,
                instance_id=None,
                repo=None,
                base_commit=None,
                model_name_or_path="unknown/unknown",
                patch="",
                patch_source="",
                no_patch_reason=f"failed to parse evidence: {exc}",
            )
            trials.append(fallback)

    prediction_rows: list[dict[str, Any]] = []
    benchmark_task_rows: list[dict[str, Any]] = []
    for trial in trials:
        prediction_rows.append(
            {
                "schema_version": "benchmark_prediction_record_v1",
                "ts": iso_now(),
                "ids": trial.ids,
                "benchmark": benchmark_info,
                "prediction": {
                    "kind": "patch",
                    "value": trial.patch,
                    "metadata": {
                        "instance_id": trial.instance_id,
                        "repo": trial.repo,
                        "base_commit": trial.base_commit,
                        "model_name_or_path": trial.model_name_or_path,
                        "patch_source": trial.patch_source,
                        "no_patch_reason": trial.no_patch_reason,
                    },
                },
                "metrics": {
                    "patch_bytes": len(trial.patch.encode("utf-8")),
                    "has_patch": 1.0 if trial.patch else 0.0,
                },
            }
        )
        benchmark_task_rows.append(
            {
                "ids": trial.ids,
                "instance_id": trial.instance_id,
                "repo": trial.repo,
                "base_commit": trial.base_commit,
                "model_name_or_path": trial.model_name_or_path,
                "has_patch": bool(trial.patch),
                "patch_source": trial.patch_source,
                "no_patch_reason": trial.no_patch_reason,
            }
        )

    write_jsonl(predictions_path, prediction_rows)
    write_jsonl(benchmark_tasks_path, benchmark_task_rows)

    grouped: dict[tuple[str, str], list[TrialPrediction]] = defaultdict(list)
    for trial in trials:
        grouped[(trial.ids["variant_id"], trial.model_name_or_path)].append(trial)

    scores: list[dict[str, Any]] = []
    installed_checked = False
    for (variant_id, model_name), group_trials in grouped.items():
        group_token = sanitize_token(f"{variant_id}__{model_name}")
        eval_run_id = sanitize_token(f"{run_id}__{group_token}")[:120]
        group_dir = evaluator_logs_dir / group_token
        group_dir.mkdir(parents=True, exist_ok=True)

        by_instance: dict[str, TrialPrediction] = {}
        for trial in group_trials:
            if not trial.patch or not trial.instance_id:
                continue
            existing = by_instance.get(trial.instance_id)
            if existing is None or len(trial.patch) > len(existing.patch):
                by_instance[trial.instance_id] = trial

        eval_command_used = evaluator_command(args, Path("<predictions_path>"), eval_run_id, include_split=bool(args.split))
        verdicts: dict[str, str] = {}
        evaluator_error: str | None = None

        if by_instance:
            if not installed_checked:
                ensure_swebench_installed(args.python_bin)
                installed_checked = True

            official_predictions_path = group_dir / "official_predictions.jsonl"
            official_predictions: list[dict[str, Any]] = []
            for trial in by_instance.values():
                official_predictions.append(
                    {
                        "instance_id": trial.instance_id,
                        "model_name_or_path": model_name,
                        "model_patch": trial.patch,
                    }
                )
            write_jsonl(official_predictions_path, official_predictions)

            cmd = evaluator_command(args, official_predictions_path, eval_run_id, include_split=bool(args.split))
            proc = run_checked(cmd, cwd=group_dir, check=False)
            output = f"{proc.stdout}\n{proc.stderr}"
            if proc.returncode != 0 and args.split and "unrecognized arguments: --split" in output:
                cmd = evaluator_command(args, official_predictions_path, eval_run_id, include_split=False)
                proc = run_checked(cmd, cwd=group_dir, check=False)

            eval_command_used = cmd
            if proc.returncode == 0:
                report_path = find_eval_report(group_dir, eval_run_id)
                report = read_json(report_path)
                verdicts = verdict_map_from_report(report)
            else:
                evaluator_error = (
                    f"official evaluator failed for variant={variant_id}, model={model_name}, "
                    f"run_id={eval_run_id}, exit={proc.returncode}. "
                    f"stdout={proc.stdout.strip()} stderr={proc.stderr.strip()}"
                )
                if not args.soft_fail:
                    raise AdapterError(evaluator_error)

        for trial in group_trials:
            if not trial.instance_id:
                scores.append(
                    score_record(
                        trial,
                        benchmark_info,
                        verdict="error",
                        evaluator_cmd=eval_command_used,
                        error_message=trial.no_patch_reason or "missing swebench instance_id",
                    )
                )
                continue
            if not trial.patch:
                scores.append(score_record(trial, benchmark_info, verdict="missing", evaluator_cmd=eval_command_used))
                continue
            if evaluator_error is not None:
                scores.append(
                    score_record(
                        trial,
                        benchmark_info,
                        verdict="error",
                        evaluator_cmd=eval_command_used,
                        error_message=evaluator_error,
                    )
                )
                continue
            verdict = verdicts.get(trial.instance_id, "error")
            scores.append(score_record(trial, benchmark_info, verdict=verdict, evaluator_cmd=eval_command_used))

    write_jsonl(scores_path, scores)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AdapterError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
