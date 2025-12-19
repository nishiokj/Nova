"""
Agent Execution Logger - Detailed tracking of agent context, planning, and execution.

This logger creates a dedicated log file (agent_execution.jsonl) that tracks:
1. Full request context presented to the agent
2. Complete planning results with all substeps
3. Execution context for each subagent/substep
4. Detailed execution step logs with failure modes

All entries include standard metadata: ts, lvl, svc, req_id, exec_id
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Any, Optional, List
from pathlib import Path
from logging.handlers import RotatingFileHandler


@dataclass
class AgentContextLog:
    """Log entry for full agent request context"""
    ts: str                         # timestamp
    lvl: str                        # level (INFO)s
    svc: str                        # service (agent_context)
    req_id: str                     # request ID
    exec_id: str                    # execution ID
    context: Dict[str, Any]         # Full context object
    request: Dict[str, Any]         # Request details

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ts": self.ts,
            "lvl": self.lvl,
            "svc": self.svc,
            "req_id": self.req_id,
            "exec_id": self.exec_id,
            "context": self.context,
            "request": self.request
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


@dataclass
class PlanningResultLog:
    """Log entry for complete planning result"""
    ts: str
    lvl: str
    svc: str                        # planning
    req_id: str
    exec_id: str
    plan: Dict[str, Any]            # Complete plan object with all substeps

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ts": self.ts,
            "lvl": self.lvl,
            "svc": self.svc,
            "req_id": self.req_id,
            "exec_id": self.exec_id,
            "plan": self.plan
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


@dataclass
class ExecutionContextLog:
    """Log entry for subagent execution context"""
    ts: str
    lvl: str
    svc: str                        # execution_context
    req_id: str
    exec_id: str
    step_id: str                    # Which step is executing
    context: Dict[str, Any]         # Context provided to this substep

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ts": self.ts,
            "lvl": self.lvl,
            "svc": self.svc,
            "req_id": self.req_id,
            "exec_id": self.exec_id,
            "step_id": self.step_id,
            "context": self.context
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


@dataclass
class ExecutionStepLog:
    """Log entry for detailed execution step result"""
    ts: str
    lvl: str
    svc: str                        # execution_step
    req_id: str
    exec_id: str
    step_id: str
    step_num: int
    status: str                     # completed, failed, partial
    action: Optional[Dict[str, Any]] = None  # What action was taken
    result: Optional[Dict[str, Any]] = None
    failure_mode: Optional[str] = None
    substeps_achieved: Optional[List[str]] = None
    substeps_failed: Optional[List[str]] = None
    error_details: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        data = {
            "ts": self.ts,
            "lvl": self.lvl,
            "svc": self.svc,
            "req_id": self.req_id,
            "exec_id": self.exec_id,
            "step_id": self.step_id,
            "step_num": self.step_num,
            "status": self.status
        }
        if self.action:
            data["action"] = self.action
        if self.result:
            data["result"] = self.result
        if self.failure_mode:
            data["failure_mode"] = self.failure_mode
        if self.substeps_achieved:
            data["substeps_achieved"] = self.substeps_achieved
        if self.substeps_failed:
            data["substeps_failed"] = self.substeps_failed
        if self.error_details:
            data["error_details"] = self.error_details
        return data

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


@dataclass
class EpisodeSummaryLog:
    """Episodic summary with RL labels - one per (req_id, exec_id)"""
    ts: str
    lvl: str
    svc: str                        # episode_summary
    req_id: str
    exec_id: str
    meta: Dict[str, Any]            # System metadata (prompt IDs, tool manifest)
    task: Dict[str, Any]            # Task details
    stats: Dict[str, Any]           # Deterministic statistics
    labels: Dict[str, Any]          # RL labels from Reflector

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ts": self.ts,
            "lvl": self.lvl,
            "svc": self.svc,
            "req_id": self.req_id,
            "exec_id": self.exec_id,
            "meta": self.meta,
            "task": self.task,
            "stats": self.stats,
            "labels": self.labels
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


class AgentExecutionLogger:
    """
    Dedicated logger for detailed agent execution tracking.
    Creates agent_execution.jsonl with full context, planning, and execution details.

    IMPORTANT: log_dir is REQUIRED. This class does not use default paths.
    The calling application should create the log directory.
    """

    def __init__(
        self,
        log_dir: str,
        max_log_size: int = 50 * 1024 * 1024,  # 50MB - can be large
        backup_count: int = 10
    ):
        """
        Initialize AgentExecutionLogger.

        Args:
            log_dir: Directory where logs will be written. REQUIRED.
            max_log_size: Maximum log file size before rotation (default: 50MB)
            backup_count: Number of backup files to keep (default: 10)
        """
        if not log_dir:
            raise ValueError("log_dir is required - AgentExecutionLogger does not use default paths")

        self.log_dir = Path(log_dir)
        self.max_log_size = max_log_size
        self.backup_count = backup_count
        self._execution_counter = 0
        self._setup_logging()

    def _setup_logging(self):
        """Set up the agent execution log file"""
        self.log_dir.mkdir(parents=True, exist_ok=True)

        self.logger = logging.getLogger("agent_execution")
        self.logger.setLevel(logging.INFO)
        self.logger.handlers = []
        self.logger.propagate = False

        handler = RotatingFileHandler(
            self.log_dir / "agent_execution.jsonl",
            maxBytes=self.max_log_size,
            backupCount=self.backup_count
        )
        handler.setFormatter(logging.Formatter('%(message)s'))
        self.logger.addHandler(handler)

    def _ts(self) -> str:
        """Generate timestamp"""
        return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    def new_execution_id(self, req_id: str) -> str:
        """Generate a new execution ID for this request"""
        self._execution_counter += 1
        return f"{req_id}-exec-{self._execution_counter:04d}"

    def log_agent_context(
        self,
        req_id: str,
        exec_id: str,
        user_input: str,
        tier: str,
        system_prompt_id: str,
        tool_manifest_id: str,
        conversation_history: List[Dict[str, Any]],
        tool_names: List[str],
        additional_context: Optional[Dict[str, Any]] = None
    ):
        """
        Log the full context presented to the agent when handling a request.
        Now uses IDs instead of full schemas for system prompts and tools.

        Args:
            req_id: Request ID
            exec_id: Execution ID
            user_input: The user's input text
            tier: Agent tier (simple/standard/advanced)
            system_prompt_id: ID of the system prompt (e.g., "tier_advanced_v3")
            tool_manifest_id: ID of the tool manifest (e.g., "default_tools_v2")
            conversation_history: Previous conversation messages (truncated)
            tool_names: List of available tool names only
            additional_context: Any other context information
        """
        context = {
            "tier": tier,
            "system_prompt_id": system_prompt_id,
            "tool_manifest_id": tool_manifest_id,
            "conversation_history": conversation_history[-5:] if len(conversation_history) > 5 else conversation_history,
            "tool_names": tool_names,
            "tool_count": len(tool_names)
        }
        if additional_context:
            context["additional"] = additional_context

        request = {
            "user_input": user_input,
            "input_length": len(user_input),
            "has_context": len(conversation_history) > 0
        }

        entry = AgentContextLog(
            ts=self._ts(),
            lvl="INFO",
            svc="agent_context",
            req_id=req_id,
            exec_id=exec_id,
            context=context,
            request=request
        )

        self.logger.info(entry.to_json())

    def log_planning_result(
        self,
        req_id: str,
        exec_id: str,
        goal: str,
        goal_type: str,
        requires_tools: bool,
        steps: List[Dict[str, Any]],
        success_criteria: str,
        estimated_complexity: str,
        reasoning: str,
        plan_status: str = "pending",
        discovery_required: bool = True,
        assumptions: Optional[List[str]] = None
    ):
        """
        Log the complete planning result with all substeps.
        Reasoning is truncated to 512 chars.

        Args:
            req_id: Request ID
            exec_id: Execution ID
            goal: The plan goal
            goal_type: Type of goal (question/task/creation/search)
            requires_tools: Whether tools are needed
            steps: List of plan steps with objectives, tool hints, etc.
            success_criteria: How success is measured
            estimated_complexity: Complexity estimate
            reasoning: Why this plan was chosen
            plan_status: Status of the plan
            discovery_required: Whether discovery must run before execution
            assumptions: Planner assumptions captured for transparency
        """
        # Truncate reasoning to keep logs manageable
        reasoning_truncated = reasoning[:512] if len(reasoning) > 512 else reasoning

        plan = {
            "goal": goal,
            "goal_type": goal_type,
            "requires_tools": requires_tools,
            "estimated_complexity": estimated_complexity,
            "success_criteria": success_criteria,
            "reasoning": reasoning_truncated,
            "status": plan_status,
            "steps": steps,
            "step_count": len(steps),
            "discovery_required": discovery_required
        }
        if assumptions:
            plan["assumptions"] = assumptions

        entry = PlanningResultLog(
            ts=self._ts(),
            lvl="INFO",
            svc="planning",
            req_id=req_id,
            exec_id=exec_id,
            plan=plan
        )

        self.logger.info(entry.to_json())

    def log_execution_context(
        self,
        req_id: str,
        exec_id: str,
        step_id: str,
        step_num: int,
        step_objective: str,
        tool_hint: Optional[str],
        messages: List[Dict[str, Any]],
        available_tools: List[str],
        system_prompt_id: str,
        tool_manifest_id: str,
        dependencies: Optional[List[int]] = None
    ):
        """
        Log the context provided to a subagent/substep during execution.
        Now includes system_prompt_id and tool_manifest_id.

        Args:
            req_id: Request ID
            exec_id: Execution ID
            step_id: Step identifier
            step_num: Step number
            step_objective: What this step should accomplish
            tool_hint: Suggested tool for this step
            messages: Message history for this step (truncated)
            available_tools: Tool names only (not full schemas)
            system_prompt_id: ID of system prompt
            tool_manifest_id: ID of tool manifest
            dependencies: Steps this depends on
        """
        context = {
            "step_num": step_num,
            "step_objective": step_objective,
            "tool_hint": tool_hint,
            "message_count": len(messages),
            "messages": messages[-3:] if len(messages) > 3 else messages,  # Keep only recent messages
            "available_tools": available_tools,  # Names only
            "system_prompt_id": system_prompt_id,
            "tool_manifest_id": tool_manifest_id,
            "dependencies": dependencies or []
        }

        entry = ExecutionContextLog(
            ts=self._ts(),
            lvl="INFO",
            svc="execution_context",
            req_id=req_id,
            exec_id=exec_id,
            step_id=step_id,
            context=context
        )

        self.logger.info(entry.to_json())

    def log_execution_step(
        self,
        req_id: str,
        exec_id: str,
        step_id: str,
        step_num: int,
        status: str,
        step_objective: str,
        tool_name: Optional[str] = None,
        tool_args: Optional[Dict[str, Any]] = None,
        tool_success: Optional[bool] = None,
        tool_output: Optional[Any] = None,
        tool_error: Optional[str] = None,
        error: Optional[str] = None,
        failure_mode: Optional[str] = None,
        substeps_achieved: Optional[List[str]] = None,
        substeps_failed: Optional[List[str]] = None,
        duration_ms: float = 0
    ):
        """
        Log detailed execution step result with action and result details.

        Args:
            req_id: Request ID
            exec_id: Execution ID
            step_id: Step identifier
            step_num: Step number
            status: Step status (completed/failed/partial)
            step_objective: What this step was trying to accomplish
            tool_name: Name of tool that was called
            tool_args: Arguments passed to tool
            tool_success: Whether tool call succeeded
            tool_output: Output from tool
            tool_error: Error from tool if failed
            error: Error message if step failed
            failure_mode: Specific failure mode (tool_failed/llm_error/timeout/etc)
            substeps_achieved: Substeps that succeeded
            substeps_failed: Substeps that failed
            duration_ms: Execution duration
        """
        # Build action object
        action = None
        if tool_name:
            action = {
                "type": "tool_call",
                "tool_name": tool_name,
                "tool_args": tool_args or {}
            }

        # Build result object
        result_data = {
            "duration_ms": round(duration_ms)
        }

        if tool_name:
            result_data["tool_success"] = tool_success if tool_success is not None else False
            if tool_output is not None:
                # Truncate large outputs
                output_str = str(tool_output)
                result_data["tool_output"] = output_str[:2000] if len(output_str) > 2000 else output_str
                result_data["result_truncated"] = len(output_str) > 2000
            if tool_error:
                result_data["error"] = tool_error

        error_details = None
        if error or failure_mode or tool_error:
            error_details = {}
            if error:
                error_details["error_message"] = error
            if failure_mode:
                error_details["failure_mode"] = failure_mode
            if tool_error:
                error_details["tool_error"] = tool_error

        # Determine log level based on status
        lvl = "INFO" if status == "completed" else "WARNING"

        entry = ExecutionStepLog(
            ts=self._ts(),
            lvl=lvl,
            svc="execution_step",
            req_id=req_id,
            exec_id=exec_id,
            step_id=step_id,
            step_num=step_num,
            status=status,
            action=action,
            result=result_data,
            failure_mode=failure_mode,
            substeps_achieved=substeps_achieved,
            substeps_failed=substeps_failed,
            error_details=error_details
        )

        self.logger.info(entry.to_json())

    def log_episode_summary(
        self,
        req_id: str,
        exec_id: str,
        tier: str,
        system_prompt_id: str,
        tool_manifest_id: str,
        user_input: str,
        goal: str,
        goal_type: str,
        total_duration_ms: float,
        tool_calls: int,
        tool_failures: int,
        max_tool_calls_allowed: int,
        rl_labels: Dict[str, Any]
    ):
        """
        Log episodic summary with RL labels - one per (req_id, exec_id).

        Args:
            req_id: Request ID
            exec_id: Execution ID
            tier: Agent tier used
            system_prompt_id: ID of system prompt
            tool_manifest_id: ID of tool manifest
            user_input: User's original input
            goal: Extracted goal from planning
            goal_type: Type of goal (question/task/creation/search)
            total_duration_ms: Total execution time
            tool_calls: Number of tool calls made
            tool_failures: Number of tool failures
            max_tool_calls_allowed: Max tool calls limit
            rl_labels: RL labels from Reflector (goal_achieved, reward, etc.)
        """
        meta = {
            "tier": tier,
            "system_prompt_id": system_prompt_id,
            "tool_manifest_id": tool_manifest_id
        }

        task = {
            "user_input": user_input,
            "goal": goal,
            "goal_type": goal_type
        }

        stats = {
            "total_duration_ms": round(total_duration_ms),
            "tool_calls": tool_calls,
            "tool_failures": tool_failures,
            "max_tool_calls_allowed": max_tool_calls_allowed
        }

        entry = EpisodeSummaryLog(
            ts=self._ts(),
            lvl="INFO",
            svc="episode_summary",
            req_id=req_id,
            exec_id=exec_id,
            meta=meta,
            task=task,
            stats=stats,
            labels=rl_labels
        )

        self.logger.info(entry.to_json())
