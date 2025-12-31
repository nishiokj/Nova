from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from util.logger import StructuredLogger
from harness.agent.tool_registry import ToolRegistry, ToolResult
from .models import SkillDefinition, SkillStep, ToolStep


TEMPLATE_PATTERN = re.compile(r"{{\s*([^}]+?)\s*}}")


def _resolve_path(data: Dict[str, Any], path: str) -> Any:
    current: Any = data
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def _render_template(value: Any, context: Dict[str, Any]) -> Any:
    if isinstance(value, str):
        def repl(match: re.Match[str]) -> str:
            expr = match.group(1).strip()
            resolved = _resolve_path(context, expr)
            if resolved is None:
                raise KeyError(f"missing template value: {expr}")
            return str(resolved)
        return TEMPLATE_PATTERN.sub(repl, value)
    if isinstance(value, dict):
        return {k: _render_template(v, context) for k, v in value.items()}
    if isinstance(value, list):
        return [_render_template(v, context) for v in value]
    return value


def _validate_input_schema(input_schema: Dict[str, Any], input_data: Dict[str, Any]) -> Optional[str]:
    if input_schema.get("type") != "object":
        return "input_schema must be type object"
    required = input_schema.get("required", [])
    missing = [key for key in required if key not in input_data]
    if missing:
        return f"missing required fields: {', '.join(missing)}"
    return None


@dataclass
class SkillToolCall:
    name: str
    args: Dict[str, Any]
    result: Optional[ToolResult] = None


@dataclass
class SkillRunResult:
    success: bool
    output: Any = None
    tool_calls: List[SkillToolCall] = field(default_factory=list)
    duration_ms: float = 0
    error: Optional[str] = None


class SkillRunner:
    def __init__(self, tool_registry: ToolRegistry, logger: Optional[StructuredLogger] = None):
        self.tool_registry = tool_registry
        self.logger = logger or StructuredLogger()

    def run(self, skill: SkillDefinition, input_data: Dict[str, Any]) -> SkillRunResult:
        start_time = time.time()

        validation_error = _validate_input_schema(skill.input_schema, input_data)
        if validation_error:
            return SkillRunResult(
                success=False,
                error=f"input validation failed: {validation_error}",
                duration_ms=(time.time() - start_time) * 1000,
            )

        if "*" in skill.allowed_tools:
            allowed_tools = {tool.name for tool in self.tool_registry.list_tools(enabled_only=True)}
        else:
            allowed_tools = set(skill.allowed_tools)

        steps: List[SkillStep | ToolStep]
        if skill.type == "workflow":
            steps = skill.steps or []
        else:
            steps = skill.tool_chain or []

        tool_calls: List[SkillToolCall] = []
        context = {"input": input_data}

        for step in steps:
            if (time.time() - start_time) * 1000 > skill.timeout_ms:
                return SkillRunResult(
                    success=False,
                    tool_calls=tool_calls,
                    error=f"skill timed out after {skill.timeout_ms} ms",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            if step.tool not in allowed_tools:
                return SkillRunResult(
                    success=False,
                    tool_calls=tool_calls,
                    error=f"tool '{step.tool}' not allowed for skill '{skill.id}'",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            try:
                args = _render_template(step.args, context)
            except KeyError as exc:
                return SkillRunResult(
                    success=False,
                    tool_calls=tool_calls,
                    error=f"template error: {exc}",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            tool_call = SkillToolCall(name=step.tool, args=args)
            tool_calls.append(tool_call)
            result = self.tool_registry.execute(step.tool, **args)
            tool_call.result = result

            if not result.is_success:
                return SkillRunResult(
                    success=False,
                    tool_calls=tool_calls,
                    error=result.error or "tool execution failed",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            context["last_output"] = result.output

        output = context.get("last_output")
        duration_ms = (time.time() - start_time) * 1000

        self.logger.info(
            f"Skill '{skill.id}' executed",
            component="skills",
            data={"duration_ms": duration_ms, "tools_used": [c.name for c in tool_calls]},
        )

        return SkillRunResult(
            success=True,
            output=output,
            tool_calls=tool_calls,
            duration_ms=duration_ms,
        )
