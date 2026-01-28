#!/usr/bin/env bun
/**
 * Sync Engine API CLI
 *
 * CLI tool to interact with the sync daemon API.
 * Connectors are discovered dynamically from the registry.
 *
 * Quick Start:
 *   1. connectors list           - See available connectors
 *   2. auth login <connector>    - Authenticate
 *   3. tasks <connector> create   - Create a sync task (interactive)
 *
 * See: packages/agent-memory/src/connectors/README.md for adding connectors.
 */

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  SyncClient,
  SyncClientError,
  captureOAuthCallback,
  getCallbackUri,
  type Account,
  type SanityCheckResult,
  type SyncEstimate,
  type SyncJob,
  type SyncTask,
  type DerivedTask,
  type DerivedJob,
  type CodingPreference,
  type CodingDecision,
} from '../packages/agent-memory/src/client/index.js'
import { sendTelegramMessage, notifyAllUsers } from '../packages/agent-memory/src/connectors/telegram/notify.js'

const SYNC_DAEMON_URL = process.env.SYNC_DAEMON_URL || 'http://localhost:3001'
const CALLBACK_PORT = parseInt(process.env.OAUTH_CALLBACK_PORT || '9876', 10)
// Use OAUTH_REDIRECT_URI for external callback (e.g., Tailscale endpoint)
// Falls back to localhost callback if not set
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI

const client = new SyncClient(SYNC_DAEMON_URL)

// ============ Short ID Index ============
// Maps short indices (#1, #2) to full ULIDs for easy reference
let lastJobsList: SyncJob[] = []
let lastTasksList: SyncTask[] = []
let lastDerivedTasksList: DerivedTask[] = []
let lastDerivedJobsList: DerivedJob[] = []

/**
 * Resolve a short ID (#1, #2) or prefix to a full ULID.
 * Supports:
 *   - #N: Index from last list (1-based) - fetches list if cache empty
 *   - Prefix: First 4+ chars of ULID (e.g., "01JD" matches "01JDXXXXXXXXXXXXXXXXXX")
 *   - Full ULID: Passed through as-is
 */
async function resolveJobId(input: string): Promise<string> {
  // Populate cache if empty and we need it
  if (lastJobsList.length === 0 && (input.startsWith('#') || (input.length >= 4 && input.length < 26))) {
    lastJobsList = await client.jobs.list({ limit: 50 })
  }

  if (input.startsWith('#')) {
    const idx = parseInt(input.slice(1), 10) - 1
    if (isNaN(idx) || idx < 0 || idx >= lastJobsList.length) {
      throw new Error(`Invalid index ${input}. Valid: #1-#${lastJobsList.length || 0}`)
    }
    return lastJobsList[idx].id
  }
  if (input.length >= 4 && input.length < 26) {
    const matches = lastJobsList.filter((j) => j.id.toUpperCase().startsWith(input.toUpperCase()))
    if (matches.length === 1) return matches[0].id
    if (matches.length > 1) {
      throw new Error(`Ambiguous prefix "${input}" matches ${matches.length} jobs. Be more specific.`)
    }
    // No match in cache - pass through and let API handle it
  }
  return input
}

async function resolveTaskId(input: string): Promise<string> {
  // Populate cache if empty and we need it
  if (lastTasksList.length === 0 && (input.startsWith('#') || (input.length >= 4 && input.length < 26))) {
    lastTasksList = await client.tasks.list()
  }

  if (input.startsWith('#')) {
    const idx = parseInt(input.slice(1), 10) - 1
    if (isNaN(idx) || idx < 0 || idx >= lastTasksList.length) {
      throw new Error(`Invalid index ${input}. Valid: #1-#${lastTasksList.length || 0}`)
    }
    return lastTasksList[idx].id
  }
  if (input.length >= 4 && input.length < 26) {
    const matches = lastTasksList.filter((t) => t.id.toUpperCase().startsWith(input.toUpperCase()))
    if (matches.length === 1) return matches[0].id
    if (matches.length > 1) {
      throw new Error(`Ambiguous prefix "${input}" matches ${matches.length} tasks. Be more specific.`)
    }
    // No match in cache - pass through and let API handle it
  }
  return input
}

async function resolveDerivedTaskId(input: string): Promise<string> {
  if (lastDerivedTasksList.length === 0 && (input.startsWith('#') || (input.length >= 4 && input.length < 26))) {
    lastDerivedTasksList = await client.derivedTasks.list()
  }

  if (input.startsWith('#')) {
    const idx = parseInt(input.slice(1), 10) - 1
    if (isNaN(idx) || idx < 0 || idx >= lastDerivedTasksList.length) {
      throw new Error(`Invalid index ${input}. Valid: #1-#${lastDerivedTasksList.length || 0}`)
    }
    return lastDerivedTasksList[idx].id
  }
  if (input.length >= 4 && input.length < 26) {
    const matches = lastDerivedTasksList.filter((t) => t.id.toUpperCase().startsWith(input.toUpperCase()))
    if (matches.length === 1) return matches[0].id
    if (matches.length > 1) {
      throw new Error(`Ambiguous prefix "${input}" matches ${matches.length} derived tasks. Be more specific.`)
    }
  }
  return input
}

async function resolveDerivedJobId(input: string): Promise<string> {
  if (lastDerivedJobsList.length === 0 && (input.startsWith('#') || (input.length >= 4 && input.length < 26))) {
    lastDerivedJobsList = await client.derivedJobs.list({ limit: 50 })
  }

  if (input.startsWith('#')) {
    const idx = parseInt(input.slice(1), 10) - 1
    if (isNaN(idx) || idx < 0 || idx >= lastDerivedJobsList.length) {
      throw new Error(`Invalid index ${input}. Valid: #1-#${lastDerivedJobsList.length || 0}`)
    }
    return lastDerivedJobsList[idx].id
  }
  if (input.length >= 4 && input.length < 26) {
    const matches = lastDerivedJobsList.filter((j) => j.id.toUpperCase().startsWith(input.toUpperCase()))
    if (matches.length === 1) return matches[0].id
    if (matches.length > 1) {
      throw new Error(`Ambiguous prefix "${input}" matches ${matches.length} derived jobs. Be more specific.`)
    }
  }
  return input
}

// ============ Output Helpers ============

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

