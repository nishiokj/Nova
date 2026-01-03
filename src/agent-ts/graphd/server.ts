/**
 * HTTP server for GraphD.
 *
 * Ported from: src/harness/graphd/server.py
 *
 * Uses Node.js built-in http module to minimize dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
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

      default:
        this.sendJson(res, { error: 'not_found' }, 404);
    }
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

      default:
        this.sendJson(res, { error: 'not_found' }, 404);
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

      // Enable SO_REUSEADDR
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`Port ${this.port} is in use, attempting to bind anyway`);
          // Try to close and rebind
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
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
        // Force close after 5 seconds
        setTimeout(() => {
          if (this.server) {
            this.server = null;
          }
          resolve();
        }, 5000);
      } else {
        resolve();
      }
    });
  }

  /**
   * Check if server is running.
   */
  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
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
