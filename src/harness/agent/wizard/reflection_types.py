"""
Reflection types for the Wizard reflection stage.

This module defines all types used by the WizardReflector component
for post-step reasoning and decision-making.
"""

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Protocol

from .types import (
    ReflectionVerdict,
    ClarificationUrgency,
    FailureCategory,
    GoalType,
    StepPhase,
)


@dataclass
class ReflectionContext:
    """
    Global context available to the reflector.

    This represents everything the Wizard knows that individual
    Workers don't have access to.
    """
    # Goal information
    goal: str
    goal_type: GoalType
    goal_success_criteria: Optional[str] = None

    # Plan state
    total_steps: int = 0
    completed_steps: int = 0
    failed_steps: int = 0
    skipped_steps: int = 0
    remaining_steps: int = 0

    # Accumulated knowledge (list of fact dicts to avoid circular import)
    key_facts: List[Dict[str, Any]] = field(default_factory=list)

    # Execution history
    total_iterations: int = 0
    total_tool_calls: int = 0
    total_llm_calls: int = 0
    elapsed_ms: float = 0.0


@dataclass
class StepContext:
    """Context specific to the current step being reflected on."""
    step_num: int
    objective: str
    tool_hint: Optional[str]
    phase: str
    attempt_count: int
    depends_on: List[int]
    is_required: bool

    # Previous attempts on this step
    previous_errors: List[str] = field(default_factory=list)


@dataclass
class WizardReflectionInput:
    """
    Complete input to the Wizard reflection stage.

    Provides all context needed for the reflector to make
    an informed decision about the step outcome.
    """
    # Global context
    global_context: ReflectionContext

    # Current step
    step_context: StepContext

    # Worker outcome (dict to avoid circular import)
    outcome: Dict[str, Any]

    # All steps for dependency analysis (list of step dicts)
    all_steps: List[Dict[str, Any]] = field(default_factory=list)

    # Recent outcomes for pattern detection
    recent_outcomes: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class ScaffoldedStep:
    """A new step to be inserted into the plan."""
    objective: str
    tool_hint: Optional[str] = None
    phase: str = "execution"
    depends_on: List[int] = field(default_factory=list)
    required: bool = False
    rationale: str = ""  # Why this step is being added


@dataclass
class RedoModifications:
    """Modifications to apply when redoing a step."""
    new_objective: Optional[str] = None
    new_tool_hint: Optional[str] = None
    injected_context: Optional[str] = None
    additional_constraints: List[str] = field(default_factory=list)
    avoid_patterns: List[str] = field(default_factory=list)  # What to NOT do


@dataclass
class ClarificationRequest:
    """
    A request for user clarification.

    Always includes a default assumption to enable auto-proceed.
    """
    question: str
    options: List[str] = field(default_factory=list)
    default_assumption: str = ""  # REQUIRED - what we do if no response
    urgency: ClarificationUrgency = ClarificationUrgency.MEDIUM
    timeout_seconds: int = 60
    context: str = ""  # Additional context for the user

    # Tracking
    step_num: int = 0
    request_id: str = ""
    created_at: float = field(default_factory=time.time)


@dataclass
class ClarificationResponse:
    """User's response to a clarification request."""
    request_id: str
    step_num: int

    # Response content (one of these is populated)
    selected_option: Optional[str] = None  # If user picked an option
    custom_text: Optional[str] = None      # If user typed custom response

    # Metadata
    used_default: bool = False      # True if timed out
    response_time_ms: float = 0.0   # How long user took

    @property
    def answer(self) -> str:
        """Get the actual answer content."""
        if self.custom_text:
            return self.custom_text
        if self.selected_option:
            return self.selected_option
        return ""


@dataclass
class QualityAssessment:
    """Assessment of Worker output quality."""
    overall_score: float = 0.5  # 0.0-1.0

    # Specific assessments
    completeness: float = 0.5      # Did it fully address the objective?
    correctness: float = 0.5       # Is the output correct/bug-free?
    clarity: float = 0.5           # Is the output clear and well-formatted?
    maintainability: float = 0.5   # Is code maintainable?
    actionability: float = 0.5     # Can the user act on this?
    relevance: float = 0.5         # Is it relevant to the goal?

    # Issues detected
    issues: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    # Suggestions
    improvement_suggestions: List[str] = field(default_factory=list)


@dataclass
class WizardReflectionOutput:
    """
    Complete output from the Wizard reflection stage.

    Determines what action the Wizard takes next.
    """
    # Primary decision
    verdict: ReflectionVerdict
    reasoning: str
    confidence: float  # 0.0-1.0

    # Quality assessment (always populated)
    quality: QualityAssessment = field(default_factory=QualityAssessment)

    # For ACCEPT_AND_EXTEND
    scaffolded_steps: List[ScaffoldedStep] = field(default_factory=list)

    # For REDO
    redo_modifications: Optional[RedoModifications] = None

    # For CLARIFY_USER
    clarification: Optional[ClarificationRequest] = None

    # For ABORT_STEP / ABORT_GOAL
    abort_reason: Optional[str] = None
    abort_category: Optional[FailureCategory] = None

    # User-facing message (always populated)
    user_message: str = ""

    # Metadata
    reflection_duration_ms: float = 0.0
    llm_tokens_used: int = 0


# Callback types for wizard integration
OnClarificationNeeded = Callable[[ClarificationRequest], None]
OnProgressUpdate = Callable[[str, int, int], None]  # message, step, total
OnStepCompleted = Callable[[int, str, bool], None]  # step_num, summary, success


class ReflectorProtocol(Protocol):
    """Protocol for the Wizard reflector component."""

    def reflect(
        self,
        input: WizardReflectionInput,
    ) -> WizardReflectionOutput:
        """Reflect on a Worker outcome and decide next action."""
        ...


class ClarificationHandler(Protocol):
    """Protocol for handling user clarification requests."""

    def request_clarification(
        self,
        request: ClarificationRequest,
    ) -> None:
        """Emit a clarification request to the user."""
        ...

    def get_response(
        self,
        request_id: str,
        timeout_ms: int,
    ) -> Optional[ClarificationResponse]:
        """Get user's response to a clarification request."""
        ...
