"""
Append-only knowledge store for accumulated facts.
Facts can be added or superseded but never deleted.
"""

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class FactSource(Enum):
    """Where a fact came from."""

    TOOL = "tool"
    INFERENCE = "inference"
    USER = "user"
    COMPACTION = "compaction"
    GRAPHDB = "graphdb"  # Static analysis from GraphDB (imports, callers, symbols)


@dataclass
class KnowledgeFact:
    """A single accumulated fact."""

    key: str  # Canonicalized key (e.g., "file:/path:exists")
    value: Any
    confidence: float  # 0.0 to 1.0
    source: FactSource
    timestamp: float = field(default_factory=time.time)

    # Provenance
    derived_from_entry: Optional[str] = None  # LedgerEntry ID
    tool_name: Optional[str] = None

    # Lifecycle
    ttl_seconds: Optional[int] = None
    is_pinned: bool = False  # Pinned facts survive compaction


class KnowledgeStore:
    """
    Append-only knowledge base owned by Wizard.

    Facts are keyed by canonicalized strings.
    New facts supersede old facts with same key.
    """

    def __init__(self, max_facts: int = 500, max_compaction_facts: int = 5):
        self._facts: Dict[str, KnowledgeFact] = {}
        self._history: List[KnowledgeFact] = []  # All facts ever added
        self._max_facts = max_facts
        self._max_compaction_facts = max_compaction_facts

    def upsert(self, fact: KnowledgeFact) -> None:
        """
        Insert or update a fact.
        If key exists, new fact supersedes (but old is kept in history).
        """
        self._history.append(fact)
        self._facts[fact.key] = fact

        if len(self._facts) > self._max_facts:
            self._evict_oldest()

    def get(self, key: str) -> Optional[KnowledgeFact]:
        """
        Get fact by key, checking TTL.
        NOTE: Does NOT delete expired facts - use evict_expired() for cleanup.
        This avoids side-effects during iteration and maintains read-only semantics.
        """
        fact = self._facts.get(key)
        if fact is None:
            return None

        if fact.ttl_seconds is not None:
            age = time.time() - fact.timestamp
            if age > fact.ttl_seconds:
                # Return None but don't delete - caller should use evict_expired()
                return None

        return fact

    def query_by_prefix(self, prefix: str) -> List[KnowledgeFact]:
        """Query facts by key prefix (e.g., 'file:')."""
        return [fact for key, fact in self._facts.items() if key.startswith(prefix)]

    def get_all_facts(self, limit: Optional[int] = None) -> List[KnowledgeFact]:
        """
        Get all current facts, optionally limited.
        Filters out expired TTL facts without deleting them.

        Args:
            limit: Maximum number of facts to return (None = all)

        Returns:
            List of non-expired facts, most recent first
        """
        now = time.time()
        valid_facts: List[KnowledgeFact] = []

        # Sort by timestamp descending (most recent first)
        sorted_facts = sorted(
            self._facts.values(), key=lambda f: f.timestamp, reverse=True
        )

        for fact in sorted_facts:
            # Skip expired facts
            if fact.ttl_seconds is not None:
                age = now - fact.timestamp
                if age > fact.ttl_seconds:
                    continue

            valid_facts.append(fact)

            if limit is not None and len(valid_facts) >= limit:
                break

        return valid_facts

    def get_recent_facts(self, limit: int = 20) -> List[KnowledgeFact]:
        """
        Get the most recent non-expired facts.
        Convenience method for context building.

        Args:
            limit: Maximum number of facts to return

        Returns:
            List of most recent non-expired facts
        """
        return self.get_all_facts(limit=limit)

    def get_top_facts(self, limit: int = 20) -> List[KnowledgeFact]:
        """
        Backwards-compatible alias used by older callers.
        Returns most recent non-expired facts.
        """
        return self.get_all_facts(limit=limit)

    def evict_expired(self) -> None:
        """Remove all expired facts."""
        now = time.time()
        to_remove: List[str] = []
        for key, fact in self._facts.items():
            if fact.ttl_seconds is not None and now - fact.timestamp > fact.ttl_seconds:
                to_remove.append(key)
        for key in to_remove:
            del self._facts[key]

    def compact(self, _budget_tokens: int) -> str:
        """
        Compact store to fit within token budget.
        Returns summary of compacted facts.
        Also consolidates old compaction facts to prevent unbounded growth.
        """
        # First, consolidate old compaction facts if there are too many
        self._consolidate_compaction_facts()

        summaries: List[str] = []
        to_remove: List[str] = []

        for key, fact in self._facts.items():
            if not fact.is_pinned:
                summaries.append(f"{key}: {str(fact.value)[:50]}")
                to_remove.append(key)

        for key in to_remove:
            del self._facts[key]

        if summaries:
            summary_text = "Compacted facts: " + "; ".join(summaries[:10])
            compaction_fact = KnowledgeFact(
                key=f"compaction:{int(time.time())}",
                value=summary_text,
                confidence=0.8,
                source=FactSource.COMPACTION,
                is_pinned=True,
            )
            self.upsert(compaction_fact)
            return summary_text

        return ""

    def _consolidate_compaction_facts(self) -> None:
        """
        Consolidate old compaction facts to prevent unbounded pinned fact growth.
        Keeps only the most recent max_compaction_facts compaction entries.
        """
        compaction_keys: List[tuple] = []  # (timestamp, key)

        for key, fact in self._facts.items():
            if key.startswith("compaction:") and fact.source == FactSource.COMPACTION:
                # Extract timestamp from key
                try:
                    ts = int(key.split(":")[1])
                    compaction_keys.append((ts, key))
                except (IndexError, ValueError):
                    compaction_keys.append((0, key))

        # If under limit, nothing to do
        if len(compaction_keys) <= self._max_compaction_facts:
            return

        # Sort by timestamp (oldest first)
        compaction_keys.sort(key=lambda x: x[0])

        # Remove oldest, keeping only max_compaction_facts
        to_remove = compaction_keys[: -self._max_compaction_facts]

        # Collect summaries from facts we're removing
        old_summaries: List[str] = []
        for _, key in to_remove:
            fact = self._facts.get(key)
            if fact:
                old_summaries.append(str(fact.value)[:100])
                del self._facts[key]

        # Create a consolidated summary of the removed compaction facts
        if old_summaries:
            consolidated = KnowledgeFact(
                key=f"compaction_consolidated:{int(time.time())}",
                value=f"Consolidated {len(old_summaries)} old compactions",
                confidence=0.7,
                source=FactSource.COMPACTION,
                is_pinned=True,
            )
            # Don't use upsert to avoid triggering eviction logic
            self._facts[consolidated.key] = consolidated
            self._history.append(consolidated)

    def _evict_oldest(self) -> None:
        """Evict oldest non-pinned fact."""
        oldest_key: Optional[str] = None
        oldest_time = float("inf")

        for key, fact in self._facts.items():
            if not fact.is_pinned and fact.timestamp < oldest_time:
                oldest_time = fact.timestamp
                oldest_key = key

        if oldest_key:
            del self._facts[oldest_key]

    @property
    def fact_count(self) -> int:
        return len(self._facts)
