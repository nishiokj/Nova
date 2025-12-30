"""
Append-only work ledger for audit trail and debugging.
All worker dispatches and outcomes are recorded permanently.
"""

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .work_item import WorkItem
    from .worker import WorkerOutcome


class EntryStatus(Enum):
    """Status of a ledger entry."""

    PENDING = "pending"
    DISPATCHED = "dispatched"
    COMPLETED = "completed"
    FAILED = "failed"


class PatchDecision(Enum):
    """Decision made on a patch."""

    APPROVED = "approved"
    REJECTED = "rejected"


@dataclass
class PatchRecord:
    """
    Record of a patch lifecycle: propose → decision → apply.
    Used for debugging plan thrash and understanding plan evolution.
    """

    patch_id: str
    proposed_at: float
    source: str  # "worker", "stagnation", "user"
    patch_type: str  # "insert", "remove", "replace", etc.
    target_steps: List[int]
    justification: str

    # Decision phase
    decision: Optional[PatchDecision] = None
    decision_at: Optional[float] = None
    rejection_reason: Optional[str] = None

    # Apply phase
    applied: bool = False
    applied_at: Optional[float] = None
    resulting_version: Optional[int] = None


@dataclass
class LedgerEntry:
    """Single entry in the append-only work ledger."""

    entry_id: str
    step_num: int
    worker_id: str
    work_item_summary: str
    dispatched_at: float

    # Filled on completion
    completed_at: Optional[float] = None
    status: EntryStatus = EntryStatus.PENDING
    outcome_summary: Optional[str] = None

    # Extracted observations
    observations: List[str] = field(default_factory=list)
    entity_refs: List[str] = field(default_factory=list)

    # Metrics
    tool_calls_made: int = 0
    llm_calls_made: int = 0
    duration_ms: float = 0


