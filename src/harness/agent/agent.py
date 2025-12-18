"""
Agent - Main reasoning and tool execution agent.
Handles user requests with tool usage and LLM reasoning.

Architecture: Plan → Execute → Reflect
- Planner: Creates explicit execution plans with success criteria
- Executor: Runs plans step-by-step with validation
- Reflector: Evaluates if goal was actually achieved
"""

import json
import time
import uuid
import os
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List, Generator, Callable, Tuple
from enum import Enum

from util.config import AgentConfig, LLMConfig, DEFAULT_TIER_TOOL_LIMITS, DEFAULT_TIER_MAX_TOKENS
from communication.events import AgentProgressEvent, ToolProgressEvent, StreamingChunkEvent
from util.llm_adapter import (
    LLMAdapter, create_adapter, Message, MessageRole,
    LLMResponse, ToolCall, ToolDefinition
)
from util.perf_trace import PerfTracer
from .tool_registry import ToolRegistry, ToolResult, ToolStatus
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
    PlanPhase,
    ToolCallRecord,
)
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
            self._planner = Planner(self._llm, tool_registry)
            self._executor = Executor(self._llm, tool_registry, config.max_tool_calls, graphd_client=self._graphd_client)
            self._reflector = Reflector(self._llm, tool_registry)
            if self._executor:
                self._executor.add_step_callback(self._handle_executor_step)

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

    def _needs_realtime_data(self, user_input: str) -> bool:
        """
        Detect if the query requires real-time data (weather, stocks, news, etc.)
        These queries MUST use tools - the model cannot answer from memory.
        """
        input_lower = user_input.lower()

        # Keywords that indicate real-time data is needed
        realtime_keywords = [
            "weather", "temperature", "forecast", "rain", "sunny", "cloudy",
            "stock", "price", "market", "trading", "shares",
            "news", "today", "current", "right now", "latest",
            "score", "game", "match", "playing",
            "traffic", "flight", "status",
            "bitcoin", "crypto", "btc", "eth",
            "exchange rate", "currency"
        ]

        return any(keyword in input_lower for keyword in realtime_keywords)

    def _needs_file_tools(self, user_input: str) -> bool:
        """
        Detect if the query clearly requires file system operations.
        """
        input_lower = user_input.lower()

        trigger_phrases = [
            "create file", "write file", "append file", "new file",
            "add file", "make file", "generate file", "remove file",
            "delete file", "edit file", "save file", "open file",
            "create folder", "create directory", "write script",
            "save script", "create test", "generate script"
        ]

        if any(phrase in input_lower for phrase in trigger_phrases):
            return True

        verbs = ["create", "write", "append", "add", "save", "edit", "update", "delete", "remove", "generate"]
        nouns = ["file", "folder", "directory", "script", "code", "config", "project"]

        if any(verb in input_lower for verb in verbs) and any(noun in input_lower for noun in nouns):
            return True

        return False

    def _is_tool_read_only(self, tool_name: Optional[str]) -> bool:
        """Check if a tool is marked read-only in the registry."""
        if not tool_name:
            return False
        tool = self.tool_registry.get(tool_name) if hasattr(self.tool_registry, "get") else None
        return bool(tool and getattr(tool, "read_only", False))

    def _shorten_text(self, text: Optional[str], max_length: int = 120) -> str:
        """Compact text for prompts without newlines or long rambles."""
        if not text:
            return ""
        clean = " ".join(str(text).split())
        if len(clean) <= max_length:
            return clean
        return clean[: max_length - 3] + "..."

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

    def _is_fast_path_eligible(self, user_input: str, budget: Optional[Dict[str, int]] = None) -> bool:
        """
        Determine if a query can skip the full context building workflow.

        Fast path criteria:
        - Simple question that doesn't need file context
        - Single-tool lookup (weather, search) with known args
        - No dependencies on working memory or filesystem context

        This saves 150-500ms of context building overhead.
        """
        input_lower = user_input.lower().strip()

        # Skip fast path if context is explicitly needed
        if self._needs_file_tools(user_input):
            return False

        # Skip fast path if we have significant working memory
        if len(self.context_state.working_memory.entries) > 10:
            return False

        # Fast path for simple questions
        simple_question_starters = [
            "what is", "what's", "what does", "who is", "who's", "when did",
            "where is", "how many", "how much", "define", "explain"
        ]
        is_simple_question = any(input_lower.startswith(q) for q in simple_question_starters)

        # Fast path for weather/search (single tool, known pattern)
        is_realtime_lookup = self._needs_realtime_data(user_input)

        # Fast path eligible if simple question OR simple realtime lookup
        if is_simple_question and len(input_lower) < 200:
            return True

        if is_realtime_lookup and len(input_lower) < 100:
            return True

        return False

    def _execute_fast_path(
        self,
        user_input: str,
        context: Optional[str],
        start_time: float
    ) -> Optional[AgentResponse]:
        """
        Execute fast path with minimal overhead.

        Skips:
        - Full context building
        - Token estimation
        - Cache planning
        - Working memory serialization

        Returns None if fast path cannot complete (falls back to normal path).
        """
        try:
            # Use the simple planner for pattern matching
            simple_plan = self._planner._try_simple_plan(user_input)

            if simple_plan is None:
                # Pattern not recognized, fall back to normal path
                return None

            # For questions that don't need tools, just answer directly
            if not simple_plan.requires_tools:
                prompt_input = user_input
                if context:
                    prompt_input = f"{user_input}\n\nContext: {context}"

                response = self._llm.respond(
                    input=prompt_input,
                    instructions=self._build_system_prompt()
                )
                duration_ms = (time.time() - start_time) * 1000

                self.logger.debug(f"Fast path completed in {duration_ms:.0f}ms (no tools)", component="agent")

                return AgentResponse(
                    content=response.content or "",
                    total_duration_ms=duration_ms,
                    tools_used=[],
                    success=True,
                    goal_achieved=True,
                    plan=simple_plan,
                    reflection=Reflection(
                        plan_goal=simple_plan.goal,
                        goal_achieved=True,
                        confidence=0.95,
                        evidence=["Fast path execution"],
                        gaps=[],
                        suggestions=[]
                    ),
                    metadata={
                        "fast_path": True,
                        "tier": self.config.tier,
                        "model": self._llm_config.model if self._llm_config else None
                    }
                )

            # For single-tool queries with known args (e.g., search), execute directly
            if (len(simple_plan.steps) == 1 and
                simple_plan.steps[0].tool_hint and
                simple_plan.steps[0].tool_args_hint):

                step = simple_plan.steps[0]
                if not self._is_tool_read_only(step.tool_hint):
                    self.logger.info(
                        f"Fast path blocked for write-capable tool '{step.tool_hint}'",
                        component="agent"
                    )
                    return None

                if self._budget and self._budget.get("max_tool_calls", 1) < 1:
                    self.logger.info(
                        "Fast path blocked by tool budget (0 allowed)",
                        component="agent"
                    )
                    return None

                tool_start = time.time()
                result = self.tool_registry.execute(step.tool_hint, **step.tool_args_hint)
                tool_duration = (time.time() - tool_start) * 1000
                duration_ms = (time.time() - start_time) * 1000

                if result.is_success:
                    self.logger.debug(
                        f"Fast path completed in {duration_ms:.0f}ms (direct tool: {step.tool_hint})",
                        component="agent"
                    )

                    return AgentResponse(
                        content=str(result.output)[:2000],
                        total_duration_ms=duration_ms,
                        tools_used=[step.tool_hint],
                        success=True,
                        goal_achieved=True,
                        plan=simple_plan,
                        reflection=Reflection(
                            plan_goal=simple_plan.goal,
                            goal_achieved=True,
                            confidence=0.95,
                            evidence=[f"Direct tool execution: {step.tool_hint}"],
                            gaps=[],
                            suggestions=[]
                        ),
                        metadata={
                            "fast_path": True,
                            "direct_tool": step.tool_hint,
                            "tool_duration_ms": tool_duration,
                            "tier": self.config.tier
                        }
                    )
                else:
                    # Tool failed, fall back to normal path for error handling
                    return None

            # Pattern matched but execution path unclear, fall back
            return None

        except Exception as e:
            self.logger.warning(f"Fast path failed, falling back: {e}", component="agent")
            return None

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

    def run_simple_response(
        self,
        user_input: str,
        context: Optional[str] = None
    ) -> AgentResponse:
        """
        Simple-tier fast path: single LLM call with minimal context.
        """
        if not self._llm:
            return AgentResponse(
                content="Agent not configured with an LLM backend.",
                success=False,
                error="No LLM configured"
            )

        start_time = time.time()
        prompt_input = user_input
        if context:
            prompt_input = f"{user_input}\n\nContext: {context}"

        try:
            response = self._llm.respond(
                input=prompt_input,
                instructions=self._build_system_prompt()
            )
            duration_ms = (time.time() - start_time) * 1000
            content = response.content or ""

            if response.has_tool_calls:
                self.logger.warning(
                    "Simple tier response ignored tool calls",
                    component="agent"
                )

            return AgentResponse(
                content=content,
                total_duration_ms=duration_ms,
                tools_used=[],
                success=True,
                metadata={
                    "tier": self.config.tier,
                    "fast_path": "simple",
                    "model": self._llm_config.model if self._llm_config else None
                }
            )

        except Exception as exc:
            duration_ms = (time.time() - start_time) * 1000
            self.logger.error(f"Simple tier completion failed: {exc}", component="agent")
            return AgentResponse(
                content="I ran into an error answering that.",
                success=False,
                error=str(exc),
                total_duration_ms=duration_ms,
                metadata={
                    "tier": self.config.tier,
                    "fast_path": "simple",
                    "model": self._llm_config.model if self._llm_config else None
                }
            )

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
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None
    ) -> AgentResponse:
        """
        Run the agent using Plan → Execute → Reflect architecture.

        1. PLAN: Create explicit execution plan with success criteria
        2. EXECUTE: Run the plan step by step
        3. REFLECT: Evaluate if the goal was actually achieved

        Args:
            user_input: The user's request
            context: Optional additional context
            budget: Budget constraints from router - MUST be enforced
            classification: Full TaskClassification for logging
            on_stream_chunk: Optional callback for streaming final response synthesis.
                            Called with (chunk: str, chunk_index: int, is_final: bool)

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

        # Add context if provided
        full_input = user_input
        if context:
            full_input = f"{user_input}\n\nContext: {context}"

        if self.logger.request_id is None:
            req_id = self.logger.new_request()
        else:
            req_id = self.logger.request_id
        exec_id = self.exec_logger.new_execution_id(req_id)
        self._current_request_id = req_id
        self._publish_agent_progress("Request received", step_number=0)

        # ========== FAST PATH FOR SIMPLE QUERIES ==========
        # Skip context building for queries that don't need filesystem/history context
        # This saves 150-500ms per request
        with self._perf_tracer.span("fast_path_check"):
            if self._is_fast_path_eligible(user_input, budget):
                with self._perf_tracer.span("fast_path_execute"):
                    fast_response = self._execute_fast_path(user_input, context, start_time)
                if fast_response is not None:
                    self._publish_agent_progress("Responded via fast path", step_number=0)
                    self._perf_tracer.print_summary()
                    self._current_request_id = None
                    return fast_response

        # ========== CONTEXT MANAGER WORKFLOW ==========
        with self._perf_tracer.span("context_manager_workflow"):
            # 1. Build context for request
            with self._perf_tracer.span("context_build"):
                context_build = ContextBuild.from_request(
                    state=self.context_state,
                    request_id=self.logger.request_id or str(uuid.uuid4()),
                    user_request=full_input,
                    tier=self.config.tier,
                    tool_trace=self.tool_trace,
                    artifacts=self.artifacts,
                    recent_file_operations=list(self._file_operations),
                    working_dir=os.getcwd(),
                    token_estimator=self.token_estimator
                )

            # 2. Plan context (allocate budgets, decide caching)
            with self._perf_tracer.span("context_plan"):
                total_budget = 180_000  # Claude's context window
                context_plan = self.context_planner.plan(
                    build=context_build,
                    total_budget=total_budget,
                    cache_strategy=CacheStrategy.CONSERVATIVE
                )

            # 3. Serialize to API format
            with self._perf_tracer.span("context_serialize"):
                serialization_result = self.context_serializer.serialize(
                    plan=context_plan,
                    build=context_build,
                    provider=self._llm_config.provider if self._llm_config else "anthropic",
                    use_responses_api=True  # Enable Responses API format for OpenAI
                )

        if not serialization_result.success:
            self.logger.error(
                f"Context serialization failed: {serialization_result.error}",
                component="agent"
            )
            self._current_request_id = None
            return AgentResponse(
                content="Failed to prepare context for LLM",
                success=False,
                error=serialization_result.error
            )

        # 4. STAGE 1: Log agent context (THICK LOGGING)
        self._log_stage_1_agent_context(
            serialization_result=serialization_result,
            user_input=full_input,
            tier=self.config.tier,
            context_plan=context_plan
        )

        # Build legacy messages for compatibility with executor
        # (Will be replaced with ContextManager in executor later)
        # system_prompt = self._build_system_prompt()
        # messages = [Message(MessageRole.SYSTEM, system_prompt)]
        # messages.extend(self._conversation)
        # messages.append(Message(MessageRole.USER, full_input))

        # Get tool definitions
        tool_definitions = self._get_tool_definitions()

        # ========== LOG FULL AGENT CONTEXT ==========
        # Extract tool names only (not full schemas)
        tool_names = [
            td.get("function", {}).get("name") if isinstance(td, dict) else getattr(td, "name", "unknown")
            for td in tool_definitions
        ]

        self.exec_logger.log_agent_context(
            req_id=req_id,
            exec_id=exec_id,
            user_input=full_input,
            tier=self.config.tier,
            system_prompt_id=f"tier_{self.config.tier}_v1",
            tool_manifest_id="default_tools_v1",
            conversation_history=[],  # No longer tracking conversation history
            tool_names=tool_names,
            additional_context={"context_provided": context} if context else None
        )

        try:
            # ========== PHASE 1: PLANNING ==========
            with self._perf_tracer.span("phase1_planning"):
                self._current_state = AgentState.PLANNING
                self._publish_agent_progress("Planning started", step_number=0)
                self._emit_thought("Creating execution plan...")

                with self._perf_tracer.span("planner_create_plan", tier=self.config.tier):
                    plan = self._planner.create_plan(
                        user_input=user_input,
                        context=context,
                        tier=self.config.tier,
                        budget=self._budget  # Pass budget constraints from router
                    )

                self._perf_tracer.add_metadata("plan_steps", len(plan.steps))
                self._perf_tracer.add_metadata("plan_type", plan.goal_type)

                self.logger.plan_created(
                    f"Plan: {plan.goal_type} - {plan.goal[:60]}",
                    tools=[s.tool_hint for s in plan.steps if s.tool_hint]
                )
            if plan.assumptions:
                self._emit_thought(f"Assumptions: {', '.join(plan.assumptions[:4])}")
            self._publish_agent_progress(f"Plan ready ({len(plan.steps)} steps)", step_number=0)

            # STAGE 2: Log planning result
            self._log_stage_2_planning_result(
                plan=plan,
                user_input=user_input,
                tier=self.config.tier
            )

            # LOG FULL PLANNER CALL - NO TRUNCATION
            # This writes to full_execution.jsonl with complete prompts and responses
            if self._agent_logger and self._planner:
                try:
                    parsed_plan_dict = plan.to_dict() if hasattr(plan, 'to_dict') else None
                    self._agent_logger.log_planner_call(
                        user_input=user_input,
                        instructions=self._planner.last_call_instructions,
                        input_str=self._planner.last_call_input,
                        raw_response=self._planner.last_call_response,
                        parsed_plan=parsed_plan_dict,
                        tier=self.config.tier,
                        duration_ms=self._planner.last_call_duration_ms
                    )
                except Exception as e:
                    self.logger.error(f"Failed to log planner call: {e}", component="agent")

            # ========== LOG PLANNING RESULT ==========
            self.exec_logger.log_planning_result(
                req_id=req_id,
                exec_id=exec_id,
                goal=plan.goal,
                goal_type=plan.goal_type,
                requires_tools=plan.requires_tools,
                steps=[
                    {
                        "step_num": s.step_num,
                        "objective": s.objective,
                        "tool_hint": s.tool_hint,
                        "tool_args_hint": s.tool_args_hint,
                        "success_criteria": s.success_criteria.description if s.success_criteria else None,
                        "depends_on": s.depends_on,
                        "status": s.status.value,
                        "phase": s.phase.value
                    }
                    for s in plan.steps
                ],
                success_criteria=plan.success_criteria.description,
                estimated_complexity=plan.estimated_complexity,
                reasoning=plan.reasoning,
                plan_status=plan.status.value,
                discovery_required=plan.discovery_required,
                assumptions=plan.assumptions
            )

            # Record planning step
            planning_step = AgentStep(
                step_number=self._step_count,
                state=AgentState.PLANNING,
                thought=f"Plan: {plan.goal} ({len(plan.steps)} steps)"
            )
            self._step_count += 1
            self._record_step(planning_step)

            # Seed plan status tracker for execution guidance
            self._plan_status = self._initialize_plan_status(plan)

            # Default to microloop execution when tools are required for better manifest-driven guidance
            # if self._executor:
            #     if plan.requires_tools:
            #         self._executor.enable_microloop()
            #     else:
            #         self._executor.disable_microloop()

            # ========== PHASE 2: EXECUTION ==========
            with self._perf_tracer.span("phase2_execution", steps=len(plan.steps)):
                self._current_state = AgentState.THINKING
                self._publish_agent_progress("Executing plan", step_number=0)
                self._emit_thought(f"Executing plan: {plan.goal[:50]}...")

                # Set up executor LLM call logging callback
                if self._executor:
                    def _executor_log_callback(
                        step_num: int,
                        objective: str,
                        instructions: str,
                        input_str: str,
                        raw_response: str,
                        tool_calls: list,
                        tool_results: list,
                        duration_ms: float,
                        phase: str,
                        manifest: dict = None
                    ):
                        if self._agent_logger:
                            try:
                                # Convert tool calls to serializable format
                                tc_dicts = []
                                for tc in tool_calls:
                                    if hasattr(tc, 'name'):
                                        tc_dicts.append({
                                            'name': tc.name,
                                            'arguments': tc.arguments if hasattr(tc, 'arguments') else {}
                                        })
                                    elif isinstance(tc, dict):
                                        tc_dicts.append(tc)

                                # Convert tool results to serializable format
                                tr_dicts = []
                                for tr in tool_results:
                                    if hasattr(tr, 'tool_name'):
                                        tr_dicts.append({
                                            'tool': tr.tool_name,
                                            'output': str(tr.result.output)[:2000] if hasattr(tr, 'result') and tr.result else '',
                                            'success': tr.result.is_success if hasattr(tr, 'result') and tr.result else False
                                        })
                                    elif isinstance(tr, dict):
                                        tr_dicts.append(tr)

                                self._agent_logger.log_executor_call(
                                    step_num=step_num,
                                    objective=objective,
                                    instructions=instructions,
                                    input_str=input_str,
                                    raw_response=raw_response,
                                    tool_calls=tc_dicts,
                                    tool_results=tr_dicts,
                                    tier=self.config.tier,
                                    duration_ms=duration_ms,
                                    phase=phase,
                                    manifest=manifest
                                )
                            except Exception as e:
                                self.logger.error(f"Failed to log executor call: {e}", component="agent")

                        if tool_results:
                            for entry in tool_results:
                                tool_name = None
                                status_label = None
                                preview = None
                                success = None
                                if hasattr(entry, "tool_name"):
                                    tool_name = getattr(entry, "tool_name", None)
                                    success = getattr(entry, "success", None)
                                    preview = getattr(entry, "output", None)
                                elif isinstance(entry, dict):
                                    tool_name = entry.get("tool") or entry.get("name")
                                    success = entry.get("success")
                                    preview = entry.get("output") or entry.get("error")
                                    status_label = entry.get("status")

                                if not tool_name:
                                    continue
                                if not status_label:
                                    if success is True:
                                        status_label = "completed"
                                    elif success is False:
                                        status_label = "failed"
                                    else:
                                        status_label = "started"

                                self._publish_tool_progress(tool_name, status_label, step_num, preview)

                    self._executor.set_llm_call_logger(_executor_log_callback)

                with self._perf_tracer.span("executor_execute"):
                    execution_context = self._augment_context_with_plan(
                        serialization_result.serialized_messages,
                        plan,
                        self._plan_status
                    )
                    stream_callback = on_stream_chunk
                    if on_stream_chunk:
                        def _stream_and_publish(chunk: str, chunk_index: int, is_final: bool):
                            on_stream_chunk(chunk, chunk_index, is_final)
                            self._publish_stream_chunk(chunk, chunk_index, is_final)
                        stream_callback = _stream_and_publish
                    trace = self._executor.execute(
                        plan=plan,
                        serialized_context=execution_context,
                        tools=tool_definitions if plan.requires_tools else [],
                        on_stream_chunk=stream_callback,
                        plan_status=self._plan_status
                    )

                self._perf_tracer.add_metadata("tool_calls", trace.tool_calls)
                self._perf_tracer.add_metadata("llm_calls", trace.llm_calls)

                final_content = trace.final_response or "I apologize, I couldn't generate a response."

            # ========== PHASE 3: REFLECTION ==========
            with self._perf_tracer.span("phase3_reflection"):
                self._current_state = AgentState.REFLECTING
                self._publish_agent_progress("Reflecting on results", step_number=0)

                # OPTIMIZATION: Skip LLM reflection for clearly successful simple executions
                # This saves 500-1500ms per request
                if (trace.all_steps_succeeded and
                    trace.tool_failures == 0 and
                    len(plan.steps) <= 2 and
                    plan.goal_type in ("question", "search")):
                    # Fast path: deterministic reflection without LLM call
                    with self._perf_tracer.span("reflection_fast_path"):
                        reflection = Reflection(
                            plan_goal=plan.goal,
                            goal_achieved=True,
                            confidence=0.95,
                            evidence=["All steps completed without errors", f"Executed {trace.tool_calls} tool(s) successfully"],
                            gaps=[],
                            suggestions=[],
                            had_tool_failures=False,
                            reward=1.0,
                            plan_quality=0.9,
                            execution_quality=1.0,
                            response_quality=0.9
                        )
                    self.logger.debug("Skipped LLM reflection (fast path)", component="agent")
                else:
                    with self._perf_tracer.span("reflector_reflect_llm"):
                        reflection = self._reflector.reflect(
                            plan=plan,
                            trace=trace,
                            file_operations=list(self._file_operations)
                        )

            # Log reflection result
            status = "completed" if reflection.goal_achieved else "failed"
            if trace.had_failures and reflection.goal_achieved:
                status = "partial"

            self.logger.reflection(
                goal_achieved=reflection.goal_achieved,
                confidence=reflection.confidence,
                gaps=reflection.gaps
            )
            contract_checklist = self._build_contract_checklist(user_input, plan, trace, reflection)
            self.logger.info("contract_checklist", component="agent", data=contract_checklist)
            if reflection.goal_achieved:
                self._publish_agent_progress("Goal achieved", step_number=0)
            else:
                self._publish_agent_progress("Goal not fully achieved", step_number=0)

            # STAGE 3: Log episode summary
            total_duration = (time.time() - start_time) * 1000
            self._log_stage_3_episode_summary(
                plan=plan,
                trace=trace,
                reflection=reflection,
                user_input=user_input,
                tier=self.config.tier,
                total_duration_ms=total_duration
            )

            # ========== LOG EPISODE SUMMARY WITH RL LABELS ==========
            total_duration = (time.time() - start_time) * 1000
            self.exec_logger.log_episode_summary(
                req_id=req_id,
                exec_id=exec_id,
                tier=self.config.tier,
                system_prompt_id=f"tier_{self.config.tier}_v1",
                tool_manifest_id="default_tools_v1",
                user_input=user_input,
                goal=plan.goal,
                goal_type=plan.goal_type,
                total_duration_ms=total_duration,
                tool_calls=trace.tool_calls,
                tool_failures=trace.tool_failures,
                max_tool_calls_allowed=self.config.max_tool_calls,
                rl_labels=reflection.to_rl_labels()
            )

            # ========== EMIT EPISODE COMPLETE EVENT FOR RL TRAINING ==========
            if self.event_bus:
                try:
                    episode_data = {
                        "req_id": req_id,
                        "exec_id": exec_id,
                        "plan": {
                            "goal": plan.goal,
                            "goal_type": plan.goal_type,
                            "steps": [
                                {
                                    "step_num": s.step_num,
                                    "objective": s.objective,
                                    "tool_hint": s.tool_hint,
                                    "status": s.status.value
                                }
                                for s in plan.steps
                            ]
                        },
                        "trace": {
                            "steps_executed": [
                                {
                                    "step_id": f"{exec_id}-step-{s.step_num}",
                                    "step_num": s.step_num,
                                    "objective": s.objective,
                                    "tool_hint": s.tool_hint,
                                    "status": s.status.value,
                                    "result": s.result,
                                    "error": s.error,
                                    "duration_ms": s.duration_ms
                                }
                                for s in trace.steps_executed
                            ],
                            "tool_calls": trace.tool_calls,
                            "tool_failures": trace.tool_failures,
                            "llm_calls": trace.llm_calls,
                            "had_failures": trace.had_failures
                        },
                        "reflection": {
                            "goal_achieved": reflection.goal_achieved,
                            "confidence": reflection.confidence,
                            "gaps": reflection.gaps,
                            "evidence": reflection.evidence
                        }
                    }
                    self.event_bus.emit_episode_complete(episode_data)
                    self.logger.debug(f"Emitted episode complete event for {req_id}")
                except Exception as e:
                    self.logger.error(f"Failed to emit episode complete event: {e}")

            # ========== BUILD RESPONSE ==========
            self._current_state = AgentState.COMPLETE
            total_duration = (time.time() - start_time) * 1000

            # Print performance trace summary if enabled
            self._perf_tracer.print_summary()

            # Determine success based on reflection
            actual_success = reflection.goal_achieved
            failure_reason = None if actual_success else "; ".join(reflection.gaps) if reflection.gaps else "Goal not achieved"

            # Extract tools used from step results
            tools_used = []
            for step_result in trace.steps_executed:
                for tool_call in step_result.tool_calls_made:
                    if tool_call.tool_name not in tools_used:
                        tools_used.append(tool_call.tool_name)

            self._publish_agent_progress("Response ready", step_number=0)
            return AgentResponse(
                content=final_content,
                structured_action=plan.goal,
                steps=self._steps,
                total_duration_ms=total_duration,
                tools_used=tools_used,
                success=actual_success,
                error=failure_reason,
                plan=plan,
                reflection=reflection,
                goal_achieved=reflection.goal_achieved,
                metadata={
                    "model": self._llm_config.model if self._llm_config else None,
                    "tool_calls": trace.tool_calls,
                    "tool_failures": trace.tool_failures,
                    "llm_calls": trace.llm_calls,
                    "max_tool_calls": self.config.max_tool_calls,
                    "file_operations": list(self._file_operations),
                    "had_tool_failures": trace.had_failures,
                    "status": status,
                    "plan_type": plan.goal_type,
                    "reflection_confidence": reflection.confidence,
                    "contract_checklist": contract_checklist
                }
            )

        except Exception as e:
            self._current_state = AgentState.ERROR
            self.logger.error(f"Agent execution failed: {e}", component="agent")
            self._publish_agent_progress(f"Execution failed: {e}", step_number=0)

            return AgentResponse(
                content=f"I encountered an error: {str(e)}",
                success=False,
                error=str(e),
                steps=self._steps,
                total_duration_ms=(time.time() - start_time) * 1000,
                goal_achieved=False
            )
        finally:
            self._current_request_id = None

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
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None
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

        if tier == "simple":
            self.logger.info("Using simple tier fast path", component="agent")
            return self._run_simple_tier_fast_path(user_input, tier, context)

        agent = self._get_agent(tier)

        # Pass budget and streaming callback to agent
        return agent.run(
            user_input, context,
            budget=budget,
            classification=classification,
            on_stream_chunk=on_stream_chunk
        )

    def _run_simple_tier_fast_path(
        self,
        user_input: str,
        tier: str,
        context: Optional[str] = None
    ) -> AgentResponse:
        """Bypass the plan/execution pipeline for simple tier requests."""
        agent = self._get_agent(tier)
        return agent.run_simple_response(user_input, context)

    def set_tier(self, tier: str):
        """Set default tier"""
        self._current_tier = tier

    @property
    def current_tier(self) -> str:
        return self._current_tier
