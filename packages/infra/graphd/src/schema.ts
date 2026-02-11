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
 * v3: Added session_events table for real-time event persistence
 * v4: Added SIAS kernel persistence tables
 * v5: Added auth tables (users, user_sessions, provider_credentials)
 * v6: Enriched sessions table with workflow fields (goal, current_work_item_id, current_objective)
 *
 * MUST match Python GRAPH_D_SCHEMA_VERSION
 */
export const GRAPHD_SCHEMA_VERSION = 'v6';

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

-- Session management tables (v2, enriched in v6)
CREATE TABLE IF NOT EXISTS sessions (
    session_key TEXT PRIMARY KEY,
    client_type TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_accessed_at REAL NOT NULL,
    expires_at REAL,
    working_dir TEXT,
    status TEXT DEFAULT 'active',
    metadata_json TEXT,
    -- Workflow fields (v6)
    goal TEXT,
    current_work_item_id TEXT,
    current_objective TEXT
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

-- Session events table (v3) - for real-time event persistence
CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    request_id TEXT,
    event_type TEXT NOT NULL,
    step_num INTEGER,
    timestamp REAL NOT NULL,
    data_json TEXT,
    FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
);

-- Session events indexes
CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_key);
CREATE INDEX IF NOT EXISTS idx_events_session_request ON session_events(session_key, request_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON session_events(timestamp DESC);

-- SIAS tables (v4)
CREATE TABLE IF NOT EXISTS sias_sessions (
    session_id TEXT PRIMARY KEY,
    started_at REAL NOT NULL,
    last_checkpoint_at REAL NOT NULL,
    iteration_count INTEGER NOT NULL,
    status TEXT NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS sias_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    iteration INTEGER NOT NULL,
    created_at REAL NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sias_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sias_patches (
    patch_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    timestamp REAL NOT NULL,
    objective TEXT,
    reasoning TEXT,
    files_changed_json TEXT,
    diff_summary TEXT,
    status TEXT NOT NULL,
    rollback_reason TEXT,
    benchmark_before_json TEXT,
    benchmark_after_json TEXT,
    test_summary_json TEXT,
    FOREIGN KEY (session_id) REFERENCES sias_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sias_decisions (
    decision_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    agent TEXT NOT NULL,
    decision_type TEXT NOT NULL,
    reasoning TEXT,
    outcome TEXT,
    related_decisions_json TEXT,
    created_at REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sias_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sias_principal_context (
    session_id TEXT PRIMARY KEY,
    patch_summary TEXT,
    current_focus TEXT,
    learned_constraints_json TEXT,
    horizon_objectives_json TEXT,
    last_updated REAL NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sias_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sias_health_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    captured_at REAL NOT NULL,
    metrics_json TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sias_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sias_benchmark_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    started_at REAL NOT NULL,
    completed_at REAL NOT NULL,
    score REAL NOT NULL,
    result_json TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sias_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sias_worktrees (
    version TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    promoted_at REAL,
    archived_at REAL,
    iterations_run INTEGER,
    benchmark_score REAL,
    failure_count INTEGER,
    failure_reason TEXT,
    failure_iteration INTEGER,
    git_commit TEXT,
    patches_included_json TEXT,
    benchmark_scores_json TEXT
);

CREATE TABLE IF NOT EXISTS sias_decision_embeddings (
    decision_id TEXT PRIMARY KEY,
    embedding_json TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sias_checkpoints_session ON sias_checkpoints(session_id);
CREATE INDEX IF NOT EXISTS idx_sias_patches_session ON sias_patches(session_id);
CREATE INDEX IF NOT EXISTS idx_sias_decisions_session ON sias_decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_sias_health_session ON sias_health_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_sias_bench_session ON sias_benchmark_runs(session_id);

-- Auth tables (v5)

-- Users table (Google OAuth)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    picture_url TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

-- Device sessions (persistent login tokens)
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_name TEXT,
    created_at REAL NOT NULL,
    last_used_at REAL NOT NULL,
    expires_at REAL,
    revoked INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Encrypted provider credentials (API keys)
CREATE TABLE IF NOT EXISTS provider_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, provider)
);

-- Auth indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_revoked ON user_sessions(revoked);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_user_id ON provider_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_user_provider ON provider_credentials(user_id, provider);
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
  'session_events',
  'sias_sessions',
  'sias_checkpoints',
  'sias_patches',
  'sias_decisions',
  'sias_principal_context',
  'sias_health_snapshots',
  'sias_benchmark_runs',
  'sias_worktrees',
  'sias_decision_embeddings',
  'users',
  'user_sessions',
  'provider_credentials',
]);

/**
 * Check if a table name is valid for export.
 */
export function isExportableTable(table: string): boolean {
  return EXPORTABLE_TABLES.has(table);
}

/**
 * Migration statements for v6 (add workflow fields to sessions).
 * These are run individually with error handling for existing columns.
 */
export const V6_MIGRATION_STATEMENTS = [
  'ALTER TABLE sessions ADD COLUMN goal TEXT;',
  'ALTER TABLE sessions ADD COLUMN current_work_item_id TEXT;',
  'ALTER TABLE sessions ADD COLUMN current_objective TEXT;',
];
