"""
Context State - Session-level persistent state management.

This module implements the top layer of the context lifecycle:
ContextState represents everything that persists across multiple requests
within a session.

Key components:
- WorkingMemoryStore: Structured fact storage with provenance
- WorkingMemoryEntry: Individual facts with confidence, TTL, tags
- MemorySource: Provenance tracking (where did this fact come from?)
- ContextState: Container for all session-level state
"""

import time
import json
import os
import hashlib
from dataclasses import dataclass, field, asdict
from typing import Dict, Any, Optional, List
from enum import Enum


class MemoryEntryStatus(Enum):
    """
    Explicit status for memory entries - enables conflict tracking.

    Makes versioning and conflict resolution transparent instead of implicit.
    """
    ACTIVE = "active"
    """Entry is current and should be used"""

    DEPRECATED = "deprecated"
    """Entry has been superseded by a newer version"""

    RETRACTED = "retracted"
    """Entry was incorrect and should not be used"""


@dataclass
class MemorySource:
    """
    Provenance tracking for working memory entries.

    Records where a fact came from, enabling validation and trust assessment.
    """
    type: str
    """Source type: 'tool', 'user', 'inferred', 'file', 'system'"""

    tool_name: Optional[str] = None
    """Tool that produced this fact (if type='tool')"""

    file_path: Optional[str] = None
    """File associated with this fact (if type='file')"""

    reasoning: Optional[str] = None
    """Why we believe this fact (if type='inferred')"""

    timestamp: float = field(default_factory=time.time)
    """When this fact was recorded"""

    metadata: Dict[str, Any] = field(default_factory=dict)
    """Additional provenance metadata (e.g., mtime for files)"""

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "MemorySource":
        """Create from dictionary."""
        return cls(**data)


@dataclass
class WorkingMemoryEntry:
    """
    A single structured fact in working memory.

    Working memory is NOT free-form text - it's structured from day 1
    with provenance, confidence, and lifecycle management.

    Graph-ready features:
    - Explicit status for conflict tracking
    - Supersedes link for versioning
    - Entity reference for future graph database linking
    """
    key: str
    """Unique canonicalized key (e.g., 'repo.entrypoint', 'file:/abs/path:status')"""

    value: Any
    """Fact value (any JSON-serializable type)"""

    confidence: float
    """Confidence level 0.0-1.0"""

    source: MemorySource
    """Provenance: where did this fact come from?"""

    status: MemoryEntryStatus = MemoryEntryStatus.ACTIVE
    """Explicit status: active, deprecated, or retracted"""

    timestamp: float = field(default_factory=time.time)
    """When this entry was created"""

    ttl_seconds: Optional[int] = None
    """Time-to-live in seconds (None = never expires)"""

    tags: List[str] = field(default_factory=list)
    """Tags for categorization (e.g., ['filesystem', 'python', 'critical'])"""

    verified: bool = False
    """Whether this has been verified (hypothesis vs confirmed fact)"""

    pin: bool = False
    """If True, never evict this entry"""

    access_count: int = 0
    """How many times this entry has been accessed"""

    last_accessed: float = field(default_factory=time.time)
    """Last access timestamp"""

    supersedes: Optional[str] = None
    """Key of the entry this replaces (for versioning/conflict tracking)"""

    entity_ref: Optional[str] = None
    """Reference to entity in future graph database (e.g., 'file:123', 'user:456')"""

    @property
    def is_expired(self) -> bool:
        """Check if this entry has expired based on TTL."""
        if self.ttl_seconds is None:
            return False
        age = time.time() - self.timestamp
        return age > self.ttl_seconds

    @property
    def is_stale(self) -> bool:
        """Check if entry might be stale (expired or low confidence)."""
        return self.is_expired or (not self.verified and self.confidence < 0.5)

    def mark_accessed(self):
        """Mark this entry as accessed (updates access count and timestamp)."""
        self.access_count += 1
        self.last_accessed = time.time()

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "key": self.key,
            "value": self.value,
            "confidence": self.confidence,
            "source": self.source.to_dict(),
            "status": self.status.value,
            "timestamp": self.timestamp,
            "ttl_seconds": self.ttl_seconds,
            "tags": self.tags,
            "verified": self.verified,
            "pin": self.pin,
            "access_count": self.access_count,
            "last_accessed": self.last_accessed,
            "supersedes": self.supersedes,
            "entity_ref": self.entity_ref,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WorkingMemoryEntry":
        """Create from dictionary."""
        data = data.copy()
        data["source"] = MemorySource.from_dict(data["source"])
        # Convert status string to enum
        if "status" in data and isinstance(data["status"], str):
            data["status"] = MemoryEntryStatus(data["status"])
        return cls(**data)

    def to_bullet(self) -> str:
        """Render as single bullet point for LLM context."""
        confidence_str = f" (confidence: {self.confidence:.1f})" if self.confidence < 1.0 else ""
        verified_str = " ✓" if self.verified else ""

        # Show status if not active
        status_str = ""
        if self.status != MemoryEntryStatus.ACTIVE:
            status_str = f" [{self.status.value}]"

        # Show supersedes link if present
        supersedes_str = ""
        if self.supersedes:
            supersedes_str = f" (supersedes: {self.supersedes})"

        return f"- {self.key}: {self.value}{confidence_str}{verified_str}{status_str}{supersedes_str}"


