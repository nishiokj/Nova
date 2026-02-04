#!/usr/bin/env bun
/**
 * Derive Watcher Actions
 *
 * Reads watcher session data directly from .watcher/ directories
 * and writes to agent_actions table.
 *
 * This bypasses the sync infrastructure since watcher data doesn't
 * need canonical entity processing - it goes straight to agent_actions.
 *
 * Usage:
 *   Register as a derived task:
 *   bun run scripts/sync-api-cli.ts derived-tasks create
 *   → Select derive-watcher-actions.ts
 *   → Mode: recurring
 *   → Interval: 15m
 */

import { readdir, stat, readFile } from 'fs/promises'
import { join, basename, resolve, dirname, isAbsolute } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'

// Project root: 3 levels up from this script (scripts/ -> agent-memory/ -> packages/ -> root)
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
import type {
  DerivedRunContext,
  DerivedRunResult,
  DerivedMetadataSchema,
} from '../src/derived/runner.js'
import { generateCanonicalId } from '../src/ids.js'

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export const metadata: DerivedMetadataSchema = {
  fields: {
    watcherPath: { type: 'string', default: '.watcher', description: 'Path to .watcher directory' },
    limit: { type: 'number', default: 500, description: 'Max entries to process per run' },
    processWorkLogs: { type: 'boolean', default: true, description: 'Include work log entries' },
  },
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SessionDir {
  id: string
  date: string
  path: string
  modifiedAt: Date
}

interface DecisionEntry {
  timestamp: string
  trigger: string
  watcherAction: string
  question?: string
  answer?: string
  rationale: string
  workItemId?: string
  executionMetrics?: {
    toolCallsMade: number
    filesModified: string[]
    durationMs: number
    contextPercentUsed: number
  }
}

interface WorkLogEntry {
  timestamp: string
  type: string
  workId?: string
  agentType?: string
  paths?: string[]
  watcherNote?: string
}

// ─── Main Run Function ─────────────────────────────────────────────────────────

export async function run(ctx: DerivedRunContext): Promise<DerivedRunResult> {
  const { sql, task, job, logger } = ctx

  logger.info(`Starting watcher actions derivation (job: ${job.id})`)
  logger.debug(`Project root: ${PROJECT_ROOT}`)

  const config = task.metadata as Record<string, unknown> | undefined
  const rawWatcherPath = (config?.watcherPath as string) ?? '.watcher'
  // Resolve relative paths against project root, not cwd
  const watcherPath = isAbsolute(rawWatcherPath) ? rawWatcherPath : resolve(PROJECT_ROOT, rawWatcherPath)
  logger.debug(`Resolved watcher path: ${watcherPath} (from: ${rawWatcherPath})`)
  const limit = (config?.limit as number) ?? 500
  const processWorkLogs = (config?.processWorkLogs as boolean) ?? true

  // Track metrics
  let decisionsProcessed = 0
  let workLogsProcessed = 0
  let actionsCreated = 0
  let actionsUpdated = 0
  let errors = 0

  // Get last processed timestamp from job metadata
  const lastRun = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM derived_jobs
    WHERE task_id = ${task.id}
      AND status = 'completed'
      AND id != ${job.id}
    ORDER BY completed_at DESC
    LIMIT 1
  `
  const lastProcessedTime = lastRun[0]?.metadata?.lastProcessedTime as string | undefined
  const sinceDate = lastProcessedTime ? new Date(lastProcessedTime) : new Date(0)

  logger.info(`Processing sessions modified since: ${sinceDate.toISOString()}`)

  // List all sessions
  const sessions = await listSessions(watcherPath, sinceDate)
  logger.info(`Found ${sessions.length} sessions to process`)

  let totalProcessed = 0
  let latestTimestamp = sinceDate.toISOString()

  for (const session of sessions) {
    if (totalProcessed >= limit) break

    // Process decisions.jsonl
    const decisionsPath = join(session.path, 'decisions.jsonl')
    if (existsSync(decisionsPath)) {
      const entries = await readJsonlFile<DecisionEntry>(decisionsPath)

      for (const entry of entries) {
        if (totalProcessed >= limit) break

        try {
          const sourceId = `${session.id}:decision:${entry.timestamp}`
          const result = await upsertDecisionAction(sql, entry, session.id, session.date, sourceId)

          if (result === 'created') actionsCreated++
          else if (result === 'updated') actionsUpdated++

          decisionsProcessed++
          totalProcessed++

          if (entry.timestamp > latestTimestamp) {
            latestTimestamp = entry.timestamp
          }
        } catch (err) {
          logger.error(`Error processing decision: ${err}`)
          errors++
        }
      }
    }

    // Process work-log.jsonl
    if (processWorkLogs && totalProcessed < limit) {
      const workLogPath = join(session.path, 'work-log.jsonl')
      if (existsSync(workLogPath)) {
        const entries = await readJsonlFile<WorkLogEntry>(workLogPath)

        for (const entry of entries) {
          if (totalProcessed >= limit) break

          try {
            const sourceId = `${session.id}:worklog:${entry.timestamp}`
            const result = await upsertWorkLogAction(sql, entry, session.id, session.date, sourceId)

            if (result === 'created') actionsCreated++
            else if (result === 'updated') actionsUpdated++

            workLogsProcessed++
            totalProcessed++

            if (entry.timestamp > latestTimestamp) {
              latestTimestamp = entry.timestamp
            }
          } catch (err) {
            logger.error(`Error processing work log: ${err}`)
            errors++
          }
        }
      }
    }
  }

  logger.info(`Processed ${decisionsProcessed} decisions, ${workLogsProcessed} work logs`)
  logger.info(`Actions: ${actionsCreated} created, ${actionsUpdated} updated, ${errors} errors`)

  return {
    outputRef: `watcher_actions_${job.id}`,
    metadata: {
      sessionsProcessed: sessions.length,
      decisionsProcessed,
      workLogsProcessed,
      actionsCreated,
      actionsUpdated,
      errors,
      lastProcessedTime: latestTimestamp,
    },
  }
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

async function listSessions(watcherPath: string, since: Date): Promise<SessionDir[]> {
  const sessions: SessionDir[] = []

  if (!existsSync(watcherPath)) {
    return sessions
  }

  const entries = await readdir(watcherPath, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const entryPath = join(watcherPath, entry.name)

    // Check if this is a date directory (YYYY-MM-DD format)
    if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
      const dateDir = entry.name
      const datePath = entryPath
      const subEntries = await readdir(datePath, { withFileTypes: true })

      for (const subEntry of subEntries) {
        if (!subEntry.isDirectory()) continue

        const sessionPath = join(datePath, subEntry.name)
        const sessionStat = await stat(sessionPath)

        if (sessionStat.mtime >= since) {
          sessions.push({
            id: subEntry.name,
            date: dateDir,
            path: sessionPath,
            modifiedAt: sessionStat.mtime,
          })
        }
      }
    } else if (entry.name.startsWith('tui_')) {
      // Legacy structure
      const sessionPath = entryPath
      const sessionStat = await stat(sessionPath)

      if (sessionStat.mtime >= since) {
        const decisionsPath = join(sessionPath, 'decisions.jsonl')
        let date = 'unknown'
        if (existsSync(decisionsPath)) {
          try {
            const content = await readFile(decisionsPath, 'utf-8')
            const firstLine = content.split('\n')[0]
            if (firstLine) {
              const parsed = JSON.parse(firstLine)
              if (parsed.timestamp) {
                date = parsed.timestamp.split('T')[0]
              }
            }
          } catch {
            // Ignore
          }
        }

        sessions.push({
          id: entry.name,
          date,
          path: sessionPath,
          modifiedAt: sessionStat.mtime,
        })
      }
    }
  }

  // Sort by modification time, oldest first (process in order)
  sessions.sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime())

  return sessions
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, 'utf-8')
  const lines = content.trim().split('\n').filter(l => l.length > 0)

  const entries: T[] = []
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as T)
    } catch {
      // Skip invalid JSON
    }
  }
  return entries
}

async function upsertDecisionAction(
  sql: ReturnType<typeof import('postgres').default>,
  entry: DecisionEntry,
  sessionId: string,
  sessionDate: string,
  sourceId: string
): Promise<'created' | 'updated' | 'skipped'> {
  // Check if action already exists
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM agent_actions
    WHERE metadata->>'source_id' = ${sourceId}
    LIMIT 1
  `

  // Infer outcome signal
  let outcomeSignal: 'positive' | 'negative' | 'neutral' | 'unknown' = 'unknown'
  switch (entry.watcherAction) {
    case 'allow':
    case 'continue':
    case 'answer':
      outcomeSignal = 'positive'
      break
    case 'realign':
    case 'escalate':
      outcomeSignal = 'negative'
      break
    case 'pause':
      outcomeSignal = 'neutral'
      break
  }

  const actionType = `watcher_${entry.trigger}`
  const context = {
    session_id: sessionId,
    session_date: sessionDate,
    work_item_id: entry.workItemId ?? null,
    question: entry.question ?? null,
    watcher_action: entry.watcherAction,
  }
  const parameters = {
    answer: entry.answer ?? null,
    tool_calls_made: entry.executionMetrics?.toolCallsMade ?? null,
    files_modified: entry.executionMetrics?.filesModified ?? null,
    duration_ms: entry.executionMetrics?.durationMs ?? null,
    context_percent_used: entry.executionMetrics?.contextPercentUsed ?? null,
  }
  const metadata = {
    source_id: sourceId,
    source_type: 'watcher_decision',
    trigger: entry.trigger,
  }

  if (existing.length > 0) {
    await sql`
      UPDATE agent_actions
      SET
        action_type = ${actionType},
        context = ${sql.json(context)},
        parameters = ${sql.json(parameters)},
        actual_outcome = ${entry.rationale},
        outcome_signal = ${outcomeSignal},
        resolved_at = ${new Date(entry.timestamp)},
        metadata = ${sql.json(metadata)}
      WHERE id = ${existing[0].id}
    `
    return 'updated'
  }

  const id = generateCanonicalId()
  await sql`
    INSERT INTO agent_actions (
      id, action_type, context, parameters,
      actual_outcome, outcome_signal, resolved_at, metadata
    )
    VALUES (
      ${id},
      ${actionType},
      ${sql.json(context)},
      ${sql.json(parameters)},
      ${entry.rationale},
      ${outcomeSignal},
      ${new Date(entry.timestamp)},
      ${sql.json(metadata)}
    )
  `
  return 'created'
}

async function upsertWorkLogAction(
  sql: ReturnType<typeof import('postgres').default>,
  entry: WorkLogEntry,
  sessionId: string,
  sessionDate: string,
  sourceId: string
): Promise<'created' | 'updated' | 'skipped'> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM agent_actions
    WHERE metadata->>'source_id' = ${sourceId}
    LIMIT 1
  `

  let outcomeSignal: 'positive' | 'negative' | 'neutral' | 'unknown' = 'neutral'
  if (entry.type === 'agent_completed') {
    outcomeSignal = 'positive'
  } else if (entry.type === 'error') {
    outcomeSignal = 'negative'
  }

  const actionType = `worklog_${entry.type}`
  const context = {
    session_id: sessionId,
    session_date: sessionDate,
    work_id: entry.workId ?? null,
    agent_type: entry.agentType ?? null,
  }
  const parameters = {
    paths: entry.paths ?? null,
    watcher_note: entry.watcherNote ?? null,
  }
  const metadata = {
    source_id: sourceId,
    source_type: 'watcher_worklog',
    log_type: entry.type,
  }

  if (existing.length > 0) {
    await sql`
      UPDATE agent_actions
      SET
        action_type = ${actionType},
        context = ${sql.json(context)},
        parameters = ${sql.json(parameters)},
        actual_outcome = ${entry.watcherNote},
        outcome_signal = ${outcomeSignal},
        resolved_at = ${new Date(entry.timestamp)},
        metadata = ${sql.json(metadata)}
      WHERE id = ${existing[0].id}
    `
    return 'updated'
  }

  const id = generateCanonicalId()
  await sql`
    INSERT INTO agent_actions (
      id, action_type, context, parameters,
      actual_outcome, outcome_signal, resolved_at, metadata
    )
    VALUES (
      ${id},
      ${actionType},
      ${sql.json(context)},
      ${sql.json(parameters)},
      ${entry.watcherNote},
      ${outcomeSignal},
      ${new Date(entry.timestamp)},
      ${sql.json(metadata)}
    )
  `
  return 'created'
}
