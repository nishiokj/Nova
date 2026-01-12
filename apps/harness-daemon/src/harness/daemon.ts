/**
 * Harness daemon entrypoint for JSONL/TCP bridge.
 */

import { pathToFileURL } from 'url';
import { createHarnessFromEnv, type AgentHarness } from './harness.js';
import { BusServer } from 'comms-bus';
import { BridgeGateway } from './bridge_gateway.js';
import { createAuthServiceFromEnv, type AuthService } from './auth_service.js';

export interface HarnessDaemonOptions {
  host?: string;
  port?: number;
  workingDir?: string;
  configPath?: string;
}

export class HarnessDaemon {
  private readonly host: string;
  private readonly port: number;
  private readonly workingDir: string;
  private readonly configPath?: string;
  private harness: AgentHarness | null = null;
  private bus: BusServer | null = null;
  private gateway: BridgeGateway | null = null;
  private authService: AuthService | null = null;

  constructor(options: HarnessDaemonOptions = {}) {
    this.host = options.host ?? process.env.EVENT_BUS_HOST ?? '127.0.0.1';
    const rawPort = options.port ?? Number(process.env.EVENT_BUS_PORT ?? '9555');
    this.port = Number.isFinite(rawPort) ? rawPort : 9555;
    this.workingDir = options.workingDir ?? process.env.HARNESS_WORKING_DIR ?? process.cwd();
    this.configPath = options.configPath ?? process.env.HARNESS_CONFIG_PATH;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (!this.harness) {
      this.harness = createHarnessFromEnv(this.workingDir, this.configPath);
      await this.harness.start();
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
        onDisconnect: (connectionId) => this.gateway?.handleDisconnect(connectionId),
      });
      this.gateway = new BridgeGateway(this.bus, this.harness, this.workingDir, this.authService);
    }

    return this.bus.start();
  }

  async stop(): Promise<void> {
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
