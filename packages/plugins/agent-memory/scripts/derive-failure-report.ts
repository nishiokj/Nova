#!/usr/bin/env bun
/**
 * Derived Task: Failed Jobs Report
 *
 * Analyzes all failed jobs across job_queue, sync_jobs, and derived_jobs tables.
 * Generates a comprehensive markdown report with:
 * - Error messages and stack traces
 * - Root cause analysis
 * - Job details (type, payload, resources used)
 * - Temporal patterns and trends
 * - Aggregated statistics by error type and job type
 *
 * The report focuses on actionable insights - not just cataloging failures,
 * but understanding patterns and providing specific recommendations.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  DerivedRunContext,
  DerivedRunResult,
  DerivedMetadataSchema,
} from '../src/derived/runner.js'

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export const metadata: DerivedMetadataSchema = {
  fields: {
    outputDir: { type: 'string', description: 'Output directory for failure reports' },
    daysBack: { type: 'number', default: 7, description: 'Number of days to analyze' },
    includePayloads: { type: 'boolean', default: false, description: 'Include full payloads in report' },
    minFailures: { type: 'number', default: 2, description: 'Minimum failures to show pattern' },
    telegramChatId: { type: 'number', description: 'Telegram chat ID for notifications' },
  },
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface FailedJob {
  source: 'job_queue' | 'sync_jobs' | 'derived_jobs'
  id: string
  job_type: string
  status: string
  last_error: string | null
  attempt_count: number | null
  max_attempts: number | null
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
  locked_until: Date | null
  locked_by: string | null
  priority: number | null
  payload: unknown
  // sync_jobs specific
  connector?: string | null
  account_id?: string | null
  cursor_state?: unknown
  items_fetched?: number | null
  items_processed?: number | null
  items_failed?: number | null
  retry_count?: number | null
  next_retry_at?: Date | null
  metadata?: unknown
  // derived_jobs specific
  task_id?: string | null
  output_ref?: string | null
}

interface ErrorPattern {
  errorType: string
  count: number
  firstSeen: Date
  lastSeen: Date
  affectedJobTypes: string[]
  affectedConnectors: string[]
  sampleJobs: Array<{
    id: string
    jobType: string
    error: string
    timestamp: Date
  }>
  rootCause: string
  recommendedActions: string[]
}

interface JobTypeStats {
  jobType: string
  total: number
  failed: number
  successRate: number
  avgAttempts: number
  mostCommonError: string | null
}

interface FailureReportData {
  periodStart: Date
  periodEnd: Date
  totalFailedJobs: number
  bySource: { job_queue: number; sync_jobs: number; derived_jobs: number }
  jobsByDay: { date: string; count: number }[]
  errorPatterns: ErrorPattern[]
  jobTypeStats: JobTypeStats[]
  failedJobs: FailedJob[]
  criticalIssues: string[]
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface ReportConfig {
  outputDir: string
  daysBack: number
  includePayloads: boolean
  minFailures: number
  telegramBotToken: string | null
  telegramChatId: number | null
}

function loadConfig(metadata: Record<string, unknown> | undefined): ReportConfig {
  const projectRoot = path.join(import.meta.dir, '../../../../')

  // Resolve Telegram chat ID: explicit metadata > first allowed user from env
  let telegramChatId = (metadata?.telegramChatId as number) ?? null
  if (!telegramChatId) {
    const allowed = process.env.TELEGRAM_ALLOWED_USERS
    if (allowed) {
      const first = parseInt(allowed.split(',')[0].trim(), 10)
      if (!isNaN(first)) telegramChatId = first
    }
  }

  return {
    outputDir: (metadata?.outputDir as string) ?? path.resolve(projectRoot, 'data/failure-reports'),
    daysBack: (metadata?.daysBack as number) ?? 7,
    includePayloads: (metadata?.includePayloads as boolean) ?? false,
    minFailures: (metadata?.minFailures as number) ?? 2,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
    telegramChatId,
  }
}

// ─── Data Collection ─────────────────────────────────────────────────────────

async function fetchFailedJobs(
  ctx: DerivedRunContext,
  daysBack: number,
): Promise<FailedJob[]> {
  const { sql, logger } = ctx

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
  logger.info(`Fetching failed jobs since ${since.toISOString()}`)

  const failedJobs: FailedJob[] = []

  // Fetch from job_queue
  const jobQueueFailed = await sql<Record<string, unknown>[]>`
    SELECT
      id,
      job_type,
      status,
      last_error,
      attempt_count,
      max_attempts,
      created_at,
      started_at,
      completed_at,
      locked_until,
      locked_by,
      priority,
      payload
    FROM job_queue
    WHERE status = 'failed'
      AND completed_at >= ${since}
    ORDER BY completed_at DESC
  `

  for (const row of jobQueueFailed) {
    failedJobs.push({
      source: 'job_queue',
      id: row.id as string,
      job_type: row.job_type as string,
      status: row.status as string,
      last_error: row.last_error as string | null,
      attempt_count: row.attempt_count as number | null,
      max_attempts: row.max_attempts as number | null,
      created_at: row.created_at as Date,
      started_at: row.started_at as Date | null,
      completed_at: row.completed_at as Date | null,
      locked_until: row.locked_until as Date | null,
      locked_by: row.locked_by as string | null,
      priority: row.priority as number | null,
      payload: row.payload,
    })
  }

  logger.info(`Found ${jobQueueFailed.length} failed jobs in job_queue`)

  // Fetch from sync_jobs
  const syncJobsFailed = await sql<Record<string, unknown>[]>`
    SELECT
      id,
      connector,
      account_id,
      job_type,
      status,
      last_error,
      retry_count,
      next_retry_at,
      created_at,
      started_at,
      completed_at,
      cursor_state,
      items_fetched,
      items_processed,
      items_failed,
      metadata
    FROM sync_jobs
    WHERE status = 'failed'
      AND completed_at >= ${since}
    ORDER BY completed_at DESC
  `

  for (const row of syncJobsFailed) {
    failedJobs.push({
      source: 'sync_jobs',
      id: row.id as string,
      job_type: row.job_type as string,
      status: row.status as string,
      last_error: row.last_error as string | null,
      attempt_count: row.retry_count as number | null,
      max_attempts: null,
      created_at: row.created_at as Date,
      started_at: row.started_at as Date | null,
      completed_at: row.completed_at as Date | null,
      locked_until: row.next_retry_at as Date | null,
      locked_by: null,
      priority: null,
      payload: null,
      connector: row.connector as string | null,
      account_id: row.account_id as string | null,
      cursor_state: row.cursor_state,
      items_fetched: row.items_fetched as number | null,
      items_processed: row.items_processed as number | null,
      items_failed: row.items_failed as number | null,
      retry_count: row.retry_count as number | null,
      next_retry_at: row.next_retry_at as Date | null,
      metadata: row.metadata,
    })
  }

  logger.info(`Found ${syncJobsFailed.length} failed jobs in sync_jobs`)

  // Fetch from derived_jobs
  const derivedJobsFailed = await sql<Record<string, unknown>[]>`
    SELECT
      dj.id,
      dj.task_id,
      dj.status,
      dj.last_error,
      dj.retry_count,
      dj.next_retry_at,
      dj.created_at,
      dj.started_at,
      dj.completed_at,
      dj.output_ref,
      dj.metadata,
      dt.name as task_name,
      dt.script_path
    FROM derived_jobs dj
    LEFT JOIN derived_tasks dt ON dj.task_id = dt.id
    WHERE dj.status = 'failed'
      AND dj.completed_at >= ${since}
    ORDER BY dj.completed_at DESC
  `

  for (const row of derivedJobsFailed) {
    failedJobs.push({
      source: 'derived_jobs',
      id: row.id as string,
      job_type: (row.task_name as string) ?? 'unknown',
      status: row.status as string,
      last_error: row.last_error as string | null,
      attempt_count: row.retry_count as number | null,
      max_attempts: null,
      created_at: row.created_at as Date,
      started_at: row.started_at as Date | null,
      completed_at: row.completed_at as Date | null,
      locked_until: row.next_retry_at as Date | null,
      locked_by: null,
      priority: null,
      payload: row.metadata,
      task_id: row.task_id as string | null,
      output_ref: row.output_ref as string | null,
    })
  }

  logger.info(`Found ${derivedJobsFailed.length} failed jobs in derived_jobs`)
  logger.info(`Total failed jobs: ${failedJobs.length}`)

  return failedJobs.sort((a, b) => 
    (b.completed_at?.getTime() ?? 0) - (a.completed_at?.getTime() ?? 0)
  )
}

// ─── Analysis Functions ─────────────────────────────────────────────────────

function extractErrorType(error: string | null): string {
  if (!error) return 'Unknown'

  // Common error patterns
  if (error.includes('ECONNREFUSED')) return 'Connection Refused'
  if (error.includes('ETIMEDOUT') || error.includes('timeout')) return 'Timeout'
  if (error.includes('ENOTFOUND')) return 'DNS Resolution'
  if (error.includes('ENOMEM') || error.includes('out of memory')) return 'Out of Memory'
  if (error.includes('Cannot find module')) return 'Module Not Found'
  if (error.includes('ResolveMessage')) return 'Module Resolution'
  if (error.includes('orphaned')) return 'Orphaned Job'
  if (error.includes('stuck')) return 'Stuck Job'
  if (error.includes('auth') || error.includes('unauthorized') || error.includes('401')) return 'Authentication'
  if (error.includes('permission') || error.includes('403')) return 'Permission'
  if (error.includes('rate limit') || error.includes('429')) return 'Rate Limit'
  if (error.includes('SyntaxError')) return 'Syntax Error'
  if (error.includes('TypeError')) return 'Type Error'
  if (error.includes('ReferenceError')) return 'Reference Error'

  // First line of error usually contains the type
  const lines = error.split('\n').filter((l) => l.trim())
  if (lines.length > 0) {
    const firstLine = lines[0].trim()
    if (firstLine.includes(':')) {
      return firstLine.split(':')[0].trim()
    }
    return firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '')
  }

  return error.slice(0, 60) + (error.length > 60 ? '...' : '')
}

function analyzeRootCause(error: string | null, job: FailedJob): { cause: string; recommendations: string[] } {
  if (!error) {
    return { cause: 'Unknown - no error message', recommendations: ['Check system logs'] }
  }

  const recommendations: string[] = []
  let cause = 'Unknown error'

  // Module resolution issues
  if (error.includes('Cannot find module') || error.includes('ResolveMessage')) {
    cause = 'Missing or misconfigured dependency/module'
    recommendations.push('Verify all dependencies are installed')
    recommendations.push('Check import paths in the script')
    recommendations.push('Run `bun install` to ensure dependencies are up to date')
    if (job.source === 'derived_jobs' && job.task_id) {
      recommendations.push(`Review script_path for task ${job.task_id}`)
    }
  }

  // Orphaned jobs
  else if (error.includes('orphaned')) {
    cause = 'Job orphaned - likely due to system restart or daemon crash'
    recommendations.push('Check daemon health and crash logs')
    recommendations.push('Review system restart logs')
    recommendations.push('Consider implementing job recovery mechanism')
  }

  // Stuck jobs
  else if (error.includes('stuck')) {
    cause = 'Job stuck - likely hung or deadlocked'
    recommendations.push('Review job for blocking operations')
    recommendations.push('Check for infinite loops or unawaited promises')
    recommendations.push('Consider adding timeouts to long-running operations')
  }

  // Connection issues
  else if (error.includes('ECONNREFUSED') || error.includes('ENOTFOUND')) {
    cause = 'Network connectivity or service availability issue'
    recommendations.push('Check if external service is running and accessible')
    recommendations.push('Verify network connectivity and firewall rules')
    recommendations.push('Check DNS resolution')
    if (job.connector) {
      recommendations.push(`Verify ${job.connector} connector configuration`)
    }
  }

  // Timeouts
  else if (error.includes('timeout') || error.includes('ETIMEDOUT')) {
    cause = 'Operation timed out'
    recommendations.push('Increase timeout values if operation is legitimately slow')
    recommendations.push('Optimize the operation to complete faster')
    recommendations.push('Check for network latency')
    if (job.connector) {
      recommendations.push(`Review ${job.connector} API rate limits`)
    }
  }

  // Authentication/Authorization
  else if (error.includes('auth') || error.includes('401') || error.includes('permission') || error.includes('403')) {
    cause = 'Authentication or authorization failure'
    recommendations.push('Verify credentials are correct and current')
    recommendations.push('Check if access tokens have expired')
    recommendations.push('Review permissions for the requested resource')
  }

  // Rate limiting
  else if (error.includes('rate limit') || error.includes('429')) {
    cause = 'API rate limit exceeded'
    recommendations.push('Implement backoff/retry strategy with exponential backoff')
    recommendations.push('Reduce request frequency')
    recommendations.push('Consider caching responses')
  }

  // Memory issues
  else if (error.includes('ENOMEM') || error.includes('out of memory')) {
    cause = 'Memory exhaustion'
    recommendations.push('Profile memory usage in the job')
    recommendations.push('Consider processing data in batches')
    recommendations.push('Investigate memory leaks')
  }

  // Default: generic error analysis
  else {
    cause = 'Runtime error'
    recommendations.push('Review error stack trace for specific issue')
    recommendations.push('Check system logs for additional context')
    if (job.source === 'derived_jobs') {
      recommendations.push('Verify script syntax and logic')
    }
  }

  return { cause, recommendations }
}

function identifyErrorPatterns(jobs: FailedJob[], minFailures: number): ErrorPattern[] {
  const patterns = new Map<string, ErrorPattern>()

  for (const job of jobs) {
    const errorType = extractErrorType(job.last_error)
    const errorDate = job.completed_at ?? job.created_at
    const analysis = analyzeRootCause(job.last_error, job)

    if (!patterns.has(errorType)) {
      patterns.set(errorType, {
        errorType,
        count: 0,
        firstSeen: errorDate,
        lastSeen: errorDate,
        affectedJobTypes: new Set(),
        affectedConnectors: new Set(),
        sampleJobs: [],
        rootCause: analysis.cause,
        recommendedActions: analysis.recommendations,
      })
    }

    const pattern = patterns.get(errorType)!
    pattern.count++
    pattern.firstSeen = new Date(Math.min(pattern.firstSeen.getTime(), errorDate.getTime()))
    pattern.lastSeen = new Date(Math.max(pattern.lastSeen.getTime(), errorDate.getTime()))
    pattern.affectedJobTypes.add(job.job_type)
    if (job.connector) pattern.affectedConnectors.add(job.connector)

    // Keep up to 3 sample jobs per pattern
    if (pattern.sampleJobs.length < 3) {
      pattern.sampleJobs.push({
        id: job.id,
        jobType: job.job_type,
        error: job.last_error?.slice(0, 200) ?? 'No error message',
        timestamp: errorDate,
      })
    }
  }

  // Convert Sets to arrays and filter by minFailures
  return Array.from(patterns.values())
    .filter((p) => p.count >= minFailures)
    .sort((a, b) => b.count - a.count)
    .map((p) => ({
      ...p,
      affectedJobTypes: Array.from(p.affectedJobTypes),
      affectedConnectors: Array.from(p.affectedConnectors),
    }))
}

function calculateJobTypeStats(jobs: FailedJob[]): JobTypeStats[] {
  const jobTypeMap = new Map<string, { total: number; failed: number; attempts: number[] }>()

  // First, get total jobs (not just failed) for success rate calculation
  // This would require additional queries, so for now we'll focus on failed jobs

  for (const job of jobs) {
    if (!jobTypeMap.has(job.job_type)) {
      jobTypeMap.set(job.job_type, { total: 0, failed: 0, attempts: [] })
    }
    const stats = jobTypeMap.get(job.job_type)!
    stats.total++
    stats.failed++
    if (job.attempt_count) {
      stats.attempts.push(job.attempt_count)
    }
  }

  return Array.from(jobTypeMap.entries())
    .map(([jobType, stats]) => ({
      jobType,
      total: stats.total,
      failed: stats.failed,
      successRate: 0, // Would need total jobs count including successes
      avgAttempts:
        stats.attempts.length > 0
          ? stats.attempts.reduce((a, b) => a + b, 0) / stats.attempts.length
          : 0,
      mostCommonError: null, // Would need error aggregation per job type
    }))
    .sort((a, b) => b.failed - a.failed)
}

function groupJobsByDay(jobs: FailedJob[]): { date: string; count: number }[] {
  const byDay = new Map<string, number>()

  for (const job of jobs) {
    const date = (job.completed_at ?? job.created_at).toISOString().split('T')[0]
    byDay.set(date, (byDay.get(date) ?? 0) + 1)
  }

  return Array.from(byDay.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function identifyCriticalIssues(jobs: FailedJob[], patterns: ErrorPattern[]): string[] {
  const issues: string[] = []

  // High failure rate for critical job types
  const criticalJobTypes = ['sync', 'derived', 'job_queue']
  for (const jobType of criticalJobTypes) {
    const failures = jobs.filter((j) => j.job_type.toLowerCase().includes(jobType))
    if (failures.length > 10) {
      issues.push(`High failure rate for ${jobType} jobs: ${failures.length} failures in analyzed period`)
    }
  }

  // Recurring patterns with high frequency
  for (const pattern of patterns) {
    if (pattern.count >= 5) {
      issues.push(`Recurring error pattern: "${pattern.errorType}" occurred ${pattern.count} times`)
    }
  }

  // Jobs with excessive retry attempts
  const highRetryJobs = jobs.filter((j) => j.attempt_count && j.attempt_count >= 3)
  if (highRetryJobs.length > 5) {
    issues.push(`${highRetryJobs.length} jobs failed after 3 or more retry attempts`)
  }

  // Recent spike in failures
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recentFailures = jobs.filter(
    (j) => (j.completed_at ?? j.created_at) >= last24h
  )
  if (recentFailures.length > 20) {
    issues.push(`Recent spike in failures: ${recentFailures.length} jobs failed in the last 24 hours`)
  }

  // Service-specific issues
  const connectors = new Set<string>()
  jobs.forEach((j) => {
    if (j.connector) connectors.add(j.connector)
  })
  for (const connector of connectors) {
    const failures = jobs.filter((j) => j.connector === connector)
    if (failures.length >= 3) {
      issues.push(`Connector "${connector}" has ${failures.length} failures - may need attention`)
    }
  }

  return issues
}

// ─── Report Generation ───────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`
  return `${(ms / 3600000).toFixed(1)}h`
}

function generateMarkdownReport(
  data: FailureReportData,
  config: ReportConfig,
): string {
  const lines: string[] = []

  // Header
  lines.push('# Failed Jobs Report')
  lines.push('')
  lines.push(`**Period:** ${data.periodStart.toISOString().slice(0, 10)} to ${data.periodEnd.toISOString().slice(0, 10)}`)
  lines.push(`**Generated:** ${new Date().toISOString()}`)
  lines.push(`**Total Failed Jobs:** ${data.totalFailedJobs}`)
  lines.push('')

  // Executive Summary
  lines.push('## Executive Summary')
  lines.push('')

  if (data.criticalIssues.length === 0) {
    lines.push('✅ No critical issues detected in the analyzed period.')
  } else {
    lines.push('### ⚠️ Critical Issues')
    lines.push('')
    for (const issue of data.criticalIssues) {
      lines.push(`- ${issue}`)
    }
  }
  lines.push('')

  // High-level stats
  lines.push('### Overview Statistics')
  lines.push('')
  lines.push(`| Metric | Value |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Total Failed Jobs | ${data.totalFailedJobs} |`)
  lines.push(`| job_queue failures | ${data.bySource.job_queue} |`)
  lines.push(`| sync_jobs failures | ${data.bySource.sync_jobs} |`)
  lines.push(`| derived_jobs failures | ${data.bySource.derived_jobs} |`)
  lines.push(`| Distinct Error Patterns | ${data.errorPatterns.length} |`)
  lines.push(`| Affected Job Types | ${data.jobTypeStats.length} |`)
  lines.push('')

  // Timeline
  lines.push('## Failure Timeline')
  lines.push('')
  lines.push('### Failures by Day')
  lines.push('')
  lines.push('| Date | Failures |')
  lines.push('|------|----------|')
  for (const day of data.jobsByDay) {
    lines.push(`| ${day.date} | ${day.count} |`)
  }
  lines.push('')

  // Error Patterns
  lines.push('## Error Pattern Analysis')
  lines.push('')
  if (data.errorPatterns.length === 0) {
    lines.push('No recurring error patterns found (all errors are unique or below threshold).')
  } else {
    for (const pattern of data.errorPatterns) {
      lines.push(`### ${pattern.errorType}`)
      lines.push('')
      lines.push(`**Occurrences:** ${pattern.count}`)
      lines.push(`**First Seen:** ${pattern.firstSeen.toISOString()}`)
      lines.push(`**Last Seen:** ${pattern.lastSeen.toISOString()}`)
      lines.push(`**Root Cause:** ${pattern.rootCause}`)
      lines.push('')

      if (pattern.affectedJobTypes.length > 0) {
        lines.push(`**Affected Job Types:**`)
        for (const jt of pattern.affectedJobTypes) {
          lines.push(`- \`${jt}\``)
        }
        lines.push('')
      }

      if (pattern.affectedConnectors.length > 0) {
        lines.push(`**Affected Connectors:**`)
        for (const conn of pattern.affectedConnectors) {
          lines.push(`- \`${conn}\``)
        }
        lines.push('')
      }

      lines.push('**Recommended Actions:**')
      for (const action of pattern.recommendedActions) {
        lines.push(`1. ${action}`)
      }
      lines.push('')

      lines.push('**Sample Failures:**')
      for (const sample of pattern.sampleJobs) {
        lines.push(`- **${sample.jobType}** (${sample.id.slice(0, 8)}...) at ${sample.timestamp.toISOString()}`)
        lines.push(`  \`\`\``)
        lines.push(`  ${sample.error}`)
        lines.push(`  \`\`\``)
      }
      lines.push('')
      lines.push('---')
      lines.push('')
    }
  }

  // Job Type Statistics
  lines.push('## Job Type Statistics')
  lines.push('')
  lines.push('| Job Type | Failed | Avg Attempts |')
  lines.push('|----------|--------|--------------|')
  for (const stat of data.jobTypeStats) {
    lines.push(`| \`${stat.jobType}\` | ${stat.failed} | ${stat.avgAttempts.toFixed(1)} |`)
  }
  lines.push('')

  // Detailed Failure List
  lines.push('## Detailed Failure List')
  lines.push('')
  lines.push('*Only showing jobs from the analyzed period.*')
  lines.push('')

  for (const job of data.failedJobs) {
    const error = job.last_error ?? 'No error message'
    const timestamp = (job.completed_at ?? job.created_at).toISOString()
    const duration =
      job.started_at && job.completed_at
        ? formatDuration(job.completed_at.getTime() - job.started_at.getTime())
        : 'N/A'

    lines.push(`### ${job.source}: ${job.job_type}`)
    lines.push('')
    lines.push(`- **Job ID:** \`${job.id}\``)
    if (job.task_id) lines.push(`- **Task ID:** \`${job.task_id}\``)
    if (job.connector) lines.push(`- **Connector:** \`${job.connector}\``)
    if (job.account_id) lines.push(`- **Account ID:** \`${job.account_id}\``)
    lines.push(`- **Status:** \`${job.status}\``)
    lines.push(`- **Created:** ${job.created_at.toISOString()}`)
    if (job.started_at) lines.push(`- **Started:** ${job.started_at.toISOString()}`)
    if (job.completed_at) lines.push(`- **Completed:** ${job.completed_at.toISOString()}`)
    if (job.started_at && job.completed_at) lines.push(`- **Duration:** ${duration}`)
    lines.push(`- **Attempts:** ${job.attempt_count ?? 'N/A'}${job.max_attempts ? `/${job.max_attempts}` : ''}`)
    if (job.priority !== null) lines.push(`- **Priority:** ${job.priority}`)
    if (job.retry_count !== null) lines.push(`- **Retry Count:** ${job.retry_count}`)

    // Progress metrics for sync_jobs
    if (job.items_fetched !== null) lines.push(`- **Items Fetched:** ${job.items_fetched}`)
    if (job.items_processed !== null) lines.push(`- **Items Processed:** ${job.items_processed}`)
    if (job.items_failed !== null) lines.push(`- **Items Failed:** ${job.items_failed}`)

    lines.push('')
    lines.push('**Error:**')
    lines.push('')
    lines.push('```')
    lines.push(error)
    lines.push('```')
    lines.push('')

    // Root Cause Analysis
    const analysis = analyzeRootCause(job.last_error, job)
    lines.push('**Root Cause:**')
    lines.push('')
    lines.push(analysis.cause)
    lines.push('')
    lines.push('**Recommended Actions:**')
    lines.push('')
    for (const action of analysis.recommendations) {
      lines.push(`- ${action}`)
    }
    lines.push('')

    // Optional payload display
    if (config.includePayloads && job.payload) {
      lines.push('**Payload:**')
      lines.push('')
      lines.push('```json')
      lines.push(JSON.stringify(job.payload, null, 2).slice(0, 2000))
      if (JSON.stringify(job.payload).length > 2000) {
        lines.push('... (truncated)')
      }
      lines.push('```')
      lines.push('')
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

// ─── Telegram Notification ─────────────────────────────────────────────────────

async function sendTelegramNotification(
  config: ReportConfig,
  data: FailureReportData,
  reportPath: string,
): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return
  }

  const TELEGRAM_API = 'https://api.telegram.org'
  const TELEGRAM_MAX_LENGTH = 4096

  // Build a summary message
  let message = `🔴 *Failed Jobs Report*\n\n`
  message += `Period: ${data.periodStart.toISOString().slice(0, 10)} - ${data.periodEnd.toISOString().slice(0, 10)}\n`
  message += `Total Failures: ${data.totalFailedJobs}\n\n`

  if (data.criticalIssues.length > 0) {
    message += `*Critical Issues (${data.criticalIssues.length})*\n`
    data.criticalIssues.slice(0, 5).forEach((issue) => {
      message += `• ${issue}\n`
    })
    if (data.criticalIssues.length > 5) {
      message += `... and ${data.criticalIssues.length - 5} more\n`
    }
    message += '\n'
  }

  if (data.errorPatterns.length > 0) {
    message += `*Top Error Patterns*\n`
    data.errorPatterns.slice(0, 3).forEach((pattern) => {
      message += `• ${pattern.errorType}: ${pattern.count} occurrences\n`
    })
    message += '\n'
  }

  message += `Full report: ${reportPath}`

  // Send message (with splitting if too long)
  const chunks: string[] = []
  if (message.length <= TELEGRAM_MAX_LENGTH) {
    chunks.push(message)
  } else {
    // Split at reasonable boundaries
    const lines = message.split('\n')
    let current = ''
    for (const line of lines) {
      if (current.length + line.length + 1 > TELEGRAM_MAX_LENGTH && current) {
        chunks.push(current)
        current = ''
      }
      current += (current ? '\n' : '') + line
    }
    if (current) chunks.push(current)
  }

  for (const chunk of chunks) {
    const res = await fetch(`${TELEGRAM_API}/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: chunk,
        parse_mode: 'Markdown',
      }),
    })
    if (!res.ok) {
      throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`)
    }
  }
}

// ─── Main Runner ─────────────────────────────────────────────────────────────

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { logger } = ctx
  const config = loadConfig(ctx.task.metadata as Record<string, unknown> | undefined)

  logger.info(`Starting failure report analysis (last ${config.daysBack} days)`)

  // Ensure output directory exists
  mkdirSync(config.outputDir, { recursive: true })

  // Fetch failed jobs
  const failedJobs = await fetchFailedJobs(ctx, config.daysBack)

  if (failedJobs.length === 0) {
    logger.info('No failed jobs found in the analyzed period')
    return {
      metadata: {
        totalFailedJobs: 0,
        periodStart: new Date(Date.now() - config.daysBack * 24 * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date().toISOString(),
      },
    }
  }

  // Analyze failures
  logger.info('Analyzing failure patterns...')
  const errorPatterns = identifyErrorPatterns(failedJobs, config.minFailures)
  const jobTypeStats = calculateJobTypeStats(failedJobs)
  const jobsByDay = groupJobsByDay(failedJobs)
  const criticalIssues = identifyCriticalIssues(failedJobs, errorPatterns)

  // Prepare report data
  const now = new Date()
  const periodStart = new Date(now.getTime() - config.daysBack * 24 * 60 * 60 * 1000)
  const reportData: FailureReportData = {
    periodStart,
    periodEnd: now,
    totalFailedJobs: failedJobs.length,
    bySource: {
      job_queue: failedJobs.filter((j) => j.source === 'job_queue').length,
      sync_jobs: failedJobs.filter((j) => j.source === 'sync_jobs').length,
      derived_jobs: failedJobs.filter((j) => j.source === 'derived_jobs').length,
    },
    jobsByDay,
    errorPatterns,
    jobTypeStats,
    failedJobs,
    criticalIssues,
  }

  // Generate markdown report
  logger.info('Generating markdown report...')
  const markdown = generateMarkdownReport(reportData, config)

  // Write report to file
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const reportPath = path.join(config.outputDir, `failure-report-${timestamp}.md`)
  writeFileSync(reportPath, markdown, 'utf-8')
  logger.info(`Report written to ${reportPath}`)

  // Also write to latest.md for easy access
  const latestPath = path.join(config.outputDir, 'latest-failure-report.md')
  writeFileSync(latestPath, markdown, 'utf-8')

  // Send Telegram notification
  if (config.telegramBotToken && config.telegramChatId) {
    try {
      await sendTelegramNotification(config, reportData, reportPath)
      logger.info('Telegram notification sent')
    } catch (err) {
      logger.warn(`Telegram notification failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    metadata: {
      totalFailedJobs: failedJobs.length,
      periodStart: periodStart.toISOString(),
      periodEnd: now.toISOString(),
      reportPath,
      errorPatternsFound: errorPatterns.length,
      criticalIssues: criticalIssues.length,
      bySource: reportData.bySource,
    },
  }
}