class WorkLedger:
    """
    Append-only work history owned by Wizard.

    INVARIANTS:
    - Entries can only be appended, never removed or modified
    - Exception: completion data can be added to a DISPATCHED entry
    """

    def __init__(self, max_entries: int = 1000):
        self._entries: List[LedgerEntry] = []
        self._by_step: Dict[int, List[str]] = {}  # step_num -> [entry_ids]
        self._by_id: Dict[str, LedgerEntry] = {}
        self._max_entries = max_entries

    def record_dispatch(
        self, step_num: int, work_item: "WorkItem", worker_id: str
    ) -> str:
        """
        Record work dispatch. Returns entry_id.
        This is the ONLY way to add entries.
        """
        entry_id = str(uuid.uuid4())[:8]
        entry = LedgerEntry(
            entry_id=entry_id,
            step_num=step_num,
            worker_id=worker_id,
            work_item_summary=work_item.objective[:100],
            dispatched_at=time.time(),
            status=EntryStatus.DISPATCHED,
        )

        self._entries.append(entry)
        self._by_id[entry_id] = entry
        self._by_step.setdefault(step_num, []).append(entry_id)

        # Enforce max_entries by evicting oldest completed entries
        if len(self._entries) > self._max_entries:
            self._evict_oldest_completed()

        return entry_id

    def _evict_oldest_completed(self) -> None:
        """
        Evict oldest completed entries to stay within max_entries.
        Only evicts COMPLETED or FAILED entries, never DISPATCHED (in-flight).
        """
        # Find completed entries that can be evicted
        evictable_indices: List[int] = []
        for i, entry in enumerate(self._entries):
            if entry.status in (EntryStatus.COMPLETED, EntryStatus.FAILED):
                evictable_indices.append(i)

        # Evict oldest first until we're under limit
        entries_to_remove = len(self._entries) - self._max_entries
        if entries_to_remove <= 0:
            return

        indices_to_remove = evictable_indices[:entries_to_remove]
        if not indices_to_remove:
            return

        # Remove from indices (reverse order to preserve indices)
        for idx in reversed(indices_to_remove):
            entry = self._entries[idx]
            # Remove from by_id
            self._by_id.pop(entry.entry_id, None)
            # Remove from by_step
            step_entries = self._by_step.get(entry.step_num, [])
            if entry.entry_id in step_entries:
                step_entries.remove(entry.entry_id)
            # Remove from entries list
            self._entries.pop(idx)

    def record_completion(self, entry_id: str, outcome: "WorkerOutcome") -> None:
        """
        Record completion of a dispatched work item.
        Only modifies completion fields - does not remove or replace entry.
        """
        entry = self._by_id.get(entry_id)
        if entry is None or entry.status != EntryStatus.DISPATCHED:
            return

        entry.completed_at = time.time()
        entry.status = EntryStatus.COMPLETED if outcome.success else EntryStatus.FAILED
        entry.outcome_summary = (
            outcome.final_response[:200] if outcome.final_response else None
        )
        entry.observations = [
            f"{fact.key}: {fact.value}" for fact in outcome.facts[:10]
        ]
        entry.entity_refs = list(outcome.entity_refs)
        entry.tool_calls_made = outcome.metrics.tool_calls_made
        entry.llm_calls_made = outcome.metrics.llm_calls_made
        entry.duration_ms = outcome.metrics.duration_ms

    def get_step_history(self, step_num: int) -> List[LedgerEntry]:
        """Get all entries for a step in chronological order."""
        entry_ids = self._by_step.get(step_num, [])
        # Filter out evicted entries (defensive - index may be stale)
        return [self._by_id[eid] for eid in entry_ids if eid in self._by_id]

    def get_recent_entries(self, n: int = 10) -> List[LedgerEntry]:
        """Get N most recent entries."""
        return list(self._entries[-n:])

    def summarize_tail(self, n: int = 5) -> str:
        """
        brief_summarize_work_done() - compact summary for context injection.
        Returns ~200 tokens max.
        """
        entries = self.get_recent_entries(n)
        if not entries:
            return "RECENT WORK: None"

        lines = ["RECENT WORK:"]
        for entry in entries:
            status = (
                "OK" if entry.status == EntryStatus.COMPLETED else entry.status.value.upper()
            )
            summary = entry.work_item_summary[:50]
            lines.append(f"- Step {entry.step_num}: {summary} [{status}]")

        return "\n".join(lines)

    @property
    def total_entries(self) -> int:
        return len(self._entries)

    # ========== PATCH LIFECYCLE TRACKING ==========

    def __init_patches(self) -> None:
        """Lazily initialize patch tracking."""
        if not hasattr(self, "_patches"):
            self._patches: List[PatchRecord] = []
            self._patches_by_id: Dict[str, PatchRecord] = {}

    def record_patch_proposed(
        self,
        patch_id: str,
        source: str,
        patch_type: str,
        target_steps: List[int],
        justification: str,
    ) -> PatchRecord:
        """Record a patch being proposed (phase 1 of lifecycle)."""
        self.__init_patches()

        record = PatchRecord(
            patch_id=patch_id,
            proposed_at=time.time(),
            source=source,
            patch_type=patch_type,
            target_steps=target_steps,
            justification=justification,
        )
        self._patches.append(record)
        self._patches_by_id[patch_id] = record
        return record

    def record_patch_decision(
        self,
        patch_id: str,
        approved: bool,
        rejection_reason: Optional[str] = None,
    ) -> None:
        """Record the decision on a patch (phase 2 of lifecycle)."""
        self.__init_patches()

        record = self._patches_by_id.get(patch_id)
        if record:
            record.decision = PatchDecision.APPROVED if approved else PatchDecision.REJECTED
            record.decision_at = time.time()
            record.rejection_reason = rejection_reason

    def record_patch_applied(
        self,
        patch_id: str,
        resulting_version: int,
    ) -> None:
        """Record a patch being applied (phase 3 of lifecycle)."""
        self.__init_patches()

        record = self._patches_by_id.get(patch_id)
        if record:
            record.applied = True
            record.applied_at = time.time()
            record.resulting_version = resulting_version

    def get_patch_history(self, limit: int = 20) -> List[PatchRecord]:
        """Get recent patch records for debugging."""
        self.__init_patches()
        return list(self._patches[-limit:])

    def get_rejected_patches(self, limit: int = 10) -> List[PatchRecord]:
        """Get recently rejected patches for thrash debugging."""
        self.__init_patches()
        rejected = [p for p in self._patches if p.decision == PatchDecision.REJECTED]
        return rejected[-limit:]

    def summarize_patch_activity(self) -> str:
        """Summarize recent patch activity for debugging."""
        self.__init_patches()

        if not self._patches:
            return "PATCH ACTIVITY: None"

        recent = self._patches[-10:]
        approved = sum(1 for p in recent if p.decision == PatchDecision.APPROVED)
        rejected = sum(1 for p in recent if p.decision == PatchDecision.REJECTED)

        lines = [
            f"PATCH ACTIVITY (last {len(recent)}):",
            f"  Approved: {approved}, Rejected: {rejected}",
        ]

        # Show last 3 patches
        for p in recent[-3:]:
            status = p.decision.value if p.decision else "pending"
            lines.append(f"  - {p.patch_type} on steps {p.target_steps}: {status}")

        return "\n".join(lines)
