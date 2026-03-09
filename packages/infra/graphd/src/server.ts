/**
 * HTTP server for GraphD.
 *
 * Ported from: src/harness/graphd/server.py
 *
 * Uses Node.js built-in http module to minimize dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import type { Socket } from 'net';
import { URL } from 'url';
import type { GraphDManager } from './manager.js';
import { safeInt } from './utils.js';

// ============================================
// REQUEST HANDLER
// ============================================

/**
 * Handle HTTP requests for GraphD.
 */
export class GraphDRequestHandler {
  constructor(private readonly manager: GraphDManager) {}

  /**
   * Handle an incoming request.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET') {
        await this.handleGet(path, url.searchParams, res);
      } else if (method === 'POST') {
        const payload = await this.readJson(req);
        await this.handlePost(path, payload, res);
      } else if (method === 'DELETE') {
        await this.handleDelete(path, res);
      } else {
        this.sendJson(res, { error: 'method_not_allowed' }, 405);
      }
    } catch (err) {
      console.error('GraphD request error:', err);
      this.sendJson(res, { error: 'internal_error' }, 500);
    }
  }

  private async handleGet(
    path: string,
    params: URLSearchParams,
    res: ServerResponse
  ): Promise<void> {
    // Control-plane routes
    if (path.startsWith('/control-plane/')) {
      this.handleControlPlaneGet(path, params, res);
      return;
    }

    switch (path) {
      case '/health':
        this.sendJson(res, this.manager.handleHealth());
        break;

      case '/symbol': {
        const filePath = params.get('path') ?? '';
        const line = safeInt(params.get('line'), 0);
        this.sendJson(res, this.manager.handleSymbol(filePath, line));
        break;
      }

      case '/context': {
        const symbolId = params.get('symbol_id') ?? '';
        const depth = safeInt(params.get('depth'), 1);
        this.sendJson(res, this.manager.handleContext(symbolId, depth));
        break;
      }

      case '/export': {
        const table = params.get('table') ?? 'files';
        const fmt = params.get('format') ?? 'jsonl';
        this.sendJson(res, this.manager.handleExport(table, fmt));
        break;
      }

      case '/traces/by-file': {
        const filePath = params.get('file_path');
        if (!filePath) {
          this.sendJson(res, { error: 'missing_file_path' }, 400);
          break;
        }
        const limit = safeInt(params.get('limit'), 100);
        const offset = safeInt(params.get('offset'), 0);
        this.sendJson(res, this.manager.fileTracesByPathGet(filePath, { limit, offset }));
        break;
      }

      default: {
        // Dynamic GET routes with path params
        const sessionTracesMatch = /^\/sessions\/([^/]+)\/traces$/.exec(path);
        if (sessionTracesMatch) {
          const sessionKey = decodeURIComponent(sessionTracesMatch[1]);
          const filePath = params.get('file_path') ?? undefined;
          const toolName = params.get('tool_name') ?? undefined;
          const limit = safeInt(params.get('limit'), 100);
          const offset = safeInt(params.get('offset'), 0);
          this.sendJson(res, this.manager.fileTracesGet(sessionKey, { filePath, toolName, limit, offset }));
          break;
        }
        this.sendJson(res, { error: 'not_found' }, 404);
      }
    }
  }

  /**
   * Handle control-plane GET requests for dashboard-control.
   */
  private handleControlPlaneGet(
    path: string,
    params: URLSearchParams,
    res: ServerResponse
  ): void {
    // GET /control-plane/sessions
    if (path === '/control-plane/sessions') {
      const limit = safeInt(params.get('limit'), 50);
      const result = this.manager.sessionsList({ limit });
      const sessions = ((result as { sessions?: unknown[] }).sessions ?? []).map(this.formatSession);
      this.sendJson(res, { sessions });
      return;
    }

    // GET /control-plane/projects
    if (path === '/control-plane/projects') {
      const result = this.manager.sessionsList({ limit: 1000 });
      const sessions = (result as { sessions?: { workingDir?: string; lastAccessedAt?: number }[] }).sessions ?? [];

      const projectMap = new Map<string, { count: number; lastAccessed: number }>();
      for (const session of sessions) {
        const wd = session.workingDir;
        if (!wd) continue;
        const existing = projectMap.get(wd);
        if (existing) {
          existing.count++;
          existing.lastAccessed = Math.max(existing.lastAccessed, session.lastAccessedAt ?? 0);
        } else {
          projectMap.set(wd, { count: 1, lastAccessed: session.lastAccessedAt ?? 0 });
        }
      }

      const projects = Array.from(projectMap.entries())
        .map(([p, data]) => ({
          id: p,
          name: p.split('/').pop() || p,
          path: p,
          sessionCount: data.count,
          activeGoals: 0,
        }))
        .sort((a, b) => b.sessionCount - a.sessionCount);

      this.sendJson(res, { projects });
      return;
    }

    // GET /control-plane/sessions/:id/messages
    const messagesMatch = /^\/control-plane\/sessions\/([^/]+)\/messages$/.exec(path);
    if (messagesMatch) {
      const sessionKey = decodeURIComponent(messagesMatch[1]);
      const result = this.manager.messagesGet(sessionKey, 200, 0);
      const messages = ((result as { messages?: unknown[] }).messages ?? []).map(this.formatMessage);
      this.sendJson(res, { messages });
      return;
    }

    // GET /control-plane/sessions/:id
    const sessionMatch = /^\/control-plane\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch) {
      const sessionKey = decodeURIComponent(sessionMatch[1]);
      const result = this.manager.sessionGet(sessionKey);
      const session = (result as { session?: unknown }).session;
      this.sendJson(res, { session: session ? this.formatSession(session) : null });
      return;
    }

