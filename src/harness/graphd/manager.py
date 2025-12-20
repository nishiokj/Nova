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

    # =========================================================================
    # Session Management Methods (v2)
    # =========================================================================

    def session_create(
        self,
        session_key: str,
        client_type: str,
        working_dir: Optional[str] = None,
        expires_at: Optional[float] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Create a new session.

        Args:
            session_key: Unique session identifier
            client_type: Type of client ('tui', 'voice', 'api')
            working_dir: Working directory for this session
            expires_at: Optional expiration timestamp
            metadata: Optional metadata dict

        Returns:
            Dict with 'success' bool and 'session_key' or 'error'
        """
        try:
            created = self.store.create_session(
                session_key=session_key,
                client_type=client_type,
                working_dir=working_dir,
                expires_at=expires_at,
                metadata=metadata,
            )
            if created:
                return {"success": True, "session_key": session_key}
            else:
                return {"success": False, "error": "session_key_exists"}
        except Exception as exc:
            self.logger.warning(f"Session create failed: {exc}", component="graphd")
            return {"success": False, "error": str(exc)}

    def session_get(self, session_key: str) -> Dict[str, Any]:
        """Get session by key.

        Returns:
            Session data dict or {"error": "..."} if not found
        """
        try:
            session = self.store.get_session(session_key)
            if session:
                return {"session": session}
            else:
                return {"error": "session_not_found", "session_key": session_key}
        except Exception as exc:
            self.logger.warning(f"Session get failed: {exc}", component="graphd")
            return {"error": str(exc)}

    def session_touch(self, session_key: str, working_dir: Optional[str] = None) -> Dict[str, Any]:
        """Update last_accessed_at timestamp for a session, creating it if needed.

        This is an upsert operation: if the session doesn't exist, it will be created.

        Args:
            session_key: Session key (format: {client_type}_{timestamp}_{uuid8})
            working_dir: Working directory for new sessions

        Returns:
            Dict with 'success' bool and 'created' bool if new session was created
        """
        try:
            updated = self.store.update_session_access(session_key)
            if updated:
                return {"success": True, "created": False}

            # Session doesn't exist - create it
            # Extract client_type from session_key (e.g., "tui_1766172870_abc123" -> "tui")
            parts = session_key.split("_")
            client_type = parts[0] if parts else "unknown"

            created = self.store.create_session(
                session_key=session_key,
                client_type=client_type,
                working_dir=working_dir,
            )
            if created:
                self.logger.info(f"Auto-created session: {session_key}", component="graphd")
                return {"success": True, "created": True}
            else:
                # Race condition: session was created by another process
                return {"success": True, "created": False}

        except Exception as exc:
            self.logger.warning(f"Session touch failed: {exc}", component="graphd")
            return {"success": False, "error": str(exc)}

    def session_close(self, session_key: str) -> Dict[str, Any]:
        """Mark a session as closed.

        Returns:
            Dict with 'success' bool
        """
        try:
            updated = self.store.update_session_status(session_key, "closed")
            return {"success": updated}
        except Exception as exc:
            self.logger.warning(f"Session close failed: {exc}", component="graphd")
            return {"success": False, "error": str(exc)}

    def session_delete(self, session_key: str) -> Dict[str, Any]:
        """Delete a session and all associated data.

        Returns:
            Dict with 'success' bool
        """
        try:
            deleted = self.store.delete_session(session_key)
            return {"success": deleted}
        except Exception as exc:
            self.logger.warning(f"Session delete failed: {exc}", component="graphd")
            return {"success": False, "error": str(exc)}

    def sessions_list(
        self,
        client_type: Optional[str] = None,
        status: str = "active",
        limit: int = 50,
    ) -> Dict[str, Any]:
        """List sessions with optional filtering.

        Returns:
            Dict with 'sessions' list
        """
        try:
            sessions = self.store.list_sessions(client_type, status, limit)
            return {"sessions": sessions}
        except Exception as exc:
            self.logger.warning(f"Sessions list failed: {exc}", component="graphd")
            return {"sessions": [], "error": str(exc)}

    def sessions_cleanup(self) -> Dict[str, Any]:
        """Delete expired sessions.

        Returns:
            Dict with 'deleted_count' int
        """
        try:
            count = self.store.cleanup_expired_sessions()
            return {"deleted_count": count}
        except Exception as exc:
            self.logger.warning(f"Sessions cleanup failed: {exc}", component="graphd")
            return {"deleted_count": 0, "error": str(exc)}

    # =========================================================================
    # Conversation Message Methods
    # =========================================================================

    def message_add(
        self,
        session_key: str,
        role: str,
        content: str,
        request_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Add a message to a session's conversation history.

        Returns:
            Dict with 'message_index' or 'error'
        """
        try:
            message_index = self.store.add_message(
                session_key=session_key,
                role=role,
                content=content,
                request_id=request_id,
                metadata=metadata,
            )
            return {"success": True, "message_index": message_index}
        except ValueError as exc:
            return {"success": False, "error": str(exc)}
        except Exception as exc:
            self.logger.warning(f"Message add failed: {exc}", component="graphd")
            return {"success": False, "error": str(exc)}

    def messages_get(
        self,
        session_key: str,
        limit: int = 100,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Get conversation messages for a session.

        Returns:
            Dict with 'messages' list
        """
        try:
            messages = self.store.get_messages(session_key, limit, offset)
            return {"messages": messages}
        except Exception as exc:
            self.logger.warning(f"Messages get failed: {exc}", component="graphd")
            return {"messages": [], "error": str(exc)}

    def messages_clear(self, session_key: str) -> Dict[str, Any]:
        """Clear all messages for a session.

        Returns:
            Dict with 'deleted_count'
        """
        try:
            count = self.store.clear_messages(session_key)
            return {"deleted_count": count}
        except Exception as exc:
            self.logger.warning(f"Messages clear failed: {exc}", component="graphd")
            return {"deleted_count": 0, "error": str(exc)}

    # =========================================================================
    # Context Snapshot Methods
    # =========================================================================

    def context_save(
        self,
        session_key: str,
        context_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Save a context window snapshot for a session.

        Returns:
            Dict with 'snapshot_version' or 'error'
        """
        try:
            version = self.store.save_context_snapshot(session_key, context_data)
            # Cleanup old snapshots to prevent unbounded growth
            self.store.cleanup_old_snapshots(session_key, keep_count=5)
            return {"success": True, "snapshot_version": version}
        except ValueError as exc:
            return {"success": False, "error": str(exc)}
        except Exception as exc:
            self.logger.warning(f"Context save failed: {exc}", component="graphd")
            return {"success": False, "error": str(exc)}

    def context_get(self, session_key: str) -> Dict[str, Any]:
        """Get the latest context snapshot for a session.

        Returns:
            Dict with 'snapshot' or 'error'
        """
        try:
            snapshot = self.store.get_latest_context_snapshot(session_key)
            if snapshot:
                return {"snapshot": snapshot}
            else:
                return {"snapshot": None}
        except Exception as exc:
            self.logger.warning(f"Context get failed: {exc}", component="graphd")
            return {"snapshot": None, "error": str(exc)}

    def context_list(self, session_key: str, limit: int = 10) -> Dict[str, Any]:
        """List context snapshots for a session.

        Returns:
            Dict with 'snapshots' list (metadata only, no full context)
        """
        try:
            snapshots = self.store.list_context_snapshots(session_key, limit)
            return {"snapshots": snapshots}
        except Exception as exc:
            self.logger.warning(f"Context list failed: {exc}", component="graphd")
            return {"snapshots": [], "error": str(exc)}
