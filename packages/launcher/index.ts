#!/usr/bin/env bun
/**
 * Rex Launcher - Unified entry point for rex CLI
 *
 * This launcher:
 * 1. Checks if daemon is running on the well-known port
 * 2. Starts daemon if not running (in background)
 * 3. Starts TUI connecting to daemon
 */

import { spawn, type Subprocess } from 'bun';
import { createConnection } from 'net';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

/**
 * Minimal user config template.
 * This is created on first run - users only need to add their API keys.
 * All other settings come from config/defaults.json
 */
const MINIMAL_USER_CONFIG = {
  $comment: "Add your API keys below. All other settings are inherited from defaults.",
  providers: {
    anthropic: "",
    openai: "",
    cerebras: "",
    together: "",
    groq: "",
    fireworks: "",
    gemini: "",
    replicate: "",
    "z.ai-coder": ""
  },
  models: {
    available: [],
    default: ""
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const DAEMON_HOST = process.env.EVENT_BUS_HOST ?? '127.0.0.1';
const DAEMON_PORT = Number(process.env.EVENT_BUS_PORT ?? '9555');
const DAEMON_STARTUP_TIMEOUT = 5000; // 5 seconds to wait for daemon

// Paths - resolve relative to launcher location
const getProjectRoot = () => {
  // In development: packages/launcher/index.ts -> project root is ../..
  // In dist: packages/launcher/dist/index.js -> project root is ../../..
  if (__dirname.includes('/dist')) {
    return path.resolve(__dirname, '..', '..', '..');
  }
  return path.resolve(__dirname, '..', '..');
};

const getDaemonPath = () => {
  const root = getProjectRoot();
  // Check for dist first, then src
  const distPath = path.join(root, 'packages', 'harness-daemon', 'dist', 'index.js');
  const srcPath = path.join(root, 'packages', 'harness-daemon', 'src', 'index.ts');
  try {
    Bun.file(distPath);
    return distPath;
  } catch {
    return srcPath;
  }
};

const getTuiPath = () => {
  const root = getProjectRoot();
  // Always use source - bun bundler corrupts UTF-8 box-drawing characters
  const srcPath = path.join(root, 'packages', 'tui', 'index.tsx');
  return srcPath;
};

const PROJECT_CONFIG_NAME = path.join('config', 'harness_config.json');

const getConfigDir = () => path.join(homedir(), '.rex');
const getUserConfigPath = () => path.join(getConfigDir(), 'config.json');

const ensureUserConfig = (): string => {
  const userConfigDir = getConfigDir();
  const userConfig = getUserConfigPath();

  // Try to create minimal user config
  try {
    // Create directory if needed
    if (!existsSync(userConfigDir)) {
      mkdirSync(userConfigDir, { recursive: true });
      console.log(`[rex] Created config directory: ${userConfigDir}`);
    }

    // Write minimal user config (just providers - all else from defaults)
    writeFileSync(userConfig, JSON.stringify(MINIMAL_USER_CONFIG, null, 2) + '\n');
    console.log(`[rex] Created user config: ${userConfig}`);
    console.log('[rex] Add your API keys to the providers section. All other settings are inherited from defaults.');
    return userConfig;
  } catch (err) {
    console.warn(`[rex] Could not create user config: ${err}`);
  }

  return userConfig;
};

const findProjectConfigPath = (startDir: string): string | null => {
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
};

const resolveConfigPath = (): string | undefined => {
  if (process.env.HARNESS_CONFIG_PATH) {
    return process.env.HARNESS_CONFIG_PATH;
  }

  ensureUserConfig();
  const projectConfig = findProjectConfigPath(process.cwd());
  return projectConfig ?? undefined;
};

/**
 * Check if daemon is running by attempting a TCP connection
 */
async function isDaemonRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: DAEMON_HOST, port: DAEMON_PORT }, () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    // Timeout after 500ms
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
  });
}

/**
 * Start the daemon in background
 */
async function startDaemon(): Promise<Subprocess> {
  const daemonPath = getDaemonPath();
  const configPath = resolveConfigPath();

  console.log('[rex] Starting daemon...');

  const daemon = spawn({
    cmd: ['bun', 'run', daemonPath],
    env: {
      ...process.env,
      ...(configPath ? { HARNESS_CONFIG_PATH: configPath } : {}),
      EVENT_BUS_HOST: DAEMON_HOST,
      EVENT_BUS_PORT: String(DAEMON_PORT),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });

  // Wait for daemon to be ready
  const startTime = Date.now();
  while (Date.now() - startTime < DAEMON_STARTUP_TIMEOUT) {
    if (await isDaemonRunning()) {
      console.log('[rex] Daemon ready');
      return daemon;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // Check if daemon failed
  if (daemon.exitCode !== null) {
    const stderr = await new Response(daemon.stderr).text();
    throw new Error(`Daemon failed to start: ${stderr}`);
  }

  throw new Error('Daemon startup timeout');
}

/**
 * Start the TUI
 */
async function startTui(): Promise<void> {
  const tuiPath = getTuiPath();

  const tui = spawn({
    cmd: ['bun', 'run', tuiPath, ...process.argv.slice(2)],
    env: {
      ...process.env,
      EVENT_BUS_HOST: DAEMON_HOST,
      EVENT_BUS_PORT: String(DAEMON_PORT),
    },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  // Wait for TUI to exit
  await tui.exited;
  process.exit(tui.exitCode ?? 0);
}

/**
 * Kill any running daemon gracefully
 */
async function killExistingDaemon(): Promise<void> {
  const { execSync } = await import('child_process');
  try {
    execSync('pkill -TERM -f harness-daemon', { stdio: 'ignore' });
    // Wait for graceful shutdown
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      if (!(await isDaemonRunning())) {
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    console.warn('[rex] Daemon did not shut down in time');
  } catch {
    // No daemon running or pkill failed - that's fine
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Handle --restart flag: kill existing daemon before proceeding
  if (process.argv.includes('--restart')) {
    console.log('[rex] Restarting daemon...');
    await killExistingDaemon();
  }

  // Check for --daemon-only flag
  if (process.argv.includes('--daemon-only')) {
    const daemonPath = getDaemonPath();
    const configPath = resolveConfigPath();

    // Run daemon in foreground
    const daemon = spawn({
      cmd: ['bun', 'run', daemonPath],
      env: {
        ...process.env,
        ...(configPath ? { HARNESS_CONFIG_PATH: configPath } : {}),
        EVENT_BUS_HOST: DAEMON_HOST,
        EVENT_BUS_PORT: String(DAEMON_PORT),
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });

    await daemon.exited;
    process.exit(daemon.exitCode ?? 0);
    return;
  }

  // Check if daemon is already running
  const running = await isDaemonRunning();

  if (!running) {
    try {
      await startDaemon();
    } catch (error) {
      console.error('[rex] Failed to start daemon:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    console.log('[rex] Daemon already running');
  }

  // Start TUI
  await startTui();
}

main().catch((error) => {
  console.error('[rex] Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
