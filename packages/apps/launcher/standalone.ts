#!/usr/bin/env bun
/**
 * Standalone entry - bundles daemon + tui into single process
 * For distribution builds only.
 */

// Force color support for markdown rendering (chalk detection fails under Bun)
// Must be set before any color-dependent modules are imported
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? '3';

import { parseArgs } from 'util';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/**
 * Minimal user config template.
 * API keys are stored in GraphD (use `nova providers set <provider> <key>`).
 * All other settings come from config/defaults.json
 */
const MINIMAL_USER_CONFIG = {
  $comment: "User preferences. API keys are stored securely in GraphD - use 'nova providers set <provider> <key>' to configure them.",
  models: {
    default: ""
  }
};

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
  console.log(`nova ${process.env.NOVA_VERSION ?? 'dev'}`);
  process.exit(0);
}

if (values.help) {
  console.log(`Usage: nova [options] [prompt]

Options:
  --daemon-only  Run daemon in foreground without TUI
  -v, --version  Print version
  -h, --help     Show this help

Commands:
  nova                    Start interactive TUI with daemon
  nova --daemon-only      Run daemon in foreground mode
  nova "prompt"           Start with initial prompt

Configuration:
  Config file: ~/.nova/config.json
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
  const configDir = path.join(homedir(), '.nova');
  const configPath = path.join(configDir, 'config.json');

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
    console.log(`[nova] Created config directory: ${configDir}`);
  }

  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(MINIMAL_USER_CONFIG, null, 2) + '\n', 'utf-8');
    console.log(`[nova] Created user config: ${configPath}`);
    console.log('[nova] To add API keys, use: nova providers set <provider> <key>');
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
    const { runHarnessDaemon } = await import('../../infra/harness-daemon/src/harness/daemon.js');
    await runHarnessDaemon();
  } else {
    // Start daemon in-process, then TUI
    const { HarnessDaemon } = await import('../../infra/harness-daemon/src/harness/daemon.js');

    const daemon = new HarnessDaemon({
      configPath: configPath ?? undefined,
      idleTimeoutMs: 0, // Disable idle timeout in standalone mode
    });

    // Run daemon startup
    const address = await daemon.start();
    console.log(`[nova] Daemon started on ${address.host}:${address.port}`);

    // Small delay for daemon to fully initialize
    await new Promise(r => setTimeout(r, 200));

    // Start TUI (this blocks until exit)
    const tuiEntry = '../tui/main.js';
    const { startTui } = await import(tuiEntry);

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
  console.error('[nova] Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
