"""
Shared data models for the Plan → Execute → Reflect architecture.

This module intentionally contains no logging. Logging is handled by the Agent.
"""

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from util.llm_adapter import Message
from .tool_registry import ToolResult


@dataclass
class ToolCallRecord:
    """Record of a single tool call made during step execution"""
    tool_name: str
    arguments: Dict[str, Any]
    result: ToolResult
    duration_ms: float
    timestamp: float


@dataclass
class StepContext:
    """
    Accumulated context during step execution.

    A step may involve multiple tool calls and reasoning rounds.
    This captures everything that happened within the step.
    """
    tool_calls_made: List[ToolCallRecord] = field(default_factory=list)
    tool_results: Dict[str, Any] = field(default_factory=dict)  # tool_name -> last result
    intermediate_reasoning: List[str] = field(default_factory=list)
    validation_checks: Dict[str, bool] = field(default_factory=dict)
    accumulated_data: Dict[str, Any] = field(default_factory=dict)  # Step's working memory

    def add_tool_result(self, tool_name: str, result: ToolResult):
        """Store tool result for this step"""
        self.tool_results[tool_name] = result

        # Could extract structured data based on tool type
        if result.is_success and result.output:
            # Store in accumulated_data with a key based on tool name
            key = f"{tool_name}_output"
            if key not in self.accumulated_data:
                self.accumulated_data[key] = []
            self.accumulated_data[key].append(result.output)

    def has_required_data(self, required: List[str]) -> bool:
        """Check if step has all required data in accumulated_data"""
        return all(key in self.accumulated_data for key in required)


@dataclass
class ValidationResult:
    """Result of validating a step's success criteria"""
    passed: bool
    details: str
    confidence: float = 1.0


class PlanStatus(Enum):
    """Status of a plan or step"""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    PARTIAL = "partial"
    SKIPPED = "skipped"  # Dependencies failed or step could not execute


class PlanPhase(Enum):
    """Execution phase for a plan step"""
    DISCOVERY = "discovery"
    EXECUTION = "execution"


@dataclass
class SuccessCriteria:
    """Defines what success looks like for a step or plan"""
    description: str                      # Human-readable success condition
    required_outputs: List[str] = field(default_factory=list)  # What must be produced
    validation_hints: List[str] = field(default_factory=list)  # How to validate
    automated_checks: Optional[Dict[str, Any]] = None  # Automated validation config


@dataclass
class StepResult:
    """
    Result from executing a single step.

    Returned by Executor - does NOT mutate the original PlanStep.
    Agent interprets this result and updates plan state accordingly.
    """
    step_num: int
    status: PlanStatus
    tool_calls_made: List[ToolCallRecord] = field(default_factory=list)
    llm_messages: List[Message] = field(default_factory=list)  # Messages to append to conversation
    accumulated_data: Dict[str, Any] = field(default_factory=dict)  # Step's working memory
    final_response: Optional[str] = None  # If step generated final response
    error: Optional[str] = None  # Error message if step failed
    duration_ms: float = 0
    phase: PlanPhase = PlanPhase.EXECUTION
    context: Optional[StepContext] = None

    # Validation results (can be filled by Agent after executor returns)
    validation_passed: bool = False
    validation_details: Optional[str] = None


@dataclass
class PlanStep:
    """
    A single step in an execution plan.

    A step is a unit of work (sub-goal), not a single tool call.
    It may involve 0-N tool calls plus reasoning to achieve its objective.

    EXPLICIT UNCERTAINTY AND VERIFICATION:
    - Discovery steps reduce specific uncertainties
    - Execution steps have verifiable pre/postconditions
    """
    step_num: int
    objective: str                        # What this step should accomplish

    # Guidance (not strict requirements)
    tool_hint: Optional[str] = None       # Suggested primary tool
    tool_args_hint: Optional[Dict] = None # Suggested arguments

    # Step boundaries and validation
    success_criteria: Optional[SuccessCriteria] = None
    max_tool_calls: int = 3               # Safety limit per step (reduced from 10)
    depends_on: List[int] = field(default_factory=list)  # Step dependencies
    phase: PlanPhase = PlanPhase.EXECUTION              # Discovery vs execution phase

    # UNCERTAINTY REDUCTION (for discovery steps)
    uncertainties_targeted: List[str] = field(default_factory=list)  # Which uncertainties this reduces
    expected_uncertainty_reduction: float = 0.0  # Expected entropy reduction (0.0-1.0)
    actual_uncertainty_reduction: float = 0.0    # Actual reduction achieved

    # PRE/POSTCONDITIONS (for execution steps)
    preconditions: List[str] = field(default_factory=list)   # Must be true before this step
    postconditions: List[str] = field(default_factory=list)  # Will be true after this step
    verification_method: Optional[str] = None  # How to verify postconditions met

    # Execution state (filled during execution)
    status: PlanStatus = PlanStatus.PENDING
    context: Optional[StepContext] = None  # Accumulated context during execution
    error: Optional[str] = None
    duration_ms: float = 0
    started_at: Optional[float] = None
    completed_at: Optional[float] = None

    # Validation results
    validation_passed: bool = False
    validation_details: Optional[str] = None

    @property
    def result(self) -> Optional[Any]:
        """Convenience property - step's accumulated data"""
        return self.context.accumulated_data if self.context else None


