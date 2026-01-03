/**
 * GraphD database schema.
 *
 * DDL statements for SQLite database.
 * Must match Python version in src/harness/graphd/store.py
 */

// ============================================
// SCHEMA VERSION
// ============================================

/**
 * Schema version - bump when adding/modifying tables.
 * v1: Initial schema (files, symbols, module_edges, exports, run_artifacts)
 * v2: Added session management tables (sessions, conversation_messages, context_snapshots)
 *
 * MUST match Python GRAPH_D_SCHEMA_VERSION
 */
export const GRAPHD_SCHEMA_VERSION = 'v2';

/**
 * GraphD version string.
 */
export const GRAPHD_VERSION = '0.1.0';

// ============================================
// DDL STATEMENTS
// ============================================

/**
 * DDL for creating all GraphD tables.
 */
export const GRAPHD_SCHEMA_DDL = `
-- Metadata table for version tracking
CREATE TABLE IF NOT EXISTS graphd_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Files table
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    lang TEXT,
    hash TEXT,
    mtime REAL
);

-- Symbols table (functions, classes, methods, etc.)
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

-- Module edges (import relationships)
CREATE TABLE IF NOT EXISTS module_edges (
    src_path TEXT,
    dst_path TEXT,
    kind TEXT,
    confidence REAL
);

-- Exports (module exports)
CREATE TABLE IF NOT EXISTS exports (
    path TEXT,
    symbol_id TEXT,
    kind TEXT,
    confidence REAL
);

-- Run artifacts (test results, build outputs)
CREATE TABLE IF NOT EXISTS run_artifacts (
    path TEXT,
    kind TEXT,
    details_json TEXT,
    updated_at REAL
);

-- Indexes for symbols and edges
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
`;

/**
 * SQL for enabling foreign key enforcement.
 */
export const ENABLE_FOREIGN_KEYS = 'PRAGMA foreign_keys = ON;';

/**
 * SQL for WAL mode (better concurrent reads).
 */
export const ENABLE_WAL = 'PRAGMA journal_mode=WAL;';

/**
 * SQL for synchronous mode (faster writes).
 */
export const ENABLE_NORMAL_SYNC = 'PRAGMA synchronous=NORMAL;';

/**
 * Tables that can be exported via export_table().
 */
export const EXPORTABLE_TABLES = new Set([
  'files',
  'symbols',
  'module_edges',
  'exports',
  'run_artifacts',
  'sessions',
  'conversation_messages',
]);

/**
 * Check if a table name is valid for export.
 */
export function isExportableTable(table: string): boolean {
  return EXPORTABLE_TABLES.has(table);
}
