"""
Agent - Main reasoning and tool execution agent.
Handles user requests with tool usage and LLM reasoning.

Architecture: Plan → Wizard → Synthesis
- Planner: Creates explicit execution plans with success criteria
- Wizard: Orchestrates steps and workers over a single context window
- Synthesizer: Produces the final response
"""

import json
import time
import uuid
import os
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Callable
from enum import Enum

from util.config import AgentConfig, LLMConfig, DEFAULT_TIER_TOOL_LIMITS, DEFAULT_TIER_MAX_TOKENS
from communication.events import AgentProgressEvent, ToolProgressEvent, StreamingChunkEvent
from util.llm_adapter import (
    LLMAdapter, create_adapter, ToolDefinition
)
from util.perf_trace import PerfTracer
from .tool_registry import ToolRegistry
from util.logger import StructuredLogger
from util.agent_execution_logger import AgentExecutionLogger
from .planner import Planner
from .executor import Executor
from .reflector import Reflector
from .agent_logger import AgentLogger
from .plan_models import (
    Plan,
    ExecutionTrace,
    Reflection,
    PlanStatus,
#    PlanPhase,
    ToolCallRecord,
)
from .wizard import convert_plan_to_wizard_plan
from .wizard.context_window import SessionContext
from util.resilience import CircuitBreakerOpenError
from harness.context_manager import (
    ContextState,
    WorkingMemoryStore,
    ContextBuild,
    ContextPlanner,
    ContextSerializer,
    TokenEstimator,
    ToolTraceSummary,
    ArtifactRegistry,
    DefaultWritePolicy,
    CacheStrategy
)


class NullLogger:
    """
    A no-op logger that silently ignores all calls.
    Used when no logger is provided to avoid None checks everywhere.

    This class does NOT create files or access global state.
    """

    def __init__(self):
        self._session_id = str(uuid.uuid4())[:8]
        self._request_id = None

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def request_id(self) -> Optional[str]:
        return self._request_id

    def new_request(self) -> str:
        import time
        self._request_id = f"{self._session_id}-null-{int(time.time() * 1000) % 100000}"
        return self._request_id

    def __getattr__(self, name):
        """Return a no-op function for any method call."""
        def noop(*args, **kwargs):
            pass
        return noop


class NullExecutionLogger:
    """
    A no-op execution logger that silently ignores all calls.
    Used when no execution logger is provided.
    """

    def __init__(self):
        self._counter = 0

    def new_execution_id(self, req_id: str) -> str:
        self._counter += 1
        return f"{req_id}-null-exec-{self._counter:04d}"

    def __getattr__(self, name):
        """Return a no-op function for any method call."""
        def noop(*args, **kwargs):
            pass
        return noop


class AgentState(Enum):
    """Agent execution states"""
    IDLE = "idle"
    PLANNING = "planning"
    THINKING = "thinking"
    EXECUTING_TOOL = "executing_tool"
    REFLECTING = "reflecting"
    GENERATING_RESPONSE = "generating_response"
    COMPLETE = "complete"
    ERROR = "error"


@dataclass
class AgentStep:
    """A single step in agent execution"""
    step_number: int
    state: AgentState
    thought: Optional[str] = None
    tool_name: Optional[str] = None
    tool_input: Optional[Dict[str, Any]] = None
    tool_output: Optional[Any] = None
    response: Optional[str] = None
    duration_ms: float = 0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "step": self.step_number,
            "state": self.state.value,
            "thought": self.thought,
            "tool_name": self.tool_name,
            "tool_input": self.tool_input,
            "tool_output": str(self.tool_output)[:500] if self.tool_output else None,
            "response": self.response,
            "duration_ms": self.duration_ms,
            "error": self.error
        }


@dataclass
class AgentResponse:
    """Response from the agent"""
    content: str                          # The spoken/displayed response
    structured_action: Optional[str] = None  # Description of action taken (for ServiceRep)
    speech_text: Optional[str] = None     # Direct TTS text (bypasses LLM summarization if present)
    steps: List[AgentStep] = field(default_factory=list)
    total_duration_ms: float = 0
    tools_used: List[str] = field(default_factory=list)
    success: bool = True
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    # Plan/Execute/Reflect tracking
    plan: Optional[Plan] = None
    reflection: Optional[Reflection] = None
    goal_achieved: bool = True            # Did we actually achieve the user's goal?

    def to_dict(self) -> Dict[str, Any]:
        return {
            "content": self.content,
            "structured_action": self.structured_action,
            "speech_text": self.speech_text,
            "steps": [s.to_dict() for s in self.steps],
            "total_duration_ms": self.total_duration_ms,
            "tools_used": self.tools_used,
            "success": self.success,
            "error": self.error,
            "metadata": self.metadata,
            "goal_achieved": self.goal_achieved,
            "plan": self.plan.to_dict() if self.plan else None
        }


@dataclass
class TierRuntime:
    """Precomputed tier configuration and LLM state."""
    agent_config: AgentConfig
    llm_config: LLMConfig


