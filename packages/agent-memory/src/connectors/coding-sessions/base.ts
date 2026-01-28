/**
 * Coding Agent Session Base Connector
 *
 * Abstract base class for coding agent session connectors.
 * Handles common logic for reading JSONL session files.
 *
 * @module connectors/coding-sessions/base
 */

import { readdir, stat, readFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import type { ConnectorType } from '../../ids.js'
import type {
  Connector,
  ConnectorCapabilities,
  LocalAuthConfig,
  AccountInfo,
  ConnectorContext,
} from '../../connector/sdk/types.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
  EntityMapper,
} from '../../sync/types.js'

// ============ Internal Types ============

export interface CodingAgentSessionConfig {
  /** Base path to sessions directory */
  sessionsPath: string
  /** Specific project folders to sync (default: all) */
  projectFilter?: string[]
  /** Maximum sessions to fetch per page (default: 10) */
  pageSize?: number
  /** Include file history snapshots (default: false) */
  includeFileHistory?: boolean
}

export interface SessionFile {
  id: string
  path: string
  modifiedAt: Date
  size: number
}

interface BackfillCursor {
  projectIndex: number
  sessionIndex: number
  messageOffset: number
}

interface IncrementalCursor {
  projectIndex: number
  sessionIndex: number
  lastModified: string
}

/**
 * Abstract base class for coding agent session connectors.
 *
 * Subclasses must implement:
 * - type: ConnectorType identifier
 * - displayName: Human-readable name
 * - getSessionMessageSchema(): Zod schema for validating messages
 * - messageToSourceItem(): Convert parsed message to SourceItem
 */
