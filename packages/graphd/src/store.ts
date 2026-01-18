/**
 * SQLite-backed GraphD store.
 *
 * Ported from: src/harness/graphd/store.py
 *
 * Uses Bun's native SQLite (bun:sqlite) for synchronous SQLite operations.
 */

import { Database } from 'bun:sqlite';
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
  GraphDEvent,
  SiasSessionRecord,
  SiasCheckpointRecord,
  SiasPatchRecord,
  SiasDecisionRecord,
  SiasPrincipalContextRecord,
  SiasBenchmarkRunRecord,
  SiasWorktreeRecord,
  SiasDecisionEmbeddingRecord,
  GraphDStats,
  UserRecord,
  UserSessionRecord,
  ProviderCredentialRecord,
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
  private db: Database;
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
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Checkpoint the WAL to flush writes to the main database file.
   * This makes writes visible to other processes reading the database.
   */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  }

  /**
   * Run a set of operations inside a single transaction.
   */
  withTransaction<T>(fn: () => T): T {
    const transaction = this.db.transaction(fn);
    return transaction();
  }

  /**
   * Initialize database schema and verify version compatibility.
   *
   * Schema versions are additive - each version adds new tables without
   * modifying existing ones. This allows safe forward migration by running
   * the DDL (which uses CREATE TABLE IF NOT EXISTS).
   */
  initialize(): void {
    const metadataExists = this.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='graphd_metadata';"
      )
      .get();

    let existingVersion: string | null = null;
    if (metadataExists) {
      const row = this.db
        .query("SELECT value FROM graphd_metadata WHERE key = 'schema_version';")
        .get() as { value: string } | null;
      existingVersion = row?.value ?? null;
    }

    // Parse version numbers (e.g., "v4" -> 4)
    const parseVersion = (v: string | null): number => {
      if (!v) return 0;
      const match = v.match(/^v(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    };

    const existingNum = parseVersion(existingVersion);
    const expectedNum = parseVersion(GRAPHD_SCHEMA_VERSION);

    // Only error on downgrades - forward migrations are safe since schema is additive
    if (existingVersion && existingNum > expectedNum) {
      throw new SchemaVersionError(existingVersion, GRAPHD_SCHEMA_VERSION, this.dbPath);
    }

    // Create all tables (IF NOT EXISTS is idempotent) - safely adds new tables
    this.db.exec(GRAPHD_SCHEMA_DDL);
    this.db.exec(ENABLE_FOREIGN_KEYS);

    // Update schema version
    if (existingVersion && existingNum < expectedNum) {
      console.log(`GraphD: migrated schema ${existingVersion} -> ${GRAPHD_SCHEMA_VERSION}`);
    }
    this.db
      .query(
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
      .query(
        'INSERT OR REPLACE INTO files (path, lang, hash, mtime) VALUES (?, ?, ?, ?);'
      )
      .run(path, lang, hashValue, mtime);
  }

  /**
   * Remove a file and all associated data.
   */
  removeFile(path: string): void {
    const transaction = this.db.transaction(() => {
      this.db.query('DELETE FROM files WHERE path = ?;').run(path);
      this.db.query('DELETE FROM symbols WHERE path = ?;').run(path);
      this.db.query('DELETE FROM module_edges WHERE src_path = ?;').run(path);
      this.db.query('DELETE FROM module_edges WHERE dst_path = ?;').run(path);
      this.db.query('DELETE FROM exports WHERE path = ?;').run(path);
    });
    transaction();
  }

  /**
   * Get a file record by path.
   */
  getFile(path: string): FileRecord | null {
    const row = this.db
      .query('SELECT * FROM files WHERE path = ?;')
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
      this.db.query('DELETE FROM symbols WHERE path = ?;').run(path);

      const insert = this.db.query(
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
      .query('SELECT * FROM symbols WHERE id = ?;')
      .get(symbolId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  /**
   * Find symbol by file path and line number.
   */
  findSymbolByPosition(path: string, line: number): Record<string, unknown> | null {
    const row = this.db
      .query(
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
      .query('SELECT * FROM symbols WHERE path = ? ORDER BY span_start ASC;')
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
      this.db.query('DELETE FROM module_edges WHERE src_path = ?;').run(path);

      const insert = this.db.query(
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
      .query('SELECT * FROM module_edges WHERE src_path = ?;')
      .all(path) as Record<string, unknown>[];
  }

  /**
   * Get importers of a file (what imports this file).
   */
  getImportersForFile(path: string): Record<string, unknown>[] {
    return this.db
      .query('SELECT * FROM module_edges WHERE dst_path = ?;')
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
      this.db.query('DELETE FROM exports WHERE path = ?;').run(path);

      const insert = this.db.query(
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
        .query(
          'INSERT OR REPLACE INTO files (path, lang, hash, mtime) VALUES (?, ?, ?, ?);'
        )
        .run(path, lang, hashValue, mtime);

      // Replace symbols
      this.db.query('DELETE FROM symbols WHERE path = ?;').run(path);
      const insertSymbol = this.db.query(
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
      this.db.query('DELETE FROM module_edges WHERE src_path = ?;').run(path);
      const insertEdge = this.db.query(
        `INSERT INTO module_edges (src_path, dst_path, kind, confidence)
         VALUES (?, ?, ?, ?);`
      );
      for (const e of edges) {
        insertEdge.run(e.srcPath, e.dstPath, e.kind, e.confidence);
      }

      // Replace exports
      this.db.query('DELETE FROM exports WHERE path = ?;').run(path);
      const insertExport = this.db.query(
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
      .query(
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
      this.db.query('SELECT COUNT(*) as c FROM files;').get() as { c: number }
    ).c;
    const symbols = (
      this.db.query('SELECT COUNT(*) as c FROM symbols;').get() as { c: number }
    ).c;
    const moduleEdges = (
      this.db.query('SELECT COUNT(*) as c FROM module_edges;').get() as {
        c: number;
      }
    ).c;
    const exports = (
      this.db.query('SELECT COUNT(*) as c FROM exports;').get() as { c: number }
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
    return this.db.query(`SELECT * FROM ${table};`).all() as Record<
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
        .query(
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
      .query('SELECT * FROM sessions WHERE session_key = ?;')
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
   * Also reactivates inactive sessions when accessed.
   */
  updateSessionAccess(sessionKey: string): boolean {
    const result = this.db
      .query(
        `UPDATE sessions
         SET last_accessed_at = ?,
             status = CASE WHEN status = 'inactive' THEN 'active' ELSE status END
         WHERE session_key = ? AND status IN ('active', 'inactive');`
      )
      .run(nowSeconds(), sessionKey);
    return result.changes > 0;
  }

  /**
   * Update session status.
   */
  updateSessionStatus(sessionKey: string, status: string): boolean {
    const result = this.db
      .query('UPDATE sessions SET status = ? WHERE session_key = ?;')
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
        .query('SELECT metadata_json FROM sessions WHERE session_key = ?;')
        .get(sessionKey) as { metadata_json: string | null } | undefined;

      if (!row) return false;

      let existing: Record<string, unknown> = {};
      if (row.metadata_json) {
        existing = safeJsonParse(row.metadata_json, {});
      }

      // Smart merge: for arrays, append instead of replace
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
      .query('UPDATE sessions SET metadata_json = ? WHERE session_key = ?;')
      .run(JSON.stringify(metadata), sessionKey);
    return result.changes > 0;
  }

  /**
   * Delete a session and all associated data.
   */
  deleteSession(sessionKey: string): boolean {
    const transaction = this.db.transaction(() => {
      this.db
        .query('DELETE FROM context_snapshots WHERE session_key = ?;')
        .run(sessionKey);
      this.db
        .query('DELETE FROM conversation_messages WHERE session_key = ?;')
        .run(sessionKey);
      return this.db
        .query('DELETE FROM sessions WHERE session_key = ?;')
        .run(sessionKey);
    });
    const result = transaction();
    return result.changes > 0;
  }

  /**
   * List sessions with optional filtering.
   * Supports filtering by clientType, workingDir, and multiple statuses.
   */
  listSessions(
    options: {
      clientType?: string;
      workingDir?: string;
      status?: string | string[];
      limit?: number;
      includePreview?: boolean;
    } = {}
  ): GraphDSession[] {
    const { clientType, workingDir, status = 'active', limit = 50, includePreview = true } = options;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Status filter (single or multiple)
    if (Array.isArray(status)) {
      if (status.length > 0) {
        conditions.push(`s.status IN (${status.map(() => '?').join(', ')})`);
        params.push(...status);
      }
    } else {
      conditions.push('s.status = ?');
      params.push(status);
    }

    // Client type filter
    if (clientType) {
      conditions.push('s.client_type = ?');
      params.push(clientType);
    }

    // Working directory filter
    if (workingDir) {
      conditions.push('s.working_dir = ?');
      params.push(workingDir);
    }

    params.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Use subquery to get last user message preview (truncated to 100 chars)
    const previewSelect = includePreview
      ? `, (
          SELECT SUBSTR(content, 1, 100)
          FROM conversation_messages m
          WHERE m.session_key = s.session_key AND m.role = 'user'
          ORDER BY m.message_index DESC
          LIMIT 1
        ) as last_user_preview`
      : '';

    const query = `
      SELECT s.*${previewSelect}
      FROM sessions s
      ${whereClause}
      ORDER BY s.last_accessed_at DESC
      LIMIT ?;
    `;

    const rows = this.db.query(query).all(...params) as Record<string, unknown>[];

    return rows.map((row) => ({
      sessionKey: row.session_key as string,
      clientType: row.client_type as string,
      createdAt: row.created_at as number,
      lastAccessedAt: row.last_accessed_at as number,
      expiresAt: row.expires_at as number | null,
      workingDir: row.working_dir as string | null,
      status: row.status as string,
      metadataJson: row.metadata_json as string | null,
      lastUserMessagePreview: includePreview ? (row.last_user_preview as string | null) : undefined,
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
        .query(
          `UPDATE sessions SET status = 'expired'
           WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'active';`
        )
        .run(now);

      // Then delete expired sessions
      const result = this.db
        .query("DELETE FROM sessions WHERE status = 'expired';")
        .run();
      return result.changes;
    });

    return transaction();
  }

  /**
   * Mark sessions as inactive if they haven't been accessed within maxIdleSeconds.
   * Returns the number of sessions marked inactive.
   */
  markStaleSessions(maxIdleSeconds: number): number {
    const cutoff = nowSeconds() - maxIdleSeconds;
    const result = this.db
      .query(
        `UPDATE sessions SET status = 'inactive'
         WHERE status = 'active' AND last_accessed_at < ?;`
      )
      .run(cutoff);
    return result.changes;
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
      .query(
        'SELECT COALESCE(MAX(message_index), -1) + 1 as next_idx FROM conversation_messages WHERE session_key = ?;'
      )
      .get(sessionKey) as { next_idx: number };
    const nextIdx = row.next_idx;

    try {
      this.db
        .query(
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
      .query(
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
      .query(
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
      .query('DELETE FROM conversation_messages WHERE session_key = ?;')
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
      .query(
        'SELECT COALESCE(MAX(snapshot_version), 0) + 1 as next_ver FROM context_snapshots WHERE session_key = ?;'
      )
      .get(sessionKey) as { next_ver: number };
    const nextVer = row.next_ver;

    try {
      this.db
        .query(
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
      .query(
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
      .query(
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
      .query(
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
      .query(
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
      .query(
        `DELETE FROM context_snapshots
         WHERE session_key = ? AND id NOT IN (${placeholders});`
      )
      .run(sessionKey, ...keepIds);

    return result.changes;
  }

  // =========================================================================
  // Session Event Methods
  // =========================================================================

  /**
   * Add an event to a session.
   */
  addEvent(
    sessionKey: string,
    eventType: string,
    data: Record<string, unknown>,
    requestId?: string,
    stepNum?: number,
    timestamp?: number
  ): number {
    const ts = timestamp ?? nowSeconds();
    try {
      const result = this.db
        .query(
          `INSERT INTO session_events
           (session_key, request_id, event_type, step_num, timestamp, data_json)
           VALUES (?, ?, ?, ?, ?, ?);`
        )
        .run(
          sessionKey,
          requestId ?? null,
          eventType,
          stepNum ?? null,
          ts,
          JSON.stringify(data)
        );
      return Number(result.lastInsertRowid);
    } catch (err) {
      if ((err as Error).message.includes('FOREIGN KEY constraint')) {
        throw new Error(`Session '${sessionKey}' does not exist`);
      }
      throw err;
    }
  }

  /**
   * Get events for a session.
   */
  getEvents(
    sessionKey: string,
    requestId?: string,
    eventType?: string,
    limit = 1000,
    offset = 0
  ): GraphDEvent[] {
    let query = 'SELECT * FROM session_events WHERE session_key = ?';
    const params: (string | number)[] = [sessionKey];

    if (requestId) {
      query += ' AND request_id = ?';
      params.push(requestId);
    }
    if (eventType) {
      query += ' AND event_type = ?';
      params.push(eventType);
    }

    query += ' ORDER BY timestamp ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.query(query).all(...params) as Record<string, unknown>[];

    return rows.map((row) => {
      const event: GraphDEvent = {
        id: row.id as number,
        sessionKey: row.session_key as string,
        requestId: row.request_id as string | null,
        eventType: row.event_type as string,
        stepNum: row.step_num as number | null,
        timestamp: row.timestamp as number,
        dataJson: row.data_json as string | null,
      };
      if (event.dataJson) {
        event.data = safeJsonParse(event.dataJson, {});
      }
      return event;
    });
  }

  /**
   * Get total event count for a session.
   */
  getEventCount(sessionKey: string, requestId?: string): number {
    let query = 'SELECT COUNT(*) as count FROM session_events WHERE session_key = ?';
    const params: string[] = [sessionKey];

    if (requestId) {
      query += ' AND request_id = ?';
      params.push(requestId);
    }

    const row = this.db.query(query).get(...params) as { count: number };
    return row.count;
  }

  /**
   * Delete events for a session (optionally filtered by request_id).
   */
  deleteEvents(sessionKey: string, requestId?: string): number {
    let query = 'DELETE FROM session_events WHERE session_key = ?';
    const params: string[] = [sessionKey];

    if (requestId) {
      query += ' AND request_id = ?';
      params.push(requestId);
    }

    const result = this.db.query(query).run(...params);
    return result.changes;
  }

  // =========================================================================
  // SIAS Kernel Methods
  // =========================================================================

  createSiasSession(
    sessionId: string,
    status = 'running',
    metadata?: Record<string, unknown>
  ): boolean {
    const now = nowSeconds();
    try {
      this.db
        .query(
          `INSERT INTO sias_sessions
           (session_id, started_at, last_checkpoint_at, iteration_count, status, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?);`
        )
        .run(sessionId, now, now, 0, status, metadata ? JSON.stringify(metadata) : null);
      return true;
    } catch (err) {
      if ((err as Error).message.includes('UNIQUE constraint')) {
        return false;
      }
      throw err;
    }
  }

  getSiasSession(sessionId: string): SiasSessionRecord | null {
    const row = this.db
      .query('SELECT * FROM sias_sessions WHERE session_id = ?;')
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const record: SiasSessionRecord = {
      sessionId: row.session_id as string,
      startedAt: row.started_at as number,
      lastCheckpointAt: row.last_checkpoint_at as number,
      iterationCount: row.iteration_count as number,
      status: row.status as string,
      metadataJson: row.metadata_json as string | null,
    };

    if (record.metadataJson) {
      record.metadata = safeJsonParse(record.metadataJson, {});
    }

    return record;
  }

  updateSiasSession(
    sessionId: string,
    updates: Partial<Pick<SiasSessionRecord, 'status' | 'lastCheckpointAt' | 'iterationCount'>> & {
      metadata?: Record<string, unknown>;
    }
  ): boolean {
    const current = this.getSiasSession(sessionId);
    if (!current) return false;

    const nextStatus = updates.status ?? current.status;
    const nextCheckpoint = updates.lastCheckpointAt ?? current.lastCheckpointAt;
    const nextIterationCount = updates.iterationCount ?? current.iterationCount;
    const metadataJson = updates.metadata
      ? JSON.stringify(updates.metadata)
      : current.metadataJson;

    const result = this.db
      .query(
        `UPDATE sias_sessions
         SET status = ?, last_checkpoint_at = ?, iteration_count = ?, metadata_json = ?
         WHERE session_id = ?;`
      )
      .run(nextStatus, nextCheckpoint, nextIterationCount, metadataJson, sessionId);

    return result.changes > 0;
  }

  insertSiasCheckpoint(
    sessionId: string,
    version: number,
    iteration: number,
    payload: Record<string, unknown>
  ): number {
    const createdAt = nowSeconds();
    const result = this.db
      .query(
        `INSERT INTO sias_checkpoints
         (session_id, version, iteration, created_at, payload_json)
         VALUES (?, ?, ?, ?, ?);`
      )
      .run(sessionId, version, iteration, createdAt, JSON.stringify(payload));

    this.updateSiasSession(sessionId, {
      lastCheckpointAt: createdAt,
      iterationCount: iteration,
    });

    return Number(result.lastInsertRowid);
  }

  getLatestSiasCheckpoint(sessionId: string): SiasCheckpointRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM sias_checkpoints
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT 1;`
      )
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const record: SiasCheckpointRecord = {
      id: row.id as number,
      sessionId: row.session_id as string,
      version: row.version as number,
      iteration: row.iteration as number,
      createdAt: row.created_at as number,
      payloadJson: row.payload_json as string,
    };

    record.payload = safeJsonParse(record.payloadJson, {});
    return record;
  }

  listSiasCheckpoints(sessionId: string, limit = 10): SiasCheckpointRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM sias_checkpoints
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?;`
      )
      .all(sessionId, limit) as Record<string, unknown>[];

    return rows.map((row) => {
      const record: SiasCheckpointRecord = {
        id: row.id as number,
        sessionId: row.session_id as string,
        version: row.version as number,
        iteration: row.iteration as number,
        createdAt: row.created_at as number,
        payloadJson: row.payload_json as string,
      };
      record.payload = safeJsonParse(record.payloadJson, {});
      return record;
    });
  }

  upsertSiasPatch(record: Omit<SiasPatchRecord, 'filesChanged' | 'benchmarkBefore' | 'benchmarkAfter' | 'testSummary'> & {
    filesChanged?: string[];
    benchmarkBefore?: Record<string, unknown>;
    benchmarkAfter?: Record<string, unknown>;
    testSummary?: Record<string, unknown>;
  }): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO sias_patches
         (patch_id, session_id, iteration, timestamp, objective, reasoning,
          files_changed_json, diff_summary, status, rollback_reason,
          benchmark_before_json, benchmark_after_json, test_summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
      )
      .run(
        record.patchId,
        record.sessionId,
        record.iteration,
        record.timestamp,
        record.objective ?? null,
        record.reasoning ?? null,
        record.filesChanged
          ? JSON.stringify(record.filesChanged)
          : record.filesChangedJson ?? null,
        record.diffSummary ?? null,
        record.status,
        record.rollbackReason ?? null,
        record.benchmarkBefore
          ? JSON.stringify(record.benchmarkBefore)
          : record.benchmarkBeforeJson ?? null,
        record.benchmarkAfter
          ? JSON.stringify(record.benchmarkAfter)
          : record.benchmarkAfterJson ?? null,
        record.testSummary
          ? JSON.stringify(record.testSummary)
          : record.testSummaryJson ?? null
      );
  }

  listSiasPatches(sessionId: string): SiasPatchRecord[] {
    const rows = this.db
      .query('SELECT * FROM sias_patches WHERE session_id = ? ORDER BY iteration ASC;')
      .all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => {
      const record: SiasPatchRecord = {
        patchId: row.patch_id as string,
        sessionId: row.session_id as string,
        iteration: row.iteration as number,
        timestamp: row.timestamp as number,
        objective: row.objective as string | null,
        reasoning: row.reasoning as string | null,
        filesChangedJson: row.files_changed_json as string | null,
        diffSummary: row.diff_summary as string | null,
        status: row.status as string,
        rollbackReason: row.rollback_reason as string | null,
        benchmarkBeforeJson: row.benchmark_before_json as string | null,
        benchmarkAfterJson: row.benchmark_after_json as string | null,
        testSummaryJson: row.test_summary_json as string | null,
      };

      record.filesChanged = record.filesChangedJson
        ? safeJsonParse(record.filesChangedJson, [])
        : [];
      record.benchmarkBefore = record.benchmarkBeforeJson
        ? safeJsonParse(record.benchmarkBeforeJson, {})
        : undefined;
      record.benchmarkAfter = record.benchmarkAfterJson
        ? safeJsonParse(record.benchmarkAfterJson, {})
        : undefined;
      record.testSummary = record.testSummaryJson
        ? safeJsonParse(record.testSummaryJson, {})
        : undefined;
      return record;
    });
  }

  upsertSiasDecision(record: Omit<SiasDecisionRecord, 'relatedDecisions'> & {
    relatedDecisions?: string[];
  }): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO sias_decisions
         (decision_id, session_id, iteration, agent, decision_type,
          reasoning, outcome, related_decisions_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`
      )
      .run(
        record.decisionId,
        record.sessionId,
        record.iteration,
        record.agent,
        record.decisionType,
        record.reasoning ?? null,
        record.outcome ?? null,
        record.relatedDecisions
          ? JSON.stringify(record.relatedDecisions)
          : record.relatedDecisionsJson ?? null,
        record.createdAt
      );
  }

  listSiasDecisions(sessionId: string): SiasDecisionRecord[] {
    const rows = this.db
      .query('SELECT * FROM sias_decisions WHERE session_id = ? ORDER BY iteration ASC;')
      .all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => {
      const record: SiasDecisionRecord = {
        decisionId: row.decision_id as string,
        sessionId: row.session_id as string,
        iteration: row.iteration as number,
        agent: row.agent as string,
        decisionType: row.decision_type as string,
        reasoning: row.reasoning as string | null,
        outcome: row.outcome as string | null,
        relatedDecisionsJson: row.related_decisions_json as string | null,
        createdAt: row.created_at as number,
      };

      record.relatedDecisions = record.relatedDecisionsJson
        ? safeJsonParse(record.relatedDecisionsJson, [])
        : [];
      return record;
    });
  }

  upsertSiasPrincipalContext(record: Omit<SiasPrincipalContextRecord, 'learnedConstraints' | 'horizonObjectives'> & {
    learnedConstraints?: string[];
    horizonObjectives?: string[];
  }): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO sias_principal_context
         (session_id, patch_summary, current_focus, learned_constraints_json,
          horizon_objectives_json, last_updated)
         VALUES (?, ?, ?, ?, ?, ?);`
      )
      .run(
        record.sessionId,
        record.patchSummary ?? null,
        record.currentFocus ?? null,
        record.learnedConstraints
          ? JSON.stringify(record.learnedConstraints)
          : record.learnedConstraintsJson ?? null,
        record.horizonObjectives
          ? JSON.stringify(record.horizonObjectives)
          : record.horizonObjectivesJson ?? null,
        record.lastUpdated
      );
  }

  getSiasPrincipalContext(sessionId: string): SiasPrincipalContextRecord | null {
    const row = this.db
      .query('SELECT * FROM sias_principal_context WHERE session_id = ?;')
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const record: SiasPrincipalContextRecord = {
      sessionId: row.session_id as string,
      patchSummary: row.patch_summary as string | null,
      currentFocus: row.current_focus as string | null,
      learnedConstraintsJson: row.learned_constraints_json as string | null,
      horizonObjectivesJson: row.horizon_objectives_json as string | null,
      lastUpdated: row.last_updated as number,
    };

    record.learnedConstraints = record.learnedConstraintsJson
      ? safeJsonParse(record.learnedConstraintsJson, [])
      : [];
    record.horizonObjectives = record.horizonObjectivesJson
      ? safeJsonParse(record.horizonObjectivesJson, [])
      : [];
    return record;
  }

  addSiasHealthSnapshot(sessionId: string, metrics: Record<string, unknown>): number {
    const capturedAt = nowSeconds();
    const result = this.db
      .query(
        `INSERT INTO sias_health_snapshots (session_id, captured_at, metrics_json)
         VALUES (?, ?, ?);`
      )
      .run(sessionId, capturedAt, JSON.stringify(metrics));
    return Number(result.lastInsertRowid);
  }

  addSiasBenchmarkRun(
    sessionId: string,
    tier: string,
    startedAt: number,
    completedAt: number,
    score: number,
    result: Record<string, unknown>
  ): number {
    const resultRow = this.db
      .query(
        `INSERT INTO sias_benchmark_runs
         (session_id, tier, started_at, completed_at, score, result_json)
         VALUES (?, ?, ?, ?, ?, ?);`
      )
      .run(sessionId, tier, startedAt, completedAt, score, JSON.stringify(result));
    return Number(resultRow.lastInsertRowid);
  }

  listSiasBenchmarkRuns(sessionId: string, limit = 10): SiasBenchmarkRunRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM sias_benchmark_runs
         WHERE session_id = ?
         ORDER BY completed_at DESC
         LIMIT ?;`
      )
      .all(sessionId, limit) as Record<string, unknown>[];

    return rows.map((row) => {
      const record: SiasBenchmarkRunRecord = {
        id: row.id as number,
        sessionId: row.session_id as string,
        tier: row.tier as string,
        startedAt: row.started_at as number,
        completedAt: row.completed_at as number,
        score: row.score as number,
        resultJson: row.result_json as string,
      };
      record.result = safeJsonParse(record.resultJson, {});
      return record;
    });
  }

  upsertSiasWorktree(record: Omit<SiasWorktreeRecord, 'patchesIncluded' | 'benchmarkScores'> & {
    patchesIncluded?: string[];
    benchmarkScores?: Record<string, unknown>[];
  }): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO sias_worktrees
         (version, path, status, created_at, promoted_at, archived_at, iterations_run,
          benchmark_score, failure_count, failure_reason, failure_iteration,
          git_commit, patches_included_json, benchmark_scores_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
      )
      .run(
        record.version,
        record.path,
        record.status,
        record.createdAt,
        record.promotedAt ?? null,
        record.archivedAt ?? null,
        record.iterationsRun ?? null,
        record.benchmarkScore ?? null,
        record.failureCount ?? null,
        record.failureReason ?? null,
        record.failureIteration ?? null,
        record.gitCommit ?? null,
        record.patchesIncluded
          ? JSON.stringify(record.patchesIncluded)
          : record.patchesIncludedJson ?? null,
        record.benchmarkScores
          ? JSON.stringify(record.benchmarkScores)
          : record.benchmarkScoresJson ?? null
      );
  }

  getSiasWorktree(version: string): SiasWorktreeRecord | null {
    const row = this.db
      .query('SELECT * FROM sias_worktrees WHERE version = ?;')
      .get(version) as Record<string, unknown> | undefined;

    if (!row) return null;

    const record: SiasWorktreeRecord = {
      version: row.version as string,
      path: row.path as string,
      status: row.status as string,
      createdAt: row.created_at as number,
      promotedAt: row.promoted_at as number | null,
      archivedAt: row.archived_at as number | null,
      iterationsRun: row.iterations_run as number | null,
      benchmarkScore: row.benchmark_score as number | null,
      failureCount: row.failure_count as number | null,
      failureReason: row.failure_reason as string | null,
      failureIteration: row.failure_iteration as number | null,
      gitCommit: row.git_commit as string | null,
      patchesIncludedJson: row.patches_included_json as string | null,
      benchmarkScoresJson: row.benchmark_scores_json as string | null,
    };

    record.patchesIncluded = record.patchesIncludedJson
      ? safeJsonParse(record.patchesIncludedJson, [])
      : [];
    record.benchmarkScores = record.benchmarkScoresJson
      ? safeJsonParse(record.benchmarkScoresJson, [])
      : [];
    return record;
  }

  listSiasWorktrees(): SiasWorktreeRecord[] {
    const rows = this.db
      .query('SELECT * FROM sias_worktrees ORDER BY created_at DESC;')
      .all() as Record<string, unknown>[];

    return rows.map((row) => {
      const record: SiasWorktreeRecord = {
        version: row.version as string,
        path: row.path as string,
        status: row.status as string,
        createdAt: row.created_at as number,
        promotedAt: row.promoted_at as number | null,
        archivedAt: row.archived_at as number | null,
        iterationsRun: row.iterations_run as number | null,
        benchmarkScore: row.benchmark_score as number | null,
        failureCount: row.failure_count as number | null,
        failureReason: row.failure_reason as string | null,
        failureIteration: row.failure_iteration as number | null,
        gitCommit: row.git_commit as string | null,
        patchesIncludedJson: row.patches_included_json as string | null,
        benchmarkScoresJson: row.benchmark_scores_json as string | null,
      };

      record.patchesIncluded = record.patchesIncludedJson
        ? safeJsonParse(record.patchesIncludedJson, [])
        : [];
      record.benchmarkScores = record.benchmarkScoresJson
        ? safeJsonParse(record.benchmarkScoresJson, [])
        : [];
      return record;
    });
  }

  upsertSiasDecisionEmbedding(decisionId: string, embedding: number[]): void {
    const createdAt = nowSeconds();
    this.db
      .query(
        `INSERT OR REPLACE INTO sias_decision_embeddings
         (decision_id, embedding_json, created_at)
         VALUES (?, ?, ?);`
      )
      .run(decisionId, JSON.stringify(embedding), createdAt);
  }

  getSiasDecisionEmbedding(decisionId: string): SiasDecisionEmbeddingRecord | null {
    const row = this.db
      .query('SELECT * FROM sias_decision_embeddings WHERE decision_id = ?;')
      .get(decisionId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const record: SiasDecisionEmbeddingRecord = {
      decisionId: row.decision_id as string,
      embeddingJson: row.embedding_json as string,
      createdAt: row.created_at as number,
    };

    record.embedding = safeJsonParse(record.embeddingJson, []);
    return record;
  }

  // =========================================================================
  // User Management Methods (v5)
  // =========================================================================

  /**
   * Create or update a user (from Google OAuth).
   */
  upsertUser(
    id: string,
    email: string,
    name?: string,
    pictureUrl?: string
  ): UserRecord {
    const now = nowSeconds();
    const existing = this.getUser(id);

    if (existing) {
      this.db
        .query(
          `UPDATE users SET email = ?, name = ?, picture_url = ?, updated_at = ?
           WHERE id = ?;`
        )
        .run(email, name ?? null, pictureUrl ?? null, now, id);
    } else {
      this.db
        .query(
          `INSERT INTO users (id, email, name, picture_url, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?);`
        )
        .run(id, email, name ?? null, pictureUrl ?? null, now, now);
    }

    return this.getUser(id)!;
  }

  /**
   * Get a user by ID.
   */
  getUser(id: string): UserRecord | null {
    const row = this.db
      .query('SELECT * FROM users WHERE id = ?;')
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      email: row.email as string,
      name: row.name as string | null,
      pictureUrl: row.picture_url as string | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Get a user by email.
   */
  getUserByEmail(email: string): UserRecord | null {
    const row = this.db
      .query('SELECT * FROM users WHERE email = ?;')
      .get(email) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      email: row.email as string,
      name: row.name as string | null,
      pictureUrl: row.picture_url as string | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Delete a user and all associated data (cascades to sessions and credentials).
   */
  deleteUser(id: string): boolean {
    const result = this.db.query('DELETE FROM users WHERE id = ?;').run(id);
    return result.changes > 0;
  }

  // =========================================================================
  // User Session Methods (v5)
  // =========================================================================

  /**
   * Create a new user session (device login).
   */
  createUserSession(
    id: string,
    userId: string,
    deviceName?: string,
    expiresAt?: number
  ): UserSessionRecord {
    const now = nowSeconds();
    this.db
      .query(
        `INSERT INTO user_sessions (id, user_id, device_name, created_at, last_used_at, expires_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, 0);`
      )
      .run(id, userId, deviceName ?? null, now, now, expiresAt ?? null);

    return this.getUserSession(id)!;
  }

  /**
   * Get a user session by ID.
   */
  getUserSession(id: string): UserSessionRecord | null {
    const row = this.db
      .query('SELECT * FROM user_sessions WHERE id = ?;')
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      userId: row.user_id as string,
      deviceName: row.device_name as string | null,
      createdAt: row.created_at as number,
      lastUsedAt: row.last_used_at as number,
      expiresAt: row.expires_at as number | null,
      revoked: (row.revoked as number) === 1,
    };
  }

  /**
   * Validate a user session (check if active and not expired/revoked).
   * Updates last_used_at on success.
   */
  validateUserSession(id: string): UserSessionRecord | null {
    const session = this.getUserSession(id);
    if (!session) return null;

    // Check if revoked
    if (session.revoked) return null;

    // Check if expired
    const now = nowSeconds();
    if (session.expiresAt && session.expiresAt < now) return null;

    // Update last used timestamp
    this.db
      .query('UPDATE user_sessions SET last_used_at = ? WHERE id = ?;')
      .run(now, id);

    return { ...session, lastUsedAt: now };
  }

  /**
   * Revoke a user session.
   */
  revokeUserSession(id: string): boolean {
    const result = this.db
      .query('UPDATE user_sessions SET revoked = 1 WHERE id = ?;')
      .run(id);
    return result.changes > 0;
  }

  /**
   * Revoke all sessions for a user.
   */
  revokeAllUserSessions(userId: string): number {
    const result = this.db
      .query('UPDATE user_sessions SET revoked = 1 WHERE user_id = ?;')
      .run(userId);
    return result.changes;
  }

  /**
   * List all sessions for a user.
   */
  listUserSessions(userId: string, includeRevoked = false): UserSessionRecord[] {
    let query = 'SELECT * FROM user_sessions WHERE user_id = ?';
    if (!includeRevoked) {
      query += ' AND revoked = 0';
    }
    query += ' ORDER BY last_used_at DESC;';

    const rows = this.db.query(query).all(userId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      userId: row.user_id as string,
      deviceName: row.device_name as string | null,
      createdAt: row.created_at as number,
      lastUsedAt: row.last_used_at as number,
      expiresAt: row.expires_at as number | null,
      revoked: (row.revoked as number) === 1,
    }));
  }

  /**
   * Clean up expired sessions.
   */
  cleanupExpiredUserSessions(): number {
    const now = nowSeconds();
    const result = this.db
      .query('DELETE FROM user_sessions WHERE expires_at IS NOT NULL AND expires_at < ?;')
      .run(now);
    return result.changes;
  }

  // =========================================================================
  // Provider Credential Methods (v5)
  // =========================================================================

  /**
   * Store an encrypted provider credential.
   */
  upsertProviderCredential(
    id: string,
    userId: string,
    provider: string,
    encryptedKey: string,
    iv: string
  ): ProviderCredentialRecord {
    const now = nowSeconds();

    // Check if exists for this user/provider combo
    const existing = this.getProviderCredential(userId, provider);

    if (existing) {
      this.db
        .query(
          `UPDATE provider_credentials
           SET encrypted_key = ?, iv = ?, updated_at = ?
           WHERE user_id = ? AND provider = ?;`
        )
        .run(encryptedKey, iv, now, userId, provider);
      return this.getProviderCredential(userId, provider)!;
    }

    this.db
      .query(
        `INSERT INTO provider_credentials (id, user_id, provider, encrypted_key, iv, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?);`
      )
      .run(id, userId, provider, encryptedKey, iv, now, now);

    return this.getProviderCredential(userId, provider)!;
  }

  /**
   * Get a provider credential for a user.
   */
  getProviderCredential(userId: string, provider: string): ProviderCredentialRecord | null {
    const row = this.db
      .query('SELECT * FROM provider_credentials WHERE user_id = ? AND provider = ?;')
      .get(userId, provider) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      userId: row.user_id as string,
      provider: row.provider as string,
      encryptedKey: row.encrypted_key as string,
      iv: row.iv as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * List all provider credentials for a user.
   */
  listProviderCredentials(userId: string): ProviderCredentialRecord[] {
    const rows = this.db
      .query('SELECT * FROM provider_credentials WHERE user_id = ? ORDER BY provider ASC;')
      .all(userId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      userId: row.user_id as string,
      provider: row.provider as string,
      encryptedKey: row.encrypted_key as string,
      iv: row.iv as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  /**
   * Delete a provider credential.
   */
  deleteProviderCredential(userId: string, provider: string): boolean {
    const result = this.db
      .query('DELETE FROM provider_credentials WHERE user_id = ? AND provider = ?;')
      .run(userId, provider);
    return result.changes > 0;
  }

  /**
   * Check if a user has a credential for a specific provider.
   */
  hasProviderCredential(userId: string, provider: string): boolean {
    const row = this.db
      .query('SELECT 1 FROM provider_credentials WHERE user_id = ? AND provider = ? LIMIT 1;')
      .get(userId, provider);
    return row !== undefined;
  }

  // =========================================================================
  // Session Fork Methods
  // =========================================================================

  /**
   * Fork a session: atomically copy session, context snapshot, and messages.
   */
  forkSession(
    sourceSessionKey: string,
    targetSessionKey: string,
    clientType?: string
  ): { success: boolean; error?: string } {
    const sourceSession = this.getSession(sourceSessionKey);
    if (!sourceSession) {
      return { success: false, error: `Source session '${sourceSessionKey}' not found` };
    }

    const now = nowSeconds();
    const effectiveClientType = clientType ?? sourceSession.clientType;

    const transaction = this.db.transaction(() => {
      // 1. Create new session record
      this.db
        .query(
          `INSERT INTO sessions (session_key, client_type, created_at, last_accessed_at,
                                 expires_at, working_dir, status, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?);`
        )
        .run(
          targetSessionKey,
          effectiveClientType,
          now,
          now,
          sourceSession.expiresAt,
          sourceSession.workingDir,
          sourceSession.metadataJson
        );

      // 2. Copy latest context snapshot
      const latestSnapshot = this.getLatestContextSnapshot(sourceSessionKey);
      if (latestSnapshot && latestSnapshot.contextJson) {
        this.db
          .query(
            `INSERT INTO context_snapshots (session_key, snapshot_version, created_at, context_json)
             VALUES (?, 1, ?, ?);`
          )
          .run(targetSessionKey, now, latestSnapshot.contextJson);
      }

      // 3. Copy conversation messages (re-index starting from 0)
      const messages = this.getMessages(sourceSessionKey, 10000, 0);
      const insertMsg = this.db.query(
        `INSERT INTO conversation_messages
         (session_key, message_index, role, content, request_id, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?);`
      );
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        insertMsg.run(
          targetSessionKey,
          i,
          msg.role,
          msg.content,
          msg.requestId,
          msg.createdAt,
          msg.metadataJson
        );
      }
    });

    try {
      transaction();
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  // =========================================================================
  // User Preferences Methods (Key-Value Storage)
  // =========================================================================

  /**
   * Get a user preference value by key.
   * Returns the parsed JSON value or null if not found.
   */
  getUserPreference<T = unknown>(key: string): T | null {
    const row = this.db
      .query('SELECT value FROM graphd_metadata WHERE key = ?;')
      .get(key) as { value: string } | undefined;

    if (!row?.value) return null;
    return safeJsonParse(row.value, null) as T | null;
  }

  /**
   * Set a user preference value.
   * Value is stored as JSON.
   */
  setUserPreference(key: string, value: unknown): void {
    this.db
      .query('INSERT OR REPLACE INTO graphd_metadata (key, value) VALUES (?, ?);')
      .run(key, JSON.stringify(value));
  }

  /**
   * Delete a user preference.
   */
  deleteUserPreference(key: string): boolean {
    const result = this.db
      .query('DELETE FROM graphd_metadata WHERE key = ?;')
      .run(key);
    return result.changes > 0;
  }
}