class Agent:
    """
    Main reasoning and execution agent.
    Uses Plan → Execute → Reflect architecture for structured execution.
    """

    def __init__(
        self,
        config: AgentConfig,
        tool_registry: ToolRegistry,
        llm_config: Optional[LLMConfig] = None,
        event_bus: Optional[Any] = None,
        logger: Optional[StructuredLogger] = None,
        execution_logger: Optional[AgentExecutionLogger] = None,
        agent_logger: Optional[AgentLogger] = None,
        graphd_client: Optional[Any] = None
    ):
        """
        Initialize Agent.

        IMPORTANT: All loggers should be injected by the application root.
        This class does NOT create default loggers to avoid global state.

        Args:
            config: Agent configuration
            tool_registry: Registry of available tools
            llm_config: LLM configuration (optional, uses config.llm_config if not provided)
            event_bus: Optional EventBus for RL training
            logger: StructuredLogger for request/health logging (optional)
            execution_logger: AgentExecutionLogger for detailed traces (optional)
            agent_logger: AgentLogger for LLM request logging (optional)
            graphd_client: Optional GraphdClient for graph-based code intelligence (optional)
        """
        self.config = config
        self.tool_registry = tool_registry
        self._graphd_client = graphd_client
        # Use NullLogger fallbacks to avoid None checks everywhere
        # These do NOT create files or access global state
        self.logger = logger or NullLogger()
        self.exec_logger = execution_logger or NullExecutionLogger()
        self.event_bus = event_bus  # Optional EventBus for RL training
        self._agent_logger = agent_logger  # May be None - only logs if provided

        # Use provided LLM config or agent's config
        self._llm_config = llm_config or config.llm_config
        self._llm: Optional[LLMAdapter] = None
        if self._llm_config:
            self._llm = create_adapter(self._llm_config, logger=self.logger)
        self._stop_requested = False
        # Plan/Execute/Reflect components
        self._planner: Optional[Planner] = None
        self._executor: Optional[Executor] = None
        self._reflector: Optional[Reflector] = None
        if self._llm:
            self._planner = Planner(self._llm, tool_registry, graphd_client=self._graphd_client)
            self._executor = Executor(self._llm, tool_registry, config.max_tool_calls, graphd_client=self._graphd_client)
            self._reflector = Reflector(self._llm, tool_registry)
            if self._executor:
                self._executor.add_step_callback(self._handle_executor_step)

        # Wizard orchestration (single-writer global state)
        self._wizard: Optional["Wizard"] = None
        if self._llm:
            from .wizard import Wizard, WizardConfig
            self._wizard = Wizard(
                tool_registry=self.tool_registry,
                llm=self._llm,
                config=WizardConfig(),
                logger=self.logger,
            )

        # ========== CONTEXT MANAGER INTEGRATION ==========
        # Session-level persistent state
        # Create WorkingMemoryStore with working_dir, then pass to ContextState
        working_dir = os.getcwd()
        working_memory = WorkingMemoryStore(
            max_entries=100,
            working_dir=working_dir
        )
        # Load user rules from files (rules.md, repository.md) at session start
        self.context_state = ContextState(
            session_id=str(uuid.uuid4()),
            working_memory=working_memory,
            working_dir=working_dir,
            load_rules=True,
        )

        # Token estimator for accurate token counting
        provider = self._llm_config.provider if self._llm_config else "anthropic"
        model = self._llm_config.model if self._llm_config else "claude-3-5-sonnet-20241022"
        self.token_estimator = TokenEstimator(provider=provider, model=model)

        # Context planner and serializer
        self.context_planner = ContextPlanner(
            token_estimator=self.token_estimator,
            model_family="claude-3"  # For cache keys
        )
        self.context_serializer = ContextSerializer()

        # Tool trace for execution history
        self.tool_trace = ToolTraceSummary(max_turns=3)

        # Artifact registry for large content
        self.artifacts = ArtifactRegistry(
            max_artifacts=20,
            max_artifact_size=50_000
        )

        # Memory write policy for gating writes
        self.memory_policy = DefaultWritePolicy()

        # Execution state
        self._current_state = AgentState.IDLE
        self._step_count = 0
        self._steps: List[AgentStep] = []
        self._file_operations: List[Dict[str, Any]] = []
        self._current_request_id: Optional[str] = None

        # Callbacks
        self._step_callbacks: List[Callable[[AgentStep], None]] = []
        self._thought_callbacks: List[Callable[[str], None]] = []
        # Phase progress callbacks: (message: str, tool_name: Optional[str], step_number: int) -> None
        self._phase_callbacks: List[Callable[[str, Optional[str], int], None]] = []

        # ========== ASYNC LOGGING ==========
        # Note: self._agent_logger is injected via constructor, not created here

        # ========== PERFORMANCE TRACING ==========
        # Enable via AGENT_PERF_TRACE=1 environment variable
        self._perf_tracer = PerfTracer("agent", enabled=os.getenv("AGENT_PERF_TRACE", "0") == "1")
        # Lightweight per-step status tracker to feed execution context
        self._plan_status: Dict[int, Dict[str, Any]] = {}

    def _log_stage_1_agent_context(
        self,
        serialization_result: Any,
        user_input: str,
        tier: str,
        context_plan: Any
    ):
        """
        STAGE 1: Queue async logging of agent context.
        Non-blocking - actual I/O happens in background thread.
        """
        if self._agent_logger:
            self._agent_logger.log_stage_1_agent_context(serialization_result, user_input, tier, context_plan)

    def _log_stage_2_planning_result(
        self,
        plan: Any,
        user_input: str,
        tier: str
    ):
        """
        STAGE 2: Queue async logging of planning result.
        Non-blocking - actual I/O happens in background thread.
        """
        if self._agent_logger:
            self._agent_logger.log_stage_2_planning_result(plan, user_input, tier)

    def _log_stage_3_episode_summary(
        self,
        plan: Any,
        trace: Any,
        reflection: Any,
        user_input: str,
        tier: str,
        total_duration_ms: float
    ):
        """
        STAGE 3: Queue async logging of episode summary.
        Non-blocking - actual I/O happens in background thread.
        """
        if self._agent_logger:
            self._agent_logger.log_stage_3_episode_summary(plan, trace, reflection, user_input, tier, total_duration_ms)

    def _build_system_prompt(self) -> str:
        """Build system prompt - uses tier-specific prompt from config"""
        # The system prompt should already be tier-specific from TieredAgent
        # Just return it directly without adding extra verbose instructions
        return self.config.system_prompt

    def _shorten_text(self, text: Optional[str], max_length: int = 120) -> str:
        """Compact text for prompts without newlines or long rambles."""
        if not text:
            return ""
        clean = " ".join(str(text).split())
        if len(clean) <= max_length:
            return clean
        return clean[: max_length - 3] + "..."

    def _serialize_messages_for_planner(self, messages: List[Dict[str, Any]]) -> str:
        """Render persisted context messages into a readable planning transcript."""
        lines: List[str] = []
        for msg in messages:
            role = msg.get("role", "unknown").upper()
            content = msg.get("content")
            if content:
                lines.append(f"{role}: {content}")

            tool_calls = msg.get("tool_calls")
            if tool_calls:
                lines.append(f"{role} TOOL_CALLS: {json.dumps(tool_calls)}")

            tool_call_id = msg.get("tool_call_id")
            if tool_call_id:
                lines.append(f"{role} TOOL_CALL_ID: {tool_call_id}")

        return "\n".join(lines).strip()

    def _render_context_for_planner(
        self,
        session_state: Optional[SessionContext],
        extra_context: Optional[str],
    ) -> Optional[str]:
        """Build a single planning context string from session messages + extra context."""
        parts: List[str] = []
        if session_state and session_state.messages:
            serialized = self._serialize_messages_for_planner(session_state.messages)
            if serialized:
                parts.append(serialized)

        if extra_context:
            parts.append(f"Additional context:\n{extra_context}")

        if not parts:
            return None

        return "\n\n".join(parts)

    def _status_symbol(self, status: Any) -> str:
        """Map PlanStatus to a compact symbol for plan summaries."""
        try:
            status_enum = status if isinstance(status, PlanStatus) else PlanStatus(status)
        except Exception:
            status_enum = PlanStatus.PENDING

        if status_enum == PlanStatus.COMPLETED:
            return "✅"
        if status_enum == PlanStatus.PARTIAL:
            return "⚠️"
        if status_enum == PlanStatus.FAILED:
            return "⚠️"
        if status_enum == PlanStatus.SKIPPED:
            return "⚠️"
        return "⏳"  # Pending or in progress

    def _initialize_plan_status(self, plan: Plan) -> Dict[int, Dict[str, Any]]:
        """Seed plan status tracker with pending steps and short summaries."""
        status: Dict[int, Dict[str, Any]] = {}
        for step in plan.steps:
            status[step.step_num] = {
                "status": step.status if step.status else PlanStatus.PENDING,
                "summary": self._shorten_text(step.objective, 80)
            }
        return status

    def _format_plan_summary(
        self,
        plan: Plan,
        plan_status: Optional[Dict[int, Dict[str, Any]]]
    ) -> str:
        """Create a compact plan sketch to prepend to execution instructions."""
        if not plan or not plan.steps:
            return ""

        steps = sorted(plan.steps, key=lambda s: s.step_num)
        total_steps = len(steps)
        extra_steps = 0
        if total_steps > 15:
            extra_steps = total_steps - 10
            steps = steps[:10]

        lines: List[str] = [
            "PLAN SKETCH",
            f"Goal: {self._shorten_text(plan.goal, 180)}",
            "Steps:"
        ]

        for step in steps:
            entry = plan_status.get(step.step_num, {}) if plan_status else {}
            status_value = entry.get("status") or step.status or PlanStatus.PENDING
            try:
                status_enum = status_value if isinstance(status_value, PlanStatus) else PlanStatus(status_value)
            except Exception:
                status_enum = PlanStatus.PENDING
            symbol = self._status_symbol(status_enum)
            summary = entry.get("summary") or self._shorten_text(step.objective, 80)
            tool_hint = f" tool:{step.tool_hint}" if step.tool_hint else ""
            deps = f" deps:{','.join(str(d) for d in step.depends_on)}" if step.depends_on else ""
            step_line = f"{step.step_num} {symbol} {summary}{tool_hint}{deps}"
            lines.append(self._shorten_text(step_line, 160))

        if extra_steps:
            lines.append(f"+{extra_steps} more steps")

        plan_text = "\n".join(lines).strip()
        if len(plan_text) > 2000:
            plan_text = plan_text[:2000]
        return plan_text

    def _augment_context_with_plan(
        self,
        serialized_context: Dict[str, Any],
        plan: Plan,
        plan_status: Optional[Dict[int, Dict[str, Any]]]
    ) -> Dict[str, Any]:
        """
        Prepend compact plan sketch to instructions without changing the shape
        of the serialized context payload.
        """
        if not serialized_context or "instructions" not in serialized_context:
            return serialized_context

        plan_summary = self._format_plan_summary(plan, plan_status)
        if not plan_summary:
            return serialized_context

        combined_instructions = f"{plan_summary}\n\n{serialized_context.get('instructions', '')}".strip()
        updated_context = dict(serialized_context)
        updated_context["instructions"] = combined_instructions
        return updated_context

    def _get_tool_definitions(self) -> List[ToolDefinition]:
        """Get tool definitions for LLM"""
        return self.tool_registry.get_definitions(enabled_only=True)

    def _record_step(self, step: AgentStep):
        """Record an execution step"""
        self._steps.append(step)
        for callback in self._step_callbacks:
            try:
                callback(step)
            except Exception as e:
                self.logger.error(f"Step callback error: {e}", component="agent")

    def _handle_executor_step(self, plan_step_num: int, record: ToolCallRecord):
        """
        Forward executor tool call events to agent step callbacks for progress updates.
        """
        agent_step = AgentStep(
            step_number=self._step_count,
            state=AgentState.EXECUTING_TOOL,
            tool_name=record.tool_name,
            tool_input=record.arguments,
            tool_output=record.result.output if record.result.is_success else record.result.error,
            duration_ms=record.duration_ms,
            error=None if record.result.is_success else record.result.error
        )
        self._step_count += 1

        metadata = record.result.metadata or {}
        paths = []
        if metadata.get("path"):
            paths.append(metadata["path"])
        if metadata.get("paths"):
            extra_paths = metadata["paths"]
            if isinstance(extra_paths, list):
                paths.extend(extra_paths)
            else:
                paths.append(extra_paths)
        action = metadata.get("action", record.tool_name)
        for path in paths:
            self._record_file_operation(path, record.tool_name, action)

        self._record_step(agent_step)
        preview = None
        if record.result.is_success and record.result.output:
            preview = str(record.result.output)
        elif record.result.error:
            preview = str(record.result.error)
        status = "completed" if record.result.is_success else "failed"
        self._publish_tool_progress(record.tool_name, status, plan_step_num, preview)

    def _record_file_operation(self, path: str, tool_name: str, action: str):
        """Track file operations requested by tools"""
        if not path:
            return
        entry = {
            "path": path,
            "tool": tool_name,
            "action": action,
            "timestamp": time.time()
        }
        self._file_operations.append(entry)
        self.logger.file_operation(
            "agent_file",
            path,
            status="noted",
            detail=f"tool={tool_name} action={action}",
            component="agent"
        )

    def _publish_event(self, event: Any) -> None:
        """Publish event to bus if available."""
        if not self.event_bus:
            return
        publish = getattr(self.event_bus, "publish", None)
        if not callable(publish):
            return
        try:
            publish(event)
        except Exception as exc:
            self.logger.error(f"Event bus publish failed: {exc}", component="agent")

    def _publish_agent_progress(self, message: str, tool_name: Optional[str] = None, step_number: int = 0) -> None:
        """Publish AgentProgressEvent for listeners (TUI, telemetry, etc.).

        This method:
        1. Notifies phase callbacks (for Harness -> ServiceRep -> TUI flow)
        2. Publishes to event bus if available (direct event publishing)
        """
        # Always notify phase callbacks (primary mechanism for progress)
        self._notify_phase(message, tool_name, step_number)

        # Also publish to event bus if available and we have a request ID
        if self._current_request_id:
            event = AgentProgressEvent(
                request_id=self._current_request_id,
                message=message,
                tool_name=tool_name,
                step_number=step_number
            )
            self._publish_event(event)

    def _publish_tool_progress(
        self,
        tool_name: Optional[str],
        status: str,
        step_number: int,
        result_preview: Optional[str] = None
    ) -> None:
        """Publish ToolProgressEvent for detailed instrumentation."""
        if not self._current_request_id or not tool_name:
            return
        preview = (result_preview or "")[:200] if result_preview else None
        event = ToolProgressEvent(
            request_id=self._current_request_id,
            tool_name=tool_name,
            status=status,
            step_num=step_number,
            result_preview=preview
        )
        self._publish_event(event)

    def _publish_stream_chunk(self, chunk: str, chunk_index: int, is_final: bool) -> None:
        """Publish streaming chunk events for downstream consumers."""
        if not self._current_request_id:
            return
        event = StreamingChunkEvent(
            request_id=self._current_request_id,
            chunk=chunk,
            chunk_index=chunk_index,
            is_final=is_final
        )
        self._publish_event(event)
        if is_final:
            self._publish_agent_progress("Streaming response complete", step_number=0)

    def _build_contract_checklist(
        self,
        user_input: str,
        plan: Plan,
        trace: ExecutionTrace,
        reflection: Reflection
    ) -> Dict[str, str]:
        """Compile the mandatory execution contract before responding."""
        intent_summary = plan.goal or user_input

        results_by_step = {sr.step_num: sr for sr in trace.step_results}
        discovery_items: List[str] = []
        for step in plan.discovery_plan:
            step_result = results_by_step.get(step.step_num)
            if not step_result:
                continue
            tool_names = sorted({record.tool_name for record in step_result.tool_calls_made})
            if tool_names:
                discovery_items.append(f"{step.objective} via {', '.join(tool_names)}")
            else:
                discovery_items.append(f"{step.objective} (reasoned only)")

        if not discovery_items:
            if plan.discovery_required:
                discovery_summary = "Discovery incomplete - no evidence captured"
            else:
                discovery_summary = "Discovery skipped (request was self-contained)"
        else:
            max_items = 4
            summary_slice = discovery_items[:max_items]
            discovery_summary = "; ".join(summary_slice)
            if len(discovery_items) > max_items:
                discovery_summary += f"; +{len(discovery_items) - max_items} more discovery actions"

        if self._file_operations:
            changes = []
            for op in self._file_operations[:5]:
                changes.append(f"{op['action']} {op['path']}")
            if len(self._file_operations) > 5:
                changes.append(f"+{len(self._file_operations) - 5} more operations")
            changes_summary = "; ".join(changes)
        else:
            changes_summary = "No files modified; provided analysis/instructions"

        validation_actions: List[str] = []
        for step_result in trace.step_results:
            for record in step_result.tool_calls_made:
                arguments = record.arguments or {}
                command = arguments.get("command") or arguments.get("code") or ""
                command_str = str(command)
                if record.tool_name == "bash_execute" and any(
                    keyword in command_str for keyword in ["pytest", "unittest", "npm test", "go test"]
                ):
                    validation_actions.append(f"{record.tool_name}: {command_str}")
                elif record.tool_name == "python_execute" and "pytest" in command_str:
                    validation_actions.append(f"{record.tool_name}: pytest run")
        if validation_actions:
            validation_summary = "; ".join(validation_actions[:3])
            if len(validation_actions) > 3:
                validation_summary += f"; +{len(validation_actions) - 3} more checks"
        else:
            validation_summary = "Validation via reasoning and inspection (no automated tests run)"

        if reflection.goal_achieved:
            remaining_summary = "Nothing pending"
        else:
            remaining_summary = "; ".join(reflection.gaps) if reflection.gaps else "Goal not fully achieved"

        contract = {
            "user_intent": intent_summary,
            "context_inspected": discovery_summary,
            "changes_made": changes_summary,
            "validation": validation_summary,
            "remaining": remaining_summary
        }
        return contract

    def _emit_thought(self, thought: str):
        """Emit a thought to callbacks"""
        self.logger.agent_thinking(thought)
        for callback in self._thought_callbacks:
            try:
                callback(thought)
            except Exception as e:
                self.logger.error(f"Thought callback error: {e}", component="agent")

    def stop(self):
        """Request the agent to stop execution at next checkpoint"""
        self._stop_requested = True
        self.logger.info("Agent stop requested", component="agent")
    
    def run(
        self,
        user_input: str,
        context: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None,
        classification: Optional[Any] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
        session_context: Optional[Dict[str, Any]] = None,
    ) -> AgentResponse:
        """
        Run the agent using Wizard orchestration.

        1. PLAN: Create explicit execution plan with success criteria
        2. WIZARD: Execute plan via Wizard + Workers
        3. SYNTHESIZE: Generate final response

        Args:
            user_input: The user's request
            context: Optional additional context
            budget: Budget constraints from router - MUST be enforced
            classification: Full TaskClassification for logging
            on_stream_chunk: Optional callback for streaming final response synthesis.
                            Called with (chunk: str, chunk_index: int, is_final: bool)
            session_context: Optional context from graphd session for hydration.
                            Contains persisted messages, read_files, and cache state.
                            This enables multi-turn conversation continuity.

        Returns:
            AgentResponse with content, plan, and reflection
        """
        if not self._llm:
            return AgentResponse(
                content="Agent not properly configured. No LLM available.",
                success=False,
                error="No LLM configured"
            )

        # Store budget for enforcement during execution
        self._budget = budget
        self._classification = classification

        # Reset tracer for this run
        self._perf_tracer.reset()

        start_time = time.time()
        self._step_count = 0
        self._steps = []
        self._file_operations = []
        self._plan_status = {}
        contract_checklist: Optional[Dict[str, str]] = None

        if self.logger.request_id is None:
            req_id = self.logger.new_request()
        else:
            req_id = self.logger.request_id
        exec_id = self.exec_logger.new_execution_id(req_id)
        self._current_request_id = req_id
        self._publish_agent_progress("Request received", step_number=0)

        # ========== SESSION CONTEXT HYDRATION ==========
        session_state: Optional[SessionContext] = None
        if session_context:
            try:
                session_state = SessionContext.from_session_dict(session_context)
                self.logger.info(
                    f"Hydrated SessionContext: {len(session_state.messages)} messages, "
                    f"{len(session_state.read_files)} files read",
                    component="agent",
                )
            except Exception as e:
                self.logger.warning(
                    f"Failed to hydrate SessionContext: {e}",
                    component="agent",
                )
                session_state = None
        planning_context = self._render_context_for_planner(session_state, context)

        # ========== WIZARD ORCHESTRATION PATH ==========
        # Create plan using existing planner
        plan = self._planner.create_plan(
            user_input=user_input,
            context=planning_context,
            tier=self.config.tier,
            budget=budget
        )
        # Convert to WizardPlan format
        wizard_plan = convert_plan_to_wizard_plan(plan)

        result = self._wizard.orchestrate(
            plan=wizard_plan,
            user_input=user_input,
            request_context=context,
            budget=budget,
            on_stream_chunk=on_stream_chunk,
            session_context=session_state,
        )

        # Build metadata including final context state for session persistence
        response_metadata = result.to_dict().get("metadata", {})
        if result.final_context_state:
            response_metadata["final_context_state"] = result.final_context_state

        return AgentResponse(
            content=result.final_response,
            structured_action=result.plan_state.goal,
            total_duration_ms=result.duration_ms,
            success=result.success,
            goal_achieved=result.goal_achieved,
            reflection=result.to_reflection(),
            metadata=response_metadata,
        )


    def add_step_callback(self, callback: Callable[[AgentStep], None]):
        """Add callback for execution steps"""
        self._step_callbacks.append(callback)

    def remove_step_callback(self, callback: Callable[[AgentStep], None]):
        """Remove a previously registered step callback"""
        if callback in self._step_callbacks:
            self._step_callbacks.remove(callback)

    def add_thought_callback(self, callback: Callable[[str], None]):
        """Add callback for agent thoughts"""
        self._thought_callbacks.append(callback)

    def add_phase_callback(self, callback: Callable[[str, Optional[str], int], None]):
        """Add callback for phase progress updates.

        Callback signature: (message: str, tool_name: Optional[str], step_number: int) -> None

        Phase callbacks fire at key points during execution:
        - Planning started/completed
        - Execution started
        - Tool executions (with tool_name)
        - Reflection started/completed
        - Goal achieved/not achieved
        """
        self._phase_callbacks.append(callback)

    def remove_phase_callback(self, callback: Callable[[str, Optional[str], int], None]):
        """Remove a previously registered phase callback"""
        if callback in self._phase_callbacks:
            self._phase_callbacks.remove(callback)

    def _notify_phase(self, message: str, tool_name: Optional[str] = None, step_number: int = 0):
        """Notify all phase callbacks of progress.

        This is the primary mechanism for agents to report progress to listeners
        (e.g., Harness -> ServiceRep -> TUI).
        """
        for callback in self._phase_callbacks:
            try:
                callback(message, tool_name, step_number)
            except Exception as e:
                self.logger.error(f"Phase callback error: {e}", component="agent")

    @property
    def state(self) -> AgentState:
        """Get current agent state"""
        return self._current_state

    @property
    def is_stop_requested(self) -> bool:
        """Check if stop has been requested"""
        return self._stop_requested