export abstract class CodingAgentSessionConnector implements Connector {
  abstract readonly type: ConnectorType
  abstract readonly displayName: string

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: false,
    supportsWrite: false,
    supportedEntityTypes: ['session_message', 'session_summary'],
  }

  readonly authConfig: LocalAuthConfig = {
    type: 'local',
  }

  protected readonly sessionsPath: string
  protected readonly projectFilter?: string[]
  protected readonly pageSize: number
  protected readonly includeFileHistory: boolean

  constructor(config: CodingAgentSessionConfig) {
    this.sessionsPath = config.sessionsPath
    this.projectFilter = config.projectFilter
    this.pageSize = config.pageSize ?? 10
    this.includeFileHistory = config.includeFileHistory ?? false
  }

  /**
   * Get the Zod schema for validating session messages.
   * Subclasses should return their agent-specific schema.
   */
  protected abstract getSessionMessageSchema(): z.ZodSchema

  /**
   * Convert a parsed message to a SourceItem.
   * Subclasses implement agent-specific mapping logic.
   */
  protected abstract messageToSourceItem(
    msg: unknown,
    sessionId: string,
    project: string
  ): SourceItem | null

  // ============ Account Discovery ============

  async listAccounts(_ctx: ConnectorContext): Promise<AccountInfo[]> {
    const username = process.env.USER ?? process.env.USERNAME ?? 'local'

    return [{
      externalId: 'local',
      displayName: `${this.displayName} (${username})`,
      username,
      isPrimary: true,
      metadata: {
        sessionsPath: this.sessionsPath,
      },
    }]
  }

  // ============ Sync Methods ============

  async fetchPage(
    _ctx: ConnectorContext,
    options: FetchPageOptions
  ): Promise<FetchPageResult> {
    const items: SourceItem[] = []

    let cursorState: BackfillCursor = {
      projectIndex: 0,
      sessionIndex: 0,
      messageOffset: 0,
    }
    if (options.cursor) {
      try {
        cursorState = JSON.parse(options.cursor) as BackfillCursor
      } catch {
        // Invalid cursor, start fresh
      }
    }

    const projects = await this.listProjects()
    if (cursorState.projectIndex >= projects.length || !projects[cursorState.projectIndex]) {
      return { items: [], hasMore: false }
    }

    const currentProject = projects[cursorState.projectIndex]
    const sessions = await this.listSessions(currentProject)

    if (cursorState.sessionIndex >= sessions.length) {
      if (cursorState.projectIndex + 1 >= projects.length) {
        return { items: [], hasMore: false }
      }
      return {
        items: [],
        hasMore: true,
        nextCursor: JSON.stringify({
          projectIndex: cursorState.projectIndex + 1,
          sessionIndex: 0,
          messageOffset: 0,
        }),
      }
    }

    const currentSession = sessions[cursorState.sessionIndex]
    const { messages, hasMore: moreMessages } = await this.readSessionMessages(
      currentSession.path,
      cursorState.messageOffset,
      this.pageSize
    )

    for (const msg of messages) {
      const sourceItem = this.messageToSourceItem(msg, currentSession.id, currentProject)
      if (sourceItem) {
        items.push(sourceItem)
      }
    }

    let hasMore = false
    let nextCursor: string | undefined

    if (moreMessages) {
      hasMore = true
      nextCursor = JSON.stringify({
        projectIndex: cursorState.projectIndex,
        sessionIndex: cursorState.sessionIndex,
        messageOffset: cursorState.messageOffset + messages.length,
      })
    } else if (cursorState.sessionIndex + 1 < sessions.length) {
      hasMore = true
      nextCursor = JSON.stringify({
        projectIndex: cursorState.projectIndex,
        sessionIndex: cursorState.sessionIndex + 1,
        messageOffset: 0,
      })
    } else if (cursorState.projectIndex + 1 < projects.length) {
      hasMore = true
      nextCursor = JSON.stringify({
        projectIndex: cursorState.projectIndex + 1,
        sessionIndex: 0,
        messageOffset: 0,
      })
    }

    return { items, hasMore, nextCursor }
  }

  async fetchChanges(
    _ctx: ConnectorContext,
    options: FetchChangesOptions
  ): Promise<FetchPageResult> {
    const items: SourceItem[] = []

    const sinceDate = options.since
      ? new Date(options.since)
      : new Date(Date.now() - 24 * 60 * 60 * 1000)

    let cursorState: IncrementalCursor = {
      projectIndex: 0,
      sessionIndex: 0,
      lastModified: sinceDate.toISOString(),
    }
    if (options.cursor) {
      try {
        const parsed = JSON.parse(options.cursor) as Record<string, unknown>
        cursorState = {
          projectIndex: typeof parsed.projectIndex === 'number' ? parsed.projectIndex : 0,
          sessionIndex: typeof parsed.sessionIndex === 'number' ? parsed.sessionIndex : 0,
          // Handle backfill cursor format (has messageOffset instead of lastModified)
          lastModified: typeof parsed.lastModified === 'string'
            ? parsed.lastModified
            : sinceDate.toISOString(),
        }
      } catch {
        // Invalid cursor, use defaults
      }
    }

    const projects = await this.listProjects()
    if (cursorState.projectIndex >= projects.length || !projects[cursorState.projectIndex]) {
      return { items: [], hasMore: false }
    }

    const currentProject = projects[cursorState.projectIndex]
    const sessions = await this.listSessionsModifiedSince(
      currentProject,
      new Date(cursorState.lastModified)
    )

    if (cursorState.sessionIndex >= sessions.length) {
      if (cursorState.projectIndex + 1 >= projects.length) {
        return { items: [], hasMore: false }
      }
      return {
        items: [],
        hasMore: true,
        nextCursor: JSON.stringify({
          projectIndex: cursorState.projectIndex + 1,
          sessionIndex: 0,
          lastModified: cursorState.lastModified,
        }),
      }
    }

    const currentSession = sessions[cursorState.sessionIndex]
    const { messages } = await this.readSessionMessages(currentSession.path, 0, 1000)

    for (const msg of messages) {
      const sourceItem = this.messageToSourceItem(msg, currentSession.id, currentProject)
      if (sourceItem) {
        items.push(sourceItem)
      }
    }

    let hasMore = false
    let nextCursor: string | undefined

    if (cursorState.sessionIndex + 1 < sessions.length) {
      hasMore = true
      nextCursor = JSON.stringify({
        projectIndex: cursorState.projectIndex,
        sessionIndex: cursorState.sessionIndex + 1,
        lastModified: cursorState.lastModified,
      })
    } else if (cursorState.projectIndex + 1 < projects.length) {
      hasMore = true
      nextCursor = JSON.stringify({
        projectIndex: cursorState.projectIndex + 1,
        sessionIndex: 0,
        lastModified: cursorState.lastModified,
      })
    }

    return { items, hasMore, nextCursor }
  }

  // ============ Protected Helpers ============

  protected async listProjects(): Promise<string[]> {
    try {
      const entries = await readdir(this.sessionsPath, { withFileTypes: true })
      let projects = entries
        .filter(e => e.isDirectory() && typeof e.name === 'string')
        .map(e => e.name)

      if (this.projectFilter && this.projectFilter.length > 0) {
        projects = projects.filter(p => this.projectFilter!.some(f => p.includes(f)))
      }

      return projects.sort()
    } catch {
      return []
    }
  }

  protected async listSessions(project: string): Promise<SessionFile[]> {
    try {
      const projectPath = join(this.sessionsPath, project)
      const entries = await readdir(projectPath, { withFileTypes: true })
      const sessions: SessionFile[] = []

      for (const entry of entries) {
        if (entry.isFile() && typeof entry.name === 'string' && entry.name.endsWith('.jsonl')) {
          const sessionId = entry.name.replace('.jsonl', '')
          const filePath = join(projectPath, entry.name)
          const stats = await stat(filePath)

          sessions.push({
            id: sessionId,
            path: filePath,
            modifiedAt: stats.mtime,
            size: stats.size,
          })
        }
      }

      return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())
    } catch {
      return []
    }
  }

  protected async listSessionsModifiedSince(
    project: string,
    since: Date
  ): Promise<SessionFile[]> {
    const sessions = await this.listSessions(project)
    return sessions.filter(s => s.modifiedAt > since)
  }

  protected async readSessionMessages(
    filePath: string,
    offset: number,
    limit: number
  ): Promise<{ messages: unknown[]; hasMore: boolean }> {
    const schema = this.getSessionMessageSchema()

    try {
      const content = await readFile(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(l => l.length > 0)

      const messages: unknown[] = []
      let lineIndex = 0
      let itemCount = 0

      for (const line of lines) {
        if (lineIndex < offset) {
          lineIndex++
          continue
        }

        if (itemCount >= limit) {
          return { messages, hasMore: true }
        }

        try {
          const parsed = JSON.parse(line)
          const result = schema.safeParse(parsed)

          if (result.success) {
            const data = result.data as { type?: string }
            // Skip file history snapshots unless configured
            if (data.type === 'file-history-snapshot' && !this.includeFileHistory) {
              lineIndex++
              continue
            }
            messages.push(result.data)
            itemCount++
          }
        } catch {
          // Skip invalid JSON lines
        }

        lineIndex++
      }

      return { messages, hasMore: false }
    } catch {
      return { messages: [], hasMore: false }
    }
  }

  // ============ Schema Methods (deprecated - will be removed with Transformation Layer) ============

  /**
   * Get source schema for an entity type.
   * @deprecated Use Transformation Layer instead
   */
  getSourceSchema(entityType: string): z.ZodSchema | undefined {
    if (entityType === 'session_message' || entityType === 'session_summary') {
      return this.getSessionMessageSchema()
    }
    return undefined
  }

  /**
   * Get mapper for an entity type.
   * @deprecated Use Transformation Layer instead - connectors don't own mappers
   */
  getMapper(_entityType: string): EntityMapper | undefined {
    return undefined
  }
}
