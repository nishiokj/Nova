#!/usr/bin/env bun
/**
 * Derived Task CLI
 *
 * Utility for creating and managing derived tasks.
 *
 * Usage:
 *   bun run scripts/derived-cli.ts create <name> <script-path> [options]
 *   bun run scripts/derived-cli.ts list
 *   bun run scripts/derived-cli.ts run <task-id> [options]
 *   bun run scripts/derived-cli.ts logs <task-id>
 *   bun run scripts/derived-cli.ts report <task-id> [options]
 */

import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'
import {
  createDerivedTaskRepository,
  type DerivedTask,
} from '../src/db/repositories/derived-task.js'
import {
  createDerivedJobRepository,
} from '../src/db/repositories/derived-job.js'
import {
  createDerivedRunLogRepository,
} from '../src/db/repositories/derived-run-log.js'
import { generateCanonicalId } from '../src/ids.js'
import { loadScriptMetadata, type DerivedMetadataSchema } from '../src/derived/runner.js'

interface CliOptions {
  help: boolean
  mode?: 'once' | 'recurring' | 'event'
  'interval-ms'?: number
  priority?: number
  metadata?: string
  label?: string
  purpose?: string
  'sanity-policy'?: string
  'report-limit'?: number
  verbose: boolean
}

function parseCliArgs(): { options: CliOptions; args: string[] } {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      mode: { type: 'string' },
      'interval-ms': { type: 'string' },
      priority: { type: 'string' },
      metadata: { type: 'string' },
      label: { type: 'string' },
      purpose: { type: 'string' },
      'sanity-policy': { type: 'string' },
      'report-limit': { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: true,
  })

  return {
    options: {
      help: values.help ?? false,
      mode: values.mode as 'once' | 'recurring' | 'event' | undefined,
      'interval-ms': values['interval-ms'] ? parseInt(values['interval-ms'], 10) : undefined,
      priority: values.priority ? parseInt(values.priority, 10) : undefined,
      metadata: values.metadata,
      label: values.label,
      purpose: values.purpose,
      'sanity-policy': values['sanity-policy'],
      'report-limit': values['report-limit'] ? parseInt(values['report-limit'], 10) : undefined,
      verbose: values.verbose ?? false,
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
    // .env not found, continue
  }
}

function printHelp(): void {
  console.log(`
Derived Task CLI

Usage:
  bun run scripts/derived-cli.ts <command> [options]

Commands:
  create <name> <script-path>    Create a new derived task
  list                           List all derived tasks
  run <task-id>                  Run a task immediately
  logs <task-id>                 Show recent jobs for a task
  report <task-id>               Show recent run logs for a task
  disable <task-id>              Disable a task
  enable <task-id>               Enable a disabled task
  delete <task-id>               Delete a task permanently
  circuit                        Show tasks with open circuits
  reset <task-id>                Reset circuit breaker for a task

Options:
  -h, --help                     Show this help message
  -v, --verbose                  Show detailed output
  --mode <once|recurring|event>  Task mode (default: once)
  --interval-ms <ms>             Interval for recurring mode
  --priority <number>            Job priority (default: 0)
  --metadata <json>              Metadata to attach to task/job
  --label <text>                 Short human-readable label
  --purpose <text>               One-line task purpose
  --sanity-policy <json>         Sanity policy JSON for this task
  --report-limit <number>        Limit rows for report command

Circuit Breaker:
  Tasks auto-disable after consecutive failures (default: 3).
  Circuit reopens with exponential backoff (5min, 10min, 20min, ...).
  Use 'reset' to manually close the circuit and retry.

Examples:
  # Create a once-off task
  bun run scripts/derived-cli.ts create extract-preferences scripts/derive-preferences.ts --mode once

  # Create a recurring task (runs every hour)
  bun run scripts/derived-cli.ts create aggregate-stats scripts/aggregate-stats.ts --mode recurring --interval-ms 3600000

  # Run a task immediately
  bun run scripts/derived-cli.ts run 01ABC...

  # List all tasks
  bun run scripts/derived-cli.ts list

  # Show tasks with open circuits
  bun run scripts/derived-cli.ts circuit

  # Reset a tripped circuit
  bun run scripts/derived-cli.ts reset 01ABC...

Environment:
  DATABASE_URL    PostgreSQL connection string
`)
}