class WorkingMemoryStore:
    """
    Structured working memory with conflict detection and lifecycle management.

    This is the core persistent knowledge base for a session.
    All entries are structured with provenance and confidence.

    Key features:
    - Key canonicalization to prevent duplication
    - Explicit status tracking (active/deprecated/retracted)
    - Supersedes links for versioning
    - Graph-ready with entity references
    """

    def __init__(self, max_entries: int = 100, working_dir: Optional[str] = None):
        self.entries: Dict[str, WorkingMemoryEntry] = {}
        self.max_entries = max_entries
        self.working_dir = working_dir or os.getcwd()

    @staticmethod
    def canonicalize_key(key: str, working_dir: Optional[str] = None) -> str:
        """
        Canonicalize key to prevent duplication.

        Enforces conventions:
        - file: prefix uses absolute paths
        - Lowercase namespace prefixes
        - No trailing/leading whitespace
        - Normalized path separators

        Examples:
            file:relative/path → file:/abs/path
            file:/abs/path → file:/abs/path
            file://abs/path → file:/abs/path
            FILE:path → file:/abs/path
            repo.EntryPoint → repo.entrypoint

        Args:
            key: Raw key
            working_dir: Working directory for resolving relative paths

        Returns:
            Canonicalized key
        """
        key = key.strip()

        # Split namespace and value
        if ":" in key:
            namespace, value = key.split(":", 1)
            namespace = namespace.lower().strip()

            # Handle file: namespace specially
            if namespace == "file":
                # Remove extra slashes
                value = value.lstrip("/")

                # Convert to absolute path
                if not os.path.isabs(value):
                    if working_dir:
                        value = os.path.abspath(os.path.join(working_dir, value))
                    else:
                        value = os.path.abspath(value)
                else:
                    value = os.path.abspath(value)

                # Normalize path separators
                value = os.path.normpath(value)

                return f"file:{value}"

            # For other namespaces, just normalize
            return f"{namespace}:{value.strip()}"

        # Dot-notation keys (e.g., repo.entrypoint)
        if "." in key:
            parts = key.split(".")
            # Lowercase the namespace, preserve the rest
            parts[0] = parts[0].lower()
            return ".".join(parts)

        # Simple keys - lowercase
        return key.lower()

    def add(self, entry: WorkingMemoryEntry, allow_overwrite: bool = False) -> bool:
        """
        Add entry to working memory with key canonicalization and versioning.

        Args:
            entry: WorkingMemoryEntry to add
            allow_overwrite: If False, refuse to overwrite existing high-confidence entries

        Returns:
            True if added, False if rejected
        """
        # Canonicalize key
        canonical_key = self.canonicalize_key(entry.key, self.working_dir)
        entry.key = canonical_key

        existing = self.entries.get(canonical_key)

        # Conflict detection with explicit status tracking
        if existing:
            # If existing entry is already deprecated/retracted, allow replacement
            if existing.status != MemoryEntryStatus.ACTIVE:
                # Mark supersedes link
                entry.supersedes = canonical_key
                self.entries[canonical_key] = entry
                return True

            # If not allowing overwrite, check confidence
            if not allow_overwrite:
                # Don't overwrite high-confidence verified facts with low-confidence ones
                if existing.verified and existing.confidence >= 0.8:
                    if not entry.verified or entry.confidence < existing.confidence:
                        return False

            # Overwriting - mark old entry as deprecated and set supersedes
            existing.status = MemoryEntryStatus.DEPRECATED
            entry.supersedes = canonical_key

        # Capacity management
        if len(self.entries) >= self.max_entries and canonical_key not in self.entries:
            # Need to evict something
            self._evict_one()

        self.entries[canonical_key] = entry
        return True

    def get(self, key: str, active_only: bool = True) -> Optional[WorkingMemoryEntry]:
        """
        Retrieve entry by key with automatic canonicalization.

        Args:
            key: Key to retrieve (will be canonicalized)
            active_only: If True, only return ACTIVE entries

        Returns:
            Entry or None if not found or not active

        Automatically marks as accessed and increments access count.
        """
        canonical_key = self.canonicalize_key(key, self.working_dir)
        entry = self.entries.get(canonical_key)

        if entry:
            # Check status if active_only
            if active_only and entry.status != MemoryEntryStatus.ACTIVE:
                return None

            entry.mark_accessed()

        return entry

    def remove(self, key: str) -> bool:
        """Remove entry by key (with canonicalization)."""
        canonical_key = self.canonicalize_key(key, self.working_dir)
        if canonical_key in self.entries:
            del self.entries[canonical_key]
            return True
        return False

    def retract(self, key: str, reason: Optional[str] = None) -> bool:
        """
        Mark entry as retracted (incorrect fact).

        Args:
            key: Key to retract
            reason: Optional reason for retraction

        Returns:
            True if retracted, False if not found
        """
        canonical_key = self.canonicalize_key(key, self.working_dir)
        entry = self.entries.get(canonical_key)

        if entry:
            entry.status = MemoryEntryStatus.RETRACTED
            if reason and "retraction_reason" not in entry.source.metadata:
                entry.source.metadata["retraction_reason"] = reason
            return True

        return False

    def query(self, prefix: str = "", tags: List[str] = None, status: Optional[MemoryEntryStatus] = None) -> List[WorkingMemoryEntry]:
        """
        Query entries by key prefix, tags, and/or status.

        Args:
            prefix: Key prefix to match (e.g., "repo." matches "repo.entrypoint")
            tags: List of tags (entry must have ALL tags)
            status: Filter by status (None = all statuses)

        Returns:
            List of matching entries
        """
        # Canonicalize prefix if provided
        if prefix:
            prefix = self.canonicalize_key(prefix, self.working_dir)

        results = []
        for entry in self.entries.values():
            # Check status filter (default to ACTIVE only if not specified)
            if status is not None and entry.status != status:
                continue
            elif status is None and entry.status != MemoryEntryStatus.ACTIVE:
                # By default, only return active entries
                continue

            # Check prefix
            if prefix and not entry.key.startswith(prefix):
                continue

            # Check tags
            if tags and not all(tag in entry.tags for tag in tags):
                continue

            results.append(entry)

        return results

    def prune_expired(self) -> int:
        """
        Remove expired entries.

        Returns:
            Number of entries removed
        """
        expired_keys = [
            key for key, entry in self.entries.items()
            if entry.is_expired and not entry.pin
        ]

        for key in expired_keys:
            del self.entries[key]

        return len(expired_keys)

    def _evict_one(self):
        """Evict one entry using LRU policy (lowest access_count, then oldest)."""
        # Don't evict pinned entries
        evictable = {k: v for k, v in self.entries.items() if not v.pin}

        if not evictable:
            # Everything is pinned, can't evict
            return

        # Evict least recently used with lowest access count
        victim_key = min(
            evictable.keys(),
            key=lambda k: (evictable[k].access_count, evictable[k].last_accessed)
        )
        del self.entries[victim_key]

    def compact(self, target_size: int) -> int:
        """
        Compact store to target size by removing low-value entries.

        Args:
            target_size: Target number of entries

        Returns:
            Number of entries removed
        """
        if len(self.entries) <= target_size:
            return 0

        # First, remove expired entries
        removed = self.prune_expired()

        # If still over target, remove by score
        if len(self.entries) > target_size:
            # Score = confidence * access_count * (1 if verified else 0.5)
            def score_entry(entry: WorkingMemoryEntry) -> float:
                if entry.pin:
                    return float('inf')
                base_score = entry.confidence * (1 + entry.access_count)
                if entry.verified:
                    base_score *= 2
                return base_score

            # Sort by score, keep top N
            sorted_entries = sorted(
                self.entries.items(),
                key=lambda kv: score_entry(kv[1]),
                reverse=True
            )

            self.entries = dict(sorted_entries[:target_size])
            removed += len(sorted_entries) - target_size

        return removed

    def to_bullets(self, max_entries: Optional[int] = None) -> str:
        """
        Render as human-readable bullet list for LLM context.

        Args:
            max_entries: Maximum entries to include (None = all)

        Returns:
            Formatted bullet list string
        """
        if not self.entries:
            return "No working memory entries."

        # Sort by importance (verified, high confidence, high access count)
        sorted_entries = sorted(
            self.entries.values(),
            key=lambda e: (e.verified, e.confidence, e.access_count),
            reverse=True
        )

        if max_entries:
            sorted_entries = sorted_entries[:max_entries]

        bullets = [entry.to_bullet() for entry in sorted_entries]
        return "\n".join(bullets)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "entries": {k: v.to_dict() for k, v in self.entries.items()},
            "max_entries": self.max_entries,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WorkingMemoryStore":
        """Create from dictionary."""
        store = cls(max_entries=data.get("max_entries", 100))
        for key, entry_data in data.get("entries", {}).items():
            store.entries[key] = WorkingMemoryEntry.from_dict(entry_data)
        return store


