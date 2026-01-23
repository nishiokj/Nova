/**
 * Gmail Connector
 *
 * Connector for Gmail API v1.
 * Supports backfill, incremental sync via history API, and Pub/Sub push webhooks.
 *
 * @module connectors/gmail
 */

import { z } from 'zod'
import {
  BaseConnector,
  type BaseConnectorOptions,
  type ConnectorCapabilities,
  type OAuth2Config,
  type AccountInfo,
  type WebhookEvent,
  type ConnectorContext,
} from '../../connector/sdk/index.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
  RateLimitInfo,
} from '../../sync/types.js'
import {
  GmailMessageSchema,
  GmailMessageListSchema,
  GmailHistoryResponseSchema,
  GmailThreadSchema,
  GmailThreadListSchema,
  GmailProfileSchema,
  GmailNotificationSchema,
  PubSubPushEnvelopeSchema,
  type GmailMessage,
  type GmailHistoryResponse,
  type GmailThread,
  type GmailMessageList,
  type GmailThreadList,
  type GmailProfile,
  type GmailNotification,
  type PubSubPushEnvelope,
} from './schemas.js'
import { gmailMappers, getGmailMapper, getGmailEntityTypes } from './mappers.js'

// ============ Constants ============

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'
const GMAIL_OAUTH_BASE = 'https://oauth2.googleapis.com'

/**
 * Configuration for Gmail connector.
 */
export interface GmailConnectorConfig {
  /** OAuth client ID from GCP Console */
  clientId: string
  /** OAuth client secret from GCP Console */
  clientSecret: string
  /** Rate limit for API requests (per second) */
  rateLimit?: number
  /** Specific labels to sync (empty = all) */
  labels?: string[]
  /** Labels to exclude from sync */
  excludeLabels?: string[]
}

// ============ Gmail Connector ============

/**
 * Gmail connector implementation.
 *
 * Supports:
 * - OAuth2 authentication
 * - Backfill of email messages
 * - Incremental sync via Gmail History API
 * - Pub/Sub push webhooks
 * - Rate limit handling (100 queries per 100 seconds per user)
 */
