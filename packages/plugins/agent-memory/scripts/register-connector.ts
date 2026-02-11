#!/usr/bin/env bun
/**
 * Register Connector CLI
 *
 * Registers a connector in the database and creates sync tasks.
 *
 * Usage:
 *   bun run scripts/register-connector.ts obsidian
 *   bun run scripts/register-connector.ts obsidian --vault-path ~/Documents/MyVault
 *   bun run scripts/register-connector.ts obsidian --dry-run
 *
 * Environment variables:
 *   DATABASE_URL or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
 */

import { parseArgs } from 'node:util'
import { loadConfig } from '../src/config/index.js'
import { createDatabase, type Database } from '../src/db/index.js'
import { createRegisteredConnectorRepository } from '../src/db/repositories/registered-connector.js'
import { createSyncTaskRepository } from '../src/db/repositories/sync-task.js'
import { createAccountRepository } from '../src/db/repositories/account.js'
import { listFactoryTypes, getFactory } from '../src/connectors/registry.js'
import type { ConnectorType } from '../src/ids.js'

// ============ CLI Parsing ============

interface CliOptions {
  help: boolean
  dryRun: boolean
  vaultPath?: string
  pageSize?: number
  folderFilter?: string[]
  tagFilter?: string[]
  excludeTagFilter?: string[]
}

function parseCliArgs(): { connectorType: string; options: CliOptions } {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'dry-run': { type: 'boolean', short: 'n', default: false },
      'vault-path': { type: 'string' },
      'page-size': { type: 'string' },
      'folder-filter': { type: 'string' },
      'tag-filter': { type: 'string' },
      'exclude-tag-filter': { type: 'string' },
    },
    allowPositionals: true,
  })

  const [connectorType] = positionals

  return {
    connectorType: connectorType ?? '',
    options: {
      help: values.help ?? false,
      dryRun: values['dry-run'] ?? false,
      vaultPath: values['vault-path'],
      pageSize: values['page-size'] ? parseInt(values['page-size'], 10) : undefined,
      folderFilter: values['folder-filter']?.split(','),
      tagFilter: values['tag-filter']?.split(','),
      excludeTagFilter: values['exclude-tag-filter']?.split(','),
    },
  }
}

function printHelp(): void {
  console.log(`
register-connector - Register a connector and create sync tasks

Usage:
  bun run scripts/register-connector.ts <connector-type> [options]

Connector Types:
  gmail         - Gmail email connector
  github        - GitHub issues, PRs, and notifications
  imessage      - iMessage messages (macOS only)
  obsidian      - Obsidian vault notes
  google-calendar - Google Calendar events

Options:
  -h, --help              Show this help message
  -n, --dry-run           Show what would be done without making changes

  --vault-path PATH        Path to Obsidian vault (for obsidian connector)
  --page-size N           Number of items per page (default: 100)
  --folder-filter F1,F2   Only sync from specific folders (for obsidian)
  --tag-filter T1,T2       Only sync notes with these tags (for obsidian)
  --exclude-tag-filter T1   Exclude notes with these tags (for obsidian)

Environment:
  DATABASE_URL              PostgreSQL connection string
  PGHOST, PGPORT, etc.      Individual connection parameters

Examples:
  # Register Obsidian with default settings
  bun run scripts/register-connector.ts obsidian

  # Register Obsidian with custom vault path
  bun run scripts/register-connector.ts obsidian --vault-path ~/Documents/Brain

  # Register Obsidian with filters
  bun run scripts/register-connector.ts obsidian \\
    --vault-path ~/Documents/Brain \\
    --tag-filter "#work,#important" \\
    --exclude-tag-filter "#private"

  # Dry run to see what would happen
  bun run scripts/register-connector.ts obsidian --dry-run
`)
}

// ============ Logging ============

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
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

// ============ Connector-Specific Config ============

function buildConnectorConfig(
  connectorType: ConnectorType,
  options: CliOptions
): Record<string, unknown> {
  const config: Record<string, unknown> = {}

  if (connectorType === 'obsidian') {
    if (options.vaultPath) {
      config.vaultPath = options.vaultPath
    }
    if (options.pageSize) {
      config.pageSize = options.pageSize
    }
    if (options.folderFilter && options.folderFilter.length > 0) {
      config.folderFilter = options.folderFilter
    }
    if (options.tagFilter && options.tagFilter.length > 0) {
      config.tagFilter = options.tagFilter
    }
    if (options.excludeTagFilter && options.excludeTagFilter.length > 0) {
      config.excludeTagFilter = options.excludeTagFilter
    }
  }

  return config
}

// ============ Registration Logic ============

