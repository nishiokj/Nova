"""
Cache Validation - Section hashing and cache correctness.

This module implements cache validation using content hashing to ensure
cached content is still valid.

Key insight: Caching without validation leads to stale context. Use content
hashing to detect changes and invalidate cache when needed.

Components:
- SectionHasher: Compute canonical hashes of section content
- CacheValidator: Validate cache entries against current content
- CacheEntry: Record of cached content with metadata
"""

import time
import hashlib
import json
from dataclasses import dataclass, field
from typing import Dict, Optional, Any, List

from .sections import ContextSection
from .state import WorkingMemoryStore


@dataclass
class CacheEntry:
    """
    Record of a cached section.

    Tracks content hash, expiration, and metadata for validation.
    """
    cache_key: str
    """Unique cache key"""

    content_hash: str
    """SHA256 hash of content"""

    created_at: float
    """When this was cached"""

    expires_at: float
    """When this expires"""

    section: ContextSection
    """Which section this caches"""

    metadata: Dict[str, Any] = field(default_factory=dict)
    """Additional metadata"""

    @property
    def is_expired(self) -> bool:
        """Check if entry has expired."""
        return time.time() > self.expires_at

    @property
    def age_seconds(self) -> float:
        """Get age in seconds."""
        return time.time() - self.created_at

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "cache_key": self.cache_key,
            "content_hash": self.content_hash,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "section": self.section.value,
            "is_expired": self.is_expired,
            "age_seconds": self.age_seconds,
            "metadata": self.metadata
        }


class SectionHasher:
    """
    Compute canonical hashes for cache validation.

    Different section types need different hashing strategies:
    - Structured data: canonical JSON ordering
    - Text: direct SHA256
    - Lists: sorted, then hashed
    """

    @staticmethod
    def hash_section(section: ContextSection, content: Any) -> str:
        """
        Compute canonical hash of section content.

        Args:
            section: Section type
            content: Section content

        Returns:
            SHA256 hash (truncated to 16 chars)
        """
        if section == ContextSection.TOOL_MANIFEST:
            # Hash tool schemas in canonical order
            if isinstance(content, list):
                # Sort by name, then canonical JSON
                sorted_tools = sorted(content, key=lambda t: getattr(t, 'name', str(t)))
                canonical = json.dumps(
                    [SectionHasher._to_dict_safe(t) for t in sorted_tools],
                    sort_keys=True
                )
            else:
                canonical = str(content)

        elif section == ContextSection.WORKING_MEMORY:
            # Hash structured entries
            if isinstance(content, WorkingMemoryStore):
                entries = sorted(content.entries.items())
                canonical = json.dumps(
                    [{k: v.to_dict()} for k, v in entries],
                    sort_keys=True
                )
            else:
                canonical = str(content)

        elif section == ContextSection.USER_RULES:
            # Hash rules in sorted order
            if hasattr(content, 'rules') and hasattr(content, 'preferences'):
                canonical = json.dumps({
                    "rules": sorted(content.rules),
                    "preferences": content.preferences
                }, sort_keys=True)
            else:
                canonical = str(content)

        else:
            # Simple text hash for other sections
            canonical = str(content)

        return hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:16]

    @staticmethod
    def _to_dict_safe(obj: Any) -> Dict:
        """Convert object to dict safely."""
        if hasattr(obj, 'to_dict'):
            return obj.to_dict()
        elif isinstance(obj, dict):
            return obj
        else:
            return {"_value": str(obj)}

    @staticmethod
    def compute_cache_key(
        section: ContextSection,
        content_hash: str,
        model_family: str,
        tier: Optional[str] = None
    ) -> str:
        """
        Compute unique cache key for section.

        Args:
            section: Section type
            content_hash: Content hash
            model_family: Model family (e.g., 'claude-3', 'gpt-4')
            tier: Optional tier (for tool manifest)

        Returns:
            Cache key string
        """
        parts = [section.value, content_hash, model_family]
        if tier:
            parts.append(tier)

        return "-".join(parts)