function printSuccess(message: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${message}`)
}

function printError(message: string): void {
  console.error(`\x1b[31m✗\x1b[0m ${message}`)
}

function formatSanityDetails(details?: Record<string, unknown>): string {
  if (!details) return ''
  if (typeof details.error === 'string') {
    return ` (${details.error})`
  }
  return ` (${JSON.stringify(details)})`
}

function printEstimate(estimate: SyncEstimate): void {
  console.log('\n\x1b[1mScope estimate:\x1b[0m')

  for (const entity of estimate.entities) {
    if (entity.count != null) {
      const formatted = entity.count.toLocaleString()
      console.log(`  \x1b[36m${formatted.padStart(10)}\x1b[0m  ${entity.type}`)
    } else {
      console.log(`          \x1b[90m?\x1b[0m  ${entity.type} \x1b[90m(${entity.description})\x1b[0m`)
    }
  }

  if (estimate.summary) {
    console.log(`\n  \x1b[90m${estimate.summary}\x1b[0m`)
  }
}

function printSanityResult(result: SanityCheckResult): void {
  // Show estimate first - this is the most useful info
  if (result.estimate) {
    printEstimate(result.estimate)
  }

  console.log('\nSanity checks:')

  if (result.checks.length === 0) {
    console.log('  (no checks)')
    return
  }

  for (const check of result.checks) {
    let icon = '\x1b[32m✓\x1b[0m'
    if (check.status === 'warning') {
      icon = '\x1b[33m!\x1b[0m'
    } else if (check.status === 'error') {
      icon = '\x1b[31m✗\x1b[0m'
    }
    const details = formatSanityDetails(check.details)
    console.log(`  ${icon} ${check.id}: ${check.message}${details}`)
  }
}

function extractSanityResult(data: unknown): SanityCheckResult | undefined {
  if (!data || typeof data !== 'object') return undefined
  const sanity = (data as { sanity?: SanityCheckResult }).sanity
  if (!sanity || typeof sanity !== 'object') return undefined
  return sanity
}

function printErrorDetails(data: unknown): void {
  const sanity = extractSanityResult(data)
  if (sanity) {
    printSanityResult(sanity)
    return
  }

  if (data && typeof data === 'object') {
    console.log('\nDetails:')
    printJson(data)
  }
}

async function requireConnectorSanity(type: string, config?: Record<string, unknown>): Promise<void> {
  const sanity = await client.connectors.sanity(type, config ?? {})
  printSanityResult(sanity)
  if (!sanity.ok) {
    throw new Error('Sanity checks failed')
  }
}

async function requireTaskSanity(opts: {
  connector: string
  syncType: 'backfill' | 'incremental'
  entityTypes?: string[]
  mode?: 'once' | 'recurring' | 'webhook'
}): Promise<void> {
  const sanity = await client.tasks.sanity(opts)
  printSanityResult(sanity)
  if (!sanity.ok) {
    throw new Error('Sanity checks failed')
  }
}

function printHeader(message: string): void {
  console.log(`\n\x1b[1m${message}\x1b[0m`)
  console.log('─'.repeat(50))
}

function printAccount(account: Account): void {
  console.log(`  \x1b[36m${account.id}\x1b[0m`)
  console.log(`    Connector: ${account.connector}`)
  console.log(`    Email: ${account.email || account.display_name || '-'}`)
  console.log(`    Status: ${account.is_active ? '\x1b[32mactive\x1b[0m' : '\x1b[33minactive\x1b[0m'}`)
  if (account.last_synced_at) {
    console.log(`    Last sync: ${new Date(account.last_synced_at).toLocaleString()}`)
  }
}

function formatInterval(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`
}

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const absDiff = Math.abs(diffMs)
  const isPast = diffMs < 0

  if (absDiff < 60000) return isPast ? 'just now' : 'in <1m'
  const minutes = Math.floor(absDiff / 60000)
  if (minutes < 60) return isPast ? `${minutes}m ago` : `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return isPast ? `${hours}h ago` : `in ${hours}h`
  const days = Math.floor(hours / 24)
  return isPast ? `${days}d ago` : `in ${days}d`
}

function printTask(task: SyncTask, index?: number): void {
  const status = task.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[33mdisabled\x1b[0m'
  const indexLabel = index !== undefined ? `\x1b[90m#${index + 1}\x1b[0m ` : ''
  const shortId = task.id.slice(0, 8)

  console.log(`  ${indexLabel}\x1b[36m${shortId}\x1b[0m \x1b[90m${task.connector}\x1b[0m`)
  console.log(`    Mode: ${task.sync_type} / ${task.mode} ${status}`)

  // Entity types
  if (task.entity_types?.length) {
    console.log(`    Types: ${task.entity_types.join(', ')}`)
  }

  // Scheduling info
  if (task.mode === 'recurring' && task.interval_ms) {
    const cadence = formatInterval(task.interval_ms)
    if (task.next_run_at) {
      const nextRun = new Date(task.next_run_at)
      const relative = formatRelativeTime(nextRun)
      console.log(`    Schedule: every ${cadence} (next: ${relative})`)
    } else {
      console.log(`    Schedule: every ${cadence}`)
    }
  } else if (task.mode === 'webhook') {
    console.log(`    Schedule: real-time (webhook)`)
  } else if (task.mode === 'once') {
    if (task.last_job_id) {
      console.log(`    Schedule: one-shot (completed)`)
    } else {
      console.log(`    Schedule: one-shot (pending)`)
    }
  }

  // Last job reference
  if (task.last_job_id) {
    console.log(`    Last job: ${task.last_job_id.slice(0, 8)}`)
  }

  // Created timestamp
  if (task.created_at) {
    console.log(`    Created: ${formatRelativeTime(new Date(task.created_at))}`)
  }
}

function printJob(job: SyncJob, index?: number): void {
  const statusColors: Record<string, string> = {
    pending: '\x1b[33m',
    running: '\x1b[34m',
    completed: '\x1b[32m',
    failed: '\x1b[31m',
    cancelled: '\x1b[90m',
  }
  const color = statusColors[job.status] || ''
  const indexLabel = index !== undefined ? `\x1b[90m#${index + 1}\x1b[0m ` : ''
  const shortId = job.id.slice(0, 8)

  console.log(`  ${indexLabel}\x1b[36m${shortId}\x1b[0m \x1b[90m${job.connector}\x1b[0m ${color}${job.status}\x1b[0m`)
  console.log(`    Type: ${job.job_type}`)

  // Entity types from metadata
  const entityTypes = job.metadata?.entityTypes as string[] | undefined
  if (entityTypes?.length) {
    console.log(`    Entities: ${entityTypes.join(', ')}`)
  }

  // Progress
  const progressPct = job.items_fetched > 0 ? Math.round((job.items_processed / job.items_fetched) * 100) : 0
  if (job.items_fetched > 0 || job.items_processed > 0) {
    let progressLine = `    Progress: ${job.items_processed}/${job.items_fetched}`
    if (job.status === 'running' && progressPct > 0) {
      progressLine += ` (${progressPct}%)`
    }
    if (job.items_failed > 0) {
      progressLine += ` \x1b[31m${job.items_failed} failed\x1b[0m`
    }
    console.log(progressLine)
  }

  // Timing
  if (job.started_at) {
    const started = new Date(job.started_at)
    if (job.completed_at) {
      const completed = new Date(job.completed_at)
      const durationMs = completed.getTime() - started.getTime()
      const durationSec = Math.round(durationMs / 1000)
      console.log(`    Duration: ${durationSec}s (${formatRelativeTime(completed)})`)
    } else if (job.status === 'running') {
      console.log(`    Started: ${formatRelativeTime(started)}`)
    }
  } else if (job.status === 'pending') {
    console.log(`    Queued: ${formatRelativeTime(new Date(job.created_at))}`)
  }

  // Retry info
  if (job.retry_count > 0) {
    let retryLine = `    Retries: ${job.retry_count}`
    if (job.next_retry_at) {
      retryLine += ` (next: ${formatRelativeTime(new Date(job.next_retry_at))})`
    }
    console.log(retryLine)
  }

  // Error
  if (job.last_error) {
    const truncatedError = job.last_error.length > 80 ? job.last_error.slice(0, 80) + '...' : job.last_error
    console.log(`    \x1b[31mError: ${truncatedError}\x1b[0m`)
  }
}

function printDerivedTask(task: DerivedTask, index?: number): void {
  const status = task.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[33mdisabled\x1b[0m'
  const indexLabel = index !== undefined ? `\x1b[90m#${index + 1}\x1b[0m ` : ''
  const shortId = task.id.slice(0, 8)

  console.log(`  ${indexLabel}\x1b[36m${shortId}\x1b[0m \x1b[90m${task.name}\x1b[0m`)
  console.log(`    Mode: ${task.mode} ${status}`)
  console.log(`    Script: ${task.script_path}`)

  if (task.mode === 'recurring' && task.interval_ms) {
    const cadence = formatInterval(task.interval_ms)
    if (task.next_run_at) {
      const nextRun = new Date(task.next_run_at)
      const relative = formatRelativeTime(nextRun)
      console.log(`    Schedule: every ${cadence} (next: ${relative})`)
    } else {
      console.log(`    Schedule: every ${cadence}`)
    }
  } else if (task.mode === 'event') {
    console.log('    Schedule: event-driven')
  } else if (task.mode === 'once') {
    console.log('    Schedule: one-shot')
  }

  if (task.last_job_id) {
    console.log(`    Last job: ${task.last_job_id.slice(0, 8)}`)
  }

  if (task.created_at) {
    console.log(`    Created: ${formatRelativeTime(new Date(task.created_at))}`)
  }
}

// ============ Commands ============

async function cmdHealth(): Promise<void> {
  printHeader('Health Check')
  const health = await client.health()
  printSuccess('Daemon is healthy')
  console.log(`  Status: ${health.status}`)
  console.log(`  Timestamp: ${health.timestamp}`)
}

// --- Accounts ---

async function cmdAccountsList(): Promise<void> {
  printHeader('Accounts')
  const accounts = await client.accounts.list()
  if (accounts.length === 0) {
    console.log('  No accounts found.')
    console.log('  Use "auth login <connector>" to add an account.')
  } else {
    accounts.forEach(printAccount)
  }
}

async function cmdAccountsGet(id: string): Promise<void> {
  printHeader('Account Details')
  const account = await client.accounts.get(id)
  printAccount(account)
  printJson(account)
}

async function cmdAccountsDelete(id: string): Promise<void> {
  printHeader('Delete Account')
  await client.accounts.delete(id)
  printSuccess(`Account ${id} deactivated`)
}

// --- Auth ---

async function cmdAuthProviders(): Promise<void> {
  printHeader('OAuth Providers')
  const providers = await client.auth.providers()
  if (providers.length === 0) {
    console.log('  No OAuth providers configured.')
    console.log('  Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET for Google.')
  } else {
    providers.forEach((p) => console.log(`  - ${p}`))
  }
}

async function cmdAuthLogin(connector: string, headless = false): Promise<void> {
  printHeader(`OAuth Login: ${connector}`)

  // Headless mode: use device authorization flow
  if (headless) {
    console.log('Using device authorization flow (headless)...\n')

    const device = await client.auth.deviceAuth(connector)

    console.log('╭─────────────────────────────────────────────────╮')
    console.log('│                                                 │')
    console.log(`│   Go to: \x1b[36m${device.verificationUri.padEnd(30)}\x1b[0m │`)
    console.log(`│   Enter code: \x1b[1m${device.userCode.padEnd(25)}\x1b[0m    │`)
    console.log('│                                                 │')
    console.log('╰─────────────────────────────────────────────────╯')

    if (device.verificationUriComplete) {
      console.log(`\nOr visit: ${device.verificationUriComplete}`)
    }

    console.log('\nWaiting for authorization...')

    const account = await client.auth.waitForDeviceAuth(connector, device.deviceCode, {
      interval: (device.interval || 5) * 1000,
      timeout: device.expiresIn * 1000,
      onPoll: () => process.stdout.write('.'),
    })

    console.log('\n')
    printSuccess('Account created successfully!')
    printAccount(account)
    return
  }

  // Browser-based flow
  const redirectUri = OAUTH_REDIRECT_URI || getCallbackUri(CALLBACK_PORT)
  const useLocalCallback = !OAUTH_REDIRECT_URI
  const daemonHandlesCallback = OAUTH_REDIRECT_URI?.includes('/api/auth/callback')

  const authResponse = await client.auth.getUrl(connector, redirectUri)
  const { url, state, existingCredentials, existingAccountId } = authResponse

  // Check if we can reuse existing credentials
  if (existingCredentials && existingAccountId) {
    console.log(`\x1b[33mFound existing ${authResponse.provider || 'OAuth'} credentials from another connector.\x1b[0m\n`)
    console.log('Options:')
    console.log('  \x1b[1m1.\x1b[0m Use existing credentials (no browser needed)')
    console.log('  \x1b[1m2.\x1b[0m Authenticate again with browser\n')

    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const choice = await new Promise<string>((resolve) => {
      rl.question('Choice [1]: ', (answer) => {
        rl.close()
        resolve(answer.trim() || '1')
      })
    })

    if (choice !== '2') {
      console.log('\nReusing existing credentials...')
      const account = await client.auth.fromExisting(connector, existingAccountId)
      printSuccess('Account created using existing credentials!')
      printAccount(account)
      return
    }

    console.log('\nProceeding with browser OAuth...')
  }

  if (daemonHandlesCallback) {
    console.log('Opening browser for OAuth...')
    const open = (await import('open')).default
    await open(url)

    console.log('\nThe daemon will handle the OAuth callback automatically.')
    console.log('Check the browser for success/error message.')
    console.log('\nAfter authorizing, run:')
    console.log('  bun run scripts/sync-api-cli.ts accounts list')
    return
  }

  if (useLocalCallback) {
    console.log('Opening browser for OAuth...')
    const result = await captureOAuthCallback(url, { port: CALLBACK_PORT })

    console.log('\nExchanging authorization code...')
    const account = await client.auth.callback(connector, result.code, result.state, redirectUri)
    printSuccess('Account created successfully!')
    printAccount(account)
  } else {
    console.log('Opening browser for OAuth...')
    const open = (await import('open')).default
    await open(url)

    console.log('\nAfter authorizing, paste the "code" parameter from the callback URL:')
    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const code = await new Promise<string>((resolve) => {
      rl.question('\nCode: ', (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    })

    if (!code) {
      throw new Error('No authorization code provided')
    }

    console.log('\nExchanging authorization code...')
    const account = await client.auth.callback(connector, code, state, redirectUri)
    printSuccess('Account created successfully!')
    printAccount(account)
  }
}

async function cmdAuthStatus(accountId: string): Promise<void> {
  printHeader('Auth Status')
  const status = await client.auth.status(accountId)
  console.log(`  Account: ${status.accountId}`)
  console.log(`  Has credentials: ${status.hasCredentials ? '\x1b[32myes\x1b[0m' : '\x1b[31mno\x1b[0m'}`)
}

async function cmdAuthRefresh(accountId: string): Promise<void> {
  printHeader('Refresh Token')
  await client.auth.refresh(accountId)
  printSuccess(`Token refreshed for ${accountId}`)
}

// --- Connectors ---

async function cmdConnectorsList(): Promise<void> {
  printHeader('Registered Connectors')
  const connectors = await client.connectors.list()
  if (connectors.length === 0) {
    console.log('  No connectors registered.')
    console.log('  Use "connectors available" to see available factories.')
  } else {
    for (const c of connectors) {
      console.log(`  \x1b[36m${c.type}\x1b[0m - ${c.displayName}`)
      console.log(`    Entity types: ${c.entityTypes.join(', ')}`)
      console.log(`    Auth: ${c.authType}`)
    }
  }
}

async function cmdConnectorsAvailable(): Promise<void> {
  printHeader('Available Connector Factories')
  const available = await client.connectors.available()
  if (available.length === 0) {
    console.log('  All factories are registered.')
  } else {
    console.log('  The following connector types can be registered:\n')
    for (const type of available) {
      console.log(`    \x1b[33m${type}\x1b[0m`)
    }
    console.log('\n  Register with: connectors register <type>')
  }
}

// ============ Connector Config Fields ============
// Defines prompts for connector-specific configuration

interface ConfigField {
  key: string
  label: string
  description: string
  required?: boolean
  secret?: boolean
  envVar?: string
  defaultValue?: string
}

const CONNECTOR_CONFIG_FIELDS: Record<string, ConfigField[]> = {
  telegram: [
    {
      key: 'botToken',
      label: 'Bot Token',
      description: 'Token from @BotFather (starts with numbers:letters)',
      required: true,
      secret: true,
      envVar: 'TELEGRAM_BOT_TOKEN',
    },
    {
      key: 'dangerousMode',
      label: 'Allow all users',
      description: 'Skip user ID restrictions (true/false)',
      defaultValue: 'false',
    },
  ],
  github: [
    {
      key: 'clientId',
      label: 'Client ID',
      description: 'GitHub OAuth App client ID',
      required: true,
      envVar: 'GITHUB_CLIENT_ID',
    },
    {
      key: 'clientSecret',
      label: 'Client Secret',
      description: 'GitHub OAuth App client secret',
      required: true,
      secret: true,
      envVar: 'GITHUB_CLIENT_SECRET',
    },
  ],
  gmail: [
    {
      key: 'clientId',
      label: 'Client ID',
      description: 'Google OAuth client ID',
      required: true,
      envVar: 'GOOGLE_CLIENT_ID',
    },
    {
      key: 'clientSecret',
      label: 'Client Secret',
      description: 'Google OAuth client secret',
      required: true,
      secret: true,
      envVar: 'GOOGLE_CLIENT_SECRET',
    },
  ],
  xcom: [
    {
      key: 'bearerToken',
      label: 'Bearer Token',
      description: 'X.com API bearer token',
      secret: true,
      envVar: 'XCOM_BEARER_TOKEN',
    },
  ],
  imessage: [
    {
      key: 'databasePath',
      label: 'Database Path',
      description: 'Path to chat.db (default: ~/Library/Messages/chat.db)',
    },
  ],
  claude_sessions: [
    {
      key: 'projectsPath',
      label: 'Projects Path',
      description: 'Path to Claude projects (default: ~/.claude/projects)',
    },
  ],
  rex_sessions: [
    {
      key: 'sessionsPath',
      label: 'Sessions Path',
      description: 'Path to Rex sessions directory',
      required: true,
    },
  ],
}

// ============ Derived Script Discovery ============
// Known directory for derived task scripts, relative to project root

const DERIVED_SCRIPTS_DIR = 'packages/agent-memory/scripts'

/** Scan for derive*.ts scripts (excluding test files) */
function discoverDerivedScripts(): { name: string; path: string }[] {
  try {
    const absDir = path.resolve(process.cwd(), DERIVED_SCRIPTS_DIR)
    const files = readdirSync(absDir)
    return files
      .filter((f) => /^derive[_-].*\.ts$/.test(f) && !f.includes('.test.'))
      .sort()
      .map((f) => ({
        name: f.replace(/\.ts$/, ''),
        path: `${DERIVED_SCRIPTS_DIR}/${f}`,
      }))
  } catch {
    return []
  }
}

/** Known metadata fields per script. Key is the script filename (without extension). */
const DERIVED_SCRIPT_METADATA: Record<string, ConfigField[]> = {
  'derive-example': [
    {
      key: 'limit',
      label: 'Entity limit',
      description: 'Max entities to query (default: 1000)',
    },
  ],
  derive_preferences: [
    {
      key: 'limit',
      label: 'Conversation limit',
      description: 'Max conversations to process per run (default: 200)',
    },
    {
      key: 'max_chunks',
      label: 'Max chunks',
      description: 'Max Gemini request chunks to send (default: 12)',
    },
  ],
  derive_preference_embeddings: [
    {
      key: 'limit',
      label: 'Preference limit',
      description: 'Max preferences to embed per run (default: 500)',
      envVar: 'OPENAI_API_KEY',
    },
  ],
  'derive-daily-digest': [
    {
      key: 'telegramChatId',
      label: 'Telegram Chat ID',
      description: 'Telegram chat ID to send digest to',
      envVar: 'TELEGRAM_ALLOWED_USERS',
    },
    {
      key: 'sessionKey',
      label: 'Session Key',
      description: 'Harness session key (default: daily-digest)',
    },
    {
      key: 'harnessHost',
      label: 'Harness Host',
      description: 'Harness daemon host (default: localhost)',
      envVar: 'HARNESS_HOST',
    },
    {
      key: 'harnessPort',
      label: 'Harness Port',
      description: 'Harness daemon port (default: 4000)',
      envVar: 'HARNESS_PORT',
    },
    {
      key: 'maxConversations',
      label: 'Max Conversations',
      description: 'Max conversations to include in digest (default: 50)',
    },
    {
      key: 'outputDir',
      label: 'Output Directory',
      description: 'Directory for digest output files (default: data/daily-digest)',
    },
  ],
}

async function cmdConnectorRegister(type: string, configJson?: string): Promise<void> {
  printHeader(`Register Connector: ${type}`)

  let config: Record<string, unknown> | undefined

  if (configJson) {
    // JSON provided directly
    try {
      config = JSON.parse(configJson)
    } catch {
      throw new Error('Invalid JSON config')
    }
  } else {
    // Interactive mode - prompt for config fields
    const fields = CONNECTOR_CONFIG_FIELDS[type]

    if (fields && fields.length > 0) {
      console.log(`  \x1b[90mConfiguring ${type}...\x1b[0m\n`)
      config = {}

      for (const field of fields) {
        // Check for env var first
        const envValue = field.envVar ? process.env[field.envVar] : undefined
        if (envValue) {
          config[field.key] = field.key.includes('Mode') ? envValue === 'true' : envValue
          console.log(`  \x1b[32m✓\x1b[0m ${field.label}: \x1b[90m(from ${field.envVar})\x1b[0m`)
          continue
        }

        // Build prompt
        const reqLabel = field.required ? ' \x1b[31m*\x1b[0m' : ''
        const hint = field.envVar ? ` \x1b[90m(or set ${field.envVar})\x1b[0m` : ''
        console.log(`  ${field.label}${reqLabel}${hint}`)
        console.log(`  \x1b[90m${field.description}\x1b[0m`)

        const value = await prompt('  > ', field.defaultValue)

        if (value) {
          // Parse booleans
          if (value === 'true' || value === 'false') {
            config[field.key] = value === 'true'
          } else {
            config[field.key] = value
          }
        } else if (field.required) {
          throw new Error(`${field.label} is required`)
        }

        console.log('')
      }

      // Confirm
      console.log('  Config to register:')
      for (const [k, v] of Object.entries(config)) {
        const field = fields.find((f) => f.key === k)
        const display = field?.secret ? '********' : String(v)
        console.log(`    ${k}: ${display}`)
      }
      console.log('')

      const confirmed = await promptConfirm('  Register with this config?')
      if (!confirmed) {
        console.log('  Cancelled.')
        return
      }
    }
  }

  await requireConnectorSanity(type, config)

  const result = await client.connectors.register(type, config)
  printSuccess(`Connector ${type} registered`)

  if (result.connector) {
    console.log(`  Display name: ${result.connector.displayName}`)
    console.log(`  Entity types: ${result.connector.entityTypes.join(', ')}`)
    console.log(`  Auth type: ${result.connector.authType}`)
  }

  if (result.registration) {
    console.log(`  Enabled: ${result.registration.enabled}`)
    if (Object.keys(result.registration.config).length > 0) {
      console.log(`  Config: ${JSON.stringify(result.registration.config)}`)
    }
  }
}

async function cmdConnectorConfig(type: string, configJson: string): Promise<void> {
  printHeader(`Update Config: ${type}`)

  let config: Record<string, unknown>
  try {
    config = JSON.parse(configJson)
  } catch {
    throw new Error('Invalid JSON config')
  }

  const result = await client.connectors.updateConfig(type, config)
  printSuccess(`Config updated for ${type}`)
  console.log(`  New config: ${JSON.stringify(result.registration?.config)}`)
}

async function cmdConnectorEnable(type: string): Promise<void> {
  printHeader(`Enable Connector: ${type}`)
  await client.connectors.setEnabled(type, true)
  printSuccess(`Connector ${type} enabled`)
}

async function cmdConnectorDisable(type: string): Promise<void> {
  printHeader(`Disable Connector: ${type}`)
  await client.connectors.setEnabled(type, false)
  printSuccess(`Connector ${type} disabled (unloaded from memory)`)
}

async function cmdConnectorUnregister(type: string): Promise<void> {
  printHeader(`Unregister Connector: ${type}`)
  await client.connectors.unregister(type)
  printSuccess(`Connector ${type} unregistered`)
}

async function cmdConnectorInfo(type: string): Promise<void> {
  printHeader(`Connector: ${type}`)
  const response = await client.connectors.get(type)

  if (!response.connector) {
    if (response.factoryAvailable) {
      console.log(`  Factory available but not registered.`)
      console.log(`  Register with: connectors register ${type}`)
    } else {
      console.log(`  Connector not found: ${type}`)
    }
    if (response.registration) {
      console.log(`\n  Registration:`)
      console.log(`    Enabled: ${response.registration.enabled}`)
      console.log(`    Config: ${JSON.stringify(response.registration.config)}`)
    }
    return
  }

  const connector = response.connector
  console.log(`  Display name: ${connector.displayName}`)
  console.log(`  Entity types: ${connector.entityTypes.join(', ')}`)
  console.log(`  Auth type: ${connector.authType}`)
  console.log(`  Capabilities:`)
  console.log(`    - Backfill: ${connector.capabilities.backfill ? 'yes' : 'no'}`)
  console.log(`    - Incremental: ${connector.capabilities.incremental ? 'yes' : 'no'}`)
  console.log(`    - Webhook: ${connector.capabilities.webhook ? 'yes' : 'no'}`)
  console.log(`    - Write: ${connector.capabilities.write ? 'yes' : 'no'}`)

  if (response.registration) {
    console.log(`\n  Registration:`)
    console.log(`    Enabled: ${response.registration.enabled}`)
    if (Object.keys(response.registration.config).length > 0) {
      console.log(`    Config: ${JSON.stringify(response.registration.config)}`)
    }
  }

  // Show accounts for this connector
  try {
    const accounts = await client.connectors.accounts(type)
    if (accounts.length > 0) {
      console.log(`\n  Accounts:`)
      for (const a of accounts) {
        console.log(`    - ${a.id} (${a.email || a.display_name || 'no name'})`)
      }
    } else if (connector.authType === 'local') {
      // Local auth connectors auto-create accounts when needed
      console.log(`\n  No accounts. Accounts are auto-created for local connectors.`)
    } else {
      console.log(`\n  No accounts. Run: auth login ${type}`)
    }
  } catch {
    // Connector not loaded, can't get accounts
  }
}

// --- Tasks ---

async function cmdTasksList(connector?: string): Promise<void> {
  printHeader('Sync Tasks')
  const tasks = await client.tasks.list(connector ? { connector } : undefined)
  lastTasksList = tasks // Cache for short ID resolution
  if (tasks.length === 0) {
    console.log('  No tasks found.')
    console.log('  Use "tasks <connector> create" to create a sync task.')
  } else {
    tasks.forEach((task, i) => printTask(task, i))
    console.log(`\n  \x1b[90mTip: Use #1, #2, etc. to reference tasks (e.g., "tasks get #1")\x1b[0m`)
  }
}

async function cmdTasksGet(id: string): Promise<void> {
  const resolvedId = await resolveTaskId(id)
  printHeader('Task Details')
  const { task, recentJobs } = await client.tasks.get(resolvedId)
  printTask(task)

  // Show full ID for copying
  console.log(`\n  Full ID: \x1b[36m${task.id}\x1b[0m`)

  if (recentJobs && recentJobs.length > 0) {
    console.log('\n  Recent jobs:')
    recentJobs.slice(0, 5).forEach((job) => {
      const statusColors: Record<string, string> = {
        pending: '\x1b[33m',
        running: '\x1b[34m',
        completed: '\x1b[32m',
        failed: '\x1b[31m',
        cancelled: '\x1b[90m',
      }
      const color = statusColors[job.status] || ''
      const shortId = job.id.slice(0, 8)
      console.log(`    ${shortId} ${color}${job.status}\x1b[0m ${job.items_processed}/${job.items_fetched}`)
    })
  }
}

// ============ Interactive Helpers ============

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const readline = await import('readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

async function promptSelect(question: string, options: string[], defaultIndex = 0): Promise<string> {
  console.log(`\n${question}`)
  options.forEach((opt, i) => {
    const marker = i === defaultIndex ? '\x1b[36m→\x1b[0m' : ' '
    console.log(`  ${marker} ${i + 1}. ${opt}`)
  })
  const answer = await prompt('Select', String(defaultIndex + 1))
  const idx = parseInt(answer, 10) - 1
  if (idx >= 0 && idx < options.length) {
    return options[idx]
  }
  return options[defaultIndex]
}

async function promptMultiSelect(question: string, options: string[], defaults: string[] = []): Promise<string[]> {
  console.log(`\n${question}`)
  console.log('  \x1b[90m(Enter numbers separated by commas, or "all")\x1b[0m')
  options.forEach((opt, i) => {
    const isDefault = defaults.includes(opt)
    const marker = isDefault ? '\x1b[32m✓\x1b[0m' : ' '
    console.log(`  ${marker} ${i + 1}. ${opt}`)
  })

  const defaultStr = defaults.length === options.length ? 'all' : defaults.map((d) => options.indexOf(d) + 1).join(',')
  const answer = await prompt('Select', defaultStr || 'all')

  if (answer.toLowerCase() === 'all') {
    return options
  }

  const indices = answer.split(',').map((s) => parseInt(s.trim(), 10) - 1)
  const selected = indices.filter((i) => i >= 0 && i < options.length).map((i) => options[i])
  return selected.length > 0 ? selected : options
}

async function promptConfirm(question: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? '[Y/n]' : '[y/N]'
  const answer = await prompt(`${question} ${hint}`)
  if (!answer) return defaultValue
  return answer.toLowerCase().startsWith('y')
}

/**
 * Interactive task creation wizard.
 * Walks through sync type, mode, entity types, and cadence.
 */
async function cmdTasksCreate(connector: string): Promise<void> {
  printHeader(`Create Task: ${connector}`)

  // 1. Fetch connector info
  console.log('Fetching connector info...')
  const response = await client.connectors.get(connector)

  if (!response.connector) {
    if (response.factoryAvailable) {
      throw new Error(`Connector "${connector}" is not registered. Run: connectors register ${connector}`)
    }
    throw new Error(`Unknown connector: ${connector}`)
  }

  const info = response.connector
  const caps = info.capabilities

  console.log(`\n\x1b[1m${info.displayName}\x1b[0m`)
  console.log(`  Entity types: ${info.entityTypes.join(', ')}`)
  console.log(`  Capabilities: ${[caps.backfill && 'backfill', caps.incremental && 'incremental', caps.webhook && 'webhook'].filter(Boolean).join(', ')}`)

  // 2. Select sync type
  const syncTypeOptions: string[] = []
  if (caps.backfill) syncTypeOptions.push('backfill')
  if (caps.incremental) syncTypeOptions.push('incremental')

  if (syncTypeOptions.length === 0) {
    throw new Error('Connector has no sync capabilities')
  }

  const syncType = syncTypeOptions.length === 1
    ? syncTypeOptions[0]
    : await promptSelect('Sync type?', [
        'backfill    - Full historical sync (fetches everything)',
        'incremental - Changes only (requires prior backfill)',
      ].filter((_, i) => syncTypeOptions.includes(['backfill', 'incremental'][i])))
        .then((s) => s.split(' ')[0])

  // 3. Select mode based on sync type
  const modeOptions: { value: string; label: string }[] = []

  if (syncType === 'backfill') {
    // Backfill is always one-shot
    modeOptions.push({ value: 'once', label: 'once - Run once and complete' })
  } else {
    // Incremental can be recurring or webhook
    modeOptions.push({ value: 'recurring', label: 'recurring - Run on a schedule' })
    if (caps.webhook) {
      modeOptions.push({ value: 'webhook', label: 'webhook   - Real-time push notifications' })
    }
    modeOptions.push({ value: 'once', label: 'once      - Run once (manual trigger)' })
  }

  const mode = modeOptions.length === 1
    ? modeOptions[0].value
    : await promptSelect('Mode?', modeOptions.map((m) => m.label)).then((s) => s.split(' ')[0])

  // 4. Select entity types
  const entityTypes = await promptMultiSelect(
    'Entity types to sync?',
    info.entityTypes,
    info.entityTypes // default to all
  )

  // 5. Interval for recurring mode
  let intervalMs: number | undefined
  if (mode === 'recurring') {
    console.log('\n\x1b[90mCommon intervals: 5m, 15m, 30m, 1h, 6h, 24h\x1b[0m')
    const intervalStr = await prompt('Sync interval', '1h')

    // Parse interval string (e.g., "5m", "1h", "30")
    const match = intervalStr.match(/^(\d+)\s*(m|min|h|hr|hour|d|day)?$/i)
    if (!match) {
      throw new Error(`Invalid interval format: ${intervalStr}. Use formats like: 5m, 1h, 30`)
    }

    const value = parseInt(match[1], 10)
    const unit = (match[2] || 'm').toLowerCase()

    switch (unit[0]) {
      case 'm':
        intervalMs = value * 60 * 1000
        break
      case 'h':
        intervalMs = value * 60 * 60 * 1000
        break
      case 'd':
        intervalMs = value * 24 * 60 * 60 * 1000
        break
      default:
        intervalMs = value * 60 * 1000
    }

    if (intervalMs < 60000) {
      throw new Error('Interval must be at least 1 minute')
    }
  }

  // 6. Show summary and confirm
  console.log('\n' + '─'.repeat(50))
  console.log('\x1b[1mTask Summary\x1b[0m')
  console.log(`  Connector:    ${connector}`)
  console.log(`  Sync type:    ${syncType}`)
  console.log(`  Mode:         ${mode}`)
  console.log(`  Entity types: ${entityTypes.join(', ')}`)
  if (intervalMs) {
    console.log(`  Interval:     ${formatInterval(intervalMs)}`)
  }
  console.log('─'.repeat(50))

  const confirmed = await promptConfirm('\nCreate this task?')
  if (!confirmed) {
    console.log('\nCancelled.')
    return
  }

  const sanityEntityTypes = entityTypes.length === info.entityTypes.length ? undefined : entityTypes
  await requireTaskSanity({
    connector,
    syncType: syncType as 'backfill' | 'incremental',
    entityTypes: sanityEntityTypes,
    mode: mode as 'once' | 'recurring' | 'webhook',
  })

  // 7. Create the task
  console.log('\nCreating task...')

  if (syncType === 'backfill' && mode === 'once') {
    // Use backfill endpoint (creates task + job)
    const { task, job } = await client.tasks.backfill({
      connector,
      entityTypes: sanityEntityTypes,
    })
    printSuccess('Backfill task created and job scheduled')
    printTask(task)
    console.log(`\n  Job ID: ${job.id.slice(0, 8)}`)
    console.log(`  Monitor: jobs get ${job.id.slice(0, 8)}`)
  } else if (mode === 'webhook') {
    // Use webhook endpoint
    const task = await client.tasks.webhook({
      connector,
      entityTypes: sanityEntityTypes,
    })
    printSuccess('Webhook task created')
    printTask(task)
    console.log('\n  Note: Webhooks may require additional provider setup.')
  } else if (mode === 'recurring') {
    // Use subscribe endpoint
    const task = await client.tasks.subscribe({
      connector,
      syncType: syncType as 'backfill' | 'incremental',
      intervalMs: intervalMs!,
      entityTypes: sanityEntityTypes,
    })
    printSuccess('Recurring task created')
    printTask(task)
  } else {
    // One-shot incremental - create recurring task, trigger immediately, then disable
    const task = await client.tasks.subscribe({
      connector,
      syncType: syncType as 'backfill' | 'incremental',
      intervalMs: 24 * 60 * 60 * 1000, // placeholder, task will be triggered manually
      entityTypes: sanityEntityTypes,
    })
    // Trigger first while still enabled
    const job = await client.tasks.trigger(task.id)
    // Then disable to prevent recurring runs
    await client.tasks.disable(task.id)
    printSuccess('One-shot incremental task created and triggered')
    const updatedTask = await client.tasks.get(task.id)
    printTask(updatedTask.task)
    console.log(`\n  Job ID: ${job.id.slice(0, 8)}`)
    console.log(`  Monitor: jobs get ${job.id.slice(0, 8)}`)
  }
}

async function cmdTasksTrigger(id: string): Promise<void> {
  const resolvedId = await resolveTaskId(id)
  printHeader('Trigger Task')
  const job = await client.tasks.trigger(resolvedId)
  printSuccess('Task triggered')
  console.log(`  Job ID: ${job.id.slice(0, 8)}`)
  console.log(`\n  Monitor: jobs get ${job.id.slice(0, 8)}`)
}

async function cmdTasksEnable(id: string): Promise<void> {
  const resolvedId = await resolveTaskId(id)
  printHeader('Enable Task')
  await client.tasks.enable(resolvedId)
  printSuccess(`Task ${resolvedId.slice(0, 8)} enabled`)
}

async function cmdTasksDisable(id: string): Promise<void> {
  const resolvedId = await resolveTaskId(id)
  printHeader('Disable Task')
  await client.tasks.disable(resolvedId)
  printSuccess(`Task ${resolvedId.slice(0, 8)} disabled`)
}

async function cmdTasksDelete(id: string): Promise<void> {
  const resolvedId = await resolveTaskId(id)
  printHeader('Delete Task')
  await client.tasks.delete(resolvedId)
  printSuccess(`Task ${resolvedId.slice(0, 8)} deleted`)
}

// --- Derived Tasks ---

async function cmdDerivedTasksList(): Promise<void> {
  printHeader('Derived Tasks')
  const tasks = await client.derivedTasks.list()
  lastDerivedTasksList = tasks
  if (tasks.length === 0) {
    console.log('  No derived tasks found.')
    console.log('  Use "derived-tasks create" to create a derived task.')
  } else {
    tasks.forEach((task, i) => printDerivedTask(task, i))
    console.log(`\n  \x1b[90mTip: Use #1, #2, etc. to reference derived tasks (e.g., "derived-tasks run #1")\x1b[0m`)
  }
}

async function cmdDerivedTasksCreate(): Promise<void> {
  printHeader('Create Derived Task')

  // 1. Discover available scripts
  const scripts = discoverDerivedScripts()
  let scriptPath: string

  if (scripts.length > 0) {
    const options = [
      ...scripts.map((s) => `${s.name.padEnd(35)} ${s.path}`),
      'other'.padEnd(35) + ' Enter a custom path',
    ]
    const selected = await promptSelect('Select script', options)

    if (selected.trim().startsWith('other')) {
      const custom = await prompt('Script path')
      if (!custom) throw new Error('Script path is required')
      scriptPath = custom
    } else {
      // Extract path from the selected option (after the padded name)
      const selectedIdx = options.indexOf(selected)
      scriptPath = scripts[selectedIdx].path
    }
  } else {
    console.log('  \x1b[33m!\x1b[0m No scripts found in ' + DERIVED_SCRIPTS_DIR)
    const custom = await prompt('Script path')
    if (!custom) throw new Error('Script path is required')
    scriptPath = custom
  }

  // 2. Validate script exists
  const resolvedScript = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath)
  if (!existsSync(resolvedScript)) {
    throw new Error(`Script not found: ${resolvedScript}\n  Check the path and try again.`)
  }

  // 3. Task name (default from script filename)
  const scriptBaseName = path.basename(scriptPath, '.ts')
  const name = await prompt('Task name', scriptBaseName)
  if (!name) {
    throw new Error('Task name is required')
  }

  // 4. Mode selection
  const mode = await promptSelect('Mode?', [
    'once      - Run once and complete',
    'recurring - Run on a schedule',
    'event     - Triggered by external events',
  ]).then((s) => s.split(' ')[0] as 'once' | 'recurring' | 'event')

  // 5. Interval for recurring
  let intervalMs: number | undefined
  if (mode === 'recurring') {
    console.log('\n\x1b[90mCommon intervals: 5m, 15m, 30m, 1h, 6h, 24h\x1b[0m')
    const intervalStr = await prompt('Run interval', '1h')
    const match = intervalStr.match(/^(\d+)\s*(m|min|h|hr|hour|d|day)?$/i)
    if (!match) {
      throw new Error(`Invalid interval format: ${intervalStr}. Use formats like: 5m, 1h, 30`)
    }

    const value = parseInt(match[1], 10)
    const unit = (match[2] || 'm').toLowerCase()

    switch (unit[0]) {
      case 'm':
        intervalMs = value * 60 * 1000
        break
      case 'h':
        intervalMs = value * 60 * 60 * 1000
        break
      case 'd':
        intervalMs = value * 24 * 60 * 60 * 1000
        break
      default:
        intervalMs = value * 60 * 1000
    }

    if (intervalMs < 60000) {
      throw new Error('Interval must be at least 1 minute')
    }
  }

  // 6. Metadata - interactive prompts for known scripts, raw JSON fallback
  let metadata: Record<string, unknown> | undefined
  const knownFields = DERIVED_SCRIPT_METADATA[scriptBaseName]

  if (knownFields && knownFields.length > 0) {
    console.log('\n\x1b[1mScript configuration\x1b[0m')
    console.log('  \x1b[90mThese values are passed to the script as task.metadata.\x1b[0m')
    console.log('  \x1b[90mLeave blank for defaults.\x1b[0m\n')

    metadata = {}
    for (const field of knownFields) {
      const envValue = field.envVar ? process.env[field.envVar] : undefined
      if (envValue && field.secret) {
        console.log(`  \x1b[32m✓\x1b[0m ${field.label}: \x1b[90m(from ${field.envVar})\x1b[0m`)
        continue // env vars for secrets don't go into metadata — the script reads them directly
      }

      const reqLabel = field.required ? ' \x1b[31m*\x1b[0m' : ''
      const envHint = field.envVar ? ` \x1b[90m(env: ${field.envVar})\x1b[0m` : ''
      console.log(`  ${field.label}${reqLabel}${envHint}`)
      console.log(`  \x1b[90m${field.description}\x1b[0m`)

      const value = await prompt('  > ', field.defaultValue)
      if (value) {
        // Parse numbers and booleans
        if (/^\d+$/.test(value)) {
          metadata[field.key] = parseInt(value, 10)
        } else if (value === 'true' || value === 'false') {
          metadata[field.key] = value === 'true'
        } else {
          metadata[field.key] = value
        }
      } else if (field.required) {
        throw new Error(`${field.label} is required`)
      }
      console.log('')
    }

    // Remove empty metadata
    if (Object.keys(metadata).length === 0) {
      metadata = undefined
    }
  } else {
    // Unknown script — offer raw JSON with explanation
    console.log('\n  \x1b[90mMetadata is passed to the script as task.metadata (a JSON object).\x1b[0m')
    console.log('  \x1b[90mScripts use it for runtime configuration (limits, API keys, output paths, etc).\x1b[0m')
    const metadataStr = await prompt('Metadata JSON (optional)', '')
    if (metadataStr) {
      try {
        metadata = JSON.parse(metadataStr)
      } catch {
        throw new Error('Metadata must be valid JSON')
      }
    }
  }

  // 7. Summary and confirm
  console.log('\n' + '─'.repeat(50))
  console.log('\x1b[1mDerived Task Summary\x1b[0m')
  console.log(`  Name:   ${name}`)
  console.log(`  Script: ${scriptPath}`)
  console.log(`  Mode:   ${mode}`)
  if (intervalMs) {
    console.log(`  Interval: ${formatInterval(intervalMs)}`)
  }
  if (metadata) {
    console.log(`  Config: ${JSON.stringify(metadata)}`)
  }
  console.log('─'.repeat(50))

  const confirmed = await promptConfirm('\nCreate this task?')
  if (!confirmed) {
    console.log('\nCancelled.')
    return
  }

  const created = await client.derivedTasks.create({
    name,
    scriptPath,
    mode,
    intervalMs,
    metadata,
  })

  printSuccess('Derived task created')
  printDerivedTask(created.task)

  if (created.sandbox) {
    console.log('\n  Sandbox validation:')
    console.log(`    Status: ${created.sandbox.status}`)
    console.log(`    Job ID: ${created.sandbox.job.id.slice(0, 8)}`)
    if (created.sandbox.lastError) {
      console.log(`    Error: ${created.sandbox.lastError}`)
    }
    if (created.sandbox.logPath) {
      console.log(`    Log: ${created.sandbox.logPath}`)
    }
  } else if (created.sandboxError) {
    console.log('\n  Sandbox validation failed to start:')
    console.log(`    Error: ${created.sandboxError}`)
  }
}

async function cmdDerivedTasksRun(id: string): Promise<void> {
  const resolvedId = await resolveDerivedTaskId(id)
  printHeader('Run Derived Task')
  const job = await client.derivedTasks.run(resolvedId)
  printSuccess('Derived task triggered')
  console.log(`  Job ID: ${job.id.slice(0, 8)}`)
  console.log(`\n  Monitor: derived-jobs get ${job.id.slice(0, 8)}`)
}

// --- Jobs ---

async function cmdJobsList(): Promise<void> {
  printHeader('Sync Jobs')
  const jobs = await client.jobs.list({ limit: 20 })
  lastJobsList = jobs // Cache for short ID resolution
  if (jobs.length === 0) {
    console.log('  No jobs found.')
  } else {
    jobs.forEach((job, i) => printJob(job, i))
    console.log(`\n  \x1b[90mTip: Use #1, #2, etc. to reference jobs (e.g., "jobs get #1")\x1b[0m`)
  }
}

async function cmdJobsGet(id: string): Promise<void> {
  const resolvedId = await resolveJobId(id)
  printHeader('Job Details')
  const { job, queueStats } = await client.jobs.get(resolvedId)
  printJob(job)

  // Show full ID for copying
  console.log(`\n  Full ID: \x1b[36m${job.id}\x1b[0m`)

  if (queueStats) {
    console.log('\n  Queue stats:')
    console.log(`    Pending: ${queueStats.pending}`)
    console.log(`    Running: ${queueStats.running}`)
    console.log(`    Completed: ${queueStats.completed}`)
    console.log(`    Failed: ${queueStats.failed}`)
    if (queueStats.avgProcessTime) {
      console.log(`    Avg time: ${Math.round(queueStats.avgProcessTime / 1000)}s`)
    }
  }
}

async function cmdJobsCancel(id: string): Promise<void> {
  const resolvedId = await resolveJobId(id)
  printHeader('Cancel Job')
  const job = await client.jobs.cancel(resolvedId)
  printSuccess(`Job ${resolvedId.slice(0, 8)} cancelled`)
  printJob(job)
}

async function cmdJobsRetry(id: string): Promise<void> {
  const resolvedId = await resolveJobId(id)
  printHeader('Retry Job')
  const { job } = await client.jobs.retry(resolvedId)
  printSuccess('New job scheduled')
  console.log(`  New job ID: ${job.id.slice(0, 8)}`)
  console.log(`\n  Monitor: jobs get ${job.id.slice(0, 8)}`)
}

// --- Derived Jobs ---

async function cmdDerivedJobsList(): Promise<void> {
  printHeader('Derived Jobs')
  const jobs = await client.derivedJobs.list({ limit: 20 })
  lastDerivedJobsList = jobs
  if (lastDerivedTasksList.length === 0) {
    lastDerivedTasksList = await client.derivedTasks.list()
  }
  const taskNameMap = new Map(lastDerivedTasksList.map((t) => [t.id, t.name]))
  if (jobs.length === 0) {
    console.log('  No derived jobs found.')
  } else {
    jobs.forEach((job, i) => {
      const status = job.status
      const shortId = job.id.slice(0, 8)
      const indexLabel = `\x1b[90m#${i + 1}\x1b[0m `
      const taskName = taskNameMap.get(job.task_id)
      const taskLabel = taskName ? `\x1b[33m${taskName}\x1b[0m` : job.task_id.slice(0, 8)
      console.log(`  ${indexLabel}\x1b[36m${shortId}\x1b[0m ${status}  ${taskLabel}`)
    })
    console.log(`\n  \x1b[90mTip: Use #1, #2, etc. to reference derived jobs (e.g., "derived-jobs get #1")\x1b[0m`)
  }
}

async function cmdDerivedJobsGet(id: string): Promise<void> {
  const resolvedId = await resolveDerivedJobId(id)
  printHeader('Derived Job Details')
  const { job, queueStats } = await client.derivedJobs.get(resolvedId)
  if (lastDerivedTasksList.length === 0) {
    lastDerivedTasksList = await client.derivedTasks.list()
  }
  const taskName = lastDerivedTasksList.find((t) => t.id === job.task_id)?.name
  console.log(`  \x1b[36m${job.id}\x1b[0m ${job.status}`)
  console.log(`    Task: ${taskName ? `\x1b[33m${taskName}\x1b[0m (${job.task_id.slice(0, 8)})` : job.task_id}`)
  if (job.output_ref) console.log(`    Output: ${job.output_ref}`)
  if (job.metadata?._logPath) console.log(`    Log: ${job.metadata._logPath}`)
  if (job.last_error) console.log(`    \x1b[31mError: ${job.last_error}\x1b[0m`)
  if (queueStats) {
    console.log('\n  Queue stats:')
    console.log(`    Pending: ${queueStats.pending}`)
    console.log(`    Running: ${queueStats.running}`)
    console.log(`    Completed: ${queueStats.completed}`)
    console.log(`    Failed: ${queueStats.failed}`)
    if (queueStats.avgProcessTime) {
      console.log(`    Avg time: ${Math.round(queueStats.avgProcessTime / 1000)}s`)
    }
  }
}

async function cmdDerivedJobsLogs(id: string, lines?: number): Promise<void> {
  const resolvedId = await resolveDerivedJobId(id)
  printHeader('Derived Job Logs')
  const response = await client.derivedJobs.logs(resolvedId, { lines })
  console.log(`  Log file: ${response.logPath}`)
  if (!response.exists) {
    console.log('  (log file not found yet)')
    return
  }
  if (response.truncated) {
    console.log(`  Showing last ${response.lines.length} lines\n`)
  } else {
    console.log('')
  }
  if (response.lines.length === 0) {
    console.log('  (no log output yet)')
    return
  }
  response.lines.forEach((line) => console.log(line))
}

async function cmdDerivedJobsCancel(id: string): Promise<void> {
  const resolvedId = await resolveDerivedJobId(id)
  printHeader('Cancel Derived Job')
  const job = await client.derivedJobs.cancel(resolvedId)
  printSuccess(`Derived job ${resolvedId.slice(0, 8)} cancelled`)
  console.log(`  Status: ${job.status}`)
}

async function cmdDerivedJobsRetry(id: string): Promise<void> {
  const resolvedId = await resolveDerivedJobId(id)
  printHeader('Retry Derived Job')
  const { job } = await client.derivedJobs.retry(resolvedId)
  printSuccess('New derived job scheduled')
  console.log(`  New job ID: ${job.id.slice(0, 8)}`)
  console.log(`\n  Monitor: derived-jobs get ${job.id.slice(0, 8)}`)
}

// --- Processing ---

async function cmdProcessJob(id: string): Promise<void> {
  const resolvedId = await resolveJobId(id)
  printHeader('Process Sync Job')
  const { job } = await client.jobs.get(resolvedId)

  const entityTypes = (job.metadata?.entityTypes as string[] | undefined) ?? []
  const transforms = await client.transformations.list({
    connector: job.connector,
    entityTypes,
  })

  if (transforms.length === 0) {
    console.log('  No registered transformations found for this job.')
  } else {
    console.log('\nAvailable transformations:')
    transforms.forEach((t, i) => {
      const label = `${t.id} - ${t.name} (${t.source.entityType})`
      const indexLabel = `\x1b[90m#${i + 1}\x1b[0m `
      console.log(`  ${indexLabel}${label}`)
    })
  }

  let transformationIds: string[] | undefined
  if (transforms.length > 0) {
    const options = transforms.map((t) => `${t.id} - ${t.name} (${t.source.entityType})`)
    const selected = await promptMultiSelect('Select transformations to run?', options, options)
    transformationIds = selected.map((s) => s.split(' ')[0])
  }

  const { result } = await client.processing.processJob(resolvedId, { transformationIds })
  printSuccess(`Processed job ${job.id.slice(0, 8)}`)
  console.log(`  Result: ${result.succeeded} succeeded, ${result.failed} failed (total ${result.total})`)
}

async function cmdProcessAll(): Promise<void> {
  printHeader('Process All Unprocessed Envelopes')
  let transformationIds: string[] | undefined
  const select = await promptConfirm('Select transformations to run?', true)
  if (select) {
    const transforms = await client.transformations.list()
    if (transforms.length === 0) {
      console.log('  No registered transformations found.')
    } else {
      const options = transforms.map((t) => `${t.id} - ${t.name} (${t.source.connector}:${t.source.entityType})`)
      const selected = await promptMultiSelect('Select transformations', options, options)
      transformationIds = selected.map((s) => s.split(' ')[0])
    }
  }

  const { result } = await client.processing.processAll({ transformationIds })
  printSuccess('Processing complete')
  console.log(`  Result: ${result.succeeded} succeeded, ${result.failed} failed (total ${result.total})`)
}

async function cmdProcessErrored(): Promise<void> {
  printHeader('Reprocess All Errored Envelopes')
  let transformationIds: string[] | undefined
  const select = await promptConfirm('Select transformations to run?', true)
  if (select) {
    const transforms = await client.transformations.list()
    if (transforms.length === 0) {
      console.log('  No registered transformations found.')
    } else {
      const options = transforms.map((t) => `${t.id} - ${t.name} (${t.source.connector}:${t.source.entityType})`)
      const selected = await promptMultiSelect('Select transformations', options, options)
      transformationIds = selected.map((s) => s.split(' ')[0])
    }
  }

  const { result } = await client.processing.processErrored({ transformationIds })
  printSuccess('Reprocessing complete')
  console.log(`  Result: ${result.succeeded} succeeded, ${result.failed} failed (total ${result.total})`)
}

async function cmdProcessReprocess(): Promise<void> {
  printHeader('Reprocess Envelopes (Scoped)')
  const connectors = await client.connectors.list()
  if (connectors.length === 0) {
    console.log('  No connectors registered.')
    return
  }

  const connectorOptions = connectors.map((c) => `${c.type} - ${c.displayName}`)
  const selectedConnector = await promptSelect('Select connector', connectorOptions, 0)
  const connector = selectedConnector.split(' ')[0]

  const connectorInfo = connectors.find((c) => c.type === connector)
  const entityTypes = connectorInfo?.entityTypes ?? []
  let entityType: string | undefined
  if (entityTypes.length > 0) {
    const selectEntity = await promptConfirm('Scope to a single entity type?', false)
    if (selectEntity) {
      const selectedEntity = await promptSelect('Select entity type', entityTypes, 0)
      entityType = selectedEntity
    }
  }

  let transformationIds: string[] | undefined
  const selectTransforms = await promptConfirm('Select transformations to run?', true)
  if (selectTransforms) {
    const transforms = await client.transformations.list({
      connector,
      entityTypes: entityType ? [entityType] : undefined,
    })
    if (transforms.length === 0) {
      console.log('  No registered transformations found.')
    } else {
      const options = transforms.map((t) => `${t.id} - ${t.name} (${t.source.connector}:${t.source.entityType})`)
      const selected = await promptMultiSelect('Select transformations', options, options)
      transformationIds = selected.map((s) => s.split(' ')[0])
    }
  }

  const { result } = await client.processing.reprocess({
    connector,
    entityType,
    transformationIds,
  })
  printSuccess('Reprocessing complete')
  console.log(`  Result: ${result.succeeded} succeeded, ${result.failed} failed (total ${result.total})`)
}

// --- Preferences ---

function printPreference(pref: CodingPreference): void {
  const shortId = pref.id.slice(0, 8)
  const confidenceColors: Record<string, string> = {
    low: '\x1b[33m',
    medium: '\x1b[36m',
    high: '\x1b[32m',
  }
  const confidenceColor = confidenceColors[pref.confidence] || ''
  const confidenceText = `${confidenceColor}${pref.confidence}\x1b[0m`

  console.log(`  \x1b[36m${shortId}\x1b[0m rank:${pref.rank.toFixed(2)} ${confidenceText}`)
  console.log(`    Category: ${pref.category} / ${pref.kind}`)
  console.log(`    Scope: ${pref.scope}`)
  console.log(`    \x1b[1m${pref.preference}\x1b[0m`)
  if (pref.context !== pref.preference) {
    console.log(`    \x1b[90m${pref.context.slice(0, 100)}${pref.context.length > 100 ? '...' : ''}\x1b[0m`)
  }
  console.log(`    Evidence: ${pref.evidence_count} (${pref.signal_strength})`)
}

async function cmdPreferencesSearch(query: string, opts?: {
  category?: string
  kind?: string
  confidence?: string
  limit?: number
  offset?: number
}): Promise<void> {
  printHeader(`Search Preferences: ${query}`)

  const response = await client.preferences.search({
    q: query,
    category: opts?.category,
    kind: opts?.kind,
    confidence: opts?.confidence,
    limit: opts?.limit,
    offset: opts?.offset,
  })

  if (response.preferences.length === 0) {
    console.log('  No results found.')
    console.log('  Try a different search query or check filters.')
    return
  }

  console.log(`  \x1b[90mFound ${response.total} result${response.total === 1 ? '' : 's'}\x1b[0m\n`)

  response.preferences.forEach(printPreference)

  if (response.filters.category || response.filters.kind || response.filters.confidence) {
    console.log('\n  Filters applied:')
    if (response.filters.category) console.log(`    category: ${response.filters.category}`)
    if (response.filters.kind) console.log(`    kind: ${response.filters.kind}`)
    if (response.filters.confidence) console.log(`    confidence: ${response.filters.confidence}`)
  }
}

// --- Decisions ---

function printDecision(dec: CodingDecision): void {
  const shortId = dec.id.slice(0, 8)
  const confidenceColors: Record<string, string> = {
    low: '\x1b[33m',
    medium: '\x1b[36m',
    high: '\x1b[32m',
  }
  const confidenceColor = confidenceColors[dec.confidence] || ''
  const confidenceText = `${confidenceColor}${dec.confidence}\x1b[0m`

  const rankText = dec.rank !== undefined ? `rank:${dec.rank.toFixed(2)} ` : ''
  const simText = dec.similarity !== undefined ? `sim:${dec.similarity.toFixed(2)} ` : ''

  console.log(`  \x1b[36m${shortId}\x1b[0m ${rankText}${simText}${confidenceText}`)
  console.log(`    Category: ${dec.category}`)
  console.log(`    Scope: ${dec.scope}`)
  console.log(`    \x1b[1m${dec.decision}\x1b[0m`)
  if (dec.rationale) {
    console.log(`    \x1b[90mRationale: ${dec.rationale.slice(0, 100)}${dec.rationale.length > 100 ? '...' : ''}\x1b[0m`)
  }
  if (dec.tradeoffs) {
    console.log(`    Tradeoffs: ${dec.tradeoffs.slice(0, 100)}${dec.tradeoffs.length > 100 ? '...' : ''}`)
  }
  console.log(`    Signal: ${dec.signal_strength} | Reversibility: ${dec.reversibility}`)
}

async function cmdDecisionsSearch(query: string, opts?: {
  category?: string
  confidence?: string
  limit?: number
  offset?: number
}): Promise<void> {
  printHeader(`Search Decisions: ${query}`)

  const response = await client.decisions.search({
    q: query,
    category: opts?.category,
    confidence: opts?.confidence,
    limit: opts?.limit,
    offset: opts?.offset,
  })

  if (response.decisions.length === 0) {
    console.log('  No results found.')
    console.log('  Try a different search query or check filters.')
    return
  }

  console.log(`  \x1b[90mFound ${response.total} result${response.total === 1 ? '' : 's'}\x1b[0m\n`)

  response.decisions.forEach(printDecision)

  if (response.filters?.category || response.filters?.confidence) {
    console.log('\n  Filters applied:')
    if (response.filters.category) console.log(`    category: ${response.filters.category}`)
    if (response.filters.confidence) console.log(`    confidence: ${response.filters.confidence}`)
  }
}

// ============ CLI Router ============

function printHelp(): void {
  console.log(`
\x1b[1mSync Engine API CLI\x1b[0m

\x1b[4mUsage:\x1b[0m
  sync-api-cli <command> [subcommand] [args]

\x1b[4mEnvironment:\x1b[0m
  SYNC_DAEMON_URL      API endpoint (default: http://localhost:3001)
  OAUTH_REDIRECT_URI   External OAuth redirect URI (e.g., Tailscale endpoint)
  OAUTH_CALLBACK_PORT  Local callback port (default: 9876)

\x1b[4mCommands:\x1b[0m

  \x1b[1mhealth\x1b[0m                           Check if daemon is running

  \x1b[1mconnectors\x1b[0m                       Discover and manage connectors
    list                           List all registered connectors
    available                      List available factories (not yet registered)
    <type>                         Show connector details and accounts
    register <type>                Register a connector (interactive prompts)
    register <type> <json>         Register with JSON config directly
    config <type> <json>           Update connector config
    enable <type>                  Enable a disabled connector
    disable <type>                 Disable a connector (unload from memory)
    unregister <type>              Unregister a connector completely

  \x1b[1mauth\x1b[0m                             Authentication
    providers                      List OAuth providers (Google, GitHub, etc.)
    login <connector>              OAuth flow (opens browser)
    login <connector> --headless   Device auth flow (no browser)
    status <accountId>             Check credential status
    refresh <accountId>            Force token refresh

  \x1b[1maccounts\x1b[0m                         Manage authenticated accounts
    list                           List all accounts
    get <id>                       Get account details
    delete <id>                    Deactivate account

  \x1b[1mtasks\x1b[0m                            Sync task management
    list                           List all tasks (shows #N indices)
    get <id>                       Get task with recent jobs
    trigger <id>                   Run a task now
    enable <id>                    Enable a task
    disable <id>                   Disable a task
    delete <id>                    Delete a task

    \x1b[90m<id> can be: #1 (index), prefix (01JD...), or full ULID\x1b[0m

    \x1b[1m<connector>\x1b[0m create
                                   Interactive task wizard
                                   Walks through: sync type, mode, entity types, interval
    \x1b[1m<connector>\x1b[0m list
                                   List tasks for this connector

  \x1b[1mderived-tasks\x1b[0m                     Derived task management
    list                           List all derived tasks (shows #N indices)
    create                         Create a derived task (interactive)
    run <id>                       Run a derived task now

    \x1b[90m<id> can be: #1 (index), prefix (01JD...), or full ULID\x1b[0m

  \x1b[1mderived-jobs\x1b[0m                      Monitor derived jobs
    list                           List recent derived jobs (shows #N indices)
    get <id>                       Get derived job details
    logs <id>                      Show derived job logs (tail)
      --lines <n>                  Number of log lines to show (default: 200)
    cancel <id>                    Cancel running derived job
    retry <id>                     Retry failed derived job

    \x1b[90m<id> can be: #1 (index), prefix (01JD...), or full ULID\x1b[0m

  \x1b[1mpreferences\x1b[0m                       Search coding preferences (TasteIndex)
    search <query>                Search preferences by query
      --category <category>         Filter by category
      --kind <kind>                Filter by kind (principle_candidate, local_convention, ignore)
      --confidence <confidence>      Filter by confidence (low, medium, high)
      --limit <n>                  Results limit (default: 20)
      --offset <n>                 Pagination offset (default: 0)

  \x1b[1mdecisions\x1b[0m                        Search coding decisions
    search <query>                Search decisions by query
      --category <category>         Filter by category
      --confidence <confidence>      Filter by confidence (low, medium, high)
      --limit <n>                  Results limit (default: 20)
      --offset <n>                 Pagination offset (default: 0)

  \x1b[1mprocess\x1b[0m                          Process raw envelopes
    job <id>                       Process envelopes for a sync job
    all                            Process all unprocessed envelopes
    errored                        Reprocess all errored envelopes
    reprocess                      Reprocess envelopes (scoped)

    \x1b[90m<id> can be: #1 (index), prefix (01JD...), or full ULID\x1b[0m

  \x1b[1mjobs\x1b[0m                             Monitor sync jobs
    list                           List recent jobs (shows #N indices)
    get <id>                       Get job details
    cancel <id>                    Cancel running job
    retry <id>                     Retry failed job

    \x1b[90m<id> can be: #1 (index), prefix (01JD...), or full ULID\x1b[0m

  \x1b[1mtelegram\x1b[0m                          Telegram Bot API
    send <message>                 Send a message via Bot API (no daemon needed)
      --chat <chatId>              Target a specific chat (default: all allowed users)

    \x1b[90mRequires: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS env vars\x1b[0m

\x1b[4mWorkflow:\x1b[0m

  \x1b[90m# 1. Discover available connectors\x1b[0m
  sync-api-cli connectors list
  \x1b[90m# → gmail - Gmail (message, thread, history)
  #   github - GitHub (user, issue, pull_request, comment, notification)\x1b[0m

  \x1b[90m# 2. Authenticate with a connector\x1b[0m
  sync-api-cli auth login gmail
  \x1b[90m# → Opens browser for OAuth, creates account\x1b[0m

  \x1b[90m# 3. Create a sync task (interactive wizard)\x1b[0m
  sync-api-cli tasks gmail create
  \x1b[90m# → Walks through: sync type, mode, entity types, interval
  #   Shows connector capabilities and validates combinations\x1b[0m

  \x1b[90m# 4. Monitor progress\x1b[0m
  sync-api-cli jobs list
  sync-api-cli jobs get #1          \x1b[90m# Use index from list\x1b[0m
  sync-api-cli jobs get 01JD        \x1b[90m# Or use ID prefix\x1b[0m

\x1b[4mExamples:\x1b[0m

  \x1b[90m# Gmail: interactive task creation\x1b[0m
  sync-api-cli auth login gmail
  sync-api-cli tasks gmail create
  \x1b[90m# → Select sync type: backfill/incremental
  # → Select mode: once/recurring/webhook
  # → Select entity types: message, thread, history
  # → Set interval (if recurring)\x1b[0m

  \x1b[90m# Reuse OAuth credentials across connectors\x1b[0m
  sync-api-cli auth login gmail     \x1b[90m# First Google connector\x1b[0m
  sync-api-cli auth login calendar  \x1b[90m# Prompts: "Found existing Google credentials"\x1b[0m

  \x1b[90m# Search coding preferences (TasteIndex)\x1b[0m
  sync-api-cli preferences search "typescript"
  sync-api-cli preferences search "test" --category testing
  sync-api-cli preferences search "code" --confidence high --limit 10
  sync-api-cli decisions search "database"
  sync-api-cli decisions search "architecture" --category design
  sync-api-cli decisions search "api" --confidence high --limit 10

\x1b[4mAdding Connectors:\x1b[0m

  See: packages/agent-memory/src/connectors/README.md

  1. Implement Connector interface in src/connectors/<name>/
  2. Register factory in src/connectors/registry.ts
  3. Add config schema in src/config/schema.ts
  4. Enable in daemon config

  Once registered, connectors appear in \`connectors list\` automatically.
`)
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      headless: { type: 'boolean', default: false },
      category: { type: 'string' },
      kind: { type: 'string' },
      confidence: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      lines: { type: 'string' },
      chat: { type: 'string' },
    },
    allowPositionals: true,
  })

  if (values.help || positionals.length === 0) {
    printHelp()
    process.exit(0)
  }

  const [command, subcommand, ...args] = positionals

  try {
    switch (command) {
      case 'health':
        await cmdHealth()
        break

      case 'connectors':
        switch (subcommand) {
          case 'list':
          case undefined:
            await cmdConnectorsList()
            break
          case 'available':
            await cmdConnectorsAvailable()
            break
          case 'register':
            if (!args[0]) throw new Error('Missing connector type')
            await cmdConnectorRegister(args[0], args[1])
            break
          case 'config':
            if (!args[0]) throw new Error('Missing connector type')
            if (!args[1]) throw new Error('Missing config JSON')
            await cmdConnectorConfig(args[0], args[1])
            break
          case 'enable':
            if (!args[0]) throw new Error('Missing connector type')
            await cmdConnectorEnable(args[0])
            break
          case 'disable':
            if (!args[0]) throw new Error('Missing connector type')
            await cmdConnectorDisable(args[0])
            break
          case 'unregister':
            if (!args[0]) throw new Error('Missing connector type')
            await cmdConnectorUnregister(args[0])
            break
          default:
            // subcommand is connector type
            await cmdConnectorInfo(subcommand)
        }
        break

      case 'accounts':
        switch (subcommand) {
          case 'list':
            await cmdAccountsList()
            break
          case 'get':
            if (!args[0]) throw new Error('Missing account ID')
            await cmdAccountsGet(args[0])
            break
          case 'delete':
            if (!args[0]) throw new Error('Missing account ID')
            await cmdAccountsDelete(args[0])
            break
          default:
            if (!subcommand) {
              await cmdAccountsList()
            } else {
              throw new Error(`Unknown subcommand: accounts ${subcommand}`)
            }
        }
        break

      case 'auth':
        switch (subcommand) {
          case 'providers':
            await cmdAuthProviders()
            break
          case 'login':
            if (!args[0]) throw new Error('Missing connector (e.g., gmail, github)')
            await cmdAuthLogin(args[0], values.headless)
            break
          case 'status':
            if (!args[0]) throw new Error('Missing account ID')
            await cmdAuthStatus(args[0])
            break
          case 'refresh':
            if (!args[0]) throw new Error('Missing account ID')
            await cmdAuthRefresh(args[0])
            break
          default:
            throw new Error(`Unknown subcommand: auth ${subcommand || '(none)'}`)
        }
        break

      case 'tasks':
        switch (subcommand) {
          case 'list':
            await cmdTasksList()
            break
          case 'get':
            if (!args[0]) throw new Error('Missing task ID')
            await cmdTasksGet(args[0])
            break
          case 'trigger':
            if (!args[0]) throw new Error('Missing task ID')
            await cmdTasksTrigger(args[0])
            break
          case 'enable':
            if (!args[0]) throw new Error('Missing task ID')
            await cmdTasksEnable(args[0])
            break
          case 'disable':
            if (!args[0]) throw new Error('Missing task ID')
            await cmdTasksDisable(args[0])
            break
          case 'delete':
            if (!args[0]) throw new Error('Missing task ID')
            await cmdTasksDelete(args[0])
            break
          default:
            if (!subcommand) {
              await cmdTasksList()
            } else {
              // subcommand is the connector type
              // args[0] is the action (create, list)
              const connector = subcommand
              const action = args[0]
              const restArgs = args.slice(1)

              switch (action) {
                case 'create':
                  // tasks <connector> create - interactive wizard
                  await cmdTasksCreate(connector)
                  break
                case 'list':
                  // tasks <connector> list - filter tasks by connector
                  await cmdTasksList(connector)
                  break
                default:
                  throw new Error(`Unknown action: tasks ${connector} ${action || '(none)'}. Use create or list.`)
              }
            }
        }
        break

      case 'derived-tasks':
        switch (subcommand) {
          case 'list':
          case undefined:
            await cmdDerivedTasksList()
            break
          case 'create':
            await cmdDerivedTasksCreate()
            break
          case 'run':
            if (!args[0]) throw new Error('Missing derived task ID')
            await cmdDerivedTasksRun(args[0])
            break
          default:
            throw new Error(`Unknown subcommand: derived-tasks ${subcommand || '(none)'}`)
        }
        break

      case 'derived-jobs':
        switch (subcommand) {
          case 'list':
          case undefined:
            await cmdDerivedJobsList()
            break
          case 'get':
            if (!args[0]) throw new Error('Missing derived job ID')
            await cmdDerivedJobsGet(args[0])
            break
          case 'logs':
            if (!args[0]) throw new Error('Missing derived job ID')
            await cmdDerivedJobsLogs(
              args[0],
              values.lines ? parseInt(values.lines as string, 10) : undefined
            )
            break
          case 'cancel':
            if (!args[0]) throw new Error('Missing derived job ID')
            await cmdDerivedJobsCancel(args[0])
            break
          case 'retry':
            if (!args[0]) throw new Error('Missing derived job ID')
            await cmdDerivedJobsRetry(args[0])
            break
          default:
            throw new Error(`Unknown subcommand: derived-jobs ${subcommand || '(none)'}`)
        }
        break

      case 'process':
        switch (subcommand) {
          case 'job':
            if (!args[0]) throw new Error('Missing job ID')
            await cmdProcessJob(args[0])
            break
          case 'all':
            await cmdProcessAll()
            break
          case 'errored':
            await cmdProcessErrored()
            break
          case 'reprocess':
            await cmdProcessReprocess()
            break
          default:
            throw new Error(`Unknown subcommand: process ${subcommand || '(none)'}`)
        }
        break

      case 'preferences':
        switch (subcommand) {
          case 'search':
            if (!args[0]) throw new Error('Missing search query')
            await cmdPreferencesSearch(args[0], {
              category: values.category as string | undefined,
              kind: values.kind as string | undefined,
              confidence: values.confidence as string | undefined,
              limit: values.limit ? parseInt(values.limit as string, 10) : undefined,
              offset: values.offset ? parseInt(values.offset as string, 10) : undefined,
            })
            break
          default:
            throw new Error(`Unknown subcommand: preferences ${subcommand || '(none)'}`)
        }
        break

      case 'decisions':
        switch (subcommand) {
          case 'search':
            if (!args[0]) throw new Error('Missing search query')
            await cmdDecisionsSearch(args[0], {
              category: values.category as string | undefined,
              confidence: values.confidence as string | undefined,
              limit: values.limit ? parseInt(values.limit as string, 10) : undefined,
              offset: values.offset ? parseInt(values.offset as string, 10) : undefined,
            })
            break
          default:
            throw new Error(`Unknown subcommand: decisions ${subcommand || '(none)'}`)
        }
        break

      case 'jobs':
        switch (subcommand) {
          case 'list':
            await cmdJobsList()
            break
          case 'get':
            if (!args[0]) throw new Error('Missing job ID')
            await cmdJobsGet(args[0])
            break
          case 'cancel':
            if (!args[0]) throw new Error('Missing job ID')
            await cmdJobsCancel(args[0])
            break
          case 'retry':
            if (!args[0]) throw new Error('Missing job ID')
            await cmdJobsRetry(args[0])
            break
          default:
            if (!subcommand) {
              await cmdJobsList()
            } else {
              throw new Error(`Unknown subcommand: jobs ${subcommand}`)
            }
        }
        break

      default:
        printError(`Unknown command: ${command}`)
        printHelp()
        process.exit(1)
    }
  } catch (error) {
    if (error instanceof SyncClientError) {
      printError(`${error.message}`)
      printErrorDetails(error.data)
      if (error.code === 'CONNECTION_ERROR') {
        console.log('\nIs the daemon running? Try: bun run packages/agent-memory/scripts/sync-daemon.ts')
      }
    } else if (error instanceof Error) {
      printError(error.message)
    } else {
      printError(String(error))
    }
    process.exit(1)
  }
}

main()
