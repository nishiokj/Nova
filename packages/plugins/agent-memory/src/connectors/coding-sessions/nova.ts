/**
 * Nova Session Connector (GraphD SQLite)
 *
 * Connector for ingesting Nova coding agent session data directly from
 * the GraphD SQLite database, with optional webhook-style event triggers.
 *
 * @module connectors/coding-sessions/nova
 */

import { Database } from 'bun:sqlite'
import { existsSync, watch } from 'fs'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'
import { z } from 'zod'
import type { ConnectorType } from '../../ids.js'
import type {
  Connector,
  ConnectorCapabilities,
  LocalAuthConfig,
  AccountInfo,
  ConnectorContext,
  SyncEstimate,
  WebhookEvent,
  WebhookSubscription,
  WebhookSubscribeOptions,
} from '../../connector/sdk/types.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
} from '../../sync/types.js'
import { NovaSessionMessageSchema, type NovaSessionMessage } from './schemas.js'
import type { TransformationRegistry } from '../../transform/registry.js'
import { novaTransforms } from './transforms.js'

// ============ Configuration ============

export interface NovaSessionConnectorConfig {
  /** Path to GraphD SQLite database (default: ~/.graphd/graphd.db) */
  databasePath?: string
  /** Only sync sessions whose working_dir matches these substrings */
  projectFilter?: string[]
  /** Only sync sessions whose session_key matches these substrings */
  sessionFilter?: string[]
  /** Only sync sessions with these client_type values */
  clientTypeFilter?: string[]
  /** Maximum messages to fetch per page (default: 100) */
  pageSize?: number
  /** Debounce window for DB change events (ms) */
  webhookDebounceMs?: number
  /** When true, webhook ingestion starts at latest row id */
  webhookStartAtLatest?: boolean
  /** Max rows to pull per webhook batch */
  webhookBatchSize?: number
}

const DEFAULT_DB_PATH = join(homedir(), '.graphd', 'graphd.db')
const DEFAULT_PAGE_SIZE = 100
const DEFAULT_WEBHOOK_DEBOUNCE_MS = 500
const DEFAULT_WEBHOOK_BATCH_SIZE = 500

// ============ Row Schemas ============

const GraphDMessageRowSchema = z.object({
  id: z.number(),
  session_key: z.string(),
  message_index: z.number(),
  role: z.string(),
  content: z.string(),
  created_at: z.number(),
  metadata_json: z.string().nullable().optional(),
  working_dir: z.string().nullable().optional(),
  client_type: z.string().nullable().optional(),
  session_metadata_json: z.string().nullable().optional(),
})

type GraphDMessageRow = z.infer<typeof GraphDMessageRowSchema>
type NovaConversationMessage = Extract<NovaSessionMessage, { type: 'user' | 'assistant' }>

// ============ Cursor Types ============

interface BackfillCursor {
  lastRowId: number
}

interface IncrementalCursor {
  lastRowId: number
  lastTimestamp: number
}

// ============ Nova Session Connector ============

