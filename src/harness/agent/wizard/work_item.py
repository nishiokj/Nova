"""
Work items are bounded units of work dispatched to Workers.
Each has clear success criteria and resource limits.
"""

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class WorkBounds:
    """Resource bounds for a work unit."""

    max_tool_calls: int = 5
    max_duration_ms: float = 60_000
    max_llm_calls: int = 3


@dataclass
class WorkItemCriteria:
    """Success criteria for a work item."""

    description: str = ""
    required_outputs: List[str] = field(default_factory=list)
    postconditions: List[str] = field(default_factory=list)
    verification_hints: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class WorkItem:
    """
    Bounded work unit dispatched to Worker.

    Workers receive WorkItems and return WorkerOutcomes.
    WorkItems are immutable once created (enforced via frozen=True).
    """

    work_id: str
    step_num: int
    objective: str
    target_paths: list[str]
    # Guidance (not strict requirements)
    tool_hint: Optional[str] = None
    tool_args_hint: Optional[Dict[str, Any]] = None

    # Boundaries
    bounds: WorkBounds = field(default_factory=WorkBounds)
    success_criteria: WorkItemCriteria = field(default_factory=WorkItemCriteria)

    # Context references (not full content) - using tuple for true immutability
    preconditions_met: tuple = field(default_factory=tuple)

    @classmethod
    def from_step_state(
        cls, step: "StepState", bounds: Optional[WorkBounds] = None  # noqa: F821
    ) -> "WorkItem":
        """Create WorkItem from StepState."""
        # Import here to avoid circular dependency (StepState imports WorkItem)

        return cls(
            work_id=str(uuid.uuid4())[:8],
            step_num=step.step_num,
            objective=step.objective,
            tool_hint=step.tool_hint,
            target_paths=step.target_paths,
            bounds=bounds or WorkBounds(),
            success_criteria=WorkItemCriteria(
                description=f"Complete: {step.objective}"
            ),
        )
