#!/usr/bin/env bun
/**
 * Test Derived Task Integration
 *
 * Simple test to verify the refactored derived task system works.
 * Creates a test derived task and runs it via the shared queue.
 */

import { parseArgs } from 'node:util'
import { join } from 'node:path'
import postgres from 'postgres'
import {
  createDerivedTaskRepository,
  createDerivedJobRepository,
} from '../src/db/repositories/derived-task.js'
import { SyncEngine } from '../src/sync/engine.js'
import { DerivedTaskIntegration } from '../src/derived/integration.js'

async function loadEnvFile(path: string): Promise<void> {
  try {
    const { readFile } = await import('node:fs/promises')
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

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    console.log('Test derived task integration')
    console.log('Usage: bun run scripts/test-derived-integration.ts')
    process.exit(0)
  }

  console.log('Testing derived task integration...\n')

  // Load environment
  await loadEnvFile(join(import.meta.dir, '../../../.env'))

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL not set')
    process.exit(1)
  }

  const sql = postgres(databaseUrl, { max: 5 })

  try {
    // Create repositories
    const taskRepo = createDerivedTaskRepository({ sql })
    const jobRepo = createDerivedJobRepository({ sql })

    // Create engine
    const engine = new SyncEngine(sql)

    // Create integration and register handlers
    const integration = new DerivedTaskIntegration(sql)
    integration.registerHandlers(engine)

    // Create a test task
    console.log('Creating test derived task...')
    const task = await taskRepo.create({
      name: 'test-integration',
      scriptPath: 'scripts/derive-example.ts',
      mode: 'once',
      metadata: { test: true },
    })
    console.log(`  ✓ Task created: ${task.id}\n`)

    // Schedule the task
    console.log('Scheduling derived job...')
    const job = await integration.scheduleTask(engine, task, { priority: 10 })
    console.log(`  ✓ Job created: ${job.id}\n`)

    // Mark task as executed
    await taskRepo.markExecuted(task.id, job.id)
    await taskRepo.update(task.id, { enabled: false })

    // Start engine to process the job
    console.log('Starting engine...')
    await engine.start()

    // Wait for job to complete
    console.log('Waiting for job completion...\n')
    const timeoutMs = 30000
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      const updatedJob = await jobRepo.findById(job.id)
      if (!updatedJob) {
        console.error('Error: Job disappeared')
        break
      }

      console.log(`  Status: ${updatedJob.status}`)

      if (updatedJob.status === 'completed') {
        console.log('\n✓ Job completed successfully!')
        if (updatedJob.metadata) {
          console.log('  Metadata:', JSON.stringify(updatedJob.metadata, null, 2))
        }
        break
      }

      if (updatedJob.status === 'failed') {
        console.error(`\n✗ Job failed: ${updatedJob.last_error}`)
        break
      }

      await new Promise(resolve => setTimeout(resolve, 500))
    }

    // Stop engine
    console.log('\nStopping engine...')
    await engine.stop()

    // Cleanup
    console.log('Cleaning up test data...')
    await jobRepo.delete(job.id)
    await taskRepo.delete(task.id)
    console.log('  ✓ Cleanup complete\n')

    console.log('Test passed!')

  } catch (error) {
    console.error('Test failed:', error)
    process.exit(1)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main()
