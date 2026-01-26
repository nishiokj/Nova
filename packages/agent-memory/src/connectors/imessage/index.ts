/**
 * iMessage Connector
 *
 * Connector for reading iMessage data from macOS chat.db SQLite database.
 * Requires Full Disk Access permission to read ~/Library/Messages/chat.db
 *
 * @module connectors/imessage
 */

import { Database } from 'bun:sqlite'
import { join } from 'path'
import { homedir } from 'os'
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
  EnrichedMessageSchema,
  type EnrichedMessage,
  IMessageSourceSchema,
  macosTimestampToISOString,
  MACOS_EPOCH_OFFSET,
} from './schemas.js'
import { imessageTransforms } from './transforms.js'
import type { Transformation } from '../../transform/types.js'

// Re-export schemas
export {
  HandleRowSchema,
  ChatRowSchema,
  MessageRowSchema,
  AttachmentRowSchema,
  EnrichedMessageSchema,
  EnrichedChatSchema,
  IMessageSourceSchema,
  IChatSourceSchema,
  macosTimestampToDate,
  macosTimestampToISOString,
  MACOS_EPOCH_OFFSET,
  type HandleRow,
  type ChatRow,
  type MessageRow,
  type AttachmentRow,
  type EnrichedMessage,
  type EnrichedChat,
  type IMessageSource,
  type IChatSource,
} from './schemas.js'

// Re-export transforms
export {
  imessageMessageTransform,
  imessageChatTransform,
  imessageTransforms,
} from './transforms.js'

// ============ Configuration ============

export interface IMessageConnectorConfig {
  /** Path to chat.db (default: ~/Library/Messages/chat.db) */
  databasePath?: string
  /** Maximum messages to fetch per page (default: 100) */
  pageSize?: number
  /** Sync attachments metadata (default: true) */
  syncAttachments?: boolean
  /** Only sync messages from specific chat identifiers */
  chatFilter?: string[]
  /** Only sync iMessage or SMS (default: both) */
  serviceFilter?: ('iMessage' | 'SMS')[]
}

const DEFAULT_CHAT_DB_PATH = join(homedir(), 'Library', 'Messages', 'chat.db')

// ============ Cursor Types ============

interface BackfillCursor {
  lastRowId: number
  lastDate: number
}

interface IncrementalCursor {
  sinceRowId: number
  sinceDate: number
}

// ============ iMessage Connector ============