// ============ Commands ============

function validateMetadata(
  metadata: Record<string, unknown> | undefined,
  schema: DerivedMetadataSchema,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...metadata }
  const errors: string[] = []

  for (const [field, def] of Object.entries(schema.fields)) {
    const value = result[field]

    if (value === undefined || value === null) {
      if (def.required) {
        errors.push(`  Missing required field: ${field} (${def.type}) — ${def.description}`)
      } else if (def.default !== undefined) {
        result[field] = def.default
      }
      continue
    }

    // Type check
    if (typeof value !== def.type) {
      errors.push(`  Field "${field}" must be ${def.type}, got ${typeof value} — ${def.description}`)
    }
  }

  if (errors.length > 0) {
    console.error('Error: Metadata validation failed:\n' + errors.join('\n'))
    process.exit(1)
  }

  return result
}

async function createTask(
  name: string,
  scriptPath: string,
  options: CliOptions,
  taskRepo: ReturnType<typeof createDerivedTaskRepository>
): Promise<void> {
  const mode = options.mode ?? 'once'

  if (mode === 'recurring' && !options['interval-ms']) {
    console.error('Error: --interval-ms is required for recurring mode')
    process.exit(1)
  }

  let metadata: Record<string, unknown> | undefined
  if (options.metadata) {
    try {
      metadata = JSON.parse(options.metadata)
    } catch {
      console.error('Error: Invalid JSON in --metadata')
      process.exit(1)
    }
  }

  let sanityPolicy: Record<string, unknown> | undefined
  if (options['sanity-policy']) {
    try {
      sanityPolicy = JSON.parse(options['sanity-policy'])
    } catch {
      console.error('Error: Invalid JSON in --sanity-policy')
      process.exit(1)
    }
  }

  // Validate metadata against script's schema
  const schema = await loadScriptMetadata(scriptPath)
  if (schema) {
    metadata = validateMetadata(metadata, schema)
    // Only pass metadata if it has keys (avoid empty object)
    if (Object.keys(metadata).length === 0) metadata = undefined
  }

  const task = await taskRepo.create({
    name,
    label: options.label ?? null,
    purpose: options.purpose ?? null,
    scriptPath,
    mode,
    intervalMs: options['interval-ms'],
    metadata,
    sanityPolicy,
  })

  console.log(`✓ Created derived task: ${task.id}`)
  console.log(`  Name: ${task.name}`)
  console.log(`  Script: ${task.script_path}`)
  console.log(`  Mode: ${task.mode}`)
  if (task.interval_ms) {
    console.log(`  Interval: ${task.interval_ms}ms`)
  }
  console.log(`  Enabled: ${task.enabled}`)
  console.log('')
  console.log(`Run with: bun run scripts/derived-cli.ts run ${task.id}`)
}

