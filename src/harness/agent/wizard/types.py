"""
Wizard-specific types and enums.

This module defines all types used by the Wizard orchestration layer.
These are INDEPENDENT of the old harness plan_models - the Wizard is a
self-contained system with its own paradigm.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class StepStatus(Enum):
    """
    Status of a plan step in the Wizard paradigm.

    State machine:
        PENDING -> IN_PROGRESS -> COMPLETED
                              -> FAILED -> PENDING (retry)
                                       -> SKIPPED (give up)
                              -> AWAITING_USER -> PENDING (after response)
        PENDING -> SKIPPED (removed by patch)

    Terminal states: COMPLETED, SKIPPED
    """
    PENDING = "pending"              # Not yet started
    IN_PROGRESS = "in_progress"      # Worker executing
    COMPLETED = "completed"          # Successfully finished (frozen)
    FAILED = "failed"                # Failed, can retry
    SKIPPED = "skipped"              # Permanently skipped (frozen)
    AWAITING_USER = "awaiting_user"  # Blocked on user clarification


class StepPhase(Enum):
    """
    Phase of execution for a step.

    Phases execute in order: DISCOVERY -> EXECUTION -> VERIFICATION
    """
    DISCOVERY = "discovery"      # Information gathering
    EXECUTION = "execution"      # Main work
    VERIFICATION = "verification"  # Validate results


class GoalType(Enum):
    """Type of goal the Wizard is pursuing."""
    TASK = "task"              # Complete a specific task
    QUESTION = "question"      # Answer a question
    EXPLORATION = "exploration"  # Explore/understand something
    MODIFICATION = "modification"  # Modify existing code/files


class ReflectionVerdict(Enum):
    """
    Wizard's verdict after reflecting on a step outcome.

    Ordered by preference - higher options should be more common.
    """
    ACCEPT = "accept"                    # Quality sufficient, proceed
    ACCEPT_AND_EXTEND = "accept_extend"  # Good, scaffold more for excellence
    REDO = "redo"                        # Redo with modifications
    CLARIFY_USER = "clarify_user"        # Need user input (rare)
    ABORT_STEP = "abort_step"            # Skip this step
    ABORT_GOAL = "abort_goal"            # Cannot achieve goal (very rare)


class ClarificationUrgency(Enum):
    """Urgency level for user clarification requests."""
    LOW = "low"           # Can proceed with default after short timeout
    MEDIUM = "medium"     # Should wait for user, but has reasonable default
    HIGH = "high"         # Genuinely needs user input, no good default
    BLOCKING = "blocking"  # Cannot proceed without user input


class FailureCategory(Enum):
    """Category of step failure for triage."""
    INFRASTRUCTURE = "infrastructure"  # Network, API, timeout errors
    SEMANTIC = "semantic"              # Wrong approach, misunderstanding
    CONTEXT = "context"                # Missing information
    CAPABILITY = "capability"          # Task beyond current abilities
    USER_INPUT = "user_input"          # Needs user decision


class DependencyType:
    """
    Dependency types for step prerequisites.

    Using class constants instead of Enum for simpler serialization.
    """
    HARD = "hard"  # Must be COMPLETED (SKIPPED blocks)
    SOFT = "soft"  # Can be COMPLETED or SKIPPED


@dataclass
class StepDependency:
    """A dependency on another step with type classification."""
    step_num: int
    dep_type: str = DependencyType.SOFT


@dataclass
class SuccessCriteria:
    """Criteria for determining if a step or goal succeeded."""
    description: str
    required_outputs: List[str] = field(default_factory=list)
    postconditions: List[str] = field(default_factory=list)
    verification_hints: List[str] = field(default_factory=list)


@dataclass
class WizardStep:
    """
    A single step in a Wizard plan.

    This is the IMMUTABLE definition of what needs to be done.
    Runtime state is tracked in StepState.
    """
    step_num: int
    objective: str  # What this step should accomplish
    phase: StepPhase = StepPhase.EXECUTION

    # Dependencies
    depends_on: List[int] = field(default_factory=list)

    # Hints for execution
    tool_hint: Optional[str] = None
    context_hints: List[str] = field(default_factory=list)

    # Target paths - explicit files mentioned by user (via @path or extracted)
    # These are FULL paths, not just leaf filenames
    target_paths: List[str] = field(default_factory=list)

    # Success criteria
    success_criteria: Optional[SuccessCriteria] = None

    # Flags
    required: bool = False  # If True, cannot be skipped for goal_achieved

    # Initial status (usually PENDING)
    status: StepStatus = StepStatus.PENDING


@dataclass
class WizardPlan:
    """
    A plan created by the Planner for the Wizard to execute.

    This is the initial plan - the Wizard will create PlanState from this
    and may modify it via patches during execution.
    """
    goal: str
    goal_type: GoalType
    steps: List[WizardStep]

    # Success criteria for the overall goal
    success_criteria: Optional[SuccessCriteria] = None

    # Metadata
    reasoning: str = ""
    estimated_complexity: str = "medium"  # low, medium, high
    requires_tools: List[str] = field(default_factory=list)


@dataclass
class WizardReflection:
    """
    Reflection on goal achievement after Wizard execution.

    Used in WizardResult.to_agent_response() for compatibility.
    """
    plan_goal: str
    goal_achieved: bool
    confidence: float  # 0.0 to 1.0

    # Evidence and gaps
    evidence: List[str] = field(default_factory=list)
    gaps: List[str] = field(default_factory=list)

    # Suggestions for improvement
    suggestions: List[str] = field(default_factory=list)

    # Summary
    summary: str = ""


@dataclass
class ToolCallRecord:
    """Record of a tool call made during execution."""
    tool_name: str
    arguments: Dict[str, Any]
    result: Optional[str] = None
    success: bool = True
    duration_ms: float = 0.0
    error: Optional[str] = None


def convert_plan_to_wizard_plan(plan: Any) -> WizardPlan:
    """
    Convert a duck-typed plan object to WizardPlan.

    Accepts any object with:
    - goal: str
    - goal_type: str or GoalType
    - steps: List with step_num, objective, depends_on, etc.

    This allows interop with legacy Plan objects without importing them.
    """
    # Convert goal_type
    goal_type_raw = getattr(plan, "goal_type", "task")
    if isinstance(goal_type_raw, GoalType):
        goal_type = goal_type_raw
    elif isinstance(goal_type_raw, str):
        try:
            goal_type = GoalType(goal_type_raw.lower())
        except ValueError:
            goal_type = GoalType.TASK
    else:
        goal_type = GoalType.TASK

    # Convert steps
    wizard_steps: List[WizardStep] = []
    for step in getattr(plan, "steps", []):
        # Handle phase conversion
        phase_raw = getattr(step, "phase", "execution")
        if isinstance(phase_raw, StepPhase):
            phase = phase_raw
        elif hasattr(phase_raw, "value"):
            # It's an enum from another module
            try:
                phase = StepPhase(phase_raw.value)
            except ValueError:
                phase = StepPhase.EXECUTION
        elif isinstance(phase_raw, str):
            try:
                phase = StepPhase(phase_raw.lower())
            except ValueError:
                phase = StepPhase.EXECUTION
        else:
            phase = StepPhase.EXECUTION

        # Handle status conversion
        status_raw = getattr(step, "status", "pending")
        if isinstance(status_raw, StepStatus):
            status = status_raw
        elif hasattr(status_raw, "value"):
            try:
                status = StepStatus(status_raw.value)
            except ValueError:
                status = StepStatus.PENDING
        elif isinstance(status_raw, str):
            try:
                status = StepStatus(status_raw.lower())
            except ValueError:
                status = StepStatus.PENDING
        else:
            status = StepStatus.PENDING

        wizard_step = WizardStep(
            step_num=getattr(step, "step_num", 0),
            objective=getattr(step, "objective", ""),
            phase=phase,
            depends_on=list(getattr(step, "depends_on", [])),
            tool_hint=getattr(step, "tool_hint", None),
            required=getattr(step, "required", False),
            status=status,
        )
        wizard_steps.append(wizard_step)

    # Handle requires_tools: Plan uses bool, WizardPlan uses List[str]
    requires_tools_raw = getattr(plan, "requires_tools", [])
    if isinstance(requires_tools_raw, bool):
        # If bool, infer tool list from step tool_hints
        requires_tools = [
            s.tool_hint for s in wizard_steps
            if s.tool_hint
        ] if requires_tools_raw else []
    else:
        requires_tools = list(requires_tools_raw)

    return WizardPlan(
        goal=getattr(plan, "goal", ""),
        goal_type=goal_type,
        steps=wizard_steps,
        reasoning=getattr(plan, "reasoning", ""),
        estimated_complexity=getattr(plan, "estimated_complexity", "medium"),
        requires_tools=requires_tools,
    )
