/**
 * GraphD Manager: persistence, HTTP API, and session management.
 *
 * Ported from: src/harness/graphd/manager.py
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve, isAbsolute } from 'path';
import { GraphStore, SchemaVersionError } from './store.js';
import { GraphDHTTPServer, checkHealthy } from './server.js';
import { GRAPHD_VERSION, GRAPHD_SCHEMA_VERSION } from './schema.js';
import type { GraphDStats, HealthResponse } from './types.js';
import { normalizePath, generateSessionKey, nowSeconds } from './utils.js';

// ============================================
// CONFIGURATION
// ============================================

/**
 * GraphD manager configuration.
 */
export interface GraphDConfig {
  /** Root path of the project */
  rootPath: string;
  /** Path to SQLite database file */
  dbPath: string;
  /** HTTP server host */
  host: string;
  /** HTTP server port */
  port: number;
  /** Allow table exports via HTTP */
  allowExport: boolean;
  /** Index interval in seconds */
  indexIntervalS: number;
  /** Maximum file size to index (bytes) */
  maxFileSizeBytes: number;
  /** Debounce time for file changes (seconds) */
  debounceS: number;
  /** Maximum files per scan */
  maxFilesPerScan: number;
  /** Path to ripgrep binary */
  rgPath: string;
  /** Enable ripgrep search */
  enableRg: boolean;
  /** Maximum search results */
  maxResults: number;
  /** TTL for derived edges (seconds) */
  derivedTtlS: number;
  /** Maximum derived edge cache entries */
  derivedMaxEntries: number;
  /** Pause indexing when agent is active */
  backpressureWhenActive: boolean;
  /** Enable idle refinement */
  idleRefinement: boolean;
  /** Log stats every N cycles */
  statsLogIntervalCycles: number;
  /** Vacuum every N cycles */
  vacuumIntervalCycles: number;
  /** Maximum files to refine per cycle */
  refineMaxFiles: number;
  /** Maximum symbols to refine per file */
  refineMaxSymbols: number;
  /** Nice level for indexer */
  niceLevel: number | null;
  /** Maximum memory in MB */
  maxMemoryMb: number | null;
  /** Ignore file path */
  ignoreFile: string | null;
  /** Extra patterns to ignore */
  extraIgnore: string[];
}

/**
 * Create default GraphD configuration.
 */
export function createGraphDConfig(
  rootPath: string,
  opts?: Partial<Omit<GraphDConfig, 'rootPath'>>
): GraphDConfig {
  return {
    rootPath,
    dbPath: opts?.dbPath ?? '.graphd/graph.db',
    host: opts?.host ?? '127.0.0.1',
    port: opts?.port ?? 9123,
    allowExport: opts?.allowExport ?? true,
    indexIntervalS: opts?.indexIntervalS ?? 30,
    maxFileSizeBytes: opts?.maxFileSizeBytes ?? 1024 * 1024, // 1MB
    debounceS: opts?.debounceS ?? 2,
    maxFilesPerScan: opts?.maxFilesPerScan ?? 100,
    rgPath: opts?.rgPath ?? 'rg',
    enableRg: opts?.enableRg ?? true,
    maxResults: opts?.maxResults ?? 100,
    derivedTtlS: opts?.derivedTtlS ?? 3600,
    derivedMaxEntries: opts?.derivedMaxEntries ?? 10000,
    backpressureWhenActive: opts?.backpressureWhenActive ?? true,
    idleRefinement: opts?.idleRefinement ?? true,
    statsLogIntervalCycles: opts?.statsLogIntervalCycles ?? 10,
    vacuumIntervalCycles: opts?.vacuumIntervalCycles ?? 100,
    refineMaxFiles: opts?.refineMaxFiles ?? 10,
    refineMaxSymbols: opts?.refineMaxSymbols ?? 50,
    niceLevel: opts?.niceLevel ?? null,
    maxMemoryMb: opts?.maxMemoryMb ?? null,
    ignoreFile: opts?.ignoreFile ?? '.gitignore',
    extraIgnore: opts?.extraIgnore ?? [],
  };
}

