"""
Tests for post-task code review hook integration and robustness.
"""

from datetime import datetime
from pathlib import Path

from hooks.store import HookStore
from hooks.manager import HookManager
from hooks.models import InvocationContext, TaskCompletionData
from hooks.code_reviewer import CodeReviewer, CodeReviewConfig
from util.config import HooksConfig


def _now_rfc3339() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _task_review_hook(hook_id: str, op_value=None) -> dict:
    ts = _now_rfc3339()
    hook = {
        "id": hook_id,
        "name": f"Hook {hook_id}",
        "description": "Post-task code review hook",
        "enabled": True,
        "trigger": "task.completed",
        "priority": 10,
        "timeout_ms": 1000,
        "fail_open": True,
        "filter": {},
        "action": {
            "type": "mutate",
            "ops": [
                {"op": "trigger_code_review"},
            ],
        },
        "created_at": ts,
        "updated_at": ts,
    }
    if op_value is not None:
        hook["action"]["ops"][0]["value"] = op_value
    return hook


def test_task_completed_triggers_code_review(temp_dir, mock_logger):
    hook_store = HookStore(temp_dir, logger=mock_logger)
    hook_store.create(_task_review_hook("review_task_completed"))
    hook_manager = HookManager(hook_store, HooksConfig(enabled=True), logger=mock_logger)

    context = InvocationContext(
        request_id="req-task-complete",
        session_key=None,
        user_input="do something",
        tier="standard",
        task_completion=TaskCompletionData(goal="do something"),
    )

    hook_result = hook_manager.run("task.completed", context)
    assert hook_result.blocked is False
    assert hook_manager.last_code_review is not None
    assert "code_review" in context.annotations


def test_code_review_config_overrides_checks(temp_dir, mock_logger):
    test_file = Path(temp_dir) / "sample.py"
    test_file.write_text("print('debug')\n# TODO: fix\n")

    hook_store = HookStore(temp_dir, logger=mock_logger)
    hook_store.create(_task_review_hook(
        "review_config_override",
        op_value={
            "check_scope": False,
            "check_writes": False,
            "check_bugs": False,
            "check_effects": False,
            "check_slop": False,
        },
    ))
    hook_manager = HookManager(hook_store, HooksConfig(enabled=True), logger=mock_logger)

    context = InvocationContext(
        request_id="req-config",
        session_key=None,
        user_input="update file",
        tier="standard",
        task_completion=TaskCompletionData(files_written=[str(test_file)]),
    )

    hook_manager.run("task.completed", context)
    review = context.annotations.get("code_review", {})
    assert review.get("findings") == []
    assert review.get("risk_level") == "low"


def test_code_reviewer_skips_invalid_and_binary_paths(temp_dir):
    binary_path = Path(temp_dir) / "binary.bin"
    binary_path.write_bytes(b"\xff\xfe\x00\x00")

    completion = TaskCompletionData(files_written=[None, str(binary_path)])
    reviewer = CodeReviewer(config=CodeReviewConfig(
        check_scope=False,
        check_writes=False,
        check_bugs=True,
        check_effects=False,
        check_slop=True,
    ))
    result = reviewer.review(completion)

    assert result.success is True
    assert result.findings == []
