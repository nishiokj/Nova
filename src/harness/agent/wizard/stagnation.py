"""
Stagnation detection for identifying and handling stuck execution.
Detects retry loops, identical outputs, and global stagnation.
"""

import hashlib
from dataclasses import dataclass
from typing import Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .work_ledger import WorkLedger
    from .worker import WorkerOutcome
    from .plan_state import PlanState
    from .plan_patch import PlanPatch


@dataclass
class StagnationSignal:
    """Signal indicating stagnation detected."""

    detected: bool
    severity: float  # 0.0 to 1.0
    reason: str
    step_num: Optional[int] = None
    suggested_action: str = ""


class StagnationDetector:
    """
    Detects execution stagnation for escalation.

    SIGNALS:
    1. Too many retries on same step
    2. Identical outputs (spinning)
    3. No progress across multiple steps
    """

    def __init__(
        self,
        max_retries_per_step: int = 3,
        max_identical_outputs: int = 3,
        no_progress_threshold: int = 10,
    ):
        self.max_retries_per_step = max_retries_per_step
        self.max_identical_outputs = max_identical_outputs
        self.no_progress_threshold = no_progress_threshold
        self._output_hashes: Dict[int, List[str]] = {}

    def check(
        self, step_num: int, ledger: "WorkLedger", outcome: Optional["WorkerOutcome"] = None
    ) -> StagnationSignal:
        """
        Check for stagnation signals.
        Returns signal if stagnation detected.
        """
        from .work_ledger import EntryStatus

        history = ledger.get_step_history(step_num)
        # Count only COMPLETED or FAILED attempts, not DISPATCHED (in-flight)
        # This prevents off-by-one where the current attempt is counted
        completed_attempts = sum(
            1 for entry in history
            if entry.status in (EntryStatus.COMPLETED, EntryStatus.FAILED)
        )
        if completed_attempts > self.max_retries_per_step:
            return StagnationSignal(
                detected=True,
                severity=0.8,
                reason=f"Step {step_num} failed {completed_attempts} times (max {self.max_retries_per_step})",
                step_num=step_num,
                suggested_action="skip_step",
            )

        if outcome and outcome.final_response:
            # MD5 used for output fingerprinting to detect stagnation, not security
            output_hash = hashlib.md5(outcome.final_response.encode(), usedforsecurity=False).hexdigest()[:8]
            self._output_hashes.setdefault(step_num, []).append(output_hash)
            hashes = self._output_hashes[step_num]
            if len(hashes) >= self.max_identical_outputs:
                recent = hashes[-self.max_identical_outputs :]
                if len(set(recent)) == 1:
                    return StagnationSignal(
                        detected=True,
                        severity=0.9,
                        reason=f"Step {step_num} producing identical outputs",
                        step_num=step_num,
                        suggested_action="pivot_approach",
                    )

        recent = ledger.get_recent_entries(self.no_progress_threshold)
        if len(recent) >= self.no_progress_threshold:
            completed = sum(1 for entry in recent if entry.status == EntryStatus.COMPLETED)
            if completed == 0:
                return StagnationSignal(
                    detected=True,
                    severity=1.0,
                    reason="No steps completed in recent work items",
                    suggested_action="abort_or_simplify",
                )

        return StagnationSignal(detected=False, severity=0.0, reason="")

    def escalate(
        self, signal: StagnationSignal, plan_state: "PlanState"
    ) -> Optional["PlanPatch"]:
        """
        Generate escalation patch based on stagnation signal.
        Returns patch to skip step or add recovery step.
        """
        from .plan_patch import PlanPatch

        if not signal.detected:
            return None

        if signal.suggested_action == "skip_step" and signal.step_num:
            return PlanPatch.create_remove(
                base_version=plan_state.version,
                step_num=signal.step_num,
                justification=f"Stagnation: {signal.reason}",
            )

        return None

    def reset_step(self, step_num: int) -> None:
        """Reset tracking for a step (called on successful completion or skip)."""
        self._output_hashes.pop(step_num, None)

    def cleanup_all(self) -> None:
        """Clear all tracking state (called when orchestration completes)."""
        self._output_hashes.clear()
