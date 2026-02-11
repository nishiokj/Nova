#!/usr/bin/env bun
/**
 * System Health Check Script
 *
 * Provides a quick overview of system health, identifying:
 * - Failed sync/derived jobs
 * - Disabled tasks that should be running
 * - Data quality issues
 * - Performance bottlenecks
 */

import { Client } from 'pg'

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'agent_memory',
  user: 'postgres',
  password: 'postgres',
})

interface HealthIssue {
  severity: 'critical' | 'warning' | 'info'
  category: string
  message: string
  action?: string
}

const issues: HealthIssue[] = []

async function checkSyncTasks() {
  const result = await client.query(`
    SELECT
      connector,
      mode,
      enabled,
      (SELECT COUNT(*) FROM sync_jobs sj WHERE sj.connector = st.connector AND sj.account_id = st.account_id AND sj.status = 'failed' AND sj.created_at > NOW() - INTERVAL '24 hours') as failed_24h,
      (SELECT COUNT(*) FROM sync_jobs sj WHERE sj.connector = st.connector AND sj.account_id = st.account_id AND sj.status = 'failed' AND sj.created_at > NOW() - INTERVAL '7 days') as failed_7d,
      (SELECT COUNT(*) FROM sync_jobs sj WHERE sj.connector = st.connector AND sj.account_id = st.account_id AND sj.status = 'completed' AND sj.created_at > NOW() - INTERVAL '24 hours') as completed_24h
    FROM sync_tasks st
    WHERE enabled = true
    ORDER BY connector
  `)

  console.log('\n📊 Active Sync Tasks:')
  console.log('─'.repeat(80))

  for (const row of result.rows) {
    const connector = row.connector
    const mode = row.mode
    const failed24h = parseInt(row.failed_24h)
    const failed7d = parseInt(row.failed_7d)
    const completed24h = parseInt(row.completed_24h)

    const status = failed24h > 0 ? '❌' : '✅'
    console.log(`${status} ${connector.padEnd(20)} ${mode.padEnd(15)} ${completed24h} ok / ${failed24h} failed (24h)`)

    if (failed24h > 5) {
      issues.push({
        severity: 'critical',
        category: 'Sync Tasks',
        message: `${connector} has ${failed24h} failed jobs in last 24h`,
        action: 'Check logs for pattern'
      })
    } else if (failed7d > 0 && completed24h === 0) {
      issues.push({
        severity: 'warning',
        category: 'Sync Tasks',
        message: `${connector} hasn't completed successfully in 24h`,
        action: 'Check if task is stuck'
      })
    }
  }
}

async function checkDisabledTasks() {
  const result = await client.query(`
    SELECT connector, mode, (SELECT COUNT(*) FROM sync_jobs WHERE task_id = sync_tasks.id LIMIT 1) as has_history
    FROM sync_tasks
    WHERE enabled = false
    AND connector IN ('github', 'gmail', 'imessage', 'claude_sessions')
    ORDER BY connector
  `)

  console.log('\n⚠️  Disabled Important Tasks:')
  console.log('─'.repeat(80))

  for (const row of result.rows) {
    const connector = row.connector
    const mode = row.mode
    const hasHistory = parseInt(row.has_history)

    console.log(`🔸 ${connector.padEnd(20)} ${mode.padEnd(15)} ${hasHistory > 0 ? '(was active)' : '(never run)'}`)

    if (connector === 'github' || connector === 'gmail') {
      issues.push({
        severity: 'warning',
        category: 'Sync Tasks',
        message: `${connector} sync is disabled - you may be missing important updates`,
        action: `Consider enabling: sync-api-cli.ts tasks enable <task-id>`
      })
    }
  }
}

async function checkDerivedTasks() {
  const result = await client.query(`
    SELECT
      name,
      enabled,
      (SELECT COUNT(*) FROM derived_jobs dj WHERE dj.task_id = dt.id AND dj.status = 'failed' AND dj.created_at > NOW() - INTERVAL '24 hours') as failed_24h,
      (SELECT COUNT(*) FROM derived_jobs dj WHERE dj.task_id = dt.id AND dj.status = 'completed' AND dj.created_at > NOW() - INTERVAL '24 hours') as completed_24h,
      next_run_at
    FROM derived_tasks dt
    ORDER BY name
  `)

  console.log('\n🔧 Derived Tasks:')
  console.log('─'.repeat(80))

  for (const row of result.rows) {
    const name = row.name
    const enabled = row.enabled
    const failed24h = parseInt(row.failed_24h)
    const completed24h = parseInt(row.completed_24h)
    const nextRun = row.next_run_at

    const status = enabled ? (failed24h > 0 ? '❌' : '✅') : '⏸️'
    const enabledStr = enabled ? 'enabled' : 'disabled'

    console.log(`${status} ${name.padEnd(30)} ${enabledStr.padEnd(10)} ${completed24h} ok / ${failed24h} failed (24h)`)

    if (enabled && failed24h > 2) {
      issues.push({
        severity: 'critical',
        category: 'Derived Tasks',
        message: `${name} has ${failed24h} failed jobs in last 24h`,
        action: 'Check error logs for recurring issues'
      })
    }

    if (name === 'daily-digest' && enabled && failed24h > 0) {
      issues.push({
        severity: 'critical',
        category: 'Derived Tasks',
        message: 'Daily digest is failing - you\'re losing signal from your conversations',
        action: 'Check logs/derived for timeout errors'
      })
    }
  }
}

