/**
 * SQLite-backed GraphD store.
 *
 * Ported from: src/harness/graphd/store.py
 *
 * Uses better-sqlite3 for synchronous SQLite operations.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'fs';
import { dirname } from 'path';
import {
  GRAPHD_SCHEMA_VERSION,
  GRAPHD_SCHEMA_DDL,
  ENABLE_FOREIGN_KEYS,
  ENABLE_WAL,
  ENABLE_NORMAL_SYNC,
  EXPORTABLE_TABLES,
  isExportableTable,
} from './schema.js';
import type {
  SymbolDef,
  ModuleEdge,
  ExportDef,
  FileRecord,
  GraphDSession,
  GraphDMessage,
  GraphDContextSnapshot,
  GraphDStats,
} from './types.js';
import { nowSeconds, safeJsonParse } from './utils.js';

// ============================================
// ERRORS
// ============================================

/**
 * Error thrown when database schema version is incompatible.
 */
export class SchemaVersionError extends Error {
  constructor(
    public readonly foundVersion: string,
    public readonly expectedVersion: string,
    public readonly dbPath: string
  ) {
    super(
      `Database schema version mismatch: found '${foundVersion}', ` +
        `expected '${expectedVersion}'. Delete ${dbPath} to recreate.`
    );
    this.name = 'SchemaVersionError';
  }
}

// ============================================
// GRAPH STORE
// ============================================

/**
 * Persistent, low-churn store of files, symbols, and module edges.
 */
export class GraphStore {
  private db: DatabaseType;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(dbPath);

    // Enable WAL mode for concurrent reads
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Initialize database schema and verify version compatibility.
   */
  initialize(): void {
    // Check if metadata table exists (indicates existing database)
    const metadataExists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='graphd_metadata';"
      )
      .get();

    if (metadataExists) {
      // Verify schema version
      const row = this.db
        .prepare("SELECT value FROM graphd_metadata WHERE key = 'schema_version';")
        .get() as { value: string } | undefined;

      if (row && row.value !== GRAPHD_SCHEMA_VERSION) {
        throw new SchemaVersionError(row.value, GRAPHD_SCHEMA_VERSION, this.dbPath);
      }
    }

    // Create all tables (IF NOT EXISTS is idempotent)
    this.db.exec(GRAPHD_SCHEMA_DDL);

    // Enable foreign key enforcement
    this.db.exec(ENABLE_FOREIGN_KEYS);