async function listTasks(
  taskRepo: ReturnType<typeof createDerivedTaskRepository>,
  options: CliOptions
): Promise<void> {
  const tasks = await taskRepo.findAll(100)

  if (tasks.length === 0) {
    console.log('No derived tasks found.')
    return
  }

  console.log(`Found ${tasks.length} derived task(s):\n`)

  for (const task of tasks) {
    const status = task.enabled ? 'enabled' : 'disabled'
    const circuitStatus = task.circuit_open_until && new Date(task.circuit_open_until) > new Date()
      ? ` ⚡CIRCUIT OPEN until ${task.circuit_open_until}`
      : ''
    console.log(`  ${task.id}  ${task.name} [${status}]${circuitStatus}`)
    if (task.label) {
      console.log(`    Label: ${task.label}`)
    }
    if (task.purpose) {
      console.log(`    Purpose: ${task.purpose}`)
    }
    console.log(`    Script: ${task.script_path}`)
    console.log(`    Mode: ${task.mode}`)
    if (task.interval_ms) {
      console.log(`    Interval: ${task.interval_ms}ms`)
    }
    if (task.next_run_at) {
      console.log(`    Next run: ${task.next_run_at}`)
    }
    if (task.last_job_id) {
      console.log(`    Last job: ${task.last_job_id}`)
    }
    if (task.last_success_at) {
      console.log(`    Last success: ${task.last_success_at}`)
    }
    if (task.last_error_at) {
      console.log(`    Last error: ${task.last_error_at}`)
    }
    if (task.last_error_code) {
      console.log(`    Error code: ${task.last_error_code}`)
    }
    if (task.consecutive_failures > 0) {
      console.log(`    Failures: ${task.consecutive_failures}/${task.max_failures}`)
    }
    console.log('')
  }
}

async function runTask(
  taskId: string,
  options: CliOptions,
  sql: ReturnType<typeof postgres>,
  taskRepo: ReturnType<typeof createDerivedTaskRepository>,
  jobRepo: ReturnType<typeof createDerivedJobRepository>
): Promise<void> {
  const task = await taskRepo.findById(taskId)
  if (!task) {
    console.error(`Error: Derived task not found: ${taskId}`)
    process.exit(1)
  }

  let metadata: Record<string, unknown> | undefined
  if (options.metadata) {
    try {
      metadata = JSON.parse(options.metadata)
    } catch {
      console.error('Error: Invalid JSON in --metadata')
      process.exit(1)
    }
  }

  const job = await jobRepo.create({
    task_id: task.id,
    priority: options.priority,
    metadata,
  })

  // Enqueue to job_queue so the MicroQueue worker picks it up
  const queueId = generateCanonicalId()
  const idempotencyKey = `derived:${task.id}:${job.id}`
  const payload = JSON.stringify({ derivedJobId: job.id })

  await sql`
    INSERT INTO job_queue (id, job_type, payload, status, priority, visible_at, max_attempts, idempotency_key)
    VALUES (${queueId}, 'derived:run', ${payload}::jsonb, 'pending', ${options.priority ?? 0}, NOW(), 3, ${idempotencyKey})
    ON CONFLICT (idempotency_key) DO NOTHING
  `

  await taskRepo.markExecuted(task.id, job.id)

  if (task.mode === 'once') {
    await taskRepo.update(task.id, { enabled: false })
  } else if (task.mode === 'recurring' && task.interval_ms) {
    const nextRunAt = new Date(Date.now() + task.interval_ms)
    await taskRepo.updateNextRunAt(task.id, nextRunAt)
  }

  console.log(`✓ Created job: ${job.id}`)
  console.log(`  Task: ${task.name} (${task.id})`)
  console.log(`  Priority: ${job.priority}`)
  console.log(`  Status: ${job.status}`)
  console.log(`  Queue ID: ${queueId}`)
  console.log('')
  console.log('Job enqueued. The sync daemon must be running to process it.')
  console.log('Start the sync daemon: bun run scripts/sync-daemon.ts')
}

async function showTaskLogs(
  taskId: string,
  taskRepo: ReturnType<typeof createDerivedTaskRepository>,
  jobRepo: ReturnType<typeof createDerivedJobRepository>
): Promise<void> {
  const task = await taskRepo.findById(taskId)
  if (!task) {
    console.error(`Error: Derived task not found: ${taskId}`)
    process.exit(1)
  }

  const jobs = await jobRepo.findByTask(task.id, 20)

  if (jobs.length === 0) {
    console.log(`No jobs found for task "${task.name}".`)
    return
  }

  console.log(`Task: ${task.name} (${task.id})`)
  console.log(`Script: ${task.script_path}\n`)
  console.log(`Recent jobs (${jobs.length}):\n`)

  for (const job of jobs) {
    const icon = job.status === 'completed' ? '✓' : job.status === 'failed' ? '✗' : '○'
    console.log(`  ${icon} ${job.id}  ${job.status}`)
    console.log(`     Created: ${job.created_at}`)
    if (job.started_at) {
      console.log(`     Started: ${job.started_at}`)
    }
    if (job.completed_at) {
      console.log(`     Completed: ${job.completed_at}`)
    }
    if (job.last_error) {
      console.log(`     Error: ${job.last_error}`)
    }
    if (job.retry_count > 0) {
      console.log(`     Retries: ${job.retry_count}`)
    }
    console.log('')
  }
}