export class IMessageConnector implements Connector {
  readonly type: ConnectorType = 'imessage'
  readonly displayName = 'iMessage'

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: false,
    supportsWrite: false,
    supportedEntityTypes: ['message', 'chat'],
  }

  readonly authConfig: LocalAuthConfig = {
    type: 'local',
    dataPath: DEFAULT_CHAT_DB_PATH,
    requiresSystemAccess: true, // Needs Full Disk Access
  }

  private readonly databasePath: string
  private readonly pageSize: number
  private readonly syncAttachments: boolean
  private readonly chatFilter?: string[]
  private readonly serviceFilter?: string[]
  private db: Database | null = null

  constructor(config: IMessageConnectorConfig = {}) {
    this.databasePath = config.databasePath ?? DEFAULT_CHAT_DB_PATH
    this.pageSize = config.pageSize ?? 100
    this.syncAttachments = config.syncAttachments ?? true
    this.chatFilter = config.chatFilter
    this.serviceFilter = config.serviceFilter
  }

  // ============ Database Access ============

  private getDatabase(): Database {
    if (this.db) return this.db

    if (!existsSync(this.databasePath)) {
      throw new Error(
        `iMessage database not found at ${this.databasePath}. ` +
        'Ensure the path is correct and you have Full Disk Access enabled.'
      )
    }

    try {
      // Open as read-only since we only need to read messages
      this.db = new Database(this.databasePath, { readonly: true })
      return this.db
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to open iMessage database: ${msg}. ` +
        'You may need to grant Full Disk Access to your terminal.'
      )
    }
  }

  private closeDatabase(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  // ============ Account Discovery ============

  async listAccounts(_ctx: ConnectorContext): Promise<AccountInfo[]> {
    const username = process.env.USER ?? process.env.USERNAME ?? 'local'

    // Try to get the user's phone number/email from the database
    let primaryId = 'local-user'
    try {
      const db = this.getDatabase()
      // Get the most common "from me" handle to identify the user
      const result = db.query<{ id: string }, []>(`
        SELECT h.id
        FROM handle h
        JOIN message m ON m.handle_id = h.ROWID
        WHERE m.is_from_me = 1
        GROUP BY h.id
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `).get()

      if (result?.id) {
        primaryId = result.id
      }
    } catch {
      // Ignore - use default
    }

    return [{
      externalId: 'local',
      displayName: `iMessage (${username})`,
      username,
      isPrimary: true,
      metadata: {
        databasePath: this.databasePath,
        primaryId,
      },
    }]
  }

  // ============ Estimate Methods ============

  async estimateScope(
    _ctx: ConnectorContext,
    syncType: 'backfill' | 'incremental',
    entityTypes?: string[]
  ): Promise<SyncEstimate> {
    const types = entityTypes ?? this.capabilities.supportedEntityTypes

    try {
      const db = this.getDatabase()

      const entities = types.map((type) => {
        if (type === 'message') {
          const result = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM message').get()
          const count = result?.count ?? 0
          return { type, count, description: `~${count.toLocaleString()} messages` }
        }
        if (type === 'chat') {
          const result = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM chat').get()
          const count = result?.count ?? 0
          return { type, count, description: `~${count.toLocaleString()} chats` }
        }
        return { type, description: `${type} (count unavailable)` }
      })

      const parts = entities.filter((e) => e.count != null).map((e) => e.description)
      const label = syncType === 'backfill' ? 'Full backfill' : 'Incremental sync'

      return {
        entities,
        summary: parts.length > 0 ? `${label}: ${parts.join(', ')}` : label,
      }
    } catch {
      return {
        entities: types.map((type) => ({ type, description: `${type} (unable to access database)` })),
      }
    }
  }

  // ============ Sync Methods ============

  async fetchPage(
    _ctx: ConnectorContext,
    options: FetchPageOptions
  ): Promise<FetchPageResult> {
    const db = this.getDatabase()
    const items: SourceItem[] = []

    // Parse cursor
    let cursor: BackfillCursor = { lastRowId: 0, lastDate: 0 }
    if (options.cursor) {
      try {
        cursor = JSON.parse(options.cursor) as BackfillCursor
      } catch {
        // Invalid cursor, start fresh
      }
    }

    const limit = options.limit ?? this.pageSize

    // Build the query with filters
    const whereConditions: string[] = ['m.ROWID > ?']
    const params: (string | number)[] = [cursor.lastRowId]

    if (this.serviceFilter?.length) {
      whereConditions.push(`m.service IN (${this.serviceFilter.map(() => '?').join(', ')})`)
      params.push(...this.serviceFilter)
    }

    if (this.chatFilter?.length) {
      whereConditions.push(`c.chat_identifier IN (${this.chatFilter.map(() => '?').join(', ')})`)
      params.push(...this.chatFilter)
    }

    // Filter by entity types if specified
    const entityTypes = options.entityTypes ?? ['message']
    if (!entityTypes.includes('message')) {
      return { items: [], hasMore: false }
    }

    const query = `
      SELECT
        m.ROWID as message_rowid,
        m.guid,
        m.text,
        m.date,
        m.date_read,
        m.is_from_me,
        m.is_read,
        m.is_audio_message,
        m.cache_has_attachments,
        m.associated_message_guid,
        m.associated_message_type,
        m.expressive_send_style_id,
        m.reply_to_guid,
        m.thread_originator_guid,
        m.service,
        c.ROWID as chat_rowid,
        c.guid as chat_guid,
        c.chat_identifier,
        c.display_name,
        h.id as handle_id,
        h.service as handle_service
      FROM message m
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY m.ROWID ASC
      LIMIT ?
    `

    params.push(limit + 1) // Fetch one extra to check hasMore

    const rows = db.query(query).all(...params) as unknown[]

    // Check if there are more rows
    const hasMore = rows.length > limit
    const rowsToProcess = hasMore ? rows.slice(0, limit) : rows

    let lastRowId = cursor.lastRowId
    let lastDate = cursor.lastDate

    for (const row of rowsToProcess) {
      const parsed = EnrichedMessageSchema.safeParse(row)
      if (!parsed.success) {
        continue
      }

      const msg = parsed.data
      lastRowId = msg.message_rowid
      lastDate = msg.date

      const sourceItem = this.messageToSourceItem(msg)
      if (sourceItem) {
        items.push(sourceItem)
      }
    }

    const nextCursor = hasMore
      ? JSON.stringify({ lastRowId, lastDate })
      : undefined

    return { items, hasMore, nextCursor }
  }

  async fetchChanges(
    _ctx: ConnectorContext,
    options: FetchChangesOptions
  ): Promise<FetchPageResult> {
    const db = this.getDatabase()
    const items: SourceItem[] = []

    // Parse cursor or use 'since' timestamp
    let cursor: IncrementalCursor
    if (options.cursor) {
      try {
        cursor = JSON.parse(options.cursor) as IncrementalCursor
      } catch {
        // Use 'since' as fallback
        const sinceDate = options.since
          ? new Date(options.since)
          : new Date(Date.now() - 24 * 60 * 60 * 1000) // Default: last 24 hours
        cursor = {
          sinceRowId: 0,
          sinceDate: this.dateToMacosTimestamp(sinceDate),
        }
      }
    } else {
      const sinceDate = options.since
        ? new Date(options.since)
        : new Date(Date.now() - 24 * 60 * 60 * 1000)
      cursor = {
        sinceRowId: 0,
        sinceDate: this.dateToMacosTimestamp(sinceDate),
      }
    }

    const limit = options.limit ?? this.pageSize

    // Build query - fetch messages newer than cursor
    const whereConditions: string[] = [
      '(m.date > ? OR (m.date = ? AND m.ROWID > ?))'
    ]
    const params: (string | number)[] = [cursor.sinceDate, cursor.sinceDate, cursor.sinceRowId]

    if (this.serviceFilter?.length) {
      whereConditions.push(`m.service IN (${this.serviceFilter.map(() => '?').join(', ')})`)
      params.push(...this.serviceFilter)
    }

    if (this.chatFilter?.length) {
      whereConditions.push(`c.chat_identifier IN (${this.chatFilter.map(() => '?').join(', ')})`)
      params.push(...this.chatFilter)
    }

    const query = `
      SELECT
        m.ROWID as message_rowid,
        m.guid,
        m.text,
        m.date,
        m.date_read,
        m.is_from_me,
        m.is_read,
        m.is_audio_message,
        m.cache_has_attachments,
        m.associated_message_guid,
        m.associated_message_type,
        m.expressive_send_style_id,
        m.reply_to_guid,
        m.thread_originator_guid,
        m.service,
        c.ROWID as chat_rowid,
        c.guid as chat_guid,
        c.chat_identifier,
        c.display_name,
        h.id as handle_id,
        h.service as handle_service
      FROM message m
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY m.date ASC, m.ROWID ASC
      LIMIT ?
    `

    params.push(limit + 1)

    const rows = db.query(query).all(...params) as unknown[]

    const hasMore = rows.length > limit
    const rowsToProcess = hasMore ? rows.slice(0, limit) : rows

    let lastRowId = cursor.sinceRowId
    let lastDate = cursor.sinceDate

    for (const row of rowsToProcess) {
      const parsed = EnrichedMessageSchema.safeParse(row)
      if (!parsed.success) {
        continue
      }

      const msg = parsed.data
      lastRowId = msg.message_rowid
      lastDate = msg.date

      const sourceItem = this.messageToSourceItem(msg)
      if (sourceItem) {
        items.push(sourceItem)
      }
    }

    const nextCursor = hasMore
      ? JSON.stringify({ sinceRowId: lastRowId, sinceDate: lastDate })
      : undefined

    return { items, hasMore, nextCursor }
  }

  // ============ Helpers ============

  private messageToSourceItem(msg: EnrichedMessage): SourceItem | null {
    // Skip empty messages (system messages, etc.)
    if (!msg.text && !msg.cache_has_attachments && !msg.associated_message_guid) {
      return null
    }

    const timestamp = macosTimestampToISOString(msg.date)

    // Determine the sender ID
    const senderId = msg.is_from_me
      ? 'me'
      : (msg.handle_id ?? 'unknown')

    const sourceData = {
      guid: msg.guid,
      text: msg.text,
      timestamp,
      is_from_me: msg.is_from_me === 1,
      is_read: msg.is_read === 1,
      service: msg.service ?? 'iMessage',
      chat: {
        guid: msg.chat_guid,
        identifier: msg.chat_identifier,
        display_name: msg.display_name,
      },
      sender: {
        id: senderId,
        is_me: msg.is_from_me === 1,
      },
      is_audio_message: msg.is_audio_message === 1,
      has_attachments: msg.cache_has_attachments === 1,
      reaction_to: msg.associated_message_type > 0 ? msg.associated_message_guid : null,
      reply_to: msg.reply_to_guid,
      send_effect: msg.expressive_send_style_id,
    }

    // Validate the output
    const validated = IMessageSourceSchema.safeParse(sourceData)
    if (!validated.success) {
      return null
    }

    return {
      source_id: msg.guid,
      entity_type: 'message',
      raw_data: validated.data,
      source_timestamp: timestamp,
    }
  }

  private dateToMacosTimestamp(date: Date): number {
    const unixSeconds = date.getTime() / 1000
    // Return in nanoseconds (multiply by 1e9)
    return (unixSeconds - MACOS_EPOCH_OFFSET) * 1e9
  }

  // ============ Schema Methods ============

  getSourceSchema(entityType: string): z.ZodSchema | undefined {
    if (entityType === 'message') {
      return IMessageSourceSchema
    }
    return undefined
  }

  // ============ Transform Registration ============

  /**
   * Register iMessage transformations with a registry.
   * Called during daemon/engine setup to enable processing.
   */
  registerTransforms(registry: { register<T>(t: Transformation<T>): void }): void {
    for (const transform of imessageTransforms) {
      registry.register(transform)
    }
  }

  // ============ Cleanup ============

  /**
   * Close the database connection.
   * Call this when done with the connector.
   */
  close(): void {
    this.closeDatabase()
  }
}

// ============ Factory ============

export function createIMessageConnector(
  config?: IMessageConnectorConfig
): IMessageConnector {
  return new IMessageConnector(config)
}
