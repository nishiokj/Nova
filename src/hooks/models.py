from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")


def _parse_rfc3339(value: str) -> None:
    if not isinstance(value, str):
        raise ValueError("timestamp must be a string")
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError("timestamp must be RFC3339") from exc


class HookFilter(BaseModel):
    tool_name: Optional[str] = None
    tier: Optional[str] = None
    user_input_regex: Optional[str] = None
    session_key: Optional[str] = None
    request_id: Optional[str] = None

    @field_validator("user_input_regex")
    @classmethod
    def validate_regex(cls, value: Optional[str]) -> Optional[str]:
        if value:
            try:
                re.compile(value)
            except re.error as exc:
                raise ValueError(f"invalid user_input_regex: {exc}") from exc
        return value


class MutationOp(BaseModel):
    op: Literal[
        "set_env",
        "set_workdir",
        "set_tier",
        "set_tool_policy",
        "transform_input",
        "transform_tool_args",
        "transform_tool_result",
        "annotate_context",
        # Code review operations (task.completed trigger)
        "trigger_code_review",
    ]
    key: Optional[str] = None
    value: Optional[Any] = None
    scope: Optional[str] = None
    path: Optional[str] = None
    template: Optional[str] = None

    @model_validator(mode="after")
    def validate_op(self) -> "MutationOp":
        if self.op == "set_env":
            if not self.key:
                raise ValueError("set_env requires key")
            if self.value is None:
                raise ValueError("set_env requires value")
        if self.op in ("set_workdir", "set_tier"):
            if self.value is None:
                raise ValueError(f"{self.op} requires value")
        if self.op == "set_tool_policy":
            if self.value is None:
                raise ValueError("set_tool_policy requires value")
        if self.op.startswith("transform_") and self.value is None and not self.template:
            raise ValueError(f"{self.op} requires value or template")
        if self.op == "annotate_context" and not self.key:
            raise ValueError("annotate_context requires key")
        return self


class HookAction(BaseModel):
    type: Literal["observe", "annotate", "block", "mutate"]
    message: Optional[str] = None
    ops: Optional[List[MutationOp]] = None

    @model_validator(mode="after")
    def validate_action(self) -> "HookAction":
        if self.type == "block" and not self.message:
            raise ValueError("block action requires message")
        if self.type == "mutate":
            if not self.ops:
                raise ValueError("mutate action requires ops")
        return self


class HookDefinition(BaseModel):
    id: str = Field(pattern=ID_PATTERN.pattern)
    name: str
    description: str
    enabled: bool = True
    trigger: Literal[
        "invocation.before",
        "invocation.after",
        "tool.before",
        "tool.after",
        "task.completed",  # After full task completion - for code review
    ]
    priority: int = 0
    timeout_ms: int = 100
    fail_open: bool = True
    filter: HookFilter = Field(default_factory=HookFilter)
    action: HookAction
    created_at: str
    updated_at: str

    @field_validator("created_at", "updated_at")
    @classmethod
    def validate_timestamps(cls, value: str) -> str:
        _parse_rfc3339(value)
        return value


@dataclass
class ToolPolicy:
    allow: Optional[List[str]] = None
    deny: Optional[List[str]] = None

    def is_allowed(self, tool_name: str) -> bool:
        if self.deny and tool_name in self.deny:
            return False
        if not self.allow:
            return True
        if "*" in self.allow:
            return True
        return tool_name in self.allow


@dataclass
class TaskCompletionData:
    """Data captured on task completion for code review hooks."""
    success: bool = True
    goal_achieved: bool = True
    goal: str = ""

    # File operations
    files_written: List[str] = field(default_factory=list)
    files_read: List[str] = field(default_factory=list)

    # Tool usage
    tools_used: List[str] = field(default_factory=list)
    tool_call_count: int = 0

    # Execution metrics
    steps_completed: int = 0
    steps_failed: int = 0
    steps_skipped: int = 0
    duration_ms: float = 0

    # For second-order effect analysis via graphd
    symbols_modified: List[str] = field(default_factory=list)

    # Plan details for scope understanding
    plan_steps: List[Dict[str, Any]] = field(default_factory=list)

    # Final response (for review)
    final_response: str = ""


@dataclass
class InvocationContext:
    request_id: str
    session_key: Optional[str]
    user_input: str
    tier: str
    tool_name: Optional[str] = None
    tool_args: Optional[Dict[str, Any]] = None
    tool_result: Optional[Any] = None
    env_overrides: Dict[str, str] = field(default_factory=dict)
    workdir_override: Optional[str] = None
    tool_policy: Optional[ToolPolicy] = None
    annotations: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

    # Task completion context (populated for task.completed trigger)
    task_completion: Optional[TaskCompletionData] = None


@dataclass
class HookDecision:
    hook_id: str
    action_type: str
    blocked: bool = False
    message: Optional[str] = None
    applied_ops: List[str] = field(default_factory=list)
    error: Optional[str] = None


@dataclass
class HookResult:
    blocked: bool = False
    message: Optional[str] = None
    decisions: List[HookDecision] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
