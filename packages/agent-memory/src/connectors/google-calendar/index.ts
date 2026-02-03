/**
 * Google Calendar Connector
 *
 * Connector for Google Calendar API v3.
 * Supports backfill, incremental sync via sync tokens, and webhook notifications.
 *
 * @module connectors/google-calendar
 */

import { z } from 'zod'
import {
  BaseConnector,
  type BaseConnectorOptions,
  type ConnectorCapabilities,
  type OAuthProviderRefConfig,
  type AccountInfo,
  type WebhookEvent,
  type ConnectorContext,
  type SyncEstimate,
} from '../../connector/sdk/index.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
  RateLimitInfo,
} from '../../sync/types.js'
import {
  GoogleCalendarEventSchema,
  GoogleCalendarEventListSchema,
  GoogleCalendarListSchema,
  GoogleCalendarNotificationSchema,
  type GoogleCalendarEvent,
  type GoogleCalendarEventList,
  type GoogleCalendarList,
  type GoogleCalendarNotification,
} from './schemas.js'
import { googleCalendarTransforms } from './transforms.js'
import type { TransformationRegistry } from '../../transform/registry.js'
import { SyncError, ErrorCode } from '../../errors/index.js'

// ============ Constants ============

const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'
const GOOGLE_OAUTH_BASE = 'https://oauth2.googleapis.com'

/**
 * Configuration for Google Calendar connector.
 */
export interface GoogleCalendarConnectorConfig {
  /** Rate limit for API requests (per second) */
  rateLimit?: number
  /** Specific calendar IDs to sync (empty = primary calendar only) */
  calendarIds?: string[]
  /** Minimum time range for events (RFC3339 timestamp) */
  minTime?: string
  /** Maximum time range for events (RFC3339 timestamp) */
  maxTime?: string
  /** Include canceled events in sync */
  includeCanceled?: boolean
}

// ============ Google Calendar Connector ============

/**
 * Google Calendar connector implementation.
 *
 * Supports:
 * - OAuth2 authentication
 * - Backfill of calendar events
 * - Incremental sync via sync tokens
 * - Webhook notifications via Google Calendar API push
 * - Rate limit handling
 */
