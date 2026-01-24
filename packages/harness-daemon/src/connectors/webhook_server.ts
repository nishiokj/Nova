/**
 * Webhook Server
 *
 * Minimal HTTP server for handling incoming webhooks from external services.
 * Runs alongside the BusServer in HarnessDaemon.
 */

import http from 'http';
import type { TelegramConnector, TelegramUpdate } from './telegram.js';

// ============================================================================
// Types
// ============================================================================

export interface WebhookServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: '0.0.0.0') */
  host?: string;
  /** Optional: Secret token for webhook verification */
  secretToken?: string;
}

export interface WebhookRoute {
  method: 'GET' | 'POST';
  path: RegExp;
  handler: (
    body: unknown,
    params: Record<string, string>,
    headers: Record<string, string>
  ) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
}

// ============================================================================
// Webhook Server
// ============================================================================

export class WebhookServer {
  private readonly config: WebhookServerConfig;
  private server: http.Server | null = null;
  private routes: WebhookRoute[] = [];

  constructor(config: WebhookServerConfig) {
    this.config = {
      host: '0.0.0.0',
      ...config,
    };
  }

  /**
   * Register a route handler.
   */
  route(method: 'GET' | 'POST', pathPattern: string, handler: WebhookRoute['handler']): void {
    // Convert path pattern to regex
    // Supports :param syntax for path parameters
    const regexPattern = pathPattern
      .replace(/:[a-zA-Z0-9_]+/g, (match) => `(?<${match.slice(1)}>[^/]+)`)
      .replace(/\//g, '\\/');

    this.routes.push({
      method,
      path: new RegExp(`^${regexPattern}$`),
      handler,
    });
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.on('error', reject);

      this.server.listen(this.config.port, this.config.host, () => {
        const address = this.server!.address();
        if (typeof address === 'object' && address) {
          resolve({ host: address.address, port: address.port });
        } else {
          resolve({ host: this.config.host!, port: this.config.port });
        }
      });
    });
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Handle an incoming HTTP request.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method?.toUpperCase() ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Extract headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value;
      }
    }

    // Health check endpoint
    if (path === '/health' && method === 'GET') {
      this.sendResponse(res, 200, { status: 'ok' });
      return;
    }

    // Find matching route
    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = path.match(route.path);
      if (!match) continue;

      // Extract path parameters
      const params: Record<string, string> = match.groups ?? {};

      // Read body for POST requests
      let body: unknown = null;
      if (method === 'POST') {
        try {
          body = await this.readBody(req);
        } catch (error) {
          this.sendResponse(res, 400, { error: 'Invalid request body' });
          return;
        }
      }

      // Execute handler
      try {
        const result = await route.handler(body, params, headers);
        this.sendResponse(res, result.status, result.body, result.headers);
      } catch (error) {
        console.error('[WebhookServer] Handler error:', error);
        this.sendResponse(res, 500, { error: 'Internal server error' });
      }
      return;
    }

    // No matching route
    this.sendResponse(res, 404, { error: 'Not found' });
  }

  /**
   * Read the request body as JSON.
   */
  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(body ? JSON.parse(body) : null);
        } catch (error) {
          reject(error);
        }
      });

      req.on('error', reject);
    });
  }

  /**
   * Send an HTTP response.
   */
  private sendResponse(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>
  ): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...headers,
    });
    res.end(JSON.stringify(body));
  }
}

// ============================================================================
// Telegram Webhook Registration
// ============================================================================

/**
 * Register Telegram webhook routes on the server.
 */
export function registerTelegramWebhook(
  server: WebhookServer,
  connector: TelegramConnector,
  options?: { secretToken?: string }
): void {
  const botId = connector.getBotId();

  // POST /webhook/telegram/:botId
  server.route('POST', `/webhook/telegram/${botId}`, async (body, params, headers) => {
    // Verify secret token if configured
    if (options?.secretToken) {
      const headerToken = headers['x-telegram-bot-api-secret-token'];
      if (headerToken !== options.secretToken) {
        console.warn('[TelegramWebhook] Invalid secret token');
        return { status: 401, body: { error: 'Unauthorized' } };
      }
    }

    // Validate update
    if (!body || typeof body !== 'object') {
      return { status: 400, body: { error: 'Invalid request body' } };
    }

    const update = body as TelegramUpdate;
    if (typeof update.update_id !== 'number') {
      return { status: 400, body: { error: 'Missing update_id' } };
    }

    // Process asynchronously - Telegram expects quick response
    void connector.handleUpdate(update).catch((error) => {
      console.error('[TelegramWebhook] Error processing update:', error);
    });

    return { status: 200, body: { ok: true } };
  });

  console.log(`[WebhookServer] Registered Telegram webhook at /webhook/telegram/${botId}`);
}
