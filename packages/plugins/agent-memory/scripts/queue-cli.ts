#!/usr/bin/env bun
/**
 * Queue CLI
 *
 * Manage the job queue directly.
 *
 * Usage:
 *   bun run scripts/queue-cli.ts list [--status=pending] [--type=derived:run]
 *   bun run scripts/queue-cli.ts clear [--status=pending] [--type=derived:run]
 *   bun run scripts/queue-cli.ts cancel <job-id>
 *   bun run scripts/queue-cli.ts stats
 *   bun run scripts/queue-cli.ts dead [--limit=20]
 *   bun run scripts/queue-cli.ts retry <job-id>
 *   bun run scripts/queue-cli.ts prune [--older-than=7d]
 */

import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

interface CliOptions {
  help: boolean
  status?: string
  type?: string
  limit?: number
  'older-than'?: string
}

function parseCliArgs(): { options: CliOptions; args: string[] } {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      status: { type: 'string', short: 's' },
      type: { type: 'string', short: 't' },
      limit: { type: 'string', short: 'l' },
      'older-than': { type: 'string' },
    },
    allowPositionals: true,
  })

  return {
    options: {
      help: values.help ?? false,
      status: values.status,
      type: values.type,
      limit: values.limit ? parseInt(values.limit, 10) : undefined,
      'older-than': values['older-than'],
    },
    args: positionals,
  }
}

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
    // .env not found
  }
}

function printHelp(): void {
  console.log(`
Queue CLI - Manage the job queue

Usage:
  bun run scripts/queue-cli.ts <command> [options]

Commands:
  list              List jobs in the queue
  clear             Clear jobs (mark as dead)
  cancel <job-id>   Cancel a specific job
  stats             Show queue statistics
  dead              List dead jobs
  retry <job-id>    Retry a dead job
  prune             Delete old completed jobs

Options:
  -h, --help              Show this help
  -s, --status <status>   Filter by status (pending, running, completed, dead)
  -t, --type <type>       Filter by job type (sync:collect, sync:process, derived:run)
  -l, --limit <n>         Limit results (default: 20)
  --older-than <duration> For prune: delete jobs older than (e.g., 7d, 24h)

Examples:
  # List pending jobs
  bun run scripts/queue-cli.ts list --status=pending

  # Clear all pending derived jobs
  bun run scripts/queue-cli.ts clear --status=pending --type=derived:run

  # Cancel a specific job
  bun run scripts/queue-cli.ts cancel 01ABC...

  # Show queue stats
  bun run scripts/queue-cli.ts stats

  # Retry a dead job
  bun run scripts/queue-cli.ts retry 01ABC...

  # Prune completed jobs older than 7 days
  bun run scripts/queue-cli.ts prune --older-than=7d
`)
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(d|h|m|s)$/)
  if (!match) throw new Error(`Invalid duration: ${duration}`)
  const value = parseInt(match[1], 10)
  const unit = match[2]
  switch (unit) {
    case 'd': return value * 24 * 60 * 60 * 1000
    case 'h': return value * 60 * 60 * 1000
    case 'm': return value * 60 * 1000
    case 's': return value * 1000
    default: throw new Error(`Unknown unit: ${unit}`)
  }
}

function formatDate(date: Date | string | null): string {
  if (!date) return '-'
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleString()
}

function truncate(str: string | null, len: number): string {
  if (!str) return '-'
  return str.length > len ? str.slice(0, len - 3) + '...' : str
}

// ============ Commands ============