# =============================================================================
# TIER-SPECIFIC SYSTEM PROMPTS - Loaded from config
# =============================================================================

def _load_tier_prompts():
    """Load tier-specific prompts from config file"""
    import json
    from pathlib import Path

    config_path = Path(__file__).parent.parent / "config" / "prompts_config.json"
    try:
        with open(config_path, 'r') as f:
            data = json.load(f)
            return data.get("agent_tier_prompts", {})
    except Exception:
        # Fallback to hardcoded defaults if config fails to load
        return {
            "simple": "You are a fast assistant. Answer from your own knowledge unless the user explicitly asks for a lookup or the request is about fresh data (time/date/weather/stocks/news).\n\nPrinciples:\n- Be decisive and brief (under 40 words).\n- ZERO tools unless the user asks you to search OR it's clearly fresh-data.\n- No preambles; just give the answer.\n\nAvailable tools (use only if necessary):\n{tools}",
            "standard": "You are a capable assistant. Optimize for fast, accurate answers with minimal tool use.\n\nPrinciples:\n- First, answer directly if you can. Only reach for tools when data is missing, stale, or explicitly requested.\n- Keep responses concise and clear; avoid boilerplate.\n\nAvailable tools:\n{tools}",
            "advanced": "You are an expert personal CLI assistant for complex tasks. Optimize for correctness and clarity.\n\nPrinciples:\n- Quickly outline the plan. This could be multiple steps and also could require discovery if called from an existing system. You are highly capable of multi-turn robust plans and should be very detail oriented for complex tasks. Use tools only where they add real evidence or fresh data.\n- Prefer fewer, high-impact tool calls (max 10). Avoid trivial tool calls (e.g., time) unless requested.\n- Double-check critical facts; provide a crisp, helpful final answer.\n\nAvailable tools:\n{tools}"
        }

