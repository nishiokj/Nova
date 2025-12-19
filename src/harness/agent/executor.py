"""
Executor - runs plans step by step and returns an ExecutionTrace.

This module intentionally contains no logging. Logging is handled by the Agent.

Architecture:
- Standard execution: Linear step execution with retry logic
- Microloop execution: State machine with reasoning, adaptation, and explicit artifact tracking

The microloop provides:
1. Explicit state machine (READY -> TOOL_PENDING -> REASONING -> COMPLETE/ESCALATE)
2. Monotonic reasoning (COMMITs cannot be undone)
3. Detailed artifact tracking (files created, modified, failures)
4. Extension points for invariants and completion conditions
"""

import json
import os
import sys
import time
import time as _time  # Alias for observability logging
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Dict, List, Optional

# ========== OBSERVABILITY TRACE FILE ==========
# Writes to a file you can `tail -f` in another terminal
_TRACE_FILE = None
_TRACE_FILE_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "..", "logs", "execution_trace.log")

def _trace(msg: str) -> None:
    """Write observability trace to file for debugging."""
    global _TRACE_FILE
    try:
        if _TRACE_FILE is None:
            os.makedirs(os.path.dirname(_TRACE_FILE_PATH), exist_ok=True)
            _TRACE_FILE = open(_TRACE_FILE_PATH, "a", buffering=1)  # Line buffered
        _TRACE_FILE.write(f"{msg}\n")
        _TRACE_FILE.flush()
    except Exception:
        pass  # Don't let tracing errors affect execution

from util.llm_adapter import LLMAdapter, ToolCall
from .plan_models import (
    Discovery,
    DiscoveryType,
    ExecutionTrace,
    Plan,
    PlanPhase,
    PlanStatus,
    PlanStep,
    StepContext,
    StepResult,
    ToolCallRecord,
    ValidationResult,
)
from .prompts import EXECUTION_STEP_PROMPT, SYNTHESIS_PROMPT, format_prompt
from .tool_registry import ToolRegistry, ToolResult, ToolStatus

# Microloop imports (optional - gracefully degrade if not available)
try:
    from .execution_models import (
        ExecutionManifest,
        StepManifestEntry,
        MicroloopContext,
        StepExecutionState,
        get_timeout_policy,
    )
    from .microloop import Microloop, MicroloopConfig, MicroloopResult
    MICROLOOP_AVAILABLE = True
except ImportError:
    MICROLOOP_AVAILABLE = False
    ExecutionManifest = None
    Microloop = None


