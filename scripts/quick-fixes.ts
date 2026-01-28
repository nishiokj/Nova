#!/usr/bin/env bun
/**
 * Quick Fixes Script
 *
 * Applies immediate fixes to common issues found during health checks.
 */

import { Client } from 'pg'

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'agent_memory',
  user: 'postgres',
  password: 'postgres',
})

async function enableImportantSyncTasks() {
  console.log('\n🔧 Enabling important sync tasks...')

  // Enable GitHub PR sync (every 5m)
  await client.query(`
    UPDATE sync_tasks
    SET enabled = true,
        next_run_at = NOW()
    WHERE connector = 'github'
      AND types @> ARRAY['pull_request']::text[]
      AND interval_ms = 300000
  `)
  console.log('✅ GitHub PR sync (5m) enabled')

  // Enable Gmail incremental sync (every 1h)
  await client.query(`
    UPDATE sync_tasks
    SET enabled = true,
        next_run_at = NOW()
    WHERE connector = 'gmail'
      AND mode = 'incremental'
      AND interval_ms = 3600000
  `)
  console.log('✅ Gmail incremental sync (1h) enabled')
}

async function cleanupOldTestTasks() {
  console.log('\n🧹 Cleaning up old test tasks...')

  // Delete old test x-bookmark tasks
  const result = await client.query(`
    DELETE FROM derived_tasks
    WHERE name = 'test'
      AND script_path = 'packages/agent-memory/scripts/derive-x-bookmarks.ts'
    RETURNING id
  `)

  console.log(`✅ Deleted ${result.rowCount} old test tasks`)
}

async function updateDailyDigestConfig() {
  console.log('\n⚙️  Optimizing daily digest configuration...')

  // Increase timeout for large conversations
  await client.query(`
    UPDATE derived_tasks
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{responseTimeoutMs}',
      '600000'::jsonb
    ),
    interval_ms = 43200000 -- Run twice daily instead of once
    WHERE name = 'daily-digest'
  `)

  console.log('✅ Daily digest timeout increased to 10min, frequency to 12h')
}

async function main() {
  try {
    await client.connect()

    console.log('='.repeat(80))
    console.log('🚀 Applying Quick Fixes')
    console.log('='.repeat(80))

    await enableImportantSyncTasks()
    await cleanupOldTestTasks()
    await updateDailyDigestConfig()

    console.log('\n' + '='.repeat(80))
    console.log('✅ All fixes applied successfully!')
    console.log('='.repeat(80))

    await client.end()
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main()
