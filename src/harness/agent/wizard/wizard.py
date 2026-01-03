"""
Wizard is the outer-loop orchestrator that owns single-writer global state.
Dispatches bounded work to Workers and coordinates plan evolution.

The Wizard does NOT create plans - it receives a WizardPlan and executes it.
Planning is the caller's responsibility.
"""

import hashlib
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Protocol

from .types import (
    StepStatus,
    WizardPlan,
    WizardReflection,
    ReflectionVerdict,
    GoalType,
)
from .reflector import WizardReflector, ReflectorConfig
from .reflection_types import (
    ReflectionContext,
    StepContext,
    WizardReflectionInput,
    WizardReflectionOutput,
    ScaffoldedStep,
)
from .events import (
    WizardEvent,
    WizardEventType,
    QualityIssueData,
    StepCompletedData,
)
from .plan_state import PlanState
from .work_ledger import WorkLedger
from .knowledge_store import KnowledgeStore, KnowledgeFact, FactSource
from .context_window import (
    BehavioralRules,
    ContextWindow,
    SessionContext,
    SystemPrompt,
    build_system_message,
    filter_persistable_messages,
)
from .work_item import WorkItem, WorkBounds
from .worker import Worker, WorkerConfig, WorkerOutcome, WorkerCacheParams, PatchSuggestion
from .plan_patch import PlanPatch
from .policy_gate import PolicyGate
from .stagnation import StagnationDetector, StagnationSignal

# Synthesis module for final response generation
from ..synthesis import ResponseSynthesizer, SynthesisInput


class ToolRegistry(Protocol):
    """Protocol for tool registry - allows any compatible implementation."""
    def get_tool(self, name: str) -> Any: ...
    def list_tools(self, enabled_only: bool = True) -> List[Any]: ...
    def get_definitions(self, enabled_only: bool = True) -> List[Any]: ...
    def execute(self, name: str, **kwargs) -> Any: ...


class Logger(Protocol):
    """Protocol for logger - allows any compatible implementation."""
    def info(self, msg: str, **kwargs) -> None: ...
    def debug(self, msg: str, **kwargs) -> None: ...
    def warning(self, msg: str, **kwargs) -> None: ...
    def error(self, msg: str, **kwargs) -> None: ...


@dataclass
class WizardConfig:
    """Wizard configuration."""

    max_workers: int = 1  # Parallel workers (start with 1)
    max_iterations: int = 50
    context_budget_tokens: int = 100_000
    compaction_threshold: float = 0.6  # Compact when >60% budget
    max_retries_per_step: int = 3  # Max retries before skipping a failed step
    deadlock_threshold: int = 5  # Max consecutive iterations with no ready steps

    # Reflection configuration
    reflection_enabled: bool = True
    reflection_model: Optional[str] = None
    reflection_timeout_ms: int = 10_000

    # Quality thresholds
    min_accept_quality: float = 0.6
    excellence_threshold: float = 0.85

    # Scaffolding limits
    max_scaffolded_per_step: int = 3
    max_total_scaffolded: int = 10
    max_plan_size: int = 20
    max_scaffold_depth: int = 3

    # Clarification policy
    clarification_timeout_seconds: int = 60
    require_default_assumption: bool = True
    max_clarification_options: int = 4


