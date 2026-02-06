---
session: tui_1770398408114_rsc6ym
created: 2026-02-06T17:20:08.115Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770398684388
Need to audit the pipeline of our HTTP server in daemon to sqlite persistence. What is the hotpath? 

### function_call
@callId call_eeddaeb5e8604c5fa5fcd480
@name explorer
@ts 1770398689482
@workItemId 14550bbc
{"objective":"Trace the HTTP server to sqlite persistence pipeline in the harness-daemon. Identify the request handlers, data processing steps, and where data is persisted to sqlite. Map out the hotpath.","goal":"Audit the HTTP server to sqlite persistence pipeline"}

### function_call_output
@callId call_eeddaeb5e8604c5fa5fcd480
@ts 1770398779605
@isError true
@durationMs 90122
@workItemId 14550bbc
Sub-agent 'explorer' failed (reason: invalid_action): Explorer read 6 files but extracted 0 artifacts. This is a hard failure. Every file read MUST produce artifacts. Files read: packages/harness-daemon/src/harness/daemon.ts, packages/harness-daemon/src/harness/control_plane_routes.ts, packages/harness-daemon/src/harness/harness.ts, packages/harness-daemon/src/harness/local_providers.ts, packages/harness-daemon/src/harness/session_store.ts...
Tools called: 16 (16 succeeded, 0 failed)
Partial output:
Let me search for the actual GraphD database operations to understand the SQLite persistence layer:

### function_call
@callId call_91ba4b6457dd42c4aff5f2c2
@name Read
@ts 1770398782863
@workItemId 14550bbc
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/daemon.ts"}

### function_call
@callId call_d17406e362494de9889d19a9
@name Read
@ts 1770398782863
@workItemId 14550bbc
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call
@callId call_adbeb8bd577c4d3db2d8b42c
@name Read
@ts 1770398782863
@workItemId 14550bbc
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/session_store.ts"}

