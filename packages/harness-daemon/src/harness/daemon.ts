/**
 * Harness daemon entrypoint for JSONL/TCP bridge.
 */

import { pathToFileURL } from 'url';
import { createHarnessFromEnv, type AgentHarness } from './harness.js';
import { BusServer } from 'comms-bus';
import { BridgeGateway } from './bridge_gateway.js';
import { createAuthServiceFromEnv, type AuthService } from './auth_service.js';
import { setConfigProviders, getConfigProviders } from './config_loader.js';

export interface HarnessDaemonOptions {
  host?: string;
  port?: number;
  workingDir?: string;
  configPath?: string;
  /** Idle timeout in ms before daemon shuts down when no clients connected. Set to 0 to disable. */
  idleTimeoutMs?: number;
}

// Default idle timeout: 5 seconds
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;

export class HarnessDaemon {
  private readonly host: string;
  private readonly port: number;
  private readonly workingDir: string;
  private readonly configPath?: string;
  private readonly idleTimeoutMs: number;
  private harness: AgentHarness | null = null;
  private bus: BusServer | null = null;
  private gateway: BridgeGateway | null = null;
  private authService: AuthService | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownRequested = false;

  constructor(options: HarnessDaemonOptions = {}) {
    this.host = options.host ?? process.env.EVENT_BUS_HOST ?? '127.0.0.1';
    const rawPort = options.port ?? Number(process.env.EVENT_BUS_PORT ?? '9555');
    this.port = Number.isFinite(rawPort) ? rawPort : 9555;
    this.workingDir = options.workingDir ?? process.env.HARNESS_WORKING_DIR ?? process.cwd();
    this.configPath = options.configPath ?? process.env.HARNESS_CONFIG_PATH;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
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
      // Load GraphD provider keys BEFORE creating harness (so they're available during config resolution)
      await this.preloadGraphDProviders();

      this.harness = createHarnessFromEnv(this.workingDir, this.configPath);
      await this.harness.start();

      // Update the running adapter with GraphD keys (harness was created with them in config cache)
      const config = this.harness.getConfig();
      if (config.graphd.enabled && config.graphd.dbPath) {
        const { LocalProviderManager } = await import('./local_providers.js');
        const providerManager = new LocalProviderManager(config.graphd.dbPath);
        const providers = providerManager.getProviders();

        // Update adapter with each provider key
        for (const [provider, apiKey] of Object.entries(providers)) {
          if (apiKey) {
            const openaiCompatProviders = new Set(['cerebras', 'together', 'groq', 'fireworks']);
            const canonicalProvider = openaiCompatProviders.has(provider) ? 'openai-compat' : provider;
            console.log(`[harness-daemon] Updating adapter: ${provider} -> ${canonicalProvider}, key: ${apiKey.slice(0, 8)}...`);
            this.harness.updateApiKey(canonicalProvider as import('types').LLMProvider, apiKey);
          }
        }
        providerManager.close();
      }
    }

    // Initialize auth service (optional - depends on env vars)
    if (!this.authService) {
      this.authService = createAuthServiceFromEnv();
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
   * Pre-load GraphD provider keys into the config cache BEFORE creating the harness.
   * This ensures API keys are available during agent config resolution.
   */
  private async preloadGraphDProviders(): Promise<void> {
    const { existsSync } = await import('fs');
    const { resolve } = await import('path');
    const { homedir } = await import('os');
    const { loadConfigFile } = await import('./config_loader.js');

    // Use the same config loading logic as the harness
    const loaded = loadConfigFile(this.configPath);
    if (!loaded) {
      console.log(`[harness-daemon] No config file found, skipping GraphD preload`);
      return;
    }

    const { config, configDir } = loaded;

    // Check if graphd is enabled and has a db_path
    const graphdEnabled = config.graphd?.enabled ?? false;
    const dbPathRaw = config.graphd?.db_path ?? '~/.graphd/graphd.db';

    if (!graphdEnabled) {
      console.log(`[harness-daemon] GraphD disabled in config, skipping preload`);
      return;
    }

    // Resolve ~ to home directory, or resolve relative to config dir
    const dbPath = dbPathRaw.startsWith('~')
      ? resolve(homedir(), dbPathRaw.slice(2))
      : resolve(configDir, dbPathRaw);

    if (!existsSync(dbPath)) {
      console.log(`[harness-daemon] GraphD database not found at ${dbPath}, skipping preload`);
      return;
    }

    try {
      console.log(`[harness-daemon] Pre-loading provider keys from GraphD at ${dbPath}`);
      const { LocalProviderManager } = await import('./local_providers.js');
      const providerManager = new LocalProviderManager(dbPath);
      const providers = providerManager.getProviders();

      if (Object.keys(providers).length > 0) {
        // Merge into config cache (GraphD takes precedence)
        const existingProviders = getConfigProviders();
        const mergedProviders = { ...existingProviders, ...providers };
        setConfigProviders(mergedProviders);
        console.log(`[harness-daemon] Pre-loaded ${Object.keys(providers).length} provider key(s) from GraphD`);
      } else {
        console.log(`[harness-daemon] No provider keys found in GraphD during preload`);
      }

      providerManager.close();
    } catch (err) {
      console.error(`[harness-daemon] Failed to preload GraphD providers:`, err);
    }
  }
}

export async function runHarnessDaemon(): Promise<void> {
  const daemon = new HarnessDaemon();
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
