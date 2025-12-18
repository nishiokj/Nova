"""Tier B derived edges cache and search helpers."""

from __future__ import annotations

import re
import subprocess
import time
from dataclasses import dataclass
import threading
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from .types import DerivedEdge


@dataclass
class SearchResult:
    path: str
    line: int
    text: str


class DerivedEdgeCache:
    """In-memory Tier B cache for derived edges with TTL and size limits.

    Uses LRU-style eviction when max_entries is reached.
    """

    def __init__(self, ttl_s: int, max_entries: int = 1000):
        self.ttl_s = ttl_s
        self.max_entries = max_entries
        self._edges: Dict[Tuple[str, str], List[DerivedEdge]] = {}
        self._access_order: List[Tuple[str, str]] = []  # LRU tracking
        self._lock = threading.Lock()

    def get(self, src: str, kind: str) -> List[DerivedEdge]:
        now = time.time()
        key = (src, kind)
        with self._lock:
            items = self._edges.get(key, [])
            fresh = [e for e in items if e.expires_at > now]
            if fresh:
                self._edges[key] = fresh
                # Update access order for LRU
                self._touch_key(key)
            else:
                self._edges.pop(key, None)
                self._remove_from_access_order(key)
            return fresh

    def set(self, src: str, kind: str, edges: Iterable[DerivedEdge]) -> None:
        key = (src, kind)
        with self._lock:
            # Evict if at capacity and this is a new key
            if key not in self._edges and len(self._edges) >= self.max_entries:
                self._evict_oldest()

            self._edges[key] = list(edges)
            self._touch_key(key)

    def stats(self) -> Dict[str, int]:
        with self._lock:
            return {
                "cached_sets": len(self._edges),
                "cached_edges": sum(len(v) for v in self._edges.values()),
                "max_entries": self.max_entries,
                "ttl_s": self.ttl_s,
            }

    def clear(self) -> int:
        """Clear all cached entries. Returns count of cleared entries."""
        with self._lock:
            count = len(self._edges)
            self._edges.clear()
            self._access_order.clear()
            return count

    def _touch_key(self, key: Tuple[str, str]) -> None:
        """Move key to end of access order (most recently used)."""
        # Remove if exists (O(n) but cache is bounded)
        if key in self._access_order:
            self._access_order.remove(key)
        self._access_order.append(key)

    def _remove_from_access_order(self, key: Tuple[str, str]) -> None:
        """Remove key from access order tracking."""
        if key in self._access_order:
            self._access_order.remove(key)

    def _evict_oldest(self) -> None:
        """Evict the least recently used entry."""
        if self._access_order:
            oldest_key = self._access_order.pop(0)
            self._edges.pop(oldest_key, None)


class RipgrepSearch:
    def __init__(self, rg_path: str, enabled: bool, max_results: int):
        self.rg_path = rg_path
        self.enabled = enabled
        self.max_results = max_results

    def search(self, pattern: str, root: str, paths: Optional[Sequence[str]] = None) -> List[SearchResult]:
        if not self.enabled:
            return []
        try:
            cmd = [self.rg_path, "-n", "--no-heading", "--color", "never", "--max-count", str(self.max_results), pattern]
            if paths:
                cmd.extend(paths)
            else:
                cmd.append(root)
            result = subprocess.run(
                cmd,
                cwd=root,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if result.returncode not in (0, 1):
                return []
            return self._parse_rg_output(result.stdout)
        except Exception:
            return []

    @staticmethod
    def _parse_rg_output(output: str) -> List[SearchResult]:
        results: List[SearchResult] = []
        for line in output.splitlines():
            parts = line.split(":", 2)
            if len(parts) < 3:
                continue
            path, line_str, text = parts[0], parts[1], parts[2]
            try:
                line_num = int(line_str)
            except ValueError:
                continue
            results.append(SearchResult(path=path, line=line_num, text=text))
        return results


def simple_regex_search(pattern: str, content: str) -> bool:
    try:
        return bool(re.search(pattern, content))
    except re.error:
        return False
