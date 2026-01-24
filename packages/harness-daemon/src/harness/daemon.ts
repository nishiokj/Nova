/**
 * Harness daemon entrypoint for JSONL/TCP bridge.
 *
 * Supports:
 * - TCP/JSONL bus for TUI connections
 * - HTTP webhooks for external integrations (Telegram, etc.)
 */

import { pathToFileURL } from 'url';
import { createHarnessFromEnv, type AgentHarness } from './harness.js';
import { BusServer } from 'comms-bus';
import { BridgeGateway } from './bridge_gateway.js';
import { createAuthServiceFromConfig, type AuthService } from './auth_service.js';
import { translateAgentEvent } from './event_translator.js';
import { WebhookServer, TelegramConnector, registerTelegramWebhook } from '../connectors/index.js';

export interface HarnessDaemonOptions {
  host?: string;
  port?: number;
  workingDir?: string;
  configPath?: string;
  /** Idle timeout in ms before daemon shuts down when no clients connected. Set to 0 to disable. */
  idleTimeoutMs?: number;
  /** Dangerous mode - bypasses all permission checks. Use with extreme caution. */
  dangerousMode?: boolean;
  /** Webhook server port (default: busPort + 1) */
  webhookPort?: number;
  /** Webhook server host (default: same as bus host) */
  webhookHost?: string;
}

// Default idle timeout: 5 seconds
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

export class HarnessDaemon {
  private readonly host: string;
  private readonly port: number;
  private readonly webhookPort: number;
  private readonly webhookHost: string;
  private readonly workingDir: string;
  private readonly configPath?: string;
  private readonly idleTimeoutMs: number;
  private readonly dangerousMode: boolean;
  private harness: AgentHarness | null = null;
  private bus: BusServer | null = null;
  private gateway: BridgeGateway | null = null;
  private authService: AuthService | null = null;
  private authConfig: { enabled: boolean; host: string; port: number; google_client_id?: string; google_redirect_uri?: string; master_key_path?: string; graphd_db_path?: string } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownRequested = false;

  // Webhook infrastructure
  private webhookServer: WebhookServer | null = null;
  private telegramConnectors: Map<string, TelegramConnector> = new Map();

  constructor(options: HarnessDaemonOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    const rawPort = options.port ?? 9555;
    this.port = Number.isFinite(rawPort) ? rawPort : 9555;
    this.webhookPort = options.webhookPort ?? this.port + 1;
    this.webhookHost = options.webhookHost ?? this.host;
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
      this.gateway = new BridgeGateway(this.bus, this.harness, this.workingDir, this.authService, this);
    }

