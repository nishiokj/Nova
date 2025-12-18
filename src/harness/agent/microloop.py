"""
Microloop - State machine execution engine for resilient step execution.

The Microloop handles the inner execution loop for a single step:
1. Decides which tool to call
2. Executes with proper timeouts
3. Reasons about outcomes
4. Adapts (retry with different args, pivot to different tool)
5. Knows when to complete or escalate

Key Design:
- State machine with explicit transitions
- Monotonic reasoning (COMMITs cannot be undone)
- Extension points for invariants and completion conditions
- Produces detailed manifest entries for audit

Usage:
    microloop = Microloop(tool_registry, llm, config)
    microloop.add_invariant_checker(my_checker)

    result = microloop.execute(step, context, manifest)
"""

import hashlib
import json
import os
import sys
import time
import time as _time  # Alias for observability logging
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

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

from util.llm_adapter import LLMAdapter, LLMResponse
from .execution_models import (
    ArtifactType,
    CompletionCondition,
    ExecutionManifest,
    InvariantChecker,
    LLMToolDecision,
    MicroloopContext,
    ReasoningDecision,
    ReasoningDecisionType,
    StepExecutionState,
    StepManifestEntry,
    TimeoutPolicy,
    ToolContextBundle,
    ToolDecision,
    ToolFailure,
    ToolInterpretation,
    WorkArtifact,
    get_timeout_policy,
    max_duration_invariant,
    max_failures_invariant,
)
from .plan_models import PlanPhase, PlanStatus, PlanStep, StepResult, ToolCallRecord, Discovery, DiscoveryType
from .tool_registry import ToolRegistry, ToolResult, ToolStatus


@dataclass
class MicroloopConfig:
    """Configuration for microloop execution."""
    max_attempts: int = 3
    max_tool_calls_per_attempt: int = 3
    max_duration_ms: float = 0  # 0 = no timeout per step
    max_failures: int = 5

    # Reasoning
    enable_llm_reasoning: bool = True  # Use LLM to reason about failures
    reasoning_budget_ms: float = 10_000  # Max time for reasoning calls

    # Recovery
    enable_auto_retry: bool = True
    enable_auto_pivot: bool = True

    # Cheap tool encouragement
    cheap_tool_bonus: float = 0.1  # Prefer cheap tools when choosing


@dataclass
class MicroloopResult:
    """Result of microloop execution for a step."""
    context: MicroloopContext
    manifest_entry: StepManifestEntry
    step_result: StepResult

    @property
    def is_complete(self) -> bool:
        return self.context.state == StepExecutionState.COMPLETE

    @property
    def is_escalated(self) -> bool:
        return self.context.state == StepExecutionState.ESCALATE


