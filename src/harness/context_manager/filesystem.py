"""
Filesystem Context - Deterministic filesystem context injection.

This module implements filesystem context injection using ONLY deterministic
heuristics - no embeddings, no "similarity magic", just clear logic.

Injection priority (deterministic):
1. Explicit paths in request (highest priority)
2. Recent file operations (from tool trace)
3. Repository "hot files" (README, package.json, etc.)
4. Language-specific anchors (main.py, index.js, etc.)
5. Compact file tree (always include if budget allows)

Key insight: Deterministic = debuggable, fast, predictable.
Embeddings can be added later as an enhancement, not a requirement.
"""

import os
import re
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Set, Any


@dataclass
class FileContext:
    """
    Context for a single file.

    Includes file path and excerpt of content.
    """
    path: str
    """File path (relative or absolute)"""

    excerpt: str
    """File content excerpt"""

    size_bytes: int
    """File size in bytes"""

    excerpt_type: str = "full"
    """Type of excerpt: 'full', 'head', 'tail', 'middle'"""

    relevance_score: float = 1.0
    """Relevance score (for prioritization)"""

    reason: str = ""
    """Why this file was included"""

    def to_text(self) -> str:
        """Render as text for context."""
        lines = [
            f"### File: {self.path}",
            f"Size: {self.size_bytes:,} bytes",
        ]

        if self.reason:
            lines.append(f"Reason: {self.reason}")

        lines.append("")
        lines.append(self.excerpt)
        lines.append("")

        return "\n".join(lines)