### function_call_output
@callId call_91ba4b6457dd42c4aff5f2c2
@ts 1770398782867
@durationMs 2
@workItemId 14550bbc
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
        ? (
            sessionKey: string,
            message: string,
            options?: { context?: string; metadata?: Record<string, unknown> }
          ) => {
            try {
              const graphd = this.harness!.getGraphD();
              const sessionResult = graphd?.sessionGet(sessionKey) as { session?: { workingDir?: string | null } } | undefined;
              const workingDir = sessionResult?.session?.workingDir ?? this.workingDir;
              const requestId = `cockpit-${randomUUID()}`;
              const runHandle = this.harness!.run({
                requestId,
                inputText: message,
                ...(typeof options?.context === 'string' && options.context.trim().length > 0
                  ? { context: options.context.trim() }
                  : {}),
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


### function_call_output
@callId call_d17406e362494de9889d19a9
@ts 1770398782868
@durationMs 2
@workItemId 14550bbc
/**
 * Control Plane API Routes for harness-daemon
 *
 * Provides REST endpoints for the Control Plane dashboard:
 * - Project/Session listing (from GraphD)
 * - Goal hierarchy (placeholder)
 * - Git integration via gh CLI
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { GraphDManager } from 'graphd';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import {
  parseSessionEscalations,
  type EscalationResolutionInput,
  type SessionEscalationRecord,
} from './escalation_state.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ControlPlaneContext {
  graphd: GraphDManager | null;
  isGraphDReady: () => boolean;
  workingDir: string;
  dispatchSessionInput?: (
    sessionKey: string,
    message: string,
    options?: {
      context?: string;
      metadata?: Record<string, unknown>;
    }
  ) => {
    success: boolean;
    requestId?: string;
    queued?: boolean;
    error?: string;
  };
  stopSession?: (
    sessionKey: string,
    note?: string
  ) => {
    success: boolean;
    requestId?: string;
    error?: string;
  };
  forkSession?: (
    sourceSessionKey: string,
    targetSessionKey?: string
  ) => {
    success: boolean;
    targetSessionKey?: string;
    error?: string;
  };
  resolveSessionEscalation?: (
    sessionKey: string,
    escalationId: string,
    resolution: EscalationResolutionInput
  ) => {
    success: boolean;
    escalationId: string;
    pendingCount?: number;
    sessionStatus?: string;
    resumed?: boolean;
    resumeRequestId?: string;
    alreadyResolved?: boolean;
    error?: string;
  };
}

interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName?: string;
  baseRefName?: string;
  body?: string;
}

interface GitRemote {
  owner: string;
  repo: string;
}

interface GitCommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

interface SessionRow {
  sessionKey: string;
  clientType: string;
  workingDir: string | null;
  status: string;
  createdAt: number;
  lastAccessedAt: number;
  goal?: string | null;
  currentWorkItemId?: string | null;
  currentObjective?: string | null;
  lastUserMessagePreview?: string | null;
  metadata?: Record<string, unknown>;
}

interface MessageRow {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

type SessionPanelStatus = 'running' | 'blocked' | 'ready' | 'done' | 'stopped';
type SessionKind = 'feature' | 'issue' | 'refactor' | 'system';

interface SessionRollup {
  sessionKey: string;
  kind: SessionKind;
  title: string;
  status: SessionPanelStatus;
  activeWorkItemId?: string;
  elapsedSec: number;
  lastEventAt: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  currentActivity: {
    tool: string;
    file?: string;
    line?: number;
  };
  gates: {
    testsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsPassed: number;
    invariantsTotal: number;
  };
  blocking: {
    unresolvedEscalationsCount: number;
  };
}

interface EscalationRollup {
  escalationId: string;
  sessionKey: string;
  workItemId?: string;
  createdAt: string;
  ageSec: number;
  headline: string;
  requestedDecision: 'choose' | 'approve' | 'clarify' | 'permission' | 'stop' | 'unknown';
  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
}

interface FocusPacket {
  packetId: string;
  sessionKey: string;
  workItemId?: string;
  type: 'escalation' | 'review' | 'session';
  createdAt: string;
  contentMarkdown: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  validationWarnings?: string[];
}

interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
  signalPriority?: 'high' | 'medium' | 'low' | 'status';
  isStatusOnly?: boolean;
}

interface TraceSummary {
  filesTouched: number;
  lastFile?: string;
  lastLine?: number;
  latestTimestampMs?: number;
}

interface TestReportSummary {
  sessionKey: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  createdAtMs: number;
  invariantsPassed?: number;
  invariantsTotal?: number;
}

interface CommitRollup {
  sha: string;
  message: string;
  author: string;
  time: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
  baseSha?: string;
  headSha?: string;
}

interface PRRollup {
  prId: string;
  number: number;
  title: string;
  status: 'open' | 'closed' | 'merged';
  ciStatus: 'pass' | 'fail' | 'running' | 'unknown';
  author: string;
  url: string;
  updatedAt: string;
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
}

interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
  lineRanges?: Array<{ start: number; end: number; added: number; deleted: number }>;
}

interface RepoLensMatch {
  kind: 'defs' | 'refs' | 'text';
  path: string;
  line: number;
  column: number;
  preview: string;
}

interface TestReportRecord {
  id: string;
  session_key: string;
  work_item_id: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  categories: unknown[];
  cases: unknown[];
  cli_output: string | null;
  command: string | null;
  coverage: Record<string, unknown> | null;
  mutation_score: number | null;
  agent_note: string | null;
  duration_ms: number | null;
  created_at: Date | string | number;
}

const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;

interface SessionCommitEvent {
  sha: string;
  headSha: string;
  baseSha?: string;
  timestampMs: number;
  sessionKey: string;
  workItemId?: string;
}

interface PatchEditInput {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

type BrowserActionName =
  | 'open'
  | 'back'
  | 'forward'
  | 'reload'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'type'
  | 'press'
  | 'wait'
  | 'scroll'
  | 'get_url'
  | 'get_title'
  | 'screenshot'
  | 'close';

interface BrowserActionInput {
  action: BrowserActionName;
  target?: string;
  text?: string;
  url?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  waitMs?: number;
  label?: string;
}

interface BrowserActionResult {
  success: boolean;
  action: BrowserActionName;
  args: string[];
  stdout?: string;
  data?: unknown;
  error?: string;
  artifactPath?: string;
}

interface BrowserRunbookStep {
  line: number;
  input: BrowserActionInput;
}

interface BrowserEvidenceItem {
  id: string;
  type: 'screenshot' | 'snapshot';
  path: string;
  createdAt: string;
  label?: string;
  url?: string;
  title?: string;
}

// Cache for GitHub data
const prCache = new Map<string, { data: PRInfo[]; fetchedAt: number }>();
const PR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const gitRemoteCache = new Map<string, { data: GitRemote | null; fetchedAt: number }>();
const GIT_CACHE_TTL_MS = 60 * 1000; // 1 minute
const ALL_SESSION_STATUSES = [
  'active',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
  'inactive',
  'expired',
] as const;
const MARKDOWN_WORKSPACE_DIR = '.cockpit/markdown';
const MARKDOWN_METADATA_DIR = '.meta';
const MARKDOWN_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
const MARKDOWN_SUGGESTED_FOLDERS = ['notes', 'packets', 'plans', 'scratch', 'handoffs'];
const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
const MARKDOWN_METADATA_MAX_BYTES = 64 * 1024;
const MARKDOWN_CHAT_CONTEXT_MAX_BYTES = 120 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item))
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
    if (parts.length === 0) return undefined;
    return parts.join('\n').trim();
  }
  if (!isRecord(value)) return undefined;
  return (
    extractText(value.text)
    ?? extractText(value.content)
    ?? extractText(value.message)
    ?? extractText(value.chunk)
    ?? extractText(value.response)
    ?? extractText(value.output)
  );
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function hasMarkdownExtension(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  for (const ext of MARKDOWN_FILE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function normalizeWorkspaceRelativePath(rawPath: string, options?: { allowEmpty?: boolean }): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return options?.allowEmpty ? '' : null;
  const slashNormalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
  const pieces = slashNormalized.split('/').map((item) => item.trim()).filter(Boolean);
  if (pieces.length === 0) return options?.allowEmpty ? '' : null;
  if (pieces.some((piece) => piece === '.' || piece === '..')) return null;
  return pieces.join('/');
}

function sanitizeMarkdownName(rawName: string): string {
  const normalized = rawName
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? '';
  const safe = normalized
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'untitled.md';
}

function ensureMarkdownFileName(rawName: string): string {
  const safe = sanitizeMarkdownName(rawName);
  return hasMarkdownExtension(safe) ? safe : `${safe}.md`;
}

function ensureMarkdownExtensionOnPath(rawPath: string): string | null {
  const normalized = normalizeWorkspaceRelativePath(rawPath);
  if (normalized === null) return null;
  return hasMarkdownExtension(normalized) ? normalized : `${normalized}.md`;
}

function buildVersionFromMtimeMs(mtimeMs: number): number {
  if (!Number.isFinite(mtimeMs)) return 0;
  return Math.max(0, Math.floor(mtimeMs));
}

async function getCockpitMarkdownWorkspaceRoot(ctx: ControlPlaneContext): Promise<string> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const root = path.resolve(ctx.workingDir, MARKDOWN_WORKSPACE_DIR);
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function resolveCockpitMarkdownWorkspacePath(
  ctx: ControlPlaneContext,
  rawPath: string,
  options?: { allowEmpty?: boolean; requireMarkdownFile?: boolean }
): Promise<{ rootDir: string; relativePath: string; absolutePath: string } | { error: string }> {
  const path = await import('path');
  const rootDir = await getCockpitMarkdownWorkspaceRoot(ctx);
  const relativePath = normalizeWorkspaceRelativePath(rawPath, { allowEmpty: options?.allowEmpty });
  if (relativePath === null) {
    return { error: 'Invalid markdown path' };
  }
  if (options?.requireMarkdownFile && relativePath && !hasMarkdownExtension(relativePath)) {
    return { error: 'Markdown files must end with .md, .markdown, or .mdx' };
  }
  const absolutePath = relativePath
    ? path.resolve(rootDir, relativePath)
    : rootDir;
  const inWorkspace = absolutePath === rootDir || absolutePath.startsWith(`${rootDir}${path.sep}`);
  if (!inWorkspace) {
    return { error: 'Path must resolve inside the markdown workspace' };
  }
  return { rootDir, relativePath, absolutePath };
}

interface MarkdownWorkspaceFileRecord {
  path: string;
  version: number;
  updatedAt: string;
  size: number;
  hash: string;
  etag: string;
  lineCount: number;
  wordCount: number;
  metadata?: Record<string, unknown>;
}

function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (depth > 5) return undefined;
  if (typeof value === 'string') {
    return value.length > 4_000 ? value.slice(0, 4_000) : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, 128)) {
      const next = sanitizeMetadataValue(item, depth + 1);
      if (next !== undefined) out.push(next);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(value)) {
      if (count >= 128) break;
      const key = rawKey.trim();
      if (!key) continue;
      const next = sanitizeMetadataValue(rawValue, depth + 1);
      if (next === undefined) continue;
      out[key] = next;
      count += 1;
    }
    return out;
  }
  return undefined;
}

function sanitizeMarkdownMetadata(value: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeMetadataValue(value, 0);
  if (!isRecord(sanitized)) return undefined;
  const serialized = JSON.stringify(sanitized);
  if (serialized.length > MARKDOWN_METADATA_MAX_BYTES) return undefined;
  return sanitized;
}

async function buildMarkdownContentHash(content: string): Promise<string> {
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function buildMarkdownWordCount(content: string): number {
  const matches = content.match(/[^\s]+/g);
  return matches ? matches.length : 0;
}

function buildMarkdownLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

function buildMarkdownEtag(version: number, hash: string): string {
  const shortHash = hash.slice(0, 16);
  return `W/"${Math.max(0, version)}-${shortHash}"`;
}

async function resolveMarkdownMetadataPath(rootDir: string, relativePath: string): Promise<string> {
  const path = await import('path');
  const metadataRoot = path.resolve(rootDir, MARKDOWN_METADATA_DIR);
  const metadataPath = path.resolve(metadataRoot, `${relativePath}.meta.json`);
  if (metadataPath === metadataRoot || metadataPath.startsWith(`${metadataRoot}${path.sep}`)) {
    return metadataPath;
  }
  throw new Error('Metadata path resolved outside markdown metadata workspace');
}

async function readMarkdownWorkspaceMetadata(
  rootDir: string,
  relativePath: string
): Promise<Record<string, unknown> | undefined> {
  const fs = await import('fs/promises');
  try {
    const metadataPath = await resolveMarkdownMetadataPath(rootDir, relativePath);
    const raw = await fs.readFile(metadataPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MARKDOWN_METADATA_MAX_BYTES) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeMarkdownMetadata(parsed);
  } catch {
    return undefined;
  }
}

async function writeMarkdownWorkspaceMetadata(
  rootDir: string,
  relativePath: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const metadataPath = await resolveMarkdownMetadataPath(rootDir, relativePath);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function buildMarkdownWorkspaceFileRecord(
  rootDir: string,
  relativePath: string,
  content: string,
  stat: { mtimeMs: number; mtime: Date; size: number },
  metadata?: Record<string, unknown>
): Promise<MarkdownWorkspaceFileRecord> {
  const version = buildVersionFromMtimeMs(stat.mtimeMs);
  const hash = await buildMarkdownContentHash(content);
  return {
    path: relativePath,
    version,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
    hash,
    etag: buildMarkdownEtag(version, hash),
    lineCount: buildMarkdownLineCount(content),
    wordCount: buildMarkdownWordCount(content),
    ...(metadata ? { metadata } : {}),
  };
}

async function writeCockpitMarkdownWorkspaceFile(
  ctx: ControlPlaneContext,
  input: {
    path: string;
    content: string;
    expectedVersion?: number;
    metadata?: Record<string, unknown>;
    operation?: 'write' | 'import' | 'patch';
    source?: string;
    baseVersion?: number;
  }
): Promise<
  | { ok: true; file: MarkdownWorkspaceFileRecord; created: boolean; previousVersion: number }
  | { ok: false; status: number; error: string; currentVersion?: number; currentUpdatedAt?: string; currentHash?: string }
> {
  const pathModule = await import('path');
  const fs = await import('fs/promises');
  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, input.path, { requireMarkdownFile: true });
  if ('error' in resolved) {
    return { ok: false, status: 400, error: resolved.error };
  }

  if (Buffer.byteLength(input.content, 'utf8') > MARKDOWN_MAX_BYTES) {
    return { ok: false, status: 400, error: `Markdown payload exceeds ${MARKDOWN_MAX_BYTES} bytes` };
  }

  let existing:
    | {
        version: number;
        updatedAt: string;
        size: number;
        content: string;
      }
    | undefined;
  try {
    const [stat, content] = await Promise.all([
      fs.stat(resolved.absolutePath),
      fs.readFile(resolved.absolutePath, 'utf8'),
    ]);
    if (stat.isFile()) {
      existing = {
        version: buildVersionFromMtimeMs(stat.mtimeMs),
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        content,
      };
    }
  } catch {
    existing = undefined;
  }

  if (typeof input.expectedVersion === 'number' && Number.isFinite(input.expectedVersion)) {
    const expected = Math.floor(input.expectedVersion);
    const current = existing?.version ?? 0;
    if (current !== expected) {
      return {
        ok: false,
        status: 409,
        error: 'Version conflict while writing markdown file',
        currentVersion: current,
        ...(existing?.updatedAt ? { currentUpdatedAt: existing.updatedAt } : {}),
        ...(existing?.content ? { currentHash: await buildMarkdownContentHash(existing.content) } : {}),
      };
    }
  }

  await fs.mkdir(pathModule.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(resolved.absolutePath, input.content, 'utf8');
  const [stat, metadataBase] = await Promise.all([
    fs.stat(resolved.absolutePath),
    readMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath),
  ]);
  const incomingMetadata = sanitizeMarkdownMetadata(input.metadata);
  const nextFile = await buildMarkdownWorkspaceFileRecord(
    resolved.rootDir,
    resolved.relativePath,
    input.content,
    stat,
  );
  const mergedMetadata = sanitizeMarkdownMetadata({
    ...(metadataBase ?? {}),
    ...(incomingMetadata ?? {}),
    source: asString(input.source)
      ?? asString(incomingMetadata?.source)
      ?? asString(metadataBase?.source)
      ?? (input.operation === 'import' ? 'import' : 'control-plane'),
    createdAt: asString(metadataBase?.createdAt) ?? nextFile.updatedAt,
    updatedAt: nextFile.updatedAt,
    lineCount: nextFile.lineCount,
    wordCount: nextFile.wordCount,
    hash: nextFile.hash,
    size: nextFile.size,
    cockpit: sanitizeMetadataValue({
      ...(isRecord(metadataBase?.cockpit) ? metadataBase.cockpit : {}),
      path: nextFile.path,
      version: nextFile.version,
      etag: nextFile.etag,
      hash: nextFile.hash,
      lineCount: nextFile.lineCount,
      wordCount: nextFile.wordCount,
      ...(typeof input.baseVersion === 'number' ? { baseVersion: Math.floor(input.baseVersion) } : {}),
      ...(typeof existing?.version === 'number' ? { previousVersion: existing.version } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
      updatedAt: nextFile.updatedAt,
    }),
  });
  try {
    if (mergedMetadata) {
      await writeMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath, mergedMetadata);
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `Failed to persist markdown metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    created: !existing,
    previousVersion: existing?.version ?? 0,
    file: {
      ...nextFile,
      ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
    },
  };
}

interface MarkdownPatchEditInput {
  startLine: number;
  endLine: number;
  replacement: string;
}

function parseMarkdownPatchEdits(value: unknown): MarkdownPatchEditInput[] {
  if (!Array.isArray(value)) return [];
  const edits: MarkdownPatchEditInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const startLine = asNumber(entry.startLine ?? entry.start_line);
    const endLine = asNumber(entry.endLine ?? entry.end_line);
    const replacement = typeof entry.replacement === 'string'
      ? entry.replacement
      : typeof entry.text === 'string'
        ? entry.text
        : undefined;
    if (!startLine || !endLine || replacement === undefined) continue;
    edits.push({
      startLine: Math.floor(startLine),
      endLine: Math.floor(endLine),
      replacement,
    });
  }
  return edits;
}

function applyMarkdownStructuredEdits(
  content: string,
  edits: MarkdownPatchEditInput[]
): { ok: true; content: string; changedLines: number } | { ok: false; error: string; status: number } {
  const hadTrailingNewline = content.endsWith('\n');
  const baseText = hadTrailingNewline ? content.slice(0, -1) : content;
  const lines = baseText.length > 0 ? baseText.split('\n') : [];
  let changedLines = 0;
  const ordered = [...edits].sort((a, b) => b.startLine - a.startLine);
  for (const edit of ordered) {
    if (edit.startLine < 1) {
      return { ok: false, status: 400, error: 'Invalid startLine in markdown edits' };
    }
    if (edit.endLine < edit.startLine - 1) {
      return { ok: false, status: 400, error: 'Invalid endLine in markdown edits' };
    }
    if (edit.endLine > lines.length) {
      return {
        ok: false,
        status: 400,
        error: `Edit range out of bounds: ${edit.startLine}-${edit.endLine} (lines=${lines.length})`,
      };
    }
    if (edit.startLine > lines.length + 1) {
      return {
        ok: false,
        status: 400,
        error: `Edit start out of bounds: ${edit.startLine} (lines=${lines.length})`,
      };
    }
    const startIdx = Math.min(lines.length, edit.startLine - 1);
    const deleteCount = Math.max(0, edit.endLine - edit.startLine + 1);
    const replacementLines = edit.replacement === '' ? [] : edit.replacement.split('\n');
    lines.splice(startIdx, deleteCount, ...replacementLines);
    changedLines += Math.max(deleteCount, replacementLines.length);
  }
  return {
    ok: true,
    content: lines.join('\n') + (hadTrailingNewline ? '\n' : ''),
    changedLines,
  };
}

async function applyMarkdownUnifiedDiffPatch(
  relativePath: string,
  currentContent: string,
  patch: string
): Promise<{ ok: true; content: string; changedLines: number } | { ok: false; error: string; status: number }> {
  const stats = parsePatchStats(patch);
  if (stats.hasBinary) {
    return { ok: false, status: 400, error: 'Binary markdown patch is not supported' };
  }
  if (stats.files.length === 0) {
    return { ok: false, status: 400, error: 'No files detected in markdown patch payload' };
  }
  const normalizedTarget = normalizeDiffPath(relativePath);
  const mismatched = stats.files.filter((filePath) => normalizeDiffPath(filePath) !== normalizedTarget);
  if (mismatched.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Markdown patch must only target ${relativePath}; found ${mismatched.join(', ')}`,
    };
  }

  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-md-patch-'));
  try {
    const targetPath = path.resolve(tempDir, normalizedTarget);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, currentContent, 'utf8');
    const patchPath = path.join(tempDir, 'markdown.patch');
    await fs.writeFile(patchPath, patch, 'utf8');
    await execFileText('git', ['apply', '--check', '--whitespace=nowarn', patchPath], {
      cwd: tempDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await execFileText('git', ['apply', '--whitespace=nowarn', patchPath], {
      cwd: tempDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const nextContent = await fs.readFile(targetPath, 'utf8');
    return { ok: true, content: nextContent, changedLines: stats.changedLines };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildCockpitMarkdownWorkspaceTree(
  ctx: ControlPlaneContext
): Promise<{
  rootDir: string;
  tree: Array<Record<string, unknown>>;
  suggestedFolders: string[];
}> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const rootDir = await getCockpitMarkdownWorkspaceRoot(ctx);

  const counters = { files: 0 };
  const MAX_FILES = 1000;
  const MAX_DEPTH = 6;

  const scanDir = async (absoluteDir: string, relativeDir: string, depth: number): Promise<Array<Record<string, unknown>>> => {
    if (depth > MAX_DEPTH || counters.files >= MAX_FILES) return [];
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }> = [];
    try {
      const dirEntries = await fs.readdir(absoluteDir, { withFileTypes: true });
      entries = dirEntries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    } catch {
      return [];
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const nodes: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink) continue;

      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absPath = path.join(absoluteDir, entry.name);

      if (entry.isDirectory) {
        const children = await scanDir(absPath, relPath, depth + 1);
        nodes.push({
          type: 'folder',
          name: entry.name,
          path: relPath,
          children,
        });
        continue;
      }

      if (!entry.isFile || !hasMarkdownExtension(entry.name)) continue;
      let statSize = 0;
      let updatedAt = new Date(0).toISOString();
      let version = 0;
      try {
        const stat = await fs.stat(absPath);
        statSize = stat.size;
        updatedAt = stat.mtime.toISOString();
        version = buildVersionFromMtimeMs(stat.mtimeMs);
      } catch {
        // Ignore flaky file metadata reads and still list the file.
      }

      counters.files += 1;
      nodes.push({
        type: 'file',
        name: entry.name,
        path: relPath,
        size: statSize,
        updatedAt,
        version,
      });
      if (counters.files >= MAX_FILES) break;
    }
    return nodes;
  };

  const tree = await scanDir(rootDir, '', 0);
  const folderSuggestions = new Set<string>(MARKDOWN_SUGGESTED_FOLDERS);
  for (const node of tree) {
    if (node.type !== 'folder') continue;
    if (typeof node.path === 'string' && node.path.trim()) {
      folderSuggestions.add(node.path);
    }
  }
  return {
    rootDir,
    tree,
    suggestedFolders: Array.from(folderSuggestions).slice(0, 12),
  };
}

function parseAgentEventTokenTotalsForDay(
  metadata: Record<string, unknown> | undefined,
  startMs: number,
  endMs: number
): number {
  const events = Array.isArray(metadata?.agent_events) ? metadata.agent_events : [];
  let total = 0;
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'llm_call') continue;
    const ts = parseTimestampMs(entry.timestamp);
    if (!ts || ts < startMs || ts >= endMs) continue;
    const data = isRecord(entry.data) ? entry.data : {};
    const prompt = asNumber(data.prompt_tokens ?? data.promptTokens) ?? 0;
    const completion = asNumber(data.completion_tokens ?? data.completionTokens) ?? 0;
    total += prompt + completion;
  }
  return total;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Execute gh CLI command
 */
async function ghCommand(args: string, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`gh ${args}`, {
      timeout: 30000,
      cwd,
      env: { ...process.env, GH_PAGER: '' },
    });
    return stdout.trim();
  } catch (error) {
    console.error('[control-plane] gh command failed:', args, error);
    throw error;
  }
}

/**
 * Get PRs for a repository
 */
async function getPRs(owner: string, repo: string): Promise<PRInfo[]> {
  const cacheKey = `${owner}/${repo}`;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const result = await ghCommand(
      `pr list --repo ${owner}/${repo} --state all --limit 50 --json number,title,state,author,url,additions,deletions,changedFiles,createdAt,updatedAt,isDraft,headRefName,baseRefName,body`
    );
    const prs: PRInfo[] = JSON.parse(result).map((pr: Record<string, unknown>) => ({
      number: pr.number as number,
      title: pr.title as string,
      state: (pr.state as string).toLowerCase() as PRInfo['state'],
      author: (pr.author as Record<string, unknown>)?.login as string ?? 'unknown',
      url: pr.url as string,
      additions: (pr.additions as number) ?? 0,
      deletions: (pr.deletions as number) ?? 0,
      changedFiles: (pr.changedFiles as number) ?? 0,
      createdAt: pr.createdAt as string,
      updatedAt: pr.updatedAt as string,
      isDraft: (pr.isDraft as boolean) ?? false,
      headRefName: pr.headRefName as string,
      baseRefName: pr.baseRefName as string,
      body: pr.body as string,
    }));

    prCache.set(cacheKey, { data: prs, fetchedAt: Date.now() });
    return prs;
  } catch {
    return [];
  }
}

/**
 * Parse git remote URL to extract owner/repo
 */
function parseGitRemote(remoteUrl: string): GitRemote | null {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  return null;
}

/**
 * Get git remote info for a project
 */
async function getGitRemote(projectPath: string): Promise<GitRemote | null> {
  const cached = gitRemoteCache.get(projectPath);
  if (cached && Date.now() - cached.fetchedAt < GIT_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: projectPath,
      timeout: 5000,
    });
    const remote = parseGitRemote(stdout.trim());
    gitRemoteCache.set(projectPath, { data: remote, fetchedAt: Date.now() });
    return remote;
  } catch {
    gitRemoteCache.set(projectPath, { data: null, fetchedAt: Date.now() });
    return null;
  }
}

