#!/usr/bin/env bun
/**
 * Watchdog — Health-check and auto-restart for the harness daemon.
 *
 * Checks whether the daemon is alive and making progress. If it detects
 * a crash, hang, or repeated errors, it restarts the daemon and optionally
 * starts an async session with a diagnosis so the agent can self-heal.
 *
 * Usage:
 *   bun run scripts/watchdog.ts                    # check + auto-restart
 *   bun run scripts/watchdog.ts check              # health check only (exit 0/1)
 *   bun run scripts/watchdog.ts restart             # force restart + async diagnosis
 *
 * Flags:
 *   --session <key>       Session key for async restart (default: new session)
 *   --stale <minutes>     Log staleness threshold (default: 10)
 *   --notify              Send Telegram notification on restart
 *   --goal <text>         Custom goal for the restarted async session
 */

import { createConnection } from 'net'
import { execSync, spawn } from 'child_process'
import { statSync, readFileSync, existsSync } from 'fs'
import path from 'path'
import { parseArgs } from 'node:util'
import postgres from 'postgres'
import { HarnessClient } from '../packages/infra/harness-client/src/index.js'
import { notifyAllUsers } from '../packages/plugins/agent-memory/src/connectors/telegram/notify.js'

// ─── Config ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dir, '..')
const DAEMON_HOST = process.env.EVENT_BUS_HOST ?? '127.0.0.1'
const DAEMON_PORT = Number(process.env.EVENT_BUS_PORT ?? '9555')
const HARNESS_LOG = path.join(PROJECT_ROOT, 'logs', 'harness.log')
const AGENT_EVENTS_LOG = path.join(PROJECT_ROOT, 'logs', 'agent_events.log')
const DAEMON_ENTRY = path.join(PROJECT_ROOT, 'packages', 'harness-daemon', 'src', 'index.ts')
const LAUNCHER_ENTRY = path.join(PROJECT_ROOT, 'packages', 'launcher', 'index.ts')

const DEFAULT_STALE_MINUTES = 120
const DAEMON_READY_TIMEOUT_MS = 15_000
const CLIENT_CONNECT_TIMEOUT_MS = 5_000

// ─── Types ─────────────────────────────────────────────────────────────────────

interface HealthReport {
  healthy: boolean
  daemonReachable: boolean
  processAlive: boolean
  logFresh: boolean
  lastLogAgeMinutes: number | null
  lastEventAgeMinutes: number | null
  recentErrors: string[]
  diagnosis: string
}

interface JobHealthReport {
  healthy: boolean
  totalJobs: number
  failedJobs: number
  failureRate: number
  recentFailures: Array<{
    id: string
    connector: string
    error: string
    completedAt: string
  }>
  diagnosis: string
}

// ─── Health Checks ─────────────────────────────────────────────────────────────

async function checkTcpConnection(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: DAEMON_HOST, port: DAEMON_PORT }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      socket.destroy()
      resolve(false)
    })
    setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 2000)
  })
}

function checkProcessAlive(): boolean {
  try {
    const result = execSync('pgrep -f "harness-daemon"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return result.length > 0
  } catch {
    return false
  }
}

function getFileAgeMinutes(filePath: string): number | null {
  try {
    const stat = statSync(filePath)
    return (Date.now() - stat.mtimeMs) / 60_000
  } catch {
    return null
  }
}

function getRecentErrors(filePath: string, lineCount = 200): string[] {
  if (!existsSync(filePath)) return []
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').slice(-lineCount)
    const errorLines = lines.filter(
      (line) =>
        line.includes('[ERROR]') ||
        line.includes('fatal') ||
        line.includes('FATAL') ||
        line.includes('uncaught') ||
        line.includes('unhandled') ||
        line.includes('ECONNREFUSED') ||
        line.includes('ENOMEM') ||
        line.includes('out of memory'),
    )
    // Deduplicate and take last 10
    const unique = [...new Set(errorLines)]
    return unique.slice(-10)
  } catch {
    return []
  }
}

