/**
 * GitHub Connector
 *
 * Reference implementation of a connector for GitHub's REST API.
 * Supports backfill, incremental sync, and webhooks.
 *
 * @module connectors/github
 */

import { z } from 'zod'
import {
  BaseConnector,
  type BaseConnectorOptions,
  type ConnectorCapabilities,
  type OAuth2Config,
  type AuthTokens,
  type AccountInfo,
  type WebhookEvent,
  type WebhookVerificationResult,
  type ConnectorContext,
} from '../../connector/sdk/index.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
  RateLimitInfo,
} from '../../sync/types.js'
import type { Transformation } from '../../transform/types.js'
import {
  GitHubUserSchema,
  GitHubIssueSchema,
  GitHubPullRequestSchema,
  GitHubCommentSchema,
  GitHubNotificationSchema,
  GitHubAuthenticatedUserSchema,
  GitHubIssueEventSchema,
  GitHubPullRequestEventSchema,
  GitHubIssueCommentEventSchema,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubComment,
  type GitHubNotification,
  type GitHubAuthenticatedUser,
} from './schemas.js'
import {
  githubTransforms,
  issueTransform,
  pullRequestTransform,
  commentTransform,
  notificationTransform,
  userTransform,
} from './transforms.js'

// ============ Constants ============

const GITHUB_API_BASE = 'https://api.github.com'

/**
 * Default OAuth2 configuration for GitHub.
 * Client ID/Secret should be provided via environment variables.
 */
export interface GitHubConnectorConfig {
  /** GitHub OAuth client ID */
  clientId: string
  /** GitHub OAuth client secret */
  clientSecret: string
  /** Custom API base URL (for GitHub Enterprise) */
  apiBaseUrl?: string
}

// ============ GitHub Connector ============

/**
 * GitHub connector implementation.
 *
 * Supports:
 * - OAuth2 authentication
 * - Backfill of issues, pull requests, comments, notifications
 * - Incremental sync via updated_at filtering
 * - Webhook verification and parsing
 * - Rate limit handling
 */
export class GitHubConnector extends BaseConnector {
  readonly type = 'github' as const
  readonly displayName = 'GitHub'

  readonly capabilities: ConnectorCapabilities = {
    supportsBackfill: true,
    supportsIncrementalSync: true,
    supportsWebhook: true,
    supportsWrite: true, // Could support creating issues, comments, etc.
    supportedEntityTypes: ['user', 'issue', 'pull_request', 'comment', 'notification'],
  }

  readonly authConfig: OAuth2Config

  private readonly apiBaseUrl: string

  constructor(config: GitHubConnectorConfig, options?: BaseConnectorOptions) {
    super(options)

    this.apiBaseUrl = config.apiBaseUrl ?? GITHUB_API_BASE

    this.authConfig = {
      type: 'oauth2',
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:user', 'read:org', 'notifications'],
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    }

    // Transformations are handled via TransformationRegistry
    // Use registerTransforms() to register GitHub transforms

    // Register schemas
    this.registerSchema('user', GitHubUserSchema)
    this.registerSchema('issue', GitHubIssueSchema)
    this.registerSchema('pull_request', GitHubPullRequestSchema)
    this.registerSchema('comment', GitHubCommentSchema)
    this.registerSchema('notification', GitHubNotificationSchema)
  }

  // ============ Account Discovery ============

  /**
   * List GitHub accounts (returns the authenticated user).
   */
  async listAccounts(ctx: ConnectorContext): Promise<AccountInfo[]> {
    const response = await this.authenticatedRequest<GitHubAuthenticatedUser>(
      ctx,
      `${this.apiBaseUrl}/user`
    )

    if (!response.ok) {
      throw new Error(`Failed to get user info: ${response.status}`)
    }

    const parsed = GitHubAuthenticatedUserSchema.safeParse(response.data)
    if (!parsed.success) {
      throw new Error(`Invalid user response: ${parsed.error.message}`)
    }

    const user = parsed.data
    return [{
      externalId: String(user.id),
      displayName: user.name ?? user.login,
      email: user.email ?? undefined,
      avatarUrl: user.avatar_url,
      username: user.login,
      isPrimary: true,
      metadata: {
        type: user.type,
        html_url: user.html_url,
      },
    }]
  }

