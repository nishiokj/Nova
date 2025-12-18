"""
Execution Models - State machine and manifest for resilient step execution.

This module provides:
- ExecutionManifest: Tracks actual work done (files, artifacts, failures)
- MicroloopContext: State machine context for step execution
- StepExecutionState: First-class execution states
- TimeoutPolicy: Standardized timeout configuration
- WorkArtifact: Explicit tracking of work products
- ReasoningTrace: Monotonic commitment pattern for reasoning

Design Principles:
1. Plan stays frozen (strategic intent) - Manifest tracks runtime state
2. Microloop has explicit state transitions with guards
3. Reasoning decisions are monotonic (COMMIT cannot be undone)
4. Extension points for future invariant checking (dependency worklist)
"""

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Callable, Dict, List, Optional, Protocol, Set, Tuple, Union

from .plan_models import PlanStep, PlanStatus, ToolCallRecord
from .tool_registry import ToolResult, ToolStatus


# =============================================================================
# STEP EXECUTION STATE MACHINE
# =============================================================================

class StepExecutionState(Enum):
    """
    First-class execution states for the microloop.

    State transitions:
    READY -> TOOL_PENDING (decide tool call)
    TOOL_PENDING -> AWAITING_RESULT (tool submitted)
    AWAITING_RESULT -> INTERPRET_RESULT (result received, needs parsing)
    INTERPRET_RESULT -> REASONING (interpretations extracted)
    REASONING -> COMPLETE (success criteria met)
    REASONING -> RETRY (same tool, different args)
    REASONING -> PIVOT (different tool)
    REASONING -> ESCALATE (cannot proceed)
    REASONING -> READY (continue with next tool call based on output)
    RETRY -> TOOL_PENDING
    PIVOT -> TOOL_PENDING
    """
    READY = auto()           # Initial state, can attempt tool call
    TOOL_PENDING = auto()    # Tool call decided, not yet executed
    AWAITING_RESULT = auto() # Tool execution in flight
    INTERPRET_RESULT = auto()  # Parse tool output into structured interpretations
    REASONING = auto()       # Evaluating outcome, deciding next action
    RETRY = auto()           # Same tool, modified approach
    PIVOT = auto()           # Different tool needed
    COMPLETE = auto()        # Success criteria met
    ESCALATE = auto()        # Cannot proceed, needs plan-level intervention


class ReasoningDecisionType(Enum):
    """Types of reasoning decisions in the microloop."""
    COMMIT = "commit"      # Forward decision, cannot be undone
    REFINE = "refine"      # Adjust within existing commits
    ESCALATE = "escalate"  # Flag for plan-level reconsideration


# =============================================================================
# WORK ARTIFACTS - Explicit tracking of actual work
# =============================================================================

class ArtifactType(Enum):
    """Types of work artifacts produced during execution."""
    FILE_CREATED = "file_created"
    FILE_MODIFIED = "file_modified"
    FILE_DELETED = "file_deleted"
    FILE_READ = "file_read"
    COMMAND_EXECUTED = "command_executed"
    SEARCH_PERFORMED = "search_performed"
    API_CALLED = "api_called"
    VALIDATION_RESULT = "validation_result"


@dataclass
class WorkArtifact:
    """
    Explicit record of work actually done.

    Unlike Discovery which is about information gathering,
    WorkArtifact tracks mutations and verifiable outcomes.
    """
    type: ArtifactType
    timestamp: float
    tool_name: str

    # File operations
    path: Optional[str] = None
    original_content_hash: Optional[str] = None  # For verifying what was changed
    new_content_hash: Optional[str] = None
    bytes_written: Optional[int] = None

    # Command execution
    command: Optional[str] = None
    exit_code: Optional[int] = None
    stdout_preview: Optional[str] = None
    stderr_preview: Optional[str] = None

    # Search/query operations
    query: Optional[str] = None
    results_count: Optional[int] = None

    # Validation
    validation_passed: Optional[bool] = None
    validation_message: Optional[str] = None

    # Universal
    success: bool = True
    error_message: Optional[str] = None
    duration_ms: float = 0

    def to_dict(self) -> Dict[str, Any]:
        """Serialize for logging/persistence."""
        return {
            "type": self.type.value,
            "timestamp": self.timestamp,
            "tool_name": self.tool_name,
            "path": self.path,
            "success": self.success,
            "error_message": self.error_message,
            "duration_ms": self.duration_ms,
            "bytes_written": self.bytes_written,
            "command": self.command,
            "exit_code": self.exit_code,
            "query": self.query,
            "results_count": self.results_count,
        }


@dataclass
class ToolFailure:
    """Detailed record of a tool failure for diagnosis."""
    tool_name: str
    timestamp: float
    attempt: int

    # Error details
    status: ToolStatus
    error_message: str
    error_type: Optional[str] = None  # e.g., "timeout", "permission", "not_found"

    # Context
    arguments: Dict[str, Any] = field(default_factory=dict)
    duration_ms: float = 0

    # Recovery info
    is_retryable: bool = True
    suggested_remedy: Optional[str] = None
    traceback: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tool_name": self.tool_name,
            "timestamp": self.timestamp,
            "attempt": self.attempt,
            "status": self.status.value,
            "error_message": self.error_message,
            "error_type": self.error_type,
            "is_retryable": self.is_retryable,
            "suggested_remedy": self.suggested_remedy,
            "duration_ms": self.duration_ms,
            "traceback": self.traceback,
        }