    // Store schema version (upsert)
    this.db
      .prepare(
        'INSERT OR REPLACE INTO graphd_metadata (key, value) VALUES (?, ?);'
      )
      .run('schema_version', GRAPHD_SCHEMA_VERSION);
  }

  // =========================================================================
  // File Operations
  // =========================================================================

  /**
   * Upsert a file record.
   */
  upsertFile(path: string, lang: string, hashValue: string, mtime: number): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO files (path, lang, hash, mtime) VALUES (?, ?, ?, ?);'
      )
      .run(path, lang, hashValue, mtime);
  }

  /**
   * Remove a file and all associated data.
   */
  removeFile(path: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE path = ?;').run(path);
      this.db.prepare('DELETE FROM symbols WHERE path = ?;').run(path);
      this.db.prepare('DELETE FROM module_edges WHERE src_path = ?;').run(path);
      this.db.prepare('DELETE FROM module_edges WHERE dst_path = ?;').run(path);
      this.db.prepare('DELETE FROM exports WHERE path = ?;').run(path);
    });
    transaction();
  }

  /**
   * Get a file record by path.
   */
  getFile(path: string): FileRecord | null {
    const row = this.db
      .prepare('SELECT * FROM files WHERE path = ?;')
      .get(path) as FileRecord | undefined;
    return row ?? null;
  }

  // =========================================================================
  // Symbol Operations
  // =========================================================================

  /**
   * Replace all symbols for a file.
   */
  replaceSymbols(path: string, symbols: SymbolDef[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM symbols WHERE path = ?;').run(path);

      const insert = this.db.prepare(
        `INSERT INTO symbols (id, path, kind, name, qualname, sig, span_start, span_end, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`
      );

      for (const s of symbols) {
        insert.run(
          s.id,
          s.path,
          s.kind,
          s.name,
          s.qualname,
          s.sig,
          s.spanStart,
          s.spanEnd,
          s.hash
        );
      }
    });
    transaction();
  }

  /**
   * Get a symbol by ID.
   */
  getSymbol(symbolId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare('SELECT * FROM symbols WHERE id = ?;')
      .get(symbolId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  /**
   * Find symbol by file path and line number.
   */
  findSymbolByPosition(path: string, line: number): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        `SELECT * FROM symbols
         WHERE path = ? AND span_start <= ?
         ORDER BY span_start DESC
         LIMIT 1;`
      )
      .get(path, line) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  /**
   * Get all symbols for a file.
   */
  getSymbolsForFile(path: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM symbols WHERE path = ? ORDER BY span_start ASC;')
      .all(path) as Record<string, unknown>[];
  }

  // =========================================================================
  // Module Edge Operations
  // =========================================================================

  /**
   * Replace all module edges for a source file.
   */
  replaceModuleEdges(path: string, edges: ModuleEdge[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM module_edges WHERE src_path = ?;').run(path);

      const insert = this.db.prepare(
        `INSERT INTO module_edges (src_path, dst_path, kind, confidence)
         VALUES (?, ?, ?, ?);`
      );

      for (const e of edges) {
        insert.run(e.srcPath, e.dstPath, e.kind, e.confidence);
      }
    });
    transaction();
  }

  /**
   * Get imports for a file (what this file imports).
   */
  getImportsForFile(path: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM module_edges WHERE src_path = ?;')
      .all(path) as Record<string, unknown>[];
  }

  /**
   * Get importers of a file (what imports this file).
   */
  getImportersForFile(path: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM module_edges WHERE dst_path = ?;')
      .all(path) as Record<string, unknown>[];
  }

  // =========================================================================
  // Export Operations
  // =========================================================================

  /**
   * Replace all exports for a file.
   */
  replaceExports(path: string, exports: ExportDef[]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM exports WHERE path = ?;').run(path);

      const insert = this.db.prepare(
        `INSERT INTO exports (path, symbol_id, kind, confidence)
         VALUES (?, ?, ?, ?);`
      );

      for (const e of exports) {
        insert.run(e.path, e.symbolId, e.kind, e.confidence);
      }
    });
    transaction();
  }

  // =========================================================================
  // Bundle Operations (atomic file + symbols + edges + exports)
  // =========================================================================

  /**
   * Upsert a file with all its symbols, edges, and exports atomically.
   */
  upsertBundle(
    path: string,
    lang: string,
    hashValue: string,
    mtime: number,
    symbols: SymbolDef[],
    edges: ModuleEdge[],
    exports: ExportDef[]
  ): void {
    const transaction = this.db.transaction(() => {
      // Upsert file
      this.db
        .prepare(
          'INSERT OR REPLACE INTO files (path, lang, hash, mtime) VALUES (?, ?, ?, ?);'
        )
        .run(path, lang, hashValue, mtime);

      // Replace symbols
      this.db.prepare('DELETE FROM symbols WHERE path = ?;').run(path);
      const insertSymbol = this.db.prepare(
        `INSERT INTO symbols (id, path, kind, name, qualname, sig, span_start, span_end, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`
      );
      for (const s of symbols) {
        insertSymbol.run(
          s.id,
          s.path,
          s.kind,
          s.name,
          s.qualname,
          s.sig,
          s.spanStart,
          s.spanEnd,
          s.hash
        );
      }

      // Replace edges
      this.db.prepare('DELETE FROM module_edges WHERE src_path = ?;').run(path);
      const insertEdge = this.db.prepare(
        `INSERT INTO module_edges (src_path, dst_path, kind, confidence)
         VALUES (?, ?, ?, ?);`
      );
      for (const e of edges) {
        insertEdge.run(e.srcPath, e.dstPath, e.kind, e.confidence);
      }

      // Replace exports
      this.db.prepare('DELETE FROM exports WHERE path = ?;').run(path);
      const insertExport = this.db.prepare(
        `INSERT INTO exports (path, symbol_id, kind, confidence)
         VALUES (?, ?, ?, ?);`
      );
      for (const e of exports) {
        insertExport.run(e.path, e.symbolId, e.kind, e.confidence);
      }
    });
    transaction();
  }

  // =========================================================================
  // Run Artifact Operations
  // =========================================================================

  /**
   * Record a run artifact (test result, build output, etc.).
   */
  recordRunArtifact(
    path: string,
    kind: string,
    details: Record<string, unknown>,
    updatedAt: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO run_artifacts (path, kind, details_json, updated_at)
         VALUES (?, ?, ?, ?);`
      )
      .run(path, kind, JSON.stringify(details), updatedAt);
  }

  // =========================================================================
  // Stats & Maintenance
  // =========================================================================

  /**
   * Get database statistics.
   */
  getStats(): GraphDStats {
    const files = (
      this.db.prepare('SELECT COUNT(*) as c FROM files;').get() as { c: number }
    ).c;
    const symbols = (
      this.db.prepare('SELECT COUNT(*) as c FROM symbols;').get() as { c: number }
    ).c;
    const moduleEdges = (
      this.db.prepare('SELECT COUNT(*) as c FROM module_edges;').get() as {
        c: number;
      }
    ).c;
    const exports = (
      this.db.prepare('SELECT COUNT(*) as c FROM exports;').get() as { c: number }
    ).c;

    return { files, symbols, moduleEdges, exports };
  }

  /**
   * Get database file size in bytes.
   */
  getDbSizeBytes(): number {
    try {
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Rebuild database to reclaim space and defragment.
   */
  vacuum(): void {
    this.db.exec('VACUUM;');
  }

  /**
   * Export all rows from a table.
   */
  exportTable(table: string): Record<string, unknown>[] {
    if (!isExportableTable(table)) {
      throw new Error(
        `Invalid table name '${table}'. ` +
          `Allowed tables: ${Array.from(EXPORTABLE_TABLES).sort().join(', ')}`
      );
    }
    // Safe: table name validated against whitelist above
    return this.db.prepare(`SELECT * FROM ${table};`).all() as Record<
      string,
      unknown
    >[];
  }

  // =========================================================================
  // Session Management Methods (v2)
  // =========================================================================

  /**
   * Create a new session.
   */
  createSession(
    sessionKey: string,
    clientType: string,
    workingDir?: string,
    expiresAt?: number,
    metadata?: Record<string, unknown>
  ): boolean {
    const now = nowSeconds();
    try {
      this.db
        .prepare(
          `INSERT INTO sessions (session_key, client_type, created_at, last_accessed_at,
                                 expires_at, working_dir, status, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?);`
        )
        .run(
          sessionKey,
          clientType,
          now,
          now,
          expiresAt ?? null,
          workingDir ?? null,
          metadata ? JSON.stringify(metadata) : null
        );
      return true;
    } catch (err) {
      // Session key already exists (UNIQUE constraint)
      if ((err as Error).message.includes('UNIQUE constraint')) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Get session by key.
   */
  getSession(sessionKey: string): GraphDSession | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE session_key = ?;')
      .get(sessionKey) as Record<string, unknown> | undefined;

    if (!row) return null;

    const session: GraphDSession = {
      sessionKey: row.session_key as string,
      clientType: row.client_type as string,
      createdAt: row.created_at as number,
      lastAccessedAt: row.last_accessed_at as number,
      expiresAt: row.expires_at as number | null,
      workingDir: row.working_dir as string | null,
      status: row.status as string,
      metadataJson: row.metadata_json as string | null,
    };

    // Parse metadata JSON
    if (session.metadataJson) {
      session.metadata = safeJsonParse(session.metadataJson, {});
    }

    return session;
  }

  /**
   * Update last_accessed_at timestamp for a session.
   */
  updateSessionAccess(sessionKey: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE sessions SET last_accessed_at = ? WHERE session_key = ? AND status = 'active';"
      )
      .run(nowSeconds(), sessionKey);
    return result.changes > 0;
  }

  /**
   * Update session status.
   */
  updateSessionStatus(sessionKey: string, status: string): boolean {
    const result = this.db
      .prepare('UPDATE sessions SET status = ? WHERE session_key = ?;')
      .run(status, sessionKey);
    return result.changes > 0;
  }

  /**
   * Update session metadata.
   */
  updateSessionMetadata(
    sessionKey: string,
    metadata: Record<string, unknown>,
    merge = true
  ): boolean {
    if (merge) {
      // Get existing metadata first
      const row = this.db
        .prepare('SELECT metadata_json FROM sessions WHERE session_key = ?;')
        .get(sessionKey) as { metadata_json: string | null } | undefined;

      if (!row) return false;

      let existing: Record<string, unknown> = {};
      if (row.metadata_json) {
        existing = safeJsonParse(row.metadata_json, {});
      }

      // Smart merge: for arrays like wizard_events, append instead of replace
      for (const [key, value] of Object.entries(metadata)) {
        if (Array.isArray(value) && Array.isArray(existing[key])) {
          // Append new items to existing array
          existing[key] = [...(existing[key] as unknown[]), ...value];
        } else {
          existing[key] = value;
        }
      }

      metadata = existing;
    }

    const result = this.db
      .prepare('UPDATE sessions SET metadata_json = ? WHERE session_key = ?;')
      .run(JSON.stringify(metadata), sessionKey);
    return result.changes > 0;
  }

  /**
   * Delete a session and all associated data.
   */
  deleteSession(sessionKey: string): boolean {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM context_snapshots WHERE session_key = ?;')
        .run(sessionKey);
      this.db
        .prepare('DELETE FROM conversation_messages WHERE session_key = ?;')
        .run(sessionKey);
      return this.db
        .prepare('DELETE FROM sessions WHERE session_key = ?;')
        .run(sessionKey);
    });
    const result = transaction();
    return result.changes > 0;
  }

  /**
   * List sessions with optional filtering.
   */
  listSessions(
    clientType?: string,
    status = 'active',
    limit = 50
  ): GraphDSession[] {
    let rows: Record<string, unknown>[];

    if (clientType) {
      rows = this.db
        .prepare(
          `SELECT * FROM sessions
           WHERE client_type = ? AND status = ?
           ORDER BY last_accessed_at DESC
           LIMIT ?;`
        )
        .all(clientType, status, limit) as Record<string, unknown>[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM sessions
           WHERE status = ?
           ORDER BY last_accessed_at DESC
           LIMIT ?;`
        )
        .all(status, limit) as Record<string, unknown>[];
    }

    return rows.map((row) => ({
      sessionKey: row.session_key as string,
      clientType: row.client_type as string,
      createdAt: row.created_at as number,
      lastAccessedAt: row.last_accessed_at as number,
      expiresAt: row.expires_at as number | null,
      workingDir: row.working_dir as string | null,
      status: row.status as string,
      metadataJson: row.metadata_json as string | null,
    }));
  }

  /**
   * Delete sessions that have passed their expires_at timestamp.
   */
  cleanupExpiredSessions(): number {
    const now = nowSeconds();

    const transaction = this.db.transaction(() => {
      // First mark as expired
      this.db
        .prepare(
          `UPDATE sessions SET status = 'expired'
           WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'active';`
        )
        .run(now);

      // Then delete expired sessions
      const result = this.db
        .prepare("DELETE FROM sessions WHERE status = 'expired';")
        .run();
      return result.changes;
    });

    return transaction();
  }

  // =========================================================================
  // Conversation Message Methods
  // =========================================================================

  /**
   * Add a message to a session's conversation history.
   */
  addMessage(
    sessionKey: string,
    role: string,
    content: string,
    requestId?: string,
    metadata?: Record<string, unknown>
  ): number {
    // Get next message index for this session
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(message_index), -1) + 1 as next_idx FROM conversation_messages WHERE session_key = ?;'
      )
      .get(sessionKey) as { next_idx: number };
    const nextIdx = row.next_idx;

    try {
      this.db
        .prepare(
          `INSERT INTO conversation_messages
           (session_key, message_index, role, content, request_id, created_at, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?);`
        )
        .run(
          sessionKey,
          nextIdx,
          role,
          content,
          requestId ?? null,
          nowSeconds(),
          metadata ? JSON.stringify(metadata) : null
        );
      return nextIdx;
    } catch (err) {
      if ((err as Error).message.includes('FOREIGN KEY constraint')) {
        throw new Error(`Session '${sessionKey}' does not exist`);
      }
      throw err;
    }
  }

  /**
   * Get conversation messages for a session.
   */
  getMessages(
    sessionKey: string,
    limit = 100,
    offset = 0
  ): GraphDMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE session_key = ?
         ORDER BY message_index ASC
         LIMIT ? OFFSET ?;`
      )
      .all(sessionKey, limit, offset) as Record<string, unknown>[];

    return rows.map((row) => {
      const msg: GraphDMessage = {
        id: row.id as number,
        sessionKey: row.session_key as string,
        messageIndex: row.message_index as number,
        role: row.role as string,
        content: row.content as string,
        requestId: row.request_id as string | null,
        createdAt: row.created_at as number,
        metadataJson: row.metadata_json as string | null,
      };
      if (msg.metadataJson) {
        msg.metadata = safeJsonParse(msg.metadataJson, {});
      }
      return msg;
    });
  }

  /**
   * Get total number of messages in a session.
   */
  getMessageCount(sessionKey: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) as count FROM conversation_messages WHERE session_key = ?;'
      )
      .get(sessionKey) as { count: number };
    return row.count;
  }

  /**
   * Delete all messages for a session.
   */
  clearMessages(sessionKey: string): number {
    const result = this.db
      .prepare('DELETE FROM conversation_messages WHERE session_key = ?;')
      .run(sessionKey);
    return result.changes;
  }

  // =========================================================================
  // Context Snapshot Methods
  // =========================================================================

  /**
   * Save a context window snapshot for a session.
   */
  saveContextSnapshot(
    sessionKey: string,
    contextData: Record<string, unknown>
  ): number {
    // Get next version number
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(snapshot_version), 0) + 1 as next_ver FROM context_snapshots WHERE session_key = ?;'
      )
      .get(sessionKey) as { next_ver: number };
    const nextVer = row.next_ver;

    try {
      this.db
        .prepare(
          `INSERT INTO context_snapshots
           (session_key, snapshot_version, created_at, context_json)
           VALUES (?, ?, ?, ?);`
        )
        .run(sessionKey, nextVer, nowSeconds(), JSON.stringify(contextData));
      return nextVer;
    } catch (err) {
      if ((err as Error).message.includes('FOREIGN KEY constraint')) {
        throw new Error(`Session '${sessionKey}' does not exist`);
      }
      throw err;
    }
  }

  /**
   * Get the most recent context snapshot for a session.
   */
  getLatestContextSnapshot(sessionKey: string): GraphDContextSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT * FROM context_snapshots
         WHERE session_key = ?
         ORDER BY snapshot_version DESC
         LIMIT 1;`
      )
      .get(sessionKey) as Record<string, unknown> | undefined;

    if (!row) return null;

    const snapshot: GraphDContextSnapshot = {
      id: row.id as number,
      sessionKey: row.session_key as string,
      snapshotVersion: row.snapshot_version as number,
      createdAt: row.created_at as number,
      contextJson: row.context_json as string | null,
    };

    if (snapshot.contextJson) {
      snapshot.context = safeJsonParse(snapshot.contextJson, {});
    }

    return snapshot;
  }

  /**
   * Get a specific version of a context snapshot.
   */
  getContextSnapshotByVersion(
    sessionKey: string,
    version: number
  ): GraphDContextSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT * FROM context_snapshots
         WHERE session_key = ? AND snapshot_version = ?;`
      )
      .get(sessionKey, version) as Record<string, unknown> | undefined;

    if (!row) return null;

    const snapshot: GraphDContextSnapshot = {
      id: row.id as number,
      sessionKey: row.session_key as string,
      snapshotVersion: row.snapshot_version as number,
      createdAt: row.created_at as number,
      contextJson: row.context_json as string | null,
    };

    if (snapshot.contextJson) {
      snapshot.context = safeJsonParse(snapshot.contextJson, {});
    }

    return snapshot;
  }

  /**
   * List context snapshots for a session (most recent first).
   */
  listContextSnapshots(
    sessionKey: string,
    limit = 10
  ): Array<{ id: number; sessionKey: string; snapshotVersion: number; createdAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, session_key, snapshot_version, created_at
         FROM context_snapshots
         WHERE session_key = ?
         ORDER BY snapshot_version DESC
         LIMIT ?;`
      )
      .all(sessionKey, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as number,
      sessionKey: row.session_key as string,
      snapshotVersion: row.snapshot_version as number,
      createdAt: row.created_at as number,
    }));
  }

  /**
   * Delete old snapshots, keeping only the most recent N.
   */
  cleanupOldSnapshots(sessionKey: string, keepCount = 5): number {
    // Get IDs to keep
    const keepRows = this.db
      .prepare(
        `SELECT id FROM context_snapshots
         WHERE session_key = ?
         ORDER BY snapshot_version DESC
         LIMIT ?;`
      )
      .all(sessionKey, keepCount) as { id: number }[];

    if (!keepRows.length) return 0;

    const keepIds = keepRows.map((r) => r.id);
    const placeholders = keepIds.map(() => '?').join(',');

    const result = this.db
      .prepare(
        `DELETE FROM context_snapshots
         WHERE session_key = ? AND id NOT IN (${placeholders});`
      )
      .run(sessionKey, ...keepIds);

    return result.changes;
  }
}
