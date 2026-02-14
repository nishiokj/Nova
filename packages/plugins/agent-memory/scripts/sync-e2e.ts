#!/usr/bin/env bun
/**
 * Sync E2E Trace
 *
 * Runs a single end-to-end flow:
 * task -> scheduler -> queue -> collector -> processor.
 *
 * Usage:
 *   bun run packages/plugins/agent-memory/scripts/sync-e2e.ts --connector claude_sessions
 *
 * Options:
 *   --connector <type>        Connector type (default: claude_sessions)
 *   --sync-type <type>        backfill | incremental (default: backfill)
 *   --mode <type>             once | recurring (default: once)
 *   --interval-ms <ms>        Recurring interval in ms (default: 1000)
 *   --entity-types <csv>      Comma-separated entity types
 *   --connector-config <json> JSON config passed to connector factory
 *   --timeout-ms <ms>         Overall timeout (default: 120000)
 *   --scheduler-poll-ms <ms>  Scheduler poll interval (default: 10000)
 *   --queue-poll-ms <ms>      Queue poll interval (default: 100)
 */

import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'
import { SyncDaemon } from '../src/daemon/index.js'
import { createConnector } from '../src/connectors/registry.js'
import { createJobQueueRepository } from '../src/db/repositories/job-queue.js'

type SyncMode = 'once' | 'recurring'
type SyncType = 'backfill' | 'incremental'

const args = parseArgs({
  options: {
    connector: { type: 'string', default: 'claude_sessions' },
    'sync-type': { type: 'string', default: 'backfill' },
    mode: { type: 'string', default: 'once' },
    'interval-ms': { type: 'string', default: '1000' },
    'entity-types': { type: 'string' },
    'connector-config': { type: 'string' },
    'timeout-ms': { type: 'string', default: '120000' },
    'scheduler-poll-ms': { type: 'string', default: '10000' },
    'queue-poll-ms': { type: 'string', default: '100' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (args.values.help) {
  console.log('Usage: bun run packages/plugins/agent-memory/scripts/sync-e2e.ts [options]')
  process.exit(0)
}

const connectorType = String(args.values.connector)
const syncType = (args.values['sync-type'] ?? 'backfill') as SyncType
const mode = (args.values.mode ?? 'once') as SyncMode
const intervalMs = parseInt(String(args.values['interval-ms'] ?? '1000'), 10)
const timeoutMs = parseInt(String(args.values['timeout-ms'] ?? '120000'), 10)
const schedulerPollMs = parseInt(String(args.values['scheduler-poll-ms'] ?? '10000'), 10)
const queuePollMs = parseInt(String(args.values['queue-poll-ms'] ?? '100'), 10)

const entityTypes = args.values['entity-types']
  ? String(args.values['entity-types']).split(',').map((t) => t.trim()).filter(Boolean)
  : undefined

let connectorConfig: Record<string, unknown> | undefined
if (args.values['connector-config']) {
  try {
    connectorConfig = JSON.parse(String(args.values['connector-config']))
  } catch (error) {
    console.error('Invalid --connector-config JSON:', error)
    process.exit(1)
  }
}

await loadEnvFile(join(import.meta.dir, '../../../../.env'))

const databaseUrl = process.env.DATABASE_URL
const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY

if (!databaseUrl || !encryptionKey) {
  console.error('Missing DATABASE_URL or CREDENTIAL_ENCRYPTION_KEY in environment.')
  process.exit(1)
}

if (encryptionKey.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
  console.error('CREDENTIAL_ENCRYPTION_KEY must be a 32-byte hex string.')
  process.exit(1)
}

if (mode === 'recurring' && (!intervalMs || intervalMs < 1000)) {
  console.error('intervalMs must be at least 1000 for recurring mode.')
  process.exit(1)
}

console.log('Starting E2E trace')
console.log(`  Connector: ${connectorType}`)
console.log(`  Sync type: ${syncType}`)
console.log(`  Mode: ${mode}`)
if (entityTypes?.length) {
  console.log(`  Entity types: ${entityTypes.join(', ')}`)
}

const sql = postgres(databaseUrl, { max: 5 })
const daemon = await SyncDaemon.create({
  sql,
  encryptionKey: Buffer.from(encryptionKey, 'hex'),
  port: 0,
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL || 'http://localhost',
  engine: {
    autoProcess: true,
    pollInterval: queuePollMs,
  },
  scheduler: {
    pollInterval: schedulerPollMs,
  },
})

// Load all registered connectors from database before registering the test connector
await daemon.loadRegisteredConnectors()

const connector = await createConnector(connectorType as any, connectorConfig ?? {})
// Only register if not already loaded from database
if (!daemon.hasConnector(connectorType as any)) {
  daemon.registerConnector(connector)
}

const account = await daemon.resolveAccount(connectorType as any)
const sanity = await daemon.checkTaskSanity({
  connector: connectorType as any,
  accountId: account.id,
  entityTypes,
  syncType,
  mode,
})

if (!sanity.ok) {
  console.log('Task sanity check failed:')
  console.log(JSON.stringify(sanity, null, 2))
  process.exit(1)
}

const task = await daemon.taskRepo.create({
  connector: connectorType as any,
  accountId: account.id,
  entityTypes,
  syncType,
  mode,
  intervalMs: mode === 'recurring' ? intervalMs : undefined,
})

console.log(`OK Task created: ${task.id}`)

let scheduledJobId: string | null = null
const scheduledJobPromise = waitForSchedulerEvent(daemon, task.id)

attachEventLogs(daemon)

await daemon.engine.start()
await daemon.scheduler.start()

const scheduledJob = await withTimeout(scheduledJobPromise, timeoutMs, 'Scheduler did not execute task')
scheduledJobId = scheduledJob.id

console.log(`OK Scheduler enqueued job: ${scheduledJobId}`)

const queueRepo = createJobQueueRepository({ sql })
const collectQueueJob = await waitForQueueJob(queueRepo, 'sync:collect', scheduledJobId, timeoutMs)
if (collectQueueJob) {
  console.log(`OK Queue job created: ${collectQueueJob.id} (${collectQueueJob.status})`)
  await watchQueueJob(queueRepo, collectQueueJob.id, 'collect', timeoutMs)
} else {
  console.log('WARN No collect queue job found (may have completed before lookup).')
}

const processQueueJob = await waitForQueueJob(queueRepo, 'sync:process', scheduledJobId, timeoutMs)
if (processQueueJob) {
  console.log(`OK Process job created: ${processQueueJob.id} (${processQueueJob.status})`)
  await watchQueueJob(queueRepo, processQueueJob.id, 'process', timeoutMs)
}

const finalJob = await waitForSyncJob(daemon, scheduledJobId, timeoutMs)
console.log(`OK Sync job ${finalJob.status}: ${finalJob.id}`)

const envelopeStats = await fetchEnvelopeStats(sql, scheduledJobId)
console.log('Envelope stats:', envelopeStats)

await daemon.scheduler.stop()
await daemon.engine.stop()
await sql.end({ timeout: 5 })
console.log('OK Done')

// ============ Helpers ============

async function loadEnvFile(path: string): Promise<void> {
  try {
    const content = await readFile(path, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^([^=]+)=(.*)$/)
      if (match) {
        const key = match[1].trim()
        let value = match[2].trim()
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        process.env[key] = value
      }
    }
  } catch {
    // .env not found, continue with existing env
  }
}

function attachEventLogs(daemon: SyncDaemon): void {
  daemon.scheduler.onEvent((event) => {
    if (event.type === 'scheduler:task_executed') {
      console.log(`[scheduler] task_executed ${event.task.id} -> job ${event.job.id}`)
      return
    }
    if (event.type === 'scheduler:task_error') {
      console.log(`[scheduler] task_error ${event.task.id}: ${event.error.message}`)
      return
    }
    if (event.type === 'scheduler:tick') {
      console.log(`[scheduler] tick processed=${event.processed}`)
    }
  })

  daemon.engine.onEvent((event) => {
    switch (event.type) {
      case 'sync:started':
        console.log(`[sync] started ${event.job.id} (${event.job.job_type})`)
        break
      case 'collect:page':
        console.log(`[collect] page items=${event.items} cursor=${event.cursor ?? '-'}`)
        break
      case 'sync:completed':
        console.log(`[sync] completed ${event.job.id}`)
        break
      case 'sync:failed':
        console.log(`[sync] failed ${event.job.id}: ${event.error.message}`)
        break
      case 'process:envelope':
        if (!event.success) {
          console.log(`[process] envelope failed ${event.envelopeId}`)
        }
        break
      default:
        break
    }
  })
}

function waitForSchedulerEvent(daemon: SyncDaemon, taskId: string): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    let done = false
    daemon.scheduler.onEvent((event) => {
      if (done) return
      if (event.type === 'scheduler:task_executed' && event.task.id === taskId) {
        done = true
        resolve({ id: event.job.id })
      } else if (event.type === 'scheduler:task_error' && event.task.id === taskId) {
        done = true
        reject(event.error)
      }
    })
  })
}