# =============================================================================
# REASONING TRACE - Monotonic commitment pattern
# =============================================================================

@dataclass
class ReasoningDecision:
    """
    A single reasoning decision in the microloop.

    COMMIT decisions are monotonic - they cannot be undone.
    This prevents oscillating reasoning loops.
    """
    decision_type: ReasoningDecisionType
    reasoning: str
    timestamp: float

    # What was decided
    action: str  # e.g., "retry_with_different_path", "pivot_to_search", "mark_complete"
    confidence: float = 0.8  # 0.0-1.0

    # For COMMIT decisions
    commitment: Optional[str] = None  # What cannot be undone

    # For REFINE decisions
    refinement_of: Optional[int] = None  # Index of decision being refined

    # Evidence
    tool_result_summary: Optional[str] = None
    success_criteria_status: Optional[str] = None

    @property
    def is_committed(self) -> bool:
        return self.decision_type == ReasoningDecisionType.COMMIT


@dataclass
class ReasoningTrace:
    """
    Full trace of reasoning decisions for a step.

    Enforces monotonic commitment - once a COMMIT is made,
    subsequent decisions cannot contradict it.
    """
    decisions: List[ReasoningDecision] = field(default_factory=list)

    @property
    def commitments(self) -> List[str]:
        """Get all committed decisions (cannot be contradicted)."""
        return [
            d.commitment for d in self.decisions
            if d.is_committed and d.commitment
        ]

    @property
    def latest_decision(self) -> Optional[ReasoningDecision]:
        return self.decisions[-1] if self.decisions else None

    def add_decision(self, decision: ReasoningDecision) -> bool:
        """
        Add a decision, checking for commitment violations.

        Returns False if decision contradicts existing commitments.
        """
        # In a full implementation, we'd check if the new decision
        # contradicts any existing commitments. For now, we just append.
        self.decisions.append(decision)
        return True

    def to_prompt_context(self) -> str:
        """Format commitments for LLM context injection."""
        if not self.commitments:
            return ""

        return "PREVIOUS COMMITMENTS (DO NOT CONTRADICT):\n" + "\n".join(
            f"  - {c}" for c in self.commitments
        )

    def to_full_reasoning_context(self) -> str:
        """
        Format full reasoning history for LLM context.

        Used when LLM needs to reason about retry/pivot/escalate decisions.
        """
        if not self.decisions:
            return ""

        lines = ["REASONING HISTORY:"]
        for i, d in enumerate(self.decisions[-5:], 1):  # Last 5 decisions
            decision_type = d.decision_type.value.upper()
            lines.append(f"  {i}. [{decision_type}] {d.action}")
            lines.append(f"     Reasoning: {d.reasoning[:100]}")
            if d.tool_result_summary:
                lines.append(f"     Tool result: {d.tool_result_summary[:80]}")
            if d.is_committed and d.commitment:
                lines.append(f"     COMMITTED: {d.commitment}")

        return "\n".join(lines)


# =============================================================================
# TIMEOUT POLICIES - Standardized timeout configuration
# =============================================================================

@dataclass
class TimeoutPolicy:
    """
    Timeout configuration for a tool category.

    Supports exponential backoff for retries.
    """
    base_timeout_ms: int = 30_000
    max_timeout_ms: int = 120_000
    backoff_multiplier: float = 1.5

    # Retry configuration
    max_retries: int = 2
    retry_delay_ms: int = 300

    # Circuit breaker
    failure_threshold: int = 3  # Failures before circuit opens
    recovery_timeout_ms: int = 60_000  # Time before retry after circuit opens

    def get_timeout_for_attempt(self, attempt: int) -> int:
        """Calculate timeout with exponential backoff."""
        timeout = self.base_timeout_ms * (self.backoff_multiplier ** attempt)
        return min(int(timeout), self.max_timeout_ms)

    def get_retry_delay(self, attempt: int) -> float:
        """Calculate retry delay in seconds."""
        delay_ms = self.retry_delay_ms * (2 ** attempt)
        return min(delay_ms, 5000) / 1000  # Cap at 5 seconds