class Executor:
    """
    Executes plans and tracks what actually happened.

    Key difference from current approach: we're executing against a PLAN
    with known success criteria, not just reacting to LLM tool calls.

    Supports two execution modes:
    1. Standard: Linear step execution with retry logic (default)
    2. Microloop: State machine with reasoning, adaptation, and artifact tracking

    Enable microloop with: executor.enable_microloop()
    """

    def __init__(
        self,
        llm: LLMAdapter,
        tool_registry: ToolRegistry,
        max_tool_calls: int = 5,
        graphd_client: Optional[Any] = None
    ):
        self.llm = llm
        self.tool_registry = tool_registry
        self.max_tool_calls = max_tool_calls
        self.graphd_client = graphd_client  # Optional graphd client for microloop
        # NO logger - Executor doesn't log, Agent does
        self._step_callbacks: List[Callable[[int, ToolCallRecord], None]] = []
        self._llm_lock = threading.Lock()  # Serialize LLM calls; adapter is not thread-safe

        # Logging callback for full LLM call details (set by Agent)
        self._llm_call_logger: Optional[Callable[[int, str, str, str, str, List, List, float, str, Optional[Dict]], None]] = None

        # Microloop support
        self._use_microloop = False
        self._microloop: Optional[Microloop] = None
        self._microloop_config: Optional[MicroloopConfig] = None
        self._current_manifest: Optional[ExecutionManifest] = None

    def enable_microloop(self, config: Optional["MicroloopConfig"] = None) -> bool:
        """
        Enable microloop execution mode.

        Args:
            config: Optional MicroloopConfig for customization

        Returns:
            True if microloop was enabled, False if not available
        """
        if not MICROLOOP_AVAILABLE:
            return False

        self._use_microloop = True
        self._microloop_config = config or MicroloopConfig()
        self._microloop = Microloop(
            tool_registry=self.tool_registry,
            llm=self.llm,
            config=self._microloop_config,
            graphd_client=self.graphd_client
        )
        if hasattr(self._microloop, "set_log_callback"):
            self._microloop.set_log_callback(self._handle_microloop_log_event)

        return True

    def disable_microloop(self) -> None:
        """Disable microloop execution mode."""
        self._use_microloop = False
        self._microloop = None
        self._current_manifest = None

    def add_step_callback(self, callback: Callable[[int, ToolCallRecord], None]):
        """Register callback invoked when a tool call completes within a step."""
        self._step_callbacks.append(callback)

    def set_llm_call_logger(
        self,
        logger_fn: Callable[[int, str, str, str, str, List, List, float, str, Optional[Dict]], None]
    ):
        """
        Set callback for logging full LLM call details.

        Callback signature:
            logger_fn(step_num, objective, instructions, input_str, raw_response,
                      tool_calls, tool_results, duration_ms, phase, manifest)
        """
        self._llm_call_logger = logger_fn

    def _log_llm_call(
        self,
        step_num: int,
        objective: str,
        instructions: str,
        input_str: str,
        raw_response: str,
        tool_calls: List,
        tool_results: List,
        duration_ms: float,
        phase: str,
        manifest: Optional[Dict[str, Discovery]] = None
    ):
        """Emit LLM call details to logger callback if set."""
        if not self._llm_call_logger:
            return
        try:
            self._llm_call_logger(
                step_num, objective, instructions, input_str, raw_response,
                tool_calls, tool_results, duration_ms, phase, manifest
            )
        except Exception as e:
            # ========== MAKE LOGGING ERRORS VISIBLE ==========
            import sys
            _trace(f"[EXECUTOR ERROR] _log_llm_call failed: {type(e).__name__}: {str(e)[:200]}")

    def _log_tool_execution(
        self,
        step_num: int,
        objective: str,
        tool_name: str,
        tool_args: Dict,
        result: ToolResult,
        duration_ms: float,
        phase: str,
        manifest: Optional[Dict[str, Discovery]] = None
    ):
        """Log tool execution result for visibility."""
        if not self._llm_call_logger:
            return
        try:
            self._llm_call_logger(
                step_num,
                objective,
                f"[TOOL EXECUTION]\nTool: {tool_name}",
                json.dumps(tool_args, indent=2) if tool_args else "",
                str(result.output)[:2000] if result.output else "",
                [{"name": tool_name, "arguments": tool_args}],
                [{
                    "tool": tool_name,
                    "output": str(result.output)[:2000] if result.output else "",
                    "success": result.is_success,
                    "error": str(result.error) if result.error else None
                }],
                duration_ms,
                f"{phase}_tool_result",
                manifest
            )
        except Exception as e:
            # ========== MAKE LOGGING ERRORS VISIBLE ==========
            import sys
            _trace(f"[EXECUTOR ERROR] _log_tool_execution failed: {type(e).__name__}: {str(e)[:200]}")

    def _emit_step_callback(self, step_num: int, record: ToolCallRecord):
        """Emit tool progress callbacks safely."""
        for callback in self._step_callbacks:
            try:
                callback(step_num, record)
            except Exception:
                # Executor deliberately stays silent - Agent handles logging
                continue

    def _safe_extract_discovery(
        self,
        tool_name: str,
        result: ToolResult,
        discoveries: Optional[Dict[str, Discovery]],
        step_num: Optional[int] = None
    ) -> None:
        """Safely extract discovery - never crashes execution if this fails."""
        if discoveries is None:
            return
        try:
            self._extract_and_store_discovery(tool_name, result, discoveries, step_num)
        except (AttributeError, TypeError, Exception):
            # Discovery extraction is optional - don't let it crash execution
            # This handles bytecode cache issues where method may not exist
            pass

    def _clip_output(self, data: Any, max_length: int = 800) -> str:
        """Compact tool outputs before feeding them back into prompts/logs."""
        if data is None:
            return ""
        text = str(data).replace("\r\n", "\n")
        if len(text) <= max_length:
            return text
        return text[: max_length] + "..."

    def _shorten_summary(self, text: Optional[str], max_length: int = 80) -> str:
        """Compact helper to keep progress/status snippets tiny."""
        if not text:
            return ""
        clean = " ".join(str(text).split())
        if len(clean) <= max_length:
            return clean
        return clean[: max_length - 3] + "..."

    def _update_plan_status_tracker(
        self,
        plan_status: Optional[Dict[int, Dict[str, Any]]],
        step_num: int,
        status: PlanStatus,
        summary: Optional[str] = None
    ) -> None:
        """Update mutable plan status mapping in-place."""
        if plan_status is None:
            return

        note = summary or plan_status.get(step_num, {}).get("summary") if plan_status else ""
        plan_status[step_num] = {
            "status": status,
            "summary": self._shorten_summary(note or f"step {step_num}", 60)
        }

    def _status_note_for_result(self, step_result: StepResult, step: PlanStep) -> str:
        """Generate tiny summary label from a step result without tool output."""
        if step_result.status == PlanStatus.SKIPPED:
            return "skipped"
        if step_result.status == PlanStatus.FAILED:
            return "failed"
        if step_result.status == PlanStatus.PARTIAL:
            return "partial"
        return step.objective or f"step {step.step_num}"

    def execute(
        self,
        plan: Plan,
        serialized_context: Dict[str, Any],
        tools: List[Any],
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
        plan_status: Optional[Dict[int, Dict[str, Any]]] = None
    ) -> ExecutionTrace:
        """
        Execute a plan and return trace of what happened.

        Args:
            plan: Execution plan
            serialized_context: Serialized context from ContextManager (Responses API format)
                               Must contain 'instructions' and 'input' keys
            tools: Tool definitions
            on_stream_chunk: Optional callback for streaming final response synthesis.
                            Called with (chunk: str, chunk_index: int, is_final: bool)
            plan_status: Mutable per-step status tracker (step_num -> status/summary)

        Does NOT mutate plan - Agent is responsible for updating plan state.
        Does NOT log - Agent handles all logging.
        """
        # ========== CRITICAL: LOG EXECUTION ENTRY POINT ==========
        # This log MUST fire immediately so we know execution started
        _exec_start = _time.time()
        _trace(f"\n[EXECUTOR] {_time.strftime('%H:%M:%S')} | execute() ENTRY | plan_goal={plan.goal[:80] if plan.goal else 'none'}... | steps={len(plan.steps)} | requires_tools={plan.requires_tools} | microloop={self._use_microloop}")

        # Validate serialized_context
        if not serialized_context or "instructions" not in serialized_context:
            raise ValueError("serialized_context with 'instructions' key is required")
        trace = ExecutionTrace(plan=plan)
        execution_discoveries: Dict[str, Discovery] = {}  # Shared across all steps
        start_time = time.time()

        try:
            if not plan.requires_tools:
                # Simple execution - just get LLM response (with optional streaming)
                if plan.steps:
                    self._update_plan_status_tracker(
                        plan_status,
                        plan.steps[0].step_num,
                        PlanStatus.IN_PROGRESS,
                        plan.steps[0].objective
                    )
                step = plan.steps[0] if plan.steps else None
                base_instructions = serialized_context.get("instructions", "")
                execution_instructions = format_prompt(
                    EXECUTION_STEP_PROMPT,
                    base_instructions=base_instructions,
                    step_num=step.step_num if step else 1,
                    objective=step.objective if step else plan.goal,
                    tool_hint=(step.tool_hint or "") if step else "",
                    phase=step.phase.value if step else PlanPhase.EXECUTION.value,
                    success_criteria=step.success_criteria.description if step and step.success_criteria else "",
                    preconditions="; ".join(step.preconditions) if step else "",
                    postconditions="; ".join(step.postconditions) if step else "",
                    verification_method=step.verification_method if step else "",
                    max_tool_calls=step.max_tool_calls if step else self.max_tool_calls
                )
                if not execution_instructions:
                    execution_instructions = base_instructions
                step_guidance = (
                    self._create_step_guidance(step, StepContext(), plan_status)
                    if step else None
                )
                combined_instructions = "\n\n".join(
                    part for part in [execution_instructions, step_guidance] if part
                ) or base_instructions
                if on_stream_chunk:
                    # Stream the response directly
                    trace.final_response = self._stream_direct_response(
                        serialized_context, on_stream_chunk, combined_instructions
                    )
                else:
                    # Use Responses API
                    # Get tools for LLM (even for direct response, LLM should know what tools exist)
                    tools = self.tool_registry.list_tools(enabled_only=True)
                    tool_defs = [t.to_definition() for t in tools]
                    tools_internally_tagged = [td.to_responses_format() for td in tool_defs]

                    llm_start = time.time()
                    llm_input = serialized_context.get("input", "")
                    # ========== LOG PRE-LLM CALL ==========
                    _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | LLM CALL STARTING | type=direct_response | input_len={len(llm_input)} | instructions_len={len(combined_instructions)}")
                    with self._llm_lock:
                        response = self.llm.respond(
                            input=llm_input,
                            instructions=combined_instructions,
                            tools=tools_internally_tagged
                        )
                    llm_duration_ms = (time.time() - llm_start) * 1000
                    _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | LLM CALL COMPLETE | duration={llm_duration_ms:.0f}ms | response_len={len(response.content or '')}")

                    # Log the complete LLM call
                    self._log_llm_call(
                        step_num=step.step_num if step else 1,
                        objective=step.objective if step else plan.goal,
                        instructions=combined_instructions,
                        input_str=llm_input,
                        raw_response=response.content or "",
                        tool_calls=[],
                        tool_results=[],
                        duration_ms=llm_duration_ms,
                        phase="execution",
                        manifest=execution_discoveries
                    )
                    trace.final_response = response.content
                trace.llm_calls += 1

                # Create a StepResult for the single reasoning step
                if plan.steps:
                    step_result = StepResult(
                        step_num=plan.steps[0].step_num,
                        status=PlanStatus.COMPLETED,
                        accumulated_data={"response": trace.final_response},
                        final_response=trace.final_response,
                        duration_ms=(time.time() - start_time) * 1000
                    )
                    trace.step_results.append(step_result)
                    self._update_plan_status_tracker(
                        plan_status,
                        plan.steps[0].step_num,
                        step_result.status,
                        self._status_note_for_result(step_result, plan.steps[0])
                    )
            else:
                # Step-by-step execution
                trace = self._execute_plan_stepwise(
                    plan, tools, trace, serialized_context, on_stream_chunk, plan_status,
                    execution_discoveries
                )

        except Exception as e:
            # Executor can throw exceptions - Agent will handle them
            trace.final_response = f"Execution error: {str(e)}"
            raise

        trace.total_duration_ms = (time.time() - start_time) * 1000
        return trace

    def _execute_plan_stepwise(
        self,
        plan: Plan,
        tools: List[Any],
        trace: ExecutionTrace,
        serialized_context: Dict[str, Any],
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None,
        plan_status: Optional[Dict[int, Dict[str, Any]]] = None,
        execution_discoveries: Optional[Dict[str, Discovery]] = None
    ) -> ExecutionTrace:
        """
        Execute plan step-by-step with resilient dependency handling.

        Architecture:
        1. Normalize dependencies (handle empty/None, remove self-refs and invalid refs)
        2. Detect and break any circular dependencies
        3. Topological sort into execution levels (steps at same level can run in parallel)
        4. Execute level-by-level, parallelizing within each level
        5. Never throw RuntimeError for dependency issues - use SKIPPED status instead

        Each step is a unit of work that may involve multiple tool calls.
        Updates plan step status after each step so dependencies work correctly.
        """
        # ========== CRITICAL: LOG STEPWISE EXECUTION ENTRY ==========
        _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | _execute_plan_stepwise() ENTRY | total_steps={len(plan.steps)} | discovery_required={plan.discovery_required} | microloop={self._use_microloop}")

        # ========== PHASE 0: MANIFEST INITIALIZATION (MICROLOOP MODE) ==========
        if self._use_microloop and MICROLOOP_AVAILABLE:
            self._current_manifest = self._create_manifest_for_plan(plan)

        # ========== PHASE 1: DEPENDENCY GRAPH PREPARATION ==========
        # Normalize and sanitize dependencies
        self._normalize_dependencies(plan.steps)

        # Detect and break any circular dependencies
        removed_edges = self._detect_and_break_cycles(plan.steps)
        if removed_edges:
            # Note: Could log this via callback if needed, but Executor stays silent
            pass

        # Topological sort into execution levels
        execution_levels = self._topological_sort_levels(plan.steps)
        if plan.discovery_required:
            discovery_steps = [s for s in plan.steps if s.phase == PlanPhase.DISCOVERY]
            execution_steps = [s for s in plan.steps if s.phase == PlanPhase.EXECUTION]
            if discovery_steps and execution_steps:
                # Enforce discovery-first ordering so execution steps don't get skipped
                discovery_levels = self._topological_sort_levels(discovery_steps)
                execution_levels = discovery_levels + self._topological_sort_levels(execution_steps)

        # ========== PHASE 2: LEVEL-BY-LEVEL EXECUTION ==========
        remaining_discovery = {
            s.step_num for s in plan.steps if s.phase == PlanPhase.DISCOVERY
        }
        discovery_required = plan.discovery_required and bool(remaining_discovery)

        for level_idx, level_steps in enumerate(execution_levels):
            # ========== LOG LEVEL EXECUTION START ==========
            step_nums = [s.step_num for s in level_steps]
            _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | level {level_idx + 1}/{len(execution_levels)} | steps={step_nums}")

            # ---- PRE-EXECUTION CHECKS FOR ALL STEPS IN LEVEL ----
            steps_to_execute = []
            for step in level_steps:
                # PHASE GATE: Cannot start execution phase before discovery completes
                if discovery_required and step.phase == PlanPhase.EXECUTION and remaining_discovery:
                    # Mark as skipped instead of throwing
                    step.status = PlanStatus.SKIPPED
                    step.error = "Skipped: Discovery phase not complete"
                    trace.step_results.append(StepResult(
                        step_num=step.step_num,
                        status=PlanStatus.SKIPPED,
                        error="Discovery phase must complete before execution steps",
                        phase=step.phase
                    ))
                    self._update_plan_status_tracker(
                        plan_status,
                        step.step_num,
                        PlanStatus.SKIPPED,
                        "skipped"
                    )
                    continue

                # UNCERTAINTY GATE: Check uncertainty threshold before execution steps
                if (step.phase == PlanPhase.EXECUTION and
                    plan.discovery_required and
                    not plan.triage_complete and
                    plan.current_uncertainty > plan.uncertainty_threshold):
                    if plan.goal_type == "question":
                        # For questions, just note the uncertainty - proceed anyway
                        plan.triage_summary = f"Proceeding despite uncertainty {plan.current_uncertainty:.2f}"
                        plan.triage_complete = True
                    else:
                        # For tasks/creation, skip this step
                        step.status = PlanStatus.SKIPPED
                        step.error = f"Uncertainty too high: {plan.current_uncertainty:.2f} > {plan.uncertainty_threshold:.2f}"
                        trace.step_results.append(StepResult(
                            step_num=step.step_num,
                            status=PlanStatus.SKIPPED,
                            error=step.error,
                            phase=step.phase
                        ))
                        self._update_plan_status_tracker(
                            plan_status,
                            step.step_num,
                            PlanStatus.SKIPPED,
                            "skipped"
                        )
                        continue

                # PRECONDITION CHECK: Verify preconditions before execution steps
                if step.phase == PlanPhase.EXECUTION and step.preconditions:
                    preconditions_met, unmet = self._verify_preconditions(step.preconditions)
                    if not preconditions_met:
                        if plan.goal_type == "question":
                            # For questions, just note warning - proceed anyway
                            step.validation_details = f"Warning: Preconditions not fully met: {unmet}"
                        else:
                            # For tasks/creation, skip
                            step.status = PlanStatus.SKIPPED
                            step.error = f"Preconditions not met: {unmet}"
                            trace.step_results.append(StepResult(
                                step_num=step.step_num,
                                status=PlanStatus.SKIPPED,
                                error=step.error,
                                phase=step.phase
                            ))
                            self._update_plan_status_tracker(
                                plan_status,
                                step.step_num,
                                PlanStatus.SKIPPED,
                                "skipped"
                            )
                            continue

                # DEPENDENCY CHECK: Verify all dependencies are satisfied
                # Note: With topological sort, dependencies SHOULD be satisfied
                # But we check defensively in case a dependency failed/was skipped
                if not self._dependencies_met(step, plan.steps):
                    step.status = PlanStatus.SKIPPED
                    step.error = f"Dependencies not satisfied: {step.depends_on}"
                    trace.step_results.append(StepResult(
                        step_num=step.step_num,
                        status=PlanStatus.SKIPPED,
                        error=step.error,
                        phase=step.phase
                    ))
                    self._update_plan_status_tracker(
                        plan_status,
                        step.step_num,
                        PlanStatus.SKIPPED,
                        "blocked"
                    )
                    continue

                # Step passed all checks - add to execution list
                steps_to_execute.append(step)

            # ---- EXECUTE ALL VALID STEPS IN THIS LEVEL (PARALLEL) ----
            if steps_to_execute:
                for step in steps_to_execute:
                    self._update_plan_status_tracker(
                        plan_status,
                        step.step_num,
                        PlanStatus.IN_PROGRESS,
                        step.objective
                    )

                # Choose execution path: microloop or standard
                if self._use_microloop and self._microloop:
                    _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | executing via MICROLOOP | steps={[s.step_num for s in steps_to_execute]}")
                    level_results = self._execute_level_parallel_microloop(
                        steps_to_execute, tools, trace, serialized_context, plan, plan_status,
                        execution_discoveries
                    )
                else:
                    _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | executing via STANDARD | steps={[s.step_num for s in steps_to_execute]}")
                    level_results = self._execute_level_parallel(
                        steps_to_execute, tools, trace, serialized_context, plan, plan_status,
                        execution_discoveries
                    )

                # ---- POST-EXECUTION UPDATES FOR EACH STEP ----
                for step, step_result in zip(steps_to_execute, level_results):
                    # Update plan step status
                    step.status = step_result.status
                    step.error = step_result.error
                    step.duration_ms = step_result.duration_ms
                    step.context = step_result.context if hasattr(step_result, "context") else step.context

                    # UNCERTAINTY TRACKING: Update uncertainty after discovery steps
                    if step.phase == PlanPhase.DISCOVERY:
                        self._update_uncertainty(plan, step, step_result)

                    # POSTCONDITION VERIFICATION: Verify postconditions after execution steps
                    if step.phase == PlanPhase.EXECUTION and step.postconditions:
                        postconditions_met, unmet = self._verify_postconditions(
                            step.postconditions,
                            step.verification_method,
                            step_result
                        )
                        if not postconditions_met:
                            step.validation_passed = False
                            step.validation_details = f"Postconditions not met: {unmet}"
                        else:
                            step.validation_passed = True
                            step.validation_details = "Postconditions verified"

                    # Store result in trace
                    trace.step_results.append(step_result)
                    self._update_plan_status_tracker(
                        plan_status,
                        step.step_num,
                        step_result.status,
                        self._status_note_for_result(step_result, step)
                    )

                    # Record step summary in discoveries for future steps to see
                    if execution_discoveries is not None:
                        self._record_step_summary(step, step_result, execution_discoveries)

                    # Track discovery phase completion
                    if discovery_required and step.phase == PlanPhase.DISCOVERY:
                        remaining_discovery.discard(step.step_num)
                        if not remaining_discovery:
                            discovery_required = False
                            plan.triage_complete = True
                            plan.triage_summary = f"Discovery complete. Uncertainty reduced to {plan.current_uncertainty:.2f}"

            # Check if we should stop early (all remaining steps are execution but discovery incomplete)
            # This prevents infinite waiting if discovery steps all failed
            if discovery_required:
                remaining_steps_all_execution = all(
                    s.phase == PlanPhase.EXECUTION
                    for level in execution_levels[level_idx + 1:]
                    for s in level
                )
                if remaining_steps_all_execution and remaining_discovery:
                    # Mark remaining discovery as failed and proceed
                    plan.triage_complete = True
                    plan.triage_summary = "Discovery incomplete but proceeding (some discovery steps failed/skipped)"
                    discovery_required = False
                    remaining_discovery.clear()

        # ========== PHASE 3: FINALIZE MANIFEST (MICROLOOP MODE) ==========
        if self._use_microloop and self._current_manifest:
            self._current_manifest.finalize()

        # ========== PHASE 4: FINAL RESPONSE SYNTHESIS ==========
        if trace.tool_calls > 0 or not trace.final_response:
            trace.final_response = self._synthesize_final_response(
                plan, trace, serialized_context, on_stream_chunk
            )

        return trace

    def _synthesize_final_response(
        self,
        plan: Plan,
        trace: ExecutionTrace,
        serialized_context: Dict[str, Any],
        on_stream_chunk: Optional[Callable[[str, int, bool], None]] = None
    ) -> str:
        """
        Generate a human-readable final response from tool results.
        Makes an LLM call to synthesize findings into a proper answer.

        If on_stream_chunk is provided, streams chunks via callback.
        """
        # Collect evidence from tool executions
        tool_results_summary = []
        for step_result in trace.step_results:
            if step_result.status == PlanStatus.COMPLETED:
                for tool_record in step_result.tool_calls_made:
                    if tool_record.result.is_success:
                        output_preview = str(tool_record.result.output)[:1000]
                        tool_results_summary.append(
                            f"- {tool_record.tool_name}: {output_preview}"
                        )

        # If no completed work, provide fallback
        if not tool_results_summary:
            fallback_msg = ""
            if trace.step_results:
                fallback_msg = f"Attempted {len(trace.step_results)} step(s) but couldn't complete the task."
            else:
                fallback_msg = "No steps were executed."
            # Emit fallback as single chunk if streaming
            if on_stream_chunk:
                on_stream_chunk(fallback_msg, 0, True)
            return fallback_msg

        # Create synthesis prompt
        tool_results_text = chr(10).join(tool_results_summary[:5])
        synthesis_prompt = format_prompt(
            SYNTHESIS_PROMPT,
            goal=plan.goal,
            goal_type=plan.goal_type,
            user_intent=getattr(plan, "user_intent", ""),
            success_criteria=plan.success_criteria.description if plan.success_criteria else "",
            tool_results=tool_results_text
        )
        if not synthesis_prompt:
            synthesis_prompt = f"""Based on the tool executions below, provide a clear, concise answer to the user's request.

User's request: {plan.goal}

Tool results:
{tool_results_text}

Provide a natural, conversational response that directly answers the user's question. Do not repeat the raw data - summarize and explain the key findings."""

        # Make LLM call to synthesize (with optional streaming)
        try:
            if on_stream_chunk:
                # STREAMING PATH: Use Responses API format for stream()
                full_content = ""
                chunk_index = 0
                had_chunks = False
                with self._llm_lock:
                    stream_gen = self.llm.stream(
                        input=serialized_context.get("input", ""),
                        instructions=synthesis_prompt
                    )

                    try:
                        while True:
                            chunk = next(stream_gen)
                            full_content += chunk
                            if chunk:
                                had_chunks = True
                            on_stream_chunk(chunk, chunk_index, False)
                            chunk_index += 1
                    except StopIteration as stop:
                        # Generator finished - emit final marker
                        # Get final response from generator return value if available
                        if hasattr(stop, 'value') and stop.value:
                            full_content = stop.value.content or full_content
                        if had_chunks:
                            on_stream_chunk("", chunk_index, True)
                        else:
                            final_text = full_content or "I completed the task but couldn't generate a summary."
                            full_content = final_text
                            on_stream_chunk(final_text, chunk_index, True)

                trace.llm_calls += 1
                return full_content or "I completed the task but couldn't generate a summary."

            else:
                # Use Responses API (non-streaming) - Time the LLM call for logging
                llm_start = time.time()
                synthesis_input = serialized_context.get("input", "")
                # ========== LOG PRE-LLM CALL ==========
                _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | LLM CALL STARTING | type=synthesis | input_len={len(synthesis_input)} | prompt_len={len(synthesis_prompt)}")
                with self._llm_lock:
                    response = self.llm.respond(
                        input=synthesis_input,
                        instructions=synthesis_prompt
                    )
                llm_duration_ms = (time.time() - llm_start) * 1000
                _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | LLM CALL COMPLETE | type=synthesis | duration={llm_duration_ms:.0f}ms")

                # Log the synthesis call (manifest=None as synthesis happens post-execution)
                self._log_llm_call(
                    step_num=0,  # Synthesis is not a numbered step
                    objective="Synthesize final response",
                    instructions=synthesis_prompt,
                    input_str=synthesis_input,
                    raw_response=response.content or "",
                    tool_calls=[],
                    tool_results=[],
                    duration_ms=llm_duration_ms,
                    phase="synthesis",
                    manifest=None
                )

            trace.llm_calls += 1
            return response.content or "I completed the task but couldn't generate a summary."

        except Exception:
            # Fallback: use simple concatenation
            fallback = "\n".join(tool_results_summary[:3])
            if on_stream_chunk:
                on_stream_chunk(fallback, 0, True)
            return fallback

    def _stream_direct_response(
        self,
        serialized_context: Dict[str, Any],
        on_stream_chunk: Callable[[str, int, bool], None],
        instructions: Optional[str] = None
    ) -> str:
        """
        Stream a direct LLM response (no tool synthesis needed).
        Used when plan.requires_tools is False.
        """
        full_content = ""
        chunk_index = 0
        had_chunks = False

        try:
            # Use Responses API format for stream()
            with self._llm_lock:
                stream_gen = self.llm.stream(
                    input=serialized_context.get("input", ""),
                    instructions=instructions or serialized_context.get("instructions", ""),
                    tools=None
                )

                try:
                    while True:
                        chunk = next(stream_gen)
                        full_content += chunk
                        if chunk:
                            had_chunks = True
                        on_stream_chunk(chunk, chunk_index, False)
                        chunk_index += 1
                except StopIteration as stop:
                    # Generator finished - emit final marker
                    # Get final response from generator return value if available
                    if hasattr(stop, 'value') and stop.value:
                        full_content = stop.value.content or full_content
                    if had_chunks:
                        on_stream_chunk("", chunk_index, True)
                    else:
                        final_text = full_content or "I couldn't generate a response."
                        full_content = final_text
                        on_stream_chunk(final_text, chunk_index, True)

            return full_content or "I couldn't generate a response."

        except Exception as e:
            error_msg = f"Error generating response: {str(e)}"
            on_stream_chunk(error_msg, 0, True)
            return error_msg

    def _execute_step(
        self,
        step: PlanStep,
        tools: List[Any],
        trace: ExecutionTrace,
        serialized_context: Dict[str, Any],
        plan_status: Optional[Dict[int, Dict[str, Any]]] = None,
        execution_discoveries: Optional[Dict[str, Discovery]] = None
    ) -> StepResult:
        """
        Execute a single step (may involve multiple tool calls).

        Returns StepResult - does NOT mutate step.
        Does NOT log.
        Can throw exceptions for critical failures.

        A step is complete when:
        1. LLM stops requesting tools (has final answer), OR
        2. max_tool_calls reached for this step
        """

        start_time = time.time()
        context = StepContext()

        # Add step guidance to help LLM focus
        # Pass context so guidance can show what data we already have
        step_guidance = self._create_step_guidance(step, context, plan_status, execution_discoveries)

        # Prepare LLM call parameters - Use Responses API
        base_instructions = serialized_context.get("instructions", "")
        execution_instructions = format_prompt(
            EXECUTION_STEP_PROMPT,
            base_instructions=base_instructions,
            step_num=step.step_num,
            objective=step.objective,
            tool_hint=step.tool_hint or "",
            phase=step.phase.value,
            success_criteria=step.success_criteria.description if step.success_criteria else "",
            preconditions="; ".join(step.preconditions),
            postconditions="; ".join(step.postconditions),
            verification_method=step.verification_method or "",
            max_tool_calls=step.max_tool_calls
        )
        if not execution_instructions:
            execution_instructions = base_instructions
        combined_instructions = "\n\n".join(
            part for part in [execution_instructions, step_guidance] if part
        )
        llm_input = serialized_context.get("input", "")
        # Convert tool definitions to internally-tagged format
        tools_internally_tagged = [t.to_responses_format() if hasattr(t, 'to_responses_format') else t for t in tools]

        tool_calls_in_step = 0
        step_complete = False
        tool_hint_executed = False
        final_response_content = None
        error_message = None

        # Execute until step completes or hits limit
        while not step_complete and tool_calls_in_step < step.max_tool_calls:
            # Use Responses API - Time the LLM call for logging
            llm_start = time.time()
            # ========== LOG PRE-LLM CALL ==========
            _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | LLM CALL STARTING | type=step_execution | step={step.step_num} | objective={step.objective[:50] if step.objective else 'none'}... | tool_calls_so_far={tool_calls_in_step}")
            with self._llm_lock:
                response = self.llm.respond(
                    input=llm_input,
                    instructions=combined_instructions,
                    tools=tools_internally_tagged
                )
            llm_duration_ms = (time.time() - llm_start) * 1000
            _trace(f"[EXECUTOR] {_time.strftime('%H:%M:%S')} | LLM CALL COMPLETE | step={step.step_num} | duration={llm_duration_ms:.0f}ms | has_tool_calls={response.has_tool_calls}")

            trace.llm_calls += 1

            # Log the complete LLM call
            self._log_llm_call(
                step_num=step.step_num,
                objective=step.objective,
                instructions=combined_instructions,
                input_str=llm_input,
                raw_response=response.content or "",
                tool_calls=response.tool_calls if response.has_tool_calls else [],
                tool_results=[],  # Will be populated after tool execution
                duration_ms=llm_duration_ms,
                phase=step.phase.value,
                manifest=execution_discoveries
            )

            if not response.has_tool_calls:
                # LLM thinks step is done (no more tools needed)
                step_complete = True
                final_response_content = response.content
                if not context.tool_calls_made:
                    trace.final_response = response.content
                break

            remaining_calls = step.max_tool_calls - tool_calls_in_step
            tool_calls_batch = response.tool_calls[:remaining_calls]

            # Fast-path: run cheap, read-only calls in parallel for speed
            if self._can_parallelize_batch(tool_calls_batch):
                (
                    batch_tool_hint_executed,
                    batch_last_success_output,
                    criteria_met,
                    criteria_output
                ) = self._execute_tool_calls_parallel(
                    tool_calls_batch,
                    step,
                    context,
                    trace,
                    execution_discoveries
                )

                tool_calls_in_step += len(tool_calls_batch)
                tool_hint_executed = tool_hint_executed or batch_tool_hint_executed

                if criteria_met:
                    step_complete = True
                    final_response_content = criteria_output
                    break

                if batch_tool_hint_executed:
                    step_complete = True
                    if batch_last_success_output is not None:
                        final_response_content = str(batch_last_success_output)[:500]
                    else:
                        # Extract any successful results from the batch
                        batch_outputs = [
                            str(record.result.output)[:200]
                            for record in context.tool_calls_made
                            if record.result.is_success and record.result.output
                        ]
                        final_response_content = "\n".join(batch_outputs) if batch_outputs else f"Completed: {step.objective}"
                    break

                # Continue to next loop for more tool calls or reasoning
                continue

            # Process all tool calls in this LLM response
            for tool_call in tool_calls_batch:
                if tool_calls_in_step >= step.max_tool_calls:
                    break

                # Execute tool
                tool_start_time = time.time()
                result = self.tool_registry.execute(tool_call.name, **tool_call.arguments)
                duration_ms = (time.time() - tool_start_time) * 1000

                # Record in context
                record = ToolCallRecord(
                    tool_name=tool_call.name,
                    arguments=tool_call.arguments,
                    result=result,
                    duration_ms=duration_ms,
                    timestamp=time.time()
                )
                context.tool_calls_made.append(record)
                context.add_tool_result(tool_call.name, result)
                self._emit_step_callback(step.step_num, record)

                # Log the tool execution result
                self._log_tool_execution(
                    step_num=step.step_num,
                    objective=step.objective,
                    tool_name=tool_call.name,
                    tool_args=tool_call.arguments,
                    result=result,
                    duration_ms=duration_ms,
                    phase=step.phase.value,
                    manifest=execution_discoveries
                )

                # Extract discovery from tool result (safe - won't crash on failure)
                self._safe_extract_discovery(tool_call.name, result, execution_discoveries, step.step_num)

                tool_calls_in_step += 1
                trace.tool_calls += 1

                # NEW: Check if success criteria met after tool call
                if step.success_criteria and step.success_criteria.required_outputs:
                    if context.has_required_data(step.success_criteria.required_outputs):
                        step_complete = True
                        # Use tool result directly, don't make another LLM call
                        if result.is_success:
                            final_response_content = self._clip_output(result.output)
                        else:
                            # Collect any successful outputs from this step
                            successful_outputs = [
                                str(r.result.output)[:200]
                                for r in context.tool_calls_made
                                if r.result.is_success and r.result.output
                            ]
                            final_response_content = "\n".join(successful_outputs) if successful_outputs else f"Completed: {step.objective}"
                        break

                # Check if this was the suggested tool and it succeeded
                if step.tool_hint and tool_call.name == step.tool_hint and result.is_success:
                    tool_hint_executed = True

                # Track failures
                if not result.is_success:
                    trace.tool_failures += 1

            # HEURISTIC: If the suggested tool was executed successfully, consider step complete
            # This prevents the LLM from looping on the same tool repeatedly
            if tool_hint_executed and tool_calls_in_step >= 1:
                step_complete = True
                # OPTIMIZATION: Use tool result directly instead of making another LLM call
                # This saves 1 LLM call per step (significant performance improvement)
                last_tool_result = context.tool_calls_made[-1].result
                if last_tool_result.is_success:
                    final_response_content = self._clip_output(last_tool_result.output, 500)
                else:
                    # Extract any successful results from earlier tool calls in this step
                    successful_outputs = [
                        str(record.result.output)[:200]
                        for record in context.tool_calls_made
                        if record.result.is_success and record.result.output
                    ]
                    if successful_outputs:
                        final_response_content = "\n".join(successful_outputs)
                    else:
                        final_response_content = f"Completed step: {step.objective}"
                break

        # Calculate duration
        duration_ms = (time.time() - start_time) * 1000

        # Determine step status
        if step_complete:
            status = PlanStatus.COMPLETED
        elif tool_calls_in_step >= step.max_tool_calls:
            status = PlanStatus.PARTIAL
            error_message = f"Max tool calls ({step.max_tool_calls}) reached before step completion"
        else:
            status = PlanStatus.FAILED
            error_message = "Step did not complete"

        # Return StepResult - Agent will handle validation, logging, state updates
        return StepResult(
            step_num=step.step_num,
            status=status,
            tool_calls_made=context.tool_calls_made,
            llm_messages=[],
            accumulated_data=context.accumulated_data,
            final_response=final_response_content,
            error=error_message,
            duration_ms=duration_ms,
            phase=step.phase,
            context=context
        )

    def _can_parallelize_batch(self, tool_calls: List[ToolCall]) -> bool:
        """Return True if all tool calls are marked safe to run in parallel"""
        return (
            len(tool_calls) > 1 and
            all(self.tool_registry.is_parallel_safe(tc.name) for tc in tool_calls)
        )

    def _execute_tool_calls_parallel(
        self,
        tool_calls: List[ToolCall],
        step: PlanStep,
        context: StepContext,
        trace: ExecutionTrace,
        execution_discoveries: Optional[Dict[str, Discovery]] = None
    ):
        """
        Execute a batch of read-only tool calls in parallel.

        Updates context, trace, and conversation scaffolding in original order.
        """
        last_success_output = None
        tool_hint_executed = False
        max_workers = min(len(tool_calls), 4)

        # Submit all calls
        futures = {}
        start_times = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            for idx, tool_call in enumerate(tool_calls):
                start_times[idx] = time.time()
                futures[executor.submit(self.tool_registry.execute, tool_call.name, **tool_call.arguments)] = (idx, tool_call)

            ordered_results: List[Optional[tuple]] = [None] * len(tool_calls)
            for future in as_completed(futures):
                idx, tool_call = futures[future]
                try:
                    result = future.result()
                except Exception as exc:  # Defensive: ensure failures are captured
                    result = ToolResult(
                        status=ToolStatus.ERROR,
                        output=None,
                        error=str(exc),
                        duration_ms=(time.time() - start_times[idx]) * 1000
                    )

                if result.duration_ms == 0:
                    result.duration_ms = (time.time() - start_times[idx]) * 1000

                ordered_results[idx] = (tool_call, result)

        # Apply results in original order for deterministic conversation state
        for tool_call, result in ordered_results:
            record = ToolCallRecord(
                tool_name=tool_call.name,
                arguments=tool_call.arguments,
                result=result,
                duration_ms=result.duration_ms,
                timestamp=time.time()
            )
            context.tool_calls_made.append(record)
            context.add_tool_result(tool_call.name, result)
            self._emit_step_callback(step.step_num, record)

            # Log the tool execution result
            self._log_tool_execution(
                step_num=step.step_num,
                objective=step.objective,
                tool_name=tool_call.name,
                tool_args=tool_call.arguments,
                result=result,
                duration_ms=result.duration_ms,
                phase=step.phase.value,
                manifest=execution_discoveries
            )

            # Extract discovery from tool result (safe - won't crash on failure)
            self._safe_extract_discovery(tool_call.name, result, execution_discoveries, step.step_num)

            trace.tool_calls += 1
            if not result.is_success:
                trace.tool_failures += 1
            else:
                last_success_output = result.output
                if step.tool_hint and tool_call.name == step.tool_hint:
                    tool_hint_executed = True

        # Success criteria check after all results applied
        criteria_met = False
        criteria_output = None
        if step.success_criteria and step.success_criteria.required_outputs:
            if context.has_required_data(step.success_criteria.required_outputs):
                criteria_met = True
                # Collect all successful outputs
                successful_outputs = [
                    str(result.output)[:200]
                    for _, result in ordered_results
                    if result.is_success and result.output
                ]
                if successful_outputs:
                    criteria_output = "\n".join(successful_outputs)
                elif last_success_output is not None:
                    criteria_output = self._clip_output(last_success_output)
                else:
                    criteria_output = f"Completed: {step.objective}"

        return tool_hint_executed, last_success_output, criteria_met, criteria_output

    def _create_step_guidance(
        self,
        step: PlanStep,
        context: Optional[StepContext] = None,
        plan_status: Optional[Dict[int, Dict[str, Any]]] = None,
        execution_discoveries: Optional[Dict[str, Discovery]] = None
    ) -> str:
        """Create system message to guide LLM for this specific step"""
        guidance = f"""You are currently executing Step {step.step_num} of a multi-step plan.

STEP OBJECTIVE: {step.objective}

SUCCESS CRITERIA: {step.success_criteria.description if step.success_criteria else "Complete the objective"}

"""

        # MICROLOOP: Show manifest of actual work done (when available)
        if self._use_microloop and self._current_manifest:
            manifest_guidance = self._current_manifest.to_step_guidance(step.step_num)
            if manifest_guidance:
                guidance += f"{manifest_guidance}\n\n"

        # Show context from previous steps
        if execution_discoveries:
            # First, show completed step summaries
            step_summaries = [
                (key, disc) for key, disc in execution_discoveries.items()
                if disc.type == DiscoveryType.STEP_SUMMARY and disc.step_num and disc.step_num < step.step_num
            ]
            if step_summaries:
                guidance += "COMPLETED STEPS:\n"
                for key, disc in sorted(step_summaries, key=lambda x: x[1].step_num or 0):
                    status_icon = "✓" if disc.status == "completed" else "✗" if disc.status == "failed" else "~"
                    tools_str = f" [tools: {', '.join(disc.tools_used)}]" if disc.tools_used else ""
                    guidance += f"  {status_icon} Step {disc.step_num}: {disc.objective or 'unknown'}{tools_str}\n"
                    if disc.result_summary:
                        guidance += f"      Result: {disc.result_summary[:100]}...\n"
                guidance += "\n"

            # Then show relevant discoveries with previews
            relevant = self._get_relevant_discoveries(step, execution_discoveries)
            # Filter out step summaries - we already showed those
            relevant = {k: v for k, v in relevant.items() if v.type != DiscoveryType.STEP_SUMMARY}
            if relevant:
                guidance += "AVAILABLE DATA FROM PREVIOUS STEPS:\n"
                for key, disc in list(relevant.items())[:5]:  # Max 5 to keep guidance concise
                    if disc.type == DiscoveryType.FILE_CONTENT:
                        guidance += f"  - File: {disc.path} ({disc.size or 0} bytes)\n"
                        if disc.preview:
                            preview = disc.preview[:150].replace('\n', ' ')
                            guidance += f"    Preview: {preview}...\n"
                    elif disc.type == DiscoveryType.SEARCH_RESULT:
                        guidance += f"  - Search '{disc.query}': {disc.total or 0} matches\n"
                        if disc.matches:
                            guidance += f"    Top matches: {', '.join(disc.matches[:3])}\n"
                    elif disc.type == DiscoveryType.DIRECTORY_LISTING:
                        guidance += f"  - Directory {disc.path}: {disc.total or 0} items\n"
                        if disc.files:
                            guidance += f"    Files: {', '.join(disc.files[:5])}\n"
                    elif disc.type == DiscoveryType.COMMAND_OUTPUT:
                        guidance += f"  - Command '{disc.command}':\n"
                        if disc.output:
                            output_preview = disc.output[:100].replace('\n', ' ')
                            guidance += f"    Output: {output_preview}...\n"
                    elif disc.type == DiscoveryType.ERROR:
                        guidance += f"  - ERROR in {disc.tool}: {disc.message[:80] if disc.message else 'unknown'}\n"
                guidance += "\n"

        # OPTIMIZATION: Show LLM what data we already have
        if context and context.accumulated_data:
            guidance += "DATA ALREADY COLLECTED:\n"
            for key, value in list(context.accumulated_data.items())[:3]:  # Max 3 to keep guidance concise
                value_str = str(value)[:100] if value else "None"
                guidance += f"  - {key}: {value_str}...\n"
            guidance += "\n"

        # OPTIMIZATION: Tell LLM what's still needed
        if step.success_criteria and step.success_criteria.required_outputs:
            missing = [req for req in step.success_criteria.required_outputs
                       if not context or req not in context.accumulated_data]
            if missing:
                guidance += f"STILL NEED: {', '.join(missing)}\n\n"
            else:
                guidance += "ALL REQUIRED DATA COLLECTED - provide final answer WITHOUT calling more tools\n\n"

        guidance += (
            "CRITICAL: This is a SINGLE FOCUSED STEP. Focus ONLY on completing this step. "
            "Once you have the required data, respond WITHOUT calling more tools.\n\n"
        )

        if step.tool_hint:
            guidance += f"SUGGESTED ACTION: Call {step.tool_hint}"
            if step.tool_args_hint:
                guidance += f" with args: {json.dumps(step.tool_args_hint)}"
            guidance += f"\nAfter calling {step.tool_hint} successfully, provide your answer. Do NOT call additional tools.\n"
        elif step.phase == PlanPhase.DISCOVERY:
            # Discovery steps ALWAYS need tools even if planner forgot to specify
            guidance += (
                "DISCOVERY STEP: You MUST use tools (search_filesystem, file_read, list_files) to gather information. "
                "Do NOT provide speculation - use tools to find actual data.\n"
            )
        elif self._objective_implies_tools(step.objective):
            # Objective implies tool usage even without explicit hint
            guidance += (
                "This step's objective requires tool usage. Use appropriate tools to complete it. "
                "Do NOT say you cannot use tools - you have full tool access.\n"
            )
        else:
            guidance += "This step is reasoning/synthesis only - no tools needed. Provide your analysis.\n"

        return guidance

    def _objective_implies_tools(self, objective: str) -> bool:
        """
        Detect if a step objective implies tool usage even without explicit tool_hint.

        This catches cases where the planner creates discovery-like steps
        but forgets to specify the tool.
        """
        objective_lower = objective.lower()

        # Keywords that strongly imply file/search operations
        tool_indicators = [
            "locate", "find", "search", "look for", "discover",
            "read", "open", "inspect", "examine", "check",
            "list", "directory", "folder", "contents",
            "execute", "run", "install", "create file", "write file",
            "modify", "edit", "update file", "delete"
        ]

        return any(indicator in objective_lower for indicator in tool_indicators)

    def _extract_and_store_discovery(
        self,
        tool_name: str,
        result: ToolResult,
        discoveries: Dict[str, Discovery],
        step_num: Optional[int] = None
    ) -> None:
        """
        Extract and store canonicalized discovery from tool result.
        Rules-based, no LLM - fast and cheap.
        """
        ts = time.time()

        if tool_name == "file_read" and result.is_success:
            path = result.metadata.get("path", "unknown") if result.metadata else "unknown"
            content = str(result.output) if result.output else ""
            discoveries[f"file:{path}"] = Discovery(
                type=DiscoveryType.FILE_CONTENT,
                timestamp=ts,
                path=path,
                size=len(content),
                preview=content[:500] if len(content) > 500 else content
            )

        elif tool_name == "file_write" and result.is_success:
            # Invalidate cached file content
            path = result.metadata.get("path", "") if result.metadata else ""
            if path:
                key_to_remove = f"file:{path}"
                if key_to_remove in discoveries:
                    del discoveries[key_to_remove]

        elif tool_name == "search_filesystem" and result.is_success:
            query = result.metadata.get("pattern", "unknown") if result.metadata else "unknown"
            output = result.output or ""
            matches = output.strip().split("\n") if isinstance(output, str) and output.strip() else []
            discoveries[f"search:{query}"] = Discovery(
                type=DiscoveryType.SEARCH_RESULT,
                timestamp=ts,
                query=query,
                matches=matches[:10],
                total=len(matches)
            )

        elif tool_name == "list_files" and result.is_success:
            path = result.metadata.get("path", ".") if result.metadata else "."
            output = result.output or ""
            files = output.strip().split("\n") if isinstance(output, str) and output.strip() else []
            discoveries[f"ls:{path}"] = Discovery(
                type=DiscoveryType.DIRECTORY_LISTING,
                timestamp=ts,
                path=path,
                files=files[:20],
                total=len(files)
            )

        elif tool_name == "bash_execute" and result.is_success:
            command = (result.metadata.get("command", "") if result.metadata else "")[:50]
            output = str(result.output)[:300] if result.output else ""
            if output and len(output) > 10:
                discoveries[f"bash:{command}"] = Discovery(
                    type=DiscoveryType.COMMAND_OUTPUT,
                    timestamp=ts,
                    command=command,
                    output=output
                )

        elif result.status == ToolStatus.ERROR:
            discoveries[f"error:{tool_name}:{step_num or 0}"] = Discovery(
                type=DiscoveryType.ERROR,
                timestamp=ts,
                tool=tool_name,
                message=str(result.error)[:200] if result.error else "Unknown error",
                step_num=step_num
            )

    def _get_relevant_discoveries(
        self,
        step: PlanStep,
        discoveries: Dict[str, Discovery]
    ) -> Dict[str, Discovery]:
        """
        Select discoveries relevant to this step.
        Simple heuristics - no LLM.
        """
        relevant = {}
        step_text = step.objective + " " + str(step.tool_args_hint or "")

        for key, disc in discoveries.items():
            # Always include errors
            if disc.type == DiscoveryType.ERROR:
                relevant[key] = disc
                continue

            # Include file content if step mentions the path
            if disc.type == DiscoveryType.FILE_CONTENT and disc.path:
                if disc.path in step_text:
                    relevant[key] = disc
                continue

            # Include search results if step is searching
            if disc.type == DiscoveryType.SEARCH_RESULT and step.tool_hint == "search_filesystem":
                relevant[key] = disc
                continue

            # Include directory listings if step is navigating filesystem
            if disc.type == DiscoveryType.DIRECTORY_LISTING and step.tool_hint in ["list_files", "file_read"]:
                relevant[key] = disc
                continue

        return relevant

    def _record_step_summary(
        self,
        step: PlanStep,
        step_result: StepResult,
        discoveries: Dict[str, Discovery]
    ) -> None:
        """Record a summary of a completed step for future steps to reference."""
        # Extract tools used from the step result
        tools_used = []
        if step_result.tool_calls_made:
            tools_used = list(set(tc.tool_name for tc in step_result.tool_calls_made))

        # Create a brief result summary
        result_summary = None
        if step_result.final_response:
            result_summary = str(step_result.final_response)[:200]
        elif step_result.accumulated_data:
            result_summary = f"Collected: {', '.join(step_result.accumulated_data.keys())}"

        discoveries[f"step:{step.step_num}"] = Discovery(
            type=DiscoveryType.STEP_SUMMARY,
            timestamp=time.time(),
            step_num=step.step_num,
            objective=step.objective[:100] if step.objective else None,
            status=step_result.status.value if step_result.status else "unknown",
            tools_used=tools_used,
            result_summary=result_summary
        )

    def _validate_step(self, step: PlanStep) -> ValidationResult:
        """Validate if step achieved its success criteria"""
        if not step.success_criteria:
            return ValidationResult(passed=True, details="No criteria specified")

        criteria = step.success_criteria

        # Check required outputs exist
        if criteria.required_outputs:
            missing_outputs = []
            for required in criteria.required_outputs:
                if not step.context or required not in step.context.accumulated_data:
                    missing_outputs.append(required)

            if missing_outputs:
                return ValidationResult(
                    passed=False,
                    details=f"Missing required outputs: {missing_outputs}",
                    confidence=1.0
                )

        # Run automated checks if defined
        if criteria.automated_checks:
            for check_name, check_config in criteria.automated_checks.items():
                if check_name == "min_items":
                    # Check if any accumulated data has minimum number of items
                    min_count = check_config
                    total_items = sum(len(v) if isinstance(v, list) else 1 for v in step.context.accumulated_data.values())
                    if total_items < min_count:
                        return ValidationResult(
                            passed=False,
                            details=f"Expected at least {min_count} items, got {total_items}",
                            confidence=1.0
                        )

        # Basic validation passed
        return ValidationResult(
            passed=True,
            details="All required outputs present" if criteria.required_outputs else "Step completed",
            confidence=0.8  # Could use LLM for higher confidence
        )

    def _dependencies_met(self, step: PlanStep, all_steps: List[PlanStep]) -> bool:
        """
        Check if step's dependencies are satisfied.

        Dependencies are met if the step is COMPLETED or PARTIAL.
        PARTIAL means some work was done and subsequent steps can proceed.
        Only PENDING and FAILED block dependent steps.
        """
        if not step.depends_on:
            return True

        for dep_num in step.depends_on:
            # Skip self-references (defensive check - should be filtered during normalization)
            if dep_num == step.step_num:
                continue

            dep_step = next((s for s in all_steps if s.step_num == dep_num), None)
            if not dep_step:
                return False

            # Accept COMPLETED or PARTIAL - both mean some work was done
            # Only PENDING and FAILED should block dependent steps
            if dep_step.status not in (PlanStatus.COMPLETED, PlanStatus.PARTIAL):
                return False

        return True

    # ========================================================================
    # DEPENDENCY RESILIENCE METHODS
    # ========================================================================

    def _normalize_dependencies(self, steps: List[PlanStep]) -> None:
        """
        Normalize and validate step dependencies in-place.

        - Handles None/empty depends_on gracefully
        - Removes self-references
        - Removes references to non-existent steps
        """
        valid_step_nums = {s.step_num for s in steps}

        for step in steps:
            # Handle None or missing depends_on
            if not step.depends_on:
                step.depends_on = []
                continue

            # Remove self-references and invalid references
            step.depends_on = [
                d for d in step.depends_on
                if d != step.step_num and d in valid_step_nums
            ]

    def _detect_and_break_cycles(self, steps: List[PlanStep]) -> List[tuple]:
        """
        Detect circular dependencies using DFS and break them.

        Returns list of (from_step, to_step) edges that were removed.
        Uses Tarjan's algorithm variant for cycle detection.
        """
        removed_edges = []

        # Build adjacency list: step_num -> list of dependent step_nums
        step_map = {s.step_num: s for s in steps}
        adj = {s.step_num: list(s.depends_on) for s in steps}

        # DFS state: 0=unvisited, 1=in_stack, 2=done
        state = {s.step_num: 0 for s in steps}

        def dfs(node: int, path: List[int]) -> None:
            """DFS to find and break back edges (cycles)."""
            state[node] = 1  # Mark as in current DFS stack

            # Copy to avoid modification during iteration
            for dep in list(adj[node]):
                if state[dep] == 1:
                    # Back edge found - this creates a cycle
                    # Remove this dependency to break the cycle
                    step_map[node].depends_on.remove(dep)
                    adj[node].remove(dep)
                    removed_edges.append((node, dep))
                elif state[dep] == 0:
                    dfs(dep, path + [node])

            state[node] = 2  # Mark as done

        # Run DFS from each unvisited node
        for step in steps:
            if state[step.step_num] == 0:
                dfs(step.step_num, [])

        return removed_edges

    def _topological_sort_levels(self, steps: List[PlanStep]) -> List[List[PlanStep]]:
        """
        Sort steps topologically and group by execution level.

        Steps at the same level have no dependencies on each other
        and can be executed in parallel.

        Uses Kahn's algorithm variant that tracks levels.

        Returns:
            List of levels, where each level is a list of steps that can run concurrently.
            Empty list if no steps provided.
        """
        if not steps:
            return []

        step_map = {s.step_num: s for s in steps}

        # Calculate in-degree for each step
        in_degree = {s.step_num: 0 for s in steps}
        for step in steps:
            for dep in step.depends_on:
                if dep in step_map:
                    # dep must complete before step, so step has incoming edge from dep
                    in_degree[step.step_num] += 1

        # Build reverse adjacency: step_num -> steps that depend on it
        dependents = {s.step_num: [] for s in steps}
        for step in steps:
            for dep in step.depends_on:
                if dep in dependents:
                    dependents[dep].append(step.step_num)

        levels = []
        remaining = set(s.step_num for s in steps)

        while remaining:
            # Find all steps with in-degree 0 (no unprocessed dependencies)
            current_level = [
                step_map[sn] for sn in remaining
                if in_degree[sn] == 0
            ]

            if not current_level:
                # No steps with in-degree 0 but still have remaining
                # This means there's a cycle we didn't catch - shouldn't happen after _detect_and_break_cycles
                # Fallback: add all remaining steps to final level
                current_level = [step_map[sn] for sn in remaining]
                levels.append(current_level)
                break

            levels.append(current_level)

            # Remove current level from remaining and update in-degrees
            for step in current_level:
                remaining.discard(step.step_num)
                # Reduce in-degree for all steps that depend on this one
                for dep_num in dependents[step.step_num]:
                    if dep_num in remaining:
                        in_degree[dep_num] -= 1

        return levels

    def _execute_step_with_retry(
        self,
        step: PlanStep,
        tools: List[Any],
        trace: ExecutionTrace,
        serialized_context: Dict[str, Any],
        plan_status: Optional[Dict[int, Dict[str, Any]]] = None,
        execution_discoveries: Optional[Dict[str, Discovery]] = None,
        max_retries: int = 2,
        backoff_base: float = 0.3
    ) -> StepResult:
        """
        Execute a step with retry logic and circuit breaker.

        Args:
            step: The step to execute
            tools: Available tools
            trace: Execution trace (for LLM/tool call counting)
            serialized_context: Context for LLM calls
            max_retries: Maximum retry attempts (default 2, so 3 total attempts)
            backoff_base: Base backoff time in seconds (exponential: base * 2^attempt)

        Returns:
            StepResult with COMPLETED, PARTIAL, FAILED, or SKIPPED status.
            Never throws an exception - always returns a result.
        """
        last_error = None
        last_result = None

        for attempt in range(max_retries + 1):
            try:
                result = self._execute_step(step, tools, trace, serialized_context, plan_status, execution_discoveries)
                last_result = result

                # Success conditions - return immediately
                if result.status in (PlanStatus.COMPLETED, PlanStatus.PARTIAL):
                    return result

                # Track error for potential retry
                last_error = result.error or "Step did not complete successfully"

            except Exception as e:
                last_error = str(e)
                last_result = None

            # Backoff before retry (skip on last attempt)
            if attempt < max_retries:
                time.sleep(backoff_base * (2 ** attempt))

        # All retries exhausted - return SKIPPED with error details
        if last_result and last_result.status == PlanStatus.FAILED:
            # Preserve the failed result but note the retries
            last_result.error = f"Failed after {max_retries + 1} attempts: {last_error}"
            return last_result

        return StepResult(
            step_num=step.step_num,
            status=PlanStatus.SKIPPED,
            error=f"Skipped after {max_retries + 1} failed attempts: {last_error}",
            duration_ms=0,
            phase=step.phase
        )

    def _execute_level_parallel(
        self,
        level_steps: List[PlanStep],
        tools: List[Any],
        trace: ExecutionTrace,
        serialized_context: Dict[str, Any],
        plan: Plan,
        plan_status: Optional[Dict[int, Dict[str, Any]]] = None,
        execution_discoveries: Optional[Dict[str, Discovery]] = None
    ) -> List[StepResult]:
        """
        Execute all steps in a level concurrently using ThreadPoolExecutor.

        Steps in the same level have no dependencies on each other,
        so they can safely run in parallel.

        Args:
            level_steps: Steps to execute (all at same dependency level)
            tools: Available tools
            trace: Execution trace
            serialized_context: Context for LLM calls
            plan: The plan being executed (for phase tracking)

        Returns:
            List of StepResults in same order as level_steps
        """
        if not level_steps:
            return []

        # Single step - no need for thread pool overhead
        if len(level_steps) == 1:
            result = self._execute_step_with_retry(
                level_steps[0], tools, trace, serialized_context, plan_status,
                execution_discoveries
            )
            return [result]

        # Multiple steps - execute in parallel
        max_workers = min(len(level_steps), 4)  # Cap at 4 concurrent steps
        results = [None] * len(level_steps)

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_idx = {
                executor.submit(
                    self._execute_step_with_retry,
                    step, tools, trace, serialized_context, plan_status,
                    execution_discoveries
                ): idx
                for idx, step in enumerate(level_steps)
            }

            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                step = level_steps[idx]
                try:
                    results[idx] = future.result()
                except Exception as e:
                    # Should not happen - _execute_step_with_retry catches all exceptions
                    # But defensive fallback just in case
                    results[idx] = StepResult(
                        step_num=step.step_num,
                        status=PlanStatus.SKIPPED,
                        error=f"Unexpected error in parallel execution: {str(e)}",
                        duration_ms=0,
                        phase=step.phase
                    )

        return results

    # =========================================================================
    # MICROLOOP EXECUTION METHODS
    # =========================================================================

    def _execute_step_with_microloop(
        self,
        step: PlanStep,
        tools: List[Any],
        trace: ExecutionTrace,
        serialized_context: Dict[str, Any],
        plan_status: Optional[Dict[int, Dict[str, Any]]] = None,
        execution_discoveries: Optional[Dict[str, Discovery]] = None
    ) -> StepResult:
        """
        Execute a step using the microloop state machine.

        This provides:
        1. Explicit state transitions (READY -> TOOL_PENDING -> REASONING -> etc)
        2. Monotonic reasoning (COMMITs cannot be undone)
        3. Adaptive recovery (retry with modifications, pivot to different tools)
        4. Detailed artifact tracking via ExecutionManifest

        Args:
            step: The step to execute
            tools: Available tools
            trace: Execution trace (for LLM/tool call counting)
            serialized_context: Context for LLM calls
            plan_status: Mutable per-step status tracker
            execution_discoveries: Discoveries from previous steps

        Returns:
            StepResult compatible with standard execution path
        """
        if not self._microloop or not self._current_manifest:
            # Fallback to standard execution if microloop not available
            return self._execute_step_with_retry(
                step, tools, trace, serialized_context, plan_status, execution_discoveries
            )

        # Execute via microloop
        result = self._microloop.execute(
            step=step,
            serialized_context=serialized_context,
            manifest=self._current_manifest,
            tools=tools,
            existing_discoveries=execution_discoveries
        )

        # Update trace counts from microloop result
        trace.tool_calls += result.manifest_entry.total_tool_calls
        trace.tool_failures += result.manifest_entry.failed_tool_calls

        # Log microloop completion
        self._log_microloop_result(step, result)

        return result.step_result

    def _log_microloop_result(self, step: PlanStep, result: "MicroloopResult") -> None:
        """Log microloop execution result for visibility."""
        if not self._llm_call_logger:
            return

        try:
            entry = result.manifest_entry

            # Build summary of what happened
            summary_parts = []
            if entry.files_created:
                summary_parts.append(f"Created: {', '.join(entry.files_created)}")
            if entry.files_modified:
                summary_parts.append(f"Modified: {', '.join(entry.files_modified)}")
            if entry.failures:
                summary_parts.append(f"Failures: {len(entry.failures)}")

            summary = "; ".join(summary_parts) if summary_parts else "No artifacts"

            self._llm_call_logger(
                step.step_num,
                step.objective,
                f"[MICROLOOP RESULT]\nState: {entry.final_state.name}\nStatus: {entry.status.value}",
                "",
                summary,
                [],
                [{
                    "tools_called": entry.tools_called,
                    "total_tool_calls": entry.total_tool_calls,
                    "successful": entry.successful_tool_calls,
                    "failed": entry.failed_tool_calls,
                    "reasoning_decisions": entry.reasoning_decisions,
                    "commitments": entry.commitments,
                }],
                entry.duration_ms,
                "microloop_result",
                None
            )
        except Exception as e:
            # ========== MAKE LOGGING ERRORS VISIBLE ==========
            import sys
            _trace(f"[EXECUTOR ERROR] _log_microloop_step_result failed: {type(e).__name__}: {str(e)[:200]}")

    def _handle_microloop_log_event(self, event: str, data: Optional[Dict[str, Any]]) -> None:
        """Relay microloop internal events through standard LLM log channel."""
        if not self._llm_call_logger:
            return

        payload = data or {}
        step_num = payload.get("step_num", 0)
        objective = payload.get("objective") or f"Step {step_num}"
        duration_ms = payload.get("duration_ms", 0.0)
        tool_name = payload.get("tool")

        # Prepare safe snapshot of payload for raw_response field
        raw_payload = dict(payload)
        raw_payload.pop("step_num", None)
        raw_response = ""
        if raw_payload:
            try:
                raw_response = json.dumps(raw_payload, default=str)[:1000]
            except Exception:
                raw_response = str(raw_payload)

        tool_calls = []
        tool_results = []

        if tool_name and event == "tool_execute_start":
            tool_calls.append({
                "name": tool_name,
                "arguments": payload.get("args", {})
            })
            tool_results.append({
                "tool": tool_name,
                "status": "started",
                "success": None
            })
        elif tool_name and event == "tool_execute_end":
            tool_results.append({
                "tool": tool_name,
                "status": "completed" if payload.get("success", True) else "failed",
                "success": payload.get("success"),
                "output": payload.get("output", "")
            })
        elif tool_name and event == "tool_failure":
            tool_results.append({
                "tool": tool_name,
                "status": "failed",
                "success": False,
                "error": payload.get("error"),
                "output": payload.get("result_preview", "")
            })

        try:
            self._llm_call_logger(
                step_num,
                objective,
                f"[MICROLOOP EVENT] {event}",
                "",
                raw_response,
                tool_calls,
                tool_results,
                duration_ms,
                f"microloop_{event}",
                None
            )
        except Exception as e:
            # ========== MAKE LOGGING ERRORS VISIBLE ==========
            import sys
            _trace(f"[EXECUTOR ERROR] _handle_microloop_log_event failed for event={event}: {type(e).__name__}: {str(e)[:200]}")

    def _execute_level_parallel_microloop(
        self,
        level_steps: List[PlanStep],
        tools: List[Any],
        trace: ExecutionTrace,
        serialized_context: Dict[str, Any],
        plan: Plan,
        plan_status: Optional[Dict[int, Dict[str, Any]]] = None,
        execution_discoveries: Optional[Dict[str, Discovery]] = None
    ) -> List[StepResult]:
        """
        Execute all steps in a level using microloop (parallel execution).

        Same interface as _execute_level_parallel but uses microloop internally.
        """
        if not level_steps:
            return []

        # Single step - execute directly
        if len(level_steps) == 1:
            result = self._execute_step_with_microloop(
                level_steps[0], tools, trace, serialized_context,
                plan_status, execution_discoveries
            )
            return [result]

        # Multiple steps - execute in parallel
        max_workers = min(len(level_steps), 4)
        results = [None] * len(level_steps)

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_idx = {
                executor.submit(
                    self._execute_step_with_microloop,
                    step, tools, trace, serialized_context,
                    plan_status, execution_discoveries
                ): idx
                for idx, step in enumerate(level_steps)
            }

            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                step = level_steps[idx]
                try:
                    results[idx] = future.result()
                except Exception as e:
                    results[idx] = StepResult(
                        step_num=step.step_num,
                        status=PlanStatus.FAILED,
                        error=f"Microloop execution error: {str(e)}",
                        duration_ms=0,
                        phase=step.phase
                    )

        return results

    def _create_manifest_for_plan(self, plan: Plan) -> "ExecutionManifest":
        """Create a new ExecutionManifest for a plan."""
        if not MICROLOOP_AVAILABLE:
            return None

        return ExecutionManifest(
            plan_goal=plan.goal,
            plan_id=str(uuid.uuid4())[:8]
        )

    def _update_uncertainty(self, plan: Plan, step: PlanStep, step_result: StepResult):
        """
        Update plan uncertainty after discovery step completes.

        Discovery steps reduce uncertainty by gathering evidence.
        Execution is only allowed once uncertainty drops below threshold.
        """
        if step.phase != PlanPhase.DISCOVERY:
            return

        # If step succeeded and targeted uncertainties
        if step_result.status == PlanStatus.COMPLETED:
            # Remove targeted uncertainties from the plan
            for uncertainty in step.uncertainties_targeted:
                if uncertainty in plan.uncertainties:
                    plan.uncertainties.remove(uncertainty)

            # Reduce current uncertainty level
            plan.current_uncertainty -= step.expected_uncertainty_reduction
            step.actual_uncertainty_reduction = step.expected_uncertainty_reduction

        # Clamp to [0, 1]
        plan.current_uncertainty = max(0.0, min(1.0, plan.current_uncertainty))

    def _verify_preconditions(self, preconditions: List[str], context: Optional[Dict[str, Any]] = None) -> tuple[bool, List[str]]:
        """
        Verify preconditions are met before execution.

        Returns:
            (all_met, list of unmet preconditions)
        """
        if not preconditions:
            return True, []

        # For now, we trust that discovery has gathered the needed information
        # In a more sophisticated implementation, we could check context/accumulated_data
        # to verify specific preconditions programmatically

        # TODO: Add programmatic precondition checking based on context
        return True, []

    def _verify_postconditions(
        self,
        postconditions: List[str],
        verification_method: Optional[str],
        step_result: StepResult
    ) -> tuple[bool, List[str]]:
        """
        Verify postconditions after step execution.

        Returns:
            (all_met, list of unmet postconditions)
        """
        if not postconditions:
            return True, []

        # Check if step completed successfully - basic verification
        if step_result.status != PlanStatus.COMPLETED:
            return False, postconditions

        # If verification method specified, could execute it here
        # For now, we trust successful completion means postconditions met
        # TODO: Add programmatic postcondition verification

        return True, []
