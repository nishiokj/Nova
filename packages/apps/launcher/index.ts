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
 * This is created on first run for user preferences.
 * API keys are stored in GraphD (use `rex providers set <provider> <key>`).
 * All other settings come from config/defaults.json
 */
const MINIMAL_USER_CONFIG = {
  $comment: "User preferences. API keys are stored securely in GraphD - use 'rex providers set <provider> <key>' to configure them.",
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
const CONTROL_PLANE_HOST = process.env.CONTROL_PLANE_HOST ?? DAEMON_HOST;
const CONTROL_PLANE_PORT = Number(process.env.CONTROL_PLANE_PORT ?? '9445');
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

const getControlPlanePath = () => {
  const root = getProjectRoot();
  const distPath = path.join(root, 'packages', 'apps', 'control-plane', 'dist', 'control-plane.js');
  const srcPath = path.join(root, 'packages', 'apps', 'control-plane', 'src', 'control-plane.ts');
  return existsSync(distPath) ? distPath : srcPath;
};

const getTuiPath = () => {
  const root = getProjectRoot();
  // Always use source - bun bundler corrupts UTF-8 box-drawing characters
  const srcPath = path.join(root, 'packages', 'apps', 'tui', 'index.tsx');
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

    // Write minimal user config for preferences (API keys stored in GraphD)
    writeFileSync(userConfig, JSON.stringify(MINIMAL_USER_CONFIG, null, 2) + '\n');
    console.log(`[rex] Created user config: ${userConfig}`);
    console.log('[rex] To add API keys, use: rex providers set <provider> <key>');
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

async function isControlPlaneRunning(): Promise<boolean> {
  return isPortRunning(CONTROL_PLANE_HOST, CONTROL_PLANE_PORT);
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

function buildControlPlaneArgs(): string[] {
  return [
    '--host', CONTROL_PLANE_HOST,
    '--port', String(CONTROL_PLANE_PORT),
    '--bus-host', DAEMON_HOST,
    '--bus-port', String(DAEMON_PORT),
  ];
}

/**
 * Start the daemon in background
 */
async function startDaemon(): Promise<Subprocess> {
  const daemonPath = getDaemonPath();
  const configPath = resolveConfigPath();
  const daemonArgs = buildDaemonArgs();

  console.log('[rex] Starting daemon...');

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
      console.log('[rex] Daemon ready');
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
 * Start the control-plane server in background.
 */
async function startControlPlane(): Promise<Subprocess> {
  const controlPlanePath = getControlPlanePath();
  const configPath = resolveConfigPath();
  const controlPlaneArgs = buildControlPlaneArgs();

  console.log('[rex] Starting control-plane server...');

  const logsDir = path.join(getProjectRoot(), 'logs');
  mkdirSync(logsDir, { recursive: true });

  const controlPlane = spawn({
    cmd: ['bun', 'run', controlPlanePath, ...controlPlaneArgs],
    cwd: getProjectRoot(),
    env: {
      ...process.env,
      ...(configPath ? { HARNESS_CONFIG_PATH: configPath } : {}),
      EVENT_BUS_HOST: DAEMON_HOST,
      EVENT_BUS_PORT: String(DAEMON_PORT),
      CONTROL_PLANE_HOST,
      CONTROL_PLANE_PORT: String(CONTROL_PLANE_PORT),
    },
    stdout: 'ignore',
    stderr: Bun.file(path.join(logsDir, 'control_plane_stderr.log')),
  });

  const startTime = Date.now();
  while (Date.now() - startTime < DAEMON_STARTUP_TIMEOUT) {
    if (await isControlPlaneRunning()) {
      console.log('[rex] Control-plane ready');
      return controlPlane;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (controlPlane.exitCode !== null) {
    throw new Error('Control-plane server failed to start (check control_plane_stderr.log)');
  }

  throw new Error('Control-plane startup timeout');
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
    execSync('pkill -TERM -f control-plane', { stdio: 'ignore' });
    // Wait for graceful shutdown
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      if (!(await isDaemonRunning()) && !(await isControlPlaneRunning())) {
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    console.warn('[rex] Services did not shut down in time');
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

    let controlPlane: Subprocess | null = null;
    const controlPlaneRunning = await isControlPlaneRunning();
    if (!controlPlaneRunning) {
      try {
        controlPlane = await startControlPlane();
      } catch (error) {
        console.error('[rex] Failed to start control-plane:', error instanceof Error ? error.message : error);
      }
    }

    const stopControlPlane = () => {
      if (controlPlane && controlPlane.exitCode === null) {
        controlPlane.kill();
      }
    };
    process.on('SIGINT', stopControlPlane);
    process.on('SIGTERM', stopControlPlane);

    await daemon.exited;
    stopControlPlane();
    process.exit(daemon.exitCode ?? 0);
    return;
  }

  // Check if daemon is already running
  const daemonRunning = await isDaemonRunning();

  // Note: --dangerous is now per-session, NOT global.
  // Starting a TUI with --dangerous enables dangerous mode for that session only.
  // It does NOT require restarting the daemon or affect other sessions.
  if (process.argv.includes('--dangerous')) {
    console.log('[rex] --dangerous mode: Will enable for this session only');
  }

  if (!daemonRunning) {
    try {
      await startDaemon();
    } catch (error) {
      console.error('[rex] Failed to start daemon:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    console.log('[rex] Daemon already running');
  }

  const controlPlaneRunning = await isControlPlaneRunning();
  if (!controlPlaneRunning) {
    try {
      await startControlPlane();
    } catch (error) {
      console.error('[rex] Failed to start control-plane:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    console.log('[rex] Control-plane already running');
  }

  // Start TUI
  await startTui();
}

main().catch((error) => {
  console.error('[rex] Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