    return this.bus.start();
  }

  async stop(): Promise<void> {
    this.cancelIdleTimer();
    this.shutdownRequested = true;

    // Stop webhook server first
    if (this.webhookServer) {
      await this.webhookServer.stop();
      this.webhookServer = null;
    }

    // Clear telegram connectors
    this.telegramConnectors.clear();

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
   * Set dangerous mode dynamically without restarting the daemon.
   * This allows a new TUI connection to request dangerous mode without
   * disconnecting existing TUIs.
   */
  setDangerousMode(enabled: boolean): void {
    const permissionChecker = this.harness?.getPermissionChecker?.();
    if (permissionChecker) {
      permissionChecker.setDangerousMode(enabled);
      const status = enabled ? 'enabled' : 'disabled';
      console.log(`[harness-daemon] Dangerous mode ${status} (dynamic)`);
    }
  }

  // =========================================================================
  // Webhook Server Methods
  // =========================================================================

  /**
   * Start the webhook HTTP server for external integrations.
   * Call this after start() if you want to enable webhooks.
   */
  async startWebhookServer(): Promise<{ host: string; port: number }> {
    if (this.webhookServer) {
      return { host: this.webhookHost, port: this.webhookPort };
    }

    this.webhookServer = new WebhookServer({
      port: this.webhookPort,
      host: this.webhookHost,
    });

    // Register any existing Telegram connectors
    for (const connector of this.telegramConnectors.values()) {
      registerTelegramWebhook(this.webhookServer, connector);
    }

    const address = await this.webhookServer.start();
    console.log(`[harness-daemon] Webhook server listening on ${address.host}:${address.port}`);
    return address;
  }

  /**
   * Stop the webhook server.
   */
  async stopWebhookServer(): Promise<void> {
    if (this.webhookServer) {
      await this.webhookServer.stop();
      this.webhookServer = null;
      console.log('[harness-daemon] Webhook server stopped');
    }
  }

  /**
   * Get the webhook server address.
   */
  getWebhookAddress(): { host: string; port: number } | null {
    if (!this.webhookServer) {
      return null;
    }
    return { host: this.webhookHost, port: this.webhookPort };
  }

  // =========================================================================
  // Telegram Integration Methods
  // =========================================================================

  /**
   * Register a Telegram bot for webhook processing.
   *
   * @param botToken - The bot token from @BotFather
   * @param options - Optional configuration
   * @returns The registered connector
   *
   * @example
   * ```ts
   * const daemon = new HarnessDaemon();
   * await daemon.start();
   * await daemon.startWebhookServer();
   *
   * const connector = await daemon.registerTelegramBot(process.env.TELEGRAM_BOT_TOKEN!);
   *
   * // Set webhook URL with Telegram
   * await connector.setWebhook('https://your-domain.com/webhook/telegram/' + connector.getBotId());
   * ```
   */
  registerTelegramBot(
    botToken: string,
    options?: { secretToken?: string }
  ): TelegramConnector {
    if (!this.harness) {
      throw new Error('Daemon not started. Call start() first.');
    }

    const connector = new TelegramConnector({
      botToken,
      workingDir: this.workingDir,
    });

    // Connect to harness
    connector.setHarness(this.harness);

    // Store by bot ID
    const botId = connector.getBotId();
    this.telegramConnectors.set(botId, connector);

    // Register webhook route if server is running
    if (this.webhookServer) {
      registerTelegramWebhook(this.webhookServer, connector, options);
    }

    console.log(`[harness-daemon] Registered Telegram bot: ${botId}`);
    return connector;
  }

  /**
   * Unregister a Telegram bot.
   */
  unregisterTelegramBot(botIdOrToken: string): boolean {
    // Extract bot ID if full token provided
    const botId = botIdOrToken.includes(':') ? botIdOrToken.split(':')[0] : botIdOrToken;

    const connector = this.telegramConnectors.get(botId);
    if (!connector) {
      return false;
    }

    this.telegramConnectors.delete(botId);
    console.log(`[harness-daemon] Unregistered Telegram bot: ${botId}`);
    return true;
  }

  /**
   * Get a registered Telegram connector by bot ID.
   */
  getTelegramConnector(botId: string): TelegramConnector | undefined {
    return this.telegramConnectors.get(botId);
  }

  /**
   * List all registered Telegram bot IDs.
   */
  listTelegramBots(): string[] {
    return Array.from(this.telegramConnectors.keys());
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
interface ParsedDaemonArgs extends HarnessDaemonOptions {
  telegramBotToken?: string;
  enableWebhooks?: boolean;
}

function parseDaemonArgs(): ParsedDaemonArgs {
  const args = process.argv.slice(2);
  const options: ParsedDaemonArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dangerous') {
      options.dangerousMode = true;
      console.log('[harness-daemon] WARNING: Running in dangerous mode - all permission checks disabled');
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
    } else if (arg === '--webhook-port' && i + 1 < args.length) {
      options.webhookPort = parseInt(args[++i], 10);
    } else if (arg === '--telegram-bot' && i + 1 < args.length) {
      options.telegramBotToken = args[++i];
      options.enableWebhooks = true;
    } else if (arg === '--enable-webhooks') {
      options.enableWebhooks = true;
    }
  }

  // Also check environment variables
  if (!options.telegramBotToken && process.env.TELEGRAM_BOT_TOKEN) {
    options.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    options.enableWebhooks = true;
  }

  return options;
}

export async function runHarnessDaemon(): Promise<void> {
  const options = parseDaemonArgs();
  const daemon = new HarnessDaemon(options);
  const address = await daemon.start();
  console.log(`[harness-daemon] bus listening on ${address.host}:${address.port}`);

  // Start webhook server if enabled or if Telegram bot is configured
  if (options.enableWebhooks) {
    const webhookAddress = await daemon.startWebhookServer();
    console.log(`[harness-daemon] webhook server listening on ${webhookAddress.host}:${webhookAddress.port}`);

    // Register Telegram bot if token provided
    if (options.telegramBotToken) {
      const connector = daemon.registerTelegramBot(options.telegramBotToken);
      console.log(`[harness-daemon] Telegram bot registered: ${connector.getBotId()}`);
      console.log(`[harness-daemon] Webhook URL: http://${webhookAddress.host}:${webhookAddress.port}/webhook/telegram/${connector.getBotId()}`);
    }
  }

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