async function runHealthCheck(staleMinutes: number): Promise<HealthReport> {
  const daemonReachable = await checkTcpConnection()
  const processAlive = checkProcessAlive()
  const lastLogAgeMinutes = getFileAgeMinutes(HARNESS_LOG)
  const lastEventAgeMinutes = getFileAgeMinutes(AGENT_EVENTS_LOG)
  const logFresh =
    lastLogAgeMinutes !== null ? lastLogAgeMinutes < staleMinutes : true // no log = no staleness signal
  const recentErrors = getRecentErrors(HARNESS_LOG)

  // Build diagnosis
  const issues: string[] = []

  if (!processAlive) {
    issues.push('Daemon process is not running (no harness-daemon process found)')
  }
  if (!daemonReachable) {
    issues.push(`Daemon TCP port ${DAEMON_PORT} is not reachable`)
  }
  if (!logFresh && lastLogAgeMinutes !== null) {
    issues.push(
      `Harness log is stale (last updated ${lastLogAgeMinutes.toFixed(1)} minutes ago, threshold: ${staleMinutes}m)`,
    )
  }
  if (recentErrors.length > 0) {
    issues.push(`Found ${recentErrors.length} recent error(s) in harness log`)
  }

  const healthy = daemonReachable && processAlive && logFresh && recentErrors.length === 0

  let diagnosis: string
  if (healthy) {
    diagnosis = 'Daemon is healthy'
  } else if (issues.length === 0) {
    diagnosis = 'Daemon appears unhealthy (unknown cause)'
  } else {
    diagnosis = issues.join('. ') + '.'
  }

  return {
    healthy,
    daemonReachable,
    processAlive,
    logFresh,
    lastLogAgeMinutes,
    lastEventAgeMinutes,
    recentErrors,
    diagnosis,
  }
}

// ─── Sync Job Health Check ─────────────────────────────────────────────────────

async function checkJobHealth(lookbackHours = 24, failureThreshold = 0.1): Promise<JobHealthReport> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    return {
      healthy: true,
      totalJobs: 0,
      failedJobs: 0,
      failureRate: 0,
      recentFailures: [],
      diagnosis: 'No DATABASE_URL configured, skipping job health check',
    }
  }

  const sql = postgres(databaseUrl)

  try {
    // Count total and failed jobs in lookback period
    const [stats] = await sql<{ total: string; failed: string }[]>`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'failed') as failed
      FROM sync_jobs
      WHERE created_at >= NOW() - INTERVAL '${sql.unsafe(String(lookbackHours))} hours'
    `

    const totalJobs = parseInt(stats.total, 10)
    const failedJobs = parseInt(stats.failed, 10)
    const failureRate = totalJobs > 0 ? failedJobs / totalJobs : 0

    // Get recent failures with details
    const recentFailures = await sql<{
      id: string
      connector: string
      last_error: string | null
      completed_at: Date | null
    }[]>`
      SELECT id, connector, last_error, completed_at
      FROM sync_jobs
      WHERE status = 'failed'
        AND created_at >= NOW() - INTERVAL '${sql.unsafe(String(lookbackHours))} hours'
      ORDER BY completed_at DESC
      LIMIT 10
    `

    const healthy = failureRate <= failureThreshold
    const issues: string[] = []

    if (!healthy) {
      issues.push(`Job failure rate ${(failureRate * 100).toFixed(1)}% exceeds threshold ${(failureThreshold * 100)}%`)
    }
    if (failedJobs > 0) {
      issues.push(`${failedJobs} failed job(s) in the last ${lookbackHours} hours`)
    }

    // Group failures by connector for summary
    const failuresByConnector = recentFailures.reduce((acc, f) => {
      acc[f.connector] = (acc[f.connector] || 0) + 1
      return acc
    }, {} as Record<string, number>)

    if (Object.keys(failuresByConnector).length > 0) {
      const summary = Object.entries(failuresByConnector)
        .map(([c, n]) => `${c}: ${n}`)
        .join(', ')
      issues.push(`Failures by connector: ${summary}`)
    }

    return {
      healthy,
      totalJobs,
      failedJobs,
      failureRate,
      recentFailures: recentFailures.map((f) => ({
        id: f.id,
        connector: f.connector,
        error: f.last_error ?? 'Unknown error',
        completedAt: f.completed_at?.toISOString() ?? 'unknown',
      })),
      diagnosis: issues.length > 0 ? issues.join('. ') + '.' : 'Sync jobs are healthy',
    }
  } finally {
    await sql.end()
  }
}

// ─── Daemon Control ────────────────────────────────────────────────────────────