/**
 * Get recent commits for a project
 */
async function getRecentCommits(projectPath: string, limit = 10): Promise<GitCommitInfo[]> {
  try {
    const { stdout } = await execAsync(
      `git log -${limit} --pretty=format:'{"sha":"%h","message":"%s","author":"%an","date":"%ci"}'`,
      { cwd: projectPath, timeout: 10000 }
    );
    return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Parse URL and extract path/query
 */
function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  return { pathname: url.pathname, query: url.searchParams };
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Route matcher for path patterns like /control-plane/projects/:id/features
 */
function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Format session row for API response
 */
function formatSession(row: SessionRow) {
  const createdAt = row.createdAt ? new Date(row.createdAt * 1000).toISOString() : null;
  const lastAccessedAt = row.lastAccessedAt ? new Date(row.lastAccessedAt * 1000).toISOString() : null;
  return {
    id: row.sessionKey,
    clientType: row.clientType,
    workingDir: row.workingDir,
    status: row.status,
    createdAt,
    lastAccessedAt,
    metadata: row.metadata,
  };
}

/**
 * Format message row for API response
 */
function formatMessage(row: MessageRow) {
  const createdAt = row.createdAt ? new Date(row.createdAt * 1000).toISOString() : null;
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    requestId: row.requestId,
    createdAt,
    metadata: row.metadata,
  };
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    if (!Number.isNaN(ts)) return ts;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
  }
  return undefined;
}

function toStringOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

async function execFileText(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; maxBuffer?: number }
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    timeout: options?.timeout ?? 15_000,
    maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024,
    encoding: 'utf8',
  } as any);
  return toStringOutput((result as any).stdout);
}

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

function shaMatches(left: string, right: string): boolean {
  const a = normalizeSha(left);
  const b = normalizeSha(right);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function getSessionCommitEvents(session: SessionRow): SessionCommitEvent[] {
  const events = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];
  const commits: SessionCommitEvent[] = [];
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'git_commit') continue;
    const ts = parseTimestampMs(entry.timestamp);
    const data = isRecord(entry.data) ? entry.data : null;
    const sha = asString(data?.sha);
    if (!sha || !ts) continue;
    const headSha = asString(data?.head_sha) ?? asString(data?.headSha) ?? sha;
    const baseSha = asString(data?.base_sha) ?? asString(data?.baseSha);
    commits.push({
      sha: headSha,
      headSha,
      ...(baseSha ? { baseSha } : {}),
      timestampMs: ts,
      sessionKey: session.sessionKey,
      ...(asString(entry.work_item_id) ? { workItemId: asString(entry.work_item_id) } : {}),
    });
  }
  return commits.sort((a, b) => a.timestampMs - b.timestampMs);
}

function findSessionCommitBySha(events: SessionCommitEvent[], sha: string): SessionCommitEvent | undefined {
  for (const event of events) {
    if (shaMatches(event.sha, sha)) return event;
  }
  return undefined;
}

function getLatestRevisionRange(
  session: SessionRow,
  requestedHeadSha?: string
): { baseSha?: string; headSha?: string } {
  const commits = getSessionCommitEvents(session);
  if (commits.length === 0) {
    const metadata = session.metadata ?? {};
    const baseSha = asString(metadata.baseSha) ?? asString(metadata.base_sha);
    const headSha = requestedHeadSha
      ?? asString(metadata.headSha)
      ?? asString(metadata.head_sha)
      ?? asString(metadata.commitSha)
      ?? asString(metadata.commit_sha)
      ?? asString(metadata.revision);
    return { baseSha, headSha };
  }

  if (requestedHeadSha) {
    const index = commits.findIndex((entry) => shaMatches(entry.headSha, requestedHeadSha) || shaMatches(entry.sha, requestedHeadSha));
    if (index >= 0) {
      const matched = commits[index];
      return {
        ...(matched.baseSha
          ? { baseSha: matched.baseSha }
          : index > 0
            ? { baseSha: commits[index - 1].headSha }
            : {}),
        headSha: matched.headSha,
      };
    }
    return { headSha: requestedHeadSha };
  }

  const head = commits[commits.length - 1];
  return {
    ...(head.baseSha
      ? { baseSha: head.baseSha }
      : commits.length > 1
        ? { baseSha: commits[commits.length - 2].headSha }
        : {}),
    headSha: head.headSha,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type DiffLineRange = { start: number; end: number; added: number; deleted: number };

function parseLineRangesFromPatch(patch: string): Map<string, DiffLineRange[]> {
  const ranges = new Map<string, DiffLineRange[]>();
  const lines = patch.split('\n');
  let currentFile: string | null = null;
  let currentStart: number | null = null;
  let rangeAdded = 0;
  let rangeDeleted = 0;
  let lineNum = 0;

  for (const line of lines) {
    // Match file header: +++ b/path/to/file
    const fileMatch = line.match(/^\+\+\+\s+b\/(.+)/);
    if (fileMatch) {
      // Save previous range if exists
      if (currentFile && currentStart !== null) {
        const fileRanges = ranges.get(currentFile) || [];
        fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });
        ranges.set(currentFile, fileRanges);
      }
      currentFile = fileMatch[1].trim();
      currentStart = null;
      rangeAdded = 0;
      rangeDeleted = 0;
      continue;
    }

    // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch && currentFile) {
      // Save previous range if exists
      if (currentStart !== null) {
        const fileRanges = ranges.get(currentFile) || [];
        fileRanges.push({ start: currentStart, end: lineNum - 1, added: rangeAdded, deleted: rangeDeleted });
        ranges.set(currentFile, fileRanges);
      }
      currentStart = parseInt(hunkMatch[1], 10);
      lineNum = currentStart;
      rangeAdded = 0;
      rangeDeleted = 0;
      continue;
    }

    // Count additions and deletions
    if (currentStart !== null) {
      if (line.startsWith('+') && !line.startsWith('++')) {
        rangeAdded++;
        lineNum++;
      } else if (line.startsWith('-') && !line.startsWith('--')) {
        rangeDeleted++;
        // Don't increment lineNum for deletions
      } else if (line.startsWith(' ')) {
        lineNum++;
      }
    }
  }

  // Save final range
  if (currentFile && currentStart !== null) {
    const fileRanges = ranges.get(currentFile) || [];
    fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });
    ranges.set(currentFile, fileRanges);
  }

  return ranges;
}

function parseNumstatOutput(stdout: string, patch?: string | null): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');

  // Parse line ranges from patch if provided
  const lineRanges = patch ? parseLineRangesFromPatch(patch) : new Map<string, DiffLineRange[]>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    const path = parts.slice(2).join('\t');
    if (!path) continue;
    if (Number.isFinite(added)) totalAdded += added;
    if (Number.isFinite(deleted)) totalDeleted += deleted;
    filesTouched += 1;

    const hotspot: DiffHotspot = {
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    };

    // Add line ranges if available
    const fileRanges = lineRanges.get(path);
    if (fileRanges && fileRanges.length > 0) {
      // Add up to 3 most significant line ranges (most changes)
      const topRanges = fileRanges
        .sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted))
        .slice(0, 3);
      if (topRanges.length > 0) {
        hotspot.lineRanges = topRanges;
      }
    }

    hotspots.push(hotspot);
  }
  hotspots.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
  return {
    summary: {
      added: totalAdded,
      deleted: totalDeleted,
      filesTouched,
    },
    hotspots,
  };
}

function parseGitLogWithNumstat(stdout: string, projectPath: string): CommitRollup[] {
  const commits: CommitRollup[] = [];
  const lines = stdout.split('\n');
  let current: CommitRollup | null = null;

  for (const raw of lines) {
    if (raw.startsWith('__COMMIT__')) {
      if (current) commits.push(current);
      const payload = raw.slice('__COMMIT__'.length);
      const [shaRaw, authorRaw, timeRaw, messageRaw] = payload.split('\u001f');
      const sha = (shaRaw ?? '').trim();
      const author = (authorRaw ?? '').trim();
      const time = (timeRaw ?? '').trim();
      const message = (messageRaw ?? '').trim();
      if (!sha || !time) {
        current = null;
        continue;
      }
      current = {
        sha,
        message,
        author: author || 'unknown',
        time,
        diffstat: { added: 0, deleted: 0, filesTouched: 0 },
        projectPath,
      };
      continue;
    }

    if (!current) continue;
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    if (Number.isFinite(added)) current.diffstat.added += added;
    if (Number.isFinite(deleted)) current.diffstat.deleted += deleted;
    current.diffstat.filesTouched += 1;
  }
  if (current) commits.push(current);

  return commits;
}