export class NovaSessionConnector implements Connector {
  readonly type: ConnectorType = 'nova_sessions'
  readonly displayName = 'Nova Sessions (GraphD)'

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: true,
    supportsWrite: false,
    supportedEntityTypes: ['session_message'],
  }

  readonly authConfig: LocalAuthConfig

  private readonly databasePath: string
  private readonly projectFilter?: string[]
  private readonly sessionFilter?: string[]
  private readonly clientTypeFilter?: string[]
  private readonly pageSize: number
  private readonly webhookDebounceMs: number
  private readonly webhookStartAtLatest: boolean
  private readonly webhookBatchSize: number
  private db: Database | null = null
  private webhookLastRowId: number | null = null
  private webhookSubscriptions = new Map<string, () => void>()

  constructor(config: NovaSessionConnectorConfig = {}) {
    this.databasePath = config.databasePath ?? DEFAULT_DB_PATH
    this.projectFilter = config.projectFilter
    this.sessionFilter = config.sessionFilter
    this.clientTypeFilter = config.clientTypeFilter
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE
    this.webhookDebounceMs = config.webhookDebounceMs ?? DEFAULT_WEBHOOK_DEBOUNCE_MS
    this.webhookStartAtLatest = config.webhookStartAtLatest ?? true
    this.webhookBatchSize = config.webhookBatchSize ?? DEFAULT_WEBHOOK_BATCH_SIZE
    this.authConfig = {
      type: 'local',
      dataPath: this.databasePath,
    }
  }

  // ============ Database Access ============

  private getDatabase(): Database {
    if (this.db) return this.db

    if (!existsSync(this.databasePath)) {
      throw new Error(
        `Nova GraphD database not found at ${this.databasePath}. ` +
        'Set nova_sessions.databasePath to the GraphD SQLite file.'
      )
    }

    try {
      this.db = new Database(this.databasePath, { readonly: true })
      return this.db
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to open GraphD database: ${msg}`)
    }
  }

  private buildFilterClause(): { clause: string; params: unknown[] } {
    const conditions: string[] = []
    const params: unknown[] = []

    if (this.clientTypeFilter && this.clientTypeFilter.length > 0) {
      conditions.push(`s.client_type IN (${this.clientTypeFilter.map(() => '?').join(', ')})`)
      params.push(...this.clientTypeFilter)
    }

    if (this.sessionFilter && this.sessionFilter.length > 0) {
      const parts = this.sessionFilter.map(() => 'm.session_key LIKE ?')
      conditions.push(`(${parts.join(' OR ')})`)
      params.push(...this.sessionFilter.map((val) => `%${val}%`))
    }

    if (this.projectFilter && this.projectFilter.length > 0) {
      const parts = this.projectFilter.map(() => 's.working_dir LIKE ?')
      conditions.push(`(s.working_dir IS NOT NULL AND (${parts.join(' OR ')}))`)
      params.push(...this.projectFilter.map((val) => `%${val}%`))
    }

    if (conditions.length === 0) {
      return { clause: '', params }
    }

    return { clause: ` AND ${conditions.join(' AND ')}`, params }
  }

  private rowToSourceItem(row: GraphDMessageRow): SourceItem | null {
    const role = row.role === 'assistant' || row.role === 'user' ? row.role : null
    if (!role) return null

    const timestamp = new Date(row.created_at * 1000).toISOString()
    const project = row.working_dir ? basename(row.working_dir) : undefined

    const message: NovaConversationMessage = {
      type: role,
      id: String(row.id),
      session_id: row.session_key,
      timestamp,
      content: row.content,
      parent_id: null,
    }

    return {
      source_id: message.id,
      entity_type: 'session_message',
      raw_data: {
        ...message,
        _meta: {
          sessionId: row.session_key,
          project,
          working_dir: row.working_dir ?? undefined,
          client_type: row.client_type ?? undefined,
          agent: 'nova',
        },
      },
      source_timestamp: message.timestamp,
    }
  }

  private getMaxRowId(): number {
    const db = this.getDatabase()
    const row = db.query<{ max_id: number }, []>(
      'SELECT COALESCE(MAX(id), 0) as max_id FROM conversation_messages;'
    ).get()
    return row?.max_id ?? 0
  }

  private queryMessagesAfter(
    lastRowId: number,
    limit: number,
    minTimestamp?: number
  ): GraphDMessageRow[] {
    const db = this.getDatabase()
    const { clause, params } = this.buildFilterClause()
    const sinceClause = typeof minTimestamp === 'number' ? ' AND m.created_at >= ?' : ''
    const query = `
      SELECT
        m.id,
        m.session_key,
        m.message_index,
        m.role,
        m.content,
        m.created_at,
        m.metadata_json,
        s.working_dir,
        s.client_type,
        s.metadata_json as session_metadata_json
      FROM conversation_messages m
      JOIN sessions s ON s.session_key = m.session_key
      WHERE m.id > ?${sinceClause}${clause}
      ORDER BY m.id ASC
      LIMIT ?;
    `
    const baseParams: unknown[] = [lastRowId]
    if (typeof minTimestamp === 'number') {
      baseParams.push(minTimestamp)
    }
    const bindings = [...baseParams, ...params, limit] as unknown[]
    const rows = db.query(query).all(bindings as any) as Record<string, unknown>[]
    const parsed: GraphDMessageRow[] = []
    for (const row of rows) {
      const result = GraphDMessageRowSchema.safeParse(row)
      if (result.success) {
        parsed.push(result.data)
      }
    }
    return parsed
  }

  // ============ Account Discovery ============

  async listAccounts(_ctx: ConnectorContext): Promise<AccountInfo[]> {
    const username = process.env.USER ?? process.env.USERNAME ?? 'local'

    return [{
      externalId: 'local',
      displayName: `Nova Sessions (GraphD) (${username})`,
      username,
      isPrimary: true,
      metadata: {
        databasePath: this.databasePath,
      },
    }]
  }

  // ============ Estimate ============

  async estimateScope(
    _ctx: ConnectorContext,
    _syncType: 'backfill' | 'incremental',
    _entityTypes?: string[]
  ): Promise<SyncEstimate> {
    try {
      const db = this.getDatabase()
      const { clause, params } = this.buildFilterClause()
      const stmt = db.query(
        `SELECT COUNT(*) as count
         FROM conversation_messages m
         JOIN sessions s ON s.session_key = m.session_key
         WHERE 1=1${clause};`
      )
      const rowResult = (params.length > 0
        ? stmt.get(...(params as any))
        : stmt.get()) as { count?: number } | undefined
      const count = rowResult?.count ?? 0

      return {
        entities: [{
          type: 'session_message',
          count,
          description: `${count} session messages`,
        }],
        summary: `Nova sessions in GraphD (${count} messages)`,
      }
    } catch {
      return {
        entities: [{
          type: 'session_message',
          description: 'session_message (unable to read GraphD database)',
        }],
      }
    }
  }

  // ============ Sync Methods ============

  async fetchPage(
    _ctx: ConnectorContext,
    options: FetchPageOptions
  ): Promise<FetchPageResult> {
    const entityTypes = options.entityTypes ?? ['session_message']
    if (!entityTypes.includes('session_message')) {
      return { items: [], hasMore: false }
    }

    let cursor: BackfillCursor = { lastRowId: 0 }
    if (options.cursor) {
      try {
        const parsed = JSON.parse(options.cursor) as Partial<BackfillCursor>
        if (typeof parsed.lastRowId === 'number') {
          cursor.lastRowId = parsed.lastRowId
        }
      } catch {
        // Invalid cursor, start fresh
      }
    }

    const limit = options.limit ?? this.pageSize
    const rows = this.queryMessagesAfter(cursor.lastRowId, limit)
    const items: SourceItem[] = []
    let lastRowId = cursor.lastRowId

    for (const row of rows) {
      const sourceItem = this.rowToSourceItem(row)
      if (sourceItem) {
        items.push(sourceItem)
      }
      if (row.id > lastRowId) {
        lastRowId = row.id
      }
    }

    const hasMore = rows.length === limit
    const nextCursor = hasMore ? JSON.stringify({ lastRowId }) : undefined

    return { items, hasMore, nextCursor }
  }

  async fetchChanges(
    _ctx: ConnectorContext,
    options: FetchChangesOptions
  ): Promise<FetchPageResult> {
    const entityTypes = options.entityTypes ?? ['session_message']
    if (!entityTypes.includes('session_message')) {
      return { items: [], hasMore: false }
    }

    let sinceSeconds = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)
    if (options.since) {
      const parsed = Date.parse(options.since)
      if (!Number.isNaN(parsed)) {
        sinceSeconds = Math.floor(parsed / 1000)
      }
    }

    let cursor: IncrementalCursor = {
      lastRowId: 0,
      lastTimestamp: sinceSeconds,
    }
    if (options.cursor) {
      try {
        const parsed = JSON.parse(options.cursor) as Partial<IncrementalCursor>
        if (typeof parsed.lastRowId === 'number') cursor.lastRowId = parsed.lastRowId
        if (typeof parsed.lastTimestamp === 'number') cursor.lastTimestamp = parsed.lastTimestamp
      } catch {
        // Invalid cursor, use defaults
      }
    }

    const limit = options.limit ?? this.pageSize
    const rows = this.queryMessagesAfter(cursor.lastRowId, limit, cursor.lastTimestamp)
    const items: SourceItem[] = []
    let lastRowId = cursor.lastRowId
    let lastTimestamp = cursor.lastTimestamp

    for (const row of rows) {
      const sourceItem = this.rowToSourceItem(row)
      if (sourceItem) {
        items.push(sourceItem)
      }
      if (row.id > lastRowId) {
        lastRowId = row.id
      }
      if (row.created_at > lastTimestamp) {
        lastTimestamp = row.created_at
      }
    }

    const hasMore = rows.length === limit
    const nextCursor = hasMore ? JSON.stringify({ lastRowId, lastTimestamp }) : undefined

    return { items, hasMore, nextCursor }
  }

  // ============ Webhook Methods (Event-Driven) ============

  async parseWebhookPayload(_event: WebhookEvent): Promise<SourceItem[]> {
    if (this.webhookStartAtLatest && this.webhookLastRowId === null) {
      this.webhookLastRowId = this.getMaxRowId()
      return []
    }

    let lastRowId = this.webhookLastRowId ?? 0
    const items: SourceItem[] = []

    while (true) {
      const rows = this.queryMessagesAfter(lastRowId, this.webhookBatchSize)
      if (rows.length === 0) break

      for (const row of rows) {
        const sourceItem = this.rowToSourceItem(row)
        if (sourceItem) {
          items.push(sourceItem)
        }
      }

      lastRowId = rows[rows.length - 1]?.id ?? lastRowId

      if (rows.length < this.webhookBatchSize) {
        break
      }
    }

    this.webhookLastRowId = lastRowId
    return items
  }

  async subscribe(
    _ctx: ConnectorContext,
    callbackUrl: string,
    _options?: WebhookSubscribeOptions
  ): Promise<WebhookSubscription> {
    const subscriptionId = `novadb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    if (!existsSync(this.databasePath)) {
      throw new Error(`GraphD database not found at ${this.databasePath}`)
    }
    const dbBasename = basename(this.databasePath)
    const directory = dirname(this.databasePath)
    const watchTargets = [
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`,
    ].filter((path) => existsSync(path))

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const notify = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
      debounceTimer = setTimeout(async () => {
        try {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-webhook-event': 'graphd:changed',
              'x-webhook-delivery': subscriptionId,
            },
            body: JSON.stringify({
              event: 'graphd:changed',
              timestamp: new Date().toISOString(),
            }),
          })
        } catch {
          // Ignore webhook delivery errors (will retry on next DB change)
        }
      }, this.webhookDebounceMs)
    }

    const watchers = watchTargets.map((path) => watch(path, notify))
    if (existsSync(directory)) {
      const dirWatcher = watch(directory, (_event, filename) => {
        if (!filename) return
        const name = filename.toString()
        if (
          name === dbBasename ||
          name === `${dbBasename}-wal` ||
          name === `${dbBasename}-shm`
        ) {
          notify()
        }
      })
      watchers.push(dirWatcher)
    }
    const close = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      for (const watcher of watchers) {
        watcher.close()
      }
      this.webhookSubscriptions.delete(subscriptionId)
    }

    this.webhookSubscriptions.set(subscriptionId, close)

    return {
      subscriptionId,
      resourceUri: `file://${this.databasePath}`,
    }
  }

  async unsubscribe(_ctx: ConnectorContext, subscriptionId: string): Promise<void> {
    const close = this.webhookSubscriptions.get(subscriptionId)
    if (close) {
      close()
    }
  }

  // ============ Schema Methods (deprecated - will be removed with Transformation Layer) ============

  getSourceSchema(entityType: string): z.ZodSchema | undefined {
    if (entityType === 'session_message') {
      return NovaSessionMessageSchema
    }
    return undefined
  }

  /**
   * Register Nova session transformations with a registry.
   */
  registerTransforms(registry: TransformationRegistry): void {
    for (const transform of novaTransforms) {
      registry.register(transform as any)
    }
  }
}

// ============ Factory ============

export function createNovaSessionConnector(
  config: NovaSessionConnectorConfig
): NovaSessionConnector {
  return new NovaSessionConnector(config)
}