function killDaemon(): void {
  console.log('[watchdog] Killing existing daemon...')
  try {
    execSync('pkill -TERM -f "harness-daemon"', { stdio: 'ignore' })
  } catch {
    // No process to kill
  }
  // Also kill launcher if running
  try {
    execSync('pkill -TERM -f "packages/apps/launcher/index"', { stdio: 'ignore' })
  } catch {
    // No process to kill
  }
}

async function waitForDaemonReady(): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < DAEMON_READY_TIMEOUT_MS) {
    if (await checkTcpConnection()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function startDaemon(): void {
  console.log('[watchdog] Starting daemon (headless, no idle timeout)...')
  const child = spawn('bun', ['run', DAEMON_ENTRY, '--idle-timeout', '0'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      EVENT_BUS_HOST: DAEMON_HOST,
      EVENT_BUS_PORT: String(DAEMON_PORT),
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  console.log(`[watchdog] Daemon spawned (pid ${child.pid})`)
}

// ─── Async Session ─────────────────────────────────────────────────────────────

async function startAsyncDiagnosis(
  sessionKey: string | undefined,
  goal: string,
): Promise<{ sessionKey: string; requestId: string } | null> {
  const client = new HarnessClient({
    host: DAEMON_HOST,
    port: DAEMON_PORT,
    requestTimeout: CLIENT_CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: 1,
  })

  try {
    await client.connect()

    // Init session — send init command and wait for ready event
    const readyPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Init timeout')), 10_000)
      client.on('event', (event: { type: string; data?: Record<string, unknown> }) => {
        if (event.type === 'ready') {
          clearTimeout(timeout)
          const sk = (event.data?.session_key as string) ?? sessionKey ?? 'unknown'
          resolve(sk)
        }
      })
    })

    client.send({
      type: 'init',
      data: {
        ...(sessionKey ? { session_key: sessionKey } : {}),
        working_dir: PROJECT_ROOT,
      },
    })

    const resolvedSessionKey = await readyPromise
    console.log(`[watchdog] Session initialized: ${resolvedSessionKey}`)

    // Start async session
    const result = await client.asyncStart(goal, PROJECT_ROOT)
    if (!result.success) {
      console.error(`[watchdog] Failed to start async session: ${result.error}`)
      client.close()
      return null
    }

    console.log(`[watchdog] Async session started: ${result.requestId}`)
    client.close()

    return {
      sessionKey: result.sessionKey ?? resolvedSessionKey,
      requestId: result.requestId ?? 'unknown',
    }
  } catch (err) {
    console.error(`[watchdog] Client error: ${err instanceof Error ? err.message : String(err)}`)
    try {
      client.close()
    } catch {}
    return null
  }
}

// ─── Telegram Notification ─────────────────────────────────────────────────────

async function sendTelegramNotification(report: HealthReport, asyncResult: { sessionKey: string; requestId: string } | null): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const allowedUsers = process.env.TELEGRAM_ALLOWED_USERS
  if (!botToken || !allowedUsers) {
    console.log('[watchdog] Telegram notification skipped (no TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USERS)')
    return
  }

  const chatIds = allowedUsers
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id))

  if (chatIds.length === 0) return

  const lines = [
    `🔧 *Watchdog: Daemon Restarted*`,
    ``,
    `*Diagnosis:* ${report.diagnosis}`,
  ]

  if (report.recentErrors.length > 0) {
    lines.push(``, `*Recent errors:*`)
    lines.push('```')
    lines.push(...report.recentErrors.slice(-5))
    lines.push('```')
  }

  if (asyncResult) {
    lines.push(``, `*Recovery:* Async session started`)
    lines.push(`Session: \`${asyncResult.sessionKey}\``)
    lines.push(`Request: \`${asyncResult.requestId}\``)
  }

  await notifyAllUsers(botToken, chatIds, lines.join('\n'), 'Markdown')
  console.log('[watchdog] Telegram notification sent')
}

// ─── Output Formatting ────────────────────────────────────────────────────────

