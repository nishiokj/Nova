#!/usr/bin/env bun
/**
 * GraphD standalone server entrypoint.
 *
 * Usage:
 *   bun run packages/infra/graphd/src/graphd.ts --host 127.0.0.1 --port 9444 --db-path ~/.graphd/graphd.db
 */

import { join, resolve } from 'path';
import { homedir } from 'os';
import { GraphDManager, createGraphDConfig } from './manager.js';

interface GraphDRunOptions {
  host: string;
  port: number;
  dbPath: string;
  rootPath: string;
}

function parseArgs(): GraphDRunOptions {
  const args = process.argv.slice(2);
  let host = process.env.GRAPHD_HOST ?? '127.0.0.1';
  let port = Number(process.env.GRAPHD_PORT ?? '9444');
  let dbPath = process.env.GRAPHD_DB_PATH ?? join(homedir(), '.graphd', 'graphd.db');
  let rootPath = process.env.GRAPHD_ROOT_PATH ?? process.cwd();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host' && i + 1 < args.length) {
      host = args[++i];
      continue;
    }
    if (arg === '--port' && i + 1 < args.length) {
      const parsed = Number.parseInt(args[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        port = parsed;
      }
      continue;
    }
    if (arg === '--db-path' && i + 1 < args.length) {
      dbPath = args[++i];
      continue;
    }
    if (arg === '--root' && i + 1 < args.length) {
      rootPath = args[++i];
      continue;
    }
  }

  return {
    host,
    port,
    dbPath,
    rootPath: resolve(rootPath),
  };
}

export async function runGraphDServer(): Promise<void> {
  const options = parseArgs();
  const config = createGraphDConfig(options.rootPath, {
    host: options.host,
    port: options.port,
    dbPath: options.dbPath,
  });
  const manager = new GraphDManager(config);

  const started = await manager.start();
  if (!started) {
    throw new Error('GraphD failed to start');
  }

  console.log(`[graphd] listening on http://${options.host}:${options.port}`);
  console.log(`[graphd] db: ${config.dbPath}`);

  const shutdown = async (signal: string) => {
    console.log(`[graphd] received ${signal}, shutting down`);
    await manager.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await new Promise(() => { /* keep alive */ });
}

if (import.meta.main) {
  runGraphDServer().catch((error: unknown) => {
    console.error('[graphd] fatal error:', error);
    process.exit(1);
  });
}