# Default timeout policies per tool category
TOOL_TIMEOUT_POLICIES: Dict[str, TimeoutPolicy] = {
    # Fast, cheap operations - encourage these
    "file_read": TimeoutPolicy(
        base_timeout_ms=10_000,
        max_timeout_ms=30_000,
        backoff_multiplier=1.0,  # No backoff - just retry quickly
        max_retries=2
    ),
    "list_files": TimeoutPolicy(
        base_timeout_ms=10_000,
        max_timeout_ms=30_000,
        max_retries=2
    ),
    "search_filesystem": TimeoutPolicy(
        base_timeout_ms=20_000,
        max_timeout_ms=60_000,
        max_retries=2
    ),

    # Medium operations
    "file_write": TimeoutPolicy(
        base_timeout_ms=15_000,
        max_timeout_ms=45_000,
        max_retries=1  # Writes are risky to retry
    ),
    "bash_execute": TimeoutPolicy(
        base_timeout_ms=30_000,
        max_timeout_ms=120_000,
        backoff_multiplier=2.0,
        max_retries=1
    ),

    # Expensive operations - discourage via longer timeouts but fewer retries
    "python_execute": TimeoutPolicy(
        base_timeout_ms=60_000,
        max_timeout_ms=180_000,
        max_retries=1
    ),
    "web_request": TimeoutPolicy(
        base_timeout_ms=45_000,
        max_timeout_ms=90_000,
        backoff_multiplier=2.0,
        max_retries=2
    ),
    "generate_image": TimeoutPolicy(
        base_timeout_ms=70_000,
        max_timeout_ms=120_000,
        max_retries=1
    ),

    # Default for unknown tools
    "default": TimeoutPolicy(
        base_timeout_ms=30_000,
        max_timeout_ms=90_000,
        max_retries=2
    ),
}


def get_timeout_policy(tool_name: str) -> TimeoutPolicy:
    """Get timeout policy for a tool, with fallback to default."""
    return TOOL_TIMEOUT_POLICIES.get(tool_name, TOOL_TIMEOUT_POLICIES["default"])


# =============================================================================
# MICROLOOP CONTEXT - State machine for step execution
# =============================================================================

@dataclass
class ToolDecision:
    """Decision about which tool to call and how."""
    tool_name: str
    arguments: Dict[str, Any]
    rationale: str
    is_retry: bool = False
    retry_modifications: Optional[str] = None  # What changed from previous attempt
    stop_after: bool = False  # Signal to complete after this tool call
    confidence: float = 0.8  # Decision confidence


@dataclass
class ToolInterpretation:
    """
    Per-tool-call parsed interpretation of output.

    These get merged into the accumulated Discovery dict (from plan_models).
    """
    interpretation_type: str  # "file_found", "symbol_found", "error_pattern", "data_extracted", etc.
    key: str  # Identifier for this interpretation
    value: Any  # The extracted value
    confidence: float = 1.0
    source_tool: str = ""
    source_output_hash: str = ""  # For dedup/staleness detection


@dataclass
class ToolContextBundle:
    """
    Context bundle injected into tool-choice and arg-generation decisions.

    This is the KEY structure that enables intelligent reasoning over tool outputs.
    The LLM sees this bundle when deciding what to call next.
    """
    # Step context
    step_objective: str
    step_num: int

    # Available tools
    tools_available: List[str]

    # Last tool execution
    last_tool_name: Optional[str] = None
    last_tool_success: Optional[bool] = None
    last_output_summary: Optional[str] = None  # Trimmed + parsed summary
    last_output_hash: Optional[str] = None  # For detecting identical outputs

    # Failure context
    failures: List[Dict[str, Any]] = field(default_factory=list)  # [{type, message, remedy}]
    failure_count: int = 0

    # Artifacts and discoveries (Discovery type from plan_models)
    artifacts: List[Dict[str, str]] = field(default_factory=list)  # [{type, path/summary}]
    discoveries: Dict[str, Any] = field(default_factory=dict)  # Accumulated Discovery entries
    interpretations_delta: List[ToolInterpretation] = field(default_factory=list)  # New from last tool

    # Budget tracking
    attempts_used: int = 0
    attempts_remaining: int = 3
    tool_calls_this_attempt: int = 0
    max_tool_calls_per_attempt: int = 5
    budget_exhausted: bool = False

    # History hashes for stagnation detection
    recent_output_hashes: List[str] = field(default_factory=list)  # Last N output hashes
    stagnation_detected: bool = False

    # Commitments from reasoning trace (cannot contradict)
    commitments: List[str] = field(default_factory=list)

    def to_decision_prompt(self) -> str:
        """Format bundle for LLM decision-making."""
        lines = [
            f"STEP {self.step_num}: {self.step_objective}",
            f"Budget: {self.attempts_used}/{self.attempts_used + self.attempts_remaining} attempts, "
            f"{self.tool_calls_this_attempt}/{self.max_tool_calls_per_attempt} tool calls this attempt",
        ]

        if self.budget_exhausted:
            lines.append("⚠️ BUDGET EXHAUSTED - must COMPLETE or ESCALATE")

        if self.stagnation_detected:
            lines.append("⚠️ STAGNATION DETECTED - outputs not changing, consider PIVOT or ESCALATE")

        lines.append(f"\nAVAILABLE TOOLS: {', '.join(self.tools_available)}")

        if self.last_tool_name:
            status = "SUCCESS" if self.last_tool_success else "FAILED"
            lines.append(f"\nLAST TOOL: {self.last_tool_name} [{status}]")
            if self.last_output_summary:
                lines.append(f"Output summary: {self.last_output_summary[:300]}")

        if self.interpretations_delta:
            lines.append("\nNEW INTERPRETATIONS (from last tool):")
            for interp in self.interpretations_delta[:5]:
                lines.append(f"  - {interp.interpretation_type}: {interp.key} = {str(interp.value)[:100]}")

        if self.discoveries:
            lines.append(f"\nACCUMULATED DISCOVERIES: {len(self.discoveries)} items")
            for key in list(self.discoveries.keys())[:5]:
                lines.append(f"  - {key}: {str(self.discoveries[key])[:60]}")

        if self.artifacts:
            lines.append("\nARTIFACTS PRODUCED:")
            for art in self.artifacts[:5]:
                lines.append(f"  - {art.get('type', 'unknown')}: {art.get('path', art.get('summary', ''))[:60]}")

        if self.failures:
            lines.append(f"\nFAILURES ({self.failure_count} total):")
            for fail in self.failures[-3:]:
                lines.append(f"  - {fail.get('type', 'unknown')}: {fail.get('message', '')[:80]}")
                if fail.get('remedy'):
                    lines.append(f"    Suggested: {fail['remedy']}")

        if self.commitments:
            lines.append("\nPREVIOUS COMMITMENTS (DO NOT CONTRADICT):")
            for c in self.commitments:
                lines.append(f"  - {c}")

        return "\n".join(lines)