function printReport(report: HealthReport): void {
  const status = report.healthy ? '✅ HEALTHY' : '❌ UNHEALTHY'
  console.log(`\n${status}`)
  console.log(`  Daemon reachable:  ${report.daemonReachable ? 'yes' : 'NO'}`)
  console.log(`  Process alive:     ${report.processAlive ? 'yes' : 'NO'}`)
  console.log(`  Log fresh:         ${report.logFresh ? 'yes' : 'NO'}`)
  if (report.lastLogAgeMinutes !== null) {
    console.log(`  Harness log age:   ${report.lastLogAgeMinutes.toFixed(1)} minutes`)
  }
  if (report.lastEventAgeMinutes !== null) {
    console.log(`  Event log age:     ${report.lastEventAgeMinutes.toFixed(1)} minutes`)
  }
  if (report.recentErrors.length > 0) {
    console.log(`  Recent errors:     ${report.recentErrors.length}`)
    for (const err of report.recentErrors.slice(-3)) {
      console.log(`    → ${err.slice(0, 120)}`)
    }
  }
  console.log(`  Diagnosis:         ${report.diagnosis}`)
  console.log()
}

function printJobReport(report: JobHealthReport): void {
  const status = report.healthy ? '✅ JOBS HEALTHY' : '❌ JOBS UNHEALTHY'
  console.log(`\n${status}`)
  console.log(`  Total jobs:        ${report.totalJobs}`)
  console.log(`  Failed jobs:       ${report.failedJobs}`)
  console.log(`  Failure rate:      ${(report.failureRate * 100).toFixed(1)}%`)

  if (report.recentFailures.length > 0) {
    console.log(`\n  Recent failures:`)
    for (const failure of report.recentFailures.slice(0, 5)) {
      console.log(`    → [${failure.connector}] ${failure.error.slice(0, 80)}`)
    }
  }

  console.log(`\n  Diagnosis:         ${report.diagnosis}`)
  console.log()
}

async function sendJobFailureNotification(report: JobHealthReport): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const allowedUsers = process.env.TELEGRAM_ALLOWED_USERS
  if (!botToken || !allowedUsers) {
    console.log('[watchdog] Telegram notification skipped (no TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USERS)')
    return
  }

  const chatIds = allowedUsers
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id))

  if (chatIds.length === 0) return

  const lines = [
    `⚠️ *Watchdog: Sync Job Failures*`,
    ``,
    `*Stats:* ${report.failedJobs}/${report.totalJobs} failed (${(report.failureRate * 100).toFixed(1)}%)`,
    ``,
    `*Diagnosis:* ${report.diagnosis}`,
  ]

  if (report.recentFailures.length > 0) {
    lines.push(``, `*Recent failures:*`)
    for (const failure of report.recentFailures.slice(0, 5)) {
      lines.push(`• \\[${failure.connector}\\] ${failure.error.slice(0, 60).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&')}`)
    }
  }

  await notifyAllUsers(botToken, chatIds, lines.join('\n'), 'MarkdownV2')
  console.log('[watchdog] Telegram job failure notification sent')
}

