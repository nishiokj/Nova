/**
 * Harness daemon entrypoint for JSONL/TCP bridge.
 *
 * Supports:
 * - TCP/JSONL bus for client connections (TUI, external integrations via harness-client)
 */

import { pathToFileURL, fileURLToPath } from 'url';
import { createServer as createHttpServer, type Server as HttpServerType, type IncomingMessage, type ServerResponse } from 'http';
import { createReadStream, statSync, existsSync } from 'fs';
import { join, extname, dirname } from 'path';
import { randomUUID } from 'crypto';
import { createHarnessFromEnv, type AgentHarness } from './harness.js';
import { BusServer, WsBridgeServer } from 'comms-bus';
import { BridgeGateway } from './bridge_gateway.js';
import { createAuthServiceFromConfig, type AuthService } from './auth_service.js';
import { translateAgentEvent } from './event_translator.js';
import { handleControlPlaneRequest, type ControlPlaneContext } from './control_plane_routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface HarnessDaemonOptions {
  host?: string;
  port?: number;
  /** WebSocket port for browser dashboard access (default: port + 1, e.g., 9556) */
  wsPort?: number;
  /** HTTP port for serving the Control Plane dashboard. Set to enable dashboard serving. */
  dashboardPort?: number;
  /** Path to dashboard static files (default: auto-detect dashboard-control/dist) */
  dashboardPath?: string;
  workingDir?: string;
  configPath?: string;
  /** Idle timeout in ms before daemon shuts down when no clients connected. Set to 0 to disable. */
  idleTimeoutMs?: number;
  /** Dangerous mode - bypasses all permission checks. Use with extreme caution. */
  dangerousMode?: boolean;
}

// Default idle timeout: 5 seconds
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

export class HarnessDaemon {
  private readonly host: string;
  private readonly port: number;
  private readonly wsPort: number;
  private readonly dashboardPort?: number;
  private readonly dashboardPath?: string;
  private readonly workingDir: string;
  private readonly configPath?: string;
  private readonly idleTimeoutMs: number;
  private readonly dangerousMode: boolean;
  private harness: AgentHarness | null = null;
  private bus: BusServer | null = null;
  private wsBridge: WsBridgeServer | null = null;
  private dashboardServer: HttpServerType | null = null;
  private gateway: BridgeGateway | null = null;
  private authService: AuthService | null = null;
  private authConfig: { enabled: boolean; host: string; port: number; google_client_id?: string; google_redirect_uri?: string; master_key_path?: string; graphd_db_path?: string } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownRequested = false;