@dataclass
class ConversationSummary:
    """
    Rolling conversation summary for session context.

    Keeps a compact summary of conversation history without storing
    full message history (which would be memory-heavy).
    """
    summary_text: str = ""
    """Current summary of conversation"""

    total_turns: int = 0
    """Total number of turns in this session"""

    last_updated: float = field(default_factory=time.time)
    """When summary was last updated"""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ConversationSummary":
        return cls(**data)


@dataclass
class UserRules:
    """
    User-defined rules and preferences.

    These are explicit constraints or preferences the user has provided,
    loaded from:
    - Global rules.md (~/.config/jesus/rules.md)
    - Repository-specific repository.md (project root)
    - Automatic OS/environment detection
    """
    rules: List[str] = field(default_factory=list)
    """List of user rules (merged from all sources)"""

    preferences: Dict[str, Any] = field(default_factory=dict)
    """User preferences dictionary (includes os_info, rule_categories)"""

    global_rules_path: Optional[str] = None
    """Path to loaded global rules.md (if found)"""

    repo_rules_path: Optional[str] = None
    """Path to loaded repository.md (if found)"""

    @property
    def os_info(self) -> Dict[str, str]:
        """Get OS information from preferences."""
        return self.preferences.get("os_info", {})

    @property
    def rule_categories(self) -> Dict[str, List[str]]:
        """Get rules organized by category."""
        return self.preferences.get("rule_categories", {})

    @property
    def has_rules(self) -> bool:
        """Check if any rules are loaded."""
        return bool(self.rules) or bool(self.os_info)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rules": self.rules,
            "preferences": self.preferences,
            "global_rules_path": self.global_rules_path,
            "repo_rules_path": self.repo_rules_path,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "UserRules":
        return cls(
            rules=data.get("rules", []),
            preferences=data.get("preferences", {}),
            global_rules_path=data.get("global_rules_path"),
            repo_rules_path=data.get("repo_rules_path"),
        )

    @classmethod
    def load_from_working_dir(cls, working_dir: Optional[str] = None) -> "UserRules":
        """
        Load rules from files in the given working directory.

        This is the primary factory method for creating UserRules
        at session initialization.

        Args:
            working_dir: Working directory for repository.md discovery.
                        Defaults to current working directory.

        Returns:
            UserRules populated with loaded rules and OS info.
        """
        from .rules_loader import load_rules_for_session

        data = load_rules_for_session(working_dir=working_dir)
        return cls(
            rules=data["rules"],
            preferences=data["preferences"],
            global_rules_path=data.get("global_rules_path"),
            repo_rules_path=data.get("repo_rules_path"),
        )


