/**
 * Harness daemon entrypoint for WebSocket bridge.
 *
 * Supports:
 * - WebSocket bus for client connections (TUI, external integrations via harness-client)
 */

import path from 'path';
import { existsSync } from 'fs';
import { createHarnessFromEnv, type AgentHarness } from './harness.js';
import { BusServer } from 'comms-bus';
import { BridgeGateway } from './bridge_gateway.js';
import { createAuthServiceFromConfig, type AuthService } from './auth_service.js';
import { translateAgentEvent } from './event_translator.js';

export interface HarnessDaemonOptions {
  host?: string;
  port?: number;
  workingDir?: string;
  configPath?: string;
  /** Idle timeout in ms before daemon shuts down when no clients connected. Set to 0 to disable. */
  idleTimeoutMs?: number;
  /** Dangerous mode - bypasses all permission checks. Use with extreme caution. */
  dangerousMode?: boolean;
  /** Receives daemon lifecycle/status messages. Defaults to stderr for CLI mode. */
  statusWriter?: (message: string) => void;
}

// Default idle timeout: 5 seconds
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

function detectProjectRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'config', 'harness_config.json');
    if (existsSync(candidate)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return startDir;
    }
    dir = parent;
  }
}

export class HarnessDaemon {
  private readonly host: string;
  private readonly port: number;
  private readonly workingDir: string;
  private readonly configPath?: string;
  private readonly idleTimeoutMs: number;
  private readonly dangerousMode: boolean;
  private readonly statusWriter: (message: string) => void;
  private harness: AgentHarness | null = null;
  private bus: BusServer | null = null;
  private gateway: BridgeGateway | null = null;
  private authService: AuthService | null = null;
  private authConfig: { enabled: boolean; host: string; port: number; google_client_id?: string; google_redirect_uri?: string; master_key_path?: string; graphd_db_path?: string } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownRequested = false;

  constructor(options: HarnessDaemonOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    const rawPort = options.port ?? 9555;
    this.port = Number.isFinite(rawPort) ? rawPort : 9555;
    this.workingDir = options.workingDir ?? detectProjectRoot(process.cwd());
    this.configPath = options.configPath;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.dangerousMode = options.dangerousMode ?? false;
    this.statusWriter = options.statusWriter ?? ((message) => process.stderr.write(message));
  }

  private writeStatus(message: string): void {
    this.statusWriter(message.endsWith('\n') ? message : `${message}\n`);
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
    this.writeStatus(`[harness-daemon] No clients connected, will shutdown in ${this.idleTimeoutMs / 1000}s`);

    this.idleTimer = setTimeout(() => {
      if (this.bus?.getConnectionCount() === 0) {
        this.writeStatus('[harness-daemon] Idle timeout reached, shutting down');
        this.shutdownRequested = true;
        void this.stop().then(() => process.exit(0));
      }
    }, this.idleTimeoutMs);
  }

  private handleConnect(connectionId: string): void {
    this.writeStatus(`[harness-daemon] Client connected: ${connectionId}`);
    this.cancelIdleTimer();
  }

  private handleDisconnect(connectionId: string): void {
    this.gateway?.handleDisconnect(connectionId);

    const remaining = this.bus?.getConnectionCount() ?? 0;
    this.writeStatus(`[harness-daemon] Client disconnected: ${connectionId}, remaining: ${remaining}`);

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
      this.authConfig = this.harness.getAuthConfig() ?? null;
    }

    // Initialize auth service from config (optional - depends on config.auth section)
    if (!this.authService && this.authConfig) {
      this.authService = createAuthServiceFromConfig(this.authConfig);
      if (this.authService) {
        this.writeStatus('[harness-daemon] Auth service initialized');
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

    return this.bus.start();
  }

  async stop(): Promise<void> {
    this.cancelIdleTimer();
    this.shutdownRequested = true;

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
    this.writeStatus('[harness-daemon] setDangerousMode() is deprecated - dangerous mode is now per-session. Use set_dangerous_mode command via bridge.');
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
      process.stderr.write('[harness-daemon] WARNING: Running in dangerous mode - all permission checks disabled\n');
    } else if (arg === '--port' && i + 1 < args.length) {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '--host' && i + 1 < args.length) {
      options.host = args[++i];
    } else if (arg === '--config' && i + 1 < args.length) {
      options.configPath = args[++i];
    } else if (arg === '--working-dir' && i + 1 < args.length) {
      options.workingDir = args[++i];
    } else if (arg === '--idle-timeout' && i + 1 < args.length) {
      options.idleTimeoutMs = parseInt(args[++i], 10);
    }
  }

  return options;
}

export async function runHarnessDaemon(): Promise<void> {
  const options = parseDaemonArgs();
  const daemon = new HarnessDaemon(options);
  const address = await daemon.start();
  process.stderr.write(`[harness-daemon] bus listening on ${address.host}:${address.port}\n`);

  const shutdown = async (signal: string) => {
    process.stderr.write(`[harness-daemon] received ${signal}, shutting down\n`);
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.main) {
  runHarnessDaemon().catch((error: unknown) => {
    process.stderr.write(`[harness-daemon] fatal error: ${String(error)}\n`);
    process.exit(1);
  });
}
