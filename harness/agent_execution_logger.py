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
    lvl: str                        # level (INFO)
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


class AgentExecutionLogger:
    """
    Dedicated logger for detailed agent execution tracking.
    Creates agent_execution.jsonl with full context, planning, and execution details.
    """

    def __init__(
        self,
        log_dir: str = "logs",
        max_log_size: int = 50 * 1024 * 1024,  # 50MB - can be large
        backup_count: int = 10
    ):
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
        system_prompt: str,
        conversation_history: List[Dict[str, Any]],
        tool_definitions: List[Dict[str, Any]],
        additional_context: Optional[Dict[str, Any]] = None
    ):
        """
        Log the full context presented to the agent when handling a request.

        Args:
            req_id: Request ID
            exec_id: Execution ID
            user_input: The user's input text
            tier: Agent tier (simple/standard/advanced)
            system_prompt: The system prompt used
            conversation_history: Previous conversation messages
            tool_definitions: Available tool definitions
            additional_context: Any other context information
        """
        context = {
            "tier": tier,
            "system_prompt": system_prompt,
            "conversation_history": conversation_history,
            "tool_definitions": [
                {"name": t.get("name"), "description": t.get("description")}
                for t in tool_definitions
            ],
            "tool_count": len(tool_definitions)
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
        plan_status: str = "pending"
    ):
        """
        Log the complete planning result with all substeps.

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
        """
        plan = {
            "goal": goal,
            "goal_type": goal_type,
            "requires_tools": requires_tools,
            "estimated_complexity": estimated_complexity,
            "success_criteria": success_criteria,
            "reasoning": reasoning,
            "status": plan_status,
            "steps": steps,
            "step_count": len(steps)
        }

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
        dependencies: Optional[List[int]] = None
    ):
        """
        Log the context provided to a subagent/substep during execution.

        Args:
            req_id: Request ID
            exec_id: Execution ID
            step_id: Step identifier
            step_num: Step number
            step_objective: What this step should accomplish
            tool_hint: Suggested tool for this step
            messages: Message history for this step
            available_tools: Tools available to this step
            dependencies: Steps this depends on
        """
        context = {
            "step_num": step_num,
            "step_objective": step_objective,
            "tool_hint": tool_hint,
            "message_count": len(messages),
            "messages": messages,
            "available_tools": available_tools,
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
        tool_used: Optional[str] = None,
        tool_result: Optional[Any] = None,
        error: Optional[str] = None,
        failure_mode: Optional[str] = None,
        substeps_achieved: Optional[List[str]] = None,
        substeps_failed: Optional[List[str]] = None,
        duration_ms: float = 0
    ):
        """
        Log detailed execution step result with failure modes.

        Args:
            req_id: Request ID
            exec_id: Execution ID
            step_id: Step identifier
            step_num: Step number
            status: Step status (completed/failed/partial)
            step_objective: What this step was trying to accomplish
            tool_used: Tool that was used
            tool_result: Result from tool execution
            error: Error message if failed
            failure_mode: Specific failure mode (tool_failed/llm_error/timeout/etc)
            substeps_achieved: Substeps that succeeded
            substeps_failed: Substeps that failed
            duration_ms: Execution duration
        """
        result = {
            "step_objective": step_objective,
            "duration_ms": round(duration_ms)
        }
        if tool_used:
            result["tool_used"] = tool_used
        if tool_result is not None:
            # Truncate large results
            result_str = str(tool_result)
            result["tool_result"] = result_str[:2000] if len(result_str) > 2000 else result_str
            result["result_truncated"] = len(result_str) > 2000

        error_details = None
        if error or failure_mode:
            error_details = {}
            if error:
                error_details["error_message"] = error
            if failure_mode:
                error_details["failure_mode"] = failure_mode

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
            result=result,
            failure_mode=failure_mode,
            substeps_achieved=substeps_achieved,
            substeps_failed=substeps_failed,
            error_details=error_details
        )

        self.logger.info(entry.to_json())


# Global instance
_global_exec_logger: Optional[AgentExecutionLogger] = None


def get_execution_logger() -> AgentExecutionLogger:
    """Get or create global execution logger"""
    global _global_exec_logger
    if _global_exec_logger is None:
        _global_exec_logger = AgentExecutionLogger()
    return _global_exec_logger


def set_execution_logger(logger: AgentExecutionLogger):
    """Set global execution logger"""
    global _global_exec_logger
    _global_exec_logger = logger