function buildDiagnosisGoal(report: HealthReport, customGoal?: string): string {
  if (customGoal) return customGoal

  const lines = [
    `The watchdog detected that the harness daemon was unhealthy and has restarted it.`,
    ``,
    `## Diagnosis`,
    report.diagnosis,
  ]

  if (report.recentErrors.length > 0) {
    lines.push(``, `## Recent Errors`)
    for (const err of report.recentErrors) {
      lines.push(`- ${err.slice(0, 200)}`)
    }
  }

  lines.push(
    ``,
    `## Instructions`,
    `1. Investigate the root cause of the issue described above.`,
    `2. Check the harness log at \`logs/harness.log\` and event log at \`logs/agent_events.log\` for more context.`,
    `3. If the issue is a code bug, fix it. If it's a configuration issue, update the config.`,
    `4. If you made code changes, run \`bun run build\` to rebuild.`,
    `5. Summarize what you found and what you fixed.`,
  )

  return lines.join('\n')
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load .env if present
  const envPath = path.join(PROJECT_ROOT, '.env')
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8')
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim()
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
        if (!process.env[key]) process.env[key] = value
      }
    }
  }

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      session: { type: 'string' },
      stale: { type: 'string', default: String(DEFAULT_STALE_MINUTES) },
      lookback: { type: 'string', default: '24' },
      threshold: { type: 'string', default: '0.1' },
      notify: { type: 'boolean', default: false },
      goal: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: false,
  })

  if (values.help) {
    console.log(`
Watchdog — Health-check and auto-restart for the harness daemon.

Usage:
  bun run scripts/watchdog.ts [command] [flags]

Commands:
  (default)    Check daemon + job health, auto-restart daemon if unhealthy, notify on failures
  check        Health check only (exit 0 if healthy, 1 if not)
  restart      Force restart and start async diagnosis session

Flags:
  --session <key>     Session key to use for async restart
  --stale <minutes>   Log staleness threshold (default: ${DEFAULT_STALE_MINUTES})
  --lookback <hours>  Job health lookback period (default: 24)
  --threshold <rate>  Job failure rate threshold 0-1 (default: 0.1 = 10%)
  --notify            Send Telegram notification on issues
  --goal <text>       Custom goal for the async diagnosis session
  -h, --help          Show this help

Note: The daemon runs with idle-timeout=0, so logs may be stale during quiet periods.
      The default staleness threshold of 2 hours prevents unnecessary restarts.
`)
    process.exit(0)
  }

  const command = positionals[0] ?? ''
  const staleMinutes = parseInt(values.stale as string, 10) || DEFAULT_STALE_MINUTES
  const lookbackHours = parseInt(values.lookback as string, 10) || 24
  const failureThreshold = parseFloat(values.threshold as string) || 0.1
  const sessionKey = values.session as string | undefined
  const notify = values.notify as boolean
  const customGoal = values.goal as string | undefined

  // ── Check (daemon + jobs) ──
  if (command === 'check') {
    const daemonReport = await runHealthCheck(staleMinutes)
    const jobReport = await checkJobHealth(lookbackHours, failureThreshold)

    printReport(daemonReport)
    printJobReport(jobReport)

    const allHealthy = daemonReport.healthy && jobReport.healthy
    process.exit(allHealthy ? 0 : 1)
  }

  // ── Restart (forced) ──
  if (command === 'restart') {
    console.log('[watchdog] Force restart requested')
    const report = await runHealthCheck(staleMinutes)
    printReport(report)

    killDaemon()
    await new Promise((r) => setTimeout(r, 3000))

    startDaemon()
    const ready = await waitForDaemonReady()
    if (!ready) {
      console.error('[watchdog] Daemon failed to start within timeout')
      process.exit(1)
    }
    console.log('[watchdog] Daemon is ready')

    const goal = buildDiagnosisGoal(report, customGoal)
    const asyncResult = await startAsyncDiagnosis(sessionKey, goal)

    if (notify) {
      await sendTelegramNotification(report, asyncResult)
    }

    if (asyncResult) {
      console.log(`[watchdog] Recovery session: ${asyncResult.sessionKey}`)
      console.log(`[watchdog] Reconnect: bun run ${LAUNCHER_ENTRY} --session '${asyncResult.sessionKey}'`)
    }
    process.exit(0)
  }

  // ── Default: check daemon + jobs, auto-restart daemon if unhealthy, notify on any issues ──
  const daemonReport = await runHealthCheck(staleMinutes)
  const jobReport = await checkJobHealth(lookbackHours, failureThreshold)

  printReport(daemonReport)
  printJobReport(jobReport)

  // Notify on job failures (independent of daemon health)
  if (!jobReport.healthy && notify) {
    await sendJobFailureNotification(jobReport)
  }

  // If daemon is healthy, we're done (job failures are alerted but don't trigger restart)
  if (daemonReport.healthy) {
    if (jobReport.healthy) {
      console.log('[watchdog] All systems healthy')
    } else {
      console.log('[watchdog] Daemon healthy, but job failures detected (notification sent)')
    }
    process.exit(jobReport.healthy ? 0 : 1)
  }

  // Daemon is unhealthy - restart it
  console.log('[watchdog] Daemon is unhealthy, initiating restart...')
  killDaemon()
  await new Promise((r) => setTimeout(r, 3000))

  startDaemon()
  const ready = await waitForDaemonReady()
  if (!ready) {
    console.error('[watchdog] Daemon failed to start within timeout')
    if (notify) {
      await sendTelegramNotification(daemonReport, null)
    }
    process.exit(1)
  }
  console.log('[watchdog] Daemon is ready')

  const goal = buildDiagnosisGoal(daemonReport, customGoal)
  const asyncResult = await startAsyncDiagnosis(sessionKey, goal)

  if (notify) {
    await sendTelegramNotification(daemonReport, asyncResult)
  }

  if (asyncResult) {
    console.log(`[watchdog] Recovery session: ${asyncResult.sessionKey}`)
    console.log(`[watchdog] Reconnect: bun run ${LAUNCHER_ENTRY} --session '${asyncResult.sessionKey}'`)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error('[watchdog] Fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
