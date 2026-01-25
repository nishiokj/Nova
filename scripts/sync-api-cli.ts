#!/usr/bin/env bun
/**
 * Sync Engine API CLI
 *
 * CLI tool to interact with the sync daemon API using the typed client SDK.
 *
 * Usage:
 *   bun run scripts/sync-api-cli.ts <command> [subcommand] [options]
 *
 * Commands:
 *   health                       - Check daemon health
 *
 *   accounts list                - List accounts
 *   accounts get <id>            - Get account details
 *   accounts delete <id>         - Deactivate account
 *
 *   auth providers               - List available OAuth providers
 *   auth login <connector>       - Start OAuth flow (opens browser)
 *   auth status <accountId>      - Check credential status
 *   auth refresh <accountId>     - Force token refresh
 *
 *   tasks list                   - List sync tasks
 *   tasks get <id>               - Get task with recent jobs
 *   tasks backfill <accountId>   - Create backfill task
 *   tasks subscribe <accountId>  - Create recurring sync
 *   tasks webhook <accountId>    - Create webhook subscription
 *   tasks trigger <id>           - Manually run a task
 *   tasks enable <id>            - Enable task
 *   tasks disable <id>           - Disable task
 *   tasks delete <id>            - Delete task
 *
 *   jobs list                    - List jobs
 *   jobs get <id>                - Get job details
 *   jobs cancel <id>             - Cancel running job
 *   jobs retry <id>              - Retry failed job
 */

import { parseArgs } from 'node:util'
import {
  SyncClient,
  SyncClientError,
  captureOAuthCallback,
  getCallbackUri,
  type Account,
  type SyncJob,
  type SyncTask,
} from '../packages/agent-memory/src/client/index.js'

const SYNC_DAEMON_URL = process.env.SYNC_DAEMON_URL || 'http://localhost:3001'
const CALLBACK_PORT = parseInt(process.env.OAUTH_CALLBACK_PORT || '9876', 10)
// Use OAUTH_REDIRECT_URI for external callback (e.g., Tailscale endpoint)
// Falls back to localhost callback if not set
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI

const client = new SyncClient(SYNC_DAEMON_URL)

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

function printTask(task: SyncTask): void {
  const status = task.enabled ? '\x1b[32menabled\x1b[0m' : '\x1b[33mdisabled\x1b[0m'
  console.log(`  \x1b[36m${task.id}\x1b[0m`)
  console.log(`    Account: ${task.account_id}`)
  console.log(`    Type: ${task.sync_type} (${task.mode})`)
  console.log(`    Status: ${status}`)
  if (task.interval_ms) {
    console.log(`    Interval: ${Math.floor(task.interval_ms / 1000 / 60)} minutes`)
  }
  if (task.next_run_at) {
    console.log(`    Next run: ${new Date(task.next_run_at).toLocaleString()}`)
  }
}

