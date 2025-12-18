"""
Context Scout - Pre-planning context gathering (Event-Driven).

The Context Scout runs IN PARALLEL with ServiceRep acknowledgment to gather
minimal context before planning. This solves the "planner can't see files" problem.

Architecture (Event-Driven):
    TranscriptionCompleteEvent
         ↓
    ┌────┴────┐
    │         │
    ServiceRep (ack)   Scout (parallel)
    │                  │
    │                  ↓
    │            ScoutCompleteEvent
    │                  │
    └────┬─────────────┘
         ↓
    Planner (waits for scout, uses snapshot)
         ↓
    Executor (executes with confidence)

The Scout is intentionally limited:
- Read-only operations only
- Max 5 tool calls
- Max 10s total
- No LLM reasoning, just pattern-based scouting

Selective Context Injection:
- Main files (refactoring target, inspiration source): FULL CONTENT
- Related files: Preview only
- Directory structure: Always included
- Future: GraphDB summaries, file relations
"""

import re
import time
import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set

from .tool_registry import ToolRegistry, ToolResult


class FileImportance(Enum):
    """Importance level for file context injection."""
    PRIMARY = "primary"      # Full content (refactoring target, main file)
    SECONDARY = "secondary"  # Extended preview (related files)
    REFERENCE = "reference"  # Brief preview (mentioned files)


@dataclass
class FileContext:
    """Context for a single file with importance-based content."""
    path: str
    importance: FileImportance
    exists: bool = True
    size: int = 0
    content: Optional[str] = None  # Full content for PRIMARY files
    preview: Optional[str] = None  # Preview for SECONDARY/REFERENCE
    # Future: GraphDB metadata
    summary: Optional[str] = None  # From GraphDB file summaries
    relations: Optional[List[str]] = None  # From GraphDB file relations


@dataclass
class ContextSnapshot:
    """
    Context gathered before planning.

    Supports selective content injection:
    - PRIMARY files: Full content (for refactoring targets)
    - SECONDARY files: Extended preview
    - REFERENCE files: Brief preview
    - Future: GraphDB summaries and relations
    """
    # Files with importance-based context
    files: Dict[str, FileContext] = field(default_factory=dict)
    # Files searched for but not found
    files_not_found: List[str] = field(default_factory=list)
    # Directory structure observed
    directories: Dict[str, List[str]] = field(default_factory=dict)
    # Search results
    search_results: Dict[str, List[str]] = field(default_factory=dict)
    # Errors encountered
    errors: List[str] = field(default_factory=list)
    # Timing
    duration_ms: float = 0
    tool_calls_made: int = 0
    # Request tracking
    request_id: Optional[str] = None

    # Legacy compatibility
    @property
    def files_found(self) -> Dict[str, Dict[str, Any]]:
        """Legacy accessor for files_found."""
        return {
            path: {"size": fc.size, "preview": fc.preview or fc.content[:200] if fc.content else None}
            for path, fc in self.files.items() if fc.exists
        }

    def to_context_string(self) -> str:
        """Format snapshot for injection into planner context."""
        lines = ["PRE-PLANNING CONTEXT (verified):"]

        # PRIMARY files - include FULL CONTENT
        primary_files = [fc for fc in self.files.values() if fc.importance == FileImportance.PRIMARY and fc.exists]
        if primary_files:
            lines.append("\n" + "=" * 60)
            lines.append("PRIMARY FILES (full content for planning):")
            lines.append("=" * 60)
            for fc in primary_files:
                lines.append(f"\n### {fc.path} ({fc.size} bytes)")
                if fc.content:
                    lines.append("```")
                    lines.append(fc.content)
                    lines.append("```")

        # SECONDARY files - extended preview
        secondary_files = [fc for fc in self.files.values() if fc.importance == FileImportance.SECONDARY and fc.exists]
        if secondary_files:
            lines.append("\nSECONDARY FILES (extended preview):")
            for fc in secondary_files:
                lines.append(f"  ✓ {fc.path} ({fc.size} bytes)")
                if fc.preview:
                    lines.append(f"    Preview: {fc.preview[:300]}...")

        # REFERENCE files - brief preview
        reference_files = [fc for fc in self.files.values() if fc.importance == FileImportance.REFERENCE and fc.exists]
        if reference_files:
            lines.append("\nREFERENCE FILES (confirmed to exist):")
            for fc in reference_files:
                lines.append(f"  ✓ {fc.path} ({fc.size} bytes)")
                if fc.preview:
                    preview = fc.preview[:100].replace("\n", " ")
                    lines.append(f"    Preview: {preview}...")

        if self.files_not_found:
            lines.append("\nFILES NOT FOUND (do not assume they exist):")
            for path in self.files_not_found:
                lines.append(f"  ✗ {path}")

        if self.directories:
            lines.append("\nDIRECTORY STRUCTURE:")
            for path, contents in self.directories.items():
                lines.append(f"  {path}/")
                for item in contents[:10]:
                    lines.append(f"    - {item}")
                if len(contents) > 10:
                    lines.append(f"    ... and {len(contents) - 10} more")

        if self.search_results:
            lines.append("\nSEARCH RESULTS:")
            for query, matches in self.search_results.items():
                lines.append(f"  '{query}': {len(matches)} matches")
                for match in matches[:5]:
                    lines.append(f"    - {match}")

        if self.errors:
            lines.append("\nSCOUT ERRORS:")
            for error in self.errors:
                lines.append(f"  ! {error}")

        return "\n".join(lines)

    @property
    def has_useful_context(self) -> bool:
        """Check if we gathered anything useful."""
        return bool(self.files or self.directories or self.search_results)

    @property
    def primary_files(self) -> List[FileContext]:
        """Get primary files with full content."""
        return [fc for fc in self.files.values() if fc.importance == FileImportance.PRIMARY]