  // ============ Sync Methods ============

  /**
   * Fetch a page of GitHub data for backfill.
   */
  async fetchPage(
    ctx: ConnectorContext,
    options: FetchPageOptions
  ): Promise<FetchPageResult> {
    const entityTypes = options.entityTypes ?? this.capabilities.supportedEntityTypes
    const items: SourceItem[] = []

    // Parse cursor
    let cursorState: CursorState = { page: 1, entityTypeIndex: 0 }
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

    // Fetch based on entity type
    let result: PageFetchResult
    switch (currentEntityType) {
      case 'user':
        result = await this.fetchAuthenticatedUser(ctx)
        break
      case 'issue':
        result = await this.fetchIssues(ctx, cursorState.page, options.limit)
        break
      case 'pull_request':
        result = await this.fetchPullRequests(ctx, cursorState.page, options.limit)
        break
      case 'comment':
        result = await this.fetchComments(ctx, cursorState.page, options.limit)
        break
      case 'notification':
        result = await this.fetchNotifications(ctx, cursorState.page, options.limit)
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
        page: cursorState.page + 1,
        entityTypeIndex: cursorState.entityTypeIndex,
      })
    } else if (cursorState.entityTypeIndex < entityTypes.length - 1) {
      // Move to next entity type
      hasMore = true
      nextCursor = JSON.stringify({
        page: 1,
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
   * Fetch changes since last sync using updated_at filtering.
   */
  async fetchChanges(
    ctx: ConnectorContext,
    options: FetchChangesOptions
  ): Promise<FetchPageResult> {
    // GitHub supports sorting by updated for issues/PRs
    const entityTypes = options.entityTypes ?? ['issue', 'pull_request', 'notification']
    const items: SourceItem[] = []

    // Parse cursor
    let cursorState: ChangeCursorState = {
      since: options.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      entityTypeIndex: 0,
      page: 1,
    }
    if (options.cursor) {
      try {
        cursorState = JSON.parse(options.cursor) as ChangeCursorState
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
      case 'issue':
        result = await this.fetchIssues(ctx, cursorState.page, options.limit, cursorState.since)
        break
      case 'pull_request':
        result = await this.fetchPullRequests(ctx, cursorState.page, options.limit, cursorState.since)
        break
      case 'notification':
        result = await this.fetchNotifications(ctx, cursorState.page, options.limit, cursorState.since)
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
        ...cursorState,
        page: cursorState.page + 1,
      })
    } else if (cursorState.entityTypeIndex < entityTypes.length - 1) {
      hasMore = true
      nextCursor = JSON.stringify({
        since: cursorState.since,
        entityTypeIndex: cursorState.entityTypeIndex + 1,
        page: 1,
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
   * Verify GitHub webhook signature.
   * GitHub uses HMAC-SHA256 with "sha256=" prefix.
   */
  override async verifyWebhookSignature(
    event: WebhookEvent,
    secret: string
  ): Promise<WebhookVerificationResult> {
    // GitHub signature is in X-Hub-Signature-256 header
    const signature = event.headers['x-hub-signature-256'] ?? event.signature
    if (!signature) {
      return { valid: false, error: 'No X-Hub-Signature-256 header' }
    }

    // Use parent's HMAC-SHA256 verification
    const eventWithSignature: WebhookEvent = {
      ...event,
      signature,
    }

    return super.verifyWebhookSignature(eventWithSignature, secret)
  }

  /**
   * Parse GitHub webhook payload into source items.
   */
  async parseWebhookPayload(event: WebhookEvent): Promise<SourceItem[]> {
    const items: SourceItem[] = []
    const eventType = event.headers['x-github-event'] ?? event.eventType

    switch (eventType) {
      case 'issues': {
        const parsed = GitHubIssueEventSchema.safeParse(event.payload)
        if (parsed.success) {
          items.push({
            source_id: String(parsed.data.issue.id),
            entity_type: 'issue',
            raw_data: parsed.data.issue,
            source_timestamp: parsed.data.issue.updated_at,
          })
        }
        break
      }

      case 'pull_request': {
        const parsed = GitHubPullRequestEventSchema.safeParse(event.payload)
        if (parsed.success) {
          items.push({
            source_id: String(parsed.data.pull_request.id),
            entity_type: 'pull_request',
            raw_data: parsed.data.pull_request,
            source_timestamp: parsed.data.pull_request.updated_at,
          })
        }
        break
      }

      case 'issue_comment': {
        const parsed = GitHubIssueCommentEventSchema.safeParse(event.payload)
        if (parsed.success) {
          items.push({
            source_id: String(parsed.data.comment.id),
            entity_type: 'comment',
            raw_data: parsed.data.comment,
            source_timestamp: parsed.data.comment.updated_at,
          })
        }
        break
      }
    }

    return items
  }

  // ============ Private Fetch Methods ============

  private async fetchAuthenticatedUser(ctx: ConnectorContext): Promise<PageFetchResult> {
    const response = await this.authenticatedRequest<GitHubAuthenticatedUser>(
      ctx,
      `${this.apiBaseUrl}/user`
    )

    if (!response.ok) {
      return { items: [], hasMore: false }
    }

    const parsed = GitHubAuthenticatedUserSchema.safeParse(response.data)
    if (!parsed.success) {
      return { items: [], hasMore: false }
    }

    return {
      items: [{
        source_id: String(parsed.data.id),
        entity_type: 'user',
        raw_data: parsed.data,
        source_timestamp: parsed.data.updated_at,
      }],
      hasMore: false,
      rateLimit: this.parseRateLimitHeaders(response.headers),
    }
  }

  private async fetchIssues(
    ctx: ConnectorContext,
    page: number,
    limit = 30,
    since?: string
  ): Promise<PageFetchResult> {
    const params: Record<string, string | number> = {
      filter: 'all',
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: Math.min(limit, 100),
      page,
    }

    if (since) {
      params.since = since
    }

    const response = await this.authenticatedRequest<GitHubIssue[]>(
      ctx,
      `${this.apiBaseUrl}/issues`,
      { params }
    )

    if (!response.ok) {
      return { items: [], hasMore: false }
    }

    // Filter out pull requests (they also appear in /issues)
    const issues = (response.data ?? []).filter(
      item => !item.pull_request
    )

    const items: SourceItem[] = []
    for (const issue of issues) {
      const parsed = GitHubIssueSchema.safeParse(issue)
      if (parsed.success) {
        items.push({
          source_id: String(parsed.data.id),
          entity_type: 'issue',
          raw_data: parsed.data,
          source_timestamp: parsed.data.updated_at,
        })
      }
    }

    return {
      items,
      hasMore: items.length === limit,
      rateLimit: this.parseRateLimitHeaders(response.headers),
    }
  }

  private async fetchPullRequests(
    ctx: ConnectorContext,
    page: number,
    limit = 30,
    since?: string
  ): Promise<PageFetchResult> {
    // Fetch PRs via /issues endpoint with PR filter
    const params: Record<string, string | number> = {
      filter: 'all',
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: Math.min(limit, 100),
      page,
    }

    if (since) {
      params.since = since
    }

    const response = await this.authenticatedRequest<GitHubIssue[]>(
      ctx,
      `${this.apiBaseUrl}/issues`,
      { params }
    )

    if (!response.ok) {
      return { items: [], hasMore: false }
    }

    // Filter to only pull requests
    const prs = (response.data ?? []).filter(
      item => item.pull_request
    )

    const items: SourceItem[] = []
    for (const pr of prs) {
      // For full PR data, we'd need to fetch /repos/{owner}/{repo}/pulls/{number}
      // For now, map the issue representation
      const parsed = GitHubIssueSchema.safeParse(pr)
      if (parsed.success) {
        items.push({
          source_id: String(parsed.data.id),
          entity_type: 'pull_request',
          raw_data: parsed.data,
          source_timestamp: parsed.data.updated_at,
        })
      }
    }

    return {
      items,
      hasMore: items.length === limit,
      rateLimit: this.parseRateLimitHeaders(response.headers),
    }
  }

  private async fetchComments(
    ctx: ConnectorContext,
    page: number,
    limit = 30
  ): Promise<PageFetchResult> {
    // Fetch recent issue comments across all repos
    // Note: This requires specific repo access, simplified here
    const params: Record<string, string | number> = {
      sort: 'updated',
      direction: 'desc',
      per_page: Math.min(limit, 100),
      page,
    }

    // We'd need to iterate repos for comments
    // For now, return empty - full implementation would need repo enumeration
    return {
      items: [],
      hasMore: false,
    }
  }

  private async fetchNotifications(
    ctx: ConnectorContext,
    page: number,
    limit = 30,
    since?: string
  ): Promise<PageFetchResult> {
    const params: Record<string, string | number | boolean> = {
      all: true,
      per_page: Math.min(limit, 100),
      page,
    }

    if (since) {
      params.since = since
    }

    const response = await this.authenticatedRequest<GitHubNotification[]>(
      ctx,
      `${this.apiBaseUrl}/notifications`,
      { params }
    )

    if (!response.ok) {
      return { items: [], hasMore: false }
    }

    const items: SourceItem[] = []
    for (const notification of response.data ?? []) {
      const parsed = GitHubNotificationSchema.safeParse(notification)
      if (parsed.success) {
        items.push({
          source_id: parsed.data.id,
          entity_type: 'notification',
          raw_data: parsed.data,
          source_timestamp: parsed.data.updated_at,
        })
      }
    }

    return {
      items,
      hasMore: items.length === limit,
      rateLimit: this.parseRateLimitHeaders(response.headers),
    }
  }

  // ============ Utility Methods ============

  private parseRateLimitHeaders(headers: Headers): RateLimitInfo | undefined {
    const remaining = headers.get('x-ratelimit-remaining')
    const limit = headers.get('x-ratelimit-limit')
    const reset = headers.get('x-ratelimit-reset')

    if (!remaining || !limit || !reset) {
      return undefined
    }

    return {
      remaining: parseInt(remaining, 10),
      limit: parseInt(limit, 10),
      resetsAt: parseInt(reset, 10),
    }
  }

  /**
   * Override webhook signature computation for GitHub's format.
   */
  protected override computeWebhookSignature(payload: string, secret: string): string {
    // GitHub expects sha256= prefix
    return 'sha256=' + super.computeWebhookSignature(payload, secret)
  }

  // ============ Transform Registration ============

  /**
   * Register GitHub transformations with a registry.
   * Call this during daemon setup to enable processing.
   */
  registerTransforms(registry: { register<T>(t: Transformation<T>): void }): void {
    for (const transform of githubTransforms) {
      registry.register(transform)
    }
  }
}

// ============ Types ============

interface CursorState {
  page: number
  entityTypeIndex: number
}

interface ChangeCursorState extends CursorState {
  since: string
}

interface PageFetchResult {
  items: SourceItem[]
  hasMore: boolean
  rateLimit?: RateLimitInfo
}

// ============ Factory ============

/**
 * Create a GitHub connector instance.
 */
export function createGitHubConnector(
  config: GitHubConnectorConfig,
  options?: BaseConnectorOptions
): GitHubConnector {
  return new GitHubConnector(config, options)
}

// Re-export schemas and transforms
export * from './schemas.js'
export {
  githubTransforms,
  userTransform,
  issueTransform,
  pullRequestTransform,
  commentTransform,
  notificationTransform,
} from './transforms.js'