async function showRunReport(
  taskId: string,
  options: CliOptions,
  taskRepo: ReturnType<typeof createDerivedTaskRepository>,
  runLogRepo: ReturnType<typeof createDerivedRunLogRepository>
): Promise<void> {
  const task = await taskRepo.findById(taskId)
  if (!task) {
    console.error(`Error: Derived task not found: ${taskId}`)
    process.exit(1)
  }

  const limit = options['report-limit'] ?? 10
  const runs = await runLogRepo.findByTask(task.id, limit)

  if (runs.length === 0) {
    console.log(`No run logs found for task "${task.name}".`)
    return
  }

  console.log(`Task: ${task.name} (${task.id})`)
  console.log(`Script: ${task.script_path}\n`)
  console.log(`Recent runs (${runs.length}):\n`)

  for (const run of runs) {
    const icon = run.status === 'ok' ? '✓' : run.status === 'skipped' ? '○' : '✗'
    console.log(`  ${icon} ${run.id}  ${run.status}`)
    console.log(`     Created: ${run.created_at}`)
    if (run.model_version) {
      console.log(`     Model: ${run.model_version}`)
    }
    if (run.duration_ms !== null) {
      console.log(`     Duration: ${run.duration_ms}ms`)
    }
    if (run.input_count !== null || run.output_count !== null) {
      console.log(`     Counts: in=${run.input_count ?? 0} out=${run.output_count ?? 0} unusable=${run.output_unusable_count ?? 0}`)
    }
    if (run.skip_reason) {
      console.log(`     Skip: ${run.skip_reason}`)
    }
    if (run.error_code || run.error_msg) {
      console.log(`     Error: ${run.error_code ?? 'unknown'} ${run.error_msg ?? ''}`.trimEnd())
    }
    console.log('')
  }
}

async function disableTask(
  taskId: string,
  taskRepo: ReturnType<typeof createDerivedTaskRepository>
): Promise<void> {
  const task = await taskRepo.findById(taskId)
  if (!task) {
    console.error(`Error: Derived task not found: ${taskId}`)
    process.exit(1)
  }

  await taskRepo.update(taskId, { enabled: false })
  console.log(`✓ Disabled task: ${task.name} (${task.id})`)
}

async function enableTask(
  taskId: string,
  taskRepo: ReturnType<typeof createDerivedTaskRepository>
): Promise<void> {
  const task = await taskRepo.findById(taskId)
  if (!task) {
    console.error(`Error: Derived task not found: ${taskId}`)
    process.exit(1)
  }

  await taskRepo.update(taskId, { enabled: true })
  // Also reset circuit if it was open
  await taskRepo.resetCircuit(taskId)
  console.log(`✓ Enabled task: ${task.name} (${task.id})`)
}

async function showCircuitOpen(
  taskRepo: ReturnType<typeof createDerivedTaskRepository>
): Promise<void> {
  const tasks = await taskRepo.findCircuitOpen()

  if (tasks.length === 0) {
    console.log('No tasks with open circuits.')
    return
  }

  console.log(`Found ${tasks.length} task(s) with open circuits:\n`)

  for (const task of tasks) {
    console.log(`  ⚡ ${task.id}  ${task.name}`)
    console.log(`     Consecutive failures: ${task.consecutive_failures}/${task.max_failures}`)
    console.log(`     Circuit open until: ${task.circuit_open_until}`)
    if (task.last_error) {
      console.log(`     Last error: ${task.last_error.slice(0, 80)}${task.last_error.length > 80 ? '...' : ''}`)
    }
    console.log('')
  }

  console.log('Use: bun run scripts/derived-cli.ts reset <task-id> to reset a circuit')
}

