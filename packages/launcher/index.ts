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
import { mkdirSync, existsSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

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
  // Check for dist first, then src
  const distPath = path.join(root, 'packages', 'tui', 'dist', 'index.js');
  const srcPath = path.join(root, 'packages', 'tui', 'index.tsx');
  try {
    Bun.file(distPath);
    return distPath;
  } catch {
    return srcPath;
  }
};

const getConfigDir = () => path.join(homedir(), '.rex');

const getConfigPath = () => {
  // Check for user config first, then project config
  const userConfigDir = getConfigDir();
  const userConfig = path.join(userConfigDir, 'config.json');
  const projectConfig = path.join(getProjectRoot(), 'config', 'harness_config.json');

  // If user config exists, use it
  if (existsSync(userConfig)) {
    return userConfig;
  }

  // Try to create user config from template
  try {
    // Create directory if needed
    if (!existsSync(userConfigDir)) {
      mkdirSync(userConfigDir, { recursive: true });
      console.log(`[rex] Created config directory: ${userConfigDir}`);
    }

    // Copy template config
    if (existsSync(projectConfig)) {
      copyFileSync(projectConfig, userConfig);
      console.log(`[rex] Created default config: ${userConfig}`);
      console.log('[rex] Edit this file to configure your LLM providers and API keys');
      return userConfig;
    }
  } catch (err) {
    console.warn(`[rex] Could not create user config: ${err}`);
  }

  // Fall back to project config
  return projectConfig;
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
  const configPath = getConfigPath();

  console.log('[rex] Starting daemon...');

  const daemon = spawn({
    cmd: ['bun', 'run', daemonPath],
    env: {
      ...process.env,
      HARNESS_CONFIG_PATH: configPath,
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
 * Main entry point
 */
async function main(): Promise<void> {
  // Check for --daemon-only flag
  if (process.argv.includes('--daemon-only')) {
    const daemonPath = getDaemonPath();
    const configPath = getConfigPath();

    // Run daemon in foreground
    const daemon = spawn({
      cmd: ['bun', 'run', daemonPath],
      env: {
        ...process.env,
        HARNESS_CONFIG_PATH: configPath,
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