export class GmailConnector extends BaseConnector {
  readonly type = 'gmail' as const
  readonly displayName = 'Gmail'

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: true,
    supportsWrite: false, // MVP is read-only
    supportedEntityTypes: getGmailEntityTypes(),
  }

  readonly authConfig: OAuth2Config

  private readonly apiBaseUrl: string
  private readonly oauthBaseUrl: string
  private readonly labels: string[]
  private readonly excludeLabels: string[]

  constructor(config: GmailConnectorConfig, options?: BaseConnectorOptions) {
    super(options)

    this.apiBaseUrl = GMAIL_API_BASE
    this.oauthBaseUrl = GMAIL_OAUTH_BASE
    this.labels = config.labels ?? []
    this.excludeLabels = config.excludeLabels ?? ['SPAM', 'TRASH']

    // Configure rate limiting (Gmail limit: 100 queries per 100 seconds)
    // Rate limit is handled by the TokenBucket in the HTTP client constructor

    this.authConfig = {
      type: 'oauth2',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.metadata',
      ],
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    }

    // Register mappers
    for (const [entityType, mapper] of Object.entries(gmailMappers)) {
      this.registerMapper(mapper)
    }

    // Register schemas
    this.registerSchema('message', GmailMessageSchema)
    this.registerSchema('thread', GmailThreadSchema)
    this.registerSchema('history', GmailHistoryResponseSchema)
  }

  // ============ Account Discovery ============

  /**
   * List Gmail accounts (returns the authenticated user).
   */
  async listAccounts(ctx: ConnectorContext): Promise<AccountInfo[]> {
    // Gmail uses OAuth2 userinfo endpoint for profile
    const response = await this.authenticatedRequest<GmailProfile>(
      ctx,
      `${this.apiBaseUrl}/users/me/profile`
    )

    if (!response.ok) {
      throw new Error(`Failed to get user profile: ${response.status}`)
    }

    const parsed = GmailProfileSchema.safeParse(response.data)
    if (!parsed.success) {
      throw new Error(`Invalid user profile response: ${parsed.error.message}`)
    }

    const user = parsed.data
    return [{
      externalId: user.emailAddress, // Gmail uses email as identifier
      displayName: user.emailAddress.split('@')[0], // Use local part as display name
      email: user.emailAddress,
      avatarUrl: undefined,
      username: user.emailAddress,
      isPrimary: true,
      metadata: {
        email: user.emailAddress,
        messages_total: user.messagesTotal,
        threads_total: user.threadsTotal,
        history_id: user.historyId,
      },
    }]
  }

  // ============ Sync Methods ============

  /**
   * Fetch a page of Gmail data for backfill.
   *
   * Gmail uses a two-step fetch:
   * 1. List messages returns only IDs
   * 2. Fetch full message for each ID
   */
  async fetchPage(
    ctx: ConnectorContext,
    options: FetchPageOptions
  ): Promise<FetchPageResult> {
    const entityTypes = options.entityTypes ?? ['message']
    const items: SourceItem[] = []

    // Parse cursor
    let cursorState: CursorState = {
      pageToken: '',
      entityTypeIndex: 0,
      fetchedIds: [],
    }
    if (options.cursor) {
      try {
        cursorState = JSON.parse(options.cursor) as CursorState
      } catch {
        // Invalid cursor, start fresh
      }
    }

    const currentEntityType = entityTypes[cursorState.entityTypeIndex]
    if (!currentEntityType) {
      return { items: [], hasMore: false }
    }

    let result: PageFetchResult
    switch (currentEntityType) {
      case 'message':
        result = await this.fetchMessages(ctx, cursorState.pageToken, options.limit)
        break
      case 'thread':
        result = await this.fetchThreads(ctx, cursorState.pageToken, options.limit)
        break
      default:
        result = { items: [], hasMore: false }
    }

    items.push(...result.items)

    // Determine next cursor
    let hasMore = false
    let nextCursor: string | undefined

    if (result.hasMore) {
      // More pages of current entity type
      hasMore = true
      nextCursor = JSON.stringify({
        pageToken: result.nextPageToken,
        entityTypeIndex: cursorState.entityTypeIndex,
        fetchedIds: [],
      })
    } else if (cursorState.entityTypeIndex < entityTypes.length - 1) {
      // Move to next entity type
      hasMore = true
      nextCursor = JSON.stringify({
        pageToken: '',
        entityTypeIndex: cursorState.entityTypeIndex + 1,
        fetchedIds: [],
      })
    }

    return {
      items,
      hasMore,
      nextCursor,
      rateLimit: result.rateLimit,
    }
  }

  /**
   * Fetch changes since last sync using Gmail History API.
   *
   * Gmail uses historyId (not timestamp) for incremental sync.
   */
  async fetchChanges(
    ctx: ConnectorContext,
    options: FetchChangesOptions
  ): Promise<FetchPageResult> {
    const entityTypes = options.entityTypes ?? ['message']
    const items: SourceItem[] = []

    // Parse cursor
    let cursorState: HistoryCursorState = {
      historyId: options.since ?? '1', // Default to start from beginning
      entityTypeIndex: 0,
    }
    if (options.cursor) {
      try {
        cursorState = JSON.parse(options.cursor) as HistoryCursorState
      } catch {
        // Invalid cursor, use defaults
      }
    }

    const currentEntityType = entityTypes[cursorState.entityTypeIndex]
    if (!currentEntityType) {
      return { items: [], hasMore: false }
    }

    let result: PageFetchResult
    switch (currentEntityType) {
      case 'message':
        result = await this.fetchMessageChanges(ctx, cursorState.historyId, options.limit)
        break
      case 'thread':
        result = await this.fetchThreadChanges(ctx, cursorState.historyId, options.limit)
        break
      default:
        result = { items: [], hasMore: false }
    }

    items.push(...result.items)

    // Determine next cursor
    let hasMore = false
    let nextCursor: string | undefined

    if (result.hasMore) {
      hasMore = true
      nextCursor = JSON.stringify({
        historyId: result.nextHistoryId ?? cursorState.historyId,
        entityTypeIndex: cursorState.entityTypeIndex,
      })
    } else if (cursorState.entityTypeIndex < entityTypes.length - 1) {
      hasMore = true
      nextCursor = JSON.stringify({
        historyId: cursorState.historyId,
        entityTypeIndex: cursorState.entityTypeIndex + 1,
      })
    }

    return {
      items,
      hasMore,
      nextCursor,
      rateLimit: result.rateLimit,
    }
  }

  // ============ Webhook Methods ============

  /**
   * Parse Gmail Pub/Sub push webhook payload.
   *
   * Gmail Pub/Sub push uses JWT auth (not HMAC like GitHub).
   * This method extracts the envelope and fetches actual changes via History API.
   */
  async parseWebhookPayload(event: WebhookEvent): Promise<SourceItem[]> {
    const items: SourceItem[] = []

    try {
      // Parse Pub/Sub push envelope
      const envelope = PubSubPushEnvelopeSchema.safeParse(event.payload)
      if (!envelope.success) {
        return items
      }

      const push = envelope.data

      // Extract base64-decoded message data
      const decodedData = Buffer.from(push.message.data, 'base64').toString('utf-8')
      const webhookPayload = GmailWebhookPayloadSchema.parse(JSON.parse(decodedData))

      // In production, you would fetch the actual changes via History API here
      // using the stored credentials for webhookPayload.emailAddress
      // For MVP, we return the webhook payload as a tombstone SourceItem
      // indicating that changes occurred

      return [{
        source_id: `webhook-${webhookPayload.historyId}`,
        entity_type: 'message',
        raw_data: { webhook: true, historyId: webhookPayload.historyId },
        source_timestamp: new Date().toISOString(),
      }]

    } catch (error) {
      // Silently fail on webhook parse errors
      return items
    }
  }

  // ============ Private Fetch Methods ============

  /**
   * Build Gmail search query from labels configuration.
   */
  private buildSearchQuery(): string {
    const queryParts: string[] = []

    // Add labels to include
    if (this.labels.length > 0) {
      const labelQuery = this.labels.map(l => `label:${l}`).join(' OR ')
      queryParts.push(`(${labelQuery})`)
    }

    // Add labels to exclude
    for (const label of this.excludeLabels) {
      queryParts.push(`-label:${label}`)
    }

    return queryParts.join(' ')
  }

  /**
   * Fetch messages for backfill.
   */
  private async fetchMessages(
    ctx: ConnectorContext,
    pageToken: string,
    limit?: number
  ): Promise<PageFetchResult> {
    const params: Record<string, string | number> = {
      userId: 'me',
      maxResults: limit ?? 50,
    }

    if (pageToken) {
      params.pageToken = pageToken
    }

    const query = this.buildSearchQuery()
    if (query) {
      params.q = query
    }

    const response = await this.authenticatedRequest<GmailMessageList>(
      ctx,
      `${this.apiBaseUrl}/users/me/messages`,
      { params }
    )

    if (!response.ok) {
      return { items: [], hasMore: false }
    }

    const parsed = GmailMessageListSchema.safeParse(response.data)
    if (!parsed.success) {
      return { items: [], hasMore: false }
    }

    const messageList = parsed.data
    const items: SourceItem[] = []

    // Gmail list endpoint only returns IDs - fetch full messages
    for (const messageRef of messageList.messages ?? []) {
      try {
        const messageResponse = await this.authenticatedRequest<GmailMessage>(
          ctx,
          `${this.apiBaseUrl}/users/me/messages/${messageRef.id}`,
          { params: { userId: 'me' } }
        )

        if (messageResponse.ok) {
          const messageParsed = GmailMessageSchema.safeParse(messageResponse.data)
          if (messageParsed.success) {
            const message = messageParsed.data
            items.push({
              source_id: message.id,
              entity_type: 'message',
              raw_data: message,
              source_timestamp: new Date(parseInt(message.internalDate)).toISOString(),
              source_version: message.historyId,
            })
          }
        }
      } catch (error) {
        // Continue on individual message fetch errors
        continue
      }
    }

    return {
      items,
      hasMore: !!messageList.nextPageToken,
      nextPageToken: messageList.nextPageToken ?? '',
      rateLimit: this.parseRateLimitHeaders(response.headers),
    }
  }

  /**
   * Fetch threads for backfill.
   */
  private async fetchThreads(
    ctx: ConnectorContext,
    pageToken: string,
    limit?: number
  ): Promise<PageFetchResult> {
    const params: Record<string, string | number> = {
      userId: 'me',
      maxResults: limit ?? 50,
    }

    if (pageToken) {
      params.pageToken = pageToken
    }

    const response = await this.authenticatedRequest<GmailThreadList>(
      ctx,
      `${this.apiBaseUrl}/users/me/threads`,
      { params }
    )

    if (!response.ok) {
      return { items: [], hasMore: false }
    }

    const threadList = GmailThreadListSchema.parse(response.data ?? {})
    const items: SourceItem[] = []

    for (const threadRef of threadList.threads ?? []) {
      try {
        const threadResponse = await this.authenticatedRequest<GmailThread>(
          ctx,
          `${this.apiBaseUrl}/users/me/threads/${threadRef.id}`,
          { params: { userId: 'me' } }
        )

        if (threadResponse.ok) {
          const threadParsed = GmailThreadSchema.safeParse(threadResponse.data)
          if (threadParsed.success) {
            const thread = threadParsed.data
            items.push({
              source_id: thread.id,
              entity_type: 'thread',
              raw_data: thread,
              source_timestamp: new Date().toISOString(),
              source_version: thread.historyId,
            })
          }
        }
      } catch (error) {
        continue
      }
    }

    return {
      items,
      hasMore: !!threadList.nextPageToken,
      nextPageToken: threadList.nextPageToken ?? '',
      rateLimit: this.parseRateLimitHeaders(response.headers),
    }
  }

  /**
   * Fetch message changes via History API.
   */
  private async fetchMessageChanges(
    ctx: ConnectorContext,
    startHistoryId: string,
    limit?: number
  ): Promise<PageFetchResult> {
    const params: Record<string, string | number> = {
      userId: 'me',
      startHistoryId,
      historyTypes: 'messageAdded,messageDeleted',
    }

    if (limit) {
      params.maxResults = limit
    }

    const response = await this.authenticatedRequest<GmailHistoryResponse>(
      ctx,
      `${this.apiBaseUrl}/users/me/history`,
      { params }
    )

    if (!response.ok) {
      return { items: [], hasMore: false }
    }

    const parsed = GmailHistoryResponseSchema.safeParse(response.data)
    if (!parsed.success) {
      return { items: [], hasMore: false }
    }

    const historyResponse = parsed.data
    const items: SourceItem[] = []

    // Process history records
    for (const record of historyResponse.history ?? []) {
      // Process added messages
      for (const added of record.messagesAdded ?? []) {
        try {
          const messageResponse = await this.authenticatedRequest<GmailMessage>(
            ctx,
            `${this.apiBaseUrl}/users/me/messages/${added.message.id}`,
            { params: { userId: 'me' } }
          )

          if (messageResponse.ok) {
            const messageParsed = GmailMessageSchema.safeParse(messageResponse.data)
            if (messageParsed.success) {
              const message = messageParsed.data
              items.push({
                source_id: message.id,
                entity_type: 'message',
                raw_data: message,
                source_timestamp: new Date(parseInt(message.internalDate)).toISOString(),
                source_version: message.historyId,
              })
            }
          }
        } catch (error) {
          continue
        }
      }

      // Process deleted messages (create tombstone items)
      for (const deleted of record.messagesDeleted ?? []) {
        items.push({
          source_id: deleted.message.id,
          entity_type: 'message',
          raw_data: { deleted: true, id: deleted.message.id },
          source_timestamp: new Date().toISOString(),
        })
      }
    }

    return {
      items,
      hasMore: false, // History API returns all changes at once
      nextHistoryId: historyResponse.historyId,
      rateLimit: this.parseRateLimitHeaders(response.headers),
    }
  }

  /**
   * Fetch thread changes via History API.
   */
  private async fetchThreadChanges(
    ctx: ConnectorContext,
    startHistoryId: string,
    limit?: number
  ): Promise<PageFetchResult> {
    // Thread changes are less common, usually handled via message changes
    // For now, return empty as threads are derived from messages
    return {
      items: [],
      hasMore: false,
      nextHistoryId: startHistoryId,
    }
  }

  // ============ Utility Methods ============

  private parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
    // Gmail uses X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
    // These may not always be present
    const limit = headers.get('X-RateLimit-Limit') ?? headers.get('x-ratelimit-limit')
    const remaining = headers.get('X-RateLimit-Remaining') ?? headers.get('x-ratelimit-remaining')
    const reset = headers.get('X-RateLimit-Reset') ?? headers.get('x-ratelimit-reset')

    if (!limit || !remaining) {
      return undefined
    }

    return {
      limit: parseInt(limit, 10),
      remaining: parseInt(remaining, 10),
      resetsAt: reset ? parseInt(reset, 10) : 0,
    }
  }
}

// ============ Types ============

interface CursorState {
  pageToken: string
  entityTypeIndex: number
  fetchedIds: string[]
}

interface HistoryCursorState {
  historyId: string
  entityTypeIndex: number
}

interface PageFetchResult {
  items: SourceItem[]
  hasMore: boolean
  nextPageToken?: string
  nextHistoryId?: string
  rateLimit?: RateLimitInfo
}

// ============ Factory ============

/**
 * Create a Gmail connector instance.
 */
export function createGmailConnector(
  config: GmailConnectorConfig,
  options?: BaseConnectorOptions
): GmailConnector {
  return new GmailConnector(config, options)
}

// Re-export schemas and mappers
export * from './schemas.js'
export { gmailMappers, getGmailMapper, getGmailEntityTypes } from './mappers.js'