async function resetCircuit(
  taskId: string,
  taskRepo: ReturnType<typeof createDerivedTaskRepository>
): Promise<void> {
  const task = await taskRepo.findById(taskId)
  if (!task) {
    console.error(`Error: Derived task not found: ${taskId}`)
    process.exit(1)
  }

  await taskRepo.resetCircuit(taskId)
  console.log(`✓ Reset circuit for task: ${task.name} (${task.id})`)
  console.log(`  Consecutive failures: 0`)
  console.log(`  Circuit: closed`)
}

async function deleteTask(
  taskId: string,
  sql: ReturnType<typeof postgres>,
  taskRepo: ReturnType<typeof createDerivedTaskRepository>
): Promise<void> {
  const task = await taskRepo.findById(taskId)
  if (!task) {
    console.error(`Error: Derived task not found: ${taskId}`)
    process.exit(1)
  }

  await sql`DELETE FROM derived_tasks WHERE id = ${taskId}`
  console.log(`✓ Deleted task: ${task.name} (${task.id})`)
}

// ============ Main ============

async function main(): Promise<void> {
  const { options, args } = parseCliArgs()

  if (options.help || args.length === 0) {
    printHelp()
    process.exit(0)
  }

  const command = args[0]

  // Load environment
  await loadEnvFile(join(import.meta.dir, '../../../.env'))

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL not set')
    process.exit(1)
  }

  const sql = postgres(databaseUrl, { max: 5 })

  const taskRepo = createDerivedTaskRepository({ sql })
  const jobRepo = createDerivedJobRepository({ sql })
  const runLogRepo = createDerivedRunLogRepository({ sql })

  try {
    switch (command) {
      case 'create': {
        if (args.length < 3) {
          console.error('Usage: create <name> <script-path>')
          process.exit(1)
        }
        const name = args[1]
        const scriptPath = args[2]
        await createTask(name, scriptPath, options, taskRepo)
        break
      }
      case 'list':
        await listTasks(taskRepo, options)
        break
      case 'run': {
        if (args.length < 2) {
          console.error('Usage: run <task-id>')
          process.exit(1)
        }
        const taskId = args[1]
        await runTask(taskId, options, sql, taskRepo, jobRepo)
        break
      }
      case 'logs': {
        if (args.length < 2) {
          console.error('Usage: logs <task-id>')
          process.exit(1)
        }
        const taskId = args[1]
        await showTaskLogs(taskId, taskRepo, jobRepo)
        break
      }
      case 'report': {
        if (args.length < 2) {
          console.error('Usage: report <task-id>')
          process.exit(1)
        }
        const taskId = args[1]
        await showRunReport(taskId, options, taskRepo, runLogRepo)
        break
      }
      case 'disable': {
        if (args.length < 2) {
          console.error('Usage: disable <task-id>')
          process.exit(1)
        }
        const taskId = args[1]
        await disableTask(taskId, taskRepo)
        break
      }
      case 'enable': {
        if (args.length < 2) {
          console.error('Usage: enable <task-id>')
          process.exit(1)
        }
        const taskId = args[1]
        await enableTask(taskId, taskRepo)
        break
      }
      case 'circuit':
        await showCircuitOpen(taskRepo)
        break
      case 'reset': {
        if (args.length < 2) {
          console.error('Usage: reset <task-id>')
          process.exit(1)
        }
        const taskId = args[1]
        await resetCircuit(taskId, taskRepo)
        break
      }
      case 'delete': {
        if (args.length < 2) {
          console.error('Usage: delete <task-id>')
          process.exit(1)
        }
        const taskId = args[1]
        await deleteTask(taskId, sql, taskRepo)
        break
      }
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
