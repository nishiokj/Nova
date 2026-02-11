#!/usr/bin/env bun
/**
 * Watchdog Derived Task
 *
 * Health-check and auto-restart for the harness daemon. Checks process health,
 * TCP connectivity, log freshness, and recent errors. Auto-restarts daemon
 * if unhealthy and optionally starts async diagnosis.
 *
 * Runs as a recurring derived task via sync daemon.
 */

import { createConnection } from 'net'
import { execSync, spawn } from 'child_process'
import { statSync, readFileSync, existsSync } from 'fs'
import path from 'path'
import type {
  DerivedRunContext,
  DerivedRunResult,
  DerivedMetadataSchema,
} from '../src/derived/runner.js'

// ─── Config ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(import.meta.dir, '..', '..', '..')
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

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export const metadata: DerivedMetadataSchema = {
  fields: {
    stale_minutes: {
      type: 'number',
      default: 120,
      description: 'Log staleness threshold in minutes (default: 120 = 2 hours)',
    },
    notify: {
      type: 'boolean',
      default: true,
      description: 'Send Telegram notification on restart',
    },
    auto_restart: {
      type: 'boolean',
      default: true,
      description: 'Auto-restart daemon if unhealthy',
    },
  },
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
    lastLogAgeMinutes !== null ? lastLogAgeMinutes < staleMinutes : true
  const recentErrors = getRecentErrors(HARNESS_LOG)

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

// ─── Daemon Control ────────────────────────────────────────────────────────────

function killDaemon(): void {
  try {
    execSync('pkill -TERM -f "harness-daemon"', { stdio: 'ignore' })
  } catch {
    // No process to kill
  }
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
}

// ─── Telegram Notification ─────────────────────────────────────────────────────

async function sendTelegramNotification(
  report: HealthReport,
  logger: DerivedRunContext['logger']
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const allowedUsers = process.env.TELEGRAM_ALLOWED_USERS
  if (!botToken || !allowedUsers) {
    logger.info('Telegram notification skipped (no TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USERS)')
    return
  }

  const chatIds = allowedUsers
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id))

  if (chatIds.length === 0) return

  const { notifyAllUsers } = await import('../src/connectors/telegram/notify.ts')

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

  await notifyAllUsers(botToken, chatIds, lines.join('\n'), 'Markdown')
  logger.info('Telegram notification sent')
}

// ─── Main Run Function ─────────────────────────────────────────────────────────

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { logger } = ctx

  logger.info('Starting watchdog health check')

  // Get config from task metadata
  const config = ctx.task.metadata as Record<string, unknown> | undefined
  const staleMinutes = (config?.stale_minutes as number) ?? DEFAULT_STALE_MINUTES
  const notify = (config?.notify as boolean) ?? true
  const autoRestart = (config?.auto_restart as boolean) ?? true

  // Run health check
  const report = await runHealthCheck(staleMinutes)

  logger.info(`Health check result: ${report.healthy ? 'HEALTHY' : 'UNHEALTHY'}`)
  logger.info(`  Daemon reachable:  ${report.daemonReachable ? 'yes' : 'NO'}`)
  logger.info(`  Process alive:     ${report.processAlive ? 'yes' : 'NO'}`)
  logger.info(`  Log fresh:         ${report.logFresh ? 'yes' : 'NO'}`)
  if (report.lastLogAgeMinutes !== null) {
    logger.info(`  Harness log age:   ${report.lastLogAgeMinutes.toFixed(1)} minutes`)
  }
  if (report.recentErrors.length > 0) {
    logger.info(`  Recent errors:     ${report.recentErrors.length}`)
  }

  // If healthy, just log and return
  if (report.healthy) {
    logger.info('No action needed')
    return { metadata: { status: 'healthy', diagnosis: report.diagnosis } }
  }

  logger.warn(`Daemon is unhealthy: ${report.diagnosis}`)

  if (!autoRestart) {
    logger.info('Auto-restart disabled, taking no action')
    return { metadata: { status: 'unhealthy', diagnosis: report.diagnosis } }
  }

  // Restart daemon
  logger.info('Killing existing daemon...')
  killDaemon()
  await new Promise((r) => setTimeout(r, 3000))

  logger.info('Starting daemon (headless, no idle timeout)...')
  startDaemon()

  const ready = await waitForDaemonReady()
  if (!ready) {
    logger.error('Daemon failed to start within timeout')
    if (notify) {
      await sendTelegramNotification(report, logger)
    }
    return {
      metadata: { status: 'failed', diagnosis: 'Daemon failed to start after restart' },
    }
  }

  logger.info('Daemon is ready')

  if (notify) {
    await sendTelegramNotification(report, logger)
  }

  return {
    metadata: {
      status: 'restarted',
      diagnosis: report.diagnosis,
      actionsTaken: ['daemon_killed', 'daemon_started'],
    },
  }
}
