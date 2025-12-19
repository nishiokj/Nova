"""
PolicyGate validates PlanPatches before application.
Enforces version checking, rate limiting, and thrash detection.
"""

import time
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from .plan_state import PlanState
    from .plan_patch import PlanPatch


class PolicyViolation(Enum):
    """Types of policy violations."""

    VERSION_MISMATCH = "version_mismatch"
    MODIFYING_DONE_STEP = "modifying_done_step"
    RATE_LIMITED = "rate_limited"
    THRASH_DETECTED = "thrash_detected"
    INVALID_OPERATION = "invalid_operation"


@dataclass
class PolicyDecision:
    """Result of policy evaluation."""

    approved: bool
    violation: Optional[PolicyViolation] = None
    reason: Optional[str] = None


class PolicyGate:
    """
    Validates PlanPatches before application.

    RULES:
    1. Reject if base_plan_version != current_plan_version
    2. Reject if patch changes DONE (frozen) steps
    3. Rate limit: max N patches per M seconds
    4. Thrash detection: same step modified repeatedly
    """

    def __init__(
        self,
        max_patches_per_window: int = 5,
        window_seconds: float = 60.0,
        thrash_threshold: int = 3,
    ):
        self.max_patches_per_window = max_patches_per_window
        self.window_seconds = window_seconds
        self.thrash_threshold = thrash_threshold

        # Patch history: (timestamp, target_steps)
        self._patch_history: List[Tuple[float, List[int]]] = []

    def evaluate(self, patch: "PlanPatch", plan_state: "PlanState") -> PolicyDecision:
        """
        Evaluate patch against all policies.
        Returns decision with approval status and any violation.
        """
        version_check = self._check_version(patch, plan_state)
        if version_check:
            return PolicyDecision(
                approved=False,
                violation=version_check,
                reason=f"Patch version {patch.base_plan_version} != current {plan_state.version}",
            )

        done_check = self._check_done_steps(patch, plan_state)
        if done_check:
            return PolicyDecision(
                approved=False,
                violation=done_check,
                reason="Cannot modify frozen/completed steps",
            )

        rate_check = self._check_rate_limit()
        if rate_check:
            return PolicyDecision(
                approved=False,
                violation=rate_check,
                reason=f"Rate limited: >{self.max_patches_per_window} patches in {self.window_seconds}s",
            )

        target_steps = [op.target_step for op in patch.operations]
        thrash_check = self._check_thrash(target_steps)
        if thrash_check:
            return PolicyDecision(
                approved=False,
                violation=thrash_check,
                reason="Thrash detected: same step modified repeatedly",
            )

        self._record_patch(target_steps)

        return PolicyDecision(approved=True)

    def _check_version(
        self, patch: "PlanPatch", plan_state: "PlanState"
    ) -> Optional[PolicyViolation]:
        """Check for version mismatch."""
        if patch.base_plan_version != plan_state.version:
            return PolicyViolation.VERSION_MISMATCH
        return None

    def _check_done_steps(
        self, patch: "PlanPatch", plan_state: "PlanState"
    ) -> Optional[PolicyViolation]:
        """Check if patch modifies done/frozen steps."""
        from .plan_patch import PatchType

        for op in patch.operations:
            if op.type == PatchType.INSERT:
                continue

            step = plan_state.steps.get(op.target_step)
            if step and step.is_frozen:
                return PolicyViolation.MODIFYING_DONE_STEP

        return None

    def _check_rate_limit(self) -> Optional[PolicyViolation]:
        """Check if we're over the rate limit."""
        self._clean_old_history()

        if len(self._patch_history) >= self.max_patches_per_window:
            return PolicyViolation.RATE_LIMITED

        return None

    def _check_thrash(self, target_steps: List[int]) -> Optional[PolicyViolation]:
        """Check for thrash pattern (same step modified repeatedly)."""
        self._clean_old_history()

        for step in target_steps:
            count = sum(1 for _, steps in self._patch_history if step in steps)
            if count >= self.thrash_threshold:
                return PolicyViolation.THRASH_DETECTED

        return None

    def _clean_old_history(self) -> None:
        """Remove patches outside the time window."""
        cutoff = time.time() - self.window_seconds
        self._patch_history = [(timestamp, steps) for timestamp, steps in self._patch_history if timestamp > cutoff]

    def _record_patch(self, target_steps: List[int]) -> None:
        """Record a patch for rate limiting and thrash detection."""
        self._patch_history.append((time.time(), target_steps))