async function listJobs(
  sql: ReturnType<typeof postgres>,
  options: CliOptions
): Promise<void> {
  const limit = options.limit ?? 20
  const status = options.status
  const jobType = options.type

  let query = sql`
    SELECT id, job_type, status, attempt_count, max_attempts,
           last_error, created_at, visible_at
    FROM job_queue
    WHERE 1=1
  `

  if (status) {
    query = sql`
      SELECT id, job_type, status, attempt_count, max_attempts,
             last_error, created_at, visible_at
      FROM job_queue
      WHERE status = ${status}
      ${jobType ? sql`AND job_type = ${jobType}` : sql``}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
  } else if (jobType) {
    query = sql`
      SELECT id, job_type, status, attempt_count, max_attempts,
             last_error, created_at, visible_at
      FROM job_queue
      WHERE job_type = ${jobType}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
  } else {
    query = sql`
      SELECT id, job_type, status, attempt_count, max_attempts,
             last_error, created_at, visible_at
      FROM job_queue
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
  }

  const rows = await query

  if (rows.length === 0) {
    console.log('No jobs found.')
    return
  }

  console.log(`Found ${rows.length} job(s):\n`)
  for (const row of rows) {
    const icon = row.status === 'completed' ? '✓' :
                 row.status === 'dead' ? '☠' :
                 row.status === 'running' ? '▶' :
                 row.status === 'pending' ? '○' : '?'
    console.log(`  ${icon} ${row.id}  ${row.job_type}  [${row.status}]`)
    console.log(`     Attempts: ${row.attempt_count}/${row.max_attempts}`)
    console.log(`     Created: ${formatDate(row.created_at)}`)
    if (row.visible_at) {
      console.log(`     Visible: ${formatDate(row.visible_at)}`)
    }
    if (row.last_error) {
      console.log(`     Error: ${truncate(row.last_error, 80)}`)
    }
    console.log('')
  }
}

async function clearJobs(
  sql: ReturnType<typeof postgres>,
  options: CliOptions
): Promise<void> {
  const status = options.status ?? 'pending'
  const jobType = options.type

  let result
  if (jobType) {
    result = await sql`
      UPDATE job_queue
      SET status = 'dead',
          completed_at = NOW(),
          last_error = 'Manually cleared via CLI'
      WHERE status = ${status}
        AND job_type = ${jobType}
      RETURNING id
    `
  } else {
    result = await sql`
      UPDATE job_queue
      SET status = 'dead',
          completed_at = NOW(),
          last_error = 'Manually cleared via CLI'
      WHERE status = ${status}
      RETURNING id
    `
  }

  console.log(`✓ Cleared ${result.length} ${status} job(s)${jobType ? ` of type ${jobType}` : ''}`)
}

async function cancelJob(
  sql: ReturnType<typeof postgres>,
  jobId: string
): Promise<void> {
  const [row] = await sql`
    UPDATE job_queue
    SET status = 'dead',
        completed_at = NOW(),
        last_error = 'Cancelled via CLI'
    WHERE id = ${jobId}
      AND status IN ('pending', 'running')
    RETURNING id, job_type, status
  `

  if (!row) {
    console.error(`Job not found or already completed: ${jobId}`)
    process.exit(1)
  }

  console.log(`✓ Cancelled job: ${row.id} (${row.job_type})`)
}

async function showStats(sql: ReturnType<typeof postgres>): Promise<void> {
  const statusCounts = await sql`
    SELECT status, COUNT(*) as count
    FROM job_queue
    GROUP BY status
    ORDER BY count DESC
  `

  const typeCounts = await sql`
    SELECT job_type, status, COUNT(*) as count
    FROM job_queue
    GROUP BY job_type, status
    ORDER BY job_type, status
  `

  console.log('Queue Statistics\n')
  console.log('By Status:')
  for (const row of statusCounts) {
    console.log(`  ${row.status}: ${row.count}`)
  }

  console.log('\nBy Type and Status:')
  let currentType = ''
  for (const row of typeCounts) {
    if (row.job_type !== currentType) {
      currentType = row.job_type
      console.log(`\n  ${currentType}:`)
    }
    console.log(`    ${row.status}: ${row.count}`)
  }
}

async function listDeadJobs(
  sql: ReturnType<typeof postgres>,
  options: CliOptions
): Promise<void> {
  const limit = options.limit ?? 20

  const rows = await sql`
    SELECT id, job_type, attempt_count, last_error, created_at, completed_at
    FROM job_queue
    WHERE status = 'dead'
    ORDER BY completed_at DESC
    LIMIT ${limit}
  `

  if (rows.length === 0) {
    console.log('No dead jobs found.')
    return
  }

  console.log(`Found ${rows.length} dead job(s):\n`)
  for (const row of rows) {
    console.log(`  ☠ ${row.id}  ${row.job_type}`)
    console.log(`     Attempts: ${row.attempt_count}`)
    console.log(`     Created: ${formatDate(row.created_at)}`)
    console.log(`     Died: ${formatDate(row.completed_at)}`)
    if (row.last_error) {
      console.log(`     Error: ${truncate(row.last_error, 80)}`)
    }
    console.log('')
  }
}

async function retryJob(
  sql: ReturnType<typeof postgres>,
  jobId: string
): Promise<void> {
  const [row] = await sql`
    UPDATE job_queue
    SET status = 'pending',
        visible_at = NOW(),
        attempt_count = 0,
        last_error = NULL,
        completed_at = NULL
    WHERE id = ${jobId}
      AND status = 'dead'
    RETURNING id, job_type
  `

  if (!row) {
    console.error(`Dead job not found: ${jobId}`)
    process.exit(1)
  }

  console.log(`✓ Retrying job: ${row.id} (${row.job_type})`)
}

async function pruneJobs(
  sql: ReturnType<typeof postgres>,
  options: CliOptions
): Promise<void> {
  const olderThan = options['older-than'] ?? '7d'
  const ms = parseDuration(olderThan)
  const cutoff = new Date(Date.now() - ms)

  const result = await sql`
    DELETE FROM job_queue
    WHERE status = 'completed'
      AND completed_at < ${cutoff}
    RETURNING id
  `

  console.log(`✓ Pruned ${result.length} completed job(s) older than ${olderThan}`)
}

// ============ Main ============

async function main(): Promise<void> {
  const { options, args } = parseCliArgs()

  if (options.help || args.length === 0) {
    printHelp()
    process.exit(0)
  }

  const command = args[0]

  await loadEnvFile(join(import.meta.dir, '../../../.env'))

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL not set')
    process.exit(1)
  }

  const sql = postgres(databaseUrl, { max: 5 })

  try {
    switch (command) {
      case 'list':
        await listJobs(sql, options)
        break
      case 'clear':
        await clearJobs(sql, options)
        break
      case 'cancel': {
        if (args.length < 2) {
          console.error('Usage: cancel <job-id>')
          process.exit(1)
        }
        await cancelJob(sql, args[1])
        break
      }
      case 'stats':
        await showStats(sql)
        break
      case 'dead':
        await listDeadJobs(sql, options)
        break
      case 'retry': {
        if (args.length < 2) {
          console.error('Usage: retry <job-id>')
          process.exit(1)
        }
        await retryJob(sql, args[1])
        break
      }
      case 'prune':
        await pruneJobs(sql, options)
        break
      default:
        console.error(`Unknown command: ${command}`)
        printHelp()
        process.exit(1)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