async function checkDataQuality() {
  // Check for orphaned messages (no conversation)
  const orphanedResult = await client.query(`
    SELECT COUNT(*) as count
    FROM canonical_message cm
    LEFT JOIN entity_source_mappings esm ON esm.raw_envelope_id = cm.id
    WHERE esm.canonical_entity_id IS NULL
    AND cm.deleted_at IS NULL
  `)

  const orphanedCount = parseInt(orphanedResult.rows[0].count)
  if (orphanedCount > 100) {
    issues.push({
      severity: 'warning',
      category: 'Data Quality',
      message: `${orphanedCount} orphaned messages detected`,
      action: 'May indicate sync issues with message linking'
    })
  }

  // Check for conversations with no messages
  const emptyConvoResult = await client.query(`
    SELECT COUNT(*) as count
    FROM canonical_conversation c
    WHERE NOT EXISTS (
      SELECT 1 FROM entity_source_mappings esm
      JOIN canonical_message cm ON cm.id = esm.canonical_entity_id
      WHERE esm.canonical_entity_type = 'message'
      AND esm.raw_envelope_id IN (
        SELECT re.id FROM raw_envelopes re
        JOIN entity_source_mappings esm2 ON esm2.raw_envelope_id = re.id
        WHERE esm2.canonical_entity_id = c.id AND esm2.canonical_entity_type = 'conversation'
      )
    )
    AND c.deleted_at IS NULL
  `)

  const emptyConvoCount = parseInt(emptyConvoResult.rows[0].count)
  if (emptyConvoCount > 10) {
    issues.push({
      severity: 'info',
      category: 'Data Quality',
      message: `${emptyConvoCount} conversations have no linked messages`,
      action: 'May be waiting for backfill to complete'
    })
  }
}

async function checkRecentActivity() {
  const result = await client.query(`
    SELECT
      source,
      COUNT(*) as count,
      MIN(timestamp) as earliest,
      MAX(timestamp) as latest
    FROM canonical_message
    WHERE timestamp > NOW() - INTERVAL '7 days'
    GROUP BY source
    ORDER BY count DESC
  `)

  console.log('\n📈 Activity (Last 7 Days):')
  console.log('─'.repeat(80))

  if (result.rows.length === 0) {
    console.log('No recent activity detected')
    issues.push({
      severity: 'warning',
      category: 'Activity',
      message: 'No messages ingested in last 7 days',
      action: 'Check if sync tasks are running'
    })
  } else {
    for (const row of result.rows) {
      console.log(`${row.source.padEnd(20)} ${row.count.toString().padStart(6)} messages (from ${new Date(row.earliest).toLocaleDateString()})`)
    }
  }
}

async function main() {
  try {
    await client.connect()

    console.log('\n' + '='.repeat(80))
    console.log('🏥 System Health Check')
    console.log('='.repeat(80))

    await checkSyncTasks()
    await checkDisabledTasks()
    await checkDerivedTasks()
    await checkDataQuality()
    await checkRecentActivity()

    console.log('\n' + '='.repeat(80))
    console.log('📋 Issues Summary')
    console.log('='.repeat(80))

    if (issues.length === 0) {
      console.log('\n✅ No issues detected! System is healthy.\n')
    } else {
      const critical = issues.filter(i => i.severity === 'critical').length
      const warning = issues.filter(i => i.severity === 'warning').length
      const info = issues.filter(i => i.severity === 'info').length

      console.log(`\n${critical} critical, ${warning} warnings, ${info} info\n`)

      for (const issue of issues) {
        const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'warning' ? '🟡' : '🔵'
        console.log(`${icon} [${issue.severity.toUpperCase()}] ${issue.category}: ${issue.message}`)
        if (issue.action) {
          console.log(`   → ${issue.action}`)
        }
      }
      console.log('')
    }

    await client.end()
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main()