  constructor(options: HarnessDaemonOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    const rawPort = options.port ?? 9555;
    this.port = Number.isFinite(rawPort) ? rawPort : 9555;
    this.wsPort = options.wsPort ?? this.port + 1; // Default: 9556
    this.dashboardPort = options.dashboardPort;
    this.dashboardPath = options.dashboardPath;
    this.workingDir = options.workingDir ?? process.cwd();
    this.configPath = options.configPath;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.dangerousMode = options.dangerousMode ?? false;
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private startIdleTimer(): void {
    if (this.idleTimeoutMs <= 0 || this.shutdownRequested) return;

    this.cancelIdleTimer();
    console.log(`[harness-daemon] No clients connected, will shutdown in ${this.idleTimeoutMs / 1000}s`);

    this.idleTimer = setTimeout(() => {
      if (this.bus && this.bus.getConnectionCount() === 0) {
        console.log('[harness-daemon] Idle timeout reached, shutting down');
        this.shutdownRequested = true;
        void this.stop().then(() => process.exit(0));
      }
    }, this.idleTimeoutMs);
  }

  private handleConnect(connectionId: string): void {
    console.log(`[harness-daemon] Client connected: ${connectionId}`);
    this.cancelIdleTimer();
  }

  private handleDisconnect(connectionId: string): void {
    this.gateway?.handleDisconnect(connectionId);

    const remaining = this.bus?.getConnectionCount() ?? 0;
    console.log(`[harness-daemon] Client disconnected: ${connectionId}, remaining: ${remaining}`);

    if (remaining === 0) {
      this.startIdleTimer();
    }
  }

  async start(): Promise<{ host: string; port: number }> {
    if (!this.harness) {
      // Create harness - API keys are resolved at request time via ProviderKeyService
      // No preloading needed - harness queries GraphD at runtime
      this.harness = createHarnessFromEnv(this.workingDir, this.configPath, this.dangerousMode);
      await this.harness.start();

      // Capture auth config from loaded harness config
      this.authConfig = this.harness.getAuthConfig?.() ?? null;
    }

    // Initialize auth service from config (optional - depends on config.auth section)
    if (!this.authService && this.authConfig) {
      this.authService = createAuthServiceFromConfig(this.authConfig);
      if (this.authService) {
        console.log('[harness-daemon] Auth service initialized');
      }
    }

    if (!this.bus) {
      this.bus = new BusServer({
        host: this.host,
        port: this.port,
        onPublish: (connectionId, channel, payload) =>
          this.gateway?.handlePublish(connectionId, channel, payload),
        onConnect: (connectionId) => this.handleConnect(connectionId),
        onDisconnect: (connectionId) => this.handleDisconnect(connectionId),
        // Direct EventBus subscription for run events - eliminates intermediate forwarding layers
        eventBus: this.harness.getEventBus(),
        eventTranslator: translateAgentEvent,
      });
      this.gateway = new BridgeGateway(this.bus, this.harness, this.workingDir, this.authService);
    }

    // Start WebSocket bridge for browser dashboard access
    if (!this.wsBridge) {
      this.wsBridge = new WsBridgeServer({
        host: this.host,
        port: this.wsPort,
        busHost: this.host,
        busPort: this.port,
      });

      // Forward events from EventBus to WebSocket clients
      const eventBus = this.harness.getEventBus();
      if (eventBus) {
        // Subscribe to all events and forward to WebSocket bridge
        eventBus.subscribeGlobal((event) => {
          // Extract requestId/runId from event for channel routing
          const requestId = (event as { requestId?: string; runId?: string }).requestId
            ?? (event as { runId?: string }).runId;
          if (requestId) {
            const channel = `run:${requestId}`;
            const wireEvent = translateAgentEvent(event);
            if (wireEvent) {
              this.wsBridge?.publish(channel, wireEvent);
            }
          }
        });
      }
    }

    const [tcpAddress, wsAddress] = await Promise.all([
      this.bus.start(),
      this.wsBridge.start(),
    ]);

    console.log(`[harness-daemon] WebSocket bridge listening on ws://${wsAddress.host}:${wsAddress.port}`);

    // Start dashboard HTTP server if port is configured
    if (this.dashboardPort && !this.dashboardServer) {
      const dashboardAddress = await this.startDashboardServer();
      console.log(`[harness-daemon] Dashboard available at http://${dashboardAddress.host}:${dashboardAddress.port}`);
    }

    return tcpAddress;
  }

  async stop(): Promise<void> {
    this.cancelIdleTimer();
    this.shutdownRequested = true;

    if (this.dashboardServer) {
      await new Promise<void>((resolve) => {
        this.dashboardServer!.close(() => resolve());
      });
      this.dashboardServer = null;
    }

    if (this.wsBridge) {
      await this.wsBridge.stop();
      this.wsBridge = null;
    }

    if (this.bus) {
      await this.bus.stop();
      this.bus = null;
    }

    if (this.authService) {
      this.authService.close();
      this.authService = null;
    }

    if (this.harness) {
      await this.harness.shutdown();
      this.harness = null;
    }
  }

  /**
   * Start the dashboard HTTP server for serving static files.
   */
  private async startDashboardServer(): Promise<{ host: string; port: number }> {
    // Find dashboard dist path
    let distPath = this.dashboardPath;
    if (!distPath) {
      // Auto-detect from package location
      const candidates = [
        join(__dirname, '../../../../dashboard-control/dist'),
        join(process.cwd(), 'packages/dashboard-control/dist'),
        join(process.cwd(), 'node_modules/@jesus/dashboard-control/dist'),
      ];
      distPath = candidates.find((p) => existsSync(join(p, 'index.html')));
    }

    if (!distPath || !existsSync(join(distPath, 'index.html'))) {
      throw new Error(`Dashboard dist not found. Build dashboard-control or provide --dashboard-path. Searched: ${distPath || 'auto-detect failed'}`);
    }

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

    const serveFile = (res: ServerResponse, filePath: string) => {
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
    };

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const dispatchSessionInput = this.harness
        ? (sessionKey: string, message: string) => {
            try {
              const graphd = this.harness!.getGraphD();
              const sessionResult = graphd?.sessionGet(sessionKey) as { session?: { workingDir?: string | null } } | undefined;
              const workingDir = sessionResult?.session?.workingDir ?? this.workingDir;
              const requestId = `cockpit-${randomUUID()}`;
              const runHandle = this.harness!.run({
                requestId,
                inputText: message,
                sessionKey,
                workingDir,
              });
              void runHandle.result.catch((error) => {
                console.error('[harness-daemon] cockpit session message run failed', {
                  sessionKey,
                  requestId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
              return { success: true, requestId };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }
        : undefined;

      const stopSession = this.harness
        ? (sessionKey: string, note?: string) => {
            try {
              this.harness!.cancelSessionAsyncRun(sessionKey);
              this.harness!.cancelSessionRalphLoop(sessionKey);
              if (!dispatchSessionInput) {
                return { success: true };
              }
              return dispatchSessionInput(
                sessionKey,
                note ?? 'Stop current work now and wait for user direction.'
              );
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }
        : undefined;

      const forkSession = this.harness
        ? (sourceSessionKey: string, targetSessionKey?: string) => {
            const target = targetSessionKey ?? `${sourceSessionKey}-fork-${Date.now().toString(36)}`;
            const result = this.harness!.forkSession(sourceSessionKey, target);
            return {
              success: result.success,
              ...(result.success ? { targetSessionKey: target } : {}),
              ...(result.error ? { error: result.error } : {}),
            };
          }
        : undefined;

      // Control Plane API context - create fresh each request so graphd is always current
      const controlPlaneCtx: ControlPlaneContext = {
        graphd: this.harness?.getGraphD() ?? null,
        isGraphDReady: () => !!(this.harness?.getGraphD()),
        workingDir: this.workingDir,
        dispatchSessionInput,
        stopSession,
        forkSession,
        resolveSessionEscalation: this.harness?.resolveSessionEscalation
          ? (sessionKey, escalationId, resolution) =>
              this.harness!.resolveSessionEscalation(sessionKey, escalationId, resolution)
          : undefined,
      };

      // Handle Control Plane API routes first
      if (handleControlPlaneRequest(req, res, controlPlaneCtx)) {
        return;
      }

      // Set CORS headers for static files
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      let filePath = join(distPath!, url.pathname);

      // Security: prevent directory traversal
      if (!filePath.startsWith(distPath!)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // Serve index.html for SPA routes
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = join(distPath!, 'index.html');
      }

      serveFile(res, filePath);
    };

    this.dashboardServer = createHttpServer(handler);

    return new Promise((resolve, reject) => {
      this.dashboardServer!.on('error', reject);
      this.dashboardServer!.listen(this.dashboardPort, this.host, () => {
        resolve({ host: this.host, port: this.dashboardPort! });
      });
    });
  }

  getAddress(): { host: string; port: number } {
    if (!this.bus) {
      return { host: this.host, port: this.port };
    }
    return this.bus.getAddress();
  }

  /**
   * @deprecated Dangerous mode is now per-session. Use the set_dangerous_mode command via bridge instead.
   * This method is a no-op and will be removed in a future version.
   */
  setDangerousMode(_enabled: boolean): void {
    console.warn('[harness-daemon] setDangerousMode() is deprecated - dangerous mode is now per-session. Use set_dangerous_mode command via bridge.');
  }

  /**
   * Get the harness instance (for advanced integrations).
   */
  getHarness(): AgentHarness | null {
    return this.harness;
  }
}

/**
 * Parse CLI arguments for daemon options.
 */
function parseDaemonArgs(): HarnessDaemonOptions {
  const args = process.argv.slice(2);
  const options: HarnessDaemonOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dangerous') {
      options.dangerousMode = true;
      console.log('[harness-daemon] WARNING: Running in dangerous mode - all permission checks disabled');
    } else if (arg === '--port' && i + 1 < args.length) {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '--ws-port' && i + 1 < args.length) {
      options.wsPort = parseInt(args[++i], 10);
    } else if (arg === '--host' && i + 1 < args.length) {
      options.host = args[++i];
    } else if (arg === '--config' && i + 1 < args.length) {
      options.configPath = args[++i];
    } else if (arg === '--working-dir' && i + 1 < args.length) {
      options.workingDir = args[++i];
    } else if (arg === '--idle-timeout' && i + 1 < args.length) {
      options.idleTimeoutMs = parseInt(args[++i], 10);
    } else if (arg === '--dashboard-port' && i + 1 < args.length) {
      options.dashboardPort = parseInt(args[++i], 10);
    } else if (arg === '--dashboard-path' && i + 1 < args.length) {
      options.dashboardPath = args[++i];
    }
  }

  return options;
}

export async function runHarnessDaemon(): Promise<void> {
  const options = parseDaemonArgs();
  const daemon = new HarnessDaemon(options);
  const address = await daemon.start();
  console.log(`[harness-daemon] bus listening on ${address.host}:${address.port}`);

  const shutdown = async (signal: string) => {
    console.log(`[harness-daemon] received ${signal}, shutting down`);
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHarnessDaemon().catch((error) => {
    console.error('[harness-daemon] fatal error:', error);
    process.exit(1);
  });
}
