"""
Evidence store for execution artifacts and verification.
Records tool outputs, file changes, and validation results.
"""

import hashlib
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class EvidenceRecord:
    """Single evidence record."""

    evidence_id: str
    step_num: int
    evidence_type: str  # "file_created", "test_passed", "search_result", etc.
    description: str

    # Optional structured data
    path: Optional[str] = None
    content_hash: Optional[str] = None
    tool_name: Optional[str] = None
    tool_output: Optional[str] = None  # Truncated output

    # Timestamp
    recorded_at: float = field(default_factory=time.time)

    # Verification status
    verified: bool = False
    verification_method: Optional[str] = None
    verification_result: Optional[str] = None


class EvidenceStore:
    """
    Append-only evidence store owned by Wizard.
    Records proof of work done for reflection and verification.
    """

    def __init__(self, max_records: int = 500):
        self._records: Dict[str, EvidenceRecord] = {}
        self._by_step: Dict[int, List[str]] = {}
        self._insertion_order: List[str] = []  # Track insertion order for eviction
        self._max_records = max_records

    def record(self, evidence: EvidenceRecord) -> None:
        """Record new evidence."""
        if not evidence.evidence_id:
            evidence.evidence_id = str(uuid.uuid4())[:8]

        self._records[evidence.evidence_id] = evidence
        self._by_step.setdefault(evidence.step_num, []).append(evidence.evidence_id)
        self._insertion_order.append(evidence.evidence_id)

        # Enforce max_records by evicting oldest unverified records
        if len(self._records) > self._max_records:
            self._evict_oldest()

    def _evict_oldest(self) -> None:
        """
        Evict oldest records to stay within max_records.
        Prioritizes evicting unverified records first, then oldest verified.
        """
        records_to_remove = len(self._records) - self._max_records
        if records_to_remove <= 0:
            return

        removed = 0
        # First pass: remove oldest unverified records
        for eid in list(self._insertion_order):
            if removed >= records_to_remove:
                break
            record = self._records.get(eid)
            if record and not record.verified:
                self._remove_record(eid)
                removed += 1

        # Second pass: if still over limit, remove oldest verified records
        for eid in list(self._insertion_order):
            if removed >= records_to_remove:
                break
            if eid in self._records:
                self._remove_record(eid)
                removed += 1

    def _remove_record(self, evidence_id: str) -> None:
        """Remove a record from all indices."""
        record = self._records.pop(evidence_id, None)
        if record:
            # Remove from by_step index
            step_list = self._by_step.get(record.step_num, [])
            if evidence_id in step_list:
                step_list.remove(evidence_id)
        # Remove from insertion order
        if evidence_id in self._insertion_order:
            self._insertion_order.remove(evidence_id)

    def record_tool_output(
        self,
        step_num: int,
        tool_name: str,
        output: Any,
        evidence_type: str = "tool_output",
    ) -> str:
        """Convenience method to record tool output as evidence."""
        output_str = str(output)[:1000]
        content_hash = hashlib.sha256(output_str.encode()).hexdigest()[:16]

        evidence = EvidenceRecord(
            evidence_id=str(uuid.uuid4())[:8],
            step_num=step_num,
            evidence_type=evidence_type,
            description=f"{tool_name} output",
            tool_name=tool_name,
            tool_output=output_str,
            content_hash=content_hash,
        )
        self.record(evidence)
        return evidence.evidence_id

    def record_file_change(
        self,
        step_num: int,
        path: str,
        action: str,
        content_hash: Optional[str] = None,
    ) -> str:
        """Record file system change as evidence."""
        evidence = EvidenceRecord(
            evidence_id=str(uuid.uuid4())[:8],
            step_num=step_num,
            evidence_type=f"file_{action}",
            description=f"File {action}: {path}",
            path=path,
            content_hash=content_hash,
        )
        self.record(evidence)
        return evidence.evidence_id

    def get_for_step(self, step_num: int) -> List[EvidenceRecord]:
        """Get all evidence for a step."""
        evidence_ids = self._by_step.get(step_num, [])
        return [self._records[eid] for eid in evidence_ids if eid in self._records]

    def verify_evidence(
        self, evidence_id: str, method: str, result: str, passed: bool
    ) -> None:
        """Mark evidence as verified."""
        evidence = self._records.get(evidence_id)
        if evidence:
            evidence.verified = passed
            evidence.verification_method = method
            evidence.verification_result = result

    def get_unverified(self, step_num: Optional[int] = None) -> List[EvidenceRecord]:
        """Get unverified evidence, optionally filtered by step."""
        records: List[EvidenceRecord]
        if step_num is not None:
            evidence_ids = self._by_step.get(step_num, [])
            records = [self._records[eid] for eid in evidence_ids if eid in self._records]
        else:
            records = list(self._records.values())
        return [record for record in records if not record.verified]

    @property
    def record_count(self) -> int:
        return len(self._records)