@dataclass
class WizardResult:
    """Result of Wizard orchestration."""

    success: bool  # True if goal_achieved (required steps COMPLETED)
    final_response: str
    plan_state: PlanState
    ledger: WorkLedger

    # Metrics
    total_iterations: int
    total_tool_calls: int
    total_llm_calls: int
    duration_ms: float

    # Step counts (computed from plan_state)
    steps_completed: int = 0
    steps_skipped: int = 0
    steps_failed: int = 0

    # Session persistence - SessionContext state for saving to graphd
    # This is the merged/final context state after orchestration
    final_context_state: Optional[Dict[str, Any]] = None

    # Observability
    events: List[WizardEvent] = field(default_factory=list)

    # Pause state (for user clarification)
    paused: bool = False
    user_prompt: Optional[Dict[str, Any]] = None  # {question, options, context}

    @property
    def is_terminated(self) -> bool:
        """True if all steps reached terminal state (COMPLETED or SKIPPED)."""
        return self.plan_state.is_terminated()

    @property
    def goal_achieved(self) -> bool:
        """True if goal was achieved (required steps COMPLETED)."""
        return self.plan_state.goal_achieved()

    def to_reflection(self) -> WizardReflection:
        """Create a reflection on the execution."""
        return WizardReflection(
            plan_goal=self.plan_state.goal,
            goal_achieved=self.success,
            confidence=0.8 if self.success else 0.3,
            evidence=[self.ledger.summarize_tail()],
            gaps=[],
            suggestions=[],
            summary=self.final_response[:200] if self.final_response else "",
        )

    def _derive_error_message(self) -> str:
        if self.final_response:
            if self.final_response.startswith("Unable to complete"):
                return self.final_response
            if self.final_response.startswith("ERROR:"):
                return self.final_response

        failed_steps = [
            s for s in self.plan_state.steps.values()
            if s.status == StepStatus.FAILED
        ]
        for step in failed_steps:
            if step.last_error:
                return step.last_error

        return "Wizard orchestration failed"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization or interop."""
        error = None if (self.success or self.paused) else self._derive_error_message()
        return {
            "content": self.final_response,
            "structured_action": self.plan_state.goal,
            "total_duration_ms": self.duration_ms,
            "success": self.success,
            "error": error,
            "goal_achieved": self.success,
            "reflection": {
                "plan_goal": self.plan_state.goal,
                "goal_achieved": self.success,
                "confidence": 0.8 if self.success else 0.3,
                "evidence": [self.ledger.summarize_tail()],
            },
            "events": [event.to_dict() for event in self.events],
            "paused": self.paused,
            "user_prompt": self.user_prompt,
            "metadata": {
                "wizard": True,
                "iterations": self.total_iterations,
                "plan_version": self.plan_state.version,
                "steps_completed": self.steps_completed,
                "steps_skipped": self.steps_skipped,
                "steps_failed": self.steps_failed,
                "paused": self.paused,
                "user_prompt": self.user_prompt,
            },
        }


class Wizard:
    """
    Outer-loop orchestrator that owns global state.

    RESPONSIBILITIES:
    1. Own single-writer state (PlanState, WorkLedger, KnowledgeStore)
    2. Build ContextWindow for each iteration (read-only, from SessionContext)
    3. Select and dispatch WorkItems to Workers
    4. Ingest WorkerOutcomes: auto-append facts, apply Wizard-approved suggestions via PolicyGate
    5. Detect stagnation and escalate

    NOT RESPONSIBLE FOR:
    - Creating plans (caller provides WizardPlan)
    """

    def __init__(
        self,
        tool_registry: ToolRegistry,
        llm: Any,  # LLMAdapter
        config: Optional[WizardConfig] = None,
        logger: Optional[Logger] = None,
    ):
        self.tool_registry = tool_registry
        self.llm = llm
        self.config = config or WizardConfig()
        self.logger = logger

        # Single-writer state (created per orchestration)
        self._plan_state: Optional[PlanState] = None
        self._ledger: Optional[WorkLedger] = None
        self._knowledge: Optional[KnowledgeStore] = None
        self._session_context: Optional[SessionContext] = None
        self._behavioral_rules = BehavioralRules.default()

        # Components
        self._policy_gate = PolicyGate()
        self._stagnation_detector = StagnationDetector()

        # Worker - require explicit [FINAL] marker for completion
        worker_config = WorkerConfig(allow_implicit_finals=False)
        self._worker = Worker(
            tool_registry,
            llm,
            worker_config,
            logger=logger,
            event_emitter=self._emit_event,
        )

        # Synthesizer for final response generation
        self._synthesizer = ResponseSynthesizer(llm=llm)

        # NEW: Reflector component for post-step reasoning
        reflector_config = ReflectorConfig(
            min_accept_quality=self.config.min_accept_quality,
            excellence_threshold=self.config.excellence_threshold,
            max_redo_attempts=self.config.max_retries_per_step,
            reflection_model=self.config.reflection_model,
            default_clarification_timeout=self.config.clarification_timeout_seconds,
            max_clarification_options=self.config.max_clarification_options,
            require_default_assumption=self.config.require_default_assumption,
            reflection_timeout_ms=self.config.reflection_timeout_ms,
        )
        self._reflector = WizardReflector(
            llm,
            reflector_config,
            logger=logger,
            event_emitter=self._emit_event,
        )

        # User input request state (tool-driven, replaces callback-based clarification)
        self._pending_user_prompt: Optional[Dict[str, Any]] = None
        self._paused_step_num: Optional[int] = None

        # NEW: Step error history for reflection context
        self._step_errors: Dict[int, List[str]] = {}

        # NEW: Goal abort tracking
        self._goal_aborted: bool = False
        self._goal_abort_reason: Optional[str] = None
        self._start_time: float = 0.0

        # NEW: Scaffolding tracking
        self._scaffolded_total: int = 0
        self._scaffolded_by_step: Dict[int, int] = {}

        # NEW: Event handlers + event buffer
        self._event_handlers: List[Callable[[WizardEvent], None]] = []
        self._events: List[WizardEvent] = []

        # NEW: Resume-capable execution state
        self._current_plan: Optional[WizardPlan] = None
        self._collected_outcomes: List[WorkerOutcome] = []
        self._iteration_count: int = 0
        self._total_tool_calls: int = 0
        self._total_llm_calls: int = 0
        # Token tracking: separate output (cumulative) from context window (peak)
        self._total_output_tokens: int = 0  # Cumulative completion tokens
        self._peak_context_tokens: int = 0  # Peak prompt tokens (context window usage)

    def _log(self, level: str, msg: str, **kwargs) -> None:
        """Log with optional logger. Silently no-ops if logger is None."""
        if self.logger is None:
            return
        log_fn = getattr(self.logger, level, None)
        if log_fn:
            log_fn(msg, component="wizard", **kwargs)

    def add_event_handler(self, handler: Callable[[WizardEvent], None]) -> None:
        """Register an event handler for Wizard events."""
        self._event_handlers.append(handler)

    def remove_event_handler(self, handler: Callable[[WizardEvent], None]) -> None:
        """Unregister an event handler."""
        if handler in self._event_handlers:
            self._event_handlers.remove(handler)

    def drain_events(self) -> List[WizardEvent]:
        """Return and clear accumulated events."""
        events = list(self._events)
        self._events.clear()
        return events

    def reset_for_new_request(self) -> None:
        """Reset token counters and events for a new request. Call before planning."""
        self._total_output_tokens = 0
        self._peak_context_tokens = 0
        self._events.clear()

    def _emit_event(self, event: WizardEvent) -> None:
        """Emit event to registered handlers and store in buffer."""
        if event.event_type == WizardEventType.LLM_CALL and event.data:
            # Track completion tokens cumulatively (actual LLM output)
            completion_tokens = event.data.get("completion_tokens", 0)
            if isinstance(completion_tokens, (int, float)):
                self._total_output_tokens += max(0, int(completion_tokens))
            # Track prompt tokens as peak (context window usage)
            prompt_tokens = event.data.get("prompt_tokens", 0)
            if isinstance(prompt_tokens, (int, float)):
                self._peak_context_tokens = max(self._peak_context_tokens, int(prompt_tokens))
        self._events.append(event)
        for handler in list(self._event_handlers):
            try:
                handler(event)
            except Exception as exc:
                self._log("warning", f"Event handler error: {exc}")
        self._log("debug", f"Event: {event.event_type.value}", data=event.data)

    def _emit_plan_snapshot(self, trigger: str, snapshot_type: str) -> None:
        """Emit full plan snapshot for dashboard versioning."""
        if not self._plan_state:
            return

        steps_data = [
            {
                "step_num": step.step_num,
                "objective": step.objective,
                "status": step.status.value,
                "phase": step.phase.value,
                "tool_hint": step.tool_hint,
                "depends_on": list(step.depends_on) if step.depends_on else [],
                "required": step.required,
            }
            for step in sorted(self._plan_state.steps.values(), key=lambda s: s.step_num)
        ]

        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.PLAN_SNAPSHOT,
                data={
                    "version": self._plan_state.version,
                    "snapshot_type": snapshot_type,
                    "steps": steps_data,
                    "goal": self._plan_state.goal,
                    "trigger": trigger,
                },
            )
        )

    def _emit_context_window_update(self) -> None:
        """Emit context window metrics for dashboard."""
        max_tokens = 200000
        message_count = len(self._session_context.messages) if self._session_context else 0
        # Context window % is based on peak prompt tokens (actual context usage)
        percentage_used = self._peak_context_tokens / max_tokens if max_tokens else 0
        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.CONTEXT_WINDOW_UPDATE,
                data={
                    # Peak context window usage (prompt tokens)
                    "context_tokens": self._peak_context_tokens,
                    # Cumulative output tokens (completion tokens)
                    "output_tokens": self._total_output_tokens,
                    "max_tokens": max_tokens,
                    "percentage_used": percentage_used,
                    "message_count": message_count,
                    # Legacy field for backwards compatibility
                    "total_tokens": self._peak_context_tokens + self._total_output_tokens,
                },
            )
        )

    def orchestrate(
        self,
        plan: WizardPlan,
        user_input: str,
        request_context: Optional[str] = None,
        budget: Optional[Dict[str, int]] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
        target_paths: Optional[List[str]] = None,
        session_context: Optional[SessionContext] = None,
    ) -> WizardResult:
        """
        Main orchestration loop.

        Args:
            plan: The WizardPlan to execute (caller creates this)
            user_input: Original user message for this request
            request_context: Optional extra context to append before user_input
            budget: Optional budget constraints
            on_stream_chunk: Optional callback for streaming responses
            target_paths: Explicit file paths from user (e.g. @mentions) - injected into ALL steps
            session_context: Optional SessionContext hydrated from session snapshots.

        Returns:
            WizardResult with execution results

        The loop:
        1. Initialize state stores from plan
        2. Use provided SessionContext OR create fresh one
        3. Loop until complete or stagnated:
           a. Handle failed steps (retry or skip)
           b. Select ready WorkItems
           c. Build read-only ContextWindow for current step
           d. Dispatch to Workers (with try/except/finally)
           e. Ingest outcomes
           f. Check stagnation (AFTER ingest)
           g. Apply patches (with lifecycle tracking)
        4. Return result with final SessionContext state for persistence

        Note:
        - If a user clarification is needed, orchestration pauses with user_prompt in result.
        - Call resume_with_answer(answer) to continue execution.
        """
        self._start_time = time.time()
        self._current_plan = plan
        self._iteration_count = 0
        self._total_tool_calls = 0
        self._total_llm_calls = 0
        # Note: token counters (_total_output_tokens, _peak_context_tokens) are NOT reset here.
        # They're reset in reset_for_new_request() which is called before planning starts.
        # This allows planner tokens to be included in the final context window metrics.
        # Collect all outcomes for synthesis
        self._collected_outcomes = []

        # Reset state
        self._pending_user_prompt = None
        self._paused_step_num = None
        self._step_errors.clear()
        self._goal_aborted = False
        self._goal_abort_reason = None
        self._scaffolded_total = 0
        self._scaffolded_by_step.clear()
        self._events.clear()

        # Initialize state stores directly from the provided plan
        self._plan_state = PlanState.from_wizard_plan(plan)
        self._ledger = WorkLedger()
        self._knowledge = KnowledgeStore()
        self._session_context = session_context or SessionContext()

        if not self._session_context.prompt_cache_id:
            self._session_context.prompt_cache_id = f"wizard:{uuid.uuid4().hex[:8]}"

        if request_context:
            self._session_context.add_message({
                "role": "user",
                "content": f"Context:\n{request_context}",
            })

        self._session_context.add_message({"role": "user", "content": user_input})

        self._log(
            "info",
            f"Session context: messages={len(self._session_context.messages)}, "
            f"read_files={len(self._session_context.read_files)}",
        )

        # ========== INJECT TARGET PATHS INTO ALL STEPS ==========
        # If target_paths provided (e.g., from @mentions), inject them into every step
        # This ensures workers have authoritative file paths without searching
        if target_paths:
            self._log("info", f"Injecting {len(target_paths)} target paths into all steps")
            for step in self._plan_state.steps.values():
                # Merge with any existing target_paths, dedup
                existing = set(step.target_paths)
                for path in target_paths:
                    if path not in existing:
                        step.target_paths.append(path)
                        existing.add(path)
            self._log("debug", f"  Target paths: {target_paths}")

        # Seed knowledge with goal
        self._knowledge.upsert(
            KnowledgeFact(
                key="goal",
                value=plan.goal,
                confidence=1.0,
                source=FactSource.USER,
                is_pinned=True,
            )
        )

        # Emit goal started event with user input and initial plan
        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.GOAL_STARTED,
                data={
                    "goal": plan.goal,
                    "user_input": user_input,
                    "steps": [
                        {
                            "step_num": step.step_num,
                            "objective": step.objective,
                            "tool_hint": step.tool_hint,
                            "phase": step.phase.value,
                        }
                        for step in sorted(
                            self._plan_state.steps.values(),
                            key=lambda s: s.step_num,
                        )
                    ],
                },
            )
        )
        self._emit_plan_snapshot("goal_started", "initial")
        self._emit_context_window_update()


        # ========== FULL PLAN LOGGING ==========
        self._log("info", f"Wizard starting: goal='{plan.goal[:80]}', steps={len(plan.steps)}")
        self._log("debug", f"=== FULL PLAN ===")
        self._log("debug", f"  goal: {plan.goal}")
        self._log("debug", f"  goal_type: {plan.goal_type}")
        self._log("debug", f"  reasoning: {plan.reasoning[:200] if plan.reasoning else '(none)'}")
        self._log("debug", f"  requires_tools: {plan.requires_tools}")
        #    self._log("debug", session_context.)
        for step in plan.steps:
            deps = f" (depends_on: {step.depends_on})" if step.depends_on else ""
            tool = f" [tool: {step.tool_hint}]" if step.tool_hint else ""
            required = " REQUIRED" if step.required else ""
            self._log("debug", f"  Step {step.step_num}: {step.objective[:80]}{tool}{deps}{required}")

        return self._run_orchestration_loop(
            budget=budget,
            on_stream_chunk=on_stream_chunk,
        )

    def resume_with_answer(
        self,
        answer: str,
        budget: Optional[Dict[str, int]] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
    ) -> WizardResult:
        """
        Resume orchestration after user provides an answer to a clarification prompt.

        Args:
            answer: The user's response to the question
            budget: Optional budget constraints
            on_stream_chunk: Optional streaming callback

        Returns:
            WizardResult with continued execution results
        """
        if not self._plan_state or not self._current_plan:
            raise RuntimeError("No active plan to resume.")

        if not self._pending_user_prompt:
            raise RuntimeError("No pending user prompt to answer.")

        # Inject the user's answer into the session context
        question = self._pending_user_prompt.get("question", "")
        self._session_context.add_message({
            "role": "user",
            "content": f"User response to '{question}':\n{answer}"
        })

        # Clear events from previous run before emitting new ones
        self._events.clear()

        # Emit event
        request_id = self._pending_user_prompt.get("request_id") if self._pending_user_prompt else None
        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.USER_INPUT_RECEIVED,
                step_num=self._paused_step_num,
                data={"answer": answer, "request_id": request_id},
            )
        )
        self._emit_context_window_update()

        # Reset paused step back to PENDING now that we have the answer
        if self._paused_step_num is not None:
            self._plan_state.reset_step_for_retry(self._paused_step_num)

        # Clear the pending prompt
        self._pending_user_prompt = None
        self._paused_step_num = None
        if self._start_time <= 0:
            self._start_time = time.time()

        return self._run_orchestration_loop(
            budget=budget,
            on_stream_chunk=on_stream_chunk,
        )

    def resume(
        self,
        budget: Optional[Dict[str, int]] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
    ) -> WizardResult:
        """
        Resume orchestration after a pause.

        This continues with the existing PlanState, ledger, and context.
        For resuming after a clarification, use resume_with_answer() instead.
        """
        if not self._plan_state or not self._current_plan:
            raise RuntimeError("No active plan to resume.")

        self._events.clear()
        if self._start_time <= 0:
            self._start_time = time.time()

        return self._run_orchestration_loop(
            budget=budget,
            on_stream_chunk=on_stream_chunk,
        )

    def _run_orchestration_loop(
        self,
        budget: Optional[Dict[str, int]] = None,
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
    ) -> WizardResult:
        """Run the orchestration loop using existing state."""
        if not self._plan_state or not self._current_plan:
            raise RuntimeError("Wizard has no active plan to run.")

        plan = self._current_plan
        iteration = self._iteration_count
        total_tool_calls = self._total_tool_calls
        total_llm_calls = self._total_llm_calls
        collected_outcomes = self._collected_outcomes
        consecutive_no_ready = 0  # Deadlock detection counter
        paused_for_user = False

        while iteration < self.config.max_iterations:
            iteration += 1

            # ========== CHECK FOR GOAL ABORT ==========
            if self._goal_aborted:
                self._log("info", f"Goal aborted: {self._goal_abort_reason}")
                break

            # Handle failed steps: retry or skip (uses step.attempt_count)
            self._handle_failed_steps()

            # Get ready steps (dependencies satisfied, status PENDING)
            ready_steps = self._plan_state.get_ready_steps()
            if not ready_steps:
                consecutive_no_ready += 1

                # Deadlock detection: if no ready steps for K iterations, abort
                if consecutive_no_ready >= self.config.deadlock_threshold:
                    break

                # Check if we're stuck or just waiting
                if not self._has_recoverable_steps():
                    break
                continue

            # Reset deadlock counter when we have work
            consecutive_no_ready = 0

            step = ready_steps[0]

            work_bounds = WorkBounds()
            if budget:
                work_bounds.max_tool_calls = min(
                    work_bounds.max_tool_calls, budget.get("max_tool_calls", 5)
                )

            work_item = WorkItem.from_step_state(step, bounds=work_bounds)

            worker_id = str(uuid.uuid4())[:8]
            self._plan_state.mark_step_in_progress(step.step_num, worker_id)

            entry_id = self._ledger.record_dispatch(step.step_num, work_item, worker_id)

            self._emit_event(
                WizardEvent(
                    event_type=WizardEventType.STEP_STARTED,
                    step_num=step.step_num,
                    data={
                        "objective": step.objective,
                        "worker_id": worker_id,
                    },
                )
            )

            # ========== BUILD STEP CONTEXT WINDOW ==========
            system_prompt = SystemPrompt(
                goal=self._plan_state.goal,
                step_num=step.step_num,
                objective=work_item.objective,
                constraints=[
                    f"Max tool calls: {work_item.bounds.max_tool_calls}",
                    f"Max duration: {work_item.bounds.max_duration_ms}ms",
                    "Do NOT call ask_user; request user input via [NEED_CONTEXT] with JSON.",
                ],
                tool_hint=work_item.tool_hint,
            )
            system_message = build_system_message(system_prompt, self._behavioral_rules)
            step_context_window = ContextWindow(
                [system_message] + self._session_context.messages
            )

            # Execute worker with try/except/finally to ensure cleanup
            self._log("debug", f"Dispatching step {step.step_num}: {step.objective[:60]}")
            outcome: Optional[WorkerOutcome] = None
            plan_version = self._plan_state.version

            # Build cache params for this step (prompt caching only)
            prompt_cache_key = None
            if self._session_context.prompt_cache_id:
                system_hash = hashlib.sha256(system_message["content"].encode()).hexdigest()[:16]
                prompt_cache_key = f"{self._session_context.prompt_cache_id}:{system_hash}"

            cache_params = WorkerCacheParams(
                prompt_cache_key=prompt_cache_key,
                prompt_cache_retention="24h",
            )

            try:
                outcome = self._worker.execute(
                    step_context_window,
                    work_item,
                    plan_version,
                    cache_params,
                    read_files=set(self._session_context.read_files),
                )
                total_tool_calls += outcome.metrics.tool_calls_made
                total_llm_calls += outcome.metrics.llm_calls_made

                # Merge context updates into session context
                if outcome.context_messages:
                    self._session_context.extend_messages(
                        filter_persistable_messages(outcome.context_messages)
                    )
                if outcome.read_files:
                    self._session_context.read_files.update(outcome.read_files)
            except Exception as exc:
                # Create a failed outcome for the exception
                outcome = WorkerOutcome(
                    work_id=work_item.work_id,
                    step_num=step.step_num,
                    base_version=plan_version,
                    success=False,
                    error=f"Worker exception: {type(exc).__name__}: {str(exc)[:200]}",
                    termination_reason="exception",
                )

            # Ensure we have an outcome
            if outcome is None:
                outcome = WorkerOutcome(
                    work_id=work_item.work_id,
                    step_num=step.step_num,
                    base_version=plan_version,
                    success=False,
                    error="Worker returned no outcome",
                    termination_reason="no_outcome",
                )

            # Log outcome
            if outcome.needs_user_input or outcome.termination_reason == "awaiting_user":
                status_str = "awaiting_user"
            else:
                status_str = "success" if outcome.success else "failed"
            self._log(
                "debug",
                f"Step {step.step_num} {status_str}: "
                f"tools={outcome.metrics.tool_calls_made}, "
                f"llm={outcome.metrics.llm_calls_made}",
            )

            # ==================================================================
            # EMIT TOOL_CALL EVENTS for dashboard telemetry
            # ==================================================================
            for fact in outcome.facts:
                if fact.source == FactSource.TOOL and fact.tool_name:
                    # Truncate result for reasonable event size
                    result_str = str(fact.value)[:2000] if fact.value else ""
                    self._emit_event(
                        WizardEvent(
                            event_type=WizardEventType.TOOL_CALL,
                            step_num=step.step_num,
                            data={
                                "tool_name": fact.tool_name,
                                "result": result_str,
                                "success": True,
                                "fact_key": fact.key,
                            },
                        )
                    )

            # Emit events for tool errors
            for error in outcome.tool_errors:
                self._emit_event(
                    WizardEvent(
                        event_type=WizardEventType.TOOL_CALL,
                        step_num=step.step_num,
                        data={
                            "tool_name": "unknown",
                            "result": error[:500],
                            "success": False,
                            "error": error[:500],
                        },
                    )
                )

            # ==================================================================
            # CHECK FOR USER INPUT REQUEST (Wizard-owned clarification)
            # ==================================================================
            if outcome.needs_user_input:
                self._log("info", f"Step {step.step_num} requested user input")
                request_id = f"user_prompt:{uuid.uuid4().hex[:8]}"
                if outcome.user_prompt is None:
                    outcome.user_prompt = {"question": "", "options": [], "context": ""}
                outcome.user_prompt["request_id"] = request_id
                self._pending_user_prompt = outcome.user_prompt
                self._paused_step_num = step.step_num
                paused_for_user = True
                self._plan_state.mark_step_awaiting_user(step.step_num, request_id)

                self._emit_event(
                    WizardEvent(
                        event_type=WizardEventType.USER_INPUT_REQUESTED,
                        step_num=step.step_num,
                        data={
                            "question": outcome.user_prompt.get("question", "") if outcome.user_prompt else "",
                            "options": outcome.user_prompt.get("options", []) if outcome.user_prompt else [],
                            "context": outcome.user_prompt.get("context", "") if outcome.user_prompt else "",
                            "request_id": request_id,
                        },
                    )
                )
                # Record pause without counting as completion/failure
                self._ledger.record_awaiting_user(entry_id, outcome.user_prompt)
                break

            # Record completion in ledger (audit trail)
            self._ledger.record_completion(entry_id, outcome)

            # ==================================================================
            # REFLECTION DISABLED: Use deterministic fallback verdicts only.
            # ==================================================================
            reflection_output = self._fallback_reflection_output(step, outcome)

            # ==================================================================
            # ACT ON REFLECTION VERDICT
            # ==================================================================
            self._apply_reflection_verdict(
                step,
                outcome,
                reflection_output,
                collected_outcomes,
                on_stream_chunk,
            )

            # ========== STAGNATION CHECK ==========
            # (After reflection, not before)
            signal = self._stagnation_detector.check(step.step_num, self._ledger, outcome)
            if signal.detected:
                self._handle_stagnation(signal)

        self._iteration_count = iteration
        self._total_tool_calls = total_tool_calls
        self._total_llm_calls = total_llm_calls

        duration_ms = (time.time() - self._start_time) * 1000

        if not paused_for_user:
            # Cleanup only after completion; preserve state for resume if paused.
            self._stagnation_detector.cleanup_all()

        # ========== FINAL RESPONSE SYNTHESIS ==========
        if paused_for_user:
            final_response = self._build_pause_response()
        else:
            final_response = self._synthesize_final_response(
                plan=plan,
                outcomes=collected_outcomes,
                on_stream=on_stream_chunk,
            )

        if self._session_context and final_response and not paused_for_user:
            last_msg = self._session_context.messages[-1] if self._session_context.messages else None
            if not (last_msg and last_msg.get("role") == "assistant" and last_msg.get("content") == final_response):
                self._session_context.add_message({"role": "assistant", "content": final_response})

        # Compute step counts
        steps_completed = sum(
            1 for s in self._plan_state.steps.values()
            if s.status == StepStatus.COMPLETED
        )
        steps_skipped = sum(
            1 for s in self._plan_state.steps.values()
            if s.status == StepStatus.SKIPPED
        )
        steps_failed = sum(
            1 for s in self._plan_state.steps.values()
            if s.status == StepStatus.FAILED
        )

        # Use goal_achieved() for success (not just is_terminated)
        goal_achieved = self._plan_state.goal_achieved()
        if paused_for_user:
            self._log(
                "info",
                "Wizard paused awaiting user clarification.",
            )
        else:
            self._log(
                "info",
                f"Wizard complete: goal_achieved={goal_achieved}, "
                f"iterations={iteration}, completed={steps_completed}, "
                f"skipped={steps_skipped}, failed={steps_failed}, "
                f"duration={duration_ms:.0f}ms"
            )

        if goal_achieved:
            self._emit_event(
                WizardEvent(
                    event_type=WizardEventType.GOAL_ACHIEVED,
                    data={
                        "goal": self._plan_state.goal,
                        "completed": steps_completed,
                        "skipped": steps_skipped,
                    },
                )
            )

        # Emit final context window metrics after all LLM calls complete
        self._emit_context_window_update()

        # Build final context state for session persistence
        final_context_state = None
        if self._session_context:
            final_context_state = self._session_context.to_session_dict()

        return WizardResult(
            success=self._plan_state.goal_achieved(),
            final_response=final_response or "Task processing complete.",
            plan_state=self._plan_state,
            ledger=self._ledger,
            total_iterations=iteration,
            total_tool_calls=total_tool_calls,
            total_llm_calls=total_llm_calls,
            duration_ms=duration_ms,
            steps_completed=steps_completed,
            steps_skipped=steps_skipped,
            steps_failed=steps_failed,
            final_context_state=final_context_state,
            events=list(self._events),
            paused=paused_for_user,
            user_prompt=self._pending_user_prompt,
        )

    def _handle_failed_steps(self) -> None:
        """
        Handle FAILED steps by either retrying or skipping.
        Uses step.attempt_count (authoritative) instead of len(history) (can be evicted).
        """
        for step in list(self._plan_state.steps.values()):
            if step.status != StepStatus.FAILED:
                continue

            # Use step.attempt_count (authoritative, survives ledger eviction)
            if step.attempt_count < self.config.max_retries_per_step:
                # Reset for retry (attempt_count incremented on next dispatch)
                self._plan_state.reset_step_for_retry(step.step_num)
            else:
                # Max retries exceeded - skip the step
                skip_reason = f"Max retries ({self.config.max_retries_per_step}) exceeded after {step.attempt_count} attempts. Last error: {step.last_error or 'unknown'}"
                self._plan_state.mark_step_skipped(step.step_num, skip_reason)
                self._stagnation_detector.reset_step(step.step_num)
                self._emit_event(
                    WizardEvent(
                        event_type=WizardEventType.STEP_SKIPPED,
                        step_num=step.step_num,
                        data={
                            "reason": "max_retries_exceeded",
                            "error": step.last_error or "unknown",
                            "attempts": step.attempt_count,
                            "message": skip_reason,
                        },
                    )
                )

    def _has_recoverable_steps(self) -> bool:
        """Check if there are any steps that can still make progress."""
        for step in self._plan_state.steps.values():
            # PENDING steps with satisfied deps will be handled
            if step.status == StepStatus.PENDING:
                return True
            # FAILED steps can be retried
            if step.status == StepStatus.FAILED:
                return True
            # IN_PROGRESS steps are being worked on
            if step.status == StepStatus.IN_PROGRESS:
                return True
        return False

    def _handle_stagnation(self, signal: StagnationSignal) -> None:
        """
        Handle stagnation by skipping the problematic step.
        Uses mark_step_skipped instead of REMOVE patch to properly satisfy dependencies.
        """
        if not signal.step_num:
            return

        # For severe stagnation (identical outputs, no progress), skip immediately
        if signal.severity >= 0.8:
            stag_reason = f"Stagnation detected: {signal.reason}"
            self._plan_state.mark_step_skipped(signal.step_num, stag_reason)
            self._stagnation_detector.reset_step(signal.step_num)
            self._emit_event(
                WizardEvent(
                    event_type=WizardEventType.STEP_SKIPPED,
                    step_num=signal.step_num,
                    data={
                        "reason": "stagnation",
                        "error": signal.reason,
                        "severity": signal.severity,
                        "message": stag_reason,
                    },
                )
            )

    def _ingest_outcome(self, outcome: WorkerOutcome, entry_id: str) -> None:
        """
        Ingest worker outcome into stores.

        Mutation order:
        1. Ledger (audit) - always
        2. PlanState (step status) - always
        3. KnowledgeStore (facts) - auto-append all
        4. PlanState (patches) - via PolicyGate, version-checked
        """
        # 1. LEDGER: Record completion (audit trail)
        self._ledger.record_completion(entry_id, outcome)

        # 2. PLAN_STATE: Update step status
        if outcome.success:
            self._plan_state.mark_step_complete(
                outcome.step_num, outcome.final_response or "Completed"
            )
            self._stagnation_detector.reset_step(outcome.step_num)
        else:
            self._plan_state.mark_step_failed(outcome.step_num, outcome.error or "Unknown error")

        # 3. KNOWLEDGE: Auto-append all facts (no promotion logic)
        for fact in outcome.facts:
            self._knowledge.upsert(fact)

        # 4. PATCHES: Apply via PolicyGate with version safety
        # Note: File dedup tracking handled via SessionContext.read_files
        self._apply_patches(outcome)

    def _apply_patches(self, outcome: WorkerOutcome) -> None:
        """Ignore direct worker patches; Wizard owns plan mutations."""
        if outcome.patches:
            self._log(
                "warning",
                f"Ignoring {len(outcome.patches)} direct worker patches; use PATCH_SUGGESTION blocks instead.",
            )

    def _apply_patch_list(self, patches: List[PlanPatch], source: str) -> None:
        """
        Apply patches with version safety and lifecycle tracking.

        Rejects patches where base_version != current plan version.
        This handles the case where plan changed while worker was executing.
        """
        for patch in patches:
            # VERSION CHECK: Reject stale patches
            if patch.base_plan_version != self._plan_state.version:
                self._log(
                    "warning",
                    f"Rejecting stale patch {patch.patch_id}: "
                    f"base_version={patch.base_plan_version}, "
                    f"current={self._plan_state.version}"
                )
                self._ledger.record_patch_proposed(
                    patch_id=patch.patch_id,
                    source=source,
                    patch_type=patch.operations[0].type.value if patch.operations else "unknown",
                    target_steps=[op.target_step for op in patch.operations],
                    justification=patch.justification,
                )
                self._ledger.record_patch_decision(
                    patch_id=patch.patch_id,
                    approved=False,
                    rejection_reason="stale_version",
                )
                continue

            # Record proposal
            self._ledger.record_patch_proposed(
                patch_id=patch.patch_id,
                source=source,
                patch_type=patch.operations[0].type.value if patch.operations else "unknown",
                target_steps=[op.target_step for op in patch.operations],
                justification=patch.justification,
            )

            # Get decision from PolicyGate
            decision = self._policy_gate.evaluate(patch, self._plan_state)

            # Record decision
            self._ledger.record_patch_decision(
                patch_id=patch.patch_id,
                approved=decision.approved,
                rejection_reason=decision.reason if not decision.approved else None,
            )

            # Apply if approved
            if decision.approved:
                self._emit_plan_snapshot(f"patch_{patch.patch_id}", "pre_patch")
                applied = self._plan_state.apply_patch(patch)
                if applied:
                    self._ledger.record_patch_applied(
                        patch_id=patch.patch_id,
                        resulting_version=self._plan_state.version,
                    )
                    self._emit_plan_snapshot(f"patch_{patch.patch_id}_applied", "post_patch")

    def _apply_patch_suggestions(
        self,
        suggestions: List[PatchSuggestion],
        source_step: int,
    ) -> None:
        """Convert worker suggestions into Wizard-owned patches and apply."""
        if not suggestions:
            return

        for suggestion in suggestions:
            patch = self._build_patch_from_suggestion(suggestion, source_step)
            if patch:
                self._apply_patch_list([patch], source="worker_suggestion")

    def _build_patch_from_suggestion(
        self,
        suggestion: PatchSuggestion,
        source_step: int,
    ) -> Optional[PlanPatch]:
        """Build a PlanPatch from a worker suggestion (Wizard controls application)."""
        patch_type = (suggestion.patch_type or "").lower()

        if patch_type == "insert":
            objective = (
                str(suggestion.objective).strip() if suggestion.objective is not None else ""
            )
            if not objective:
                return None
            if len(self._plan_state.steps) >= self.config.max_plan_size:
                self._log("warning", "Skipping suggested insert: plan at max size")
                return None
            insert_after = suggestion.insert_after or source_step
            if not isinstance(insert_after, int):
                try:
                    insert_after = int(insert_after)
                except (TypeError, ValueError):
                    return None
            if insert_after not in self._plan_state.steps:
                return None
            patch = PlanPatch.create_insert(
                base_version=self._plan_state.version,
                objective=objective,
                tool_hint=suggestion.tool_hint,
                insert_after=insert_after,
                justification=suggestion.rationale,
            )
            if patch.operations and patch.operations[0].new_step is not None:
                phase = suggestion.phase or "execution"
                if phase not in ("discovery", "execution", "verification"):
                    phase = "execution"
                patch.operations[0].new_step["phase"] = phase
                depends_on = suggestion.depends_on if isinstance(suggestion.depends_on, list) else []
                depends_on = [d for d in depends_on if isinstance(d, int)]
                patch.operations[0].new_step["depends_on"] = depends_on or [insert_after]
                patch.operations[0].new_step["required"] = suggestion.required
            return patch

        if patch_type == "replace":
            target_step = suggestion.target_step
            if target_step is None:
                return None
            if not isinstance(target_step, int):
                try:
                    target_step = int(target_step)
                except (TypeError, ValueError):
                    return None
            if target_step not in self._plan_state.steps:
                return None
            if suggestion.tool_hint is None:
                return None
            return PlanPatch.create_replace(
                base_version=self._plan_state.version,
                step_num=target_step,
                new_tool_hint=suggestion.tool_hint,
                justification=suggestion.rationale,
            )

        if patch_type == "remove":
            target_step = suggestion.target_step
            if target_step is None:
                return None
            if not isinstance(target_step, int):
                try:
                    target_step = int(target_step)
                except (TypeError, ValueError):
                    return None
            if target_step not in self._plan_state.steps:
                return None
            return PlanPatch.create_remove(
                base_version=self._plan_state.version,
                step_num=target_step,
                justification=suggestion.rationale,
            )

        return None

    def _synthesize_final_response(
        self,
        plan: WizardPlan,
        outcomes: List[WorkerOutcome],
        on_stream: Optional[Callable[[str, int, bool], None]] = None,
    ) -> str:
        """
        Synthesize final response from collected outcomes.

        Uses the ResponseSynthesizer to:
        1. Collect tool outputs and step summaries from outcomes
        2. Generate a coherent final response
        3. Stream it via callback if provided

        Args:
            plan: The executed plan
            outcomes: Collected successful worker outcomes
            on_stream: Optional streaming callback

        Returns:
            Synthesized final response string
        """
        # If no outcomes, provide fallback
        if not outcomes:
            fallback = self._build_no_outcomes_response(plan)
            if on_stream:
                self._synthesizer.stream_content(fallback, on_stream)
            return fallback

        # Build synthesis input from outcomes
        tool_outputs = []
        step_summaries = []
        partial_response = None

        for outcome in outcomes:
            # Collect tool results from facts
            for fact in outcome.facts:
                if fact.source == FactSource.TOOL and fact.tool_name:
                    tool_outputs.append({
                        "tool": fact.tool_name,
                        "output": str(fact.value)[:10000]
                    })

            # Use the last non-empty final response as partial
            if outcome.final_response:
                partial_response = outcome.final_response
                step_summaries.append(f"Step {outcome.step_num}: {outcome.final_response[:150]}")

        # Determine goal type
        goal_type = plan.goal_type.value if hasattr(plan.goal_type, 'value') else str(plan.goal_type)

        synthesis_input = SynthesisInput(
            goal=plan.goal,
            goal_type=goal_type,
            tool_outputs=tool_outputs,
            step_summaries=step_summaries,
            partial_response=partial_response,
        )

        # Use synthesizer with optional streaming
        result = self._synthesizer.synthesize(synthesis_input, on_stream=on_stream)

        self._log(
            "debug",
            f"Synthesis complete: method={result.synthesis_method}, "
            f"llm_called={result.llm_called}, duration={result.duration_ms:.0f}ms"
        )

        return result.content

    def _build_no_outcomes_response(self, plan: WizardPlan) -> str:
        """Build a non-silent fallback response when no outcomes were accepted."""
        if self._goal_aborted:
            reason = self._goal_abort_reason or "Goal aborted due to unrecoverable issues."
            return f"Unable to complete the goal: {reason}"

        steps_failed = [
            s for s in self._plan_state.steps.values()
            if s.status == StepStatus.FAILED
        ]
        steps_skipped = [
            s for s in self._plan_state.steps.values()
            if s.status == StepStatus.SKIPPED
        ]

        lines = [
            f"Unable to complete the goal: {plan.goal}",
            f"Steps failed: {len(steps_failed)}, skipped: {len(steps_skipped)}.",
        ]

        error_details = []
        for step in steps_failed[:3]:
            if step.last_error:
                error_details.append(f"Step {step.step_num}: {step.last_error}")
        if error_details:
            lines.append("Recent errors:")
            lines.extend(error_details)

        return "\n".join(lines)

    def _build_pause_response(self) -> str:
        """Build a response indicating the wizard is awaiting user input."""
        if not self._pending_user_prompt:
            return "Paused awaiting user input."

        question = self._pending_user_prompt.get("question", "")
        options = self._pending_user_prompt.get("options", [])

        lines = [f"Question: {question}"]
        if options:
            lines.append(f"Options: {', '.join(options)}")
        return "\n".join(lines)

    # ======================================================================
    # REFLECTION STAGE METHODS
    # ======================================================================

    def _fallback_reflection_output(
        self,
        step: Any,
        outcome: WorkerOutcome,
    ) -> WizardReflectionOutput:
        """Create a minimal reflection output when reflection is disabled."""
        if outcome.success:
            verdict = ReflectionVerdict.ACCEPT
            user_message = outcome.final_response or "Step completed."
        else:
            verdict = ReflectionVerdict.REDO
            user_message = outcome.error or "Step failed; retrying."

        return WizardReflectionOutput(
            verdict=verdict,
            reasoning="Reflection disabled",
            confidence=0.2,
            user_message=user_message,
        )

    def _reflect_on_outcome(
        self,
        plan: WizardPlan,
        step: Any,  # StepState
        outcome: WorkerOutcome,
        previous_outcomes: List[WorkerOutcome],
        iteration: int,
    ) -> WizardReflectionOutput:
        """
        Build reflection input and invoke reflector.
        """
        # Convert GoalType if needed
        goal_type = plan.goal_type
        if isinstance(goal_type, str):
            try:
                goal_type = GoalType(goal_type.lower())
            except ValueError:
                goal_type = GoalType.TASK

        # Build global context
        global_context = ReflectionContext(
            goal=plan.goal,
            goal_type=goal_type,
            goal_success_criteria=(
                plan.success_criteria.description
                if plan.success_criteria else None
            ),
            total_steps=len(self._plan_state.steps),
            completed_steps=sum(
                1 for s in self._plan_state.steps.values()
                if s.status == StepStatus.COMPLETED
            ),
            failed_steps=sum(
                1 for s in self._plan_state.steps.values()
                if s.status == StepStatus.FAILED
            ),
            skipped_steps=sum(
                1 for s in self._plan_state.steps.values()
                if s.status == StepStatus.SKIPPED
            ),
            remaining_steps=sum(
                1 for s in self._plan_state.steps.values()
                if s.status in (StepStatus.PENDING, StepStatus.IN_PROGRESS)
            ),
            key_facts=self._get_top_facts_as_dicts(10),
            total_iterations=iteration,
            total_tool_calls=sum(o.metrics.tool_calls_made for o in previous_outcomes),
            total_llm_calls=sum(o.metrics.llm_calls_made for o in previous_outcomes),
            elapsed_ms=(time.time() - self._start_time) * 1000,
        )

        # Build step context
        step_context = StepContext(
            step_num=step.step_num,
            objective=step.override_objective or step.objective,
            tool_hint=step.tool_hint,
            phase=step.phase.value if hasattr(step.phase, 'value') else str(step.phase),
            attempt_count=step.attempt_count,
            depends_on=step.depends_on,
            is_required=step.required,
            previous_errors=self._get_step_errors(step.step_num),
        )

        # Convert outcome to dict for reflection input
        outcome_dict = {
            "success": outcome.success,
            "final_response": outcome.final_response,
            "error": outcome.error,
            "termination_reason": outcome.termination_reason,
            "tool_errors": list(outcome.tool_errors),
            "facts": [
                {
                    "key": f.key,
                    "value": f.value,
                    "tool_name": f.tool_name,
                }
                for f in outcome.facts
            ],
        }

        # Convert all steps to dicts
        all_steps_dicts = [
            {
                "step_num": s.step_num,
                "objective": s.objective,
                "status": s.status,
            }
            for s in self._plan_state.steps.values()
        ]

        # Build reflection input
        reflection_input = WizardReflectionInput(
            global_context=global_context,
            step_context=step_context,
            outcome=outcome_dict,
            all_steps=all_steps_dicts,
            recent_outcomes=[
                {
                    "success": o.success,
                    "final_response": o.final_response,
                    "error": o.error,
                }
                for o in previous_outcomes[-5:]
            ],
        )

        # Invoke reflector
        self._log("debug", f"Reflecting on step {step.step_num} outcome...")
        return self._reflector.reflect(reflection_input)

    def _apply_reflection_verdict(
        self,
        step: Any,  # StepState
        outcome: WorkerOutcome,
        reflection: WizardReflectionOutput,
        collected_outcomes: List[WorkerOutcome],
        on_stream: Optional[Callable[[str, int, bool], None]],
    ) -> None:
        """
        Apply the reflection verdict to update state.
        """
        self._log(
            "debug",
            f"Reflection verdict: {reflection.verdict.value} "
            f"(confidence={reflection.confidence:.2f})"
        )

        if reflection.verdict == ReflectionVerdict.ACCEPT:
            self._handle_accept(step, outcome, reflection, collected_outcomes)

        elif reflection.verdict == ReflectionVerdict.ACCEPT_AND_EXTEND:
            self._handle_accept_extend(step, outcome, reflection, collected_outcomes)

        elif reflection.verdict == ReflectionVerdict.REDO:
            self._handle_redo(step, outcome, reflection)

        elif reflection.verdict == ReflectionVerdict.ABORT_STEP:
            self._handle_abort_step(step, reflection)

        elif reflection.verdict == ReflectionVerdict.ABORT_GOAL:
            self._handle_abort_goal(reflection)

        # Stream user message if provided
        if reflection.user_message and on_stream:
            self._stream_content(reflection.user_message, on_stream)

        # Log quality issues
        if reflection.quality.issues:
            self._log("warning", f"Quality issues: {reflection.quality.issues}")
            self._emit_event(
                WizardEvent(
                    event_type=WizardEventType.QUALITY_ISSUE_DETECTED,
                    step_num=step.step_num,
                    data=QualityIssueData(
                        step_num=step.step_num,
                        issues=reflection.quality.issues,
                        errors=[],
                        severity="medium",
                    ).__dict__,
                )
            )
        if reflection.quality.errors:
            self._log("warning", f"Detected errors: {reflection.quality.errors}")
            self._emit_event(
                WizardEvent(
                    event_type=WizardEventType.ERROR_DETECTED,
                    step_num=step.step_num,
                    data=QualityIssueData(
                        step_num=step.step_num,
                        issues=[],
                        errors=reflection.quality.errors,
                        severity="high",
                    ).__dict__,
                )
            )

        # Apply any worker-suggested patch proposals (Wizard decides + applies)
        if outcome.patch_suggestions and not self._goal_aborted:
            self._apply_patch_suggestions(outcome.patch_suggestions, step.step_num)

    def _handle_accept(
        self,
        step: Any,
        outcome: WorkerOutcome,
        reflection: WizardReflectionOutput,
        collected_outcomes: List[WorkerOutcome],
    ) -> None:
        """Handle ACCEPT verdict."""
        self._plan_state.mark_step_complete(
            step.step_num,
            outcome.final_response or "Completed"
        )
        self._ingest_outcome_data(outcome)
        collected_outcomes.append(outcome)
        self._stagnation_detector.reset_step(step.step_num)

        self._log("info", f"Step {step.step_num} ACCEPTED")
        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.STEP_COMPLETED,
                step_num=step.step_num,
                data=StepCompletedData(
                    step_num=step.step_num,
                    objective=step.override_objective or step.objective,
                    outcome_summary=outcome.final_response or "Completed",
                    quality_score=reflection.quality.overall_score,
                    verdict=reflection.verdict.value,
                    scaffolded_count=0,
                ).__dict__,
            )
        )
        self._emit_context_window_update()

    def _handle_accept_extend(
        self,
        step: Any,
        outcome: WorkerOutcome,
        reflection: WizardReflectionOutput,
        collected_outcomes: List[WorkerOutcome],
    ) -> None:
        """Handle ACCEPT_AND_EXTEND verdict."""
        # Check if this was a refusal - if so, SKIP the step instead of completing it
        # The scaffolded steps will do the actual work
        if getattr(outcome, 'is_refusal', False):
            self._log("info", f"Step {step.step_num} was a refusal - marking SKIPPED, scaffolding decomposed work")
            self._plan_state.mark_step_skipped(
                step.step_num,
                "Task decomposed into smaller steps"
            )
            # Don't collect the refusal outcome - it has no useful content
        else:
            # Normal case: actual work was done, mark as complete
            self._plan_state.mark_step_complete(
                step.step_num,
                outcome.final_response or "Completed"
            )
            self._ingest_outcome_data(outcome)
            collected_outcomes.append(outcome)

        # Then, scaffold new steps
        self._stagnation_detector.reset_step(step.step_num)
        scaffolded_steps = self._filter_scaffolded_steps(step, reflection.scaffolded_steps)
        inserted_count = 0
        for scaffolded in scaffolded_steps:
            if self._scaffold_new_step(scaffolded, after_step=step.step_num):
                inserted_count += 1
                self._scaffolded_total += 1
                self._scaffolded_by_step[step.step_num] = (
                    self._scaffolded_by_step.get(step.step_num, 0) + 1
                )

        self._log(
            "info",
            f"Step {step.step_num} ACCEPTED, scaffolded "
            f"{inserted_count} new steps"
        )
        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.STEPS_SCAFFOLDED,
                step_num=step.step_num,
                data={
                    "count": inserted_count,
                    "total_scaffolded": self._scaffolded_total,
                },
            )
        )
        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.STEP_COMPLETED,
                step_num=step.step_num,
                data=StepCompletedData(
                    step_num=step.step_num,
                    objective=step.override_objective or step.objective,
                    outcome_summary=outcome.final_response or "Completed",
                    quality_score=reflection.quality.overall_score,
                    verdict=reflection.verdict.value,
                    scaffolded_count=inserted_count,
                ).__dict__,
            )
        )
        self._emit_context_window_update()

    def _handle_redo(
        self,
        step: Any,
        outcome: WorkerOutcome,
        reflection: WizardReflectionOutput,
    ) -> None:
        """Handle REDO verdict."""
        mods = reflection.redo_modifications

        if mods:
            # Apply modifications
            if mods.new_objective:
                self._plan_state.set_override_objective(step.step_num, mods.new_objective)
            if mods.new_tool_hint:
                self._plan_state.set_step_tool_hint(step.step_num, mods.new_tool_hint)
            if mods.injected_context:
                self._session_context.add_message({
                    "role": "system",
                    "content": f"Additional guidance: {mods.injected_context}"
                })
            if mods.avoid_patterns:
                # Add as system message constraint
                constraints = "\n".join(f"- DO NOT: {p}" for p in mods.avoid_patterns)
                self._session_context.add_message({
                    "role": "system",
                    "content": f"Constraints for step {step.step_num}:\n{constraints}"
                })

        # Record the error for future attempts
        self._record_step_error(step.step_num, outcome.error or "Redo requested")

        # Reset for retry
        self._plan_state.reset_step_for_retry(
            step.step_num,
            last_error=outcome.error or "Redo requested",
        )

        self._log(
            "info",
            f"Step {step.step_num} marked for REDO "
            f"(attempt {step.attempt_count + 1})"
        )
        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.STEP_FAILED,
                step_num=step.step_num,
                data={
                    "reason": outcome.error or "Redo requested",
                    "verdict": reflection.verdict.value,
                },
            )
        )

    def _handle_abort_step(
        self,
        step: Any,
        reflection: WizardReflectionOutput,
    ) -> None:
        """Handle ABORT_STEP verdict."""
        abort_reason = reflection.abort_reason or "Not achievable"
        abort_message = f"Wizard decision: {abort_reason}"
        self._plan_state.mark_step_skipped(step.step_num, abort_message)
        self._stagnation_detector.reset_step(step.step_num)

        self._log("info", f"Step {step.step_num} ABORTED: {abort_reason}")
        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.STEP_SKIPPED,
                step_num=step.step_num,
                data={
                    "reason": "aborted",
                    "error": abort_reason,
                    "message": abort_message,
                },
            )
        )

    def _handle_abort_goal(
        self,
        reflection: WizardReflectionOutput,
    ) -> None:
        """Handle ABORT_GOAL verdict."""
        self._log(
            "error",
            f"GOAL ABORTED: {reflection.abort_reason}"
        )

        # Mark all pending steps as skipped
        for step in self._plan_state.steps.values():
            if step.status in (StepStatus.PENDING, StepStatus.IN_PROGRESS):
                self._plan_state.mark_step_skipped(
                    step.step_num,
                    "Goal aborted"
                )

        # This will cause the loop to terminate
        self._goal_aborted = True
        self._goal_abort_reason = reflection.abort_reason
        self._emit_event(
            WizardEvent(
                event_type=WizardEventType.GOAL_ABORTED,
                data={"reason": reflection.abort_reason or "Aborted"},
            )
        )

    # ======================================================================
    # PLAN SCAFFOLDING METHODS
    # ======================================================================

    def _scaffold_new_step(
        self,
        scaffolded: ScaffoldedStep,
        after_step: int,
    ) -> bool:
        """Insert a new scaffolded step into the plan."""
        # Create patch to insert
        patch = PlanPatch.create_insert(
            base_version=self._plan_state.version,
            objective=scaffolded.objective,
            tool_hint=scaffolded.tool_hint,
            insert_after=after_step,
            justification=scaffolded.rationale,
        )
        if patch.operations and patch.operations[0].new_step is not None:
            patch.operations[0].new_step["phase"] = scaffolded.phase
            patch.operations[0].new_step["depends_on"] = (
                scaffolded.depends_on or [after_step]
            )
            patch.operations[0].new_step["required"] = scaffolded.required
            patch.operations[0].new_step["scaffolded_from"] = after_step
            parent_depth = getattr(
                self._plan_state.steps.get(after_step), "scaffold_depth", 0
            )
            patch.operations[0].new_step["scaffold_depth"] = parent_depth + 1

        # Apply patch
        self._emit_plan_snapshot(f"patch_{patch.patch_id}", "pre_patch")
        applied = self._plan_state.apply_patch(patch)
        if applied:
            self._emit_plan_snapshot(f"patch_{patch.patch_id}_applied", "post_patch")
            self._log(
                "debug",
                f"Scaffolded new step after {after_step}: {scaffolded.objective[:50]}..."
            )
            return True

        self._log(
            "warning",
            f"Failed to scaffold step: {scaffolded.objective[:50]}..."
        )
        return False

    def _filter_scaffolded_steps(
        self,
        parent_step: Any,
        scaffolded_steps: List[ScaffoldedStep],
    ) -> List[ScaffoldedStep]:
        """Apply scaffolding limits and depth checks."""
        if not scaffolded_steps:
            return []

        per_step_limit = max(0, self.config.max_scaffolded_per_step)
        total_left = max(0, self.config.max_total_scaffolded - self._scaffolded_total)
        plan_slots = max(0, self.config.max_plan_size - len(self._plan_state.steps))
        allowed = min(per_step_limit, total_left, plan_slots)
        if allowed <= 0:
            return []

        parent_depth = getattr(parent_step, "scaffold_depth", 0)
        filtered: List[ScaffoldedStep] = []
        for scaffolded in scaffolded_steps:
            if parent_depth + 1 > self.config.max_scaffold_depth:
                continue
            filtered.append(scaffolded)
            if len(filtered) >= allowed:
                break

        return filtered

    # ======================================================================
    # HELPER METHODS
    # ======================================================================

    def _get_step_errors(self, step_num: int) -> List[str]:
        """Get previous errors for a step."""
        return self._step_errors.get(step_num, [])

    def _record_step_error(self, step_num: int, error: str) -> None:
        """Record an error for a step."""
        if step_num not in self._step_errors:
            self._step_errors[step_num] = []
        self._step_errors[step_num].append(error)

    def _get_top_facts_as_dicts(self, limit: int) -> List[Dict[str, Any]]:
        """Get top knowledge facts as dictionaries."""
        if not self._knowledge:
            return []

        facts = self._knowledge.get_recent_facts(limit)
        return [
            {
                "key": f.key,
                "value": f.value,
                "confidence": f.confidence,
            }
            for f in facts
        ]

    def _ingest_outcome_data(self, outcome: WorkerOutcome) -> None:
        """
        Ingest outcome data into knowledge store and apply patches.
        This is the data ingestion part, separate from step status updates.
        """
        # Ingest knowledge facts
        for fact in outcome.facts:
            self._knowledge.upsert(fact)

        # Apply patches via PolicyGate
        self._apply_patches(outcome)

    def _stream_content(
        self,
        content: str,
        on_stream: Callable[[str, int, bool], None],
    ) -> None:
        """Stream content to callback."""
        # Stream in chunks
        chunk_size = 50
        for i in range(0, len(content), chunk_size):
            chunk = content[i:i + chunk_size]
            is_final = (i + chunk_size >= len(content))
            on_stream(chunk, i, is_final)