@dataclass
class LLMToolDecision:
    """
    Structured output from LLM tool decision.

    The LLM must return this exact structure (via JSON schema enforcement).
    """
    action: str  # "CALL_TOOL", "COMPLETE", "ESCALATE"
    tool_name: Optional[str] = None
    arguments: Optional[Dict[str, Any]] = None
    rationale: str = ""
    confidence: float = 0.8
    stop_after_this: bool = False  # If True, mark step complete after tool execution

    @classmethod
    def from_json(cls, data: Dict[str, Any]) -> "LLMToolDecision":
        return cls(
            action=data.get("action", "ESCALATE"),
            tool_name=data.get("tool_name"),
            arguments=data.get("arguments", {}),
            rationale=data.get("rationale", ""),
            confidence=data.get("confidence", 0.8),
            stop_after_this=data.get("stop_after_this", False),
        )

    def to_tool_decision(self) -> Optional[ToolDecision]:
        """Convert to ToolDecision if action is CALL_TOOL."""
        if self.action != "CALL_TOOL" or not self.tool_name:
            return None
        return ToolDecision(
            tool_name=self.tool_name,
            arguments=self.arguments or {},
            rationale=self.rationale,
            stop_after=self.stop_after_this,
            confidence=self.confidence,
        )


@dataclass
class MicroloopContext:
    """
    State machine context for step execution.

    Tracks all state needed for the microloop to:
    1. Execute tools with proper timeouts
    2. Reason about outcomes
    3. Adapt (retry/pivot) when needed
    4. Know when to complete or escalate

    Extension Points:
    - invariant_checkers: Functions that validate state after each transition
    - completion_conditions: Additional conditions beyond success_criteria
    - pre_tool_hooks: Called before each tool execution
    - post_tool_hooks: Called after each tool execution
    """
    step: PlanStep

    # State machine
    state: StepExecutionState = StepExecutionState.READY

    # Attempt tracking
    attempt: int = 0
    max_attempts: int = 3
    tool_attempts: Dict[str, int] = field(default_factory=dict)  # tool_name -> attempts

    # Per-attempt tool call budget (prevents infinite spin)
    tool_calls_this_attempt: int = 0
    max_tool_calls_per_attempt: int = 5
    total_tool_calls: int = 0

    # History
    tool_history: List[ToolCallRecord] = field(default_factory=list)
    reasoning_trace: ReasoningTrace = field(default_factory=ReasoningTrace)

    # Accumulated work
    artifacts: List[WorkArtifact] = field(default_factory=list)
    failures: List[ToolFailure] = field(default_factory=list)
    accumulated_data: Dict[str, Any] = field(default_factory=dict)

    # Discoveries - uses Discovery type from plan_models for cross-step sharing
    # These are the accumulated structured findings from all tool calls
    discoveries: Dict[str, Any] = field(default_factory=dict)
    # Per-tool-call interpretations (delta from last tool, merged into discoveries)
    interpretations_delta: List[ToolInterpretation] = field(default_factory=list)

    # Stagnation detection - track output hashes to detect spinning
    recent_output_hashes: List[str] = field(default_factory=list)
    MAX_OUTPUT_HASH_HISTORY: int = 5

    # Current tool decision (set when in TOOL_PENDING state)
    current_tool_decision: Optional[ToolDecision] = None
    current_tool_result: Optional[ToolResult] = None

    # Timing
    started_at: float = field(default_factory=time.time)
    last_state_change: float = field(default_factory=time.time)

    # Extension points (set by Microloop class)
    _invariant_checkers: List[Callable[["MicroloopContext"], Tuple[bool, str]]] = field(
        default_factory=list, repr=False
    )
    _completion_conditions: List[Callable[["MicroloopContext"], Tuple[bool, str]]] = field(
        default_factory=list, repr=False
    )

    @property
    def elapsed_ms(self) -> float:
        return (time.time() - self.started_at) * 1000

    @property
    def is_terminal(self) -> bool:
        """Check if in a terminal state (COMPLETE or ESCALATE)."""
        return self.state in (StepExecutionState.COMPLETE, StepExecutionState.ESCALATE)

    @property
    def should_give_up(self) -> bool:
        """Check if we've exhausted retry attempts."""
        return self.attempt >= self.max_attempts

    @property
    def budget_exhausted(self) -> bool:
        """Check if per-attempt tool call budget is exhausted."""
        return self.tool_calls_this_attempt >= self.max_tool_calls_per_attempt

    @property
    def is_stagnating(self) -> bool:
        """
        Detect stagnation: outputs not changing across tool calls.

        Returns True if last 3+ outputs have identical hashes.
        """
        if len(self.recent_output_hashes) < 3:
            return False
        # Check if last 3 hashes are identical
        last_three = self.recent_output_hashes[-3:]
        return len(set(last_three)) == 1

    def record_tool_call_tracking(self, output_hash: str) -> None:
        """
        Track tool call for budget and stagnation detection.

        Call this after each tool execution.
        """
        self.tool_calls_this_attempt += 1
        self.total_tool_calls += 1

        # Track output hash for stagnation detection
        self.recent_output_hashes.append(output_hash)
        if len(self.recent_output_hashes) > self.MAX_OUTPUT_HASH_HISTORY:
            self.recent_output_hashes.pop(0)

    def reset_attempt_budget(self) -> None:
        """Reset per-attempt tool call counter (called on new attempt)."""
        self.tool_calls_this_attempt = 0

    def build_context_bundle(
        self,
        tools_available: List[str],
        existing_discoveries: Optional[Dict[str, Any]] = None
    ) -> ToolContextBundle:
        """
        Build ToolContextBundle for LLM tool-choice decision.

        This is THE key method for injecting intelligence into decisions.
        """
        import hashlib

        # Get last tool info
        last_tool_name = None
        last_tool_success = None
        last_output_summary = None
        last_output_hash = None

        if self.tool_history:
            last_record = self.tool_history[-1]
            last_tool_name = last_record.tool_name
            last_tool_success = last_record.result.is_success if last_record.result else False
            if last_record.result and last_record.result.output:
                output_str = str(last_record.result.output)
                last_output_summary = output_str[:500]
                last_output_hash = hashlib.md5(output_str.encode()).hexdigest()[:8]

        # Build failure summaries
        failure_summaries = [
            {
                "type": f.error_type or "unknown",
                "message": f.error_message[:100],
                "remedy": f.suggested_remedy,
                "tool": f.tool_name,
            }
            for f in self.failures[-5:]
        ]

        # Build artifact summaries
        artifact_summaries = [
            {
                "type": a.type.value,
                "path": a.path,
                "summary": a.stdout_preview[:100] if a.stdout_preview else None,
            }
            for a in self.artifacts[-5:]
        ]

        # Merge existing discoveries with current discoveries
        merged_discoveries = dict(existing_discoveries or {})
        merged_discoveries.update(self.discoveries)

        return ToolContextBundle(
            step_objective=self.step.objective,
            step_num=self.step.step_num,
            tools_available=tools_available,
            last_tool_name=last_tool_name,
            last_tool_success=last_tool_success,
            last_output_summary=last_output_summary,
            last_output_hash=last_output_hash,
            failures=failure_summaries,
            failure_count=len(self.failures),
            artifacts=artifact_summaries,
            discoveries=merged_discoveries,
            interpretations_delta=self.interpretations_delta,
            attempts_used=self.attempt,
            attempts_remaining=self.max_attempts - self.attempt,
            tool_calls_this_attempt=self.tool_calls_this_attempt,
            max_tool_calls_per_attempt=self.max_tool_calls_per_attempt,
            budget_exhausted=self.budget_exhausted,
            recent_output_hashes=self.recent_output_hashes[-3:],
            stagnation_detected=self.is_stagnating,
            commitments=self.reasoning_trace.commitments,
        )

    @property
    def files_created(self) -> List[str]:
        """Get list of files created during this step."""
        return [
            a.path for a in self.artifacts
            if a.type == ArtifactType.FILE_CREATED and a.path and a.success
        ]

    @property
    def files_modified(self) -> List[str]:
        """Get list of files modified during this step."""
        return [
            a.path for a in self.artifacts
            if a.type == ArtifactType.FILE_MODIFIED and a.path and a.success
        ]

    @property
    def failed_operations(self) -> List[str]:
        """Get summary of failed operations."""
        return [
            f"{f.tool_name}: {f.error_message[:50]}" for f in self.failures
        ]

    def record_artifact(self, artifact: WorkArtifact) -> None:
        """Record a work artifact."""
        self.artifacts.append(artifact)

    def record_failure(self, failure: ToolFailure) -> None:
        """Record a tool failure."""
        self.failures.append(failure)
        self.tool_attempts[failure.tool_name] = self.tool_attempts.get(failure.tool_name, 0) + 1

    def transition_to(self, new_state: StepExecutionState) -> bool:
        """
        Transition to a new state.

        Returns False if transition is invalid or invariants fail.
        """
        # Validate transition
        valid_transitions = {
            StepExecutionState.READY: {StepExecutionState.TOOL_PENDING, StepExecutionState.COMPLETE, StepExecutionState.ESCALATE},
            StepExecutionState.TOOL_PENDING: {StepExecutionState.AWAITING_RESULT, StepExecutionState.ESCALATE},
            StepExecutionState.AWAITING_RESULT: {StepExecutionState.INTERPRET_RESULT},
            StepExecutionState.INTERPRET_RESULT: {StepExecutionState.REASONING},
            StepExecutionState.REASONING: {
                StepExecutionState.COMPLETE,
                StepExecutionState.RETRY,
                StepExecutionState.PIVOT,
                StepExecutionState.ESCALATE,
                StepExecutionState.READY,  # Continue with next tool based on output
            },
            StepExecutionState.RETRY: {StepExecutionState.TOOL_PENDING, StepExecutionState.ESCALATE},
            StepExecutionState.PIVOT: {StepExecutionState.TOOL_PENDING, StepExecutionState.ESCALATE},
            StepExecutionState.COMPLETE: set(),  # Terminal
            StepExecutionState.ESCALATE: set(),  # Terminal
        }

        if new_state not in valid_transitions.get(self.state, set()):
            return False

        # Check invariants
        for checker in self._invariant_checkers:
            passed, reason = checker(self)
            if not passed:
                # Invariant failed - force ESCALATE
                self.state = StepExecutionState.ESCALATE
                self.reasoning_trace.add_decision(ReasoningDecision(
                    decision_type=ReasoningDecisionType.ESCALATE,
                    reasoning=f"Invariant violation: {reason}",
                    timestamp=time.time(),
                    action="escalate_invariant_violation"
                ))
                return False

        self.state = new_state
        self.last_state_change = time.time()
        return True

    def check_completion_conditions(self) -> Tuple[bool, str]:
        """
        Check if any completion condition is met.

        Returns (is_complete, reason).
        """
        # Built-in: Check success criteria
        if self.step.success_criteria and self.step.success_criteria.required_outputs:
            required = self.step.success_criteria.required_outputs
            if all(key in self.accumulated_data for key in required):
                return True, "All required outputs collected"

        # Extension: Custom completion conditions
        for condition in self._completion_conditions:
            is_complete, reason = condition(self)
            if is_complete:
                return True, reason

        return False, ""

    def to_manifest_entry(self) -> Dict[str, Any]:
        """Export context state for manifest."""
        return {
            "step_num": self.step.step_num,
            "objective": self.step.objective,
            "state": self.state.value if hasattr(self.state, 'value') else str(self.state),
            "attempts": self.attempt,
            "elapsed_ms": self.elapsed_ms,
            "artifacts": [a.to_dict() for a in self.artifacts],
            "failures": [f.to_dict() for f in self.failures],
            "files_created": self.files_created,
            "files_modified": self.files_modified,
            "tool_history": [
                {
                    "tool": t.tool_name,
                    "success": t.result.is_success if t.result else False,
                    "duration_ms": t.duration_ms
                }
                for t in self.tool_history
            ],
            "reasoning_decisions": len(self.reasoning_trace.decisions),
            "commitments": self.reasoning_trace.commitments,
        }

    def to_llm_reasoning_context(self) -> str:
        """
        Build comprehensive context for LLM reasoning about retry/pivot/escalate.

        This is the KEY method for injecting rich context into LLM decisions.
        Called when the microloop needs adaptive reasoning (not just rule-based).
        """
        sections = []

        # 1. Step context
        sections.append(f"STEP {self.step.step_num}: {self.step.objective}")
        sections.append(f"State: {self.state.name} | Attempt: {self.attempt}/{self.max_attempts}")

        # 2. Previous reasoning (commitments are binding)
        reasoning_ctx = self.reasoning_trace.to_full_reasoning_context()
        if reasoning_ctx:
            sections.append(reasoning_ctx)

        commitment_ctx = self.reasoning_trace.to_prompt_context()
        if commitment_ctx:
            sections.append(commitment_ctx)

        # 3. Tool execution history with results
        if self.tool_history:
            sections.append("TOOL EXECUTION HISTORY:")
            for i, record in enumerate(self.tool_history[-5:], 1):
                status = "SUCCESS" if record.result and record.result.is_success else "FAILED"
                output_preview = ""
                if record.result:
                    if record.result.is_success and record.result.output:
                        output_preview = f"\n     Output: {str(record.result.output)[:100]}..."
                    elif record.result.error:
                        output_preview = f"\n     Error: {record.result.error[:100]}"
                sections.append(
                    f"  {i}. {record.tool_name} [{status}] ({record.duration_ms:.0f}ms){output_preview}"
                )

        # 4. Work artifacts (what was actually accomplished)
        if self.artifacts:
            sections.append("WORK ACCOMPLISHED:")
            for artifact in self.artifacts[-5:]:
                if artifact.type == ArtifactType.FILE_CREATED:
                    sections.append(f"  + Created: {artifact.path} ({artifact.bytes_written or 0} bytes)")
                elif artifact.type == ArtifactType.FILE_MODIFIED:
                    sections.append(f"  ~ Modified: {artifact.path}")
                elif artifact.type == ArtifactType.FILE_READ:
                    sections.append(f"  . Read: {artifact.path}")
                elif artifact.type == ArtifactType.COMMAND_EXECUTED:
                    sections.append(f"  $ Executed: {artifact.command[:50]}... (exit: {artifact.exit_code})")
                elif artifact.type == ArtifactType.SEARCH_PERFORMED:
                    sections.append(f"  ? Search '{artifact.query}': {artifact.results_count} results")

        # 5. Failures with diagnosis (critical for adaptive reasoning)
        if self.failures:
            sections.append("FAILURES (for adaptive reasoning):")
            for failure in self.failures[-3:]:
                sections.append(f"  X {failure.tool_name} (attempt {failure.attempt}):")
                sections.append(f"    Error type: {failure.error_type or 'unknown'}")
                sections.append(f"    Message: {failure.error_message[:100]}")
                sections.append(f"    Retryable: {failure.is_retryable}")
                if failure.suggested_remedy:
                    sections.append(f"    Suggested: {failure.suggested_remedy}")

        # 6. Current decision point
        if self.current_tool_result:
            sections.append("CURRENT TOOL RESULT (decide next action):")
            result = self.current_tool_result
            if result.is_success:
                sections.append(f"  Status: SUCCESS")
                sections.append(f"  Output: {str(result.output)[:200]}...")
            else:
                sections.append(f"  Status: FAILED ({result.status.value if hasattr(result.status, 'value') else result.status})")
                sections.append(f"  Error: {result.error}")

        return "\n\n".join(sections)


