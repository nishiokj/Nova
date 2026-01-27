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

interface CliOptions {
  help: boolean
  mode?: 'once' | 'recurring' | 'event'
  'interval-ms'?: number
  priority?: number
  metadata?: string
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

Options:
  -h, --help                     Show this help message
  -v, --verbose                  Show detailed output
  --mode <once|recurring|event>  Task mode (default: once)
  --interval-ms <ms>             Interval for recurring mode
  --priority <number>            Job priority (default: 0)
  --metadata <json>              Metadata to attach to task/job

Examples:
  # Create a once-off task
  bun run scripts/derived-cli.ts create extract-preferences scripts/derive-preferences.ts --mode once

  # Create a recurring task (runs every hour)
  bun run scripts/derived-cli.ts create aggregate-stats scripts/aggregate-stats.ts --mode recurring --interval-ms 3600000

  # Run a task immediately
  bun run scripts/derived-cli.ts run 01ABC...

  # List all tasks
  bun run scripts/derived-cli.ts list

Environment:
  DATABASE_URL    PostgreSQL connection string
`)
}

// ============ Commands ============

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

  const task = await taskRepo.create({
    name,
    scriptPath,
    mode,
    intervalMs: options['interval-ms'],
    metadata,
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
    console.log(`  ${task.id}  ${task.name} [${status}]`)
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
    console.log('')
  }
}

async function runTask(
  taskId: string,
  options: CliOptions,
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
  console.log('')
  console.log('Note: This only creates the job. The SyncEngine queue must be running to process it.')
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
        await runTask(taskId, options, taskRepo, jobRepo)
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
