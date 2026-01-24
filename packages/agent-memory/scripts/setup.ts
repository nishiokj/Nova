#!/usr/bin/env bun
/**
 * Database Setup Script
 *
 * Bootstraps the agent-memory database:
 * 1. Validates configuration
 * 2. Tests database connection
 * 3. Runs migrations
 * 4. Validates schema
 *
 * Usage:
 *   bun run scripts/setup.ts
 *   bun run scripts/setup.ts --dry-run
 *   bun run scripts/setup.ts --config ./my-config.json
 *
 * Environment variables:
 *   DATABASE_URL or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
 *   LOG_LEVEL (default: info)
 */

import { parseArgs } from 'node:util'
import {
  loadConfig,
  getConfigSummary,
  type AppConfig,
} from '../src/config/index.js'
import {
  createDatabase,
  migrate,
  getCurrentVersion,
  getPendingMigrations,
  isSchemaUpToDate,
  type Database,
} from '../src/db/index.js'

// ============ CLI Parsing ============

interface CliOptions {
  help: boolean
  dryRun: boolean
  configFile?: string
  verbose: boolean
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'dry-run': { type: 'boolean', short: 'n', default: false },
      config: { type: 'string', short: 'c' },
      verbose: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: false,
  })

  return {
    help: values.help ?? false,
    dryRun: values['dry-run'] ?? false,
    configFile: values.config,
    verbose: values.verbose ?? false,
  }
}

function printHelp(): void {
  console.log(`
agent-memory setup - Bootstrap the database

Usage:
  bun run scripts/setup.ts [options]

Options:
  -h, --help      Show this help message
  -n, --dry-run   Show what would be done without making changes
  -c, --config    Path to config file (default: ./agent-memory.config.json)
  -v, --verbose   Show detailed output

Environment:
  DATABASE_URL              PostgreSQL connection string
  PGHOST, PGPORT, etc.      Individual connection parameters
  LOG_LEVEL                 Logging level (debug, info, warn, error)

Examples:
  bun run scripts/setup.ts
  bun run scripts/setup.ts --dry-run
  bun run scripts/setup.ts --config ./production.config.json
`)
}

// ============ Logging ============

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_COLORS = {
  debug: '\x1b[90m',   // gray
  info: '\x1b[36m',    // cyan
  warn: '\x1b[33m',    // yellow
  error: '\x1b[31m',   // red
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const color = LOG_COLORS[level]
  const prefix = `${color}[${level.toUpperCase()}]${LOG_COLORS.reset}`
  const dataStr = data ? ` ${JSON.stringify(data)}` : ''
  console.log(`${prefix} ${message}${dataStr}`)
}

function success(message: string): void {
  console.log(`${LOG_COLORS.green}✓${LOG_COLORS.reset} ${message}`)
}

function header(message: string): void {
  console.log(`\n${LOG_COLORS.bold}${message}${LOG_COLORS.reset}`)
}

// ============ Setup Steps ============

async function loadAndValidateConfig(configFile?: string): Promise<AppConfig> {
  header('Loading configuration...')

  const config = await loadConfig({ configFile })
  const summary = getConfigSummary(config)

  log('info', 'Configuration loaded', {
    env: config.env,
    database: (summary.database as Record<string, unknown>).host,
  })

  return config
}

async function testConnection(config: AppConfig): Promise<Database> {
  header('Testing database connection...')

  const db = createDatabase({
    connectionString: config.database.connectionString,
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    username: config.database.username,
    password: config.database.password,
    max: 1, // Single connection for setup
    connectTimeout: 10,
  })

  const connected = await db.ping()
  if (!connected) {
    throw new Error('Failed to connect to database')
  }

  success('Connected to database')

  // Check PostgreSQL version
  const [versionRow] = await db.sql<{ version: string }[]>`SELECT version()`
  log('info', `PostgreSQL: ${versionRow.version.split(',')[0]}`)

  return db
}

async function checkExtensions(db: Database): Promise<void> {
  header('Checking required extensions...')

  const extensions = ['pgvector', 'pg_trgm']

  for (const ext of extensions) {
    const [row] = await db.sql<{ installed: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = ${ext}
      ) as installed
    `

    if (row.installed) {
      success(`Extension '${ext}' is installed`)
    } else {
      log('warn', `Extension '${ext}' not installed - will be created by migration`)
    }
  }
}

async function runMigrations(db: Database, dryRun: boolean, verbose: boolean): Promise<void> {
  header('Running migrations...')

  const currentVersion = await getCurrentVersion(db)
  const pending = await getPendingMigrations(db)

  log('info', `Current schema version: ${currentVersion}`)
  log('info', `Pending migrations: ${pending.length}`)

  if (pending.length === 0) {
    success('Schema is up to date')
    return
  }

  if (verbose) {
    for (const m of pending) {
      log('debug', `  ${m.version}: ${m.description}`)
    }
  }

  if (dryRun) {
    log('warn', 'Dry run - skipping migration execution')
    return
  }

  const result = await migrate(db, {
    dryRun,
    onMigration: (migration, status) => {
      if (status === 'applying') {
        log('info', `Applying migration ${migration.version}: ${migration.description}`)
      } else if (status === 'applied') {
        success(`Applied migration ${migration.version}`)
      }
    },
  })

  log('info', `Migrations complete`, {
    applied: result.applied.length,
    skipped: result.skipped.length,
    currentVersion: result.current_version,
  })
}

async function validateSchema(db: Database): Promise<void> {
  header('Validating schema...')

  const expectedTables = [
    'schema_migrations',
    'raw_envelopes',
    'canonical_entities',
    'entity_source_mappings',
    'sync_jobs',
    'job_queue',
    'merge_decisions',
    'pending_reviews',
    'accounts',
    'webhook_deliveries',
  ]

  const rows = await db.sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `

  const existingTables = new Set(rows.map((r) => r.tablename))

  let allPresent = true
  for (const table of expectedTables) {
    if (existingTables.has(table)) {
      success(`Table '${table}' exists`)
    } else {
      log('error', `Table '${table}' is missing!`)
      allPresent = false
    }
  }

  if (!allPresent) {
    throw new Error('Schema validation failed - missing tables')
  }

  // Check that schema is up to date
  const upToDate = await isSchemaUpToDate(db)
  if (!upToDate) {
    log('warn', 'Schema has pending migrations')
  }
}

async function showStats(db: Database): Promise<void> {
  header('Database statistics...')

  const stats = await db.sql<{ table_name: string; row_count: number }[]>`
    SELECT
      relname as table_name,
      n_live_tup as row_count
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY n_live_tup DESC
  `

  for (const row of stats) {
    log('debug', `  ${row.table_name}: ${row.row_count} rows`)
  }
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
║     Agent Memory Database Setup       ║
╚═══════════════════════════════════════╝${LOG_COLORS.reset}
`)

  if (options.dryRun) {
    log('warn', 'DRY RUN MODE - No changes will be made')
  }

  let db: Database | undefined

  try {
    // Step 1: Load configuration
    const config = await loadAndValidateConfig(options.configFile)

    // Step 2: Test connection
    db = await testConnection(config)

    // Step 3: Check extensions
    await checkExtensions(db)

    // Step 4: Run migrations
    await runMigrations(db, options.dryRun, options.verbose)

    // Step 5: Validate schema
    if (!options.dryRun) {
      await validateSchema(db)
    }

    // Step 6: Show stats
    if (options.verbose && !options.dryRun) {
      await showStats(db)
    }

    header('Setup complete!')
    success('Database is ready for use')

  } catch (error) {
    log('error', 'Setup failed', {
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