class ContextScout:
    """
    Pre-planning context gatherer (async-capable).

    Runs cheap, read-only operations to give the planner
    grounded knowledge about the codebase.

    Can run:
    - Synchronously: scout() blocks until done
    - Asynchronously: scout_async() returns immediately, get results later

    Supports importance-based content injection:
    - PRIMARY: Full file content (refactoring targets, inspiration sources)
    - SECONDARY: Extended preview (related files)
    - REFERENCE: Brief preview (mentioned files)
    """

    def __init__(
        self,
        tool_registry: ToolRegistry,
        max_tool_calls: int = 5,
        max_duration_ms: float = 5_000,
        max_primary_file_size: int = 50_000,  # Max bytes for full content
    ):
        self.tool_registry = tool_registry
        self.max_tool_calls = max_tool_calls
        self.max_duration_ms = max_duration_ms
        self.max_primary_file_size = max_primary_file_size

        # Async state
        self._pending_results: Dict[str, ContextSnapshot] = {}
        self._pending_lock = threading.Lock()
        self._active_scouts: Dict[str, threading.Thread] = {}

        # GraphDB integration point (future)
        self._graph_db: Optional[Any] = None

    def set_graph_db(self, graph_db: Any) -> None:
        """Set GraphDB for file summaries/relations (future integration)."""
        self._graph_db = graph_db

    def scout(self, user_input: str, working_dir: str = ".", request_id: Optional[str] = None) -> ContextSnapshot:
        """
        Scout context before planning (synchronous).

        Extracts file paths and identifiers from user input,
        determines importance, then verifies they exist.
        """
        snapshot = ContextSnapshot(request_id=request_id)
        start_time = time.time()

        # Extract paths with importance classification
        paths_with_importance = self._extract_paths_with_importance(user_input)

        # Extract potential search terms
        search_terms = self._extract_search_terms(user_input)

        # Check PRIMARY files first (full content)
        for path, importance in paths_with_importance:
            if snapshot.tool_calls_made >= self.max_tool_calls:
                break
            if (time.time() - start_time) * 1000 > self.max_duration_ms:
                break

            self._check_path_with_importance(path, importance, snapshot, working_dir)

        # Do searches if we have budget
        for term in search_terms:
            if snapshot.tool_calls_made >= self.max_tool_calls:
                break
            if (time.time() - start_time) * 1000 > self.max_duration_ms:
                break

            self._search_for(term, snapshot, working_dir)

        snapshot.duration_ms = (time.time() - start_time) * 1000
        return snapshot

    def scout_async(
        self,
        user_input: str,
        working_dir: str = ".",
        request_id: str = "",
        on_complete: Optional[Callable[[ContextSnapshot], None]] = None
    ) -> str:
        """
        Scout context asynchronously (non-blocking).

        Returns request_id immediately. Use get_results() or wait_for_results()
        to retrieve the snapshot.

        Args:
            user_input: User's request
            working_dir: Working directory for file operations
            request_id: Request ID for tracking (generated if not provided)
            on_complete: Optional callback when scouting completes

        Returns:
            request_id for retrieving results
        """
        if not request_id:
            import uuid
            request_id = str(uuid.uuid4())[:8]

        def _scout_worker():
            try:
                snapshot = self.scout(user_input, working_dir, request_id)
                with self._pending_lock:
                    self._pending_results[request_id] = snapshot
                if on_complete:
                    on_complete(snapshot)
            finally:
                with self._pending_lock:
                    self._active_scouts.pop(request_id, None)

        thread = threading.Thread(target=_scout_worker, daemon=True)
        with self._pending_lock:
            self._active_scouts[request_id] = thread
        thread.start()

        return request_id

    def get_results(self, request_id: str) -> Optional[ContextSnapshot]:
        """Get results if available (non-blocking)."""
        with self._pending_lock:
            return self._pending_results.pop(request_id, None)

    def wait_for_results(self, request_id: str, timeout_ms: float = 10_000) -> Optional[ContextSnapshot]:
        """Wait for results with timeout."""
        start = time.time()
        while (time.time() - start) * 1000 < timeout_ms:
            with self._pending_lock:
                if request_id in self._pending_results:
                    return self._pending_results.pop(request_id)
                if request_id not in self._active_scouts:
                    # Not active and no results - already retrieved or never started
                    return None
            time.sleep(0.05)  # 50ms poll interval
        return None

    def is_scouting(self, request_id: str) -> bool:
        """Check if a scout is still running."""
        with self._pending_lock:
            return request_id in self._active_scouts

    def _extract_paths_with_importance(self, user_input: str) -> List[tuple]:
        """
        Extract file paths with importance classification.

        Returns list of (path, FileImportance) tuples, sorted by importance.

        PRIMARY indicators:
        - "refactor X", "modify X", "update X", "edit X"
        - "based on X", "like X", "similar to X", "inspired by X"
        - File mentioned in creation context

        SECONDARY indicators:
        - "related to X", "also check X"

        REFERENCE indicators:
        - Any other file path mentioned
        """
        paths_importance: Dict[str, FileImportance] = {}
        input_lower = user_input.lower()

        # PRIMARY patterns: refactoring targets, inspiration sources
        primary_patterns = [
            r'refactor\s+["\']?([^\s"\']+\.[a-z]+)',
            r'modify\s+["\']?([^\s"\']+\.[a-z]+)',
            r'update\s+["\']?([^\s"\']+\.[a-z]+)',
            r'edit\s+["\']?([^\s"\']+\.[a-z]+)',
            r'based on\s+["\']?([^\s"\']+\.[a-z]+)',
            r'like\s+["\']?([^\s"\']+\.[a-z]+)',
            r'similar to\s+["\']?([^\s"\']+\.[a-z]+)',
            r'inspired? by\s+["\']?([^\s"\']+\.[a-z]+)',
            r'inspiration from\s+["\']?([^\s"\']+\.[a-z]+)',
            r'take inspiration\s+from\s+["\']?([^\s"\']+)',
            r'copy from\s+["\']?([^\s"\']+\.[a-z]+)',
            r'convert\s+["\']?([^\s"\']+\.[a-z]+)',
        ]

        for pattern in primary_patterns:
            for match in re.finditer(pattern, input_lower):
                path = match.group(1)
                paths_importance[path] = FileImportance.PRIMARY

        # Extract all other paths as REFERENCE
        all_paths = self._extract_paths(user_input)
        for path in all_paths:
            if path not in paths_importance:
                paths_importance[path] = FileImportance.REFERENCE

        # Sort by importance (PRIMARY first, then SECONDARY, then REFERENCE)
        importance_order = {
            FileImportance.PRIMARY: 0,
            FileImportance.SECONDARY: 1,
            FileImportance.REFERENCE: 2
        }
        sorted_paths = sorted(
            paths_importance.items(),
            key=lambda x: importance_order[x[1]]
        )

        return sorted_paths

    def _extract_paths(self, user_input: str) -> List[str]:
        """Extract potential file/directory paths from user input."""
        paths = []

        # Pattern 1: @mentions like @tui/render_engine.py - HIGHEST PRIORITY
        at_mentions = re.findall(r'@([\w/\-\.]+\.[\w]+)', user_input)
        paths.extend(at_mentions)

        # Pattern 2: Match paths in quotes
        quoted = re.findall(r'["\']([^"\']+)["\']', user_input)
        paths.extend([p for p in quoted if '/' in p or '.' in p])

        # Pattern 3: Explicit paths like /foo/bar.py or ./foo/bar
        path_pattern = r'(?:^|[^@\w])[./]([\w/-]+(?:\.\w+)?)'
        for match in re.finditer(path_pattern, user_input):
            candidate = match.group(1)
            if '/' in candidate or candidate.endswith(('.py', '.ts', '.js', '.json', '.md', '.txt')):
                paths.append(candidate)

        return list(set(paths))

    def _check_path_with_importance(
        self,
        path: str,
        importance: FileImportance,
        snapshot: ContextSnapshot,
        working_dir: str
    ) -> None:
        """
        Check if a path exists and gather context based on importance.

        PRIMARY: Full content (up to max_primary_file_size)
        SECONDARY: Extended preview (500 chars)
        REFERENCE: Brief preview (200 chars)
        """
        try:
            # Try file_read first
            result = self.tool_registry.execute(
                "file_read",
                path=path,
                timeout_override=5
            )
            snapshot.tool_calls_made += 1

            if result.is_success:
                content = str(result.output) if result.output else ""
                size = len(content)

                # Build FileContext based on importance
                if importance == FileImportance.PRIMARY:
                    # Full content for PRIMARY files (up to limit)
                    if size <= self.max_primary_file_size:
                        file_ctx = FileContext(
                            path=path,
                            importance=importance,
                            exists=True,
                            size=size,
                            content=content,
                            preview=content[:500] if content else None
                        )
                    else:
                        # Too large - demote to extended preview
                        file_ctx = FileContext(
                            path=path,
                            importance=importance,
                            exists=True,
                            size=size,
                            content=None,  # Too large
                            preview=content[:2000] if content else None
                        )
                elif importance == FileImportance.SECONDARY:
                    file_ctx = FileContext(
                        path=path,
                        importance=importance,
                        exists=True,
                        size=size,
                        content=None,
                        preview=content[:500] if content else None
                    )
                else:  # REFERENCE
                    file_ctx = FileContext(
                        path=path,
                        importance=importance,
                        exists=True,
                        size=size,
                        content=None,
                        preview=content[:200] if content else None
                    )

                # Future: Add GraphDB metadata
                if self._graph_db:
                    # file_ctx.summary = self._graph_db.get_file_summary(path)
                    # file_ctx.relations = self._graph_db.get_file_relations(path)
                    pass

                snapshot.files[path] = file_ctx

            else:
                # Maybe it's a directory?
                list_result = self.tool_registry.execute(
                    "list_files",
                    path=path,
                    timeout_override=5
                )
                snapshot.tool_calls_made += 1

                if list_result.is_success:
                    output = str(list_result.output) if list_result.output else ""
                    files = [f for f in output.strip().split("\n") if f]
                    snapshot.directories[path] = files
                else:
                    snapshot.files_not_found.append(path)

        except Exception as e:
            snapshot.errors.append(f"Error checking {path}: {str(e)[:50]}")

    def _extract_search_terms(self, user_input: str) -> List[str]:
        """Extract meaningful search terms from user input."""
        terms = []
        input_lower = user_input.lower()

        # Look for "find X", "search for X", "locate X" patterns
        search_patterns = [
            r'find\s+(\w+)',
            r'search\s+for\s+(\w+)',
            r'locate\s+(\w+)',
            r'where\s+is\s+(\w+)',
        ]

        for pattern in search_patterns:
            for match in re.finditer(pattern, input_lower):
                term = match.group(1)
                if len(term) > 3:  # Skip short terms
                    terms.append(term)

        return list(set(terms))

    def _check_path(self, path: str, snapshot: ContextSnapshot, working_dir: str) -> None:
        """Check if a path exists and gather info about it."""
        try:
            # Try file_read first
            result = self.tool_registry.execute(
                "file_read",
                path=path,
                timeout_override=5
            )
            snapshot.tool_calls_made += 1

            if result.is_success:
                content = str(result.output) if result.output else ""
                snapshot.files_found[path] = {
                    "size": len(content),
                    "preview": content[:200] if content else None
                }
            else:
                # Maybe it's a directory?
                list_result = self.tool_registry.execute(
                    "list_files",
                    path=path,
                    timeout_override=5
                )
                snapshot.tool_calls_made += 1

                if list_result.is_success:
                    output = str(list_result.output) if list_result.output else ""
                    files = [f for f in output.strip().split("\n") if f]
                    snapshot.directories[path] = files
                else:
                    snapshot.files_not_found.append(path)

        except Exception as e:
            snapshot.errors.append(f"Error checking {path}: {str(e)[:50]}")

    def _search_for(self, term: str, snapshot: ContextSnapshot, working_dir: str) -> None:
        """Search for a term in the codebase."""
        try:
            result = self.tool_registry.execute(
                "search_filesystem",
                pattern=f"*{term}*",
                path=working_dir,
                timeout_override=5
            )
            snapshot.tool_calls_made += 1

            if result.is_success:
                output = str(result.output) if result.output else ""
                matches = [m for m in output.strip().split("\n") if m]
                if matches:
                    snapshot.search_results[term] = matches[:10]

        except Exception as e:
            snapshot.errors.append(f"Error searching for {term}: {str(e)[:50]}")


def should_scout(user_input: str) -> bool:
    """
    Determine if context scouting is needed before planning.

    Scout when user references specific files/paths that need verification.
    """
    input_lower = user_input.lower()

    # File/path references
    has_path = bool(re.search(r'[./][\w/-]+\.\w+', user_input))

    # Creation tasks that reference existing files
    creation_with_reference = any(kw in input_lower for kw in [
        "take inspiration", "based on", "similar to", "like the",
        "copy from", "refactor", "convert", "migrate"
    ])

    # Explicit location requests
    location_request = any(kw in input_lower for kw in [
        "where is", "find", "locate", "search for"
    ])

    return has_path or creation_with_reference or location_request