# Load tier prompts from config
_TIER_PROMPTS = _load_tier_prompts()

SIMPLE_TIER_PROMPT = _TIER_PROMPTS.get("simple", "")
STANDARD_TIER_PROMPT = _TIER_PROMPTS.get("standard", "")
ADVANCED_TIER_PROMPT = _TIER_PROMPTS.get("advanced", "")

# Tool call limits and max tokens are driven by the JSON config defaults above
TIER_TOOL_LIMITS = DEFAULT_TIER_TOOL_LIMITS
TIER_MAX_TOKENS = DEFAULT_TIER_MAX_TOKENS


class TieredAgent:
    """
    Agent that operates with tier-specific behavior.
    Each tier has different prompts, tool limits, and response styles.

    IMPORTANT: All loggers should be injected by the application root.
    This class does NOT create default loggers to avoid global state.
    """

    def __init__(
        self,
        config: AgentConfig,
        tool_registry: ToolRegistry,
        tier_configs: Dict[str, LLMConfig],
        event_bus: Optional[Any] = None,
        logger: Optional[StructuredLogger] = None,
        execution_logger: Optional[AgentExecutionLogger] = None,
        agent_logger: Optional[AgentLogger] = None,
        graphd_client: Optional[Any] = None
    ):
        """
        Initialize TieredAgent.

        Args:
            config: Agent configuration
            tool_registry: Registry of available tools
            tier_configs: LLM configs per tier
            event_bus: Optional EventBus for RL training
            logger: StructuredLogger for request/health logging (optional)
            execution_logger: AgentExecutionLogger for detailed traces (optional)
            agent_logger: AgentLogger for LLM request logging (optional)
            graphd_client: Optional GraphdClient for graph-based code intelligence (optional)
        """
        self.config = config
        self.tool_registry = tool_registry
        self.tier_configs = tier_configs
        self.event_bus = event_bus
        self._graphd_client = graphd_client
        self._agents: Dict[str, Agent] = {}
        self._tier_runtimes: Dict[str, TierRuntime] = {}
        self._current_tier = config.tier
        # Use NullLogger fallbacks - no global state access
        self.logger = logger or NullLogger()
        self.execution_logger = execution_logger or NullExecutionLogger()
        self._agent_logger = agent_logger  # May be None
        self._prepare_tier_runtimes()

    def _get_tier_prompt(self, tier: str) -> str:
        """Get the appropriate system prompt for the tier"""
        tools = self.tool_registry.list_tools(enabled_only=True)
        tool_descriptions = "\n".join([f"- {t.name}: {t.description}" for t in tools])

        # Get prompt template from config
        prompt_template = _TIER_PROMPTS.get(tier, _TIER_PROMPTS.get("standard"))
        return prompt_template.format(tools=tool_descriptions)

    def _prepare_tier_runtimes(self):
        """Pre-compute tier runtimes so switching tiers is deterministic."""
        for tier in self._resolve_tier_names():
            self._tier_runtimes[tier] = self._build_tier_runtime(tier)

    def _resolve_tier_names(self) -> List[str]:
        """Determine which tiers should be available."""
        tiers = set(self.config.tier_tool_limits.keys())
        tiers.add(self.config.tier)
        for tier in self.tier_configs.keys():
            if tier in DEFAULT_TIER_TOOL_LIMITS or tier in DEFAULT_TIER_MAX_TOKENS:
                tiers.add(tier)
        return sorted(tiers)

    def _build_tier_runtime(self, tier: str) -> TierRuntime:
        """Create the AgentConfig/LLMConfig pair for a tier."""
        base_llm_config = (
            self.tier_configs.get(tier)
            or self.tier_configs.get("standard")
            or self.config.llm_config
        )
        if not base_llm_config:
            raise ValueError(f"No LLM config available for tier '{tier}'")

        tier_max_tokens = self.config.tier_max_tokens.get(tier)
        if tier_max_tokens is None:
            llm_base_max = getattr(self.config.llm_config, "max_tokens", None) if self.config.llm_config else None
            tier_max_tokens = llm_base_max or DEFAULT_TIER_MAX_TOKENS.get(tier, 500)

        llm_config = LLMConfig(
            provider=base_llm_config.provider,
            model=base_llm_config.model,
            api_key=base_llm_config.api_key,
            api_base=base_llm_config.api_base,
            max_tokens=tier_max_tokens,
            max_completion_tokens=tier_max_tokens,
            failover_models=getattr(base_llm_config, "failover_models", []),
            temperature=base_llm_config.temperature,
            top_p=base_llm_config.top_p,
            timeout=base_llm_config.timeout,
            max_retries=base_llm_config.max_retries,
            retry_delay=base_llm_config.retry_delay,
            retry_backoff_multiplier=base_llm_config.retry_backoff_multiplier,
            retry_backoff_max=base_llm_config.retry_backoff_max,
            retry_jitter=base_llm_config.retry_jitter,
            circuit_breaker_threshold=base_llm_config.circuit_breaker_threshold,
            circuit_breaker_cooldown=base_llm_config.circuit_breaker_cooldown,
            circuit_breaker_half_open_successes=base_llm_config.circuit_breaker_half_open_successes,
            streaming=base_llm_config.streaming
        )

        tool_limit = self.config.tier_tool_limits.get(tier, self.config.max_tool_calls)

        tier_config = AgentConfig(
            llm_config=llm_config,
            tier=tier,
            system_prompt=self._get_tier_prompt(tier),
            max_tool_calls=tool_limit,
            tool_timeout=self.config.tool_timeout,
            allow_code_execution=self.config.allow_code_execution,
            allow_internet=self.config.allow_internet,
            allow_bash=self.config.allow_bash,
            tier_tool_limits=self.config.tier_tool_limits,
            tier_max_tokens=self.config.tier_max_tokens
        )

        self.logger.system_init("agent", f"configured_{tier}", {
            "max_tokens": tier_max_tokens,
            "max_tools": tool_limit
        })

        return TierRuntime(agent_config=tier_config, llm_config=llm_config)

    def _get_agent(self, tier: str) -> Agent:
        """Get or create agent for tier with tier-specific config"""
        if tier not in self._tier_runtimes:
            self._tier_runtimes[tier] = self._build_tier_runtime(tier)

        if tier not in self._agents:
            runtime = self._tier_runtimes[tier]
            self._agents[tier] = Agent(
                runtime.agent_config,
                self.tool_registry,
                runtime.llm_config,
                self.event_bus,
                logger=self.logger,
                execution_logger=self.execution_logger,
                agent_logger=self._agent_logger,
                graphd_client=self._graphd_client
            )
        return self._agents[tier]

    def get_agent_for_tier(self, tier: str) -> Agent:
        """Public accessor for tier-specific Agent instances."""
        return self._get_agent(tier)

    def prewarm_all_tiers(self) -> List[str]:
        """Prewarm every tier's LLM adapter to keep connections warm."""
        warmed: List[str] = []
        warmed_keys = set()

        for tier in self._resolve_tier_names():
            agent = self._get_agent(tier)
            if not agent._llm:
                continue

            provider = agent._llm.provider
            model = agent._llm.config.model if agent._llm.config else "unknown"
            key = f"{provider}:{model}"
            prewarm_fn = getattr(agent._llm, "prewarm", None)
            if callable(prewarm_fn):
                try:
                    if key in warmed_keys or prewarm_fn():
                        warmed_keys.add(key)
                        warmed.append(tier)
                    else:
                        self.logger.warning(
                            f"Prewarm returned False for tier {tier}",
                            component="agent"
                        )
                except Exception as exc:
                    self.logger.error(
                        f"Prewarm failed for tier {tier}: {exc}",
                        component="agent"
                    )
            else:
                warmed.append(tier)

        return warmed

    def run(
        self,
        user_input: str,
        tier: str = None,
        context: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None,
        classification: Optional[Any] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
        session_context: Optional[Dict[str, Any]] = None,
    ) -> AgentResponse:
        """
        Run with specified tier and tier-appropriate behavior.

        Args:
            user_input: The user's request
            tier: Which tier to use (simple/standard/advanced)
            context: Optional additional context
            budget: Budget constraints from router (max_tool_calls, max_tokens, max_steps)
            classification: Full TaskClassification from router (for logging/debugging)
            on_stream_chunk: Optional callback for streaming final response synthesis.
                            Called with (chunk: str, chunk_index: int, is_final: bool)
            session_context: Optional context from graphd session for hydration.
                            Contains persisted messages, read_files, and cache state.
        """
        tier = tier or self._current_tier

        # Use budget from classification if provided, otherwise fall back to config
        if budget:
            tool_limit = budget.get("max_tool_calls")
            max_steps = budget.get("max_steps")
        else:
            tool_limit = self.config.tier_tool_limits.get(tier)
            max_steps = None

        if tool_limit is None:
            tool_limit = self.config.max_tool_calls

        self.logger.debug(
            f"Running agent at tier '{tier}' (max {tool_limit} tools, max {max_steps} steps)",
            component="agent"
        )

        agent = self._get_agent(tier)

        # Pass budget, streaming callback, and session context to agent
        return agent.run(
            user_input, context,
            budget=budget,
            classification=classification,
            on_stream_chunk=on_stream_chunk,
            session_context=session_context,
        )

    def set_tier(self, tier: str):
        """Set default tier"""
        self._current_tier = tier

    @property
    def current_tier(self) -> str:
        return self._current_tier
