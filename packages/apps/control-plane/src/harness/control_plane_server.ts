/**
 * Dedicated Control Plane HTTP server.
 *
 * Runs independently from the harness daemon process and bridges mutable
 * operations over the bus while reading session state directly from GraphD.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServerType, type ServerResponse } from 'http';
import { createReadStream, existsSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { extname, join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { createGraphDConfig, GraphDManager } from 'graphd';
import { HarnessClient } from 'harness-client';
import { BusClient } from 'comms-bus';

import { loadConfig } from './config_loader.js';
import { handleControlPlaneRequest, type ControlPlaneContext } from './control_plane_routes.js';
import { normalizeSessionPermissionState, type SessionPermissionStateView } from './routes/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ControlPlaneServerOptions {
  host?: string;
  port?: number;
  dashboardPath?: string;
  workingDir?: string;
  configPath?: string;
  busHost?: string;
  busPort?: number;
}

type ControlPlaneBridgeRequestType =
  | 'control_plane_dispatch'
  | 'control_plane_stop'
  | 'control_plane_fork'
  | 'control_plane_permissions_get'
  | 'control_plane_permissions_update'
  | 'control_plane_resolve_escalation'
  | 'control_plane_memory_info'
  | 'control_plane_model_get'
  | 'control_plane_model_set'
  | 'async_start'
  | 'async_cancel'
  | 'async_status';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ControlPlaneServer {
  private readonly host: string;
  private readonly port: number;
  private readonly dashboardPath?: string;
  private readonly workingDir: string;
  private readonly configPath?: string;
  private readonly busHost: string;
  private readonly busPort: number;

  private graphd: GraphDManager | null = null;
  private graphdStarted = false;
  private server: HttpServerType | null = null;
  private staticRoot: string | null = null;

  constructor(options: ControlPlaneServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = Number.isFinite(options.port) ? (options.port as number) : 9445;
    this.dashboardPath = options.dashboardPath;
    this.workingDir = options.workingDir ?? process.cwd();
    this.configPath = options.configPath;
    this.busHost = options.busHost ?? process.env.EVENT_BUS_HOST ?? '127.0.0.1';
    const rawBusPort = options.busPort ?? Number(process.env.EVENT_BUS_PORT ?? '9555');
    this.busPort = Number.isFinite(rawBusPort) ? rawBusPort : 9555;
  }

  async start(): Promise<{ host: string; port: number }> {
    await this.startGraphD();
    this.staticRoot = this.resolveStaticRoot();

    if (this.dashboardPath && !this.staticRoot) {
      console.warn(`[control-plane] Dashboard dist not found at ${this.dashboardPath}; serving API only`);
    } else if (!this.staticRoot) {
      console.warn('[control-plane] Dashboard dist not found; serving API only');
    }

    this.server = createHttpServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(this.port, this.host, () => {
        resolve({ host: this.host, port: this.port });
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    if (this.graphd && this.graphdStarted) {
      await this.graphd.stop();
      this.graphd = null;
      this.graphdStarted = false;
    }
  }

  private async startGraphD(): Promise<void> {
    try {
      const config = loadConfig(this.configPath, this.workingDir);
      if (!config.graphd.enabled) {
        console.warn('[control-plane] GraphD disabled in config; API routes will be limited');
        return;
      }

      const graphdConfig = createGraphDConfig(config.tools.repoRoot, {
        host: config.graphd.host,
        port: config.graphd.port,
        dbPath: config.graphd.dbPath,
      });

      this.graphd = new GraphDManager(graphdConfig);
      this.graphdStarted = await this.graphd.connect();
      if (!this.graphdStarted) {
        const graphdAddress = `${config.graphd.host}:${config.graphd.port}`;
        console.warn(
          `[control-plane] GraphD is not running at ${graphdAddress}; start GraphD before control-plane for full API support`
        );
        this.graphd = null;
      }
    } catch (error) {
      console.warn('[control-plane] Failed to connect to GraphD:', errorMessage(error));
      this.graphd = null;
      this.graphdStarted = false;
    }
  }

  private resolveStaticRoot(): string | null {
    if (this.dashboardPath && existsSync(join(this.dashboardPath, 'index.html'))) {
      return this.dashboardPath;
    }

    if (this.dashboardPath) {
      return null;
    }

    const candidates = [
      join(__dirname, '../../../dashboard-control/dist'),
      join(process.cwd(), 'packages/apps/dashboard-control/dist'),
      join(process.cwd(), 'node_modules/@jesus/dashboard-control/dist'),
    ];

    return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? null;
  }

  private async withBridgeClient<T>(fn: (client: HarnessClient) => Promise<T>): Promise<T> {
    const client = new HarnessClient({
      host: this.busHost,
      port: this.busPort,
      requestTimeout: 15_000,
      maxReconnectAttempts: 0,
    });

    await client.connect();
    try {
      return await fn(client);
    } finally {
      client.close();
    }
  }

  private async requestBridge<T extends Record<string, unknown>>(
    type: ControlPlaneBridgeRequestType,
    data: Record<string, unknown>
  ): Promise<T> {
    return this.withBridgeClient((client) => client.request<T>(type, data));
  }

  private createContext(): ControlPlaneContext {
    return {
      graphd: this.graphd,
      isGraphDReady: () => !!(this.graphd && this.graphdStarted),
      workingDir: this.workingDir,
      dispatchSessionInput: async (sessionKey, message, options) => {
        try {
          const requestId = `cockpit-${randomUUID()}`;
          const result = await this.requestBridge<{
            success?: boolean;
            requestId?: string;
            error?: string;
          }>('control_plane_dispatch', {
            session_key: sessionKey,
            message,
            request_id: requestId,
            ...(typeof options?.context === 'string' && options.context.trim().length > 0
              ? { context: options.context.trim() }
              : {}),
            ...(isRecord(options?.metadata) ? { metadata: options.metadata } : {}),
          });

          return {
            success: result.success === true,
            requestId: typeof result.requestId === 'string' ? result.requestId : requestId,
            ...(typeof result.error === 'string' ? { error: result.error } : {}),
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
      respondToPermissionRequest: async (sessionKey, input) => {
        try {
          return await this.withBridgeClient(async (client) => {
            const initSent = client.send({
              type: 'init',
              data: {
                session_key: sessionKey,
              },
            });
            if (!initSent) {
              return { success: false, error: 'Failed to initialize bridge session for permission response' };
            }
            await new Promise((resolve) => setTimeout(resolve, 5));

            const sent = client.send({
              type: 'permission_response',
              data: {
                request_id: input.requestId,
                decision: input.decision,
                ...(typeof input.pattern === 'string' && input.pattern.trim().length > 0
                  ? { pattern: input.pattern.trim() }
                  : {}),
              },
            });
            if (!sent) {
              return { success: false, error: 'Failed sending permission response to bridge' };
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { success: true };
          });
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
      stopSession: async (sessionKey, note) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            requestId?: string;
            error?: string;
          }>('control_plane_stop', {
            session_key: sessionKey,
            ...(typeof note === 'string' && note.trim().length > 0 ? { note } : {}),
          });
          return {
            success: result.success === true,
            ...(typeof result.requestId === 'string' ? { requestId: result.requestId } : {}),
            ...(typeof result.error === 'string' ? { error: result.error } : {}),
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
      forkSession: async (sourceSessionKey, targetSessionKey) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            targetSessionKey?: string;
            error?: string;
          }>('control_plane_fork', {
            source_session_key: sourceSessionKey,
            ...(typeof targetSessionKey === 'string' && targetSessionKey.trim().length > 0
              ? { target_session_key: targetSessionKey.trim() }
              : {}),
          });
          return {
            success: result.success === true,
            ...(typeof result.targetSessionKey === 'string' ? { targetSessionKey: result.targetSessionKey } : {}),
            ...(typeof result.error === 'string' ? { error: result.error } : {}),
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
      getSessionPermissionState: async (sessionKey, options) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            state?: unknown;
            error?: string;
          }>('control_plane_permissions_get', {
            session_key: sessionKey,
            ...(typeof options?.workingDir === 'string' && options.workingDir.trim().length > 0
              ? { working_dir: options.workingDir.trim() }
              : {}),
          });

          if (result.success !== true) {
            return null;
          }
          return normalizeSessionPermissionState(result.state) as SessionPermissionStateView;
        } catch {
          return null;
        }
      },
      updateSessionPermissionState: async (sessionKey, input, options) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            state?: unknown;
            error?: string;
          }>('control_plane_permissions_update', {
            session_key: sessionKey,
            update: input,
            ...(typeof options?.workingDir === 'string' && options.workingDir.trim().length > 0
              ? { working_dir: options.workingDir.trim() }
              : {}),
          });

          if (result.success !== true) {
            return null;
          }
          return normalizeSessionPermissionState(result.state) as SessionPermissionStateView;
        } catch {
          return null;
        }
      },
      resolveSessionEscalation: async (sessionKey, escalationId, resolution) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            escalationId?: string;
            pendingCount?: number;
            sessionStatus?: string;
            resumed?: boolean;
            resumeRequestId?: string;
            alreadyResolved?: boolean;
            error?: string;
          }>('control_plane_resolve_escalation', {
            session_key: sessionKey,
            escalation_id: escalationId,
            resolution,
          });

          return {
            success: result.success === true,
            escalationId: typeof result.escalationId === 'string' ? result.escalationId : escalationId,
            ...(typeof result.pendingCount === 'number' ? { pendingCount: result.pendingCount } : {}),
            ...(typeof result.sessionStatus === 'string' ? { sessionStatus: result.sessionStatus } : {}),
            ...(typeof result.resumed === 'boolean' ? { resumed: result.resumed } : {}),
            ...(typeof result.resumeRequestId === 'string' ? { resumeRequestId: result.resumeRequestId } : {}),
            ...(typeof result.alreadyResolved === 'boolean' ? { alreadyResolved: result.alreadyResolved } : {}),
            ...(typeof result.error === 'string' ? { error: result.error } : {}),
          };
        } catch (error) {
          return {
            success: false,
            escalationId,
            error: errorMessage(error),
          };
        }
      },
      getDebugMemoryInfo: async () => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            sessionCount?: number;
            maxSessions?: number;
            sessions?: unknown;
          }>('control_plane_memory_info', {});

          const sessions = Array.isArray(result.sessions)
            ? result.sessions.filter((item): item is {
                sessionKey: string;
                contextItemCount: number;
                contextEstimatedTokens: number;
                observerContextItemCount: number;
                workItemLogCount: number;
                workItemsCreatedCount: number;
                lastAccessMs: number;
                isExecuting: boolean;
              } => isRecord(item) && typeof item.sessionKey === 'string')
            : [];

          return {
            sessionCount: typeof result.sessionCount === 'number' ? result.sessionCount : sessions.length,
            maxSessions: typeof result.maxSessions === 'number' ? result.maxSessions : 0,
            sessions,
          };
        } catch {
          return {
            sessionCount: 0,
            maxSessions: 0,
            sessions: [],
          };
        }
      },
      getSessionModelSelections: async (sessionKey) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            selections?: Record<string, { provider: string; model: string; reasoning?: string }>;
          }>('control_plane_model_get', { session_key: sessionKey });
          return {
            success: result.success === true,
            selections: isRecord(result.selections) ? result.selections as Record<string, { provider: string; model: string; reasoning?: string }> : {},
          };
        } catch {
          return { success: false, selections: {} };
        }
      },
      setSessionModelSelection: async (sessionKey, agentType, selection) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            agentType?: string;
            selection?: { provider: string; model: string; reasoning?: string };
            error?: string;
          }>('control_plane_model_set', {
            session_key: sessionKey,
            agent_type: agentType,
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoning ? { reasoning: selection.reasoning } : {}),
          });
          return {
            success: result.success === true,
            agentType: typeof result.agentType === 'string' ? result.agentType : agentType,
            selection: isRecord(result.selection) ? result.selection as { provider: string; model: string; reasoning?: string } : selection,
            ...(typeof result.error === 'string' ? { error: result.error } : {}),
          };
        } catch (error) {
          return { success: false, agentType, selection, error: errorMessage(error) };
        }
      },
      startSessionAsync: async (sessionKey, goal) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            requestId?: string;
            goal?: string;
            error?: string;
          }>('async_start', {
            session_key: sessionKey,
            goal,
          });
          return {
            success: result.success === true,
            ...(typeof result.requestId === 'string' ? { requestId: result.requestId } : {}),
            ...(typeof result.goal === 'string' ? { goal: result.goal } : {}),
            ...(typeof result.error === 'string' ? { error: result.error } : {}),
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
      cancelSessionAsync: async (sessionKey) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            error?: string;
          }>('async_cancel', {
            session_key: sessionKey,
          });
          return { success: result.success === true, ...(typeof result.error === 'string' ? { error: result.error } : {}) };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
      getSessionAsyncStatus: async (sessionKey) => {
        try {
          const result = await this.requestBridge<{
            success?: boolean;
            running?: boolean;
            requestId?: string;
            goal?: string;
            startedAt?: number;
            elapsedMs?: number;
            error?: string;
          }>('async_status', {
            session_key: sessionKey,
          });
          return {
            success: result.success === true,
            running: result.running === true,
            ...(typeof result.requestId === 'string' ? { requestId: result.requestId } : {}),
            ...(typeof result.goal === 'string' ? { goal: result.goal } : {}),
            ...(typeof result.startedAt === 'number' ? { startedAt: result.startedAt } : {}),
            ...(typeof result.elapsedMs === 'number' ? { elapsedMs: result.elapsedMs } : {}),
            ...(typeof result.error === 'string' ? { error: result.error } : {}),
          };
        } catch (error) {
          return { success: false, running: false, error: errorMessage(error) };
        }
      },
      subscribeEvents: (handler) => {
        let closed = false;
        let connecting = false;
        let bus: BusClient | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

        const clearReconnectTimer = () => {
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
        };

        const scheduleReconnect = () => {
          if (closed || reconnectTimer) return;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connectAndSubscribe();
          }, 300);
        };

        const detachCurrentBus = () => {
          if (!bus) return;
          try {
            bus.unsubscribe('events:all');
          } catch {
            // Ignore unsubscribe errors during reconnect.
          }
          bus.close();
          bus = null;
        };

        const connectAndSubscribe = async () => {
          if (closed || connecting) return;
          connecting = true;
          detachCurrentBus();

          const nextBus = new BusClient({ host: this.busHost, port: this.busPort });
          bus = nextBus;

          nextBus.on('event', (payload, channel) => {
            if (channel !== 'events:all' || !isRecord(payload)) {
              return;
            }
            const type = typeof payload.type === 'string' ? payload.type : 'unknown';
            const data = isRecord(payload.data) ? payload.data : payload;
            const sessionKeyRaw = data.session_key
              ?? data.sessionKey
              ?? payload.session_key
              ?? payload.sessionKey;
            const sessionKey = typeof sessionKeyRaw === 'string' ? sessionKeyRaw : undefined;
            handler({ type, ...(sessionKey ? { sessionKey } : {}), data });
          });

          nextBus.on('close', () => {
            if (closed) return;
            scheduleReconnect();
          });

          nextBus.on('error', () => {
            if (closed) return;
            scheduleReconnect();
          });

          try {
            await nextBus.connect();
            if (closed) {
              nextBus.close();
              return;
            }
            nextBus.subscribe('events:all');
          } catch (error) {
            console.warn('[control-plane] Failed to subscribe to events:', errorMessage(error));
            scheduleReconnect();
          } finally {
            connecting = false;
          }
        };

        void connectAndSubscribe();

        return () => {
          closed = true;
          clearReconnectTimer();
          detachCurrentBus();
        };
      },
    };
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controlPlaneCtx = this.createContext();
    if (handleControlPlaneRequest(req, res, controlPlaneCtx)) {
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this.staticRoot) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Dashboard static assets unavailable' }));
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const requestedPath = join(this.staticRoot, url.pathname);
    if (!requestedPath.startsWith(this.staticRoot)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let filePath = requestedPath;
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(this.staticRoot, 'index.html');
    }

    this.serveFile(res, filePath);
  }

  private serveFile(res: ServerResponse, filePath: string): void {
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    };

    try {
      const stat = statSync(filePath);
      const ext = extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
}

function parseControlPlaneArgs(): ControlPlaneServerOptions {
  const args = process.argv.slice(2);
  const options: ControlPlaneServerOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--port' || arg === '--dashboard-port') && i + 1 < args.length) {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '--host' && i + 1 < args.length) {
      options.host = args[++i];
    } else if (arg === '--dashboard-path' && i + 1 < args.length) {
      options.dashboardPath = args[++i];
    } else if (arg === '--working-dir' && i + 1 < args.length) {
      options.workingDir = args[++i];
    } else if (arg === '--config' && i + 1 < args.length) {
      options.configPath = args[++i];
    } else if (arg === '--bus-host' && i + 1 < args.length) {
      options.busHost = args[++i];
    } else if (arg === '--bus-port' && i + 1 < args.length) {
      options.busPort = parseInt(args[++i], 10);
    }
  }

  return options;
}

export async function runControlPlaneServer(): Promise<void> {
  const options = parseControlPlaneArgs();
  const server = new ControlPlaneServer(options);
  const address = await server.start();
  console.log(`[control-plane] listening on http://${address.host}:${address.port}`);

  const shutdown = async (signal: string) => {
    console.log(`[control-plane] received ${signal}, shutting down`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runControlPlaneServer().catch((error) => {
    console.error('[control-plane] fatal error:', error);
    process.exit(1);
  });
}