class Microloop:
    """
    State machine execution engine for step execution.

    The microloop runs until reaching a terminal state (COMPLETE or ESCALATE).

    Extension Points:
    - add_invariant_checker(): Add custom invariant checks
    - add_completion_condition(): Add custom completion conditions
    - set_pre_tool_hook(): Called before each tool execution
    - set_post_tool_hook(): Called after each tool execution

    Future Extension:
    - Graphd /impact results can feed invariant checkers or a dependency worklist
    - Invariants should encode impact hints (SignatureContract, NameContract, etc.)
    """

    def __init__(
        self,
        tool_registry: ToolRegistry,
        llm: Optional[LLMAdapter] = None,
        config: Optional[MicroloopConfig] = None,
        graphd_client: Optional[Any] = None
    ):
        self.tool_registry = tool_registry
        self.llm = llm
        self.config = config or MicroloopConfig()
        self.graphd_client = graphd_client  # Optional graphd client for smart lookups

        # Extension points
        self._invariant_checkers: List[InvariantChecker] = []
        self._completion_conditions: List[CompletionCondition] = []
        self._pre_tool_hook: Optional[Callable[[str, Dict], None]] = None
        self._post_tool_hook: Optional[Callable[[str, ToolResult], None]] = None

        # Logging callback (set by Executor)
        self._log_callback: Optional[Callable[[str, Any], None]] = None

        # Add default invariants
        self._invariant_checkers.append(max_duration_invariant(self.config.max_duration_ms))
        self._invariant_checkers.append(max_failures_invariant(self.config.max_failures))

    def add_invariant_checker(self, checker: InvariantChecker) -> None:
        """Add a custom invariant checker."""
        self._invariant_checkers.append(checker)

    def add_completion_condition(self, condition: CompletionCondition) -> None:
        """Add a custom completion condition."""
        self._completion_conditions.append(condition)

    def set_pre_tool_hook(self, hook: Callable[[str, Dict], None]) -> None:
        """Set hook called before each tool execution."""
        self._pre_tool_hook = hook

    def set_post_tool_hook(self, hook: Callable[[str, ToolResult], None]) -> None:
        """Set hook called after each tool execution."""
        self._post_tool_hook = hook

    def set_log_callback(self, callback: Callable[[str, Any], None]) -> None:
        """Set logging callback for execution events."""
        self._log_callback = callback

    def _log(self, event: str, data: Any = None) -> None:
        """Emit log event if callback is set."""
        if self._log_callback:
            try:
                self._log_callback(event, data)
            except Exception as e:
                # ========== MAKE LOGGING ERRORS VISIBLE ==========
                import sys
                _trace(f"[MICROLOOP ERROR] _log callback failed for event={event}: {type(e).__name__}: {str(e)[:200]}")

    def _truncate_text(self, text: Optional[str], max_length: int = 2000) -> Optional[str]:
        if not text:
            return None
        return text if len(text) <= max_length else text[:max_length] + "..."

    def _summarize_args(self, args: Optional[Dict[str, Any]], max_length: int = 200) -> Dict[str, str]:
        """Compact arguments for logging to avoid noisy blobs."""
        if not args:
            return {}
        summary: Dict[str, str] = {}
        for key, value in args.items():
            try:
                text = str(value)
            except Exception:
                text = "<unserializable>"
            summary[key] = text if len(text) <= max_length else text[:max_length] + "..."
        return summary

    def _extract_traceback(self, result: Optional[ToolResult]) -> Optional[str]:
        if not result or not isinstance(result.metadata, dict):
            return None
        tb = result.metadata.get("traceback")
        return self._truncate_text(str(tb)) if tb else None

    def execute(
        self,
        step: PlanStep,
        serialized_context: Dict[str, Any],
        manifest: ExecutionManifest,
        tools: List[Any],
        existing_discoveries: Optional[Dict[str, Any]] = None
    ) -> MicroloopResult:
        """
        Execute a step using the microloop state machine.

        Args:
            step: The step to execute
            serialized_context: Context for LLM calls
            manifest: Execution manifest to update
            tools: Available tool definitions
            existing_discoveries: Discoveries from previous steps

        Returns:
            MicroloopResult containing context, manifest entry, and step result
        """
        # ========== CRITICAL: IMMEDIATE LOG ON ENTRY ==========
        _trace(f"[MICROLOOP] {_time.strftime('%H:%M:%S')} | execute() ENTRY | step={step.step_num} | objective={step.objective[:60] if step.objective else 'none'}... | tool_hint={step.tool_hint}")

        # Initialize context with extension points
        context = MicroloopContext(
            step=step,
            max_attempts=self.config.max_attempts,
            _invariant_checkers=self._invariant_checkers,
            _completion_conditions=self._completion_conditions,
        )

        self._log("microloop_start", {
            "step_num": step.step_num,
            "objective": step.objective,
            "max_attempts": context.max_attempts
        })

        # Main execution loop
        while not context.is_terminal:
            self._execute_state(context, serialized_context, tools, existing_discoveries)

        # Build manifest entry from context
        manifest_entry = self._build_manifest_entry(context)
        manifest.add_step_entry(manifest_entry)

        # Build step result
        step_result = self._build_step_result(context)

        self._log("microloop_end", {
            "step_num": step.step_num,
            "final_state": context.state.name,
            "attempts": context.attempt,
            "elapsed_ms": context.elapsed_ms
        })

        return MicroloopResult(
            context=context,
            manifest_entry=manifest_entry,
            step_result=step_result
        )

    def _execute_state(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any],
        tools: List[Any],
        discoveries: Optional[Dict[str, Any]] = None
    ) -> None:
        """Execute the current state and transition to next."""
        state = context.state

        # ========== LOG STATE TRANSITIONS ==========
        _trace(f"[MICROLOOP] {_time.strftime('%H:%M:%S')} | step={context.step.step_num} | state={state.name} | attempt={context.attempt} | tool_calls={context.tool_calls_this_attempt}/{context.max_tool_calls_per_attempt}")

        if state == StepExecutionState.READY:
            self._handle_ready(context, serialized_context, tools, discoveries)

        elif state == StepExecutionState.TOOL_PENDING:
            self._handle_tool_pending(context)

        elif state == StepExecutionState.AWAITING_RESULT:
            self._handle_awaiting_result(context)

        elif state == StepExecutionState.INTERPRET_RESULT:
            self._handle_interpret_result(context, serialized_context, discoveries)

        elif state == StepExecutionState.REASONING:
            self._handle_reasoning(context, serialized_context, tools, discoveries)

        elif state == StepExecutionState.RETRY:
            self._handle_retry(context, serialized_context, tools, discoveries)

        elif state == StepExecutionState.PIVOT:
            self._handle_pivot(context, serialized_context, tools, discoveries)

    def _handle_ready(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any],
        tools: List[Any],
        discoveries: Optional[Dict[str, Any]] = None
    ) -> None:
        """Handle READY state - decide what tool to call."""
        # Check if step has explicit tool hint
        if context.step.tool_hint and context.step.tool_args_hint:
            # Direct execution path - no LLM needed
            context.current_tool_decision = ToolDecision(
                tool_name=context.step.tool_hint,
                arguments=context.step.tool_args_hint,
                rationale="Using pre-specified tool and arguments",
                is_retry=False
            )
            context.transition_to(StepExecutionState.TOOL_PENDING)
            return

        # Check if step doesn't need tools
        if not context.step.tool_hint:
            # Reasoning-only step - check completion immediately
            is_complete, reason = context.check_completion_conditions()
            if is_complete:
                context.reasoning_trace.add_decision(ReasoningDecision(
                    decision_type=ReasoningDecisionType.COMMIT,
                    reasoning=f"Step complete without tools: {reason}",
                    timestamp=time.time(),
                    action="complete_no_tools",
                    commitment="Step marked complete"
                ))
                context.transition_to(StepExecutionState.COMPLETE)
            else:
                # No tools and not complete - escalate
                context.transition_to(StepExecutionState.ESCALATE)
            return

        # Use LLM to decide tool call
        tool_decision = self._decide_tool_call(context, serialized_context, tools, discoveries)

        if tool_decision:
            context.current_tool_decision = tool_decision
            context.transition_to(StepExecutionState.TOOL_PENDING)
        else:
            # Couldn't decide on a tool - escalate
            context.reasoning_trace.add_decision(ReasoningDecision(
                decision_type=ReasoningDecisionType.ESCALATE,
                reasoning="Could not determine appropriate tool call",
                timestamp=time.time(),
                action="escalate_no_tool_decision"
            ))
            context.transition_to(StepExecutionState.ESCALATE)

    def _handle_tool_pending(self, context: MicroloopContext) -> None:
        """Handle TOOL_PENDING state - execute the decided tool."""
        decision = context.current_tool_decision
        if not decision:
            context.transition_to(StepExecutionState.ESCALATE)
            return

        # Get timeout policy
        policy = get_timeout_policy(decision.tool_name)
        timeout_ms = policy.get_timeout_for_attempt(context.tool_attempts.get(decision.tool_name, 0))

        self._log("tool_execute_start", {
            "step_num": context.step.step_num,
            "tool": decision.tool_name,
            "timeout_ms": timeout_ms,
            "attempt": context.attempt,
            "args": self._summarize_args(decision.arguments)
        })

        # Pre-tool hook
        if self._pre_tool_hook:
            try:
                self._pre_tool_hook(decision.tool_name, decision.arguments)
            except Exception:
                pass

        # Execute tool
        # ========== LOG PRE-TOOL EXECUTION ==========
        _trace(f"[MICROLOOP] {_time.strftime('%H:%M:%S')} | TOOL EXECUTION STARTING | tool={decision.tool_name} | args_keys={list(decision.arguments.keys()) if decision.arguments else []}")
        start_time = time.time()
        try:
            result = self.tool_registry.execute(
                decision.tool_name,
                timeout_override=timeout_ms / 1000,  # Convert to seconds
                **decision.arguments
            )
            _trace(f"[MICROLOOP] {_time.strftime('%H:%M:%S')} | TOOL EXECUTION COMPLETE | tool={decision.tool_name} | success={result.is_success} | duration={(time.time() - start_time) * 1000:.0f}ms")
        except Exception as e:
            _trace(f"[MICROLOOP] {_time.strftime('%H:%M:%S')} | TOOL EXECUTION FAILED | tool={decision.tool_name} | error={str(e)[:100]}")
            result = ToolResult(
                status=ToolStatus.ERROR,
                output=None,
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
                metadata={"traceback": traceback.format_exc()}
            )

        duration_ms = (time.time() - start_time) * 1000
        if result.duration_ms == 0:
            result.duration_ms = duration_ms

        # Post-tool hook
        if self._post_tool_hook:
            try:
                self._post_tool_hook(decision.tool_name, result)
            except Exception:
                pass

        # Record tool call
        record = ToolCallRecord(
            tool_name=decision.tool_name,
            arguments=decision.arguments,
            result=result,
            duration_ms=duration_ms,
            timestamp=time.time()
        )
        context.tool_history.append(record)
        context.current_tool_result = result

        # Track tool call for budget and stagnation detection
        output_str = str(result.output) if result.output else ""
        output_hash = hashlib.md5(output_str.encode()).hexdigest()[:8]
        context.record_tool_call_tracking(output_hash)
        context.tool_attempts[decision.tool_name] = context.tool_attempts.get(decision.tool_name, 0) + 1

        # Record artifact or failure
        if result.is_success:
            artifact = self._create_artifact(decision.tool_name, decision.arguments, result)
            if artifact:
                context.record_artifact(artifact)

            # Update accumulated data
            key = f"{decision.tool_name}_output"
            if key not in context.accumulated_data:
                context.accumulated_data[key] = []
            context.accumulated_data[key].append(result.output)
        else:
            failure = self._create_failure(decision.tool_name, decision.arguments, result, context.attempt)
            context.record_failure(failure)

        if not result.is_success:
            tb_text = self._extract_traceback(result)
            failure_payload = {
                "step_num": context.step.step_num,
                "tool": decision.tool_name,
                "status": result.status.value if hasattr(result, "status") else "error",
                "error": result.error,
                "duration_ms": duration_ms,
                "attempt": context.attempt,
                "args": self._summarize_args(decision.arguments),
            }
            if tb_text:
                failure_payload["traceback"] = tb_text
                try:
                    self.tool_registry.logger.error(
                        f"Microloop captured exception from tool '{decision.tool_name}'",
                        component="microloop",
                        data={
                            "tool": decision.tool_name,
                            "attempt": context.attempt,
                            "args": self._summarize_args(decision.arguments),
                            "traceback": tb_text,
                            "error": result.error
                        }
                    )
                except Exception:
                    pass
            self._log("tool_failure", failure_payload)

        self._log("tool_execute_end", {
            "step_num": context.step.step_num,
            "tool": decision.tool_name,
            "success": result.is_success,
            "duration_ms": duration_ms
        })

        # Transition to awaiting result (for async tools this would be different)
        context.transition_to(StepExecutionState.AWAITING_RESULT)

    def _handle_awaiting_result(self, context: MicroloopContext) -> None:
        """Handle AWAITING_RESULT state - result is ready, go to interpretation."""
        # Results are synchronous, transition to INTERPRET_RESULT for parsing
        context.transition_to(StepExecutionState.INTERPRET_RESULT)

    def _handle_interpret_result(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any],
        existing_discoveries: Optional[Dict[str, Any]] = None
    ) -> None:
        """
        Handle INTERPRET_RESULT state - parse tool output into structured interpretations.

        This is the KEY step that gives the system state for intelligent reasoning.
        Instead of just storing raw output, we extract structured observations.
        """
        result = context.current_tool_result
        decision = context.current_tool_decision

        if not result or not decision:
            context.transition_to(StepExecutionState.REASONING)
            return

        # Clear previous interpretations delta
        context.interpretations_delta = []

        # Parse output into structured interpretations
        interpretations = self._parse_tool_output(
            decision.tool_name,
            decision.arguments,
            result,
            context.step.objective
        )

        # Store interpretations delta (for context bundle)
        context.interpretations_delta = interpretations

        # Merge interpretations into discoveries (canonicalized form)
        for interp in interpretations:
            discovery = self._interpretation_to_discovery(
                interp,
                decision.tool_name,
                decision.arguments
            )
            if discovery:
                # Use interpretation key as discovery key
                key = f"{decision.tool_name}:{interp.key}"
                context.discoveries[key] = discovery

        _trace(f"[MICROLOOP] {_time.strftime('%H:%M:%S')} | INTERPRET_RESULT | extracted {len(interpretations)} interpretations | tool={decision.tool_name}")

        # Transition to REASONING with enriched context
        context.transition_to(StepExecutionState.REASONING)

    def _parse_tool_output(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        result: ToolResult,
        objective: str
    ) -> List[ToolInterpretation]:
        """
        Parse tool output into structured interpretations.

        This extracts semantic meaning from raw tool outputs.
        """
        interpretations = []
        output = result.output
        output_str = str(output) if output else ""
        output_hash = hashlib.md5(output_str.encode()).hexdigest()[:8]

        if not result.is_success:
            # Extract error interpretation
            interpretations.append(ToolInterpretation(
                interpretation_type="error",
                key="error",
                value={
                    "type": result.status.value if hasattr(result.status, 'value') else str(result.status),
                    "message": str(result.error)[:200] if result.error else "Unknown error",
                },
                source_tool=tool_name,
                source_output_hash=output_hash,
            ))
            return interpretations

        # Tool-specific parsing
        if tool_name == "file_read":
            path = arguments.get("path", "unknown")
            content = output_str

            # Basic file content interpretation
            interpretations.append(ToolInterpretation(
                interpretation_type="file_content",
                key=path,
                value={
                    "path": path,
                    "size": len(content),
                    "preview": content[:500],
                    "line_count": content.count('\n') + 1,
                },
                source_tool=tool_name,
                source_output_hash=output_hash,
            ))

            # Extract symbols if it looks like code
            if any(ext in path for ext in ['.py', '.js', '.ts', '.java', '.go', '.rs']):
                symbols = self._extract_code_symbols(content, path)
                if symbols:
                    interpretations.append(ToolInterpretation(
                        interpretation_type="symbols_found",
                        key=f"{path}:symbols",
                        value=symbols,
                        source_tool=tool_name,
                        source_output_hash=output_hash,
                    ))

        elif tool_name == "search_filesystem":
            pattern = arguments.get("pattern", "unknown")
            matches = output_str.strip().split('\n') if output_str.strip() else []

            interpretations.append(ToolInterpretation(
                interpretation_type="search_results",
                key=pattern,
                value={
                    "pattern": pattern,
                    "total_matches": len(matches),
                    "matches": matches[:20],  # Top 20
                },
                source_tool=tool_name,
                source_output_hash=output_hash,
            ))

        elif tool_name == "list_files":
            path = arguments.get("path", ".")
            files = output_str.strip().split('\n') if output_str.strip() else []

            interpretations.append(ToolInterpretation(
                interpretation_type="directory_listing",
                key=path,
                value={
                    "path": path,
                    "total_files": len(files),
                    "files": files[:30],  # Top 30
                },
                source_tool=tool_name,
                source_output_hash=output_hash,
            ))

        elif tool_name == "bash_execute":
            command = arguments.get("command", "")

            interpretations.append(ToolInterpretation(
                interpretation_type="command_output",
                key=command[:50],
                value={
                    "command": command,
                    "output": output_str[:1000],
                    "exit_code": result.metadata.get("exit_code", 0) if result.metadata else 0,
                },
                source_tool=tool_name,
                source_output_hash=output_hash,
            ))

        else:
            # Generic interpretation for unknown tools
            interpretations.append(ToolInterpretation(
                interpretation_type="generic_output",
                key=tool_name,
                value={
                    "output": output_str[:1000],
                },
                source_tool=tool_name,
                source_output_hash=output_hash,
            ))

        return interpretations

    def _extract_code_symbols(self, content: str, path: str) -> Dict[str, List[str]]:
        """Extract function/class/method names from code content."""
        import re
        symbols: Dict[str, List[str]] = {"classes": [], "functions": [], "methods": []}

        # Python patterns
        if path.endswith('.py'):
            symbols["classes"] = re.findall(r'^class\s+(\w+)', content, re.MULTILINE)
            symbols["functions"] = re.findall(r'^def\s+(\w+)', content, re.MULTILINE)
            symbols["methods"] = re.findall(r'^\s+def\s+(\w+)', content, re.MULTILINE)

        # JavaScript/TypeScript patterns
        elif path.endswith(('.js', '.ts', '.tsx', '.jsx')):
            symbols["classes"] = re.findall(r'class\s+(\w+)', content)
            symbols["functions"] = re.findall(r'function\s+(\w+)', content)
            symbols["functions"] += re.findall(r'const\s+(\w+)\s*=\s*(?:async\s*)?\(', content)

        # Filter empty lists
        return {k: v for k, v in symbols.items() if v}

    def _interpretation_to_discovery(
        self,
        interp: ToolInterpretation,
        tool_name: str,
        arguments: Dict[str, Any]
    ) -> Optional[Discovery]:
        """Convert a ToolInterpretation to a Discovery for cross-step sharing."""
        timestamp = time.time()

        if interp.interpretation_type == "file_content":
            return Discovery(
                type=DiscoveryType.FILE_CONTENT,
                timestamp=timestamp,
                path=interp.value.get("path"),
                size=interp.value.get("size"),
                preview=interp.value.get("preview", "")[:500],
            )

        elif interp.interpretation_type == "search_results":
            return Discovery(
                type=DiscoveryType.SEARCH_RESULT,
                timestamp=timestamp,
                query=interp.value.get("pattern"),
                matches=interp.value.get("matches", [])[:10],
                total=interp.value.get("total_matches"),
            )

        elif interp.interpretation_type == "directory_listing":
            return Discovery(
                type=DiscoveryType.DIRECTORY_LISTING,
                timestamp=timestamp,
                path=interp.value.get("path"),
                files=interp.value.get("files", [])[:20],
                total=interp.value.get("total_files"),
            )

        elif interp.interpretation_type == "command_output":
            return Discovery(
                type=DiscoveryType.COMMAND_OUTPUT,
                timestamp=timestamp,
                command=interp.value.get("command"),
                output=interp.value.get("output", "")[:500],
            )

        elif interp.interpretation_type == "error":
            return Discovery(
                type=DiscoveryType.ERROR,
                timestamp=timestamp,
                tool=tool_name,
                message=interp.value.get("message"),
            )

        return None

    def _handle_reasoning(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any],
        tools: List[Any] = None,
        discoveries: Optional[Dict[str, Any]] = None
    ) -> None:
        """
        Handle REASONING state - evaluate outcome and decide next action.

        This is the key adaptive decision point:
        1. Check budget/stagnation limits -> force decision
        2. Check if success criteria met (evidence-based) -> COMPLETE
        3. Check if should continue with output-based args -> READY
        4. Check if should retry (same tool, different args) -> RETRY
        5. Check if should pivot (different tool) -> PIVOT
        6. Check if should give up -> ESCALATE
        """
        result = context.current_tool_result
        decision = context.current_tool_decision

        # ===== BUDGET ENFORCEMENT =====
        # If budget exhausted, must decide now (no more READY transitions)
        if context.budget_exhausted:
            _trace(f"[MICROLOOP] {_time.strftime('%H:%M:%S')} | BUDGET EXHAUSTED | tool_calls={context.tool_calls_this_attempt}")

            # Check if we have enough evidence to complete
            is_complete, reason = self._check_evidence_based_completion(context, discoveries)
            if is_complete:
                context.reasoning_trace.add_decision(ReasoningDecision(
                    decision_type=ReasoningDecisionType.COMMIT,
                    reasoning=f"Budget exhausted but completion evidence found: {reason}",
                    timestamp=time.time(),
                    action="complete_on_budget",
                    commitment="Step marked complete (budget limit)"
                ))
                context.transition_to(StepExecutionState.COMPLETE)
                return

            # Budget exhausted, no completion evidence - escalate or complete partial
            if context.artifacts or context.discoveries:
                # We have some work done - mark as partial completion
                context.reasoning_trace.add_decision(ReasoningDecision(
                    decision_type=ReasoningDecisionType.COMMIT,
                    reasoning="Budget exhausted with partial progress",
                    timestamp=time.time(),
                    action="complete_partial_budget",
                    commitment="Step marked as partial (budget limit)"
                ))
                context.transition_to(StepExecutionState.COMPLETE)
            else:
                # No progress at all - escalate
                context.reasoning_trace.add_decision(ReasoningDecision(
                    decision_type=ReasoningDecisionType.ESCALATE,
                    reasoning="Budget exhausted with no progress",
                    timestamp=time.time(),
                    action="escalate_budget_no_progress"
                ))
                context.transition_to(StepExecutionState.ESCALATE)
            return

        # ===== STAGNATION DETECTION =====
        if context.is_stagnating:
            _trace(f"[MICROLOOP] {_time.strftime('%H:%M:%S')} | STAGNATION DETECTED | hashes={context.recent_output_hashes[-3:]}")

            # Stagnation means we're spinning - must pivot or escalate
            context.reasoning_trace.add_decision(ReasoningDecision(
                decision_type=ReasoningDecisionType.REFINE,
                reasoning="Stagnation detected - outputs not changing, pivoting",
                timestamp=time.time(),
                action="pivot_stagnation"
            ))
            context.transition_to(StepExecutionState.PIVOT)
            context.attempt += 1
            context.reset_attempt_budget()
            return

        # ===== EVIDENCE-BASED COMPLETION CHECK =====
        is_complete, reason = self._check_evidence_based_completion(context, discoveries)
        if is_complete:
            context.reasoning_trace.add_decision(ReasoningDecision(
                decision_type=ReasoningDecisionType.COMMIT,
                reasoning=f"Evidence-based completion: {reason}",
                timestamp=time.time(),
                action="complete",
                commitment="Step marked complete",
                tool_result_summary=str(result.output)[:100] if result and result.output else None
            ))
            context.transition_to(StepExecutionState.COMPLETE)
            return

        # ===== TOOL SUCCESS PATH =====
        if result and result.is_success:
            # Check if tool decision says to stop after this
            if decision and decision.stop_after:
                context.reasoning_trace.add_decision(ReasoningDecision(
                    decision_type=ReasoningDecisionType.COMMIT,
                    reasoning="Tool decision indicated stop after this call",
                    timestamp=time.time(),
                    action="complete_stop_after",
                    commitment="Step marked complete (stop_after flag)"
                ))
                context.transition_to(StepExecutionState.COMPLETE)
                return

            # Tool worked - check if we should continue, pivot, or complete
            if context.attempt < context.max_attempts:
                # Evidence-based pivot check (replaces simple _should_pivot)
                should_pivot, pivot_reason = self._should_pivot_evidence_based(context, discoveries)
                if should_pivot:
                    context.reasoning_trace.add_decision(ReasoningDecision(
                        decision_type=ReasoningDecisionType.REFINE,
                        reasoning=f"Pivot after success: {pivot_reason}",
                        timestamp=time.time(),
                        action="pivot_after_success"
                    ))
                    context.transition_to(StepExecutionState.PIVOT)
                    context.attempt += 1
                    context.reset_attempt_budget()
                else:
                    # Continue with next tool call - LLM will decide args based on output
                    context.reasoning_trace.add_decision(ReasoningDecision(
                        decision_type=ReasoningDecisionType.REFINE,
                        reasoning="Tool succeeded, continuing based on output",
                        timestamp=time.time(),
                        action="continue"
                    ))
                    context.transition_to(StepExecutionState.READY)
            else:
                # Out of attempts but tool succeeded - mark as partial success
                context.reasoning_trace.add_decision(ReasoningDecision(
                    decision_type=ReasoningDecisionType.COMMIT,
                    reasoning="Max attempts reached with partial success",
                    timestamp=time.time(),
                    action="complete_partial",
                    commitment="Step marked as partial completion"
                ))
                context.transition_to(StepExecutionState.COMPLETE)
            return

        # ===== TOOL FAILURE PATH =====
        if context.should_give_up:
            context.reasoning_trace.add_decision(ReasoningDecision(
                decision_type=ReasoningDecisionType.ESCALATE,
                reasoning=f"Max attempts ({context.max_attempts}) exhausted",
                timestamp=time.time(),
                action="escalate_exhausted"
            ))
            context.transition_to(StepExecutionState.ESCALATE)
            return

        # Analyze failure and decide: retry or pivot?
        recovery = self._analyze_failure_and_recover(context, serialized_context)

        if recovery == "retry":
            context.reasoning_trace.add_decision(ReasoningDecision(
                decision_type=ReasoningDecisionType.REFINE,
                reasoning=f"Retrying with modified approach: {result.error if result else 'unknown'}",
                timestamp=time.time(),
                action="retry"
            ))
            context.transition_to(StepExecutionState.RETRY)
            context.attempt += 1
            context.reset_attempt_budget()

        elif recovery == "pivot":
            context.reasoning_trace.add_decision(ReasoningDecision(
                decision_type=ReasoningDecisionType.REFINE,
                reasoning=f"Pivoting after failure: {result.error if result else 'unknown'}",
                timestamp=time.time(),
                action="pivot"
            ))
            context.transition_to(StepExecutionState.PIVOT)
            context.attempt += 1
            context.reset_attempt_budget()

        else:  # escalate
            context.reasoning_trace.add_decision(ReasoningDecision(
                decision_type=ReasoningDecisionType.ESCALATE,
                reasoning=f"Cannot recover from failure: {result.error if result else 'unknown'}",
                timestamp=time.time(),
                action="escalate_unrecoverable"
            ))
            context.transition_to(StepExecutionState.ESCALATE)

    def _handle_retry(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any],
        tools: List[Any],
        discoveries: Optional[Dict[str, Any]] = None
    ) -> None:
        """Handle RETRY state - same tool, modified arguments."""
        last_decision = context.current_tool_decision
        if not last_decision:
            context.transition_to(StepExecutionState.ESCALATE)
            return

        # Modify arguments based on failure
        modified_args = self._modify_tool_arguments(
            context,
            last_decision.tool_name,
            last_decision.arguments,
            serialized_context
        )

        if modified_args:
            context.current_tool_decision = ToolDecision(
                tool_name=last_decision.tool_name,
                arguments=modified_args,
                rationale="Retry with modified arguments",
                is_retry=True,
                retry_modifications=self._describe_modifications(last_decision.arguments, modified_args)
            )
            context.transition_to(StepExecutionState.TOOL_PENDING)
        else:
            # Couldn't modify - try pivot instead
            context.transition_to(StepExecutionState.PIVOT)

    def _handle_pivot(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any],
        tools: List[Any],
        discoveries: Optional[Dict[str, Any]] = None
    ) -> None:
        """Handle PIVOT state - different tool."""
        # Determine alternative tool
        alternative = self._select_alternative_tool(context, serialized_context, tools, discoveries)

        if alternative:
            context.current_tool_decision = alternative
            context.transition_to(StepExecutionState.TOOL_PENDING)
        else:
            # No alternative - escalate
            context.reasoning_trace.add_decision(ReasoningDecision(
                decision_type=ReasoningDecisionType.ESCALATE,
                reasoning="No alternative tool available",
                timestamp=time.time(),
                action="escalate_no_alternative"
            ))
            context.transition_to(StepExecutionState.ESCALATE)

    # =========================================================================
    # EVIDENCE-BASED DECISION METHODS
    # =========================================================================

    def _check_evidence_based_completion(
        self,
        context: MicroloopContext,
        discoveries: Optional[Dict[str, Any]] = None
    ) -> Tuple[bool, str]:
        """
        Check completion based on verifiable evidence, not just "we called the tool."

        A step is complete when:
        1. Required artifacts exist (files created/modified)
        2. Expected content/symbols found
        3. Tests passed (if relevant)
        4. Tool outputs contain required fields
        """
        step = context.step

        # Check 1: Success criteria from step definition
        if step.success_criteria:
            # Check required outputs
            if step.success_criteria.required_outputs:
                required = set(step.success_criteria.required_outputs)
                found = set(context.accumulated_data.keys())
                if required.issubset(found):
                    return True, f"Required outputs found: {required}"

            # Check validation hints against discoveries
            if step.success_criteria.validation_hints:
                for hint in step.success_criteria.validation_hints:
                    hint_lower = hint.lower()
                    # Check if hint is satisfied by discoveries
                    for key, disc in context.discoveries.items():
                        if hasattr(disc, 'preview') and disc.preview:
                            if hint_lower in disc.preview.lower():
                                return True, f"Validation hint '{hint}' found in output"

        # Check 2: Required artifacts based on objective
        objective_lower = step.objective.lower()

        # If objective mentions "read" and we have file content, complete
        if "read" in objective_lower and any(
            k.startswith("file_read:") for k in context.discoveries
        ):
            return True, "File read completed"

        # If objective mentions "search" or "find" and we have search results
        if ("search" in objective_lower or "find" in objective_lower) and any(
            k.startswith("search_filesystem:") for k in context.discoveries
        ):
            search_keys = [k for k in context.discoveries if k.startswith("search_filesystem:")]
            if search_keys:
                disc = context.discoveries[search_keys[0]]
                if hasattr(disc, 'total') and disc.total and disc.total > 0:
                    return True, f"Search completed with {disc.total} results"

        # If objective mentions "list" and we have directory listing
        if "list" in objective_lower and any(
            k.startswith("list_files:") for k in context.discoveries
        ):
            return True, "Directory listing completed"

        # Check 3: Files created/modified match objective
        if context.files_created:
            # Check if any created file matches objective
            for path in context.files_created:
                if any(word in path.lower() for word in objective_lower.split()):
                    return True, f"Created file matching objective: {path}"

        # Check 4: Custom completion conditions
        is_complete, reason = context.check_completion_conditions()
        if is_complete:
            return True, reason

        return False, ""

    def _should_pivot_evidence_based(
        self,
        context: MicroloopContext,
        discoveries: Optional[Dict[str, Any]] = None
    ) -> Tuple[bool, str]:
        """
        Evidence-based pivot decision (replaces simple call-count heuristic).

        Pivot when:
        1. Success but no progress: output identical / no new artifacts
        2. Success but insufficient: tool cannot produce missing evidence
        3. Tool type mismatch: tool doesn't fit objective
        """
        if not context.tool_history:
            return False, ""

        last_tool = context.tool_history[-1].tool_name
        same_tool_calls = sum(1 for t in context.tool_history if t.tool_name == last_tool)
        step = context.step
        objective_lower = step.objective.lower()

        # Check 1: No new artifacts in last N calls with same tool
        if same_tool_calls >= 2:
            # Check if last two calls produced different outputs
            recent_same_tool = [t for t in context.tool_history[-3:] if t.tool_name == last_tool]
            if len(recent_same_tool) >= 2:
                # Compare output hashes
                hashes = []
                for record in recent_same_tool:
                    if record.result and record.result.output:
                        h = hashlib.md5(str(record.result.output).encode()).hexdigest()[:8]
                        hashes.append(h)
                if len(set(hashes)) == 1 and len(hashes) >= 2:
                    return True, "Same output repeated - need different tool"

        # Check 2: Tool type doesn't match objective
        tool_objective_mismatch = {
            "file_read": ["search", "find", "list", "create", "write"],
            "search_filesystem": ["read content", "modify", "write", "create"],
            "list_files": ["search pattern", "read content", "write"],
            "bash_execute": [],  # bash is flexible
        }

        if last_tool in tool_objective_mismatch:
            mismatches = tool_objective_mismatch[last_tool]
            if any(m in objective_lower for m in mismatches):
                return True, f"Tool '{last_tool}' doesn't match objective requiring {mismatches}"

        # Check 3: Discovery gaps - have some info but need different type
        if context.discoveries:
            has_file_content = any(k.startswith("file_read:") for k in context.discoveries)
            has_search = any(k.startswith("search_filesystem:") for k in context.discoveries)
            has_listing = any(k.startswith("list_files:") for k in context.discoveries)

            # If we have file content but objective asks for search, pivot
            if has_file_content and "search" in objective_lower and not has_search:
                return True, "Have file content but need search results"

            # If we have search but objective asks for content, pivot
            if has_search and ("content" in objective_lower or "read" in objective_lower) and not has_file_content:
                return True, "Have search results but need file content"

        return False, ""

    # =========================================================================
    # DECISION HELPERS
    # =========================================================================

    def _decide_tool_call(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any],
        tools: List[Any],
        discoveries: Optional[Dict[str, Any]] = None
    ) -> Optional[ToolDecision]:
        """
        Decide which tool to call based on step objective and context.

        Uses ToolContextBundle to inject full history/discoveries into decision.
        Falls back to heuristics when LLM not available.
        """
        step = context.step

        # Get available tool names
        tool_names = [t.name if hasattr(t, 'name') else str(t) for t in tools] if tools else []
        if not tool_names:
            tool_names = ["file_read", "file_write", "search_filesystem", "list_files", "bash_execute"]

        # Build context bundle for intelligent decision making
        context_bundle = context.build_context_bundle(tool_names, discoveries)

        # If this is a continuation (tool history exists), use LLM to decide next action
        if context.tool_history and self.llm and self.config.enable_llm_reasoning:
            llm_decision = self._llm_decide_next_tool(context_bundle, serialized_context)
            if llm_decision:
                if llm_decision.action == "COMPLETE":
                    # LLM says we're done - return a decision with stop_after flag
                    # We'll create a no-op completion
                    return None  # Let reasoning handle completion
                elif llm_decision.action == "ESCALATE":
                    return None  # Let reasoning handle escalation
                elif llm_decision.action == "CALL_TOOL":
                    return llm_decision.to_tool_decision()

        # First call or no LLM - use heuristics
        if step.tool_hint:
            # Generate args based on last output if available (arg modification on success)
            if context.tool_history and context.current_tool_result and context.current_tool_result.is_success:
                # Success-based arg generation - learn from output
                args = self._generate_next_args_from_output(
                    step.tool_hint,
                    step.objective,
                    context.current_tool_result,
                    context.interpretations_delta,
                    discoveries
                )
            else:
                # First call - infer from objective
                args = self._infer_tool_arguments(step.tool_hint, step.objective, discoveries)

            return ToolDecision(
                tool_name=step.tool_hint,
                arguments=args,
                rationale=f"Using suggested tool: {step.tool_hint}"
            )

        # No tool hint and no LLM - try heuristic tool selection
        return self._heuristic_select_tool(context, step.objective, tool_names, discoveries)

    def _llm_decide_next_tool(
        self,
        context_bundle: ToolContextBundle,
        serialized_context: Dict[str, Any]
    ) -> Optional[LLMToolDecision]:
        """
        Use LLM to decide the next tool call based on full context.

        Returns structured decision: CALL_TOOL, COMPLETE, or ESCALATE.
        """
        if not self.llm:
            return None

        try:
            # Build decision prompt from context bundle
            decision_context = context_bundle.to_decision_prompt()

            prompt = f"""You are deciding the next action for a step execution.

{decision_context}

Based on the context above, decide the next action. You MUST respond with valid JSON:

{{
    "action": "CALL_TOOL" | "COMPLETE" | "ESCALATE",
    "tool_name": "<tool name if CALL_TOOL>",
    "arguments": {{"<arg_name>": "<value>"}},
    "rationale": "<brief explanation>",
    "confidence": 0.0-1.0,
    "stop_after_this": true | false  // Set true if this should be the final tool call
}}

RULES:
1. If budget is exhausted, you MUST return COMPLETE or ESCALATE
2. If stagnation is detected, PIVOT to a different tool or ESCALATE
3. If you have the information needed, return COMPLETE
4. Base your tool arguments on the LAST TOOL OUTPUT - use discovered paths, patterns, etc.
5. DO NOT repeat the same tool call with identical arguments
6. Respect PREVIOUS COMMITMENTS

Respond with ONLY the JSON object, no other text."""

            start_time = time.time()
            response = self.llm.respond(
                input=prompt,
                instructions="You are a tool execution planner. Respond with only valid JSON."
            )
            duration_ms = (time.time() - start_time) * 1000

            if duration_ms > self.config.reasoning_budget_ms:
                _trace(f"[MICROLOOP] LLM decision over budget: {duration_ms:.0f}ms")

            if response and response.content:
                # Parse JSON response
                content = response.content.strip()
                # Handle markdown code blocks
                if content.startswith("```"):
                    content = content.split("```")[1]
                    if content.startswith("json"):
                        content = content[4:]
                    content = content.strip()

                data = json.loads(content)
                return LLMToolDecision.from_json(data)

        except json.JSONDecodeError as e:
            _trace(f"[MICROLOOP] LLM decision JSON parse error: {e}")
        except Exception as e:
            _trace(f"[MICROLOOP] LLM decision error: {e}")

        return None

    def _generate_next_args_from_output(
        self,
        tool_name: str,
        objective: str,
        last_result: ToolResult,
        interpretations: List[ToolInterpretation],
        discoveries: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Generate next tool arguments based on last output (arg modification on success).

        This is KEY for adaptive behavior - using output to inform next call.
        """
        args = {}
        output_str = str(last_result.output) if last_result.output else ""

        # Extract useful info from interpretations
        file_paths = []
        search_patterns = []

        for interp in interpretations:
            if interp.interpretation_type == "search_results":
                # Use search results to get file paths
                matches = interp.value.get("matches", [])
                file_paths.extend(matches[:5])
            elif interp.interpretation_type == "directory_listing":
                # Use directory listing to get files
                files = interp.value.get("files", [])
                file_paths.extend(files[:5])
            elif interp.interpretation_type == "file_content":
                # Already have content - might need different file
                pass

        # Tool-specific arg generation based on output
        if tool_name == "file_read":
            # If we have discovered paths, use the first unread one
            if file_paths:
                # Filter out already-read files
                read_files = set()
                if discoveries:
                    read_files = {k.split(":", 1)[1] for k in discoveries if k.startswith("file_read:")}
                for path in file_paths:
                    if path not in read_files:
                        args["path"] = path
                        break
            if "path" not in args:
                # Fall back to inference
                args = self._infer_tool_arguments(tool_name, objective, discoveries)

        elif tool_name == "search_filesystem":
            # Refine search based on previous results
            # Try to extract a more specific pattern
            args = self._infer_tool_arguments(tool_name, objective, discoveries)
            # If we got too many results, narrow down
            for interp in interpretations:
                if interp.interpretation_type == "search_results":
                    total = interp.value.get("total_matches", 0)
                    if total > 50:
                        # Too broad - try to narrow
                        current_pattern = args.get("pattern", "")
                        if "*" in current_pattern:
                            # Make more specific
                            args["pattern"] = current_pattern.replace("*", "")

        elif tool_name == "list_files":
            # If we have paths from search, list a specific directory
            if file_paths:
                import os
                for path in file_paths:
                    dir_path = os.path.dirname(path) if "/" in path else "."
                    if dir_path:
                        args["path"] = dir_path
                        break
            if "path" not in args:
                args = self._infer_tool_arguments(tool_name, objective, discoveries)

        else:
            args = self._infer_tool_arguments(tool_name, objective, discoveries)

        return args

    def _heuristic_select_tool(
        self,
        context: MicroloopContext,
        objective: str,
        available_tools: List[str],
        discoveries: Optional[Dict[str, Any]] = None
    ) -> Optional[ToolDecision]:
        """
        Heuristically select a tool based on objective keywords.
        """
        objective_lower = objective.lower()

        # Keyword-based tool selection
        if any(kw in objective_lower for kw in ["read", "content", "view", "show"]):
            if "file_read" in available_tools:
                args = self._infer_tool_arguments("file_read", objective, discoveries)
                return ToolDecision(
                    tool_name="file_read",
                    arguments=args,
                    rationale="Objective suggests file reading"
                )

        if any(kw in objective_lower for kw in ["search", "find", "grep", "locate"]):
            if "search_filesystem" in available_tools:
                args = self._infer_tool_arguments("search_filesystem", objective, discoveries)
                return ToolDecision(
                    tool_name="search_filesystem",
                    arguments=args,
                    rationale="Objective suggests searching"
                )

        if any(kw in objective_lower for kw in ["list", "directory", "ls", "files in"]):
            if "list_files" in available_tools:
                args = self._infer_tool_arguments("list_files", objective, discoveries)
                return ToolDecision(
                    tool_name="list_files",
                    arguments=args,
                    rationale="Objective suggests listing"
                )

        if any(kw in objective_lower for kw in ["run", "execute", "command", "bash"]):
            if "bash_execute" in available_tools:
                args = self._infer_tool_arguments("bash_execute", objective, discoveries)
                return ToolDecision(
                    tool_name="bash_execute",
                    arguments=args,
                    rationale="Objective suggests command execution"
                )

        return None

    def _should_pivot(self, context: MicroloopContext) -> bool:
        """Determine if we should pivot to a different tool."""
        # Heuristic: If we've called the same tool multiple times, consider pivoting
        if not context.tool_history:
            return False

        last_tool = context.tool_history[-1].tool_name
        same_tool_calls = sum(1 for t in context.tool_history if t.tool_name == last_tool)

        return same_tool_calls >= 2

    def _analyze_failure_and_recover(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any]
    ) -> str:
        """
        Analyze failure and decide recovery strategy.

        Returns: "retry", "pivot", or "escalate"

        Uses LLM-based reasoning if enabled and available, otherwise falls back to heuristics.
        """
        if not context.failures:
            return "escalate"

        # Try LLM-based reasoning first if enabled
        if self.config.enable_llm_reasoning and self.llm:
            llm_decision = self._llm_analyze_failure(context, serialized_context)
            if llm_decision:
                return llm_decision

        # Fall back to rule-based heuristics
        return self._heuristic_analyze_failure(context, serialized_context)

    def _llm_analyze_failure(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any]
    ) -> Optional[str]:
        """
        Use LLM to analyze failure and decide recovery strategy.

        Injects full context including ReasoningTrace, WorkArtifacts, and ToolFailures.

        Returns: "retry", "pivot", "escalate", or None if LLM call fails
        """
        try:
            # Build comprehensive context for LLM
            reasoning_context = context.to_llm_reasoning_context()

            prompt = f"""You are analyzing a tool execution failure to decide the best recovery strategy.

{reasoning_context}

Based on the above context, decide the next action:

1. RETRY - Same tool with modified arguments (use when: timeout, temporary error, can fix args)
2. PIVOT - Try a different tool (use when: tool is wrong for task, permission issue, not found)
3. ESCALATE - Give up on this step (use when: unrecoverable error, max attempts reached, no alternatives)

CRITICAL RULES:
- If there are PREVIOUS COMMITMENTS listed, you MUST NOT contradict them
- Consider the failure's error_type and suggested_remedy
- Check if the tool is marked as retryable
- Consider how many attempts have been made

Respond with ONLY one word: RETRY, PIVOT, or ESCALATE"""

            # Make LLM call with budget limit
            start_time = time.time()
            response = self.llm.respond(
                input=prompt,
                instructions="You are a tool execution recovery analyzer. Respond with exactly one word: RETRY, PIVOT, or ESCALATE."
            )
            duration_ms = (time.time() - start_time) * 1000

            # Check budget
            if duration_ms > self.config.reasoning_budget_ms:
                self._log("llm_reasoning_over_budget", {"duration_ms": duration_ms})

            # Parse response
            if response and response.content:
                content = response.content.strip().upper()
                if "RETRY" in content:
                    return "retry"
                elif "PIVOT" in content:
                    return "pivot"
                elif "ESCALATE" in content:
                    return "escalate"

            return None  # Fall back to heuristics

        except Exception as e:
            self._log("llm_reasoning_error", {"error": str(e)})
            return None  # Fall back to heuristics

    def _heuristic_analyze_failure(
        self,
        context: MicroloopContext,
        serialized_context: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Rule-based heuristic for failure recovery (fallback when LLM not available).

        IMPORTANT: "not found" errors for file_read should trigger RETRY if we have
        alternative paths to try, not immediate pivot.
        """
        last_failure = context.failures[-1]
        error = last_failure.error_message.lower()

        # CRITICAL: Check file_read "not found" FIRST, BEFORE is_retryable check!
        # The is_retryable flag marks "not_found" as non-retryable by default,
        # but for file_read we CAN retry if we have alternative paths.
        if last_failure.tool_name == "file_read" and "not found" in error:
            # Check if we have alternative paths to try
            failed_path = last_failure.arguments.get("path", "")
            alternative_paths = self._find_alternative_paths(context, failed_path, serialized_context)

            # Filter out already-tried paths
            tried_paths = {r.arguments.get("path", "") for r in context.tool_history
                         if r.tool_name == "file_read" and r.arguments}
            untried = [p for p in alternative_paths if p not in tried_paths]

            if untried:
                _trace(f"[MICROLOOP] not_found -> RETRY with alternatives: {untried[:3]}")
                return "retry"
            # No alternatives - then pivot
            _trace(f"[MICROLOOP] not_found -> PIVOT (no untried path alternatives)")
            return "pivot"

        # Check if retryable (for other error types)
        if not last_failure.is_retryable:
            return "pivot"

        # Check tool-specific retry limits
        tool_attempts = context.tool_attempts.get(last_failure.tool_name, 0)
        policy = get_timeout_policy(last_failure.tool_name)

        if tool_attempts >= policy.max_retries:
            return "pivot"

        # Errors that suggest retry with modification
        retry_indicators = ["timeout", "busy", "rate limit", "temporary", "retry"]
        if any(ind in error for ind in retry_indicators):
            return "retry"

        # Other errors that suggest pivot
        pivot_indicators = ["permission", "invalid", "unsupported"]
        if any(ind in error for ind in pivot_indicators):
            return "pivot"

        # Default: try retry once, then pivot
        if tool_attempts < 1:
            return "retry"
        return "pivot"

    def _find_alternative_paths(
        self,
        context: MicroloopContext,
        failed_path: str,
        serialized_context: Optional[Dict[str, Any]] = None
    ) -> List[str]:
        """
        Find alternative paths to try when a file_read fails.

        Sources:
        1. User input @mentions (from original user input if available)
        2. Step objective (quoted/backticked paths)
        3. Discoveries (search results, directory listings)
        4. Path variations (with/without ./, different directories)
        """
        import re
        alternatives = []

        # Extract the filename from the failed path
        failed_filename = failed_path.split("/")[-1] if "/" in failed_path else failed_path

        # Source 0: Extract from ORIGINAL USER INPUT if available in serialized_context
        if serialized_context:
            user_input = serialized_context.get("user_input", "") or serialized_context.get("prompt", "") or ""
            if user_input:
                # @mentions from user input
                user_at_mentions = re.findall(r'@([\w/\-\.]+\.[\w]+)', user_input)
                alternatives.extend(user_at_mentions)
                # Quoted paths from user input
                user_quoted = re.findall(r'["\']([^"\']+\.[a-zA-Z]{1,4})["\']', user_input)
                alternatives.extend(user_quoted)
                user_backtick = re.findall(r'`([^`]+\.[a-zA-Z]{1,4})`', user_input)
                alternatives.extend(user_backtick)

        # Source 1: Extract @mentions from objective
        objective = context.step.objective or ""
        at_mentions = re.findall(r'@([\w/\-\.]+\.[\w]+)', objective)
        alternatives.extend(at_mentions)

        # Source 2: Extract quoted/backticked paths from objective
        quoted_paths = re.findall(r'["\']([^"\']+\.[a-zA-Z]{1,4})["\']', objective)
        alternatives.extend(quoted_paths)
        backtick_paths = re.findall(r'`([^`]+\.[a-zA-Z]{1,4})`', objective)
        alternatives.extend(backtick_paths)

        # Source 3: Check discoveries for files matching the filename
        for key, disc in context.discoveries.items():
            if hasattr(disc, 'files') and disc.files:
                # From directory listings
                for f in disc.files:
                    if failed_filename in f:
                        alternatives.append(f)
            if hasattr(disc, 'matches') and disc.matches:
                # From search results
                for m in disc.matches:
                    if failed_filename in m:
                        alternatives.append(m)

        # Source 4: Generate path variations
        # If failed_path was just "/filename.py", try common locations
        if failed_path.startswith("/") and "/" not in failed_path[1:]:
            # Absolute path with no directory - try relative variants
            variations = [
                failed_filename,
                f"./{failed_filename}",
                f"src/{failed_filename}",
                f"tui/{failed_filename}",  # Common in this codebase
            ]
            alternatives.extend(variations)
        elif not failed_path.startswith("/") and not failed_path.startswith("./"):
            # Relative path without ./ - try with ./
            alternatives.append(f"./{failed_path}")

        # Deduplicate and remove the failed path
        seen = set()
        unique = []
        for p in alternatives:
            if p and p != failed_path and p not in seen:
                seen.add(p)
                unique.append(p)

        return unique

    def _modify_tool_arguments(
        self,
        context: MicroloopContext,
        tool_name: str,
        original_args: Dict[str, Any],
        serialized_context: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Modify tool arguments for retry.

        Returns modified args or None if modification not possible.

        CRITICAL: For file_read "not found" errors, we MUST try alternative paths
        extracted from user input, discoveries, and path variations.
        """
        if not context.failures:
            return None

        last_failure = context.failures[-1]
        error = last_failure.error_message.lower()

        # Clone original args
        modified = dict(original_args)

        # Tool-specific modifications
        if tool_name == "file_read":
            if "path" in modified and "not found" in error:
                failed_path = modified["path"]

                # Get alternative paths (pass serialized_context for user input access)
                alternatives = self._find_alternative_paths(context, failed_path, serialized_context)

                # Filter out paths we've already tried
                tried_paths = set()
                for record in context.tool_history:
                    if record.tool_name == "file_read" and record.arguments:
                        tried_paths.add(record.arguments.get("path", ""))

                untried = [p for p in alternatives if p not in tried_paths]

                if untried:
                    next_path = untried[0]
                    _trace(f"[MICROLOOP] Retrying file_read with alternative path: {failed_path} -> {next_path}")
                    modified["path"] = next_path
                    return modified
                else:
                    _trace(f"[MICROLOOP] No untried alternative paths for {failed_path}")
                    return None

            # Non-not-found errors - try basic path fixes
            if "path" in modified:
                path = modified["path"]
                if not path.startswith("/") and not path.startswith("./"):
                    modified["path"] = f"./{path}"

        elif tool_name == "bash_execute":
            # Add timeout or modify command
            if "timeout" in error:
                # Can't easily fix timeout
                return None

        elif tool_name == "search_filesystem":
            # Broaden search pattern
            if "pattern" in modified:
                pattern = modified["pattern"]
                if "*" not in pattern:
                    modified["pattern"] = f"*{pattern}*"

        # If no meaningful modification made, return None
        if modified == original_args:
            return None

        return modified

    def _select_alternative_tool(
        self,
        context: MicroloopContext,
        serialized_context: Dict[str, Any],
        tools: List[Any],
        discoveries: Optional[Dict[str, Any]] = None
    ) -> Optional[ToolDecision]:
        """
        Select an alternative tool after pivot.

        Uses heuristics based on step objective and failed tools.
        """
        step = context.step
        failed_tools = {f.tool_name for f in context.failures}

        # Map objectives to alternative tools
        objective_lower = step.objective.lower()

        alternatives = []

        if "read" in objective_lower or "content" in objective_lower:
            alternatives = ["file_read", "bash_execute"]
        elif "search" in objective_lower or "find" in objective_lower:
            alternatives = ["search_filesystem", "list_files", "bash_execute"]
        elif "list" in objective_lower or "directory" in objective_lower:
            alternatives = ["list_files", "bash_execute"]
        elif "write" in objective_lower or "create" in objective_lower:
            alternatives = ["file_write", "bash_execute"]
        elif "execute" in objective_lower or "run" in objective_lower:
            alternatives = ["bash_execute", "python_execute"]

        # Filter out failed tools
        alternatives = [t for t in alternatives if t not in failed_tools]

        if not alternatives:
            return None

        # Pick first available alternative
        tool_name = alternatives[0]
        args = self._infer_tool_arguments(tool_name, step.objective, discoveries)

        return ToolDecision(
            tool_name=tool_name,
            arguments=args,
            rationale=f"Pivoting to alternative tool: {tool_name}"
        )

    def _infer_tool_arguments(
        self,
        tool_name: str,
        objective: str,
        discoveries: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Infer tool arguments from objective text.

        Uses graphd if available for smart symbol/file lookups.
        Falls back to heuristic extraction.
        """
        args = {}

        # Extract paths from objective
        import re
        path_patterns = [
            r'["\']([^"\']+\.[a-zA-Z]{1,4})["\']',  # "file.ext"
            r'`([^`]+\.[a-zA-Z]{1,4})`',             # `file.ext`
            r'\b(\S+\.[a-zA-Z]{1,4})\b',             # file.ext
        ]

        for pattern in path_patterns:
            match = re.search(pattern, objective)
            if match:
                path = match.group(1)
                break
        else:
            path = None

        # TRY GRAPHD FIRST: Smart symbol/file lookup
        if self.graphd_client and tool_name == "file_read" and not path:
            # Extract symbol/class/function names from objective
            symbol_patterns = [
                r'\b([A-Z][a-zA-Z]+(?:\.[a-zA-Z_]+)*)\b',  # ClassName.method
                r'\b([a-z_]+(?:\.[a-z_]+)*)\b'              # function_name
            ]
            for pattern in symbol_patterns:
                match = re.search(pattern, objective)
                if match:
                    symbol_name = match.group(1)
                    try:
                        # Use graphd search to find files containing this symbol
                        search_resp = self.graphd_client.search({
                            "pattern": f"\\b{symbol_name}\\b",
                            "max_results": 5
                        })
                        items = search_resp.get("items", [])
                        if items:
                            # Use first match
                            path = items[0].get("path")
                            self._log("graphd_symbol_resolved", {
                                "symbol": symbol_name,
                                "path": path,
                                "matches": len(items)
                            })
                            break
                    except Exception:
                        pass  # Fall back to heuristics

        # Standard tool argument inference
        if tool_name == "file_read" and path:
            args["path"] = path
        elif tool_name == "file_write" and path:
            args["path"] = path
            args["content"] = ""  # Placeholder
        elif tool_name == "search_filesystem":
            # Extract search term
            search_patterns = [r'search\s+for\s+["\']?(\w+)', r'find\s+["\']?(\w+)']
            for pattern in search_patterns:
                match = re.search(pattern, objective, re.IGNORECASE)
                if match:
                    args["pattern"] = f"*{match.group(1)}*"
                    break
        elif tool_name == "list_files" and path:
            args["path"] = path
        elif tool_name == "bash_execute":
            # Very basic - just echo the objective
            args["command"] = "echo 'Command not specified'"

        return args

    def _describe_modifications(
        self,
        original: Dict[str, Any],
        modified: Dict[str, Any]
    ) -> str:
        """Describe what changed between original and modified args."""
        changes = []
        for key in set(original.keys()) | set(modified.keys()):
            if key not in original:
                changes.append(f"added {key}")
            elif key not in modified:
                changes.append(f"removed {key}")
            elif original[key] != modified[key]:
                changes.append(f"changed {key}")
        return "; ".join(changes) if changes else "no changes"

    # =========================================================================
    # ARTIFACT AND FAILURE CREATION
    # =========================================================================

    def _create_artifact(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        result: ToolResult
    ) -> Optional[WorkArtifact]:
        """Create a work artifact from successful tool execution."""
        timestamp = time.time()

        if tool_name == "file_read":
            content = str(result.output) if result.output else ""
            return WorkArtifact(
                type=ArtifactType.FILE_READ,
                timestamp=timestamp,
                tool_name=tool_name,
                path=arguments.get("path"),
                new_content_hash=hashlib.md5(content.encode()).hexdigest()[:8],
                success=True,
                duration_ms=result.duration_ms
            )

        elif tool_name == "file_write":
            content = arguments.get("content", "")
            return WorkArtifact(
                type=ArtifactType.FILE_CREATED,
                timestamp=timestamp,
                tool_name=tool_name,
                path=arguments.get("path"),
                bytes_written=len(content) if isinstance(content, str) else 0,
                new_content_hash=hashlib.md5(str(content).encode()).hexdigest()[:8],
                success=True,
                duration_ms=result.duration_ms
            )

        elif tool_name == "bash_execute":
            output = str(result.output) if result.output else ""
            return WorkArtifact(
                type=ArtifactType.COMMAND_EXECUTED,
                timestamp=timestamp,
                tool_name=tool_name,
                command=arguments.get("command", "")[:100],
                stdout_preview=output[:200],
                exit_code=0,  # Success assumed since result.is_success
                success=True,
                duration_ms=result.duration_ms
            )

        elif tool_name == "search_filesystem":
            output = str(result.output) if result.output else ""
            matches = output.strip().split("\n") if output.strip() else []
            return WorkArtifact(
                type=ArtifactType.SEARCH_PERFORMED,
                timestamp=timestamp,
                tool_name=tool_name,
                query=arguments.get("pattern", ""),
                results_count=len(matches),
                success=True,
                duration_ms=result.duration_ms
            )

        return None

    def _create_failure(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        result: ToolResult,
        attempt: int
    ) -> ToolFailure:
        """Create a failure record from failed tool execution."""
        # Determine error type
        error_msg = str(result.error) if result.error else "Unknown error"
        error_type = self._classify_error(result.status, error_msg)

        # Determine if retryable
        is_retryable = error_type not in {"permission", "invalid_args", "not_found"}

        # Suggest remedy
        remedy = self._suggest_remedy(tool_name, error_type, error_msg)
        tb_text = self._extract_traceback(result)

        return ToolFailure(
            tool_name=tool_name,
            timestamp=time.time(),
            attempt=attempt,
            status=result.status,
            error_message=error_msg[:200],
            error_type=error_type,
            arguments=arguments,
            duration_ms=result.duration_ms,
            is_retryable=is_retryable,
            suggested_remedy=remedy,
            traceback=tb_text
        )

    def _classify_error(self, status: ToolStatus, error_msg: str) -> str:
        """Classify error into categories."""
        error_lower = error_msg.lower()

        if status == ToolStatus.TIMEOUT:
            return "timeout"
        elif "permission" in error_lower or "access denied" in error_lower:
            return "permission"
        elif "not found" in error_lower or "no such file" in error_lower:
            return "not_found"
        elif "invalid" in error_lower or "argument" in error_lower:
            return "invalid_args"
        elif "rate limit" in error_lower or "quota" in error_lower:
            return "rate_limit"
        else:
            return "unknown"

    def _suggest_remedy(self, tool_name: str, error_type: str, error_msg: str) -> Optional[str]:
        """Suggest a remedy for the error."""
        remedies = {
            "timeout": "Try with smaller input or increase timeout",
            "permission": "Check file permissions or use elevated privileges",
            "not_found": "Verify path exists or search for correct path",
            "invalid_args": "Review and correct tool arguments",
            "rate_limit": "Wait and retry, or reduce request frequency",
        }
        return remedies.get(error_type)

    # =========================================================================
    # RESULT BUILDING
    # =========================================================================

    def _build_manifest_entry(self, context: MicroloopContext) -> StepManifestEntry:
        """Build manifest entry from microloop context."""
        step = context.step

        # Determine final status
        if context.state == StepExecutionState.COMPLETE:
            status = PlanStatus.COMPLETED
        elif context.state == StepExecutionState.ESCALATE:
            status = PlanStatus.FAILED
        else:
            status = PlanStatus.PARTIAL

        # Collect file lists
        files_created = []
        files_modified = []
        files_read = []
        for artifact in context.artifacts:
            if artifact.path:
                if artifact.type == ArtifactType.FILE_CREATED:
                    files_created.append(artifact.path)
                elif artifact.type == ArtifactType.FILE_MODIFIED:
                    files_modified.append(artifact.path)
                elif artifact.type == ArtifactType.FILE_READ:
                    files_read.append(artifact.path)

        # Collect tool stats
        tools_called = list(set(t.tool_name for t in context.tool_history))
        successful = sum(1 for t in context.tool_history if t.result and t.result.is_success)
        failed = len(context.tool_history) - successful

        # Error and escalation info
        error = None
        escalation_reason = None
        if context.state == StepExecutionState.ESCALATE:
            if context.failures:
                error = context.failures[-1].error_message
            if context.reasoning_trace.latest_decision:
                escalation_reason = context.reasoning_trace.latest_decision.reasoning

        return StepManifestEntry(
            step_num=step.step_num,
            objective=step.objective,
            final_state=context.state,
            status=status,
            artifacts=context.artifacts,
            failures=context.failures,
            files_created=files_created,
            files_modified=files_modified,
            files_read=files_read,
            tools_called=tools_called,
            total_tool_calls=len(context.tool_history),
            successful_tool_calls=successful,
            failed_tool_calls=failed,
            reasoning_decisions=len(context.reasoning_trace.decisions),
            commitments=context.reasoning_trace.commitments,
            duration_ms=context.elapsed_ms,
            error=error,
            escalation_reason=escalation_reason,
        )

    def _build_step_result(self, context: MicroloopContext) -> StepResult:
        """Build StepResult from microloop context for executor compatibility."""
        step = context.step

        # Determine status
        if context.state == StepExecutionState.COMPLETE:
            status = PlanStatus.COMPLETED
        elif context.state == StepExecutionState.ESCALATE:
            status = PlanStatus.FAILED
        else:
            status = PlanStatus.PARTIAL

        # Build final response from accumulated data
        final_response = None
        if context.accumulated_data:
            # Get last successful output
            for key in reversed(list(context.accumulated_data.keys())):
                value = context.accumulated_data[key]
                if isinstance(value, list) and value:
                    final_response = str(value[-1])[:500]
                    break
                elif value:
                    final_response = str(value)[:500]
                    break

        # Error message
        error = None
        if context.failures:
            error = context.failures[-1].error_message

        return StepResult(
            step_num=step.step_num,
            status=status,
            tool_calls_made=context.tool_history,
            accumulated_data=context.accumulated_data,
            final_response=final_response,
            error=error,
            duration_ms=context.elapsed_ms,
            phase=step.phase,
        )
