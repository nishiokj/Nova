"""
Artifact Registry - Addressable storage for large content.

This module implements artifact storage with addressable handles (artifact://id).
Large content is stored separately and referenced by handle, with excerpts
in the main context.

Key insight: Don't bloat context with full file contents or outputs.
Store them as artifacts and include only excerpts or summaries.

Artifacts are:
- Addressable: artifact://abc123
- Excerpted: First/last N lines in context
- Retrievable: Agent can request full content via tool
"""

import time
import hashlib
from dataclasses import dataclass, field, asdict
from typing import Dict, Optional, Any, List


@dataclass
class Artifact:
    """
    Large content stored outside main context.

    Each artifact has:
    - Unique ID (artifact://...)
    - Full content (stored)
    - Excerpt (shown in context)
    - Metadata (type, size, etc.)
    """
    id: str
    """Unique artifact handle (e.g., artifact://abc123)"""

    name: str
    """Human-readable name"""

    type: str
    """Artifact type: 'file_content', 'tool_output', 'code', 'data'"""

    content: str
    """Full content (stored, not always in context)"""

    size_bytes: int
    """Content size in bytes"""

    created_at: float = field(default_factory=time.time)
    """Creation timestamp"""

    excerpt: Optional[str] = None
    """Preview excerpt (first/last N lines)"""

    metadata: Dict[str, Any] = field(default_factory=dict)
    """Additional metadata"""

    access_count: int = 0
    """Number of times accessed"""

    last_accessed: float = field(default_factory=time.time)
    """Last access timestamp"""

    def mark_accessed(self):
        """Mark artifact as accessed."""
        self.access_count += 1
        self.last_accessed = time.time()

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary (excluding full content for efficiency)."""
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "size_bytes": self.size_bytes,
            "created_at": self.created_at,
            "excerpt": self.excerpt,
            "metadata": self.metadata,
            "access_count": self.access_count,
            "last_accessed": self.last_accessed
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any], content: str = "") -> "Artifact":
        """Create from dictionary."""
        data = data.copy()
        data["content"] = content
        return cls(**data)

    def to_context_summary(self, include_excerpt: bool = True) -> str:
        """
        Generate compact summary for context.

        Args:
            include_excerpt: Whether to include excerpt

        Returns:
            Formatted summary string
        """
        lines = [
            f"**{self.id}**: {self.name}",
            f"Type: {self.type}",
            f"Size: {self.size_bytes:,} bytes"
        ]

        if self.metadata:
            for key, value in self.metadata.items():
                lines.append(f"{key}: {value}")

        if include_excerpt and self.excerpt:
            lines.append("")
            lines.append("Excerpt:")
            lines.append(self.excerpt)

        return "\n".join(lines)


class ArtifactRegistry:
    """
    Storage and management for large artifacts.

    Provides:
    - Addressable storage (artifact://id)
    - Automatic excerpting
    - Capacity management
    - Retrieval by handle
    """

    def __init__(
        self,
        max_artifacts: int = 20,
        max_artifact_size: int = 50_000,
        excerpt_lines: int = 10
    ):
        """
        Initialize artifact registry.

        Args:
            max_artifacts: Maximum number of artifacts to store
            max_artifact_size: Maximum size per artifact in chars
            excerpt_lines: Number of lines for excerpt (first/last)
        """
        self.artifacts: Dict[str, Artifact] = {}
        self.max_artifacts = max_artifacts
        self.max_artifact_size = max_artifact_size
        self.excerpt_lines = excerpt_lines

    def store(
        self,
        name: str,
        content: str,
        artifact_type: str = "content",
        metadata: Optional[Dict[str, Any]] = None
    ) -> Optional[str]:
        """
        Store content as artifact.

        Args:
            name: Human-readable name
            content: Full content to store
            artifact_type: Type of artifact
            metadata: Optional metadata

        Returns:
            Artifact handle (artifact://id) or None if too small
        """
        # Don't create artifacts for tiny content
        if len(content) < 1000:
            return None

        # Truncate if too large
        if len(content) > self.max_artifact_size:
            content = content[:self.max_artifact_size]

        # Generate artifact ID
        content_hash = hashlib.sha256(content.encode()).hexdigest()[:12]
        artifact_id = f"artifact://{content_hash}"

        # Check if already exists
        if artifact_id in self.artifacts:
            self.artifacts[artifact_id].mark_accessed()
            return artifact_id

        # Create excerpt
        excerpt = self._create_excerpt(content)

        # Create artifact
        artifact = Artifact(
            id=artifact_id,
            name=name,
            type=artifact_type,
            content=content,
            size_bytes=len(content),
            excerpt=excerpt,
            metadata=metadata or {}
        )

        # Capacity management
        if len(self.artifacts) >= self.max_artifacts:
            self._evict_one()

        self.artifacts[artifact_id] = artifact
        return artifact_id

    def get(self, artifact_id: str) -> Optional[Artifact]:
        """
        Retrieve artifact by handle.

        Args:
            artifact_id: Artifact handle

        Returns:
            Artifact or None if not found
        """
        artifact = self.artifacts.get(artifact_id)
        if artifact:
            artifact.mark_accessed()
        return artifact

    def get_content(self, artifact_id: str) -> Optional[str]:
        """
        Get full content of artifact.

        Args:
            artifact_id: Artifact handle

        Returns:
            Full content or None if not found
        """
        artifact = self.get(artifact_id)
        return artifact.content if artifact else None

    def remove(self, artifact_id: str) -> bool:
        """Remove artifact by handle."""
        if artifact_id in self.artifacts:
            del self.artifacts[artifact_id]
            return True
        return False

    def _create_excerpt(self, content: str) -> str:
        """
        Create excerpt from content.

        Shows first N and last N lines with ellipsis.
        """
        lines = content.split('\n')

        if len(lines) <= self.excerpt_lines * 2:
            # Short enough, include all
            return content

        # First N lines
        first = '\n'.join(lines[:self.excerpt_lines])
        # Last N lines
        last = '\n'.join(lines[-self.excerpt_lines:])

        omitted = len(lines) - (self.excerpt_lines * 2)
        return f"{first}\n\n... ({omitted} lines omitted) ...\n\n{last}"

    def _evict_one(self):
        """Evict least recently used artifact."""
        if not self.artifacts:
            return

        # Evict LRU (lowest access_count, then oldest last_accessed)
        victim_id = min(
            self.artifacts.keys(),
            key=lambda aid: (
                self.artifacts[aid].access_count,
                self.artifacts[aid].last_accessed
            )
        )

        del self.artifacts[victim_id]

    def to_context_summary(self, max_artifacts: Optional[int] = None) -> str:
        """
        Generate compact summary of all artifacts for context.

        Args:
            max_artifacts: Maximum artifacts to include (None = all)

        Returns:
            Formatted summary string
        """
        if not self.artifacts:
            return "No artifacts stored."

        lines = [
            f"# Artifacts ({len(self.artifacts)} stored)",
            ""
        ]

        # Sort by access count (most accessed first)
        sorted_artifacts = sorted(
            self.artifacts.values(),
            key=lambda a: (a.access_count, a.created_at),
            reverse=True
        )

        if max_artifacts:
            sorted_artifacts = sorted_artifacts[:max_artifacts]

        for artifact in sorted_artifacts:
            lines.append(artifact.to_context_summary(include_excerpt=True))
            lines.append("")

        return "\n".join(lines)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "artifacts": {
                aid: artifact.to_dict()
                for aid, artifact in self.artifacts.items()
            },
            "max_artifacts": self.max_artifacts,
            "max_artifact_size": self.max_artifact_size,
            "excerpt_lines": self.excerpt_lines
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any], artifact_contents: Optional[Dict[str, str]] = None) -> "ArtifactRegistry":
        """
        Create from dictionary.

        Args:
            data: Registry data
            artifact_contents: Optional map of artifact_id -> full content

        Returns:
            ArtifactRegistry instance
        """
        registry = cls(
            max_artifacts=data.get("max_artifacts", 20),
            max_artifact_size=data.get("max_artifact_size", 50_000),
            excerpt_lines=data.get("excerpt_lines", 10)
        )

        artifact_contents = artifact_contents or {}

        for aid, artifact_data in data.get("artifacts", {}).items():
            content = artifact_contents.get(aid, "")
            registry.artifacts[aid] = Artifact.from_dict(artifact_data, content=content)

        return registry

    def compact(self, target_count: int) -> int:
        """
        Compact to target number of artifacts.

        Args:
            target_count: Target artifact count

        Returns:
            Number of artifacts removed
        """
        if len(self.artifacts) <= target_count:
            return 0

        # Keep most accessed artifacts
        sorted_artifacts = sorted(
            self.artifacts.items(),
            key=lambda kv: (kv[1].access_count, kv[1].last_accessed),
            reverse=True
        )

        to_keep = dict(sorted_artifacts[:target_count])
        removed = len(self.artifacts) - len(to_keep)

        self.artifacts = to_keep
        return removed

    def get_stats(self) -> Dict[str, Any]:
        """Get registry statistics."""
        if not self.artifacts:
            return {
                "total_artifacts": 0,
                "total_size_bytes": 0,
                "average_size_bytes": 0
            }

        total_size = sum(a.size_bytes for a in self.artifacts.values())
        total_accesses = sum(a.access_count for a in self.artifacts.values())

        return {
            "total_artifacts": len(self.artifacts),
            "total_size_bytes": total_size,
            "average_size_bytes": total_size // len(self.artifacts),
            "total_accesses": total_accesses,
            "average_accesses": total_accesses / len(self.artifacts),
            "capacity_utilization": len(self.artifacts) / self.max_artifacts
        }
