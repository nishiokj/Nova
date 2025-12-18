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
                """
            )

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
    EXPORTABLE_TABLES = frozenset({"files", "symbols", "module_edges", "exports", "run_artifacts"})

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