export class GoogleCalendarConnector extends BaseConnector {
  readonly type = 'google-calendar' as const
  readonly displayName = 'Google Calendar'

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: true,
    supportsWrite: true,
    supportedEntityTypes: ['event'],
  }

  readonly authConfig: OAuthProviderRefConfig = {
    type: 'oauth2_provider',
    provider: 'google',
    scopes: [
      'https://www.googleapis.com/auth/calendar',
    ],
  }

  private readonly apiBaseUrl: string
  private readonly calendarIds: string[]
  private readonly minTime?: string
  private readonly maxTime?: string
  private readonly includeCanceled: boolean

  constructor(config: GoogleCalendarConnectorConfig = {}, options?: BaseConnectorOptions) {
    super(options)

    this.apiBaseUrl = GOOGLE_CALENDAR_API_BASE
    this.calendarIds = config.calendarIds ?? ['primary']
    this.minTime = config.minTime
    this.maxTime = config.maxTime
    this.includeCanceled = config.includeCanceled ?? false

    // Register schemas
    this.registerSchema('event', GoogleCalendarEventSchema)
  }

  // ============ Account Discovery ============

  /**
   * List Google Calendar accounts (returns the authenticated user).
   * Uses the Calendar API's own calendarList endpoint instead of userinfo,
   * so we don't need openid/profile/email scopes.
   */
  async listAccounts(ctx: ConnectorContext): Promise<AccountInfo[]> {
    const response = await this.authenticatedRequest<GoogleCalendarList>(
      ctx,
      `${this.apiBaseUrl}/users/me/calendarList`
    )

    if (!response.ok) {
      console.error('[GoogleCalendarConnector] CalendarList request failed:', response.status, response.data)
      throw new Error(`Failed to get calendar list: ${response.status}`)
    }

    const parsed = GoogleCalendarListSchema.safeParse(response.data)
    if (!parsed.success) {
      throw new Error(`Failed to parse calendar list: ${parsed.error.message}`)
    }

    const primary = parsed.data.items.find(cal => cal.primary)
    if (!primary) {
      throw new Error('No primary calendar found — cannot determine account identity')
    }

    // Primary calendar id is the user's email address
    const email = primary.id
    return [{
      externalId: email,
      displayName: primary.summary || email.split('@')[0],
      email,
      username: email,
      isPrimary: true,
      metadata: {
        email,
        timezone: primary.timeZone,
        calendarCount: parsed.data.items.length,
      },
    }]
  }

  // ============ Estimate Methods ============

  /**
   * Estimate the scope of a sync operation.
   */
  async estimateScope(
    ctx: ConnectorContext,
    syncType: 'backfill' | 'incremental',
    entityTypes?: string[]
  ): Promise<SyncEstimate> {
    const types = entityTypes ?? this.capabilities.supportedEntityTypes

    // Fetch calendar list to get calendar info
    const calendarsResponse = await this.authenticatedRequest<GoogleCalendarList>(
      ctx,
      `${this.apiBaseUrl}/users/me/calendarList`
    )

    if (!calendarsResponse.ok) {
      return {
        entities: types.map((type) => ({
          type,
          description: 'Unable to estimate (calendar list fetch failed)',
        })),
      }
    }

    const calendars = GoogleCalendarListSchema.safeParse(calendarsResponse.data)
    if (!calendars.success) {
      return {
        entities: types.map((type) => ({
          type,
          description: 'Unable to estimate (calendar list parse failed)',
        })),
      }
    }

    const selectedCalendars = calendars.data.items.filter((cal) => cal.selected !== false)

    if (syncType === 'backfill') {
      const entities = types.map((type) => ({
        type,
        description: `${type} from ${selectedCalendars.length} calendar(s)`,
      }))

      return {
        entities,
        summary: `Backfill: ${selectedCalendars.length} calendar(s)`,
      }
    }

    // Incremental - count not available without fetching
    return {
      entities: types.map((type) => ({
        type,
        description: `${type} changes since last sync`,
      })),
      summary: 'Incremental sync (changes since last sync)',
    }
  }

  // ============ Sync Methods ============

  /**
   * Fetch a page of Google Calendar events for backfill.
   */
  async fetchPage(
    ctx: ConnectorContext,
    options: FetchPageOptions
  ): Promise<FetchPageResult> {
    const entityTypes = options.entityTypes ?? ['event']
    const items: SourceItem[] = []

    // Parse cursor
    let cursorState: CursorState = {
      calendarIdIndex: 0,
      pageToken: '',
      entityTypeIndex: 0,
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
      case 'event':
        result = await this.fetchEvents(ctx, cursorState, options.limit)
        break
      default:
        result = { items: [], hasMore: false }
    }

    items.push(...result.items)

    // Determine next cursor
    let hasMore = false
    let nextCursor: string | undefined

    if (result.hasMore) {
      // More pages of current calendar/entity type
      hasMore = true
      nextCursor = JSON.stringify({
        calendarIdIndex: cursorState.calendarIdIndex,
        pageToken: result.nextPageToken,
        entityTypeIndex: cursorState.entityTypeIndex,
      })
    } else if (cursorState.calendarIdIndex < this.calendarIds.length - 1) {
      // Move to next calendar
      hasMore = true
      nextCursor = JSON.stringify({
        calendarIdIndex: cursorState.calendarIdIndex + 1,
        pageToken: '',
        entityTypeIndex: cursorState.entityTypeIndex,
      })
    } else if (cursorState.entityTypeIndex < entityTypes.length - 1) {
      // Move to next entity type
      hasMore = true
      nextCursor = JSON.stringify({
        calendarIdIndex: 0,
        pageToken: '',
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

  /**
   * Fetch changes since last sync using sync tokens.
   */
  async fetchChanges(
    ctx: ConnectorContext,
    options: FetchChangesOptions
  ): Promise<FetchPageResult> {
    const entityTypes = options.entityTypes ?? ['event']
    const items: SourceItem[] = []

    // Parse cursor - may be syncToken or JSON cursor
    let cursorState: SyncCursorState = {
      syncToken: '',
      calendarIdIndex: 0,
      entityTypeIndex: 0,
    }
    if (options.cursor) {
      try {
        cursorState = JSON.parse(options.cursor) as SyncCursorState
      } catch {
        // Invalid cursor, use defaults
      }
    } else if (options.since) {
      // Try parsing as JSON cursor (stored sync_cursor from previous sync)
      try {
        const parsed = JSON.parse(options.since) as SyncCursorState
        if (parsed.syncToken) {
          cursorState = parsed
        }
      } catch {
        // Plain syncToken string
        cursorState.syncToken = options.since
      }
    }

    const currentEntityType = entityTypes[cursorState.entityTypeIndex]
    if (!currentEntityType) {
      return { items: [], hasMore: false }
    }

    let result: PageFetchResult
    switch (currentEntityType) {
      case 'event':
        result = await this.fetchEventChanges(ctx, cursorState, options.limit)
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
        syncToken: result.nextSyncToken || cursorState.syncToken,
        calendarIdIndex: cursorState.calendarIdIndex,
        entityTypeIndex: cursorState.entityTypeIndex,
      })
    } else if (cursorState.calendarIdIndex < this.calendarIds.length - 1) {
      hasMore = true
      nextCursor = JSON.stringify({
        syncToken: '',
        calendarIdIndex: cursorState.calendarIdIndex + 1,
        entityTypeIndex: cursorState.entityTypeIndex,
      })
    } else if (cursorState.entityTypeIndex < entityTypes.length - 1) {
      hasMore = true
      nextCursor = JSON.stringify({
        syncToken: '',
        calendarIdIndex: 0,
        entityTypeIndex: cursorState.entityTypeIndex + 1,
      })
    } else {
      // Sync complete - still emit cursor
      nextCursor = JSON.stringify({
        syncToken: result.nextSyncToken || cursorState.syncToken,
        calendarIdIndex: cursorState.calendarIdIndex,
        entityTypeIndex: cursorState.entityTypeIndex,
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
   * Parse Google Calendar webhook notification payload.
   */
  async parseWebhookPayload(event: WebhookEvent): Promise<SourceItem[]> {
    const items: SourceItem[] = []

    try {
      const notification = GoogleCalendarNotificationSchema.safeParse(event.payload)
      if (!notification.success) {
        return items
      }

      const payload = notification.data

      // Return a marker item indicating changes occurred
      // Actual event fetching would happen in fetchChanges
      return [{
        source_id: `webhook-${payload.resource_id}`,
        entity_type: 'event',
        raw_data: {
          webhook: true,
          resource_id: payload.resource_id,
          channel_id: payload.channel_id,
        },
        source_timestamp: new Date().toISOString(),
      }]

    } catch (error) {
      // Silently fail on webhook parse errors
      return items
    }
  }

  /**
   * Subscribe to Google Calendar webhook notifications.
   */
  async subscribe(
    ctx: ConnectorContext,
    callbackUrl: string,
    options?: { entityTypes?: string[]; options?: Record<string, unknown> }
  ): Promise<{ subscriptionId: string; expiresAt?: Date; resourceUri?: string }> {
    const calendarId = options?.options?.calendarId as string ?? 'primary'

    // Create a watch channel
    const watchBody = {
      id: `google-calendar-watch-${Date.now()}-${Math.random().toString(36).substring(2)}`,
      type: 'web_hook',
      address: callbackUrl,
      params: {
        ttl: '3600', // 1 hour in seconds
      },
    }

    const response = await this.authenticatedRequest<{ resourceId: string; expiration: string }>(
      ctx,
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      { method: 'POST', body: watchBody }
    )

    if (!response.ok) {
      throw new Error(`Failed to subscribe to Google Calendar watch: ${response.status}`)
    }

    return {
      subscriptionId: response.data?.resourceId || 'unknown',
      expiresAt: response.data?.expiration ? new Date(Number(response.data.expiration)) : undefined,
      resourceUri: callbackUrl,
    }
  }

  /**
   * Unsubscribe from Google Calendar notifications.
   */
  async unsubscribe(ctx: ConnectorContext, subscriptionId: string): Promise<void> {
    // Google Calendar uses channel_id and resource_id to stop
    // For MVP, we'll send a stop request with the subscriptionId as resourceId
    const stopBody = {
      id: subscriptionId,
      resourceId: subscriptionId,
    }

    const response = await this.authenticatedRequest<Record<string, unknown>>(
      ctx,
      `${this.apiBaseUrl}/channels/stop`,
      { method: 'POST', body: stopBody }
    )

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to unsubscribe from Google Calendar watch: ${response.status}`)
    }
  }

  /**
   * Renew Google Calendar subscription by re-registering watch.
   */
  async renewSubscription(
    ctx: ConnectorContext,
    subscriptionId: string
  ): Promise<{ subscriptionId: string; expiresAt?: Date; resourceUri?: string }> {
    // Need to store calendar ID with subscription for renewal
    // For MVP, we'll just re-subscribe to primary calendar
    return this.subscribe(ctx, '', { options: { calendarId: 'primary' } })
  }

  // ============ Private Fetch Methods ============

  /**
   * Fetch events for backfill.
   */
  private async fetchEvents(
    ctx: ConnectorContext,
    cursorState: CursorState,
    limit?: number
  ): Promise<PageFetchResult> {
    const calendarId = this.calendarIds[cursorState.calendarIdIndex] ?? 'primary'

    const params: Record<string, string | number | boolean> = {
      maxResults: limit ?? 50,
      singleEvents: true, // Expand recurring events
    }

    if (cursorState.pageToken) {
      params.pageToken = cursorState.pageToken
    }

    if (this.minTime) {
      params.timeMin = this.minTime
    }

    if (this.maxTime) {
      params.timeMax = this.maxTime
    }

    if (!this.includeCanceled) {
      // Only show events where status is 'confirmed'
      // This is handled by filtering after fetch, as API doesn't have direct filter
    }

    const response = await this.authenticatedRequest<GoogleCalendarEventList>(
      ctx,
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events`,
      { params }
    )

    if (!response.ok) {
      throw new SyncError(
        `Google Calendar API error: ${response.status}`,
        ErrorCode.SYNC_COLLECT,
        {
          retryable: response.status >= 500,
          context: {
            connector: this.type,
            calendarId,
            status: response.status,
          },
        }
      )
    }

    const parsed = GoogleCalendarEventListSchema.safeParse(response.data)
    if (!parsed.success) {
      throw new SyncError(
        `Failed to parse Google Calendar response: ${parsed.error.message}`,
        ErrorCode.SYNC_PROCESS,
        {
          retryable: false,
          context: { connector: this.type, calendarId },
        }
      )
    }

    const eventList = parsed.data
    const items: SourceItem[] = []

    for (const event of eventList.items) {
      // Filter out canceled events if configured
      if (!this.includeCanceled && event.status === 'cancelled') {
        continue
      }

      const eventParsed = GoogleCalendarEventSchema.safeParse(event)
      if (eventParsed.success) {
        const eventData = eventParsed.data
        items.push({
          source_id: `${calendarId}/${eventData.id}`,
          entity_type: 'event',
          raw_data: eventData,
          source_timestamp: eventData.created || new Date().toISOString(),
          source_version: eventData.updated,
        })
      }
    }

    return {
      items,
      hasMore: !!eventList.nextPageToken,
      nextPageToken: eventList.nextPageToken ?? '',
      rateLimit: this.parseRateLimitHeaders(response.headers),
    }
  }

  /**
   * Fetch event changes via sync token.
   */
  private async fetchEventChanges(
    ctx: ConnectorContext,
    cursorState: SyncCursorState,
    limit?: number
  ): Promise<PageFetchResult> {
    const calendarId = this.calendarIds[cursorState.calendarIdIndex] ?? 'primary'

    const params: Record<string, string | number | boolean> = {
      singleEvents: true,
    }

    if (limit) {
      params.maxResults = limit
    }

    if (this.minTime) {
      params.timeMin = this.minTime
    }

    if (this.maxTime) {
      params.timeMax = this.maxTime
    }

    // Use syncToken for incremental sync
    if (cursorState.syncToken) {
      params.syncToken = cursorState.syncToken
    }

    const response = await this.authenticatedRequest<GoogleCalendarEventList>(
      ctx,
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events`,
      { params }
    )

    if (!response.ok) {
      // HTTP 410 Gone = sync token invalidated, need full resync
      if (response.status === 410) {
        throw new SyncError(
          'Google Calendar sync token invalidated - full resync required',
          ErrorCode.SYNC_CURSOR,
          {
            retryable: true,
            context: {
              connector: this.type,
              calendarId,
              status: response.status,
            },
          }
        )
      }
      throw new SyncError(
        `Google Calendar API error: ${response.status}`,
        ErrorCode.SYNC_COLLECT,
        {
          retryable: response.status >= 500,
          context: {
            connector: this.type,
            calendarId,
            status: response.status,
          },
        }
      )
    }

    const parsed = GoogleCalendarEventListSchema.safeParse(response.data)
    if (!parsed.success) {
      throw new SyncError(
        `Failed to parse Google Calendar response: ${parsed.error.message}`,
        ErrorCode.SYNC_PROCESS,
        {
          retryable: false,
          context: { connector: this.type, calendarId },
        }
      )
    }

    const eventList = parsed.data
    const items: SourceItem[] = []

    for (const event of eventList.items) {
      const eventParsed = GoogleCalendarEventSchema.safeParse(event)
      if (eventParsed.success) {
        const eventData = eventParsed.data
        items.push({
          source_id: `${calendarId}/${eventData.id}`,
          entity_type: 'event',
          raw_data: eventData,
          source_timestamp: eventData.updated || new Date().toISOString(),
          source_version: eventData.updated,
        })
      }
    }

    return {
      items,
      hasMore: false, // Sync token returns all changes at once
      nextSyncToken: eventList.nextSyncToken,
      rateLimit: this.parseRateLimitHeaders(response.headers),
    }
  }

  // ============ Transform Registration ============

  /**
   * Register Google Calendar transformations with a registry.
   */
  registerTransforms(registry: TransformationRegistry): void {
    for (const transform of googleCalendarTransforms) {
      registry.register(transform as any)
    }
  }

  // ============ Utility Methods ============

  private parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
    // Google Calendar API may return rate limit headers
    const limit = headers.get('X-RateLimit-Limit') || headers.get('x-ratelimit-limit')
    const remaining = headers.get('X-RateLimit-Remaining') || headers.get('x-ratelimit-remaining')
    const reset = headers.get('X-RateLimit-Reset') || headers.get('x-ratelimit-reset')

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
  calendarIdIndex: number
  pageToken: string
  entityTypeIndex: number
}

interface SyncCursorState {
  syncToken: string
  calendarIdIndex: number
  entityTypeIndex: number
}

interface PageFetchResult {
  items: SourceItem[]
  hasMore: boolean
  nextPageToken?: string
  nextSyncToken?: string
  rateLimit?: RateLimitInfo
}

// ============ Factory ============

/**
 * Create a Google Calendar connector instance.
 */
export function createGoogleCalendarConnector(
  config: GoogleCalendarConnectorConfig,
  options?: BaseConnectorOptions
): GoogleCalendarConnector {
  return new GoogleCalendarConnector(config, options)
}

// Re-export schemas and transforms
export * from './schemas.js'
export { googleCalendarTransforms, googleCalendarEventTransform } from './transforms.js'