function printJob(job: SyncJob): void {
  const statusColors: Record<string, string> = {
    pending: '\x1b[33m',
    running: '\x1b[34m',
    completed: '\x1b[32m',
    failed: '\x1b[31m',
    cancelled: '\x1b[90m',
  }
  const color = statusColors[job.status] || ''
  console.log(`  \x1b[36m${job.id}\x1b[0m`)
  console.log(`    Account: ${job.account_id}`)
  console.log(`    Type: ${job.job_type}`)
  console.log(`    Status: ${color}${job.status}\x1b[0m`)
  console.log(`    Progress: ${job.items_processed}/${job.items_fetched} (${job.items_failed} failed)`)
  if (job.started_at) {
    console.log(`    Started: ${new Date(job.started_at).toLocaleString()}`)
  }
  if (job.completed_at) {
    console.log(`    Completed: ${new Date(job.completed_at).toLocaleString()}`)
  }
  if (job.last_error) {
    console.log(`    Error: ${job.last_error}`)
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

async function cmdAuthLogin(connector: string): Promise<void> {
  printHeader(`OAuth Login: ${connector}`)

  // Use external redirect URI if configured, otherwise localhost
  const redirectUri = OAUTH_REDIRECT_URI || getCallbackUri(CALLBACK_PORT)
  const useLocalCallback = !OAUTH_REDIRECT_URI

  // Get authorization URL
  const { url, state } = await client.auth.getUrl(connector, redirectUri)

  let code: string

  if (useLocalCallback) {
    // Capture callback via local server (opens browser + captures code automatically)
    console.log('Opening browser for OAuth...')
    const result = await captureOAuthCallback(url, { port: CALLBACK_PORT })
    code = result.code
  } else {
    // External redirect - open browser, user pastes code
    console.log('Opening browser for OAuth...')
    const open = (await import('open')).default
    await open(url)

    console.log('\nAfter authorizing, paste the "code" parameter from the callback URL:')
    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    code = await new Promise<string>((resolve) => {
      rl.question('\nCode: ', (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    })

    if (!code) {
      throw new Error('No authorization code provided')
    }
  }

  // Exchange code for account
  console.log('\nExchanging authorization code...')
  const account = await client.auth.callback(connector, code, state, redirectUri)

  printSuccess('Account created successfully!')
  printAccount(account)
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

// --- Tasks ---

async function cmdTasksList(): Promise<void> {
  printHeader('Sync Tasks')
  const tasks = await client.tasks.list()
  if (tasks.length === 0) {
    console.log('  No tasks found.')
    console.log('  Use "tasks backfill <accountId>" to create a sync task.')
  } else {
    tasks.forEach(printTask)
  }
}

async function cmdTasksGet(id: string): Promise<void> {
  printHeader('Task Details')
  const { task, recentJobs } = await client.tasks.get(id)
  printTask(task)
  if (recentJobs && recentJobs.length > 0) {
    console.log('\n  Recent jobs:')
    recentJobs.slice(0, 5).forEach((job) => {
      const color = job.status === 'completed' ? '\x1b[32m' : job.status === 'failed' ? '\x1b[31m' : ''
      console.log(`    - ${job.id} ${color}${job.status}\x1b[0m`)
    })
  }
}

async function cmdTasksBackfill(accountId: string): Promise<void> {
  printHeader('Create Backfill Task')
  const { task, job } = await client.tasks.backfill(accountId)
  printSuccess('Backfill task created')
  console.log(`  Task ID: ${task.id}`)
  console.log(`  Job ID: ${job.id}`)
  console.log('\nMonitor progress: bun run scripts/sync-api-cli.ts jobs get ' + job.id)
}

async function cmdTasksSubscribe(accountId: string, intervalMin: string): Promise<void> {
  printHeader('Create Recurring Sync')
  const intervalMs = parseInt(intervalMin, 10) * 60 * 1000
  if (isNaN(intervalMs) || intervalMs < 60000) {
    throw new Error('Interval must be at least 1 minute')
  }
  const task = await client.tasks.subscribe(accountId, {
    syncType: 'incremental',
    intervalMs,
  })
  printSuccess('Subscription created')
  printTask(task)
}

async function cmdTasksWebhook(accountId: string): Promise<void> {
  printHeader('Create Webhook Subscription')
  const task = await client.tasks.webhook(accountId)
  printSuccess('Webhook subscription created')
  printTask(task)
  console.log('\nNote: Webhooks may require additional provider setup (e.g., Google Pub/Sub).')
}

async function cmdTasksTrigger(id: string): Promise<void> {
  printHeader('Trigger Task')
  const job = await client.tasks.trigger(id)
  printSuccess('Task triggered')
  console.log(`  Job ID: ${job.id}`)
}

async function cmdTasksEnable(id: string): Promise<void> {
  printHeader('Enable Task')
  await client.tasks.enable(id)
  printSuccess(`Task ${id} enabled`)
}

async function cmdTasksDisable(id: string): Promise<void> {
  printHeader('Disable Task')
  await client.tasks.disable(id)
  printSuccess(`Task ${id} disabled`)
}

async function cmdTasksDelete(id: string): Promise<void> {
  printHeader('Delete Task')
  await client.tasks.delete(id)
  printSuccess(`Task ${id} deleted`)
}

// --- Jobs ---

async function cmdJobsList(): Promise<void> {
  printHeader('Sync Jobs')
  const jobs = await client.jobs.list({ limit: 20 })
  if (jobs.length === 0) {
    console.log('  No jobs found.')
  } else {
    jobs.forEach(printJob)
  }
}

async function cmdJobsGet(id: string): Promise<void> {
  printHeader('Job Details')
  const { job, queueStats } = await client.jobs.get(id)
  printJob(job)
  if (queueStats) {
    console.log('\n  Queue stats:')
    console.log(`    Pending: ${queueStats.pending}`)
    console.log(`    Running: ${queueStats.running}`)
  }
}

async function cmdJobsCancel(id: string): Promise<void> {
  printHeader('Cancel Job')
  const job = await client.jobs.cancel(id)
  printSuccess(`Job ${id} cancelled`)
  printJob(job)
}

async function cmdJobsRetry(id: string): Promise<void> {
  printHeader('Retry Job')
  const { job } = await client.jobs.retry(id)
  printSuccess('New job scheduled')
  console.log(`  New job ID: ${job.id}`)
}

// ============ CLI Router ============

function printHelp(): void {
  console.log(`
\x1b[1mSync Engine API CLI\x1b[0m

\x1b[4mUsage:\x1b[0m
  bun run scripts/sync-api-cli.ts <command> [subcommand] [args]

\x1b[4mEnvironment:\x1b[0m
  SYNC_DAEMON_URL      API endpoint (default: http://localhost:3001)
  OAUTH_REDIRECT_URI   External OAuth redirect URI (e.g., Tailscale endpoint)
  OAUTH_CALLBACK_PORT  Local callback port if no OAUTH_REDIRECT_URI (default: 9876)

\x1b[4mCommands:\x1b[0m

  \x1b[1mhealth\x1b[0m                         Check if daemon is running

  \x1b[1maccounts\x1b[0m
    list                         List all accounts
    get <id>                     Get account details
    delete <id>                  Deactivate account

  \x1b[1mauth\x1b[0m
    providers                    List available OAuth providers
    login <connector>            Start OAuth flow (opens browser)
    status <accountId>           Check credential status
    refresh <accountId>          Force token refresh

  \x1b[1mtasks\x1b[0m
    list                         List all sync tasks
    get <id>                     Get task with recent jobs
    backfill <accountId>         Create one-time backfill task
    subscribe <accountId> <min>  Create recurring sync (interval in minutes)
    webhook <accountId>          Create webhook subscription
    trigger <id>                 Manually run a task now
    enable <id>                  Enable a task
    disable <id>                 Disable a task
    delete <id>                  Delete a task

  \x1b[1mjobs\x1b[0m
    list                         List recent jobs
    get <id>                     Get job details
    cancel <id>                  Cancel a running job
    retry <id>                   Retry a failed job

\x1b[4mExamples:\x1b[0m

  # Start daemon and check health
  bun run scripts/sync-api-cli.ts health

  # Add Gmail account (opens browser for OAuth)
  bun run scripts/sync-api-cli.ts auth login gmail

  # List accounts
  bun run scripts/sync-api-cli.ts accounts list

  # Start backfill sync
  bun run scripts/sync-api-cli.ts tasks backfill <account-id>

  # Create hourly sync
  bun run scripts/sync-api-cli.ts tasks subscribe <account-id> 60

  # Monitor jobs
  bun run scripts/sync-api-cli.ts jobs list
`)
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h', default: false },
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
            await cmdAuthLogin(args[0])
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
          case 'backfill':
            if (!args[0]) throw new Error('Missing account ID')
            await cmdTasksBackfill(args[0])
            break
          case 'subscribe':
            if (!args[0]) throw new Error('Missing account ID')
            if (!args[1]) throw new Error('Missing interval (minutes)')
            await cmdTasksSubscribe(args[0], args[1])
            break
          case 'webhook':
            if (!args[0]) throw new Error('Missing account ID')
            await cmdTasksWebhook(args[0])
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
              throw new Error(`Unknown subcommand: tasks ${subcommand}`)
            }
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