    // GET /control-plane/traces (placeholder - returns empty)
    if (path === '/control-plane/traces') {
      this.sendJson(res, { traces: [] });
      return;
    }

    // GET /control-plane/goals/hierarchy (placeholder)
    if (path === '/control-plane/goals/hierarchy') {
      this.sendJson(res, { goals: [] });
      return;
    }

    // GET /control-plane/token-usage (placeholder)
    if (path === '/control-plane/token-usage') {
      this.sendJson(res, { usage: [] });
      return;
    }

    this.sendJson(res, { error: 'not_found' }, 404);
  }

  private formatSession(row: unknown): object {
    const r = row as { sessionKey?: string; clientType?: string; workingDir?: string; status?: string; createdAt?: number; lastAccessedAt?: number; metadata?: unknown };
    return {
      id: r.sessionKey,
      clientType: r.clientType,
      workingDir: r.workingDir,
      status: r.status,
      createdAt: r.createdAt ? new Date(r.createdAt * 1000).toISOString() : null,
      lastAccessedAt: r.lastAccessedAt ? new Date(r.lastAccessedAt * 1000).toISOString() : null,
      metadata: r.metadata,
    };
  }

  private formatMessage(row: unknown): object {
    const r = row as { id?: number; role?: string; content?: string; requestId?: string; createdAt?: number; metadata?: unknown };
    return {
      id: r.id,
      role: r.role,
      content: r.content,
      requestId: r.requestId,
      createdAt: r.createdAt ? new Date(r.createdAt * 1000).toISOString() : null,
      metadata: r.metadata,
    };
  }

  private async handlePost(
    path: string,
    payload: Record<string, unknown>,
    res: ServerResponse
  ): Promise<void> {
    switch (path) {
      case '/impact':
        this.sendJson(res, this.manager.handleImpact(payload));
        break;

      case '/search':
        this.sendJson(res, this.manager.handleSearch(payload));
        break;

      case '/control':
        this.sendJson(res, this.manager.handleControl(payload));
        break;

      case '/artifact':
        this.sendJson(res, this.manager.handleArtifact(payload));
        break;

      default: {
        // Dynamic POST routes with path params
        const sessionTracesMatch = /^\/sessions\/([^/]+)\/traces$/.exec(path);
        if (sessionTracesMatch) {
          const sessionKey = decodeURIComponent(sessionTracesMatch[1]);
          const filePath = payload.file_path as string | undefined;
          const toolName = payload.tool_name as string | undefined;
          const newContent = payload.new_content as string | undefined;
          const contentHash = payload.content_hash as string | undefined;
          if (!filePath || !toolName || !newContent || !contentHash) {
            this.sendJson(res, { error: 'missing required fields: file_path, tool_name, new_content, content_hash' }, 400);
            break;
          }
          this.sendJson(res, this.manager.fileTraceAdd(sessionKey, {
            filePath,
            toolName,
            modelId: payload.model_id as string | undefined,
            requestId: payload.request_id as string | undefined,
            oldContent: payload.old_content as string | undefined,
            newContent,
            contentHash,
            createdAt: payload.created_at as number | undefined,
          }));
          break;
        }
        this.sendJson(res, { error: 'not_found' }, 404);
      }
    }
  }

  private async handleDelete(path: string, res: ServerResponse): Promise<void> {
    if (path.startsWith('/session/')) {
      const sessionKey = path.slice('/session/'.length);
      if (!sessionKey) {
        this.sendJson(res, { error: 'missing_session_key' }, 400);
        return;
      }
      const deleted = this.manager.sessionDelete(sessionKey);
      this.sendJson(res, { deleted, session_key: sessionKey });
      return;
    }

    this.sendJson(res, { error: 'not_found' }, 404);
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        if (!body) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body) as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
      req.on('error', () => {
        resolve({});
      });
    });
  }

  private sendJson(
    res: ServerResponse,
    payload: Record<string, unknown> | object,
    status = 200
  ): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}