async function loadSessionDiffstats(
  sessions: SessionRow[]
): Promise<Map<string, { added: number; deleted: number; filesTouched: number }>> {
  const bySession = new Map<string, { added: number; deleted: number; filesTouched: number }>();
  const cachedByRange = new Map<string, { added: number; deleted: number; filesTouched: number }>();

  for (const session of sessions) {
    const workingDir = session.workingDir;
    if (!workingDir) continue;
    const range = getLatestRevisionRange(session);
    if (!range.baseSha || !range.headSha) continue;
    const cacheKey = `${workingDir}\u001f${range.baseSha}\u001f${range.headSha}`;
    const cached = cachedByRange.get(cacheKey);
    if (cached) {
      bySession.set(session.sessionKey, cached);
      continue;
    }
    try {
      const numstat = await execFileText(
        'git',
        ['diff', '--numstat', '--no-color', `${range.baseSha}..${range.headSha}`],
        { cwd: workingDir, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
      );
      const parsed = parseNumstatOutput(numstat).summary;
      cachedByRange.set(cacheKey, parsed);
      bySession.set(session.sessionKey, parsed);
    } catch {
      // Keep trace fallback when git diffstat is unavailable.
    }
  }

  return bySession;
}

function mapTestReportRow(row: TestReportRecord): Record<string, unknown> {
  const createdAtMs = row.created_at instanceof Date
    ? row.created_at.getTime()
    : parseTimestampMs(row.created_at) ?? Date.now();
  return {
    id: row.id,
    sessionKey: row.session_key,
    workItemId: row.work_item_id,
    verdict: row.verdict,
    categories: Array.isArray(row.categories) ? row.categories : [],
    cases: Array.isArray(row.cases) ? row.cases : [],
    cliOutput: row.cli_output ?? '',
    command: row.command ?? '',
    coverage: row.coverage ?? null,
    mutationScore: row.mutation_score ?? null,
    agentNote: row.agent_note ?? '',
    durationMs: row.duration_ms ?? 0,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

function isLockfilePath(filePath: string): boolean {
  const name = filePath.trim().toLowerCase();
  return (
    name.endsWith('/package-lock.json') || name === 'package-lock.json'
    || name.endsWith('/yarn.lock') || name === 'yarn.lock'
    || name.endsWith('/pnpm-lock.yaml') || name === 'pnpm-lock.yaml'
    || name.endsWith('/bun.lock') || name === 'bun.lock'
    || name.endsWith('/bun.lockb') || name === 'bun.lockb'
    || name.endsWith('/cargo.lock') || name === 'cargo.lock'
  );
}

function normalizeDiffPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const withoutPrefix = trimmed.startsWith('a/') || trimmed.startsWith('b/')
    ? trimmed.slice(2)
    : trimmed;
  return withoutPrefix.replace(/^"+|"+$/g, '');
}

function parsePatchStats(patch: string): {
  files: string[];
  changedLines: number;
  hasBinary: boolean;
} {
  const files = new Set<string>();
  let changedLines = 0;
  let hasBinary = false;
  const lines = patch.split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      hasBinary = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const candidate = line.slice(4).trim();
      if (candidate !== '/dev/null') {
        files.add(normalizeDiffPath(candidate));
      }
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      changedLines += 1;
    }
  }
  return { files: Array.from(files), changedLines, hasBinary };
}

function parsePatchEdits(value: unknown): PatchEditInput[] {
  if (!Array.isArray(value)) return [];
  const edits: PatchEditInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const filePath = asString(entry.path);
    const startLine = asNumber(entry.startLine ?? entry.start_line);
    const endLine = asNumber(entry.endLine ?? entry.end_line);
    const replacement = typeof entry.replacement === 'string'
      ? entry.replacement
      : typeof entry.text === 'string'
        ? entry.text
        : undefined;
    if (!filePath || !startLine || !endLine || replacement === undefined) continue;
    edits.push({
      path: filePath,
      startLine: Math.floor(startLine),
      endLine: Math.floor(endLine),
      replacement,
    });
  }
  return edits;
}

async function resolveSessionFilePath(workingDir: string, relativePath: string): Promise<{
  resolvedPath?: string;
  relativePath?: string;
  error?: string;
}> {
  const path = await import('path');
  const baseDir = path.resolve(workingDir);
  const resolvedPath = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(baseDir, relativePath);
  const inWorkingDir = resolvedPath === baseDir || resolvedPath.startsWith(`${baseDir}${path.sep}`);
  if (!inWorkingDir) {
    return { error: 'Patch paths must resolve inside the session working directory' };
  }
  return {
    resolvedPath,
    relativePath: path.relative(baseDir, resolvedPath),
  };
}

