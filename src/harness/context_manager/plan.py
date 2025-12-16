"""
Context Plan - Execution-level decision record for context serialization.

This module implements the ContextPlan - a first-class, loggable, debuggable
record of what goes into the context and why.

Key insight: Context construction is a series of decisions. Making the plan
explicit allows debugging, replay, and optimization.

Lifecycle:
1. ContextPlanner.plan() creates ContextPlan
2. Plan logs all decisions (budgets, compaction, caching)
3. ContextSerializer.serialize() executes the plan
4. Plan can be logged, replayed, debugged
"""

import time
from dataclasses import dataclass, field
from typing import Dict, Any, Optional, List

from .sections import ContextSection


@dataclass
class SectionPlan:
    """
    Plan for a single section's inclusion in context.

    Records all decisions about this section: allocation, compaction,
    caching, and actual content.
    """
    section: ContextSection
    """Which section this plan covers"""

    content_hash: str
    """SHA256 hash of section content (for cache validation)"""

    cache_key: Optional[str] = None
    """Cache key if section is cacheable"""

    cache_control: Optional[str] = None
    """Cache control strategy ('ephemeral' or None)"""

    allocated_tokens: int = 0
    """Token budget allocated to this section"""

    actual_tokens: int = 0
    """Actual token count after compaction"""

    original_tokens: int = 0
    """Original token count before compaction"""

    included: bool = True
    """Whether to include this section in final context"""

    compacted: bool = False
    """Whether compaction was applied"""

    eviction_applied: Optional[str] = None
    """Eviction method used (if any)"""

    drop_reason: Optional[str] = None
    """Reason for dropping section (if not included)"""

    metadata: Dict[str, Any] = field(default_factory=dict)
    """Additional metadata about this section"""

    @property
    def compression_ratio(self) -> float:
        """Calculate compression ratio (original/actual)."""
        if self.original_tokens == 0:
            return 1.0
        return self.original_tokens / max(1, self.actual_tokens)

    @property
    def is_over_budget(self) -> bool:
        """Check if section exceeded its allocation."""
        return self.actual_tokens > self.allocated_tokens

    @property
    def budget_utilization(self) -> float:
        """Calculate budget utilization (0.0 - 1.0+)."""
        if self.allocated_tokens == 0:
            return 0.0
        return self.actual_tokens / self.allocated_tokens

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for logging."""
        return {
            "section": self.section.value,
            "content_hash": self.content_hash[:12],  # Truncate for readability
            "cache_key": self.cache_key,
            "cache_control": self.cache_control,
            "allocated_tokens": self.allocated_tokens,
            "actual_tokens": self.actual_tokens,
            "original_tokens": self.original_tokens,
            "included": self.included,
            "compacted": self.compacted,
            "eviction_applied": self.eviction_applied,
            "drop_reason": self.drop_reason,
            "compression_ratio": round(self.compression_ratio, 2),
            "budget_utilization": round(self.budget_utilization, 2),
            "metadata": self.metadata
        }


@dataclass
class ContextPlan:
    """
    Deterministic plan for context serialization.

    This is a first-class object that records all decisions about
    what goes into the context and why. Can be logged, debugged, and replayed.

    The plan is the source of truth for understanding context construction.
    """
    request_id: str
    """Request identifier"""

    session_id: str
    """Session identifier"""

    total_budget: int
    """Total token budget available"""

    sections: List[SectionPlan]
    """Plans for each section"""

    cache_strategy: str = "conservative"
    """Cache strategy: 'aggressive', 'conservative', 'disabled'"""

    rationale: str = ""
    """Human-readable explanation of this plan"""

    estimated_cost: float = 0.0
    """Estimated API cost in USD"""

    created_at: float = field(default_factory=time.time)
    """When this plan was created"""

    metadata: Dict[str, Any] = field(default_factory=dict)
    """Additional plan metadata"""

    @property
    def total_tokens(self) -> int:
        """Total tokens across all included sections."""
        return sum(sp.actual_tokens for sp in self.sections if sp.included)

    @property
    def total_allocated(self) -> int:
        """Total tokens allocated across all sections."""
        return sum(sp.allocated_tokens for sp in self.sections)

    @property
    def budget_utilization(self) -> float:
        """Overall budget utilization (0.0 - 1.0)."""
        if self.total_budget == 0:
            return 0.0
        return self.total_tokens / self.total_budget

    @property
    def is_over_budget(self) -> bool:
        """Check if plan exceeds budget."""
        return self.total_tokens > self.total_budget

    @property
    def cacheable_sections(self) -> List[SectionPlan]:
        """Get sections that support caching."""
        return [sp for sp in self.sections if sp.cache_key is not None]

    @property
    def compacted_sections(self) -> List[SectionPlan]:
        """Get sections that were compacted."""
        return [sp for sp in self.sections if sp.compacted]

    def get_section_plan(self, section: ContextSection) -> Optional[SectionPlan]:
        """Get plan for a specific section."""
        for sp in self.sections:
            if sp.section == section:
                return sp
        return None

    def to_dict(self) -> Dict[str, Any]:
        """
        Convert to dictionary for logging and debugging.

        This is the key method that makes plans debuggable.
        """
        return {
            "request_id": self.request_id,
            "session_id": self.session_id,
            "total_budget": self.total_budget,
            "total_tokens": self.total_tokens,
            "total_allocated": self.total_allocated,
            "budget_utilization": round(self.budget_utilization, 2),
            "is_over_budget": self.is_over_budget,
            "cache_strategy": self.cache_strategy,
            "rationale": self.rationale,
            "estimated_cost": self.estimated_cost,
            "created_at": self.created_at,
            "sections": [sp.to_dict() for sp in self.sections],
            "summary": {
                "total_sections": len(self.sections),
                "included_sections": sum(1 for sp in self.sections if sp.included),
                "cacheable_sections": len(self.cacheable_sections),
                "compacted_sections": len(self.compacted_sections),
                "average_utilization": round(
                    sum(sp.budget_utilization for sp in self.sections) / max(1, len(self.sections)),
                    2
                )
            },
            "metadata": self.metadata
        }

    def explain(self) -> str:
        """
        Generate human-readable explanation of this plan.

        Useful for logging and debugging.
        """
        lines = [
            f"Context Plan for request {self.request_id}",
            f"Total budget: {self.total_budget:,} tokens",
            f"Total used: {self.total_tokens:,} tokens ({self.budget_utilization:.1%} utilization)",
            f"Cache strategy: {self.cache_strategy}",
            "",
            "Sections:"
        ]

        for sp in self.sections:
            status = "✓" if sp.included else "✗"
            compact = " [compacted]" if sp.compacted else ""
            cached = " [cached]" if sp.cache_key else ""

            lines.append(
                f"  {status} {sp.section.value}: "
                f"{sp.actual_tokens:,}/{sp.allocated_tokens:,} tokens "
                f"({sp.budget_utilization:.1%}){compact}{cached}"
            )

            if sp.eviction_applied:
                lines.append(f"      Eviction: {sp.eviction_applied}")

            if sp.drop_reason:
                lines.append(f"      Dropped: {sp.drop_reason}")

        if self.rationale:
            lines.extend(["", "Rationale:", self.rationale])

        return "\n".join(lines)

    def validate(self) -> tuple[bool, List[str]]:
        """
        Validate this plan.

        Returns:
            (is_valid, list of validation errors)
        """
        errors = []

        # Check budget
        if self.is_over_budget:
            errors.append(
                f"Plan exceeds budget: {self.total_tokens:,} > {self.total_budget:,}"
            )

        # Check each section
        for sp in self.sections:
            if sp.included and sp.is_over_budget:
                errors.append(
                    f"{sp.section.value} over budget: "
                    f"{sp.actual_tokens} > {sp.allocated_tokens}"
                )

            if sp.included and sp.actual_tokens == 0:
                errors.append(f"{sp.section.value} included but has 0 tokens")

        # Check required sections
        required_sections = {ContextSection.SYSTEM_CORE, ContextSection.USER_REQUEST}
        included_sections = {sp.section for sp in self.sections if sp.included}

        for required in required_sections:
            if required not in included_sections:
                errors.append(f"Required section missing: {required.value}")

        return len(errors) == 0, errors


@dataclass
class PlanExecutionResult:
    """
    Result of executing a context plan.

    Records what actually happened when the plan was serialized and sent.
    """
    plan: ContextPlan
    """The plan that was executed"""

    success: bool
    """Whether execution succeeded"""

    serialized_messages: Optional[List[Dict]] = None
    """Serialized messages (if successful)"""

    error: Optional[str] = None
    """Error message (if failed)"""

    actual_tokens_sent: int = 0
    """Actual tokens sent to API"""

    cache_hits: int = 0
    """Number of cache hits"""

    cache_misses: int = 0
    """Number of cache misses"""

    execution_time_ms: float = 0.0
    """Time to execute plan in milliseconds"""

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for logging."""
        return {
            "plan_id": self.plan.request_id,
            "success": self.success,
            "error": self.error,
            "actual_tokens_sent": self.actual_tokens_sent,
            "cache_hits": self.cache_hits,
            "cache_misses": self.cache_misses,
            "execution_time_ms": round(self.execution_time_ms, 2),
            "plan_summary": self.plan.to_dict()["summary"]
        }