class FilesystemContext:
    """
    Deterministic filesystem context injection.

    Uses only deterministic heuristics - no embeddings or ML models.
    """

    # Repository anchor files (in priority order)
    HOT_FILES = [
        "README.md",
        "README",
        "package.json",
        "pyproject.toml",
        "requirements.txt",
        "Cargo.toml",
        "go.mod",
        "pom.xml",
        "Makefile",
        "setup.py",
        ".env.example",
        "docker-compose.yml",
        "Dockerfile"
    ]

    # Language-specific entry points
    LANGUAGE_ANCHORS = {
        "python": ["main.py", "__init__.py", "app.py", "run.py", "__main__.py"],
        "javascript": ["index.js", "app.js", "server.js", "main.js"],
        "typescript": ["index.ts", "app.ts", "server.ts", "main.ts"],
        "go": ["main.go", "cmd/main.go"],
        "rust": ["main.rs", "lib.rs", "src/main.rs", "src/lib.rs"],
        "java": ["Main.java", "App.java"],
    }

    def __init__(self, working_dir: str, token_estimator=None):
        """
        Initialize filesystem context builder.

        Args:
            working_dir: Working directory root
            token_estimator: Token estimator for budget management
        """
        self.working_dir = working_dir
        self.token_estimator = token_estimator

    def build(
        self,
        user_request: str,
        recent_operations: List[Dict[str, Any]],
        budget_tokens: int = 20_000
    ) -> str:
        """
        Build filesystem context with deterministic heuristics.

        Priority order:
        1. Explicit paths in request
        2. Recent file operations
        3. Hot files (README, etc.)
        4. Language anchors (main.py, etc.)
        5. File tree

        Args:
            user_request: User's request text
            recent_operations: Recent file operations from tool trace
            budget_tokens: Token budget for this section

        Returns:
            Formatted filesystem context string
        """
        file_contexts: List[FileContext] = []
        included_paths: Set[str] = set()
        budget_remaining = budget_tokens

        # 1. Explicit paths in request (highest priority)
        explicit_paths = self._extract_paths_from_request(user_request)
        for path in explicit_paths:
            if budget_remaining < 500:
                break

            file_ctx = self._load_file_context(
                path,
                max_lines=50,
                reason="Explicit mention in request"
            )

            if file_ctx:
                tokens = self._estimate_tokens(file_ctx.to_text())
                if tokens <= budget_remaining:
                    file_contexts.append(file_ctx)
                    included_paths.add(path)
                    budget_remaining -= tokens

        # 2. Recent file operations
        recent_paths = self._extract_recent_paths(recent_operations, limit=5)
        for path in recent_paths:
            if path in included_paths:
                continue
            if budget_remaining < 500:
                break

            file_ctx = self._load_file_context(
                path,
                max_lines=30,
                reason="Recent file operation"
            )

            if file_ctx:
                tokens = self._estimate_tokens(file_ctx.to_text())
                if tokens <= budget_remaining:
                    file_contexts.append(file_ctx)
                    included_paths.add(path)
                    budget_remaining -= tokens

        # 3. Repository hot files
        hot_files = self._find_hot_files()
        for path in hot_files:
            if path in included_paths:
                continue
            if budget_remaining < 500:
                break

            file_ctx = self._load_file_context(
                path,
                max_lines=20,
                reason="Repository anchor file"
            )

            if file_ctx:
                tokens = self._estimate_tokens(file_ctx.to_text())
                if tokens <= budget_remaining:
                    file_contexts.append(file_ctx)
                    included_paths.add(path)
                    budget_remaining -= tokens

        # 4. Language-specific anchors
        anchors = self._find_language_anchors()
        for path in anchors:
            if path in included_paths:
                continue
            if budget_remaining < 500:
                break

            file_ctx = self._load_file_context(
                path,
                max_lines=15,
                reason="Language entry point"
            )

            if file_ctx:
                tokens = self._estimate_tokens(file_ctx.to_text())
                if tokens <= budget_remaining:
                    file_contexts.append(file_ctx)
                    included_paths.add(path)
                    budget_remaining -= tokens

        # 5. Compact file tree (always include if budget allows)
        tree_text = ""
        if budget_remaining > 1000:
            tree = self._get_file_tree(max_depth=2)
            tree_text = f"## File Tree\n\n```\n{tree}\n```\n\n"
            tree_tokens = self._estimate_tokens(tree_text)
            if tree_tokens > budget_remaining:
                # Try shallower tree
                tree = self._get_file_tree(max_depth=1)
                tree_text = f"## File Tree\n\n```\n{tree}\n```\n\n"

        # Assemble final context
        sections = []

        if tree_text:
            sections.append(tree_text)

        if file_contexts:
            sections.append("## Files\n")
            for file_ctx in file_contexts:
                sections.append(file_ctx.to_text())

        return "\n".join(sections)

    def _extract_paths_from_request(self, request: str) -> List[str]:
        """
        Extract file paths from request using regex.

        Patterns:
        - ./path/to/file.py
        - /absolute/path/to/file.py
        - path/to/file.py
        - file.py
        """
        # Pattern: optional ./ or /, followed by path with extension
        pattern = r'(?:\.\/|\/)?[\w\/\-\.]+\.\w+'
        matches = re.findall(pattern, request)

        # Validate that paths look reasonable
        valid_paths = []
        for match in matches:
            # Must have an extension
            if '.' not in os.path.basename(match):
                continue

            # Check if file exists
            full_path = os.path.join(self.working_dir, match)
            if os.path.isfile(full_path):
                valid_paths.append(match)

        return valid_paths

    def _extract_recent_paths(
        self,
        recent_operations: List[Dict[str, Any]],
        limit: int = 5
    ) -> List[str]:
        """Extract paths from recent file operations."""
        paths = []
        seen = set()

        for op in reversed(recent_operations):
            path = op.get("path")
            if not path or path in seen:
                continue

            # Verify file exists
            full_path = os.path.join(self.working_dir, path)
            if os.path.isfile(full_path):
                paths.append(path)
                seen.add(path)

                if len(paths) >= limit:
                    break

        return paths

    def _find_hot_files(self) -> List[str]:
        """Find repository anchor files."""
        found = []
        for candidate in self.HOT_FILES:
            full_path = os.path.join(self.working_dir, candidate)
            if os.path.isfile(full_path):
                found.append(candidate)
        return found

    def _find_language_anchors(self) -> List[str]:
        """Find language-specific entry points."""
        found = []

        # Detect primary language by checking for specific files
        language = self._detect_language()

        if language and language in self.LANGUAGE_ANCHORS:
            for candidate in self.LANGUAGE_ANCHORS[language]:
                full_path = os.path.join(self.working_dir, candidate)
                if os.path.isfile(full_path):
                    found.append(candidate)

        return found

    def _detect_language(self) -> Optional[str]:
        """Detect primary language from repository."""
        # Check for language indicators
        if os.path.isfile(os.path.join(self.working_dir, "pyproject.toml")) or \
           os.path.isfile(os.path.join(self.working_dir, "requirements.txt")):
            return "python"

        if os.path.isfile(os.path.join(self.working_dir, "package.json")):
            # Check if TypeScript
            if os.path.isfile(os.path.join(self.working_dir, "tsconfig.json")):
                return "typescript"
            return "javascript"

        if os.path.isfile(os.path.join(self.working_dir, "Cargo.toml")):
            return "rust"

        if os.path.isfile(os.path.join(self.working_dir, "go.mod")):
            return "go"

        if os.path.isfile(os.path.join(self.working_dir, "pom.xml")):
            return "java"

        return None

    def _load_file_context(
        self,
        path: str,
        max_lines: int = 50,
        reason: str = ""
    ) -> Optional[FileContext]:
        """
        Load file and create context.

        Args:
            path: File path (relative to working_dir)
            max_lines: Maximum lines to include
            reason: Reason for inclusion

        Returns:
            FileContext or None if file can't be loaded
        """
        full_path = os.path.join(self.working_dir, path)

        if not os.path.isfile(full_path):
            return None

        try:
            size = os.path.getsize(full_path)

            with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()

            # Determine excerpt type
            if len(lines) <= max_lines:
                excerpt = ''.join(lines)
                excerpt_type = "full"
            else:
                # Include first half and last half
                half = max_lines // 2
                first = ''.join(lines[:half])
                last = ''.join(lines[-half:])
                omitted = len(lines) - max_lines
                excerpt = f"{first}\n... ({omitted} lines omitted) ...\n{last}"
                excerpt_type = "middle"

            return FileContext(
                path=path,
                excerpt=excerpt,
                size_bytes=size,
                excerpt_type=excerpt_type,
                reason=reason
            )

        except Exception as e:
            # Can't read file, skip it
            return None

    def _get_file_tree(self, max_depth: int = 2) -> str:
        """
        Generate compact file tree.

        Args:
            max_depth: Maximum directory depth

        Returns:
            Tree string
        """
        lines = []

        def walk_dir(dir_path: str, prefix: str = "", depth: int = 0):
            if depth > max_depth:
                return

            try:
                entries = sorted(os.listdir(dir_path))
            except PermissionError:
                return

            # Filter out common ignore patterns
            entries = [
                e for e in entries
                if not e.startswith('.') and
                e not in {'node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build'}
            ]

            for i, entry in enumerate(entries):
                full_path = os.path.join(dir_path, entry)
                is_last = i == len(entries) - 1
                connector = "└── " if is_last else "├── "

                if os.path.isdir(full_path):
                    lines.append(f"{prefix}{connector}{entry}/")
                    extension = "    " if is_last else "│   "
                    walk_dir(full_path, prefix + extension, depth + 1)
                else:
                    lines.append(f"{prefix}{connector}{entry}")

        lines.append(os.path.basename(self.working_dir) + "/")
        walk_dir(self.working_dir, "", 0)

        return "\n".join(lines)

    def _estimate_tokens(self, text: str) -> int:
        """Estimate tokens for text."""
        if self.token_estimator:
            return self.token_estimator.estimate_fast(text)
        else:
            # Fallback approximation
            return len(text) // 4
