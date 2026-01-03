"""SQLite-backed Tier A store for graphd."""

from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any, Dict, Iterable, List, Optional

from .constants import GRAPH_D_SCHEMA_VERSION
from .types import ExportDef, ModuleEdge, SymbolDef


class SchemaVersionError(Exception):
    """Raised when database schema version is incompatible."""

    def __init__(self, found_version: str, expected_version: str, db_path: str):
        self.found_version = found_version
        self.expected_version = expected_version
        self.db_path = db_path
        super().__init__(
            f"Database schema version mismatch: found '{found_version}', "
            f"expected '{expected_version}'. Delete {db_path} to recreate."
        )


class GraphStore:
    """Persistent, low-churn store of files, symbols, and module edges."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._conn:
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA synchronous=NORMAL;")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def initialize(self) -> None:
        """Initialize database schema and verify version compatibility.

        Raises:
            SchemaVersionError: If existing database has incompatible schema version
        """
        with self._lock:
            # Check if metadata table exists (indicates existing database)
            cursor = self._conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='graphd_metadata';"
            )
            metadata_exists = cursor.fetchone() is not None

            if metadata_exists:
                # Verify schema version
                row = self._conn.execute(
                    "SELECT value FROM graphd_metadata WHERE key = 'schema_version';"
                ).fetchone()
                if row:
                    found_version = row[0]
                    if found_version != GRAPH_D_SCHEMA_VERSION:
                        raise SchemaVersionError(
                            found_version, GRAPH_D_SCHEMA_VERSION, self.db_path
                        )

            # Create all tables (IF NOT EXISTS is idempotent)
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS graphd_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
                CREATE TABLE IF NOT EXISTS files (
                    path TEXT PRIMARY KEY,
                    lang TEXT,
                    hash TEXT,
                    mtime REAL
                );
                CREATE TABLE IF NOT EXISTS symbols (
                    id TEXT PRIMARY KEY,
                    path TEXT,
                    kind TEXT,
                    name TEXT,
                    qualname TEXT,
                    sig TEXT,
                    span_start INTEGER,
                    span_end INTEGER,
                    hash TEXT
                );
                CREATE TABLE IF NOT EXISTS module_edges (
                    src_path TEXT,
                    dst_path TEXT,
                    kind TEXT,
                    confidence REAL
                );
                CREATE TABLE IF NOT EXISTS exports (
                    path TEXT,
                    symbol_id TEXT,
                    kind TEXT,
                    confidence REAL
                );
                CREATE TABLE IF NOT EXISTS run_artifacts (
                    path TEXT,
                    kind TEXT,
                    details_json TEXT,
                    updated_at REAL
                );
                CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
                CREATE INDEX IF NOT EXISTS idx_edges_src ON module_edges(src_path);
                CREATE INDEX IF NOT EXISTS idx_edges_dst ON module_edges(dst_path);

                -- Session management tables (v2)
                CREATE TABLE IF NOT EXISTS sessions (
                    session_key TEXT PRIMARY KEY,
                    client_type TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    last_accessed_at REAL NOT NULL,
                    expires_at REAL,
                    working_dir TEXT,
                    status TEXT DEFAULT 'active',
                    metadata_json TEXT
                );

                CREATE TABLE IF NOT EXISTS conversation_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_key TEXT NOT NULL,
                    message_index INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    request_id TEXT,
                    created_at REAL NOT NULL,
                    metadata_json TEXT,
                    FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS context_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_key TEXT NOT NULL,
                    snapshot_version INTEGER NOT NULL,
                    created_at REAL NOT NULL,
                    context_json TEXT,
                    FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
                );

                -- Session indexes
                CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
                CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
                CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_messages(session_key);
                CREATE INDEX IF NOT EXISTS idx_conv_session_idx ON conversation_messages(session_key, message_index);
                CREATE INDEX IF NOT EXISTS idx_snapshot_session ON context_snapshots(session_key);
                CREATE INDEX IF NOT EXISTS idx_snapshot_session_ver ON context_snapshots(session_key, snapshot_version DESC);
                """
            )

            # Enable foreign key enforcement (required for CASCADE)
            self._conn.execute("PRAGMA foreign_keys = ON;")

            # Store schema version (upsert)
            self._conn.execute(
                "INSERT OR REPLACE INTO graphd_metadata (key, value) VALUES (?, ?);",
                ("schema_version", GRAPH_D_SCHEMA_VERSION),
            )
            self._conn.commit()

    def upsert_file(self, path: str, lang: str, hash_value: str, mtime: float) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO files (path, lang, hash, mtime) VALUES (?, ?, ?, ?);",
                (path, lang, hash_value, mtime),
            )
            self._conn.commit()

    def replace_symbols(self, path: str, symbols: Iterable[SymbolDef]) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM symbols WHERE path = ?;", (path,))
            self._conn.executemany(
                """
                INSERT INTO symbols (id, path, kind, name, qualname, sig, span_start, span_end, hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                """,
                [
                    (
                        s.id,
                        s.path,
                        s.kind,
                        s.name,
                        s.qualname,
                        s.sig,
                        s.span_start,
                        s.span_end,
                        s.hash,
                    )
                    for s in symbols
                ],
            )
            self._conn.commit()

    def replace_module_edges(self, path: str, edges: Iterable[ModuleEdge]) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM module_edges WHERE src_path = ?;", (path,))
            self._conn.executemany(
                """
                INSERT INTO module_edges (src_path, dst_path, kind, confidence)
                VALUES (?, ?, ?, ?);
                """,
                [(e.src_path, e.dst_path, e.kind, e.confidence) for e in edges],
            )
            self._conn.commit()

    def replace_exports(self, path: str, exports: Iterable[ExportDef]) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM exports WHERE path = ?;", (path,))
            self._conn.executemany(
                """
                INSERT INTO exports (path, symbol_id, kind, confidence)
                VALUES (?, ?, ?, ?);
                """,
                [(e.path, e.symbol_id, e.kind, e.confidence) for e in exports],
            )
            self._conn.commit()

    def upsert_bundle(
        self,
        path: str,
        lang: str,
        hash_value: str,
        mtime: float,
        symbols: Iterable[SymbolDef],
        edges: Iterable[ModuleEdge],
        exports: Iterable[ExportDef],
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO files (path, lang, hash, mtime) VALUES (?, ?, ?, ?);",
                (path, lang, hash_value, mtime),
            )
            self._conn.execute("DELETE FROM symbols WHERE path = ?;", (path,))
            self._conn.executemany(
                """
                INSERT INTO symbols (id, path, kind, name, qualname, sig, span_start, span_end, hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                """,
                [
                    (
                        s.id,
                        s.path,
                        s.kind,
                        s.name,
                        s.qualname,
                        s.sig,
                        s.span_start,
                        s.span_end,
                        s.hash,
                    )
                    for s in symbols
                ],
            )
            self._conn.execute("DELETE FROM module_edges WHERE src_path = ?;", (path,))
            self._conn.executemany(
                """
                INSERT INTO module_edges (src_path, dst_path, kind, confidence)
                VALUES (?, ?, ?, ?);
                """,
                [(e.src_path, e.dst_path, e.kind, e.confidence) for e in edges],
            )
            self._conn.execute("DELETE FROM exports WHERE path = ?;", (path,))
            self._conn.executemany(
                """
                INSERT INTO exports (path, symbol_id, kind, confidence)
                VALUES (?, ?, ?, ?);
                """,
                [(e.path, e.symbol_id, e.kind, e.confidence) for e in exports],
            )
            self._conn.commit()

    def remove_file(self, path: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM files WHERE path = ?;", (path,))
            self._conn.execute("DELETE FROM symbols WHERE path = ?;", (path,))
            self._conn.execute("DELETE FROM module_edges WHERE src_path = ?;", (path,))
            self._conn.execute("DELETE FROM module_edges WHERE dst_path = ?;", (path,))
            self._conn.execute("DELETE FROM exports WHERE path = ?;", (path,))
            self._conn.commit()

    def get_symbol(self, symbol_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM symbols WHERE id = ?;", (symbol_id,)
            ).fetchone()
            return dict(row) if row else None

    def find_symbol_by_position(self, path: str, line: int) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT * FROM symbols
                WHERE path = ? AND span_start <= ?
                ORDER BY span_start DESC
                LIMIT 1;
                """,
                (path, line),
            ).fetchone()
            return dict(row) if row else None

    def get_symbols_for_file(self, path: str) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM symbols WHERE path = ? ORDER BY span_start ASC;",
                (path,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_imports_for_file(self, path: str) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM module_edges WHERE src_path = ?;",
                (path,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_importers_for_file(self, path: str) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM module_edges WHERE dst_path = ?;",
                (path,),
            ).fetchall()
            return [dict(r) for r in rows]

    def record_run_artifact(self, path: str, kind: str, details: Dict[str, Any], updated_at: float) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO run_artifacts (path, kind, details_json, updated_at)
                VALUES (?, ?, ?, ?);
                """,
                (path, kind, json.dumps(details), updated_at),
            )
            self._conn.commit()

    def get_stats(self) -> Dict[str, Any]:
        with self._lock:
            files = self._conn.execute("SELECT COUNT(*) as c FROM files;").fetchone()["c"]
            symbols = self._conn.execute("SELECT COUNT(*) as c FROM symbols;").fetchone()["c"]
            edges = self._conn.execute("SELECT COUNT(*) as c FROM module_edges;").fetchone()["c"]
            exports = self._conn.execute("SELECT COUNT(*) as c FROM exports;").fetchone()["c"]
            return {
                "files": files,
                "symbols": symbols,
                "module_edges": edges,
                "exports": exports,
            }

    # Tables that can be exported via export_table()
    EXPORTABLE_TABLES = frozenset({"files", "symbols", "module_edges", "exports", "run_artifacts", "sessions", "conversation_messages"})

    def vacuum(self) -> None:
        """Rebuild database to reclaim space and defragment.

        Note: This locks the database briefly. Call during idle periods.
        """
        with self._lock:
            self._conn.execute("VACUUM;")

    def get_db_size_bytes(self) -> int:
        """Get the size of the database file in bytes."""
        import os
        try:
            return os.path.getsize(self.db_path)
        except OSError:
            return 0

    def export_table(self, table: str) -> List[Dict[str, Any]]:
        """Export all rows from a table.

        Args:
            table: Table name (must be in EXPORTABLE_TABLES whitelist)

        Returns:
            List of row dictionaries

        Raises:
            ValueError: If table name is not in whitelist (SQL injection protection)
        """
        if table not in self.EXPORTABLE_TABLES:
            raise ValueError(
                f"Invalid table name '{table}'. "
                f"Allowed tables: {', '.join(sorted(self.EXPORTABLE_TABLES))}"
            )
        with self._lock:
            # Safe: table name validated against whitelist above
            rows = self._conn.execute(f"SELECT * FROM {table};").fetchall()
            return [dict(r) for r in rows]

    # =========================================================================
    # Session Management Methods (v2)
    # =========================================================================

    def create_session(
        self,
        session_key: str,
        client_type: str,
        working_dir: Optional[str] = None,
        expires_at: Optional[float] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Create a new session.

        Args:
            session_key: Unique session identifier (format: {client_type}_{timestamp}_{uuid8})
            client_type: Type of client ('tui', 'voice', 'api')
            working_dir: Working directory for this session
            expires_at: Optional expiration timestamp (Unix time)
            metadata: Optional metadata dict

        Returns:
            True if session was created, False if session_key already exists
        """
        import time
        now = time.time()
        with self._lock:
            try:
                self._conn.execute(
                    """
                    INSERT INTO sessions (session_key, client_type, created_at, last_accessed_at,
                                         expires_at, working_dir, status, metadata_json)
                    VALUES (?, ?, ?, ?, ?, ?, 'active', ?);
                    """,
                    (
                        session_key,
                        client_type,
                        now,
                        now,
                        expires_at,
                        working_dir,
                        json.dumps(metadata) if metadata else None,
                    ),
                )
                self._conn.commit()
                return True
            except sqlite3.IntegrityError:
                # Session key already exists
                return False

    def get_session(self, session_key: str) -> Optional[Dict[str, Any]]:
        """Get session by key.

        Returns:
            Session dict with parsed metadata, or None if not found
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sessions WHERE session_key = ?;",
                (session_key,),
            ).fetchone()
            if not row:
                return None
            result = dict(row)
            # Parse metadata JSON
            if result.get("metadata_json"):
                try:
                    result["metadata"] = json.loads(result["metadata_json"])
                except json.JSONDecodeError:
                    result["metadata"] = None
            else:
                result["metadata"] = None
            return result

    def update_session_access(self, session_key: str) -> bool:
        """Update last_accessed_at timestamp for a session.

        Returns:
            True if session was updated, False if not found
        """
        import time
        with self._lock:
            cursor = self._conn.execute(
                "UPDATE sessions SET last_accessed_at = ? WHERE session_key = ? AND status = 'active';",
                (time.time(), session_key),
            )
            self._conn.commit()
            return cursor.rowcount > 0

    def update_session_status(self, session_key: str, status: str) -> bool:
        """Update session status.

        Args:
            session_key: Session to update
            status: New status ('active', 'expired', 'closed')

        Returns:
            True if updated, False if not found
        """
        with self._lock:
            cursor = self._conn.execute(
                "UPDATE sessions SET status = ? WHERE session_key = ?;",
                (status, session_key),
            )
            self._conn.commit()
            return cursor.rowcount > 0

    def update_session_metadata(
        self,
        session_key: str,
        metadata: Dict[str, Any],
        merge: bool = True,
    ) -> bool:
        """Update session metadata.

        Args:
            session_key: Session to update
            metadata: Metadata dict to store
            merge: If True, merge with existing metadata. If False, replace entirely.

        Returns:
            True if updated, False if not found
        """
        with self._lock:
            if merge:
                # Get existing metadata first
                row = self._conn.execute(
                    "SELECT metadata_json FROM sessions WHERE session_key = ?;",
                    (session_key,),
                ).fetchone()
                if not row:
                    return False
                existing = {}
                if row["metadata_json"]:
                    try:
                        existing = json.loads(row["metadata_json"])
                    except json.JSONDecodeError:
                        pass
                # Smart merge: for arrays like wizard_events, append instead of replace
                for key, value in metadata.items():
                    if isinstance(value, list) and isinstance(existing.get(key), list):
                        # Append new items to existing array
                        existing[key] = existing[key] + value
                    else:
                        existing[key] = value
                metadata = existing

            cursor = self._conn.execute(
                "UPDATE sessions SET metadata_json = ? WHERE session_key = ?;",
                (json.dumps(metadata), session_key),
            )
            self._conn.commit()
            return cursor.rowcount > 0

    def delete_session(self, session_key: str) -> bool:
        """Delete a session and all associated data (cascades to messages and snapshots).

        Returns:
            True if deleted, False if not found
        """
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM sessions WHERE session_key = ?;",
                (session_key,),
            )
            self._conn.commit()
            return cursor.rowcount > 0

    def list_sessions(
        self,
        client_type: Optional[str] = None,
        status: str = "active",
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """List sessions with optional filtering.

        Args:
            client_type: Filter by client type (None for all)
            status: Filter by status (default 'active')
            limit: Maximum number of sessions to return

        Returns:
            List of session dicts ordered by last_accessed_at DESC
        """
        with self._lock:
            if client_type:
                rows = self._conn.execute(
                    """
                    SELECT * FROM sessions
                    WHERE client_type = ? AND status = ?
                    ORDER BY last_accessed_at DESC
                    LIMIT ?;
                    """,
                    (client_type, status, limit),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """
                    SELECT * FROM sessions
                    WHERE status = ?
                    ORDER BY last_accessed_at DESC
                    LIMIT ?;
                    """,
                    (status, limit),
                ).fetchall()
            return [dict(r) for r in rows]

    def cleanup_expired_sessions(self) -> int:
        """Delete sessions that have passed their expires_at timestamp.

        Returns:
            Number of sessions deleted
        """
        import time
        with self._lock:
            # First mark as expired
            self._conn.execute(
                """
                UPDATE sessions SET status = 'expired'
                WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'active';
                """,
                (time.time(),),
            )
            # Then delete expired sessions (CASCADE will clean up related data)
            cursor = self._conn.execute(
                "DELETE FROM sessions WHERE status = 'expired';",
            )
            self._conn.commit()
            return cursor.rowcount

    # =========================================================================
    # Conversation Message Methods
    # =========================================================================

    def add_message(
        self,
        session_key: str,
        role: str,
        content: str,
        request_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> int:
        """Add a message to a session's conversation history.

        Args:
            session_key: Session to add message to
            role: Message role ('user', 'assistant', 'system')
            content: Message content
            request_id: Optional request ID for tracing
            metadata: Optional metadata (tools_used, duration_ms, etc.)

        Returns:
            The message_index of the new message

        Raises:
            ValueError: If session doesn't exist
        """
        import time
        with self._lock:
            # Get next message index for this session
            row = self._conn.execute(
                "SELECT COALESCE(MAX(message_index), -1) + 1 as next_idx FROM conversation_messages WHERE session_key = ?;",
                (session_key,),
            ).fetchone()
            next_idx = row["next_idx"]

            try:
                self._conn.execute(
                    """
                    INSERT INTO conversation_messages
                    (session_key, message_index, role, content, request_id, created_at, metadata_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?);
                    """,
                    (
                        session_key,
                        next_idx,
                        role,
                        content,
                        request_id,
                        time.time(),
                        json.dumps(metadata) if metadata else None,
                    ),
                )
                self._conn.commit()
                return next_idx
            except sqlite3.IntegrityError as e:
                raise ValueError(f"Session '{session_key}' does not exist") from e

    def get_messages(
        self,
        session_key: str,
        limit: int = 100,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        """Get conversation messages for a session.

        Args:
            session_key: Session to get messages for
            limit: Maximum messages to return
            offset: Number of messages to skip (from the start)

        Returns:
            List of message dicts ordered by message_index ASC
        """
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM conversation_messages
                WHERE session_key = ?
                ORDER BY message_index ASC
                LIMIT ? OFFSET ?;
                """,
                (session_key, limit, offset),
            ).fetchall()

            results = []
            for row in rows:
                msg = dict(row)
                if msg.get("metadata_json"):
                    try:
                        msg["metadata"] = json.loads(msg["metadata_json"])
                    except json.JSONDecodeError:
                        msg["metadata"] = None
                else:
                    msg["metadata"] = None
                results.append(msg)
            return results

    def get_message_count(self, session_key: str) -> int:
        """Get total number of messages in a session."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) as count FROM conversation_messages WHERE session_key = ?;",
                (session_key,),
            ).fetchone()
            return row["count"]

    def clear_messages(self, session_key: str) -> int:
        """Delete all messages for a session.

        Returns:
            Number of messages deleted
        """
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM conversation_messages WHERE session_key = ?;",
                (session_key,),
            )
            self._conn.commit()
            return cursor.rowcount

    # =========================================================================
    # Context Snapshot Methods
    # =========================================================================

    def save_context_snapshot(
        self,
        session_key: str,
        context_data: Dict[str, Any],
    ) -> int:
        """Save a context window snapshot for a session.

        Creates a new version. Old versions are kept for history.

        Args:
            session_key: Session to save snapshot for
            context_data: Context data to serialize

        Returns:
            The snapshot version number

        Raises:
            ValueError: If session doesn't exist
        """
        import time
        with self._lock:
            # Get next version number
            row = self._conn.execute(
                "SELECT COALESCE(MAX(snapshot_version), 0) + 1 as next_ver FROM context_snapshots WHERE session_key = ?;",
                (session_key,),
            ).fetchone()
            next_ver = row["next_ver"]

            try:
                self._conn.execute(
                    """
                    INSERT INTO context_snapshots
                    (session_key, snapshot_version, created_at, context_json)
                    VALUES (?, ?, ?, ?);
                    """,
                    (
                        session_key,
                        next_ver,
                        time.time(),
                        json.dumps(context_data),
                    ),
                )
                self._conn.commit()
                return next_ver
            except sqlite3.IntegrityError as e:
                raise ValueError(f"Session '{session_key}' does not exist") from e

    def get_latest_context_snapshot(self, session_key: str) -> Optional[Dict[str, Any]]:
        """Get the most recent context snapshot for a session.

        Returns:
            Dict with snapshot data and parsed context, or None if no snapshots exist
        """
        with self._lock:
            row = self._conn.execute(
                """
                SELECT * FROM context_snapshots
                WHERE session_key = ?
                ORDER BY snapshot_version DESC
                LIMIT 1;
                """,
                (session_key,),
            ).fetchone()

            if not row:
                return None

            result = dict(row)
            if result.get("context_json"):
                try:
                    result["context"] = json.loads(result["context_json"])
                except json.JSONDecodeError:
                    result["context"] = None
            else:
                result["context"] = None
            return result

    def get_context_snapshot_by_version(
        self,
        session_key: str,
        version: int,
    ) -> Optional[Dict[str, Any]]:
        """Get a specific version of a context snapshot.

        Returns:
            Snapshot dict with parsed context, or None if not found
        """
        with self._lock:
            row = self._conn.execute(
                """
                SELECT * FROM context_snapshots
                WHERE session_key = ? AND snapshot_version = ?;
                """,
                (session_key, version),
            ).fetchone()

            if not row:
                return None

            result = dict(row)
            if result.get("context_json"):
                try:
                    result["context"] = json.loads(result["context_json"])
                except json.JSONDecodeError:
                    result["context"] = None
            else:
                result["context"] = None
            return result

    def list_context_snapshots(
        self,
        session_key: str,
        limit: int = 10,
    ) -> List[Dict[str, Any]]:
        """List context snapshots for a session (most recent first).

        Returns:
            List of snapshot metadata (without full context_json for efficiency)
        """
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, session_key, snapshot_version, created_at
                FROM context_snapshots
                WHERE session_key = ?
                ORDER BY snapshot_version DESC
                LIMIT ?;
                """,
                (session_key, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def cleanup_old_snapshots(self, session_key: str, keep_count: int = 5) -> int:
        """Delete old snapshots, keeping only the most recent N.

        Args:
            session_key: Session to clean up
            keep_count: Number of most recent snapshots to keep

        Returns:
            Number of snapshots deleted
        """
        with self._lock:
            # Get IDs to keep
            keep_ids = self._conn.execute(
                """
                SELECT id FROM context_snapshots
                WHERE session_key = ?
                ORDER BY snapshot_version DESC
                LIMIT ?;
                """,
                (session_key, keep_count),
            ).fetchall()

            if not keep_ids:
                return 0

            keep_id_list = [r["id"] for r in keep_ids]
            placeholders = ",".join("?" * len(keep_id_list))

            cursor = self._conn.execute(
                f"""
                DELETE FROM context_snapshots
                WHERE session_key = ? AND id NOT IN ({placeholders});
                """,
                [session_key] + keep_id_list,
            )
            self._conn.commit()
            return cursor.rowcount
