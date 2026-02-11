/**
 * Watcher Sessions Connector
 *
 * Reads watcher session data from .watcher/ directories.
 * Supports decisions.jsonl and work-log.jsonl files.
 *
 * @module connectors/watcher-sessions/connector
 */

import { readdir, stat, readFile } from 'fs/promises'
import { join, basename, dirname } from 'path'
import { existsSync } from 'fs'
import { z } from 'zod'
import type { ConnectorType } from '../../ids.js'
import type {
  Connector,
  ConnectorCapabilities,
  LocalAuthConfig,
  AccountInfo,
  ConnectorContext,
  SyncEstimate,
} from '../../connector/sdk/types.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
} from '../../sync/types.js'
import {
  DecisionEntrySchema,
  WorkLogEntrySchema,
  WatcherDecisionSourceSchema,
  WatcherWorkLogSourceSchema,
  type DecisionEntry,
  type WorkLogEntry,
} from './schemas.js'

// ============ Configuration ============

export interface WatcherSessionsConnectorConfig {
  /** Base path to .watcher directory (default: ./.watcher) */
  watcherPath?: string
  /** Maximum entries to fetch per page (default: 100) */
  pageSize?: number
  /** Only sync specific session IDs */
  sessionFilter?: string[]
}

// ============ Session File Types ============

interface SessionDir {
  id: string
  date: string
  path: string
  modifiedAt: Date
}

interface SessionFile {
  type: 'decisions' | 'work-log'
  path: string
  sessionId: string
  sessionDate: string
  modifiedAt: Date
}

// ============ Cursor Types ============

interface BackfillCursor {
  sessionIndex: number
  fileType: 'decisions' | 'work-log'
  lineOffset: number
}

interface IncrementalCursor {
  sinceDate: string
  sessionIndex: number
  fileType: 'decisions' | 'work-log'
  lineOffset: number
}

// ============ Connector ============

