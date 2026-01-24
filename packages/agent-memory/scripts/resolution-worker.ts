#!/usr/bin/env bun
/**
 * Entity Resolution Worker
 *
 * Standalone process that polls for unresolved identities and resolves them.
 * Can run continuously or process a single batch.
 *
 * Usage:
 *   bun run scripts/resolution-worker.ts              # Continuous mode
 *   bun run scripts/resolution-worker.ts --once       # Process once and exit
 *   bun run scripts/resolution-worker.ts --sync-job <id>  # Process specific sync job
 *
 * Environment variables:
 *   DATABASE_URL or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
 *   RESOLUTION_POLL_INTERVAL_MS (default: 5000)
 *   RESOLUTION_BATCH_SIZE (default: 50)
 */

import { parseArgs } from 'node:util'
import {
  loadConfig,
  type AppConfig,
} from '../src/config/index.js'
import {
  createDatabase,
  type Database,
} from '../src/db/index.js'
import { EntityResolutionEngine } from '../src/resolution/index.js'

// ============ CLI Parsing ============

interface CliOptions {
  help: boolean
  once: boolean
  syncJob?: string
  verbose: boolean
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      once: { type: 'boolean', short: '1', default: false },
      'sync-job': { type: 'string', short: 's' },
      verbose: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: false,
  })

  return {
    help: values.help ?? false,
    once: values.once ?? false,
    syncJob: values['sync-job'],
    verbose: values.verbose ?? false,
  }
}

function printHelp(): void {
  console.log(`
agent-memory resolution-worker - Entity resolution processor

Usage:
  bun run scripts/resolution-worker.ts [options]

Options:
  -h, --help              Show this help message
  -1, --once              Process once and exit (no polling)
  -s, --sync-job <id>     Process identities from a specific sync job
  -v, --verbose           Show detailed output

Environment:
  DATABASE_URL                     PostgreSQL connection string
  RESOLUTION_POLL_INTERVAL_MS      Poll interval in ms (default: 5000)
  RESOLUTION_BATCH_SIZE            Batch size (default: 50)

Examples:
  bun run scripts/resolution-worker.ts                    # Continuous polling
  bun run scripts/resolution-worker.ts --once             # Single batch
  bun run scripts/resolution-worker.ts --sync-job abc123  # Specific job
`)
}

// ============ Logging ============

const LOG_COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
  const color = LOG_COLORS[level]
  const timestamp = new Date().toISOString()
  const prefix = `${LOG_COLORS.debug}${timestamp}${LOG_COLORS.reset} ${color}[${level.toUpperCase()}]${LOG_COLORS.reset}`
  const dataStr = data ? ` ${JSON.stringify(data)}` : ''
  console.log(`${prefix} ${message}${dataStr}`)
}

// ============ Worker ============

interface WorkerConfig {
  pollIntervalMs: number
  batchSize: number
  maxBatchesPerPoll: number
}

class ResolutionWorker {
  private db: Database
  private engine: EntityResolutionEngine
  private config: WorkerConfig
  private isRunning = false
  private verbose: boolean

  constructor(db: Database, appConfig: AppConfig, verbose: boolean) {
    this.db = db
    this.engine = new EntityResolutionEngine(db.sql, appConfig.entityResolution)
    this.verbose = verbose

    this.config = {
      pollIntervalMs: parseInt(process.env.RESOLUTION_POLL_INTERVAL_MS ?? '5000', 10),
      batchSize: parseInt(process.env.RESOLUTION_BATCH_SIZE ?? '50', 10),
      maxBatchesPerPoll: 10,
    }

    // Wire up event handler for logging
    this.engine.onEvent((event) => {
      if (this.verbose) {
        log('debug', `Resolution event: ${event.type}`, event as unknown as Record<string, unknown>)
      }
    })
  }

  /**
   * Process identities from a specific sync job.
   */
  async processSyncJob(syncJobId: string): Promise<void> {
    log('info', `Processing identities from sync job: ${syncJobId}`)

    const stats = await this.engine.resolveFromSyncJob(syncJobId)

    log('info', 'Sync job resolution complete', {
      total: stats.total,
      resolved: stats.resolved,
      queued: stats.queued,
      failed: stats.failed,
    })
  }

  /**
   * Process a single batch of unresolved identities.
   */
  async processOnce(): Promise<{ processed: number; remaining: number }> {
    const unresolvedCount = await this.engine.getUnresolvedCount()

    if (unresolvedCount === 0) {
      log('info', 'No unresolved identities')
      return { processed: 0, remaining: 0 }
    }

    log('info', `Found ${unresolvedCount} unresolved identities`)

    const stats = await this.engine.resolveAllUnresolved({
      limit: this.config.batchSize * this.config.maxBatchesPerPoll,
      batchSize: this.config.batchSize,
    })

    const remaining = await this.engine.getUnresolvedCount()

    log('info', 'Batch complete', {
      processed: stats.total,
      resolved: stats.resolved,
      queued: stats.queued,
      failed: stats.failed,
      remaining,
    })

    return { processed: stats.total, remaining }
  }

  /**
   * Run continuously, polling for unresolved identities.
   */
  async runContinuous(): Promise<void> {
    this.isRunning = true

    log('info', 'Starting resolution worker', {
      pollIntervalMs: this.config.pollIntervalMs,
      batchSize: this.config.batchSize,
    })

    // Handle graceful shutdown
    const shutdown = async () => {
      log('info', 'Shutting down...')
      this.isRunning = false
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    while (this.isRunning) {
      try {
        const { processed, remaining } = await this.processOnce()

        // If there's more work, don't wait
        if (remaining > 0 && processed > 0) {
          continue
        }

        // Wait before next poll
        await sleep(this.config.pollIntervalMs)
      } catch (error) {
        log('error', 'Error in resolution loop', {
          error: error instanceof Error ? error.message : String(error),
        })
        // Back off on error
        await sleep(this.config.pollIntervalMs * 2)
      }
    }

    log('info', 'Resolution worker stopped')
  }

  /**
   * Get current stats for monitoring.
   */
  async getStats(): Promise<{
    unresolved: number
    pendingReview: number
  }> {
    const [unresolved, pendingReview] = await Promise.all([
      this.engine.getUnresolvedCount(),
      this.engine.getPendingReviewCount(),
    ])
    return { unresolved, pendingReview }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============ Main ============

async function main(): Promise<void> {
  const options = parseCliArgs()

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  console.log(`
${LOG_COLORS.bold}╔═══════════════════════════════════════╗
║     Entity Resolution Worker          ║
╚═══════════════════════════════════════╝${LOG_COLORS.reset}
`)

  let db: Database | undefined

  try {
    // Load configuration
    const config = await loadConfig()

    // Connect to database
    db = createDatabase({
      connectionString: config.database.connectionString,
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      username: config.database.username,
      password: config.database.password,
      max: 5, // Small pool for worker
    })

    const connected = await db.ping()
    if (!connected) {
      throw new Error('Failed to connect to database')
    }

    log('info', 'Connected to database')

    // Create worker
    const worker = new ResolutionWorker(db, config, options.verbose)

    // Show initial stats
    const stats = await worker.getStats()
    log('info', 'Initial state', stats)

    // Run based on mode
    if (options.syncJob) {
      // Process specific sync job
      await worker.processSyncJob(options.syncJob)
    } else if (options.once) {
      // Process once and exit
      await worker.processOnce()
    } else {
      // Continuous mode
      await worker.runContinuous()
    }

  } catch (error) {
    log('error', 'Worker failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    process.exit(1)
  } finally {
    if (db) {
      await db.close()
    }
  }
}

main()
