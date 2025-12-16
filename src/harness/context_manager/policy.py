"""
Memory Write Policy - Gate what gets written to working memory.

This module implements policies that control which discoveries get persisted
to working memory. Not everything should be remembered.

Key insight: Unbounded memory writes lead to noise and drift. Gate writes
with explicit policies that require provenance, confidence, and relevance.

Policies check:
- Stability: Is this fact stable or ephemeral?
- Relevance: Was this actually used?
- Provenance: Where did this come from?
- Confidence: How sure are we?
- TTL: How long should this live?
"""

import time
from dataclasses import dataclass
from typing import Optional, Any
from enum import Enum

from .state import WorkingMemoryEntry, MemorySource


class WriteDecision(Enum):
    """Decision on whether to write memory entry."""
    ACCEPT = "accept"
    """Accept and write entry"""

    REJECT_LOW_CONFIDENCE = "reject_low_confidence"
    """Reject: confidence too low"""

    REJECT_NO_PROVENANCE = "reject_no_provenance"
    """Reject: missing provenance"""

    REJECT_UNUSED = "reject_unused"
    """Reject: not accessed/used"""

    REJECT_EPHEMERAL = "reject_ephemeral"
    """Reject: too ephemeral/unstable"""

    REJECT_DUPLICATE = "reject_duplicate"
    """Reject: duplicate of existing entry"""


@dataclass
class WriteDecisionResult:
    """Result of write policy decision."""
    decision: WriteDecision
    """Accept or reject with reason"""

    reason: str = ""
    """Human-readable explanation"""

    suggested_ttl: Optional[int] = None
    """Suggested TTL if accepted"""

    @property
    def should_write(self) -> bool:
        """Whether to write the entry."""
        return self.decision == WriteDecision.ACCEPT


class MemoryWritePolicy:
    """
    Gate what gets written to working memory.

    Enforces quality standards for memory entries:
    - Must have provenance
    - Must meet confidence threshold
    - Must be stable (not inferred with low confidence)
    - Must have been accessed or be critical
    """

    def __init__(
        self,
        min_confidence: float = 0.7,
        require_provenance: bool = True,
        require_usage: bool = False,
        allow_inferred: bool = True
    ):
        """
        Initialize write policy.

        Args:
            min_confidence: Minimum confidence for inferred facts
            require_provenance: Whether provenance is required
            require_usage: Whether fact must have been accessed
            allow_inferred: Whether to allow inferred facts at all
        """
        self.min_confidence = min_confidence
        self.require_provenance = require_provenance
        self.require_usage = require_usage
        self.allow_inferred = allow_inferred

    def should_write(
        self,
        entry: WorkingMemoryEntry,
        context: Optional[Any] = None
    ) -> WriteDecisionResult:
        """
        Decide if entry should be written to working memory.

        Args:
            entry: Entry to evaluate
            context: Optional execution context

        Returns:
            WriteDecisionResult with decision and reasoning
        """
        # Check provenance
        if self.require_provenance and not entry.source.type:
            return WriteDecisionResult(
                decision=WriteDecision.REJECT_NO_PROVENANCE,
                reason="Entry has no provenance (source.type is empty)"
            )

        # Check if inferred facts are allowed
        if not self.allow_inferred and entry.source.type == "inferred":
            return WriteDecisionResult(
                decision=WriteDecision.REJECT_EPHEMERAL,
                reason="Inferred facts not allowed by policy"
            )

        # Check confidence for inferred facts
        if entry.source.type == "inferred" and entry.confidence < self.min_confidence:
            return WriteDecisionResult(
                decision=WriteDecision.REJECT_LOW_CONFIDENCE,
                reason=f"Inferred fact confidence ({entry.confidence:.2f}) below threshold ({self.min_confidence})"
            )

        # Check usage requirement
        if self.require_usage:
            if not entry.pin and "critical" not in entry.tags:
                if entry.access_count == 0:
                    return WriteDecisionResult(
                        decision=WriteDecision.REJECT_UNUSED,
                        reason="Entry was never accessed and not marked critical"
                    )

        # Determine TTL based on source type
        suggested_ttl = self._suggest_ttl(entry)

        return WriteDecisionResult(
            decision=WriteDecision.ACCEPT,
            reason="Entry meets all policy requirements",
            suggested_ttl=suggested_ttl
        )

    def _suggest_ttl(self, entry: WorkingMemoryEntry) -> Optional[int]:
        """
        Suggest TTL based on entry characteristics.

        Args:
            entry: Entry to evaluate

        Returns:
            Suggested TTL in seconds or None for no expiration
        """
        # Pinned entries never expire
        if entry.pin:
            return None

        # TTL by source type
        if entry.source.type == "file":
            # Files change frequently
            return 300  # 5 minutes
        elif entry.source.type == "user":
            # User preferences are stable
            return 3600  # 1 hour
        elif entry.source.type == "inferred":
            # Inferred facts are less stable
            return 600  # 10 minutes
        elif entry.source.type == "tool":
            # Tool results moderately stable
            return 900  # 15 minutes
        else:
            # Default
            return 600  # 10 minutes


class ConservativeWritePolicy(MemoryWritePolicy):
    """
    Conservative policy: only write high-confidence, verified facts.

    Use this when memory quality is more important than completeness.
    """

    def __init__(self):
        super().__init__(
            min_confidence=0.9,
            require_provenance=True,
            require_usage=True,
            allow_inferred=False
        )


class PermissiveWritePolicy(MemoryWritePolicy):
    """
    Permissive policy: write most facts, let compaction handle cleanup.

    Use this when completeness is more important than strict quality.
    """

    def __init__(self):
        super().__init__(
            min_confidence=0.5,
            require_provenance=True,
            require_usage=False,
            allow_inferred=True
        )


class DefaultWritePolicy(MemoryWritePolicy):
    """
    Balanced default policy.

    Good middle ground for most use cases.
    """

    def __init__(self):
        super().__init__(
            min_confidence=0.7,
            require_provenance=True,
            require_usage=False,
            allow_inferred=True
        )


def apply_write_policy(
    entry: WorkingMemoryEntry,
    policy: MemoryWritePolicy,
    context: Optional[Any] = None
) -> tuple[bool, Optional[int], str]:
    """
    Apply write policy to entry and return decision.

    Args:
        entry: Entry to evaluate
        policy: Write policy to apply
        context: Optional execution context

    Returns:
        (should_write, suggested_ttl, reason)
    """
    result = policy.should_write(entry, context)

    # Apply suggested TTL if accepted and not already set
    if result.should_write and entry.ttl_seconds is None:
        entry.ttl_seconds = result.suggested_ttl

    return result.should_write, result.suggested_ttl, result.reason
