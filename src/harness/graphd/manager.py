"""Graphd manager: indexing, cache, and HTTP API."""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Dict, Optional

from util.logger import StructuredLogger

from .constants import GRAPH_D_SCHEMA_VERSION, GRAPH_D_VERSION
from .derived import DerivedEdgeCache, RipgrepSearch
from .impact import ImpactEngine
from .indexer import GraphIndexer
from .server import GraphdHTTPServer, GraphdRequestHandler
from .store import GraphStore, SchemaVersionError
from .utils import normalize_path


class GraphdManager:
    def __init__(self, config, logger: Optional[StructuredLogger] = None):
        self.config = config
        self.logger = logger or StructuredLogger()
        self.root = os.path.abspath(config.root_path or os.getcwd())
        self.db_path = self._resolve_db_path(config.db_path)
        self._active = False
        self._paused = False
        self._running = False
        self._last_index_stats: Dict[str, Any] = {}

        db_dir = os.path.dirname(self.db_path)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        self.store = GraphStore(self.db_path)
        self.indexer = GraphIndexer(
            store=self.store,
            root=self.root,
            max_file_size_bytes=config.max_file_size_bytes,
            debounce_s=config.debounce_s,
            max_files_per_scan=config.max_files_per_scan,
            ignore_file=config.ignore_file,
            extra_ignore=config.extra_ignore,
        )
        self.cache = DerivedEdgeCache(
            ttl_s=config.derived_ttl_s,
            max_entries=config.derived_max_entries,
        )
        self.search = RipgrepSearch(
            rg_path=config.rg_path,
            enabled=config.enable_rg,
            max_results=config.max_results,
        )
        self.impact_engine = ImpactEngine(
            store=self.store,
            cache=self.cache,
            search=self.search,
            root=self.root,
            ttl_s=config.derived_ttl_s,
        )
        self._server_thread: Optional[threading.Thread] = None
        self._index_thread: Optional[threading.Thread] = None
        self._server = None

    def start(self) -> bool:
        try:
            self._apply_resource_limits()
            self.store.initialize()
            self._running = True

            self._index_thread = threading.Thread(target=self._index_loop, name="graphd-index", daemon=True)
            self._index_thread.start()

            handler = self._handler_factory()
            self._server = GraphdHTTPServer(self.config.host, self.config.port, handler)
            self._server_thread = threading.Thread(target=self._server.start, name="graphd-http", daemon=True)
            self._server_thread.start()

            self.logger.system_init("graphd", "ready", {"db_path": self.db_path, "root": self.root})
            return True
        except SchemaVersionError as exc:
            self.logger.error(
                f"Graphd schema version mismatch: found '{exc.found_version}', "
                f"expected '{exc.expected_version}'. Delete {exc.db_path} to recreate.",
                component="graphd",
                error=exc,
            )
            self._running = False
            return False
        except Exception as exc:
            self.logger.error(f"Graphd failed to start: {exc}", component="graphd", error=exc)
            self._running = False
            return False

    def stop(self) -> None:
        self._running = False
        if self._server:
            self._server.stop()
        self.store.close()

    def set_active(self, active: bool) -> None:
        self._active = active

    def set_paused(self, paused: bool) -> None:
        self._paused = paused

    def handle_health(self) -> Dict[str, Any]:
        return {
            "status": "ok" if self._running else "stopped",
            "version": GRAPH_D_VERSION,
            "schema_version": GRAPH_D_SCHEMA_VERSION,
            "root": self.root,
            "db_path": self.db_path,
            "active": self._active,
            "paused": self._paused,
            "stats": self.store.get_stats(),
            "cache": self.cache.stats(),
            "last_index": self._last_index_stats,
        }

    def handle_symbol(self, path: str, line: int) -> Dict[str, Any]:
        if not path or line <= 0:
            return {"error": "missing_path_or_line"}
        rel = normalize_path(path, self.root)
        if rel.startswith(".."):
            return {"error": "path_outside_root"}
        symbol = self.store.find_symbol_by_position(rel, line)
        return {"symbol": symbol, "path": rel}

    def handle_context(self, symbol_id: str, depth: int) -> Dict[str, Any]:
        symbol = self.store.get_symbol(symbol_id)
        if not symbol:
            return {"error": "symbol_not_found"}
        path = symbol.get("path")
        imports = self.store.get_imports_for_file(path)
        importers = self.store.get_importers_for_file(path)
        derived = [edge.to_dict() for edge in self.cache.get(symbol_id, "callers")]
        return {
            "symbol": symbol,
            "file": path,
            "module_edges": {"imports": imports, "imported_by": importers},
            "derived": {"callers": derived},
            "depth": depth,
        }

    def handle_impact(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        entity = payload.get("entity", {})
        if entity.get("path"):
            normalized = normalize_path(entity["path"], self.root)
            if normalized.startswith(".."):
                return {"error": "path_outside_root"}
            entity["path"] = normalized
            payload["entity"] = entity
        items = self.impact_engine.compute(payload)
        return {"items": [item.to_dict() for item in items]}

    def handle_search(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        pattern = payload.get("pattern", "")
        path = payload.get("path")
        max_results = int(payload.get("max_results", self.config.max_results))
        if not pattern:
            return {"items": []}
        searcher = RipgrepSearch(self.config.rg_path, self.config.enable_rg, max_results)
        paths = None
        if path:
            normalized = normalize_path(path, self.root)
            if normalized.startswith(".."):
                return {"error": "path_outside_root"}
            paths = [normalized]
        items = searcher.search(pattern, self.root, paths)
        return {"items": [item.__dict__ for item in items]}

    def handle_control(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if "paused" in payload:
            self._paused = bool(payload.get("paused"))
        if "active" in payload:
            self._active = bool(payload.get("active"))
        return {"active": self._active, "paused": self._paused}

    def handle_export(self, table: str, fmt: str) -> Dict[str, Any]:
        if not self.config.allow_export:
            return {"error": "export_disabled"}
        if fmt != "jsonl":
            return {"error": "unsupported_format"}
        try:
            data = self._export_jsonl(table)
            return {"format": "jsonl", "table": table, "data": data}
        except ValueError as exc:
            return {"error": str(exc)}

    def handle_artifact(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        path = payload.get("path")
        kind = payload.get("kind")
        details = payload.get("details", {})
        if not path or not kind:
            return {"error": "missing_path_or_kind"}
        rel = normalize_path(path, self.root)
        self.store.record_run_artifact(rel, kind, details, time.time())
        return {"status": "recorded"}

    def _index_loop(self) -> None:
        cycle_count = 0
        while self._running:
            if self._paused or (self._active and self.config.backpressure_when_active):
                time.sleep(self.config.index_interval_s)
                continue
            try:
                self._last_index_stats = self.indexer.scan_once()
                cycle_count += 1

                # Idle refinement
                if self.config.idle_refinement and not self._active:
                    self._refine_updated_files(self._last_index_stats.get("updated_paths", []))

                # Periodic stats logging
                if (
                    self.config.stats_log_interval_cycles > 0
                    and cycle_count % self.config.stats_log_interval_cycles == 0
                ):
                    self._log_stats(cycle_count)

                # Periodic vacuum (only when idle)
                if (
                    self.config.vacuum_interval_cycles > 0
                    and cycle_count % self.config.vacuum_interval_cycles == 0
                    and not self._active
                ):
                    self._run_vacuum()

            except Exception as exc:
                self.logger.error(f"Graphd index error: {exc}", component="graphd", error=exc)
            time.sleep(self.config.index_interval_s)

    def _log_stats(self, cycle_count: int) -> None:
        """Log periodic statistics for observability."""
        try:
            db_stats = self.store.get_stats()
            cache_stats = self.cache.stats()
            db_size = self.store.get_db_size_bytes()
            self.logger.info(
                f"Graphd stats: cycle={cycle_count} "
                f"files={db_stats.get('files', 0)} "
                f"symbols={db_stats.get('symbols', 0)} "
                f"edges={db_stats.get('module_edges', 0)} "
                f"cache_sets={cache_stats.get('cached_sets', 0)} "
                f"cache_edges={cache_stats.get('cached_edges', 0)} "
                f"db_size={db_size // 1024}KB",
                component="graphd",
            )
        except Exception as exc:
            self.logger.warning(f"Failed to log graphd stats: {exc}", component="graphd")

    def _run_vacuum(self) -> None:
        """Run SQLite VACUUM to reclaim space."""
        try:
            before_size = self.store.get_db_size_bytes()
            self.store.vacuum()
            after_size = self.store.get_db_size_bytes()
            saved = before_size - after_size
            if saved > 0:
                self.logger.info(
                    f"Graphd vacuum completed: {before_size // 1024}KB -> {after_size // 1024}KB "
                    f"(saved {saved // 1024}KB)",
                    component="graphd",
                )
            else:
                self.logger.debug("Graphd vacuum completed (no space reclaimed)", component="graphd")
        except Exception as exc:
            self.logger.warning(f"Graphd vacuum failed: {exc}", component="graphd")

    def _handler_factory(self):
        manager = self

        class Handler(GraphdRequestHandler):
            pass

        Handler.manager = manager
        return Handler

    def _resolve_db_path(self, db_path: str) -> str:
        if os.path.isabs(db_path):
            return db_path
        return os.path.abspath(os.path.join(self.root, db_path))

    def _export_jsonl(self, table: str) -> str:
        rows = self.store.export_table(table)
        return "\n".join(json.dumps(r) for r in rows)

    def _refine_updated_files(self, updated_paths: Any) -> None:
        if not updated_paths:
            return
        files = list(updated_paths)[: self.config.refine_max_files]
        for path in files:
            symbols = self.store.get_symbols_for_file(path)[: self.config.refine_max_symbols]
            for symbol in symbols:
                symbol_id = symbol.get("id")
                name = symbol.get("name")
                if not symbol_id or not name:
                    continue
                self.impact_engine.build_callers_cache(symbol_id, name, path)

    def _apply_resource_limits(self) -> None:
        """Apply process-level resource limits for graphd.

        Note: These affect the entire process (including all threads).
        nice() lowers scheduling priority, RLIMIT_AS caps address space.
        """
        if self.config.nice_level is not None:
            try:
                current = os.nice(0)
                os.nice(self.config.nice_level)
                self.logger.debug(
                    f"Applied nice level: {current} -> {current + self.config.nice_level}",
                    component="graphd"
                )
            except OSError as exc:
                self.logger.warning(
                    f"Failed to apply nice level {self.config.nice_level}: {exc}",
                    component="graphd"
                )
            except Exception as exc:
                self.logger.warning(
                    f"Unexpected error applying nice level: {exc}",
                    component="graphd"
                )

        if self.config.max_memory_mb:
            try:
                import resource
                limit = int(self.config.max_memory_mb) * 1024 * 1024
                resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
                self.logger.debug(
                    f"Applied memory limit: {self.config.max_memory_mb}MB",
                    component="graphd"
                )
            except ImportError:
                self.logger.warning(
                    "resource module not available (Windows?), skipping memory limit",
                    component="graphd"
                )
            except (ValueError, OSError) as exc:
                self.logger.warning(
                    f"Failed to apply memory limit {self.config.max_memory_mb}MB: {exc}",
                    component="graphd"
                )
            except Exception as exc:
                self.logger.warning(
                    f"Unexpected error applying memory limit: {exc}",
                    component="graphd"
                )