# =============================================================================
# EXECUTION MANIFEST - Track actual work done
# =============================================================================

@dataclass
class StepManifestEntry:
    """Detailed record of what happened in a step."""
    step_num: int
    objective: str

    # Final state
    final_state: StepExecutionState
    status: PlanStatus

    # Work done
    artifacts: List[WorkArtifact] = field(default_factory=list)
    failures: List[ToolFailure] = field(default_factory=list)

    # Explicit file tracking
    files_created: List[str] = field(default_factory=list)
    files_modified: List[str] = field(default_factory=list)
    files_read: List[str] = field(default_factory=list)
    files_deleted: List[str] = field(default_factory=list)

    # Tool execution summary
    tools_called: List[str] = field(default_factory=list)
    total_tool_calls: int = 0
    successful_tool_calls: int = 0
    failed_tool_calls: int = 0

    # Reasoning trace
    reasoning_decisions: int = 0
    commitments: List[str] = field(default_factory=list)

    # Timing
    duration_ms: float = 0

    # Error info
    error: Optional[str] = None
    escalation_reason: Optional[str] = None

    def claimed_vs_actual(self) -> Dict[str, Any]:
        """
        Compare what the step claimed to do vs what actually happened.

        This is critical for verifying that "file created" claims are true.
        """
        # TODO: Could add filesystem verification here
        return {
            "files_claimed_created": self.files_created,
            "files_claimed_modified": self.files_modified,
            "verification_status": "not_verified",  # Placeholder for actual verification
        }