// ============================================
// MANAGER
// ============================================

/**
 * GraphD Manager.
 *
 * Manages the SQLite store, HTTP server, and session state.
 */
export class GraphDManager {
  readonly config: GraphDConfig;
  readonly root: string;
  readonly dbPath: string;

  private store: GraphStore;
  private server: GraphDHTTPServer | null = null;
  private running = false;
  private active = false;
  private paused = false;
  private reusingExisting = false;
  private lastIndexStats: Record<string, unknown> = {};

  constructor(config: GraphDConfig) {
    this.config = config;
    this.root = resolve(config.rootPath);
    this.dbPath = this.resolveDbPath(config.dbPath);

    // Ensure database directory exists
    const dbDir = dirname(this.dbPath);
    if (dbDir && !existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Initialize store
    this.store = new GraphStore(this.dbPath);
  }

  /**
   * Start the GraphD manager.
   */
  async start(): Promise<boolean> {
    try {
      // Check if port is already in use
      const inUse = await checkHealthy(this.config.host, this.config.port, 1000);
      if (inUse) {
        console.warn(
          `GraphD already running on ${this.config.host}:${this.config.port}, reusing existing instance`
        );
        this.running = true;
        this.reusingExisting = true;
        return true;
      }

      // Initialize database
      this.store.initialize();
      this.running = true;
      this.reusingExisting = false;

      // Start HTTP server
      this.server = new GraphDHTTPServer(
        this.config.host,
        this.config.port,
        this
      );
      await this.server.start();

      // Verify server started
      const healthy = await checkHealthy(
        this.config.host,
        this.config.port,
        1000
      );
      if (!healthy) {
        console.warn('GraphD server started but health check failed');
      }

      console.log(
        `GraphD ready: db=${this.dbPath} root=${this.root} port=${this.config.port}`
      );
      return true;
    } catch (err) {
      if (err instanceof SchemaVersionError) {
        console.error(
          `GraphD schema version mismatch: found '${err.foundVersion}', ` +
            `expected '${err.expectedVersion}'. Delete ${err.dbPath} to recreate.`
        );
      } else {
        console.error('GraphD failed to start:', err);
      }
      this.running = false;
      return false;
    }
  }

  /**
   * Stop the GraphD manager.
   */
  async stop(): Promise<void> {
    this.running = false;

    // Don't stop if we're reusing an existing instance
    if (this.reusingExisting) {
      return;
    }

    if (this.server) {
      await this.server.stop();
      this.server = null;
    }

    this.store.close();
  }

  /**
   * Set active state (agent is processing).
   */
  setActive(active: boolean): void {
    this.active = active;
  }

  /**
   * Set paused state (pause indexing).
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  // =========================================================================
  // HTTP API Handlers
  // =========================================================================

  /**
   * Handle /health endpoint.
   */
  handleHealth(): HealthResponse {
    return {
      status: this.running ? 'ok' : 'stopped',
      version: GRAPHD_VERSION,
      schemaVersion: GRAPHD_SCHEMA_VERSION,
      root: this.root,
      dbPath: this.dbPath,
      active: this.active,
      paused: this.paused,
      stats: this.store.getStats(),
      lastIndex: this.lastIndexStats,
    };
  }

  /**
   * Handle /symbol endpoint.
   */
  handleSymbol(
    path: string,
    line: number
  ): Record<string, unknown> {
    if (!path || line <= 0) {
      return { error: 'missing_path_or_line' };
    }
    const rel = normalizePath(path, this.root);
    if (rel.startsWith('..')) {
      return { error: 'path_outside_root' };
    }
    const symbol = this.store.findSymbolByPosition(rel, line);
    return { symbol, path: rel };
  }

  /**
   * Handle /context endpoint.
   */
  handleContext(
    symbolId: string,
    depth: number
  ): Record<string, unknown> {
    const symbol = this.store.getSymbol(symbolId);
    if (!symbol) {
      return { error: 'symbol_not_found' };
    }
    const path = symbol.path as string;
    const imports = this.store.getImportsForFile(path);
    const importers = this.store.getImportersForFile(path);
    return {
      symbol,
      file: path,
      module_edges: { imports, imported_by: importers },
      derived: { callers: [] }, // TODO: implement derived edge cache
      depth,
    };
  }

  /**
   * Handle /impact endpoint.
   */
  handleImpact(payload: Record<string, unknown>): Record<string, unknown> {
    const entity = payload.entity as Record<string, unknown> | undefined;
    if (entity?.path) {
      const normalized = normalizePath(entity.path as string, this.root);
      if (normalized.startsWith('..')) {
        return { error: 'path_outside_root' };
      }
    }
    // TODO: implement impact engine
    return { items: [] };
  }

  /**
   * Handle /search endpoint.
   */
  handleSearch(payload: Record<string, unknown>): Record<string, unknown> {
    const pattern = payload.pattern as string | undefined;
    if (!pattern) {
      return { items: [] };
    }
    // TODO: implement ripgrep search
    return { items: [] };
  }

  /**
   * Handle /control endpoint.
   */
  handleControl(payload: Record<string, unknown>): Record<string, unknown> {
    if ('paused' in payload) {
      this.paused = Boolean(payload.paused);
    }
    if ('active' in payload) {
      this.active = Boolean(payload.active);
    }
    return { active: this.active, paused: this.paused };
  }

  /**
   * Handle /export endpoint.
   */
  handleExport(table: string, fmt: string): Record<string, unknown> {
    if (!this.config.allowExport) {
      return { error: 'export_disabled' };
    }
    if (fmt !== 'jsonl') {
      return { error: 'unsupported_format' };
    }
    try {
      const rows = this.store.exportTable(table);
      const data = rows.map((r) => JSON.stringify(r)).join('\n');
      return { format: 'jsonl', table, data };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /**
   * Handle /artifact endpoint.
   */
  handleArtifact(payload: Record<string, unknown>): Record<string, unknown> {
    const path = payload.path as string | undefined;
    const kind = payload.kind as string | undefined;
    const details = (payload.details ?? {}) as Record<string, unknown>;

    if (!path || !kind) {
      return { error: 'missing_path_or_kind' };
    }

    const rel = normalizePath(path, this.root);
    this.store.recordRunArtifact(rel, kind, details, nowSeconds());
    return { status: 'recorded' };
  }

  // =========================================================================
  // Session Management (v2)
  // =========================================================================

  /**
   * Create a new session.
   */
  sessionCreate(
    sessionKey: string,
    clientType: string,
    workingDir?: string,
    expiresAt?: number,
    metadata?: Record<string, unknown>
  ): Record<string, unknown> {
    try {
      const created = this.store.createSession(
        sessionKey,
        clientType,
        workingDir,
        expiresAt,
        metadata
      );
      if (created) {
        return { success: true, session_key: sessionKey };
      }
      return { success: false, error: 'session_key_exists' };
    } catch (err) {
      console.warn('Session create failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Get session by key.
   */
  sessionGet(sessionKey: string): Record<string, unknown> {
    try {
      const session = this.store.getSession(sessionKey);
      if (session) {
        return { session };
      }
      return { error: 'session_not_found', session_key: sessionKey };
    } catch (err) {
      console.warn('Session get failed:', err);
      return { error: (err as Error).message };
    }
  }

  /**
   * Touch session (update last_accessed_at, create if needed).
   */
  sessionTouch(
    sessionKey: string,
    workingDir?: string
  ): Record<string, unknown> {
    try {
      const updated = this.store.updateSessionAccess(sessionKey);
      if (updated) {
        return { success: true, created: false };
      }

      // Session doesn't exist - create it
      const parts = sessionKey.split('_');
      const clientType = parts[0] ?? 'unknown';

      const created = this.store.createSession(
        sessionKey,
        clientType,
        workingDir
      );
      if (created) {
        console.log(`Auto-created session: ${sessionKey}`);
        return { success: true, created: true };
      }

      // Race condition: session was created by another process
      return { success: true, created: false };
    } catch (err) {
      console.warn('Session touch failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Close a session.
   */
  sessionClose(sessionKey: string): Record<string, unknown> {
    try {
      const updated = this.store.updateSessionStatus(sessionKey, 'closed');
      return { success: updated };
    } catch (err) {
      console.warn('Session close failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Update session metadata.
   */
  sessionUpdateMetadata(
    sessionKey: string,
    metadata: Record<string, unknown>,
    merge = true
  ): Record<string, unknown> {
    try {
      const updated = this.store.updateSessionMetadata(
        sessionKey,
        metadata,
        merge
      );
      return { success: updated };
    } catch (err) {
      console.warn('Session update metadata failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Delete a session.
   */
  sessionDelete(sessionKey: string): boolean {
    try {
      return this.store.deleteSession(sessionKey);
    } catch (err) {
      console.warn('Session delete failed:', err);
      return false;
    }
  }

  /**
   * List sessions.
   */
  sessionsList(
    clientType?: string,
    status = 'active',
    limit = 50
  ): Record<string, unknown> {
    try {
      const sessions = this.store.listSessions(clientType, status, limit);
      return { sessions };
    } catch (err) {
      console.warn('Sessions list failed:', err);
      return { sessions: [], error: (err as Error).message };
    }
  }

  /**
   * Cleanup expired sessions.
   */
  sessionsCleanup(): Record<string, unknown> {
    try {
      const count = this.store.cleanupExpiredSessions();
      return { deleted_count: count };
    } catch (err) {
      console.warn('Sessions cleanup failed:', err);
      return { deleted_count: 0, error: (err as Error).message };
    }
  }

  // =========================================================================
  // Message Management
  // =========================================================================

  /**
   * Add a message to a session.
   */
  messageAdd(
    sessionKey: string,
    role: string,
    content: string,
    requestId?: string,
    metadata?: Record<string, unknown>
  ): Record<string, unknown> {
    try {
      const messageIndex = this.store.addMessage(
        sessionKey,
        role,
        content,
        requestId,
        metadata
      );
      return { success: true, message_index: messageIndex };
    } catch (err) {
      console.warn('Message add failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Get messages for a session.
   */
  messagesGet(
    sessionKey: string,
    limit = 100,
    offset = 0
  ): Record<string, unknown> {
    try {
      const messages = this.store.getMessages(sessionKey, limit, offset);
      return { messages };
    } catch (err) {
      console.warn('Messages get failed:', err);
      return { messages: [], error: (err as Error).message };
    }
  }

  /**
   * Clear all messages for a session.
   */
  messagesClear(sessionKey: string): Record<string, unknown> {
    try {
      const count = this.store.clearMessages(sessionKey);
      return { deleted_count: count };
    } catch (err) {
      console.warn('Messages clear failed:', err);
      return { deleted_count: 0, error: (err as Error).message };
    }
  }

  // =========================================================================
  // Context Snapshot Management
  // =========================================================================

  /**
   * Save a context snapshot.
   */
  contextSave(
    sessionKey: string,
    contextData: Record<string, unknown>
  ): Record<string, unknown> {
    try {
      const version = this.store.saveContextSnapshot(sessionKey, contextData);
      // Cleanup old snapshots
      this.store.cleanupOldSnapshots(sessionKey, 5);
      return { success: true, snapshot_version: version };
    } catch (err) {
      console.warn('Context save failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Get latest context snapshot.
   */
  contextGet(sessionKey: string): Record<string, unknown> {
    try {
      const snapshot = this.store.getLatestContextSnapshot(sessionKey);
      return { snapshot };
    } catch (err) {
      console.warn('Context get failed:', err);
      return { snapshot: null, error: (err as Error).message };
    }
  }

  /**
   * List context snapshots.
   */
  contextList(sessionKey: string, limit = 10): Record<string, unknown> {
    try {
      const snapshots = this.store.listContextSnapshots(sessionKey, limit);
      return { snapshots };
    } catch (err) {
      console.warn('Context list failed:', err);
      return { snapshots: [], error: (err as Error).message };
    }
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private resolveDbPath(dbPath: string): string {
    if (isAbsolute(dbPath)) {
      return dbPath;
    }
    return resolve(this.root, dbPath);
  }
}
