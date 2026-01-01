from __future__ import annotations

import os
import re
import time
from typing import Any, Dict, Optional

from util.config import HooksConfig
from util.logger import StructuredLogger
from .engine import HookEngine
from .models import (
    HookDefinition,
    HookDecision,
    HookResult,
    InvocationContext,
    MutationOp,
    ToolPolicy,
)
from .store import HookStore
from .code_reviewer import CodeReviewer, CodeReviewConfig, CodeReviewResult


TEMPLATE_PATTERN = re.compile(r"{{\s*([^}]+?)\s*}}")


def _resolve_path(obj: Any, path: str) -> Any:
    current: Any = obj
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif hasattr(current, part):
            current = getattr(current, part)
        else:
            return None
    return current


def _render_template(text: str, context: Dict[str, Any]) -> str:
    def repl(match: re.Match[str]) -> str:
        expr = match.group(1).strip()
        resolved = _resolve_path(context, expr)
        if resolved is None:
            raise KeyError(f"missing template value: {expr}")
        return str(resolved)
    return TEMPLATE_PATTERN.sub(repl, text)


def _set_path(target: Dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    current = target
    for part in parts[:-1]:
        if part not in current or not isinstance(current[part], dict):
            current[part] = {}
        current = current[part]
    current[parts[-1]] = value


def _coerce_tool_policy(value: Any) -> ToolPolicy:
    if isinstance(value, dict):
        allow = value.get("allow") or value.get("allowed")
        deny = value.get("deny") or value.get("blocked")
        allow_list = None
        deny_list = None
        if allow is not None:
            allow_list = [allow] if isinstance(allow, str) else list(allow)
        if deny is not None:
            deny_list = [deny] if isinstance(deny, str) else list(deny)
        return ToolPolicy(allow=allow_list, deny=deny_list)
    if isinstance(value, list):
        return ToolPolicy(allow=[str(v) for v in value], deny=None)
    if isinstance(value, str):
        return ToolPolicy(allow=[value], deny=None)
    raise ValueError("invalid tool policy value")


class HookManager:
    def __init__(
        self,
        store: HookStore,
        config: HooksConfig,
        logger: Optional[StructuredLogger] = None,
        graphd_client: Optional[Any] = None,
    ):
        self.store = store
        self.config = config
        self.logger = logger or StructuredLogger()
        self.engine = HookEngine()
        self.graphd_client = graphd_client

        # Code reviewer instance (lazy-initialized)
        self._code_reviewer: Optional[CodeReviewer] = None

        # Last code review result (accessible for inspection)
        self.last_code_review: Optional[CodeReviewResult] = None

    def set_graphd_client(self, client: Any) -> None:
        """Set the graphd client for code review effects analysis."""
        self.graphd_client = client
        # Reset reviewer to pick up new client
        self._code_reviewer = None

    def _get_code_reviewer(self) -> CodeReviewer:
        """Get or create the code reviewer instance."""
        if self._code_reviewer is None:
            self._code_reviewer = CodeReviewer(
                graphd_client=self.graphd_client,
                config=CodeReviewConfig(),
                logger=self.logger,
            )
        return self._code_reviewer

    def run(self, trigger: str, context: InvocationContext) -> HookResult:
        if not self.config.enabled:
            return HookResult()

        start_time = time.time()
        list_result = self.store.list()
        for err in list_result.errors:
            self.logger.warning(
                f"Hook load error: {err.get('message')}",
                component="hooks",
                data={"path": err.get("path"), "errors": err.get("errors")},
            )

        hooks = self.engine.evaluate(list_result.items, trigger, context)
        decisions = []

        for hook in hooks:
            hook_start = time.time()
            try:
                decision = self._apply_hook(hook, context)
            except Exception as exc:
                msg = f"Hook '{hook.id}' failed: {exc}"
                if hook.fail_open or self.config.default_fail_open:
                    self.logger.warning(msg, component="hooks")
                    decision = HookDecision(hook_id=hook.id, action_type=hook.action.type, error=str(exc))
                    decisions.append(decision)
                    self.logger.info(
                        f"Hook decision {hook.id}",
                        component="hooks",
                        data={
                            "trigger": trigger,
                            "hook_id": hook.id,
                            "action": hook.action.type,
                            "blocked": False,
                            "applied_ops": [],
                            "error": str(exc),
                        },
                    )
                    continue
                return HookResult(blocked=True, message=msg, decisions=decisions, errors=[str(exc)])

            elapsed_ms = (time.time() - hook_start) * 1000
            if elapsed_ms > hook.timeout_ms:
                msg = f"Hook '{hook.id}' timed out after {hook.timeout_ms} ms"
                if hook.fail_open or self.config.default_fail_open:
                    self.logger.warning(msg, component="hooks")
                    decision = HookDecision(hook_id=hook.id, action_type=hook.action.type, error=msg)
                    decisions.append(decision)
                    self.logger.info(
                        f"Hook decision {hook.id}",
                        component="hooks",
                        data={
                            "trigger": trigger,
                            "hook_id": hook.id,
                            "action": hook.action.type,
                            "blocked": False,
                            "applied_ops": [],
                            "error": msg,
                        },
                    )
                    continue
                return HookResult(blocked=True, message=msg, decisions=decisions, errors=[msg])

            decisions.append(decision)
            self.logger.info(
                f"Hook decision {hook.id}",
                component="hooks",
                data={
                    "trigger": trigger,
                    "hook_id": hook.id,
                    "action": hook.action.type,
                    "blocked": decision.blocked,
                    "applied_ops": decision.applied_ops,
                },
            )
            if decision.blocked:
                return HookResult(blocked=True, message=decision.message, decisions=decisions)

            if (time.time() - start_time) * 1000 > self.config.max_exec_ms:
                msg = f"Hook execution exceeded {self.config.max_exec_ms} ms"
                if self.config.default_fail_open:
                    self.logger.warning(msg, component="hooks")
                    break
                return HookResult(blocked=True, message=msg, decisions=decisions, errors=[msg])

        return HookResult(blocked=False, decisions=decisions)

    def _apply_hook(self, hook: HookDefinition, context: InvocationContext) -> HookDecision:
        action = hook.action
        decision = HookDecision(hook_id=hook.id, action_type=action.type)

        if action.type == "observe":
            return decision

        if action.type == "annotate":
            if action.message:
                context.annotations[hook.id] = action.message
            return decision

        if action.type == "block":
            decision.blocked = True
            decision.message = action.message
            return decision

        if action.type == "mutate":
            for op in action.ops or []:
                self._apply_mutation(op, context, decision)
            return decision

        return decision

    def _apply_mutation(self, op: MutationOp, context: InvocationContext, decision: HookDecision) -> None:
        template_context = {
            "input": context.user_input,
            "tier": context.tier,
            "tool_name": context.tool_name,
            "tool_args": context.tool_args or {},
            "tool_result": context.tool_result,
            "session_key": context.session_key,
            "request_id": context.request_id,
            "annotations": context.annotations,
            "metadata": context.metadata,
        }

        if op.template:
            value = _render_template(op.template, template_context)
        elif isinstance(op.value, str) and "{{" in op.value:
            value = _render_template(op.value, template_context)
        else:
            value = op.value

        if op.op == "set_env":
            scope = op.scope or "invocation"
            if scope == "process":
                os.environ[str(op.key)] = str(value)
            else:
                context.env_overrides[str(op.key)] = str(value)
            decision.applied_ops.append(op.op)
            return

        if op.op == "set_workdir":
            context.workdir_override = str(value)
            decision.applied_ops.append(op.op)
            return

        if op.op == "set_tier":
            context.tier = str(value)
            decision.applied_ops.append(op.op)
            return

        if op.op == "set_tool_policy":
            context.tool_policy = _coerce_tool_policy(value)
            decision.applied_ops.append(op.op)
            return

        if op.op == "transform_input":
            context.user_input = str(value)
            decision.applied_ops.append(op.op)
            return

        if op.op == "transform_tool_args":
            if context.tool_args is None:
                raise ValueError("tool_args not available for transform_tool_args")
            key = op.path or op.key
            if not key:
                raise ValueError("transform_tool_args requires path or key")
            _set_path(context.tool_args, key, value)
            decision.applied_ops.append(op.op)
            return

        if op.op == "transform_tool_result":
            if context.tool_result is None:
                raise ValueError("tool_result not available for transform_tool_result")
            key = op.path or op.key
            if key:
                target = context.tool_result
                if isinstance(target, dict):
                    _set_path(target, key, value)
                elif hasattr(target, "output") and key.startswith("output"):
                    if key == "output":
                        target.output = value
                    else:
                        if not isinstance(target.output, dict):
                            target.output = {}
                        _set_path(target.output, key.replace("output.", "", 1), value)
                elif hasattr(target, "metadata") and key.startswith("metadata"):
                    if key == "metadata":
                        target.metadata = value
                    else:
                        if not isinstance(target.metadata, dict):
                            target.metadata = {}
                        _set_path(target.metadata, key.replace("metadata.", "", 1), value)
                else:
                    setattr(target, key, value)
            else:
                if hasattr(context.tool_result, "output"):
                    context.tool_result.output = value
                else:
                    context.tool_result = value
            decision.applied_ops.append(op.op)
            return

        if op.op == "annotate_context":
            context.annotations[str(op.key)] = value
            decision.applied_ops.append(op.op)
            return

        if op.op == "trigger_code_review":
            # Run code review on task completion
            if context.task_completion is None:
                self.logger.warning(
                    "trigger_code_review called without task_completion data",
                    component="hooks",
                )
                return

            review_config = None
            if op.value is not None:
                if isinstance(op.value, dict):
                    review_config = CodeReviewConfig.from_dict(op.value, logger=self.logger)
                else:
                    self.logger.warning(
                        "trigger_code_review config must be an object",
                        component="hooks",
                        data={"value_type": type(op.value).__name__},
                    )

            reviewer = (
                self._get_code_reviewer()
                if review_config is None
                else CodeReviewer(
                    graphd_client=self.graphd_client,
                    config=review_config,
                    logger=self.logger,
                )
            )
            review_result = reviewer.review(context.task_completion)
            self.last_code_review = review_result

            # Store review result in annotations for downstream access
            context.annotations["code_review"] = review_result.to_dict()
            context.annotations["code_review_risk"] = review_result.risk_level
            context.annotations["code_review_notes"] = review_result.review_notes

            self.logger.info(
                f"Code review completed: risk={review_result.risk_level}, "
                f"findings={len(review_result.findings)}",
                component="hooks",
                data={
                    "risk_level": review_result.risk_level,
                    "findings_count": len(review_result.findings),
                    "files_written": review_result.files_written_count,
                    "affected_count": review_result.affected_count,
                },
            )

            decision.applied_ops.append(op.op)
            return
