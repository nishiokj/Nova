"""
Versioned, single-writer plan state.
Only the Wizard may modify plan state. Steps become frozen once DONE.
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, TYPE_CHECKING

from .types import (
    StepStatus,
    StepPhase,
    WizardPlan,
    WizardStep,
    DependencyType,
    StepDependency,
)

if TYPE_CHECKING:
    from .plan_patch import PlanPatch
    from .plan_patch import PatchOperation  # pragma: no cover - type checking only


@dataclass
class StepState:
    """Runtime state for a single step."""

    step_num: int
    status: StepStatus
    objective: str  # IMMUTABLE - never mutated after creation
    tool_hint: Optional[str]
    depends_on: List[int]  # Legacy: step nums (treated as soft deps)
    phase: StepPhase

    # Typed dependencies (replaces depends_on for new steps)
    typed_deps: List[StepDependency] = field(default_factory=list)

    # Target paths - explicit files to operate on (FULL paths, not leaf names)
    # Worker will auto-read these at start
    target_paths: List[str] = field(default_factory=list)

    # Lifecycle
    is_frozen: bool = False  # True when DONE - cannot be modified
    started_at: Optional[float] = None
    completed_at: Optional[float] = None

    # Worker tracking
    worker_id: Optional[str] = None
    outcome_summary: Optional[str] = None

    # Attempt tracking (survives ledger eviction - authoritative source)
    attempt_count: int = 0
    last_error: Optional[str] = None

    # Clarification tracking
    clarification_request_id: Optional[str] = None

    # Redo overrides (objective remains immutable)
    override_objective: Optional[str] = None

    # Scaffolding metadata
    scaffolded_from: Optional[int] = None
    scaffold_depth: int = 0

    # Ordering: explicit position for correct execution order
    position: float = 0.0  # Lower = earlier in execution order

    # Required flag: if True, cannot be skipped for goal_achieved
    required: bool = False

    @classmethod
    def from_wizard_step(cls, step: WizardStep) -> "StepState":
        """Create StepState from WizardStep definition."""
        # Convert depends_on to typed_deps (all soft by default)
        typed_deps = [
            StepDependency(step_num=dep, dep_type=DependencyType.SOFT)
            for dep in step.depends_on
        ]
        return cls(
            step_num=step.step_num,
            status=step.status,
            objective=step.objective,
            tool_hint=step.tool_hint,
            depends_on=list(step.depends_on),
            phase=step.phase,
            typed_deps=typed_deps,
            target_paths=list(step.target_paths) if step.target_paths else [],
            position=float(step.step_num),  # Initial position from step_num
            required=step.required,
            scaffold_depth=0,
        )


@dataclass
class PlanState:
    """
    Single-writer global plan state owned by Wizard.

    INVARIANTS:
    - version increments on every modification
    - frozen steps cannot be modified
    - only FUTURE steps can be patched
    """

    plan_id: str
    version: int
    goal: str
    goal_type: str
    steps: Dict[int, StepState]

    # Phase tracking
    discovery_complete: bool = False
    execution_complete: bool = False

    # Timestamps
    created_at: float = field(default_factory=time.time)
    last_modified: float = field(default_factory=time.time)

    @classmethod
    def from_wizard_plan(cls, plan: WizardPlan) -> "PlanState":
        """Create PlanState from WizardPlan."""
        steps = {s.step_num: StepState.from_wizard_step(s) for s in plan.steps}
        return cls(
            plan_id=str(uuid.uuid4()),
            version=1,
            goal=plan.goal,
            goal_type=plan.goal_type.value if hasattr(plan.goal_type, 'value') else str(plan.goal_type),
            steps=steps,
        )

    # Statuses that satisfy SOFT dependencies
    SOFT_DEP_SATISFIED_STATUSES = frozenset({
        StepStatus.COMPLETED,
        StepStatus.SKIPPED,
    })

    # Statuses that satisfy HARD dependencies (SKIPPED does NOT satisfy)
    HARD_DEP_SATISFIED_STATUSES = frozenset({
        StepStatus.COMPLETED,
    })

    def get_ready_steps(self) -> List[StepState]:
        """
        Get steps whose dependencies are satisfied and status is PENDING.
        Returns steps sorted by position (lower = earlier).

        Dependency semantics:
        - HARD deps: must be COMPLETED (SKIPPED blocks the step)
        - SOFT deps: can be COMPLETED or SKIPPED
        """
        ready: List[StepState] = []
        for step in self.steps.values():
            if step.status != StepStatus.PENDING:
                continue
            if step.is_frozen:
                continue

            deps_satisfied = self._check_dependencies_satisfied(step)
            if deps_satisfied:
                ready.append(step)

        # Sort by position for deterministic execution order
        ready.sort(key=lambda s: s.position)
        return ready

    def _check_dependencies_satisfied(self, step: StepState) -> bool:
        """
        Check if all dependencies for a step are satisfied.
        Uses typed_deps if available, falls back to depends_on (treated as soft).
        """
        # If we have typed_deps, use those
        if step.typed_deps:
            for dep in step.typed_deps:
                dep_step = self.steps.get(dep.step_num)
                if dep_step is None:
                    return False  # Missing dependency

                if dep.dep_type == DependencyType.HARD:
                    if dep_step.status not in self.HARD_DEP_SATISFIED_STATUSES:
                        return False
                else:  # SOFT
                    if dep_step.status not in self.SOFT_DEP_SATISFIED_STATUSES:
                        return False
            return True

        # Legacy: use depends_on as soft deps
        for dep_num in step.depends_on:
            dep_step = self.steps.get(dep_num)
            if dep_step is None:
                return False
            if dep_step.status not in self.SOFT_DEP_SATISFIED_STATUSES:
                return False
        return True

    def can_modify_step(self, step_num: int) -> bool:
        """Only PENDING steps that are not frozen can be modified."""
        step = self.steps.get(step_num)
        if step is None:
            return False
        return not step.is_frozen and step.status == StepStatus.PENDING

    def freeze_step(self, step_num: int) -> None:
        """
        Mark step as frozen (DONE). Cannot be undone.
        Does NOT set completed_at - callers must set that before freezing.
        """
        step = self.steps.get(step_num)
        if step:
            step.is_frozen = True
            # Ensure completed_at is set (defensive - callers should set it)
            if step.completed_at is None:
                step.completed_at = time.time()

    def mark_step_in_progress(self, step_num: int, worker_id: str) -> None:
        """Mark step as IN_PROGRESS with worker assignment."""
        step = self.steps.get(step_num)
        if step and self.can_modify_step(step_num):
            step.status = StepStatus.IN_PROGRESS
            step.worker_id = worker_id
            step.started_at = time.time()
            step.attempt_count += 1  # Increment on each attempt
            self._bump_version()

    def mark_step_complete(self, step_num: int, outcome_summary: str) -> None:
        """Mark step as COMPLETED and freeze it."""
        step = self.steps.get(step_num)
        if step:
            step.status = StepStatus.COMPLETED
            step.outcome_summary = outcome_summary
            step.completed_at = time.time()
            self.freeze_step(step_num)
            self._bump_version()

    def mark_step_failed(self, step_num: int, error: str) -> None:
        """Mark step as FAILED (can be retried)."""
        step = self.steps.get(step_num)
        if step:
            step.status = StepStatus.FAILED
            step.outcome_summary = f"FAILED: {error}"
            step.last_error = error
            step.worker_id = None  # Clear worker assignment
            self._bump_version()

    def mark_step_skipped(self, step_num: int, reason: str) -> None:
        """
        Mark step as SKIPPED (permanently giving up).
        SKIPPED satisfies dependencies so downstream steps can proceed.
        """
        step = self.steps.get(step_num)
        if step:
            step.status = StepStatus.SKIPPED
            step.outcome_summary = f"SKIPPED: {reason}"
            step.completed_at = time.time()
            self.freeze_step(step_num)
            self._bump_version()

    def mark_step_awaiting_user(self, step_num: int, request_id: str) -> None:
        """Mark step as AWAITING_USER with clarification request ID."""
        step = self.steps.get(step_num)
        if step and not step.is_frozen:
            step.status = StepStatus.AWAITING_USER
            step.clarification_request_id = request_id
            self._bump_version()

    def reset_step_for_retry(
        self,
        step_num: int,
        last_error: Optional[str] = None,
    ) -> bool:
        """
        Reset a FAILED/IN_PROGRESS/AWAITING_USER step back to PENDING for retry.
        Returns True if reset was successful.
        """
        step = self.steps.get(step_num)
        if step is None:
            return False
        if step.is_frozen:
            return False
        if step.status not in (StepStatus.FAILED, StepStatus.IN_PROGRESS, StepStatus.AWAITING_USER):
            return False

        step.status = StepStatus.PENDING
        step.worker_id = None
        step.started_at = None
        step.outcome_summary = None
        step.clarification_request_id = None
        if last_error is not None:
            step.last_error = last_error
        self._bump_version()
        return True

    def set_override_objective(self, step_num: int, objective: Optional[str]) -> bool:
        """Set or clear a redo override objective for a step."""
        step = self.steps.get(step_num)
        if step is None or step.is_frozen:
            return False
        step.override_objective = objective
        self._bump_version()
        return True

    def set_step_tool_hint(self, step_num: int, tool_hint: Optional[str]) -> bool:
        """Update a step's tool hint."""
        step = self.steps.get(step_num)
        if step is None or step.is_frozen:
            return False
        step.tool_hint = tool_hint
        self._bump_version()
        return True

    def apply_patch(self, patch: "PlanPatch") -> bool:
        """
        Apply patch atomically with version check.
        Returns True if successful, False if rejected.

        Rejection reasons:
        - Version mismatch
        - Contains unimplemented patch types (REORDER, SPLIT)
        - Targets non-modifiable steps (except INSERT)
        """
        from .plan_patch import PatchType

        if patch.base_plan_version != self.version:
            return False

        # Phase 1: Validate all operations
        for op in patch.operations:
            # Reject unimplemented patch types immediately
            if op.type in (PatchType.REORDER, PatchType.SPLIT):
                return False  # Not implemented - reject, don't silent no-op

            # For non-INSERT ops, check if target step is modifiable
            if op.type != PatchType.INSERT:
                if not self.can_modify_step(op.target_step):
                    return False

        # Phase 2: Apply all operations
        for op in patch.operations:
            self._apply_operation(op)

        self._bump_version()
        return True

    def _apply_operation(self, op: "PatchOperation") -> None:
        """
        Apply a single patch operation.

        Supported operations:
        - INSERT: Add new step with explicit position ordering
        - REPLACE: Only tool_hint changes (objective is IMMUTABLE)
        - REMOVE: Mark step SKIPPED and freeze it properly

        REORDER and SPLIT are rejected in apply_patch(), never reach here.
        """
        from .plan_patch import PatchType

        if op.type == PatchType.INSERT and op.new_step:
            # Assign step number (unique identifier, NOT order)
            next_num = max(self.steps.keys(), default=0) + 1

            # Calculate position for ordering
            if op.insert_after is not None and op.insert_after >= 0:
                after_step = self.steps.get(op.insert_after)
                if after_step:
                    # Position between insert_after and next step
                    higher_positions = [
                        s.position for s in self.steps.values()
                        if s.position > after_step.position
                    ]
                    if higher_positions:
                        next_position = (after_step.position + min(higher_positions)) / 2
                    else:
                        next_position = after_step.position + 1.0
                else:
                    next_position = float(next_num)
            else:
                # Append at end: position after all existing steps
                max_position = max((s.position for s in self.steps.values()), default=0.0)
                next_position = max_position + 1.0

            # Build typed dependencies
            depends_on_raw = op.new_step.get("depends_on", [])
            valid_depends = [d for d in depends_on_raw if d in self.steps]
            typed_deps = [
                StepDependency(
                    step_num=d,
                    dep_type=op.new_step.get("dep_type", DependencyType.SOFT)
                )
                for d in valid_depends
            ]

            new_state = StepState(
                step_num=next_num,
                status=StepStatus.PENDING,
                objective=op.new_step.get("objective", ""),
                tool_hint=op.new_step.get("tool_hint"),
                depends_on=valid_depends,
                phase=StepPhase(op.new_step.get("phase", "execution")),
                typed_deps=typed_deps,
                position=next_position,
                required=op.new_step.get("required", False),
                scaffolded_from=op.new_step.get("scaffolded_from"),
                scaffold_depth=op.new_step.get("scaffold_depth", 0),
            )
            self.steps[next_num] = new_state

        elif op.type == PatchType.REPLACE and op.target_step in self.steps:
            # REPLACE: Only tool_hint can be changed (objective is IMMUTABLE)
            step = self.steps[op.target_step]
            # Intentionally DO NOT mutate objective - it's immutable
            # if op.new_objective: step.objective = op.new_objective  # REMOVED
            if op.new_tool_hint is not None:
                step.tool_hint = op.new_tool_hint

        elif op.type == PatchType.REMOVE and op.target_step in self.steps:
            # REMOVE: Mark SKIPPED and freeze properly
            step = self.steps[op.target_step]
            if step.status == StepStatus.PENDING and not step.is_frozen:
                step.status = StepStatus.SKIPPED
                step.outcome_summary = "SKIPPED: Removed by patch"
                step.completed_at = time.time()
                step.is_frozen = True  # Terminal state - freeze it

        # REORDER and SPLIT are rejected in apply_patch(), never reach here

    def _bump_version(self) -> None:
        """Increment version and update timestamp."""
        self.version += 1
        self.last_modified = time.time()

    def clear_in_progress(self, step_num: int) -> None:
        """
        Clear IN_PROGRESS state without marking success/failure.
        Used in finally blocks to ensure steps don't stay stuck IN_PROGRESS.
        Marks as FAILED with error for retry logic.
        """
        step = self.steps.get(step_num)
        if step and step.status == StepStatus.IN_PROGRESS:
            error_msg = "Interrupted: cleared from IN_PROGRESS"
            step.status = StepStatus.FAILED
            step.outcome_summary = error_msg
            step.last_error = error_msg  # Set for retry decision logic
            step.worker_id = None
            self._bump_version()

    def is_terminated(self) -> bool:
        """
        Check if all steps have reached a terminal state.
        This does NOT mean the goal was achieved - just that we're done trying.

        Terminal states: COMPLETED, SKIPPED
        Non-terminal states: PENDING, IN_PROGRESS, FAILED
        """
        return all(
            s.status in (StepStatus.COMPLETED, StepStatus.SKIPPED)
            for s in self.steps.values()
        )

    def goal_achieved(self) -> bool:
        """
        Check if the goal was actually achieved.

        Returns True only if:
        - All steps are terminal (is_terminated)
        - All REQUIRED steps are COMPLETED (not SKIPPED)

        If no steps are marked required, falls back to:
        - At least one step COMPLETED
        """
        if not self.is_terminated():
            return False

        required_steps = [s for s in self.steps.values() if s.required]

        if required_steps:
            # All required steps must be COMPLETED
            return all(s.status == StepStatus.COMPLETED for s in required_steps)
        else:
            # No required steps: at least one must be COMPLETED
            return any(s.status == StepStatus.COMPLETED for s in self.steps.values())

    def is_complete(self) -> bool:
        """
        DEPRECATED: Use is_terminated() or goal_achieved() instead.
        Kept for backwards compatibility - returns is_terminated().
        """
        return self.is_terminated()

    def get_stuck_steps(self) -> List[StepState]:
        """
        Get steps that are stuck (IN_PROGRESS too long or FAILED).
        Used for deadlock detection.
        """
        stuck: List[StepState] = []
        now = time.time()
        for step in self.steps.values():
            if step.status == StepStatus.IN_PROGRESS:
                # Stuck if IN_PROGRESS for > 5 minutes
                if step.started_at and (now - step.started_at) > 300:
                    stuck.append(step)
            elif step.status == StepStatus.FAILED:
                stuck.append(step)
        return stuck