async function waitForQueueJob(
  repo: ReturnType<typeof createJobQueueRepository>,
  jobType: string,
  syncJobId: string,
  timeout: number
): Promise<{ id: string; status: string } | null> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const { items } = await repo.findByType(jobType, { limit: 25 })
    const match = items.find((item) => {
      const payload = item.payload as { syncJobId?: string } | undefined
      return payload?.syncJobId === syncJobId
    })
    if (match) {
      return { id: match.id, status: match.status }
    }
    await sleep(200)
  }
  return null
}

async function watchQueueJob(
  repo: ReturnType<typeof createJobQueueRepository>,
  jobId: string,
  label: string,
  timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout
  let lastStatus: string | null = null
  while (Date.now() < deadline) {
    const job = await repo.findById(jobId)
    if (!job) return
    if (job.status !== lastStatus) {
      console.log(`[queue:${label}] ${job.status} (attempts=${job.attempt_count})`)
      lastStatus = job.status
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'dead') {
      return
    }
    await sleep(250)
  }
}

async function waitForSyncJob(daemon: SyncDaemon, jobId: string, timeout: number) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const job = await daemon.syncJobRepo.findById(jobId)
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) {
      return job
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for sync job: ${jobId}`)
}

async function fetchEnvelopeStats(sql: ReturnType<typeof postgres>, syncJobId: string) {
  const [row] = await sql<{ total: string; processed: string; failed: string }[]>`
    SELECT
      COUNT(*)::text AS total,
      COUNT(processed_at)::text AS processed,
      COUNT(processing_error)::text AS failed
    FROM raw_envelopes
    WHERE sync_job_id = ${syncJobId}
  `
  return {
    total: parseInt(row?.total ?? '0', 10),
    processed: parseInt(row?.processed ?? '0', 10),
    failed: parseInt(row?.failed ?? '0', 10),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeout)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId!)
  }
}
