"""
Budget Management - Token budget allocation and eviction policies.

This module implements the token budget system that replaces vague priorities
with explicit budgets and deterministic eviction policies.

Key concepts:
- SectionBudget: Token allocation for each section
- EvictionPolicy: What to do when over budget
- BudgetAllocator: Distributes tokens across sections

No guesswork - budgets enforce reality.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional
from enum import Enum

from .sections import ContextSection


class EvictionPolicy(Enum):
    """
    Explicit policies for handling over-budget sections.

    Each policy has deterministic behavior - no magic.
    """
    NONE = "none"
    """Never evict - hard requirement (e.g., system core)"""

    DROP_OLDEST = "drop_oldest"
    """Remove oldest entries first"""

    SUMMARIZE_OLDEST = "summarize_oldest"
    """Compress oldest entries into summary"""

    KEEP_TOPK_BY_SCORE = "keep_topk_by_score"
    """Keep only highest-scoring entries"""

    EXCERPT = "excerpt"
    """Replace full content with excerpt (first/last N lines)"""

    TRUNCATE = "truncate"
    """Hard truncate at token limit"""


@dataclass
class SectionBudget:
    """
    Token budget configuration for a single section.

    Explicit allocation with minimum guarantees and eviction policy.
    """
    section: ContextSection
    """Which section this budget applies to"""

    max_tokens: int
    """Maximum tokens allocated to this section"""

    min_tokens: int
    """Minimum guaranteed tokens (reserved)"""

    eviction_policy: EvictionPolicy
    """What to do when content exceeds max_tokens"""

    pin: bool = False
    """If True, never drop this section entirely"""

    priority: int = 5
    """Priority for proportional allocation (1-10, higher = more important)"""

    def __post_init__(self):
        """Validate budget configuration."""
        if self.min_tokens > self.max_tokens:
            raise ValueError(f"min_tokens ({self.min_tokens}) > max_tokens ({self.max_tokens})")

        if self.min_tokens < 0 or self.max_tokens < 0:
            raise ValueError("Token budgets must be non-negative")

        if self.priority < 1 or self.priority > 10:
            raise ValueError("Priority must be 1-10")


class BudgetAllocator:
    """
    Allocate token budgets across context sections.

    Uses a two-phase allocation:
    1. Reserve minimum budgets for all sections
    2. Distribute remaining tokens proportionally by priority
    """

    # Default budget configurations for each section type
    DEFAULT_BUDGETS: Dict[ContextSection, SectionBudget] = {
        ContextSection.SYSTEM_CORE: SectionBudget(
            section=ContextSection.SYSTEM_CORE,
            max_tokens=2000,
            min_tokens=500,
            eviction_policy=EvictionPolicy.NONE,
            pin=True,
            priority=10
        ),
        ContextSection.TOOL_MANIFEST: SectionBudget(
            section=ContextSection.TOOL_MANIFEST,
            max_tokens=8000,
            min_tokens=1000,
            eviction_policy=EvictionPolicy.NONE,
            pin=True,
            priority=10
        ),
        ContextSection.EXECUTION_CONTRACT: SectionBudget(
            section=ContextSection.EXECUTION_CONTRACT,
            max_tokens=500,
            min_tokens=200,
            eviction_policy=EvictionPolicy.NONE,
            pin=True,
            priority=10
        ),
        ContextSection.USER_RULES: SectionBudget(
            section=ContextSection.USER_RULES,
            max_tokens=2000,
            min_tokens=0,
            eviction_policy=EvictionPolicy.SUMMARIZE_OLDEST,
            pin=False,
            priority=6
        ),
        ContextSection.WORKING_MEMORY: SectionBudget(
            section=ContextSection.WORKING_MEMORY,
            max_tokens=10_000,
            min_tokens=1000,
            eviction_policy=EvictionPolicy.KEEP_TOPK_BY_SCORE,
            pin=True,
            priority=9
        ),
        ContextSection.TOOL_TRACE_SUMMARY: SectionBudget(
            section=ContextSection.TOOL_TRACE_SUMMARY,
            max_tokens=8000,
            min_tokens=500,
            eviction_policy=EvictionPolicy.DROP_OLDEST,
            pin=True,
            priority=7
        ),
        ContextSection.ARTIFACTS: SectionBudget(
            section=ContextSection.ARTIFACTS,
            max_tokens=20_000,
            min_tokens=0,
            eviction_policy=EvictionPolicy.EXCERPT,
            pin=False,
            priority=5
        ),
        ContextSection.FILESYSTEM_CONTEXT: SectionBudget(
            section=ContextSection.FILESYSTEM_CONTEXT,
            max_tokens=20_000,
            min_tokens=1000,
            eviction_policy=EvictionPolicy.EXCERPT,
            pin=True,
            priority=8
        ),
        ContextSection.USER_REQUEST: SectionBudget(
            section=ContextSection.USER_REQUEST,
            max_tokens=10_000,
            min_tokens=10_000,  # Never compress user input
            eviction_policy=EvictionPolicy.NONE,
            pin=True,
            priority=10
        ),
    }

    def __init__(self, custom_budgets: Optional[Dict[ContextSection, SectionBudget]] = None):
        """
        Initialize budget allocator.

        Args:
            custom_budgets: Optional custom budget overrides
        """
        self.budgets = self.DEFAULT_BUDGETS.copy()
        if custom_budgets:
            self.budgets.update(custom_budgets)

    def allocate(
        self,
        total_budget: int,
        sections: List[ContextSection],
        actual_sizes: Optional[Dict[ContextSection, int]] = None
    ) -> Dict[ContextSection, int]:
        """
        Allocate token budget across sections.

        Two-phase allocation:
        1. Reserve minimum budgets
        2. Distribute remainder proportionally by priority

        Args:
            total_budget: Total tokens available
            sections: Sections to allocate for
            actual_sizes: Actual current sizes (optional, for optimization)

        Returns:
            Dictionary mapping section to allocated tokens
        """
        actual_sizes = actual_sizes or {}

        # Phase 1: Reserve minimums
        reserved = sum(self.budgets[s].min_tokens for s in sections)

        if reserved > total_budget:
            # Not enough budget for minimums - proportionally reduce
            return self._allocate_constrained(total_budget, sections)

        available = total_budget - reserved

        # Phase 2: Distribute remainder by priority
        allocations: Dict[ContextSection, int] = {}
        total_priority = sum(self.budgets[s].priority for s in sections)

        for section in sections:
            budget = self.budgets[section]

            # Start with minimum
            base = budget.min_tokens

            # Add proportional share of available tokens
            if total_priority > 0:
                priority_share = (budget.priority / total_priority) * available
                extra = min(priority_share, budget.max_tokens - base)
            else:
                extra = 0

            # Final allocation
            allocation = int(base + extra)

            # Cap at actual size if known and smaller
            if section in actual_sizes:
                allocation = min(allocation, actual_sizes[section])

            allocations[section] = min(allocation, budget.max_tokens)

        return allocations

    def _allocate_constrained(
        self,
        total_budget: int,
        sections: List[ContextSection]
    ) -> Dict[ContextSection, int]:
        """
        Allocate when budget is insufficient for all minimums.

        Priority-based distribution with pinned sections getting preference.
        """
        # First, allocate to pinned sections
        pinned = [s for s in sections if self.budgets[s].pin]
        unpinned = [s for s in sections if not self.budgets[s].pin]

        allocations: Dict[ContextSection, int] = {}
        remaining = total_budget

        # Allocate to pinned first
        if pinned:
            total_pinned_min = sum(self.budgets[s].min_tokens for s in pinned)
            if total_pinned_min <= remaining:
                # Can satisfy all pinned minimums
                for section in pinned:
                    allocations[section] = self.budgets[section].min_tokens
                    remaining -= allocations[section]
            else:
                # Proportionally reduce pinned
                for section in pinned:
                    share = (self.budgets[section].min_tokens / total_pinned_min) * remaining
                    allocations[section] = int(share)
                remaining = 0

        # Allocate remainder to unpinned by priority
        if remaining > 0 and unpinned:
            total_priority = sum(self.budgets[s].priority for s in unpinned)
            for section in unpinned:
                share = (self.budgets[section].priority / total_priority) * remaining
                allocations[section] = int(share)

        return allocations

    def get_budget(self, section: ContextSection) -> SectionBudget:
        """Get budget configuration for a section."""
        return self.budgets.get(section, SectionBudget(
            section=section,
            max_tokens=5000,
            min_tokens=0,
            eviction_policy=EvictionPolicy.TRUNCATE,
            pin=False,
            priority=5
        ))

    def set_budget(self, section: ContextSection, budget: SectionBudget):
        """Override budget for a section."""
        self.budgets[section] = budget

    def validate_allocation(
        self,
        allocations: Dict[ContextSection, int],
        total_budget: int
    ) -> tuple[bool, Optional[str]]:
        """
        Validate that allocation is feasible.

        Returns:
            (is_valid, error_message)
        """
        # Check total doesn't exceed budget
        total_allocated = sum(allocations.values())
        if total_allocated > total_budget:
            return False, f"Total allocation ({total_allocated}) exceeds budget ({total_budget})"

        # Check each section respects its constraints
        for section, allocated in allocations.items():
            budget = self.budgets.get(section)
            if not budget:
                continue

            if allocated < budget.min_tokens:
                return False, f"{section.value}: allocated ({allocated}) < minimum ({budget.min_tokens})"

            if allocated > budget.max_tokens:
                return False, f"{section.value}: allocated ({allocated}) > maximum ({budget.max_tokens})"

        return True, None

    def to_dict(self) -> Dict:
        """Export budget configuration as dictionary."""
        return {
            section.value: {
                "max_tokens": budget.max_tokens,
                "min_tokens": budget.min_tokens,
                "eviction_policy": budget.eviction_policy.value,
                "pin": budget.pin,
                "priority": budget.priority
            }
            for section, budget in self.budgets.items()
        }