async function registerConnector(
  db: Database,
  connectorType: ConnectorType,
  config: Record<string, unknown>,
  dryRun: boolean
): Promise<void> {
  header('Registering connector...')

  // Validate connector type
  const factoryEntry = getFactory(connectorType)
  if (!factoryEntry) {
    throw new Error(`Unknown connector type: ${connectorType}`)
  }

  log('info', `Connector: ${factoryEntry.displayName}`)
  log('info', `Type: ${connectorType}`)

  const registeredConnectorRepo = createRegisteredConnectorRepository(db)
  const syncTaskRepo = createSyncTaskRepository(db)
  const accountRepo = createAccountRepository(db)

  // Register the connector
  if (!dryRun) {
    const registered = await registeredConnectorRepo.register({
      type: connectorType,
      enabled: true,
      config,
    })

    success(`Registered connector: ${connectorType}`)
    log('info', `Registered at: ${registered.registered_at}`)
  } else {
    log('warn', 'Dry run - skipping connector registration')
    log('debug', `Would register connector with config:`, config)
  }

  // Create or get account
  header('Ensuring account exists...')

  const externalAccountId = 'local' // For local connectors
  let account
  const existingAccount = await accountRepo.findByConnector(connectorType, externalAccountId)

  if (existingAccount) {
    account = existingAccount
    log('info', `Account already exists: ${account.id}`)
  } else {
    if (!dryRun) {
      account = await accountRepo.create({
        connector: connectorType,
        external_account_id: externalAccountId,
        auth_type: 'local' as const,
      })
      success(`Created account: ${account.id}`)
    } else {
      log('warn', 'Dry run - would create account')
      account = { id: 'dry-run-id' } as any
    }
  }

  // Create sync tasks
  header('Creating sync tasks...')

  const tasks = [
    {
      description: `Full backfill of ${factoryEntry.displayName}`,
      sync_type: 'backfill' as const,
    },
    {
      description: `Incremental sync of ${factoryEntry.displayName}`,
      sync_type: 'incremental' as const,
    },
  ]

  for (const task of tasks) {
    if (!dryRun && account) {
      await syncTaskRepo.create({
        connector: connectorType,
        accountId: account.id,
        syncType: task.sync_type,
        mode: 'once', // Run once, can be rescheduled
      })
      success(`Created task: ${connectorType}:${task.sync_type}`)
    } else {
      log('warn', `Dry run - would create task: ${connectorType}:${task.sync_type}`)
    }
  }
}

async function showConnectorStatus(db: Database, connectorType: ConnectorType): Promise<void> {
  header('Connector status...')

  const registeredConnectorRepo = createRegisteredConnectorRepository(db)
  const syncTaskRepo = createSyncTaskRepository(db)

  const connector = await registeredConnectorRepo.findByType(connectorType)
  if (connector) {
    log('info', 'Connector is already registered', {
      enabled: connector.enabled,
      registered_at: connector.registered_at,
      updated_at: connector.updated_at,
    })
    log('debug', 'Config:', connector.config)
  } else {
    log('info', 'Connector is not registered')
  }

  const tasks = await syncTaskRepo.findByConnector(connectorType)
  if (tasks.length > 0) {
    log('info', `Found ${tasks.length} sync tasks`)
    for (const task of tasks) {
      log('info', `  - ${task.name} (${task.sync_type}) [${task.enabled ? 'enabled' : 'disabled'}]`)
    }
  } else {
    log('info', 'No sync tasks found')
  }
}

// ============ Main ============

async function main(): Promise<void> {
  const { connectorType, options } = parseCliArgs()

  if (options.help || !connectorType) {
    printHelp()
    process.exit(options.help ? 0 : 1)
  }

  console.log(`
${LOG_COLORS.bold}╔═══════════════════════════════════════╗
║        Connector Registration Tool       ║
╚═══════════════════════════════════════╝${LOG_COLORS.reset}
`)

  if (options.dryRun) {
    log('warn', 'DRY RUN MODE - No changes will be made')
  }

  // Validate connector type
  const availableTypes = listFactoryTypes()
  if (!availableTypes.includes(connectorType as ConnectorType)) {
    log('error', `Invalid connector type: ${connectorType}`)
    log('info', `Available types: ${availableTypes.join(', ')}`)
    process.exit(1)
  }

  let db: Database | undefined

  try {
    // Load configuration
    header('Loading configuration...')
    const config = await loadConfig()
    log('info', 'Configuration loaded')

    // Connect to database
    header('Connecting to database...')
    db = createDatabase({
      connectionString: config.database.connectionString,
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      username: config.database.username,
      password: config.database.password,
      max: 1,
      connectTimeout: 10,
    })

    const connected = await db.ping()
    if (!connected) {
      throw new Error('Failed to connect to database')
    }
    success('Connected to database')

    // Build connector config
    const connectorConfig = buildConnectorConfig(connectorType as ConnectorType, options)
    if (Object.keys(connectorConfig).length > 0) {
      log('info', 'Connector config:', connectorConfig)
    }

    // Show current status
    await showConnectorStatus(db, connectorType as ConnectorType)

    // Register connector
    await registerConnector(db, connectorType as ConnectorType, connectorConfig, options.dryRun)

    header('Complete!')

    if (options.dryRun) {
      log('info', 'Dry run successful - no changes made')
      log('info', 'Run again without --dry-run to apply changes')
    } else {
      success('Connector registered and sync tasks created')
      log('info', 'You can now run a sync using the sync daemon or CLI')
    }

  } catch (error) {
    log('error', 'Registration failed', {
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
