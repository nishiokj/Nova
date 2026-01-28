#!/usr/bin/env bun
/**
 * Run the preferences derived task
 */

import { SyncClient } from '../packages/agent-memory/src/client/index.js'

const SYNC_DAEMON_URL = process.env.SYNC_DAEMON_URL || 'http://localhost:3001'
const client = new SyncClient(SYNC_DAEMON_URL)

async function main() {
  console.log('Creating derived task for preferences...')

  // Create the derived task
  const created = await client.derivedTasks.create({
    name: 'preferences',
    scriptPath: 'packages/agent-memory/scripts/derive_preferences.ts',
    mode: 'once',
  })
  const task = created.task

  console.log(`✓ Created derived task: ${task.id.slice(0, 8)}`)
  console.log(`  Name: ${task.name}`)
  console.log(`  Script: ${task.script_path}`)

  if (created.sandbox) {
    console.log('\nSandbox validation:')
    console.log(`  Status: ${created.sandbox.status}`)
    if (created.sandbox.lastError) {
      console.log(`  Error: ${created.sandbox.lastError}`)
    }
    if (created.sandbox.logPath) {
      console.log(`  Log: ${created.sandbox.logPath}`)
    }
  } else if (created.sandboxError) {
    console.log('\nSandbox validation failed to start:')
    console.log(`  Error: ${created.sandboxError}`)
  }

  console.log('\nRunning derived task...')

  // Run the derived task
  const job = await client.derivedTasks.run(task.id)

  console.log(`✓ Triggered derived job: ${job.id.slice(0, 8)}`)
  console.log(`  Status: ${job.status}`)

  // Wait a moment and check status
  await new Promise(resolve => setTimeout(resolve, 2000))

  const jobDetails = await client.derivedJobs.get(job.id)
  console.log(`\nJob status: ${jobDetails.job.status}`)
  if (jobDetails.job.last_error) {
    console.log(`Error: ${jobDetails.job.last_error}`)
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
