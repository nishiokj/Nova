/**
 * Start GraphD server for the dashboard.
 *
 * Run with: bun run start-graphd.ts
 */

import { GraphDManager, createGraphDConfig } from '../../packages/graphd/src/index.js';
import path from 'path';

// Dashboard runs from dashboard/ dir - use harness-daemon's database
const ROOT_PATH = path.resolve(process.cwd(), '..', '..');
const HARNESS_DB_PATH = path.resolve(process.cwd(), '..', 'harness-daemon', '.graphd', 'graphd.db');
const PORT = 9444;

async function main() {
  console.log('Starting GraphD server...');
  console.log(`  Root: ${ROOT_PATH}`);
  console.log(`  Port: ${PORT}`);
  console.log(`  DB: ${HARNESS_DB_PATH}`);

  const config = createGraphDConfig(ROOT_PATH, {
    port: PORT,
    host: '127.0.0.1',
    dbPath: HARNESS_DB_PATH,  // Use harness-daemon's database
  });

  console.log(`  DB Path: ${config.dbPath}`);

  const manager = new GraphDManager(config);

  try {
    const started = await manager.start();
    if (!started) {
      console.error('Failed to start GraphD (returned false)');
      process.exit(1);
    }
  } catch (error) {
    // Print the full error message
    console.error('='.repeat(60));
    console.error('GraphD FAILED TO START');
    console.error('='.repeat(60));
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
      if (error.stack) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
    } else {
      console.error('Error:', error);
    }
    console.error('='.repeat(60));
    process.exit(1);
  }

  console.log(`GraphD running on http://127.0.0.1:${PORT}`);
  console.log('Press Ctrl+C to stop');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down GraphD...');
    await manager.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await manager.stop();
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Unhandled error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