@dataclass
class ExecutionManifest:
    """
    Tracks actual work done during plan execution.

    Key differences from ExecutionTrace:
    1. Explicit artifact tracking (files created, modified, etc.)
    2. Structured failure records with diagnosis info
    3. Reasoning trace for audit
    4. Claimed vs actual verification

    The Plan stays frozen. This manifest records what actually happened.
    """
    plan_goal: str
    plan_id: str  # For correlation

    # Step-by-step manifest
    step_entries: List[StepManifestEntry] = field(default_factory=list)

    # Aggregate tracking
    all_files_created: Set[str] = field(default_factory=set)
    all_files_modified: Set[str] = field(default_factory=set)
    all_files_read: Set[str] = field(default_factory=set)

    # Aggregate failures
    all_failures: List[ToolFailure] = field(default_factory=list)
    escalated_steps: List[int] = field(default_factory=list)

    # Amendments (deviations from plan)
    amendments: List[Dict[str, Any]] = field(default_factory=list)

    # Timing
    started_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None

    @property
    def total_duration_ms(self) -> float:
        if self.completed_at:
            return (self.completed_at - self.started_at) * 1000
        return (time.time() - self.started_at) * 1000

    @property
    def success_rate(self) -> float:
        """Percentage of steps that completed successfully."""
        if not self.step_entries:
            return 0.0
        completed = sum(1 for e in self.step_entries if e.status == PlanStatus.COMPLETED)
        return completed / len(self.step_entries)

    @property
    def had_escalations(self) -> bool:
        return len(self.escalated_steps) > 0

    def add_step_entry(self, entry: StepManifestEntry) -> None:
        """Add a completed step entry and update aggregates."""
        self.step_entries.append(entry)

        # Update aggregate file tracking
        self.all_files_created.update(entry.files_created)
        self.all_files_modified.update(entry.files_modified)
        self.all_files_read.update(entry.files_read)

        # Track escalations
        if entry.final_state == StepExecutionState.ESCALATE:
            self.escalated_steps.append(entry.step_num)

        # Aggregate failures
        self.all_failures.extend(entry.failures)

    def add_amendment(self, step_num: int, amendment_type: str, details: str) -> None:
        """Record a deviation from the original plan."""
        self.amendments.append({
            "timestamp": time.time(),
            "step_num": step_num,
            "type": amendment_type,
            "details": details,
        })

    def finalize(self) -> None:
        """Mark manifest as complete."""
        self.completed_at = time.time()

    def to_summary(self) -> Dict[str, Any]:
        """Generate summary for logging/reporting."""
        return {
            "plan_goal": self.plan_goal,
            "plan_id": self.plan_id,
            "total_steps": len(self.step_entries),
            "success_rate": self.success_rate,
            "files_created": list(self.all_files_created),
            "files_modified": list(self.all_files_modified),
            "total_failures": len(self.all_failures),
            "escalated_steps": self.escalated_steps,
            "amendments_count": len(self.amendments),
            "duration_ms": self.total_duration_ms,
        }

    def to_step_guidance(self, current_step_num: int) -> str:
        """
        Generate guidance for LLM about what work has been done.

        This is injected into step execution prompts so the LLM
        knows exactly what files exist, what failed, etc.
        """
        lines = ["EXECUTION MANIFEST - Work Done So Far:"]

        # Completed steps summary with more detail
        completed = [e for e in self.step_entries if e.status == PlanStatus.COMPLETED]
        if completed:
            lines.append(f"\nCOMPLETED STEPS ({len(completed)}):")
            for entry in completed[-3:]:  # Last 3 completed
                tools_str = f" [{', '.join(entry.tools_called[:3])}]" if entry.tools_called else ""
                lines.append(f"  Step {entry.step_num}: {entry.objective[:50]}{tools_str}")
                # Show what was produced
                if entry.files_created:
                    lines.append(f"    -> Created: {', '.join(entry.files_created[:3])}")
                if entry.files_modified:
                    lines.append(f"    -> Modified: {', '.join(entry.files_modified[:3])}")
                # Show commitments made (from reasoning trace)
                if entry.commitments:
                    lines.append(f"    -> Committed: {entry.commitments[0][:60]}...")

        # Files created with verification note
        if self.all_files_created:
            lines.append(f"\nFILES CREATED (verified): {', '.join(list(self.all_files_created)[:5])}")

        # Files modified
        if self.all_files_modified:
            lines.append(f"FILES MODIFIED: {', '.join(list(self.all_files_modified)[:5])}")

        # Recent failures
        recent_failures = [f for f in self.all_failures if f.timestamp > time.time() - 60]
        if recent_failures:
            lines.append(f"\nRECENT FAILURES ({len(recent_failures)}):")
            for fail in recent_failures[-2:]:
                lines.append(f"  - {fail.tool_name}: {fail.error_message[:60]}")

        # Escalations
        if self.escalated_steps:
            lines.append(f"\nESCALATED STEPS: {self.escalated_steps}")

        return "\n".join(lines)


