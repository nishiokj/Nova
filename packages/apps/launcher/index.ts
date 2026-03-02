#!/usr/bin/env bun
/**
 * Nova Launcher - Unified entry point for nova CLI
 *
 * This launcher:
 * 1. Checks if daemon is running on the well-known port
 * 2. Starts daemon if not running (in background)
 * 3. Starts TUI connecting to daemon
 */

import { spawn, type Subprocess } from 'bun';
import { createConnection } from 'net';
import { mkdirSync, existsSync, writeFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

/**
 * Minimal user config template.
 * This is created on first run for user preferences.
 * API keys are stored in GraphD (use `nova providers set <provider> <key>`).
 * All other settings come from config/defaults.json
 */
const MINIMAL_USER_CONFIG = {
  $comment: "User preferences. API keys are stored securely in GraphD - use 'nova providers set <provider> <key>' to configure them.",
  models: {
    default: ""
  },
  agents: {}
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const DAEMON_HOST = process.env.EVENT_BUS_HOST ?? '127.0.0.1';
const DAEMON_PORT = Number(process.env.EVENT_BUS_PORT ?? '9555');
const DAEMON_STARTUP_TIMEOUT = 5000; // 5 seconds to wait for daemon

// Paths - resolve relative to launcher location
const getProjectRoot = () => {
  // In development: packages/apps/launcher/index.ts -> project root is ../../..
  // In dist: packages/apps/launcher/dist/index.js -> project root is ../../../..
  if (__dirname.includes('/dist')) {
    return path.resolve(__dirname, '..', '..', '..', '..');
  }
  return path.resolve(__dirname, '..', '..', '..');
};

const getDaemonPath = () => {
  const root = getProjectRoot();
  // Check for dist first, then src
  const distPath = path.join(root, 'packages', 'infra', 'harness-daemon', 'dist', 'index.js');
  const srcPath = path.join(root, 'packages', 'infra', 'harness-daemon', 'src', 'index.ts');
  return existsSync(distPath) ? distPath : srcPath;
};

const getHarnessCliPath = () => {
  const root = getProjectRoot();
  return path.join(root, 'packages', 'infra', 'harness-daemon', 'bin', 'nova.js');
};

const getTuiPath = () => {
  const root = getProjectRoot();
  const srcPath = path.join(root, 'packages', 'apps', 'tui', 'index.tsx');
  const distPath = path.join(root, 'packages', 'apps', 'tui', 'dist', 'index.js');
  // Prefer source in workspace development, fallback to dist when running from packaged artifacts.
  return existsSync(srcPath) ? srcPath : distPath;
};

const PROJECT_CONFIG_NAME = path.join('config', 'harness_config.json');

const getConfigDir = () => path.join(homedir(), '.nova');
const getUserConfigPath = () => path.join(getConfigDir(), 'config.json');

const ensureUserConfig = (): string => {
  const userConfigDir = getConfigDir();
  const userConfig = getUserConfigPath();

  // Try to create minimal user config
  try {
    // Create directory if needed
    if (!existsSync(userConfigDir)) {
      mkdirSync(userConfigDir, { recursive: true });
      console.log(`[nova] Created config directory: ${userConfigDir}`);
    }

    // Write minimal user config for preferences (API keys stored in GraphD)
    writeFileSync(userConfig, JSON.stringify(MINIMAL_USER_CONFIG, null, 2) + '\n');
    console.log(`[nova] Created user config: ${userConfig}`);
    console.log('[nova] To add API keys, use: nova providers set <provider> <key>');
    return userConfig;
  } catch (err) {
    console.warn(`[nova] Could not create user config: ${err}`);
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

const resolveHeadlessConfigPath = (): string | undefined => {
  if (process.env.HARNESS_CONFIG_PATH) {
    return process.env.HARNESS_CONFIG_PATH;
  }
  const projectConfig = findProjectConfigPath(process.cwd());
  return projectConfig ?? undefined;
};

/**
 * Check if daemon is running by attempting a TCP connection
 */
async function isPortRunning(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port }, () => {
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

async function isDaemonRunning(): Promise<boolean> {
  return isPortRunning(DAEMON_HOST, DAEMON_PORT);
}

function isExistingFile(targetPath: string): boolean {
  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

async function runHarnessCli(rawArgs: string[]): Promise<number> {
  const harnessCliPath = getHarnessCliPath();
  if (!existsSync(harnessCliPath)) {
    throw new Error(`harness CLI not found: ${harnessCliPath}`);
  }

  const configPath = resolveHeadlessConfigPath();
  const proc = spawn({
    cmd: ['bun', harnessCliPath, ...rawArgs],
    cwd: getProjectRoot(),
    env: {
      ...process.env,
      ...(configPath ? { HARNESS_CONFIG_PATH: configPath } : {}),
      EVENT_BUS_HOST: DAEMON_HOST,
      EVENT_BUS_PORT: String(DAEMON_PORT),
    },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });

  await proc.exited;
  return proc.exitCode ?? 0;
}

async function maybeRunHeadless(rawArgs: string[]): Promise<boolean> {
  const withoutLauncherFlags = rawArgs.filter(
    (arg) => arg !== '--restart' && arg !== '--daemon-only'
  );
  const normalized = [...withoutLauncherFlags];

  if (normalized.length === 0) return false;

  const command = normalized[0];
  if (command === 'run') {
    const code = await runHarnessCli(normalized);
    process.exit(code);
  }

  let hasExplicitHeadlessFlags = false;
  for (const arg of normalized) {
    if (
      arg === '--input' ||
      arg.startsWith('--input=') ||
      arg === '--input-file' ||
      arg.startsWith('--input-file=')
    ) {
      hasExplicitHeadlessFlags = true;
      break;
    }
  }

  if (hasExplicitHeadlessFlags) {
    const code = await runHarnessCli(['run', ...normalized]);
    process.exit(code);
  }

  if (command.startsWith('-')) {
    return false;
  }

  const inputPath = path.resolve(command);
  if (!isExistingFile(inputPath)) return false;

  const passthrough = normalized.slice(1);
  const code = await runHarnessCli(['run', '--input-file', inputPath, ...passthrough]);
  process.exit(code);
}

/**
 * Build daemon args from launcher argv.
 * Note: --dangerous is no longer forwarded to daemon - it's now per-session.
 */
function buildDaemonArgs(): string[] {
  const daemonArgs: string[] = [];
  // --dangerous is now handled per-session by the TUI, not the daemon
  return daemonArgs;
}

/**
 * Start the daemon in background
 */
async function startDaemon(): Promise<Subprocess> {
  const daemonPath = getDaemonPath();
  const configPath = resolveConfigPath();
  const daemonArgs = buildDaemonArgs();

  console.log('[nova] Starting daemon...');

  const logsDir = path.join(getProjectRoot(), 'logs');
  mkdirSync(logsDir, { recursive: true });

  const daemon = spawn({
    cmd: ['bun', 'run', daemonPath, ...daemonArgs],
    cwd: getProjectRoot(),
    env: {
      ...process.env,
      ...(configPath ? { HARNESS_CONFIG_PATH: configPath } : {}),
      EVENT_BUS_HOST: DAEMON_HOST,
      EVENT_BUS_PORT: String(DAEMON_PORT),
    },
    stdout: 'ignore',
    stderr: Bun.file(path.join(logsDir, 'daemon_stderr.log')),
  });

  // Wait for daemon to be ready
  const startTime = Date.now();
  while (Date.now() - startTime < DAEMON_STARTUP_TIMEOUT) {
    if (await isDaemonRunning()) {
      console.log('[nova] Daemon ready');
      return daemon;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // Check if daemon failed
  if (daemon.exitCode !== null) {
    throw new Error(`Daemon failed to start (check stderr output above)`);
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
    cwd: getProjectRoot(),
    env: {
      ...process.env,
      EVENT_BUS_HOST: DAEMON_HOST,
      EVENT_BUS_PORT: String(DAEMON_PORT),
      // Force color support for markdown rendering (chalk detection fails under Bun)
      FORCE_COLOR: '3',
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
    console.warn('[nova] Services did not shut down in time');
  } catch {
    // No daemon running or pkill failed - that's fine
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  if (await maybeRunHeadless(process.argv.slice(2))) {
    return;
  }

  // Handle --restart flag: kill existing daemon before proceeding
  if (process.argv.includes('--restart')) {
    console.log('[nova] Restarting daemon...');
    await killExistingDaemon();
  }

  // Check for --daemon-only flag
  if (process.argv.includes('--daemon-only')) {
    const daemonPath = getDaemonPath();
    const configPath = resolveConfigPath();
    const daemonArgs = buildDaemonArgs();

    // Run daemon in foreground
    const daemon = spawn({
      cmd: ['bun', 'run', daemonPath, ...daemonArgs],
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
  const daemonRunning = await isDaemonRunning();

  // Note: --dangerous is now per-session, NOT global.
  // Starting a TUI with --dangerous enables dangerous mode for that session only.
  // It does NOT require restarting the daemon or affect other sessions.
  if (process.argv.includes('--dangerous')) {
    console.log('[nova] --dangerous mode: Will enable for this session only');
  }

  if (!daemonRunning) {
    try {
      await startDaemon();
    } catch (error) {
      console.error('[nova] Failed to start daemon:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    console.log('[nova] Daemon already running');
  }

  // Start TUI
  await startTui();
}

main().catch((error) => {
  console.error('[nova] Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
