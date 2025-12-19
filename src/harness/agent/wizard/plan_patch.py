"""
Plan patches are bounded mutations to FUTURE steps only.
All patches must pass through PolicyGate before application.
"""

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class PatchType(Enum):
    """
    Types of plan mutations.

    Implementation Status:
    - INSERT: ✅ Implemented - Add new step with insert_after ordering
    - REPLACE: ✅ Implemented - Replace step objective/tool_hint
    - REMOVE: ✅ Implemented - Mark pending step as SKIPPED
    - REORDER: ⏳ Not implemented - Silent no-op
    - SPLIT: ⏳ Not implemented - Silent no-op
    """

    INSERT = "insert"  # Add new step
    REPLACE = "replace"  # Replace step objective/hints
    REORDER = "reorder"  # Change step order (NOT IMPLEMENTED)
    SPLIT = "split"  # Split one step into multiple (NOT IMPLEMENTED)
    REMOVE = "remove"  # Remove pending step


@dataclass
class PatchOperation:
    """Single operation within a patch."""

    type: PatchType
    target_step: int  # Step being modified (or insert_after for INSERT)

    # For INSERT
    new_step: Optional[Dict[str, Any]] = None
    insert_after: Optional[int] = None

    # For REPLACE
    new_objective: Optional[str] = None
    new_tool_hint: Optional[str] = None

    # For REORDER
    new_position: Optional[int] = None

    # For SPLIT
    sub_steps: Optional[List[Dict[str, Any]]] = None


@dataclass
class PlanPatch:
    """
    Proposed modification to plan.
    Must pass PolicyGate before application.
    """

    patch_id: str
    base_plan_version: int  # Version this patch was created against

    operations: List[PatchOperation] = field(default_factory=list)

    justification: str = ""
    risk_flags: List[str] = field(default_factory=list)

    # Source tracking
    suggested_by_worker: Optional[str] = None
    suggested_at: float = field(default_factory=time.time)

    @classmethod
    def create_insert(
        cls,
        base_version: int,
        objective: str,
        tool_hint: Optional[str] = None,
        insert_after: int = -1,
        justification: str = "",
        worker_id: Optional[str] = None,
    ) -> "PlanPatch":
        """Create a patch that inserts a new step."""
        return cls(
            patch_id=str(uuid.uuid4())[:8],
            base_plan_version=base_version,
            operations=[
                PatchOperation(
                    type=PatchType.INSERT,
                    target_step=insert_after,
                    new_step={
                        "objective": objective,
                        "tool_hint": tool_hint,
                        "phase": "execution",
                    },
                    insert_after=insert_after,
                )
            ],
            justification=justification,
            suggested_by_worker=worker_id,
        )

    @classmethod
    def create_remove(
        cls,
        base_version: int,
        step_num: int,
        justification: str = "",
        worker_id: Optional[str] = None,
    ) -> "PlanPatch":
        """Create a patch that removes a pending step."""
        return cls(
            patch_id=str(uuid.uuid4())[:8],
            base_plan_version=base_version,
            operations=[
                PatchOperation(
                    type=PatchType.REMOVE,
                    target_step=step_num,
                )
            ],
            justification=justification,
            suggested_by_worker=worker_id,
        )