@dataclass
class Plan:
    """
    An explicit execution plan created before running.

    Key difference from current approach: we know WHAT we're trying to do
    and HOW we'll know if we succeeded BEFORE we start.

    TWO-PHASE ARCHITECTURE (Epistemic → Instrumental):
    - Phase A (Discovery/Triage): Reduce uncertainty through observation
    - Phase B (Execution): Take minimal actions with verification gates
    """
    goal: str                             # The user's actual goal
    goal_type: str                        # "question", "task", "creation", "search"
    steps: List[PlanStep]                 # Ordered steps to achieve goal
    success_criteria: SuccessCriteria     # How we know the whole plan succeeded
    estimated_complexity: str             # "simple", "standard", "advanced"
    requires_tools: bool                  # Does this need external tools?
    reasoning: str                        # Why this plan
    discovery_plan: List[PlanStep] = field(default_factory=list)
    execution_plan: List[PlanStep] = field(default_factory=list)
    discovery_required: bool = True
    assumptions: List[str] = field(default_factory=list)

    # EXPLICIT UNCERTAINTY TRACKING (Phase A)
    user_intent: str = ""                 # Explicitly modeled user intent
    uncertainties: List[str] = field(default_factory=list)  # What we don't know
    uncertainty_threshold: float = 0.2    # Max acceptable uncertainty before execution (0.0-1.0)
    current_uncertainty: float = 1.0      # Current uncertainty level

    # PRE/POSTCONDITIONS
    preconditions: List[str] = field(default_factory=list)   # Must be true before execution
    postconditions: List[str] = field(default_factory=list)  # Will be true after completion

    # PHASE TRACKING
    triage_complete: bool = False         # Has Phase A (discovery) completed?
    triage_summary: Optional[str] = None  # What did we learn in discovery?

    # Metadata
    created_at: float = field(default_factory=time.time)
    status: PlanStatus = PlanStatus.PENDING

    def to_dict(self) -> Dict[str, Any]:
        return {
            "goal": self.goal,
            "goal_type": self.goal_type,
            "user_intent": self.user_intent,
            "steps": [
                {
                    "step_num": s.step_num,
                    "objective": s.objective,
                    "tool_hint": s.tool_hint,
                    "status": s.status.value,
                    "phase": s.phase.value
                }
                for s in self.steps
            ],
            "success_criteria": self.success_criteria.description,
            "complexity": self.estimated_complexity,
            "requires_tools": self.requires_tools,
            "discovery_required": self.discovery_required,
            "triage_complete": self.triage_complete,
            "assumptions": self.assumptions,
            "uncertainties": self.uncertainties,
            "uncertainty_threshold": self.uncertainty_threshold,
            "current_uncertainty": self.current_uncertainty,
            "preconditions": self.preconditions,
            "postconditions": self.postconditions
        }


@dataclass
class ExecutionTrace:
    """Record of what happened during execution"""
    plan: Plan
    step_results: List[StepResult] = field(default_factory=list)  # Results from executor
    llm_calls: int = 0
    tool_calls: int = 0
    tool_failures: int = 0
    final_response: Optional[str] = None
    total_duration_ms: float = 0

    # Legacy accessor for backwards compatibility during migration
    @property
    def steps_executed(self) -> List[StepResult]:
        """Alias for step_results - for backwards compatibility"""
        return self.step_results

    @property
    def had_failures(self) -> bool:
        return self.tool_failures > 0

    @property
    def all_steps_succeeded(self) -> bool:
        """Check if all steps completed successfully (SKIPPED steps are acceptable)."""
        return all(
            s.status in (PlanStatus.COMPLETED, PlanStatus.PARTIAL, PlanStatus.SKIPPED)
            for s in self.step_results
        )


@dataclass
class Reflection:
    """Post-execution evaluation with RL labels"""
    plan_goal: str
    goal_achieved: bool                   # Did we actually accomplish the goal?
    confidence: float                     # 0-1 confidence in assessment (now called reflection_confidence)
    evidence: List[str]                   # Why we think goal was/wasn't achieved
    gaps: List[str]                       # What's missing
    suggestions: List[str]                # What could be done differently
    should_retry: bool = False            # Should we try again with different approach?

    # RL-specific labels
    had_tool_failures: bool = False
    reward: float = 0.0
    plan_quality: float = 0.0
    execution_quality: float = 0.0
    response_quality: float = 0.0

    def to_rl_labels(self) -> Dict[str, Any]:
        """Convert to RL labels dict for logging"""
        return {
            "goal_achieved": self.goal_achieved,
            "reflection_confidence": self.confidence,
            "had_tool_failures": self.had_tool_failures,
            "reward": self.reward,
            "plan_quality": self.plan_quality,
            "execution_quality": self.execution_quality,
            "response_quality": self.response_quality,
            "gaps": self.gaps,
            "suggested_improvements": self.suggestions
        }