class CacheValidator:
    """
    Validate if cached content is still valid.

    Tracks cache entries and validates against current content hashes.
    """

    def __init__(self):
        """Initialize cache validator."""
        self.cache_registry: Dict[str, CacheEntry] = {}
        self.hit_count: int = 0
        self.miss_count: int = 0
        self.invalidation_count: int = 0

    def should_use_cache(
        self,
        cache_key: str,
        content_hash: str,
        ttl_seconds: int = 3600
    ) -> bool:
        """
        Check if cache should be used.

        Args:
            cache_key: Cache key to check
            content_hash: Current content hash
            ttl_seconds: TTL for validation

        Returns:
            True if cache is valid, False otherwise
        """
        entry = self.cache_registry.get(cache_key)

        if not entry:
            self.miss_count += 1
            return False

        # Check if expired
        if entry.is_expired:
            self.invalidation_count += 1
            self.miss_count += 1
            return False

        # Check if content changed (hash mismatch)
        if entry.content_hash != content_hash:
            self.invalidation_count += 1
            self.miss_count += 1
            return False

        # Cache is valid
        self.hit_count += 1
        return True

    def register_cache(
        self,
        cache_key: str,
        content_hash: str,
        section: ContextSection,
        ttl_seconds: int = 3600,
        metadata: Optional[Dict[str, Any]] = None
    ):
        """
        Register successful cache write.

        Args:
            cache_key: Cache key
            content_hash: Content hash
            section: Section type
            ttl_seconds: TTL in seconds
            metadata: Optional metadata
        """
        self.cache_registry[cache_key] = CacheEntry(
            cache_key=cache_key,
            content_hash=content_hash,
            created_at=time.time(),
            expires_at=time.time() + ttl_seconds,
            section=section,
            metadata=metadata or {}
        )

    def invalidate(self, cache_key: str) -> bool:
        """
        Manually invalidate a cache entry.

        Args:
            cache_key: Key to invalidate

        Returns:
            True if entry was found and removed
        """
        if cache_key in self.cache_registry:
            del self.cache_registry[cache_key]
            self.invalidation_count += 1
            return True
        return False

    def invalidate_section(self, section: ContextSection) -> int:
        """
        Invalidate all cache entries for a section.

        Args:
            section: Section to invalidate

        Returns:
            Number of entries invalidated
        """
        to_remove = [
            key for key, entry in self.cache_registry.items()
            if entry.section == section
        ]

        for key in to_remove:
            del self.cache_registry[key]

        self.invalidation_count += len(to_remove)
        return len(to_remove)

    def prune_expired(self) -> int:
        """
        Remove expired cache entries.

        Returns:
            Number of entries removed
        """
        expired_keys = [
            key for key, entry in self.cache_registry.items()
            if entry.is_expired
        ]

        for key in expired_keys:
            del self.cache_registry[key]

        return len(expired_keys)

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        total_requests = self.hit_count + self.miss_count
        hit_rate = self.hit_count / max(1, total_requests)

        return {
            "total_entries": len(self.cache_registry),
            "hit_count": self.hit_count,
            "miss_count": self.miss_count,
            "invalidation_count": self.invalidation_count,
            "total_requests": total_requests,
            "hit_rate": hit_rate,
            "entries_by_section": self._count_by_section()
        }

    def _count_by_section(self) -> Dict[str, int]:
        """Count cache entries by section."""
        counts: Dict[str, int] = {}
        for entry in self.cache_registry.values():
            section_name = entry.section.value
            counts[section_name] = counts.get(section_name, 0) + 1
        return counts

    def to_dict(self) -> Dict[str, Any]:
        """Export as dictionary for persistence."""
        return {
            "cache_registry": {
                key: entry.to_dict()
                for key, entry in self.cache_registry.items()
            },
            "stats": self.get_stats()
        }


class CacheStrategy:
    """
    Cache strategy configuration.

    Defines when and how to use caching for different scenarios.
    """

    AGGRESSIVE = "aggressive"
    """Cache everything possible, maximize savings"""

    CONSERVATIVE = "conservative"
    """Cache only stable sections, minimize staleness risk"""

    DISABLED = "disabled"
    """Disable caching entirely"""

    @staticmethod
    def should_cache_section(
        section: ContextSection,
        strategy: str
    ) -> bool:
        """
        Determine if section should be cached given strategy.

        Args:
            section: Section to check
            strategy: Cache strategy

        Returns:
            True if section should be cached
        """
        if strategy == CacheStrategy.DISABLED:
            return False

        if not section.is_cacheable:
            return False

        if strategy == CacheStrategy.CONSERVATIVE:
            # Only cache static and versioned sections
            return section.cache_category in {"static", "versioned"}

        # AGGRESSIVE: cache all cacheable sections
        return True

    @staticmethod
    def get_ttl(section: ContextSection, strategy: str) -> int:
        """
        Get TTL for section given strategy.

        Args:
            section: Section type
            strategy: Cache strategy

        Returns:
            TTL in seconds
        """
        if strategy == CacheStrategy.CONSERVATIVE:
            # Shorter TTLs for conservative strategy
            if section.cache_category == "static":
                return 1800  # 30 minutes
            elif section.cache_category == "versioned":
                return 600  # 10 minutes
            else:
                return 300  # 5 minutes

        # AGGRESSIVE: longer TTLs
        if section.cache_category == "static":
            return 3600  # 1 hour
        elif section.cache_category == "versioned":
            return 1800  # 30 minutes
        elif section.cache_category == "semi-static":
            return 900  # 15 minutes
        else:
            return 600  # 10 minutes
