#!/usr/bin/env bun
/**
 * Standalone entry - bundles daemon + tui into single process
 * For distribution builds only.
 */

import { parseArgs } from 'util';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { DEFAULT_CONFIG } from './default-config.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'daemon-only': { type: 'boolean', default: false },
    'version': { type: 'boolean', short: 'v', default: false },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.version) {
  // Embedded at build time
  console.log(`rex ${process.env.REX_VERSION ?? 'dev'}`);
  process.exit(0);
}

if (values.help) {
  console.log(`Usage: rex [options] [prompt]

Options:
  --daemon-only  Run daemon in foreground without TUI
  -v, --version  Print version
  -h, --help     Show this help

Commands:
  rex                    Start interactive TUI with daemon
  rex --daemon-only      Run daemon in foreground mode
  rex "prompt"           Start with initial prompt

Configuration:
  Config file: ~/.rex/config.json
  On first run, a default config is created.
  Edit this file to configure LLM providers and API keys.
`);
  process.exit(0);
}

/**
 * Ensure config directory and file exist
 */
const PROJECT_CONFIG_NAME = path.join('config', 'harness_config.json');

function ensureConfig(): string {
  const configDir = path.join(homedir(), '.rex');
  const configPath = path.join(configDir, 'config.json');

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
    console.log(`[rex] Created config directory: ${configDir}`);
  }

  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    console.log(`[rex] Created default config: ${configPath}`);
    console.log('[rex] Edit this file to configure your LLM providers and API keys');
  }

  return configPath;
}

function findProjectConfigPath(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, PROJECT_CONFIG_NAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function main(): Promise<void> {
  ensureConfig();
  const configPath = findProjectConfigPath(process.cwd());

  // Set environment for harness
  if (configPath) {
    process.env.HARNESS_CONFIG_PATH = configPath;
  }
  process.env.EVENT_BUS_HOST = process.env.EVENT_BUS_HOST ?? '127.0.0.1';
  process.env.EVENT_BUS_PORT = process.env.EVENT_BUS_PORT ?? '9555';

  // Import daemon and tui directly - bundler will inline them
  if (values['daemon-only']) {
    const { runHarnessDaemon } = await import('../harness-daemon/src/harness/daemon.js');
    await runHarnessDaemon();
  } else {
    // Start daemon in-process, then TUI
    const { HarnessDaemon } = await import('../harness-daemon/src/harness/daemon.js');

    const daemon = new HarnessDaemon({
      configPath: configPath ?? undefined,
      idleTimeoutMs: 0, // Disable idle timeout in standalone mode
    });

    // Run daemon startup
    const address = await daemon.start();
    console.log(`[rex] Daemon started on ${address.host}:${address.port}`);

    // Small delay for daemon to fully initialize
    await new Promise(r => setTimeout(r, 200));

    // Start TUI (this blocks until exit)
    const { startTui } = await import('../tui/main.js');

    // Pass positional arguments as initial prompt
    const initialPrompt = positionals.length > 0 ? positionals.join(' ') : undefined;

    try {
      await startTui({ initialPrompt });
    } finally {
      // Clean shutdown
      await daemon.stop();
    }

    process.exit(0);
  }
}

main().catch((error) => {
  console.error('[rex] Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
