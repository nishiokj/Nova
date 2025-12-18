"""Filesystem indexing for graphd Tier A."""

from __future__ import annotations

import fnmatch
import os
import time
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Set

from .languages import LanguagePlugin, default_plugins
from .store import GraphStore
from .types import ExportDef, ModuleEdge, SymbolDef
from .utils import guess_language, normalize_path, sha1_bytes, sha1_text


DEFAULT_EXCLUDE_DIRS = {
    "__pycache__",
    ".venv",
    "venv",
    "site-packages",
    "dist",
    "build",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    "node_modules",
    ".tox",
    ".eggs",
    ".cache",
    ".ruff_cache",
}

DEFAULT_EXCLUDE_EXTENSIONS = {
    ".pyc",
    ".pyo",
    ".so",
    ".o",
    ".a",
    ".dylib",
    ".dll",
    ".exe",
    ".class",
}


@dataclass
class FileState:
    mtime: float
    hash_value: str
    last_indexed_at: float


class GraphIgnore:
    def __init__(self, root: str, ignore_file: str, extra_patterns: Optional[Iterable[str]] = None):
        self.root = root
        self.ignore_file = ignore_file
        self.patterns: List[str] = []
        self._load(extra_patterns)

    def _load(self, extra_patterns: Optional[Iterable[str]]) -> None:
        if extra_patterns:
            self.patterns.extend(list(extra_patterns))

        ignore_path = os.path.join(self.root, self.ignore_file)
        if not os.path.exists(ignore_path):
            return
        try:
            with open(ignore_path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    self.patterns.append(line)
        except Exception:
            pass

    def is_ignored(self, rel_path: str) -> bool:
        if not self.patterns:
            return False
        rel_norm = rel_path.replace("\\", "/")
        for pattern in self.patterns:
            normalized = pattern.rstrip("/")
            if rel_norm.startswith(normalized + "/") or rel_norm == normalized:
                return True
            if fnmatch.fnmatch(rel_norm, pattern):
                return True
        return False


class GraphIndexer:
    def __init__(
        self,
        store: GraphStore,
        root: str,
        max_file_size_bytes: int,
        debounce_s: float,
        max_files_per_scan: int,
        ignore_file: str,
        extra_ignore: Optional[Iterable[str]] = None,
        plugins: Optional[Iterable[LanguagePlugin]] = None,
    ):
        self.store = store
        self.root = root
        self.max_file_size_bytes = max_file_size_bytes
        self.debounce_s = debounce_s
        self.max_files_per_scan = max_files_per_scan
        self._state: Dict[str, FileState] = {}
        self._plugins = list(plugins) if plugins else list(default_plugins())
        self._plugin_map = self._build_plugin_map(self._plugins)
        self._ignore = GraphIgnore(root, ignore_file, extra_ignore)
        self._pending_files: List[str] = []
        self._last_seen: Set[str] = set()

    def scan_once(self) -> Dict[str, int]:
        updated_files = 0
        updated_paths: List[str] = []
        errors = 0

        if not self._pending_files:
            self._pending_files = self._collect_files()

        batch = self._pending_files[: self.max_files_per_scan]
        self._pending_files = self._pending_files[self.max_files_per_scan :]
        for rel_path in batch:
            abs_path = os.path.join(self.root, rel_path)
            if not os.path.exists(abs_path):
                continue
            try:
                stat = os.stat(abs_path)
                mtime = stat.st_mtime
                existing = self._state.get(rel_path)
                now = time.time()
                if existing and existing.mtime == mtime:
                    continue
                if existing and (now - existing.last_indexed_at) < self.debounce_s:
                    continue

                lang = guess_language(rel_path)
                content, hash_value = self._read_file(abs_path, mtime)
                symbols: List[SymbolDef] = []
                edges: List[ModuleEdge] = []
                exports: List[ExportDef] = []
                if content is not None:
                    plugin = self._plugin_map.get(os.path.splitext(rel_path)[1].lower())
                    if plugin:
                        symbols = plugin.extract_symbols(rel_path, content)
                        edges = plugin.extract_module_edges(rel_path, content, self.root)
                        exports = plugin.extract_exports(rel_path, content)
                if edges:
                    edges = self._dedupe_edges(edges)
                self.store.upsert_bundle(
                    rel_path,
                    lang,
                    hash_value,
                    mtime,
                    symbols,
                    edges,
                    exports,
                )

                self._state[rel_path] = FileState(mtime=mtime, hash_value=hash_value, last_indexed_at=now)
                updated_files += 1
                updated_paths.append(rel_path)
            except OSError:
                continue
            except Exception:
                errors += 1

        removed_files = 0
        if not self._pending_files:
            removed = set(self._state.keys()) - self._last_seen
            for rel_path in removed:
                self.store.remove_file(rel_path)
                self._state.pop(rel_path, None)
            removed_files = len(removed)

        return {
            "updated_files": updated_files,
            "removed_files": removed_files,
            "errors": errors,
            "updated_paths": updated_paths,
        }

    def _collect_files(self) -> List[str]:
        seen: Set[str] = set()
        files: List[str] = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in DEFAULT_EXCLUDE_DIRS]
            for filename in filenames:
                _, ext = os.path.splitext(filename)
                if ext in DEFAULT_EXCLUDE_EXTENSIONS:
                    continue
                abs_path = os.path.join(dirpath, filename)
                rel_path = normalize_path(abs_path, self.root)
                if self._ignore.is_ignored(rel_path):
                    continue
                seen.add(rel_path)
                files.append(rel_path)
        self._last_seen = seen
        return files

    def _read_file(self, path: str, mtime: float) -> tuple[Optional[str], str]:
        try:
            size = os.path.getsize(path)
            if size > self.max_file_size_bytes:
                return None, sha1_text(f"{size}:{mtime}")[:16]
            with open(path, "rb") as handle:
                data = handle.read()
            return data.decode("utf-8", errors="ignore"), sha1_bytes(data)[:16]
        except Exception:
            return None, sha1_text(f"{mtime}")[:16]

    @staticmethod
    def _build_plugin_map(plugins: Iterable[LanguagePlugin]) -> Dict[str, LanguagePlugin]:
        plugin_map: Dict[str, LanguagePlugin] = {}
        for plugin in plugins:
            for ext in plugin.extensions:
                plugin_map[ext] = plugin
        return plugin_map

    @staticmethod
    def _dedupe_edges(edges: Iterable[ModuleEdge]) -> List[ModuleEdge]:
        seen: Set[tuple[str, str, str]] = set()
        deduped: List[ModuleEdge] = []
        for edge in edges:
            key = (edge.src_path, edge.dst_path, edge.kind)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(edge)
        return deduped