export class WatcherSessionsConnector implements Connector {
  readonly type: ConnectorType = 'watcher_sessions'
  readonly displayName = 'Watcher Sessions'

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: false,
    supportsWrite: false,
    supportedEntityTypes: ['decision', 'work_log_entry'],
  }

  readonly authConfig: LocalAuthConfig = {
    type: 'local',
  }

  private readonly watcherPath: string
  private readonly pageSize: number
  private readonly sessionFilter?: string[]

  constructor(config: WatcherSessionsConnectorConfig = {}) {
    this.watcherPath = config.watcherPath ?? '.watcher'
    this.pageSize = config.pageSize ?? 100
    this.sessionFilter = config.sessionFilter
  }

  // ============ Account Discovery ============

  async listAccounts(_ctx: ConnectorContext): Promise<AccountInfo[]> {
    const username = process.env.USER ?? process.env.USERNAME ?? 'local'

    return [{
      externalId: 'local',
      displayName: `Watcher Sessions (${username})`,
      username,
      isPrimary: true,
      metadata: {
        watcherPath: this.watcherPath,
      },
    }]
  }

  // ============ Estimate ============

  async estimateScope(
    _ctx: ConnectorContext,
    syncType: 'backfill' | 'incremental',
    entityTypes?: string[]
  ): Promise<SyncEstimate> {
    const types = entityTypes ?? this.capabilities.supportedEntityTypes

    try {
      const sessions = await this.listAllSessions()
      let decisionCount = 0
      let workLogCount = 0

      // Sample first few sessions to estimate
      const sampled = sessions.slice(0, 10)
      for (const session of sampled) {
        const files = await this.listSessionFiles(session)
        for (const file of files) {
          const lines = await this.countLines(file.path)
          if (file.type === 'decisions') {
            decisionCount += lines
          } else {
            workLogCount += lines
          }
        }
      }

      // Extrapolate
      const multiplier = sessions.length / Math.max(sampled.length, 1)
      decisionCount = Math.round(decisionCount * multiplier)
      workLogCount = Math.round(workLogCount * multiplier)

      const entities = types.map((type) => {
        if (type === 'decision') {
          return { type, count: decisionCount, description: `~${decisionCount.toLocaleString()} decisions` }
        }
        if (type === 'work_log_entry') {
          return { type, count: workLogCount, description: `~${workLogCount.toLocaleString()} work log entries` }
        }
        return { type, description: `${type} (count unavailable)` }
      })

      const label = syncType === 'backfill' ? 'Full backfill' : 'Incremental sync'
      const parts = entities.filter((e) => e.count != null).map((e) => e.description)

      return {
        entities,
        summary: parts.length > 0 ? `${label}: ${parts.join(', ')} from ${sessions.length} sessions` : label,
      }
    } catch {
      return {
        entities: types.map((type) => ({ type, description: `${type} (unable to read directory)` })),
      }
    }
  }

  // ============ Sync Methods ============

  async fetchPage(
    _ctx: ConnectorContext,
    options: FetchPageOptions
  ): Promise<FetchPageResult> {
    const items: SourceItem[] = []
    const entityTypes = options.entityTypes ?? ['decision', 'work_log_entry']

    let cursor: BackfillCursor = {
      sessionIndex: 0,
      fileType: 'decisions',
      lineOffset: 0,
    }
    if (options.cursor) {
      try {
        cursor = JSON.parse(options.cursor) as BackfillCursor
      } catch {
        // Invalid cursor, start fresh
      }
    }

    const sessions = await this.listAllSessions()
    if (cursor.sessionIndex >= sessions.length) {
      return { items: [], hasMore: false }
    }

    const limit = options.limit ?? this.pageSize
    let collected = 0

    while (collected < limit && cursor.sessionIndex < sessions.length) {
      const session = sessions[cursor.sessionIndex]
      const files = await this.listSessionFiles(session)

      // Find current file
      const fileTypes: ('decisions' | 'work-log')[] = []
      if (entityTypes.includes('decision')) fileTypes.push('decisions')
      if (entityTypes.includes('work_log_entry')) fileTypes.push('work-log')

      const currentFileIdx = fileTypes.indexOf(cursor.fileType)
      if (currentFileIdx === -1) {
        cursor.sessionIndex++
        cursor.fileType = fileTypes[0] ?? 'decisions'
        cursor.lineOffset = 0
        continue
      }

      for (let fi = currentFileIdx; fi < fileTypes.length && collected < limit; fi++) {
        const fileType = fileTypes[fi]
        const file = files.find(f => f.type === fileType)

        if (!file) {
          cursor.lineOffset = 0
          continue
        }

        const offset = fi === currentFileIdx ? cursor.lineOffset : 0
        const { entries, hasMore } = await this.readJsonlFile(
          file.path,
          fileType,
          session.id,
          session.date,
          offset,
          limit - collected
        )

        items.push(...entries)
        collected += entries.length

        if (hasMore) {
          cursor.fileType = fileType
          cursor.lineOffset = offset + entries.length
          return {
            items,
            hasMore: true,
            nextCursor: JSON.stringify(cursor),
          }
        }

        cursor.lineOffset = 0
        cursor.fileType = fileTypes[fi + 1] ?? 'decisions'
      }

      cursor.sessionIndex++
      cursor.fileType = fileTypes[0] ?? 'decisions'
      cursor.lineOffset = 0
    }

    const hasMore = cursor.sessionIndex < sessions.length
    return {
      items,
      hasMore,
      nextCursor: hasMore ? JSON.stringify(cursor) : undefined,
    }
  }

  async fetchChanges(
    _ctx: ConnectorContext,
    options: FetchChangesOptions
  ): Promise<FetchPageResult> {
    const sinceDate = options.since
      ? new Date(options.since)
      : new Date(Date.now() - 24 * 60 * 60 * 1000)

    let cursor: IncrementalCursor = {
      sinceDate: sinceDate.toISOString(),
      sessionIndex: 0,
      fileType: 'decisions',
      lineOffset: 0,
    }
    if (options.cursor) {
      try {
        const parsed = JSON.parse(options.cursor) as Record<string, unknown>
        cursor = {
          sinceDate: (parsed.sinceDate as string) ?? sinceDate.toISOString(),
          sessionIndex: (parsed.sessionIndex as number) ?? 0,
          fileType: (parsed.fileType as 'decisions' | 'work-log') ?? 'decisions',
          lineOffset: (parsed.lineOffset as number) ?? 0,
        }
      } catch {
        // Use defaults
      }
    }

    // Filter to sessions modified since the cursor date
    const allSessions = await this.listAllSessions()
    const sessions = allSessions.filter(s => s.modifiedAt >= new Date(cursor.sinceDate))

    if (cursor.sessionIndex >= sessions.length) {
      return { items: [], hasMore: false }
    }

    // Reuse backfill logic with filtered sessions
    const result = await this.fetchPage(_ctx, {
      cursor: JSON.stringify({
        sessionIndex: cursor.sessionIndex,
        fileType: cursor.fileType,
        lineOffset: cursor.lineOffset,
      }),
      limit: options.limit ?? this.pageSize,
      entityTypes: options.entityTypes,
    })

    // Update cursor to incremental format
    if (result.nextCursor) {
      const backfillCursor = JSON.parse(result.nextCursor) as BackfillCursor
      result.nextCursor = JSON.stringify({
        sinceDate: cursor.sinceDate,
        sessionIndex: backfillCursor.sessionIndex,
        fileType: backfillCursor.fileType,
        lineOffset: backfillCursor.lineOffset,
      })
    }

    return result
  }

  // ============ Helpers ============

  private async listAllSessions(): Promise<SessionDir[]> {
    const sessions: SessionDir[] = []

    if (!existsSync(this.watcherPath)) {
      return sessions
    }

    try {
      const entries = await readdir(this.watcherPath, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const entryPath = join(this.watcherPath, entry.name)

        // Check if this is a date directory (YYYY-MM-DD format)
        if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
          // New structure: .watcher/{date}/{sessionId}/
          const dateDir = entry.name
          const datePath = entryPath
          const subEntries = await readdir(datePath, { withFileTypes: true })

          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) continue

            const sessionPath = join(datePath, subEntry.name)
            const sessionStat = await stat(sessionPath)

            if (this.sessionFilter && !this.sessionFilter.includes(subEntry.name)) {
              continue
            }

            sessions.push({
              id: subEntry.name,
              date: dateDir,
              path: sessionPath,
              modifiedAt: sessionStat.mtime,
            })
          }
        } else if (entry.name.startsWith('tui_')) {
          // Legacy structure: .watcher/{sessionId}/
          const sessionPath = entryPath
          const sessionStat = await stat(sessionPath)

          if (this.sessionFilter && !this.sessionFilter.includes(entry.name)) {
            continue
          }

          // Extract date from session files if available
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

      // Sort by modification time, newest first
      sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())

      return sessions
    } catch {
      return []
    }
  }

  private async listSessionFiles(session: SessionDir): Promise<SessionFile[]> {
    const files: SessionFile[] = []

    const decisionsPath = join(session.path, 'decisions.jsonl')
    const workLogPath = join(session.path, 'work-log.jsonl')

    if (existsSync(decisionsPath)) {
      const s = await stat(decisionsPath)
      files.push({
        type: 'decisions',
        path: decisionsPath,
        sessionId: session.id,
        sessionDate: session.date,
        modifiedAt: s.mtime,
      })
    }

    if (existsSync(workLogPath)) {
      const s = await stat(workLogPath)
      files.push({
        type: 'work-log',
        path: workLogPath,
        sessionId: session.id,
        sessionDate: session.date,
        modifiedAt: s.mtime,
      })
    }

    return files
  }

  private async countLines(filePath: string): Promise<number> {
    try {
      const content = await readFile(filePath, 'utf-8')
      return content.trim().split('\n').filter(l => l.length > 0).length
    } catch {
      return 0
    }
  }

  private async readJsonlFile(
    filePath: string,
    fileType: 'decisions' | 'work-log',
    sessionId: string,
    sessionDate: string,
    offset: number,
    limit: number
  ): Promise<{ entries: SourceItem[]; hasMore: boolean }> {
    const entries: SourceItem[] = []

    try {
      const content = await readFile(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(l => l.length > 0)

      let lineIndex = 0
      let collected = 0

      for (const line of lines) {
        if (lineIndex < offset) {
          lineIndex++
          continue
        }

        if (collected >= limit) {
          return { entries, hasMore: true }
        }

        try {
          const parsed = JSON.parse(line)

          if (fileType === 'decisions') {
            const result = DecisionEntrySchema.safeParse(parsed)
            if (result.success) {
              const entry = result.data
              const sourceItem = this.decisionToSourceItem(entry, sessionId, sessionDate, lineIndex)
              if (sourceItem) {
                entries.push(sourceItem)
                collected++
              }
            }
          } else {
            const result = WorkLogEntrySchema.safeParse(parsed)
            if (result.success) {
              const entry = result.data
              const sourceItem = this.workLogToSourceItem(entry, sessionId, sessionDate, lineIndex)
              if (sourceItem) {
                entries.push(sourceItem)
                collected++
              }
            }
          }
        } catch {
          // Skip invalid JSON
        }

        lineIndex++
      }

      return { entries, hasMore: false }
    } catch {
      return { entries: [], hasMore: false }
    }
  }

  private decisionToSourceItem(
    entry: DecisionEntry,
    sessionId: string,
    sessionDate: string,
    lineIndex: number
  ): SourceItem | null {
    const sourceData = {
      session_id: sessionId,
      session_date: sessionDate,
      timestamp: entry.timestamp,
      trigger: entry.trigger,
      watcher_action: entry.watcherAction,
      question: entry.question ?? null,
      answer: entry.answer ?? null,
      rationale: entry.rationale,
      work_item_id: entry.workItemId ?? null,
      tool_calls_made: entry.executionMetrics?.toolCallsMade ?? null,
      files_modified: entry.executionMetrics?.filesModified ?? null,
      duration_ms: entry.executionMetrics?.durationMs ?? null,
      context_percent_used: entry.executionMetrics?.contextPercentUsed ?? null,
    }

    const validated = WatcherDecisionSourceSchema.safeParse(sourceData)
    if (!validated.success) {
      return null
    }

    // Source ID: session_id + line index for uniqueness
    const sourceId = `${sessionId}:decision:${lineIndex}`

    return {
      source_id: sourceId,
      entity_type: 'decision',
      raw_data: validated.data,
      source_timestamp: entry.timestamp,
    }
  }

  private workLogToSourceItem(
    entry: WorkLogEntry,
    sessionId: string,
    sessionDate: string,
    lineIndex: number
  ): SourceItem | null {
    const sourceData = {
      session_id: sessionId,
      session_date: sessionDate,
      timestamp: entry.timestamp,
      type: entry.type,
      work_id: entry.workId ?? null,
      agent_type: entry.agentType ?? null,
      paths: entry.paths ?? null,
      watcher_note: entry.watcherNote ?? null,
    }

    const validated = WatcherWorkLogSourceSchema.safeParse(sourceData)
    if (!validated.success) {
      return null
    }

    const sourceId = `${sessionId}:worklog:${lineIndex}`

    return {
      source_id: sourceId,
      entity_type: 'work_log_entry',
      raw_data: validated.data,
      source_timestamp: entry.timestamp,
    }
  }

  // ============ Schema Methods ============

  getSourceSchema(entityType: string): z.ZodSchema | undefined {
    if (entityType === 'decision') {
      return WatcherDecisionSourceSchema
    }
    if (entityType === 'work_log_entry') {
      return WatcherWorkLogSourceSchema
    }
    return undefined
  }
}

// ============ Factory ============

export function createWatcherSessionsConnector(
  config?: WatcherSessionsConnectorConfig
): WatcherSessionsConnector {
  return new WatcherSessionsConnector(config)
}