// ============================================
// HTTP SERVER
// ============================================

/**
 * GraphD HTTP server.
 */
export class GraphDHTTPServer {
  private server: Server | null = null;
  private readonly handler: GraphDRequestHandler;
  private shutdownRequested = false;
  private connections = new Set<Socket>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly manager: GraphDManager
  ) {
    this.handler = new GraphDRequestHandler(manager);
  }

  /**
   * Start the HTTP server.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        // Don't log requests (matching Python behavior)
        this.handler.handle(req, res).catch((err) => {
          console.error('Request handler error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal_error' }));
          }
        });
      });

      // Track connections for clean shutdown
      this.server.on('connection', (socket) => {
        this.connections.add(socket);
        socket.on('close', () => {
          this.connections.delete(socket);
        });
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`Port ${this.port} is in use`);
          this.server?.close();
          reject(err);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        resolve();
      });
    });
  }

  /**
   * Stop the server gracefully.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.shutdownRequested = true;
      if (!this.server) {
        resolve();
        return;
      }

      // Stop accepting new connections
      this.server.close(() => {
        this.server = null;
        this.connections.clear();
        resolve();
      });

      // Destroy all active connections after a short grace period
      setTimeout(() => {
        for (const socket of this.connections) {
          socket.destroy();
        }
        this.connections.clear();
      }, 500);

      // Force resolve after 2 seconds if server.close() hasn't completed
      setTimeout(() => {
        if (this.server) {
          this.server = null;
          this.connections.clear();
        }
        resolve();
      }, 2000);
    });
  }

  /**
   * Check if server is running.
   */
  get isRunning(): boolean {
    return this.server?.listening ?? false;
  }
}

// ============================================
// HEALTH CHECK UTILITY
// ============================================

/**
 * Check if GraphD server is responding at the given URL.
 */
export async function checkHealthy(
  host: string,
  port: number,
  timeoutMs = 2000
): Promise<boolean> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    fetch(`http://${host}:${port}/health`, { signal: controller.signal })
      .then((res) => {
        clearTimeout(timeoutId);
        resolve(res.ok);
      })
      .catch(() => {
        clearTimeout(timeoutId);
        resolve(false);
      });
  });
}