class ContextState:
    """
    Session-level persistent state.

    This is the top layer of the context lifecycle - everything that
    persists across multiple requests within a session.

    Lifecycle:
    1. Load from checkpoint (or create new)
    2. Use for multiple requests
    3. Update after each request with discoveries
    4. Save checkpoint periodically
    """

    def __init__(
        self,
        session_id: str,
        working_memory: Optional[WorkingMemoryStore] = None,
        user_rules: Optional[UserRules] = None,
        conversation_summary: Optional[ConversationSummary] = None,
        working_dir: Optional[str] = None,
        load_rules: bool = False,
    ):
        """
        Initialize context state.

        Args:
            session_id: Unique session identifier
            working_memory: Pre-populated working memory (optional)
            user_rules: Pre-loaded user rules (optional)
            conversation_summary: Existing conversation summary (optional)
            working_dir: Working directory for rules discovery (optional)
            load_rules: If True and user_rules not provided, load from files
        """
        self.session_id = session_id
        self.working_memory = working_memory or WorkingMemoryStore()

        # Load rules from files if requested and not provided
        if user_rules is not None:
            self.user_rules = user_rules
        elif load_rules:
            self.user_rules = UserRules.load_from_working_dir(working_dir)
        else:
            self.user_rules = UserRules()

        self.conversation_summary = conversation_summary or ConversationSummary()
        self.created_at = time.time()
        self.last_modified = time.time()

    @classmethod
    def create_with_rules(
        cls,
        session_id: str,
        working_dir: Optional[str] = None,
    ) -> "ContextState":
        """
        Create a new session with rules loaded from files.

        This is the recommended factory method for creating new sessions
        that should have user rules loaded.

        Args:
            session_id: Unique session identifier
            working_dir: Working directory for repository.md discovery

        Returns:
            ContextState with loaded user rules
        """
        user_rules = UserRules.load_from_working_dir(working_dir)
        return cls(
            session_id=session_id,
            user_rules=user_rules,
        )

    def save_checkpoint(self, checkpoint_dir: str = ".context_checkpoints") -> str:
        """
        Save state to disk.

        Returns:
            Path to checkpoint file
        """
        os.makedirs(checkpoint_dir, exist_ok=True)

        checkpoint = {
            "session_id": self.session_id,
            "working_memory": self.working_memory.to_dict(),
            "user_rules": self.user_rules.to_dict(),
            "conversation_summary": self.conversation_summary.to_dict(),
            "created_at": self.created_at,
            "last_modified": time.time(),
            "version": "1.0"
        }

        self.last_modified = checkpoint["last_modified"]

        checkpoint_path = os.path.join(checkpoint_dir, f"{self.session_id}.json")
        with open(checkpoint_path, 'w') as f:
            json.dump(checkpoint, f, indent=2)

        return checkpoint_path

    @classmethod
    def load_checkpoint(
        cls,
        session_id: str,
        checkpoint_dir: str = ".context_checkpoints"
    ) -> "ContextState":
        """
        Load state from disk.

        If checkpoint doesn't exist, creates new session.
        """
        checkpoint_path = os.path.join(checkpoint_dir, f"{session_id}.json")

        if not os.path.exists(checkpoint_path):
            # Create new session
            return cls(session_id=session_id)

        with open(checkpoint_path, 'r') as f:
            checkpoint = json.load(f)

        state = cls(session_id=session_id)
        state.working_memory = WorkingMemoryStore.from_dict(checkpoint["working_memory"])
        state.user_rules = UserRules.from_dict(checkpoint["user_rules"])
        state.conversation_summary = ConversationSummary.from_dict(checkpoint["conversation_summary"])
        state.created_at = checkpoint.get("created_at", time.time())
        state.last_modified = checkpoint.get("last_modified", time.time())

        return state

    def update_from_discoveries(self, discoveries: List[WorkingMemoryEntry]):
        """
        Update working memory with new discoveries from request execution.

        Args:
            discoveries: List of new facts discovered during execution
        """
        for entry in discoveries:
            self.working_memory.add(entry, allow_overwrite=False)

        self.last_modified = time.time()

    def to_dict(self) -> Dict[str, Any]:
        """
        Serialize ContextState to dictionary for storage (e.g., GraphDB).

        Returns:
            Dictionary representation of the full context state
        """
        return {
            "session_id": self.session_id,
            "working_memory": self.working_memory.to_dict(),
            "user_rules": self.user_rules.to_dict(),
            "conversation_summary": self.conversation_summary.to_dict(),
            "created_at": self.created_at,
            "last_modified": self.last_modified,
            "version": "1.0",
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any], working_dir: Optional[str] = None) -> "ContextState":
        """
        Deserialize ContextState from dictionary (e.g., from GraphDB).

        Args:
            data: Dictionary representation of context state
            working_dir: Working directory for WorkingMemoryStore (optional)

        Returns:
            Restored ContextState instance
        """
        session_id = data.get("session_id", "unknown")

        # Restore working memory
        working_memory_data = data.get("working_memory", {})
        working_memory = WorkingMemoryStore.from_dict(working_memory_data)
        if working_dir:
            working_memory.working_dir = working_dir

        # Restore user rules
        user_rules_data = data.get("user_rules", {})
        user_rules = UserRules.from_dict(user_rules_data)

        # Restore conversation summary
        conv_summary_data = data.get("conversation_summary", {})
        conversation_summary = ConversationSummary.from_dict(conv_summary_data)

        # Create instance
        state = cls(
            session_id=session_id,
            working_memory=working_memory,
            user_rules=user_rules,
            conversation_summary=conversation_summary,
        )

        # Restore timestamps
        state.created_at = data.get("created_at", time.time())
        state.last_modified = data.get("last_modified", time.time())

        return state