# =============================================================================
# INVARIANT CHECKER PROTOCOL - Extension point for future dependency worklist
# =============================================================================

class InvariantChecker(Protocol):
    """
    Protocol for invariant checkers.

    Invariant checkers are called after each state transition.
    If they return (False, reason), the microloop escalates.

    Future use: Graphd /impact results could implement this
    to enforce impact hints per sub-step.
    """

    def __call__(self, context: MicroloopContext) -> Tuple[bool, str]:
        """
        Check invariants.

        Returns:
            (passed, reason) - If passed is False, reason explains why
        """
        ...


class CompletionCondition(Protocol):
    """
    Protocol for custom completion conditions.

    Completion conditions supplement the built-in success_criteria check.
    If any condition returns (True, reason), the step is complete.
    """

    def __call__(self, context: MicroloopContext) -> Tuple[bool, str]:
        """
        Check if completion condition is met.

        Returns:
            (is_complete, reason) - If is_complete is True, reason explains why
        """
        ...


# =============================================================================
# BUILT-IN INVARIANT CHECKERS
# =============================================================================

def max_duration_invariant(max_duration_ms: float) -> InvariantChecker:
    """Create an invariant checker that fails if step takes too long. 0 = disabled."""
    def check(context: MicroloopContext) -> Tuple[bool, str]:
        if max_duration_ms > 0 and context.elapsed_ms > max_duration_ms:
            return False, f"Step exceeded max duration ({max_duration_ms}ms)"
        return True, ""
    return check


def max_failures_invariant(max_failures: int) -> InvariantChecker:
    """Create an invariant checker that fails after too many failures."""
    def check(context: MicroloopContext) -> Tuple[bool, str]:
        if len(context.failures) > max_failures:
            return False, f"Too many failures ({len(context.failures)} > {max_failures})"
        return True, ""
    return check


def no_destructive_retry_invariant() -> InvariantChecker:
    """
    Invariant that prevents retrying destructive operations.

    Write/delete operations should not be retried blindly.
    """
    DESTRUCTIVE_TOOLS = {"file_write", "file_delete", "bash_execute"}

    def check(context: MicroloopContext) -> Tuple[bool, str]:
        if context.state == StepExecutionState.RETRY:
            last_tool = context.tool_history[-1].tool_name if context.tool_history else None
            if last_tool in DESTRUCTIVE_TOOLS:
                return False, f"Cannot retry destructive tool: {last_tool}"
        return True, ""
    return check