async function enforcePatchConstraints(
  mode: 'patch' | 'edits',
  files: string[],
  changedLines: number
): Promise<{ ok: boolean; error?: string }> {
  if (files.le
... [truncated 50040 chars]

### function_call_output
@callId call_adbeb8bd577c4d3db2d8b42c
@ts 1770398782868
@durationMs 1
@workItemId 14550bbc
import { ContextWindow } from 'context';
import type { GraphDManager } from 'graphd';
import type { ContextWindowSnapshot, SessionPermissionState } from 'types';
import type { ModelSelection } from 'agent';
import type { HandoffSpec } from 'protocol';
import { PermissionChecker } from './permissions.js';
import path from 'path';

interface SessionStoreOptions {
  sessionKey: string;
  maxTokens: number;
  graphd: GraphDManager | null;
  isGraphDReady: () => boolean;
  logger: HarnessLogger;
  dangerousMode?: boolean;  // Allow sessions to opt into dangerous mode independently
  workingDir?: string;       // Working directory for permission checks
}

export interface HarnessLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  warning(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  flush?(): void;
}

export interface PausedState {
  goal: string;
  agentType: string;
  workingDir: string;
  planMode?: boolean;
  userPromptType?: string;
  handoffSpec?: HandoffSpec; // Stored for execution after user approval
  pausedAt: number; // Timestamp when session entered paused state
}

export type PausedWorkItemStatus = 'pending' | 'resolved' | 'cancelled';

export interface PausedWorkItemState {
  workId: string;
  agentType: string;
  objective?: string;
  reason: string;
  escalationId?: string;
  status: PausedWorkItemStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolutionSummary?: string;
}

function normalizeHandoffSpec(value: unknown): HandoffSpec | undefined {
  if (!value) return undefined;
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const spec = candidate as HandoffSpec;
  if (typeof spec.goal !== 'string' || typeof spec.context !== 'string' || !Array.isArray(spec.workItems)) {
    return undefined;
  }
  return spec;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asPositiveTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizePausedWorkItemStatus(value: unknown): PausedWorkItemStatus {
  switch (value) {
    case 'pending':
    case 'resolved':
    case 'cancelled':
      return value;
    default:
      return 'pending';
  }
}

function normalizePausedWorkItem(value: unknown): PausedWorkItemState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const workId = asNonEmptyString(input.workId);
  const agentType = asNonEmptyString(input.agentType);
  const reason = asNonEmptyString(input.reason);
  if (!workId || !agentType || !reason) return null;
  const objective = asNonEmptyString(input.objective);
  const escalationId = asNonEmptyString(input.escalationId);

  const createdAt = asPositiveTimestamp(input.createdAt) ?? Date.now();
  const updatedAt = asPositiveTimestamp(input.updatedAt) ?? createdAt;
  const resolvedAt = asPositiveTimestamp(input.resolvedAt);
  const resolutionSummary = asNonEmptyString(input.resolutionSummary);

  return {
    workId,
    agentType,
    ...(objective ? { objective } : {}),
    reason,
    ...(escalationId ? { escalationId } : {}),
    status: normalizePausedWorkItemStatus(input.status),
    createdAt,
    updatedAt,
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolutionSummary ? { resolutionSummary } : {}),
  };
}

/**
 * Build an interruption directive that wraps the user's message with guidance.
 * This helps the agent understand the message arrived mid-execution and how to handle it.
 */
function buildInterruptionDirective(userMessage: string): string {
  return `**User Interruption**: "${userMessage}"

Consider if the user is:
- Asking you to stop current work
- Requesting a pivot to a different task
- Providing information that invalidates your current action
- Adding context as an addendum

Acknowledge the interruption and adjust your approach accordingly.`;
}

/** Info about an active async run for a session */
export interface AsyncRunInfo {
  requestId: string;
  goal: string;
  cancelled: boolean;
  startedAt: number;
}

/** Info about an active Ralph Loop for a session */
export interface RalphLoopInfo {
  requestId: string;
  cancelled: boolean;
}

export class SessionStore {
  private readonly sessionKey: string;
  private readonly maxTokens: number;
  private readonly graphd: GraphDManager | null;
  private readonly isGraphDReady: () => boolean;
  private readonly logger: HarnessLogger;
  private readonly workingDir: string;
  private readonly permissionChecker: PermissionChecker;
  private context: ContextWindow | null = null;
  private readonly contextFilePath: string;
  private pausedState: PausedState | null = null;
  private pausedWorkItems = new Map<string, PausedWorkItemState>();
  private modelSelections = new Map<string, ModelSelection>();
  private asyncModeEnabled = false;

  // Execution tracking: prevents race conditions when user sends messages during agent execution
  private executingRequestId: string | null = null;
  private queuedUserMessages: Array<{ requestId: string; message: string }> = [];

  // Session-level exclusive operation tracking (prevents multiple connections from starting concurrent ops)
  private asyncRun: AsyncRunInfo | null = null;
  private ralphLoop: RalphLoopInfo | null = null;

  constructor(options: SessionStoreOptions) {
    this.sessionKey = options.sessionKey;
    this.maxTokens = options.maxTokens;
    this.graphd = options.graphd;
    this.isGraphDReady = options.isGraphDReady;
    this.logger = options.logger;
    this.workingDir = options.workingDir ?? process.cwd();
    const date = new Date().toISOString().split('T')[0];
    this.contextFilePath = path.join(this.workingDir, '.haiku', 'sessions', date, options.sessionKey, 'context.md');

    // Per-session permission checker - each session has its own dangerous mode and grants
    this.permissionChecker = new PermissionChecker(
      this.workingDir,
      options.dangerousMode ?? false
    );
  }

  setAsyncModeEnabled(enabled: boolean): void {
    this.asyncModeEnabled = enabled;
  }

  isAsyncModeEnabled(): boolean {
    return this.asyncModeEnabled;
  }

  // --- Session-level exclusive operation management ---

  /**
   * Start an async run for this session.
   * Returns false if an async run is already active (caller should reject the request).
   */
  startAsyncRun(info: AsyncRunInfo): boolean {
    if (this.asyncRun !== null) {
      return false;
    }
    this.asyncRun = info;
    return true;
  }

  /**
   * Get the current async run info, if any.
   */
  getAsyncRun(): AsyncRunInfo | null {
    return this.asyncRun;
  }

  /**
   * Mark the async run as cancelled.
   */
  cancelAsyncRun(): void {
    if (this.asyncRun) {
      this.asyncRun.cancelled = true;
    }
  }

  /**
   * Clear the async run state.
   */
  clearAsyncRun(): void {
    this.asyncRun = null;
  }

  /**
   * Start a Ralph Loop for this session.
   * Returns false if a Ralph Loop is already active (caller should reject the request).
   */
  startRalphLoop(info: RalphLoopInfo): boolean {
    if (this.ralphLoop !== null) {
      return false;
    }
    this.ralphLoop = info;
    return true;
  }

  /**
   * Get the current Ralph Loop info, if any.
   */
  getRalphLoop(): RalphLoopInfo | null {
    return this.ralphLoop;
  }

  /**
   * Mark the Ralph Loop as cancelled.
   */
  cancelRalphLoop(): void {
    if (this.ralphLoop) {
      this.ralphLoop.cancelled = true;
    }
  }

  /**
   * Clear the Ralph Loop state.
   */
  clearRalphLoop(): void {
    this.ralphLoop = null;
  }

  getContext(): ContextWindow {
    if (this.context) {
      return this.context;
    }

    // First, recover paused state from GraphD metadata if it exists
    this.recoverPausedState();

    // Try to hydrate from GraphD
    if (this.isGraphDReady() && this.graphd) {
      try {
        const result = this.graphd.contextGet(this.sessionKey) as {
          snapshot?: { context?: ContextWindowSnapshot };
          error?: string;
        };
        if (result.snapshot?.context) {
          this.context = ContextWindow.deserialize(result.snapshot.context, this.contextFilePath);
          this.logger.debug('Hydrated context from GraphD', {
            sessionKey: this.sessionKey,
            itemCount: this.context.items.length,
            version: this.context.version,
          });
          return this.context;
        }
      } catch (error) {
        this.logger.warning('Failed to hydrate context from GraphD', {
          sessionKey: this.sessionKey,
          error: String(error),
        });
      }
    }

    this.context = new ContextWindow(this.sessionKey, this.maxTokens, this.contextFilePath);
    this.logger.debug('Created new context', { sessionKey: this.sessionKey, maxTokens: this.maxTokens, path: this.contextFilePath });
    return this.context;
  }

  /**
   * Recover paused state from GraphD session metadata.
   * Called during context hydration to restore session pause state.
   */
  private recoverPausedState(): void {
    if (!this.isGraphDReady() || !this.graphd) {
      return;
    }

    try {
      const session = this.graphd.sessionGet(this.sessionKey);
      const metadata = session?.metadata as Record<string, unknown> | undefined;
      const pausedStateMetadata = metadata?.paused_state as Omit<PausedState, 'pausedAt'> | undefined;

      if (pausedStateMetadata) {
        const normalizedHandoffSpec = normalizeHandoffSpec(pausedStateMetadata.handoffSpec);
        if (pausedStateMetadata.handoffSpec && !normalizedHandoffSpec) {
          this.logger.warning('Dropped invalid paused handoffSpec from metadata', { sessionKey: this.sessionKey });
        }
        this.pausedState = {
          ...pausedStateMetadata,
          handoffSpec: normalizedHandoffSpec,
          pausedAt: Date.now(),
        };
        this.logger.debug('Recovered paused state from GraphD', {
          sessionKey: this.sessionKey,
          goal: this.pausedState.goal,
          agentType: this.pausedState.agentType,
        });
      }

      const pausedWorkItemsRaw = metadata?.paused_work_items;
      const pausedWorkItems = Array.isArray(pausedWorkItemsRaw)
        ? pausedWorkItemsRaw.map((entry) => normalizePausedWorkItem(entry)).filter((entry): entry is PausedWorkItemState => entry !== null)
        : [];
      if (pausedWorkItems.length > 0) {
        this.pausedWorkItems.clear();
        for (const item of pausedWorkItems) {
          this.pausedWorkItems.set(item.workId, item);
        }
        this.logger.debug('Recovered paused work items from GraphD', {
          sessionKey: this.sessionKey,
          count: pausedWorkItems.length,
        });
      }

      // Hydrate session state (model selections, permissions) from metadata
      if (metadata) {
        this.hydrateSessionState(metadata);
      }
    } catch (error) {
      this.logger.warning('Failed to recover paused state from GraphD', {
        sessionKey: this.sessionKey,
        error: String(error),
      });
    }
  }

  getCachedContextSnapshot(): ContextWindowSnapshot | null {
    if (!this.context) return null;
    return this.context.serialize();
  }

  /**
   * Clear the current context and create a fresh one.
   * Used for handoff transitions from planning to execution.
   */
  clearContext(): ContextWindow {
    this.context = new ContextWindow(this.sessionKey, this.maxTokens, this.contextFilePath);
    this.context.clear(); // Wipe items loaded from existing disk file
    this.logger.debug('Cleared context for handoff', { sessionKey: this.sessionKey });
    return this.context;
  }

  hydrateFromSnapshot(snapshot: ContextWindowSnapshot): void {
    this.context = ContextWindow.deserialize(snapshot, this.contextFilePath);
  }

  /**
   * Get message history for TUI rehydration.
   * This returns the conversation history that should be displayed in the TUI.
   */
  getMessageHistory(): Array<{ role: 'user' | 'agent' | 'system'; content: string; timestamp: number; requestId?: string }> {
    const context = this.getContext();
    return context.getMessageHistory();
  }

  persistContext(): void {
    if (!this.context || !this.isGraphDReady() || !this.graphd) return;

    try {
      const snapshot = this.context.serialize();
      this.graphd.contextSave(this.sessionKey, { context: snapshot });
      this.logger.debug('Persisted context to GraphD', {
        sessionKey: this.sessionKey,
        itemCount: this.context.items.length,
        version: this.context.version,
      });
    } catch (error) {
      this.logger.warning('Failed to persist context to GraphD', {
        sessionKey: this.sessionKey,
        error: String(error),
      });
    }
  }

  /**
   * Persist session state (model selections, permissions) to GraphD.
   */
  private persistSessionState(): void {
    if (!this.isGraphDReady() || !this.graphd) return;

    try {
      const metadata: Record<string, unknown> = {
        model_selections: Object.fromEntries(this.modelSelections),
        permission_state: this.permissionChecker.getState(),
      };
      this.graphd.sessionUpdateMetadata(this.sessionKey, metadata);
      this.logger.debug('Persisted session state to GraphD', {
        sessionKey: this.sessionKey,
        modelSelectionsCount: this.modelSelections.size,
        permissionGrants: this.permissionChecker.getState().sessionGrants.length,
        permissionDenials: this.permissionChecker.getState().sessionDenials.length,
        dangerousMode: this.permissionChecker.getState().dangerousMode,
      });
    } catch (error) {
      this.logger.warning('Failed to persist session state to GraphD', {
        sessionKey: this.sessionKey,
        error: String(error),
      });
    }
  }

  /**
   * Hydrate session state from GraphD metadata.
   */
  private hydrateSessionState(metadata: Record<string, unknown>): void {
    // Hydrate model selections
    const modelSelections = metadata.model_selections as Record<string, ModelSelection> | undefined;
    if (modelSelections) {
      for (const [agentType, selection] of Object.entries(modelSelections)) {
        if (selection?.provider && selection?.model) {
          this.modelSelections.set(agentType, selection);
        }
      }
    }

    // Hydrate permission state
    const permissionState = metadata.permission_state as SessionPermissionState | undefined;
    if (permissionState) {
      this.permissionChecker.hydrateState(permissionState);
      this.logger.debug('Hydrated permission state from GraphD', {
        sessionKey: this.sessionKey,
        grants: permissionState.sessionGrants.length,
        denials: permissionState.sessionDenials.length,
        dangerousMode: permissionState.dangerousMode,
      });
    }
  }

  touch(workingDir: string): void {
    if (!this.isGraphDReady() || !this.graphd) return;
    this.graphd.sessionTouch(this.sessionKey, workingDir);
  }

  setPausedState(state: Omit<PausedState, 'pausedAt'>): void {
    this.pausedState = { ...state, pausedAt: Date.now() };
    // Persist paused state to GraphD session metadata for recovery
    if (this.isGraphDReady() && this.graphd) {
      try {
        this.graphd.sessionUpdateMetadata(this.sessionKey, { paused_state: state });
        this.logger.debug('Persisted paused state to GraphD', {
          sessionKey: this.sessionKey,
          goal: state.goal,
          agentType: state.agentType,
        });
      } catch (error) {
        this.logger.warning('Failed to persist paused state to GraphD', {
          sessionKey: this.sessionKey,
          error: String(error),
        });
      }
    }
  }

  getPausedState(): PausedState | null {
    return this.pausedState;
  }

  upsertPausedWorkItem(input: {
    workId: string;
    agentType: string;
    objective?: string;
    reason: string;
    escalationId?: string;
    status?: PausedWorkItemStatus;
    timestamp?: number;
  }): PausedWorkItemState {
    const now = input.timestamp ?? Date.now();
    const existing = this.pausedWorkItems.get(input.workId);
    const next: PausedWorkItemState = {
      workId: input.workId,
      agentType: input.agentType,
      ...(input.objective ? { objective: input.objective } : existing?.objective ? { objective: existing.objective } : {}),
      reason: input.reason,
      ...(input.escalationId ? { escalationId: input.escalationId } : existing?.escalationId ? { escalationId: existing.escalationId } : {}),
      status: input.status ?? 'pending',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.resolvedAt ? { resolvedAt: existing.resolvedAt } : {}),
      ...(existing?.resolutionSummary ? { resolutionSummary: existing.resolutionSummary } : {}),
    };
    this.pausedWorkItems.set(input.workId, next);
    this.persistPausedWorkItems();
    return next;
  }

  listPausedWorkItems(): PausedWorkItemState[] {
    return Array.from(this.pausedWorkItems.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  resolvePausedWorkItem(workId: string, resolutionSummary?: string, timestamp: number = Date.now()): PausedWorkItemState | null {
    const existing = this.pausedWorkItems.get(workId);
    if (!existing) return null;
    if (existing.status === 'resolved' || existing.status === 'cancelled') return existing;

    const next: PausedWorkItemState = {
      ...existing,
      status: 'resolved',
      updatedAt: timestamp,
      resolvedAt: timestamp,
      ...(resolutionSummary ? { resolutionSummary } : {}),
    };
    this.pausedWorkItems.set(workId, next);
    this.persistPausedWorkItems();
    return next;
  }

  cancelPausedWorkItem(workId: string, resolutionSummary?: string, timestamp: number = Date.now()): PausedWorkItemState | null {
    const existing = this.pausedWorkItems.get(workId);
    if (!existing) return null;
    if (existing.status === 'resolved' || existing.status === 'cancelled') return existing;

    const next: PausedWorkItemState = {
      ...existing,
      status: 'cancelled',
      updatedAt: timestamp,
      resolvedAt: timestamp,
      ...(resolutionSummary ? { resolutionSummary } : {}),
    };
    this.pausedWorkItems.set(workId, next);
    this.persistPausedWorkItems();
    return next;
  }

  private persistPausedWorkItems(): void {
    if (!this.isGraphDReady() || !this.graphd) return;
    try {
      this.graphd.sessionUpdateMetadata(this.sessionKey, {
        paused_work_items: Array.from(this.pausedWorkItems.values()),
      });
    } catch (error) {
      this.logger.warning('Failed to persist paused work items to GraphD', {
        sessionKey: this.sessionKey,
        error: String(error),
      });
    }
  }

  clearPausedState(): void {
    this.pausedState = null;
    // Clear paused state from GraphD session metadata
    if (this.isGraphDReady() && this.graphd) {
      try {
        this.graphd.sessionUpdateMetadata(this.sessionKey, { paused_state: null });
        this.logger.debug('Cleared paused state from GraphD', { sessionKey: this.sessionKey });
      } catch (error) {
        this.logger.warning('Failed to clear paused state from GraphD', {
          sessionKey: this.sessionKey,
          error: String(error),
        });
      }
    }
  }

  close(): void {
    this.persistContext();
    this.context = null;
    this.pausedState = null;
    this.pausedWorkItems.clear();
    this.modelSelections.clear();
    this.asyncRun = null;
    this.ralphLoop = null;
  }

  /**
   * Set model selection for a specific agent type.
   */
  setModelSelection(agentType: string, selection: ModelSelection): void {
    this.modelSelections.set(agentType, selection);
    this.persistSessionState();
  }

  /**
   * Get model selection for a specific agent type.
   * Returns null if no selection exists for that agent type.
   */
  getModelSelection(agentType: string): ModelSelection | null {
    return this.modelSelections.get(agentType) ?? null;
  }

  /**
   * Get all model selections (for persistence).
   */
  getAllModelSelections(): Map<string, ModelSelection> {
    return new Map(this.modelSelections);
  }

  /**
   * Clear all model selections.
   */
  clearModelSelections(): void {
    this.modelSelections.clear();
  }

  // --- Permission management (per-session) ---

  /**
   * Get the permission checker for this session.
   * Each session has its own permission state including dangerous mode.
   */
  getPermissionChecker(): PermissionChecker {
    return this.permissionChecker;
  }

  /**
   * Set dangerous mode for this session.
   * Does not affect other sessions.
   */
  setDangerousMode(enabled: boolean): void {
    this.permissionChecker.setDangerousMode(enabled);
    this.logger.info('Dangerous mode changed', {
      sessionKey: this.sessionKey,
      enabled,
    });
  }

  // --- Execution tracking ---

  /**
   * Mark that an orchestrator is executing for this session.
   * Returns false if there's already an active execution (caller should queue message instead).
   */
  startExecution(requestId: string): boolean {
    if (this.executingRequestId !== null) {
      return false;
    }
    this.executingRequestId = requestId;
    return true;
  }

  /**
   * Check if there's an active orchestrator execution.
   */
  isExecuting(): boolean {
    return this.executingRequestId !== null;
  }

  /**
   * Get the current executing request ID, if any.
   */
  getExecutingRequestId(): string | null {
    return this.executingRequestId;
  }

  /**
   * Mark execution as complete and return any queued user messages.
   * Messages should be injected into context before next agent turn.
   */
  endExecution(): Array<{ requestId: string; message: string }> {
    this.executingRequestId = null;
    const queued = this.queuedUserMessages;
    this.queuedUserMessages = [];
    return queued;
  }

  /**
   * Queue a user message to be seen by the running agent on its next turn.
   * The message is added to the context window immediately (with interruption directive)
   * so the agent sees it and understands it's an interruption.
   */
  queueUserMessage(requestId: string, message: string): void {
    this.queuedUserMessages.push({ requestId, message });
    // Add to context with interruption directive so agent understands it's mid-execution
    const ctx = this.getContext();
    const directive = buildInterruptionDirective(message);
    ctx.addMessage('user', directive);
    this.logger.debug('Queued user message during execution', {
      sessionKey: this.sessionKey,
      executingRequestId: this.executingRequestId,
      queuedRequestId: requestId,
      messagePreview: message.slice(0, 100),
    });
  }

  /**
   * Drain queued messages (clears the queue).
   */
  drainQueuedMessages(): Array<{ requestId: string; message: string }> {
    const queued = this.queuedUserMessages;
    this.queuedUserMessages = [];
    return queued;
  }

  /**
   * Get queued messages without clearing them (for inspection).
   */
  getQueuedMessages(): ReadonlyArray<{ requestId: string; message: string }> {
    return this.queuedUserMessages;
  }

  /**
   * Check if there are pending user messages (interruptions) waiting.
   * Used by orchestrator to avoid premature termination.
   */
  hasPendingInterruption(): boolean {
    return this.queuedUserMessages.length > 0;
  }

  /**
   * Check if any pending user message is a stop request.
   * Used by agent to exit loop early on explicit user stop.
   */
  hasPendingStopRequest(): boolean {
    return this.queuedUserMessages.some(({ message }) => /\bstop\b/i.test(message));
  }
}


### function_call
@callId call_40b96f5e117141fdb9824a51
@name Grep
@ts 1770398795837
@workItemId 14550bbc
{"pattern":"graphd\\.(session|message|trace|token|escalation)","path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness"}

### function_call
@callId call_a00fc8be73844d7c90b2afba
@name Glob
@ts 1770398795837
@workItemId 14550bbc
{"pattern":"**/graphd/**/*.ts"}

### function_call_output
@callId call_40b96f5e117141fdb9824a51
@ts 1770398797061
@durationMs 1223
@workItemId 14550bbc
packages/harness-daemon/src/harness/session_store.ts:317:28:      const session = this.graphd.sessionGet(this.sessionKey);
packages/harness-daemon/src/harness/session_store.ts:424:12:      this.graphd.sessionUpdateMetadata(this.sessionKey, metadata);
packages/harness-daemon/src/harness/session_store.ts:469:10:    this.graphd.sessionTouch(this.sessionKey, workingDir);
packages/harness-daemon/src/harness/session_store.ts:477:14:        this.graphd.sessionUpdateMetadata(this.sessionKey, { paused_state: state });
packages/harness-daemon/src/harness/session_store.ts:565:12:      this.graphd.sessionUpdateMetadata(this.sessionKey, {
packages/harness-daemon/src/harness/session_store.ts:581:14:        this.graphd.sessionUpdateMetadata(this.sessionKey, { paused_state: null });
packages/harness-daemon/src/harness/bridge_gateway.ts:583:9:        graphd.sessionUpdateStatus(state.sessionKey, 'inactive');
packages/harness-daemon/src/harness/bridge_gateway.ts:604:7:      graphd.sessionTouch(sessionKey, state.workingDir);
packages/harness-daemon/src/harness/bridge_gateway.ts:605:7:      graphd.sessionUpdateStatus(sessionKey, 'active');
packages/harness-daemon/src/harness/bridge_gateway.ts:753:7:      graphd.sessionSetGoalIfEmpty(sessionKey, goalPreview);
packages/harness-daemon/src/harness/bridge_gateway.ts:999:23:      const session = graphd.sessionGet(sessionKey);
packages/harness-daemon/src/harness/bridge_gateway.ts:1011:9:        graphd.sessionUpdateMetadata(sessionKey, { model_selections: sessionSelections });
packages/harness-daemon/src/harness/bridge_gateway.ts:1559:20:    const result = graphd.sessionsList({
packages/harness-daemon/src/harness/bridge_gateway.ts:1633:9:        graphd.sessionUpdateMetadata(sessionKey, { model_selections: null });
packages/harness-daemon/src/harness/bridge_gateway.ts:1686:7:      graphd.sessionUpdateMetadata(sessionKey, { model_selections: updatedSelections });
packages/harness-daemon/src/harness/bridge_gateway.ts:2124:7:      graphd.sessionUpdateWorkflow(sessionKey, { goal });
packages/harness-daemon/src/harness/bridge_gateway.ts:2421:19:                  graphd.sessionTouch(sessionKey);
packages/harness-daemon/src/harness/control_plane_routes.ts:3603:22:  const result = ctx.graphd.sessionsList({
packages/harness-daemon/src/harness/control_plane_routes.ts:3616:22:  const result = ctx.graphd.sessionGet(sessionKey) as { session?: SessionRow };
packages/harness-daemon/src/harness/control_plane_routes.ts:4622:9:    ctx.graphd.sessionUpdateMetadata(sessionKey, metadataPatch);
...[truncated at 20 results]

### function_call_output
@callId call_a00fc8be73844d7c90b2afba
@ts 1770398797061
@durationMs 1222
@workItemId 14550bbc
packages/graphd/src/index.ts
packages/graphd/src/manager.ts
packages/graphd/src/schema.ts
packages/graphd/src/server.ts
packages/graphd/src/store.ts
packages/graphd/src/types.ts
packages/graphd/src/utils.ts

### function_call
@callId call_742c586f41bf4f3dbf2b230d
@name Read
@ts 1770398804015
@workItemId 14550bbc
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/graphd/src/manager.ts"}

### function_call
@callId call_5555882b11e94e1fb53fca31
@name Read
@ts 1770398804015
@workItemId 14550bbc
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/graphd/src/store.ts"}

### function_call_output
@callId call_742c586f41bf4f3dbf2b230d
@ts 1770398804022
@durationMs 4
@workItemId 14550bbc
/**
 * GraphD Manager: persistence, HTTP API, and session management.
 *
 * Ported from: src/harness/graphd/manager.py
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve, isAbsolute } from 'path';
import { execSync } from 'child_process';
import { GraphStore, SchemaVersionError } from './store.js';
import { GraphDHTTPServer, checkHealthy } from './server.js';
import { GRAPHD_VERSION, GRAPHD_SCHEMA_VERSION } from './schema.js';
import type { GraphDStats, HealthResponse } from './types.js';
import { normalizePath, generateSessionKey, nowSeconds } from './utils.js';

/**
 * Kill any process listening on the specified port.
 * Returns true if a process was killed, false if no process was found.
 */
function killProcessOnPort(port: number): boolean {
  try {
    // Get PIDs of processes using this port
    const platform = process.platform;
    let pids: number[] = [];

    if (platform === 'darwin' || platform === 'linux') {
      // Use lsof to find processes on the port
      const output = execSync(`lsof -ti :${port} 2>/dev/null || true`, {
        encoding: 'utf-8',
      }).trim();
      if (output) {
        pids = output.split('\n').map((p) => parseInt(p, 10)).filter((p) => !isNaN(p));
      }
    } else if (platform === 'win32') {
      // Windows: use netstat to find the PID
      const output = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf-8',
      }).trim();
      const lines = output.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(pid) && pid > 0) {
          pids.push(pid);
        }
      }
    }

    if (pids.length === 0) {
      return false;
    }

    // Kill each PID
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`Killed stale process ${pid} on port ${port}`);
      } catch {
        // Process may have already exited
      }
    }

    return true;
  } catch {
    return false;
  }
}

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
  /** Session idle timeout in seconds (mark inactive after this) */
  sessionIdleTimeoutS: number;
  /** Session cleanup interval in seconds */
  sessionCleanupIntervalS: number;
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
    sessionIdleTimeoutS: opts?.sessionIdleTimeoutS ?? 300, // 5 minutes
    sessionCleanupIntervalS: opts?.sessionCleanupIntervalS ?? 60, // 1 minute
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

  private store: GraphStore | null = null;
  private server: GraphDHTTPServer | null = null;
  private running = false;
  private active = false;
  private paused = false;
  private reusingExisting = false;
  private lastIndexStats: Record<string, unknown> = {};
  private sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: GraphDConfig) {
    this.config = config;
    this.root = resolve(config.rootPath);
    this.dbPath = this.resolveDbPath(config.dbPath);
  }

  /**
   * Last error encountered during start.
   */
  lastError: Error | null = null;

  /**
   * Start the GraphD manager.
   * Throws on failure with detailed error message.
   */
  async start(): Promise<boolean> {
    this.lastError = null;

    try {
      // Check if port is already in use BEFORE opening database
      const inUse = await checkHealthy(this.config.host, this.config.port, 1000);
      if (inUse) {
        console.warn(
          `GraphD already running on ${this.config.host}:${this.config.port}, reusing existing instance`
        );
        this.running = true;
        this.reusingExisting = true;

        // Open database for local writes so events are persisted to the shared DB.
        try {
          const dbDir = dirname(this.dbPath);
          if (dbDir && !existsSync(dbDir)) {
            mkdirSync(dbDir, { recursive: true });
          }
          this.store = new GraphStore(this.dbPath);
          this.store.initialize();

          // CRITICAL: Start session cleanup timer even when reusing.
          // Session cleanup is database-level, not server-level. Multiple processes
          // can safely run cleanup concurrently (SQL UPDATE is atomic).
          // Without this, sessions stay "active" forever when the primary GraphD
          // instance doesn't handle sessions (e.g., dashboard-only).
          this.startSessionCleanupTimer();
        } catch (err) {
          console.warn('GraphD reuse: failed to open local store', err);
          this.store = null;
        }

        return true;
      }

      // Ensure database directory exists
      const dbDir = dirname(this.dbPath);
      if (dbDir && !existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      // Now open database - we're the primary instance
      this.store = new GraphStore(this.dbPath);
      this.store.initialize();
      this.running = true;
      this.reusingExisting = false;

      // Start HTTP server (with retry after killing stale process)
      this.server = new GraphDHTTPServer(
        this.config.host,
        this.config.port,
        this
      );

      try {
        await this.server.start();
      } catch (err) {
        // If EADDRINUSE but health check failed, there's a stale process holding the port
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          console.warn(`Port ${this.config.port} held by stale process, attempting cleanup...`);
          const killed = killProcessOnPort(this.config.port);
          if (killed) {
            // Wait briefly for port to be released
            await new Promise((resolve) => setTimeout(resolve, 100));
            // Retry once
            this.server = new GraphDHTTPServer(
              this.config.host,
              this.config.port,
              this
            );
            await this.server.start();
            console.log(`Successfully started after killing stale process`);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      // Verify server started
      const healthy = await checkHealthy(
        this.config.host,
        this.config.port,
        1000
      );
      if (!healthy) {
        console.warn('GraphD server started but health check failed');
      }

      // Start session cleanup timer
      this.startSessionCleanupTimer();

      console.log(
        `GraphD ready: db=${this.dbPath} root=${this.root} port=${this.config.port}`
      );
      return true;
    } catch (err) {
      this.running = false;

      // Create detailed error message
      let errorMessage: string;
      if (err instanceof SchemaVersionError) {
        errorMessage = `Schema version mismatch: found '${err.foundVersion}', expected '${err.expectedVersion}'. Delete ${err.dbPath} to recreate.`;
      } else if (err instanceof Error) {
        errorMessage = `${err.name}: ${err.message}`;
        if (err.stack) {
          // Include first line of stack for context
          const stackLine = err.stack.split('\n')[1]?.trim();
          if (stackLine) {
            errorMessage += ` (${stackLine})`;
          }
        }
      } else {
        errorMessage = String(err);
      }

      // Store error for retrieval
      this.lastError = new Error(`GraphD failed to start: ${errorMessage}`);

      // Re-throw with detailed message so callers get the info
      throw this.lastError;
    }
  }

  /**
   * Stop the GraphD manager.
   */
  async stop(): Promise<void> {
    this.running = false;

    // Stop session cleanup timer
    this.stopSessionCleanupTimer();

    // Don't stop the shared server if we're reusing an existing instance
    if (this.reusingExisting) {
      if (this.store) {
        this.store.close();
        this.store = null;
      }
      return;
    }

    if (this.server) {
      await this.server.stop();
      this.server = null;
    }

    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }

  /**
   * Start the background session cleanup timer.
   */
  private startSessionCleanupTimer(): void {
    if (this.sessionCleanupTimer) return;

    const intervalMs = this.config.sessionCleanupIntervalS * 1000;
    this.sessionCleanupTimer = setInterval(() => {
      this.runSessionCleanup();
    }, intervalMs);

    // Run immediately on start to clean up any stale sessions
    this.runSessionCleanup();
  }

  /**
   * Stop the background session cleanup timer.
   */
  private stopSessionCleanupTimer(): void {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = null;
    }
  }

  /**
   * Run session cleanup: mark stale sessions as inactive and clean expired ones.
   */
  private runSessionCleanup(): void {
    if (!this.store) return;

    try {
      const staleCount = this.store.markStaleSessions(this.config.sessionIdleTimeoutS);
      const expiredCount = this.store.cleanupExpiredSessions();

      if (staleCount > 0 || expiredCount > 0) {
        console.log(`Session cleanup: ${staleCount} marked inactive, ${expiredCount} expired deleted`);
      }
    } catch (err) {
      console.warn('Session cleanup failed:', err);
    }
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

  /**
   * Checkpoint the WAL to flush writes to the main database file.
   * This makes writes visible to other processes (like the dashboard).
   */
  checkpoint(): void {
    if (this.store) {
      this.store.checkpoint();
    }
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
      stats: this.store?.getStats() ?? { files: 0, symbols: 0, moduleEdges: 0, exports: 0 },
      lastIndex: this.lastIndexStats,
    };
  }

  /**
   * Check if this manager is reusing an existing instance.
   */
  isReusing(): boolean {
    return this.reusingExisting;
  }

  /**
   * Handle /symbol endpoint.
   */
  handleSymbol(
    path: string,
    line: number
  ): Record<string, unknown> {
    if (!this.store) {
      return { error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { success: false, error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { success: false, error: 'reusing_existing_instance' };
    }
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
    return this.sessionUpdateStatus(sessionKey, 'closed');
  }

  /**
   * Update session status.
   */
  sessionUpdateStatus(sessionKey: string, status: string): Record<string, unknown> {
    if (!this.store) {
      return { success: false, error: 'reusing_existing_instance' };
    }
    try {
      const updated = this.store.updateSessionStatus(sessionKey, status);
      return { success: updated };
    } catch (err) {
      console.warn('Session status update failed:', err);
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
    if (!this.store) {
      return { success: false, error: 'reusing_existing_instance' };
    }
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
   * Update session workflow state (goal, current work item, objective).
   */
  sessionUpdateWorkflow(
    sessionKey: string,
    updates: {
      status?: string;
      goal?: string | null;
      currentWorkItemId?: string | null;
      currentObjective?: string | null;
    }
  ): boolean {
    if (!this.store) return false;
    try {
      return this.store.updateSessionWorkflow(sessionKey, updates);
    } catch (err) {
      console.warn('Session workflow update failed:', err);
      return false;
    }
  }

  /**
   * Set goal only if not already set.
   */
  sessionSetGoalIfEmpty(sessionKey: string, goal: string): boolean {
    if (!this.store) return false;
    try {
      return this.store.setGoalIfEmpty(sessionKey, goal);
    } catch (err) {
      console.warn('Session set goal failed:', err);
      return false;
    }
  }

  /**
   * Delete a session.
   */
  sessionDelete(sessionKey: string): boolean {
    if (!this.store) {
      return false;
    }
    try {
      return this.store.deleteSession(sessionKey);
    } catch (err) {
      console.warn('Session delete failed:', err);
      return false;
    }
  }

  /**
   * List sessions with optional filtering.
   */
  sessionsList(
    options: {
      clientType?: string;
      workingDir?: string;
      status?: string | string[];
      limit?: number;
      includePreview?: boolean;
    } = {}
  ): Record<string, unknown> {
    if (!this.store) {
      return { sessions: [], error: 'reusing_existing_instance' };
    }
    try {
      const sessions = this.store.listSessions(options);
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
    if (!this.store) {
      return { deleted_count: 0, error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { success: false, error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { messages: [], error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { deleted_count: 0, error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { success: false, error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { snapshot: null, error: 'reusing_existing_instance' };
    }
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
    if (!this.store) {
      return { snapshots: [], error: 'reusing_existing_instance' };
    }
    try {
      const snapshots = this.store.listContextSnapshots(sessionKey, limit);
      return { snapshots };
    } catch (err) {
      console.warn('Context list failed:', err);
      return { snapshots: [], error: (err as Error).message };
    }
  }

  // =========================================================================
  // Event Management
  // =========================================================================

  /**
   * Add an event to a session.
   */
  eventAdd(
    sessionKey: string,
    eventType: string,
    data: Record<string, unknown>,
    requestId?: string,
    stepNum?: number
  ): Record<string, unknown> {
    if (!this.store) {
      return { success: false, error: 'reusing_existing_instance' };
    }
    try {
      const eventId = this.store.addEvent(
        sessionKey,
        eventType,
        data,
        requestId,
        stepNum
      );
      return { success: true, event_id: eventId };
    } catch (err) {
      console.warn('Event add failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Get events for a session.
   */
  eventsGet(
    sessionKey: string,
    requestId?: string,
    eventType?: string,
    limit = 1000,
    offset = 0
  ): Record<string, unknown> {
    if (!this.store) {
      return { events: [], error: 'reusing_existing_instance' };
    }
    try {
      const events = this.store.getEvents(
        sessionKey,
        requestId,
        eventType,
        limit,
        offset
      );
      return { events };
    } catch (err) {
      console.warn('Events get failed:', err);
      return { events: [], error: (err as Error).message };
    }
  }

  /**
   * Get event count for a session.
   */
  eventsCount(sessionKey: string, requestId?: string): Record<string, unknown> {
    if (!this.store) {
      return { count: 0, error: 'reusing_existing_instance' };
    }
    try {
      const count = this.store.getEventCount(sessionKey, requestId);
      return { count };
    } catch (err) {
      console.warn('Events count failed:', err);
      return { count: 0, error: (err as Error).message };
    }
  }

  /**
   * Delete events for a session.
   */
  eventsDelete(sessionKey: string, requestId?: string): Record<string, unknown> {
    if (!this.store) {
      return { deleted_count: 0, error: 'reusing_existing_instance' };
    }
    try {
      const count = this.store.deleteEvents(sessionKey, requestId);
      return { deleted_count: count };
    } catch (err) {
      console.warn('Events delete failed:', err);
      return { deleted_count: 0, error: (err as Error).message };
    }
  }

  // =========================================================================
  // Session Fork
  // =========================================================================

  /**
   * Fork a session, duplicating context snapshot and messages.
   */
  sessionFork(
    sourceSessionKey: string,
    targetSessionKey?: string
  ): { success: boolean; newSessionKey?: string; error?: string } {
    if (!this.store) {
      return { success: false, error: 'reusing_existing_instance' };
    }

    const newKey = targetSessionKey ?? generateSessionKey();

    try {
      const result = this.store.forkSession(sourceSessionKey, newKey);
      if (result.success) {
        return { success: true, newSessionKey: newKey };
      }
      return { success: false, error: result.error };
    } catch (err) {
      console.warn('Session fork failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }

  // =========================================================================
  // User Preferences
  // =========================================================================

  /**
   * Get a user preference value.
   */
  getUserPreference<T = unknown>(key: string): T | null {
    if (!this.store) return null;
    try {
      return this.store.getUserPreference<T>(key);
    } catch (err) {
      console.warn('Get user preference failed:', err);
      return null;
    }
  }

  /**
   * Set a user preference value.
   */
  setUserPreference(key: string, value: unknown): boolean {
    if (!this.store) return false;
    try {
      this.store.setUserPreference(key, value);
      return true;
    } catch (err) {
      console.warn('Set user preference failed:', err);
      return false;
    }
  }

  /**
   * Delete a user preference.
   */
  deleteUserPreference(key: string): boolean {
    if (!this.store) return false;
    try {
      return this.store.deleteUserPreference(key);
    } catch (err) {
      console.warn('Delete user preference failed:', err);
      return false;
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


### function_call_output
@callId call_5555882b11e94e1fb53fca31
@ts 1770398804022
@durationMs 2
@workItemId 14550bbc
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
  V6_MIGRATION_STATEMENTS,
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
  SessionStatus,
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

    // Run v6 migrations (add columns to existing tables)
    // These fail gracefully if columns already exist
    if (existingNum < 6) {
      for (const stmt of V6_MIGRATION_STATEMENTS) {
        try {
          this.db.exec(stmt);
        } catch (err) {
          // Ignore "duplicate column name" errors - column already exists
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('duplicate column name')) {
            throw err;
          }
        }
      }
    }

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
    metadata?: Record<string, unknown>,
    goal?: string
  ): boolean {
    const now = nowSeconds();
    try {
      this.db
        .query(
          `INSERT INTO sessions (session_key, client_type, created_at, last_accessed_at,
                                 expires_at, working_dir, status, metadata_json, goal)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?);`
        )
        .run(
          sessionKey,
          clientType,
          now,
          now,
          expiresAt ?? null,
          workingDir ?? null,
          metadata ? JSON.stringify(metadata) : null,
          goal ?? null
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
      status: row.status as SessionStatus,
      metadataJson: row.metadata_json as string | null,
      // Workflow fields (v6)
      goal: row.goal as string | null,
      currentWorkItemId: row.current_work_item_id as string | null,
      currentObjective: row.current_objective as string | null,
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
   * Update session workflow state (goal, current work item, objective).
   * Only updates non-null fields.
   */
  updateSessionWorkflow(
    sessionKey: string,
    updates: {
      status?: string;
      goal?: string | null;
      currentWorkItemId?: string | null;
      currentObjective?: string | null;
    }
  ): boolean {
    const setClauses: string[] = [];
    const params: (string | null)[] = [];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);
    }
    if (updates.goal !== undefined) {
      setClauses.push('goal = ?');
      params.push(updates.goal);
    }
    if (updates.currentWorkItemId !== undefined) {
      setClauses.push('current_work_item_id = ?');
      params.push(updates.currentWorkItemId);
    }
    if (updates.currentObjective !== undefined) {
      setClauses.push('current_objective = ?');
      params.push(updates.currentObjective);
    }

    if (setClauses.length === 0) return false;

    params.push(sessionKey);
    const result = this.db
      .query(`UPDATE sessions SET ${setClauses.join(', ')} WHERE session_key = ?;`)
      .run(...params);
    return result.changes > 0;
  }

  /**
   * Set goal only if not already set (first-message semantics).
   */
  setGoalIfEmpty(sessionKey: string, goal: string): boolean {
    const result = this.db
      .query('UPDATE sessions SET goal = ? WHERE session_key = ? AND (goal IS NULL OR goal = ?);')
      .run(goal, sessionKey, '');
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
      status: row.status as SessionStatus,
      metadataJson: row.metadata_json as string | null,
      lastUserMessagePreview: includePreview ? (row.last_user_preview as string | null) : undefined,
      // Workflow fields (v6)
      goal: row.goal as string | null,
      currentWorkItemId: row.current_work_item_id as string | null,
      currentObjective: row.current_objective as string | null,
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
      .query('SEL
... [truncated 14590 chars]

### message:assistant
@ts 1770399426145
Here is the implementation plan and code to add Escalations support to `harness-daemon` and `graphd`.

### 1. Update GraphD Schema
Add a table to persist escalations relationally.

**File:** `packages/graphd/src/schema.ts`

typescript
// ... existing imports

// Add to the DDL string
export const GRAPHD_SCHEMA_DDL = `
  -- ... existing tables (files, symbols, etc.)

  CREATE TABLE IF NOT EXISTS session_escalations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    escalation_id TEXT NOT NULL UNIQUE,
    work_item_id TEXT,
    headline TEXT NOT NULL,
    requested_decision TEXT NOT NULL, -- 'choose', 'approve', 'clarify', etc.
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'resolved', 'cancelled'
    resolution_summary TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    metadata_ TEXT,
    FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_session_escalations_session_key 
    ON session_escalations(session_key);
  
  CREATE INDEX IF NOT EXISTS idx_session_escalations_status 
    ON session_escalations(status);
` + ` -- existing DDL (concatenated for brevity)`;

// Add to EXPORTABLE_TABLES if needed
export const EXPORTABLE_TABLES = new Set([
  'files', 'symbols', 'module_edges', 'exports', 
  'sessions', 'conversation_messages', 'context_snapshots', 'session_events',
  'session_escalations' 
]);
``### 2. Update GraphD Store
Implement CRUD operations for escalations.

**File:** `packages/graphd/src/store.ts`

typescript
// ... imports

export interface SessionEscalationRecord {
  id: number;
  sessionKey: string;
  escalationId: string;
  workItemId: string | null;
  headline: string;
  requestedDecision: string;
  status: 'pending' | 'resolved' | 'cancelled';
  resolutionSummary: string | null;
  createdAt: number;
  resolvedAt: number | null;
  metadataJson: string | null;
}

export class GraphStore {
  // ... existing code

  // =========================================================================
  // Escalation Management Methods
  // =========================================================================

  /**
   * Upsert an escalation.
   */
  upsertEscalation(record: {
    sessionKey: string;
    escalationId: string;
    workItemId?: string | null;
    headline: string;
    requestedDecision: string;
    status?: 'pending' | 'resolved' | 'cancelled';
    resolutionSummary?: string | null;
    createdAt?: number;
    resolvedAt?: number | null;
    metadata?: Record<string, unknown> | null;
  }): boolean {
    const now = record.createdAt ?? nowSeconds();
    
    try {
      this.db
        .query(
          `INSERT INTO session_escalations 
             (session_key, escalation_id, work_item_id, headline, requested_decision, 
              status, resolution_summary, created_at, resolved_at, metadata_)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(escalation_id) 
           DO UPDATE SET 
             status = excluded.status,
             resolution_summary = excluded.resolution_summary,
             resolved_at = excluded.resolved_at,
             metadata_ = excluded.metadata_;`
        )
        .run(
          record.sessionKey,
          record.escalationId,
          record.workItemId ?? null,
          record.headline,
          record.requestedDecision,
          record.status ?? 'pending',
          record.resolutionSummary ?? null,
          now,
          record.resolvedAt ?? null,
          record.metadata ? JSON.stringify(record.metadata) : null
        );
      return true;
    } catch (err) {
      console.warn('Upsert escalation failed:', err);
      return false;
    }
  }

  /**
   * Get escalations for a session.
   */
  getEscalations(sessionKey: string): SessionEscalationRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM session_escalations 
         WHERE session_key = ? 
         ORDER BY created_at DESC;`
      )
      .all(sessionKey) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as number,
      sessionKey: row.session_key as string,
      escalationId: row.escalation_id as string,
      workItemId: row.work_item_id as string | null,
      headline: row.headline as string,
      requestedDecision: row.requested_decision as string,
      status: row.status as 'pending' | 'resolved' | 'cancelled',
      resolutionSummary: row.resolution_summary as string | null,
      createdAt: row.created_at as number,
      resolvedAt: row.resolved_at as number | null,
      metadataJson: row.metadata_ as string | null,
    }));
  }

  /**
   * Resolve or cancel an escalation.
   */
  updateEscalation(
    escalationId: string,
    updates: {
      status: 'resolved' | 'cancelled';
      resolutionSummary?: string;
      resolvedAt?: number;
    }
  ): boolean {
    const resolvedAt = updates.resolvedAt ?? nowSeconds();
    
    const result = this.db
      .query(
        `UPDATE session_escalations 
         SET status = ?, resolution_summary = ?, resolved_at = ? 
         WHERE escalation_id = ?;`
      )
      .run(updates.status, updates.resolutionSummary ?? null, resolvedAt, escalationId);
    
    return result.changes > 0;
  }

  /**
   * Delete escalations for a session.
   */
  deleteEscalations(sessionKey: string): number {
    const result = this.db
      .query('DELETE FROM session_escalations WHERE session_key = ?;')
      .run(sessionKey);
    return result.changes;
  }
}
``### 3. Update GraphD Manager
Expose store methods to the HTTP API and internal callers.

**File:** `packages/graphd/src/manager.ts`

typescript
import type { SessionEscalationRecord } from './store.js';

export class GraphDManager {
  // ... existing code

  /**
   * Upsert an escalation.
   */
  escalationUpsert(record: {
    sessionKey: string;
    escalationId: string;
    workItemId?: string | null;
    headline: string;
    requestedDecision: string;
    status?: 'pending' | 'resolved' | 'cancelled';
    resolutionSummary?: string | null;
    createdAt?: number;
    resolvedAt?: number | null;
    metadata?: Record<string, unknown> | null;
  }): boolean {
    if (!this.store) return false;
    try {
      return this.store.upsertEscalation(record);
    } catch (err) {
      console.warn('Manager escalation upsert failed:', err);
      return false;
    }
  }

  /**
   * Get escalations for a session.
   */
  escalationsList(sessionKey: string): { escalations: SessionEscalationRecord[]; error?: string } {
    if (!this.store) {
      return { escalations: [], error: 'reusing_existing_instance' };
    }
    try {
      const escalations = this.store.getEscalations(sessionKey);
      return { escalations };
    } catch (err) {
      console.warn('Manager escalations list failed:', err);
      return { escalations: [], error: (err as Error).message };
    }
  }

  /**
   * Resolve an escalation.
   */
  escalationResolve(
    escalationId: string,
    resolution: {
      status: 'resolved' | 'cancelled';
      resolutionSummary?: string;
    }
  ): { success: boolean; error?: string } {
    if (!this.store) {
      return { success: false, error: 'reusing_existing_instance' };
    }
    try {
      const updated = this.store.updateEscalation(escalationId, {
        status: resolution.status,
        resolutionSummary: resolution.resolutionSummary,
        resolvedAt: nowSeconds(),
      });
      return { success: updated };
    } catch (err) {
      console.warn('Manager escalation resolve failed:', err);
      return { success: false, error: (err as Error).message };
    }
  }
}
``### 4. Create Escalation State Types/Logic
Define the types and the parsing logic referenced in `control_plane_routes.ts`.

**File:** `packages/harness-daemon/src/harness/escalation_state.ts`

typescript
import type { SessionEscalationRecord } from 'graphd';

export interface EscalationResolutionInput {
  status: 'resolved' | 'cancelled';
  resolutionSummary?: string;
}

export interface SessionEscalationRollup {
  escalationId: string;
  sessionKey: string;
  workItemId?: string;
  createdAt: string;
  ageSec: number;
  headline: string;
  requestedDecision: 'choose' | 'approve' | 'clarify' | 'permission' | 'stop' | 'unknown';
  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
  status: 'pending' | 'resolved' | 'cancelled';
  resolutionSummary?: string;
  resolvedAt?: string;
}

/**
 * Parse session escalations from GraphD records.
 * Converts the raw DB records into the "Rollup" format expected by the dashboard.
 */
export function parseSessionEscalations(
  dbRecords: SessionEscalationRecord[],
  nowMs: number = Date.now()
): SessionEscalationRollup[] {
  return dbRecords.map((rec) => {
    const createdSec = rec.createdAt;
    const ageSec = Math.floor((nowMs / 1000) - createdSec);

    // In a real system, 'refs' might be parsed from metadata or looked up separately.
    // For now, we construct a basic ref if workItemId exists.
    const refs: Array<{ type: string; label: string; target: string; preview?: string }> = [];
    if (rec.workItemId) {
      refs.push({
        type: 'work_item',
        label: 'Work Item',
        target: rec.workItemId,
      });
    }

    return {
      escalationId: rec.escalationId,
      sessionKey: rec.sessionKey,
      workItemId: rec.workItemId ?? undefined,
      createdAt: new Date(createdSec * 1000).toISOString(),
      ageSec,
      headline: rec.headline,
      requestedDecision: rec.requestedDecision as any,
      status: rec.status,
      resolutionSummary: rec.resolutionSummary ?? undefined,
      resolvedAt: rec.resolvedAt ? new Date(rec.resolvedAt * 1000).toISOString() : undefined,
      refs,
    };
  });
}
``### 5. Update SessionStore
Sync paused work items to the GraphD escalation table.

**File:** `packages/harness-daemon/src/harness/session_store.ts`

typescript
// ... imports

export class SessionStore {
  // ... existing fields

  // ... existing methods

  upsertPausedWorkItem(input: {
    workId: string;
    agentType: string;
    objective?: string;
    reason: string;
    escalationId?: string;
    status?: PausedWorkItemStatus;
    timestamp?: number;
  }): PausedWorkItemState {
    const now = input.timestamp ?? Date.now();
    const existing = this.pausedWorkItems.get(input.workId);
    
    // Determine if this is a new escalation or an update
    // We use workId as the escalationId for simplicity here, or derive one
    const escalationId = input.escalationId ?? `esc_${input.workId}`;
    const isNew = !existing;

    // ... existing PausedWorkItemState logic ...

    this.pausedWorkItems.set(input.workId, next);
    this.persistPausedWorkItems();

    // --- NEW: Sync to GraphD Escalations ---
    if (this.isGraphDReady() && this.graphd) {
      try {
        // Map PausedWorkItemState to SessionEscalationRecord
        this.graphd.escalationUpsert({
          sessionKey: this.sessionKey,
          escalationId: escalationId,
          workItemId: input.workId,
          headline: input.objective || input.reason,
          requestedDecision: 'clarify', // Default for generic pauses
          status: next.status === 'resolved' ? 'resolved' : (next.status === 'cancelled' ? 'cancelled' : 'pending'),
          resolutionSummary: next.resolutionSummary,
          createdAt: next.createdAt / 1000,
          resolvedAt: next.resolvedAt ? next.resolvedAt / 1000 : undefined,
        });
      } catch (error) {
        this.logger.warning('Failed to sync escalation to GraphD', {
          sessionKey: this.sessionKey,
          workId: input.workId,
          error: String(error),
        });
      }
    }

    return next;
  }

  // ... existing methods
}
``### 6. Update Control Plane Routes (Usage Example)
Although the file was truncated, this demonstrates how `resolveSessionEscalation` in `control_plane_routes.ts` utilizes the new GraphD manager.

typescript
// Inside ControlPlaneRoutes class or handler logic

async function resolveEscalationHandler(
  ctx: ControlPlaneContext,
  sessionKey: string,
  escalationId: string,
  resolution: EscalationResolutionInput
): Promise<{ success: boolean; error?: string }> {
  if (!ctx.graphd) {
    return { success: false, error: 'GraphD not available' };
  }

  // 1. Update the DB record
  const result = ctx.graphd.escalationResolve(escalationId, resolution);
  
  if (!result.success) {
    return result;
  }

  // 2. Update in-memory SessionStore state if available
  // (This assumes escalationId maps to a workId, which depends on your ID strategy)
  if (escalationId.startsWith('esc_')) {
    const workId = escalationId.replace('esc_', '');
    // You would need a reference to the session store here to call resolvePausedWorkItem
    // sessionStore.resolvePausedWorkItem(workId, resolution.resolutionSummary);
  }

  return { success: true };
}

