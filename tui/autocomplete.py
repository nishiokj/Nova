"""File autocomplete support for TUI.

Provides fast file caching and fuzzy matching for @filename autocomplete feature.
"""

from __future__ import annotations

import os
import time
import threading
from typing import List, Tuple, Set


# Directories and patterns to ignore when scanning files
IGNORED_DIRS = {
    "node_modules",
    "__pycache__",
    "venv",
    ".venv",
    "dist",
    "build",
    "site-packages",
    ".pytest_cache",
    ".claude",
    "logs",
    ".git",
    ".mypy_cache",
    ".ruff_cache",
    ".idea",
    ".vscode",
    "temp",
    ".egg-info",
    "htmlcov",
    ".tox",
    ".nox",
}

IGNORED_EXTENSIONS = {
    ".pyc",
    ".pyo",
    ".so",
    ".dylib",
    ".dll",
    ".class",
    ".o",
}


class FileCache:
    """Manages cached list of project files for autocomplete."""

    def __init__(self, root_dir: str):
        """Initialize file cache.

        Args:
            root_dir: Root directory to scan for files
        """
        self.root_dir = os.path.abspath(root_dir)
        self.files: List[str] = []
        self.last_update = 0.0
        self.lock = threading.Lock()

    def build_initial(self) -> None:
        """Build initial file list (blocking).

        Scans the project directory and populates the file cache.
        Should be called during TUI startup.
        """
        with self.lock:
            self.files = self._scan_files()
            self.last_update = time.time()

    def refresh_background(self) -> None:
        """Refresh file list in background.

        Safe to call from background thread. Only refreshes if enough
        time has passed since last update.
        """
        current_time = time.time()

        # Only refresh if > 5 seconds since last update
        if current_time - self.last_update < 5.0:
            return

        with self.lock:
            self.files = self._scan_files()
            self.last_update = current_time

    def _scan_files(self) -> List[str]:
        """Scan directory tree and return list of relative file paths.

        Returns:
            List of relative file paths from root directory
        """
        files = []

        try:
            for dirpath, dirnames, filenames in os.walk(self.root_dir):
                # Filter out ignored directories (modifies dirnames in-place)
                dirnames[:] = [
                    d for d in dirnames
                    if d not in IGNORED_DIRS and not d.startswith('.')
                ]

                # Calculate relative directory path
                rel_dir = os.path.relpath(dirpath, self.root_dir)
                if rel_dir == '.':
                    rel_dir = ''

                # Add files with relative paths
                for filename in filenames:
                    # Skip ignored extensions and hidden files
                    if filename.startswith('.'):
                        continue

                    _, ext = os.path.splitext(filename)
                    if ext in IGNORED_EXTENSIONS:
                        continue

                    # Build relative path
                    if rel_dir:
                        rel_path = os.path.join(rel_dir, filename)
                    else:
                        rel_path = filename

                    files.append(rel_path)

        except Exception as e:
            # Silently handle errors during scanning
            pass

        # Sort for consistent ordering
        files.sort()
        return files

    def get_files(self) -> List[str]:
        """Get current file list (thread-safe).

        Returns:
            Copy of current file list
        """
        with self.lock:
            return self.files.copy()


def fuzzy_match(query: str, candidates: List[str], limit: int = 10) -> List[str]:
    """Fast fuzzy matching for file paths.

    Uses hybrid matching strategy:
    1. Prefix match on filename (highest priority)
    2. Substring match in filename (medium priority)
    3. Substring match in path (lower priority)
    4. Character sequence match (lowest priority)

    Args:
        query: Search query string
        candidates: List of file paths to search
        limit: Maximum number of results to return

    Returns:
        List of matching file paths, sorted by relevance
    """
    if not query:
        return []

    query_lower = query.lower()
    results: List[Tuple[str, int]] = []

    for candidate in candidates:
        filename = os.path.basename(candidate).lower()
        path_lower = candidate.lower()

        # Priority 1: Prefix match on filename (highest score)
        if filename.startswith(query_lower):
            score = 1000 + len(query) * 10
            results.append((candidate, score))

        # Priority 2: Substring in filename
        elif query_lower in filename:
            # Bonus for match position (earlier is better)
            pos = filename.index(query_lower)
            score = 500 + len(query) * 5 - pos
            results.append((candidate, score))

        # Priority 3: Substring anywhere in path
        elif query_lower in path_lower:
            pos = path_lower.index(query_lower)
            score = 100 + len(query) * 2 - pos // 2
            results.append((candidate, score))

        # Priority 4: Character sequence match (fuzzy)
        else:
            char_score = _char_sequence_score(query_lower, filename)
            if char_score > 0:
                results.append((candidate, char_score))

    # Sort by score (descending), then alphabetically
    results.sort(key=lambda x: (-x[1], x[0]))

    # Return top matches
    return [path for path, score in results[:limit]]


def _char_sequence_score(query: str, text: str) -> int:
    """Score based on whether all chars in query appear in order in text.

    Args:
        query: Query string
        text: Text to search in

    Returns:
        Score > 0 if all characters match in sequence, 0 otherwise
    """
    qi, ti = 0, 0
    matches = 0

    while qi < len(query) and ti < len(text):
        if query[qi] == text[ti]:
            qi += 1
            matches += 1
        ti += 1

    # Return score if all query chars found
    if qi == len(query):
        return matches * 10
    return 0
