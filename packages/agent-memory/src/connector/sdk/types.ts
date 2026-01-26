/**
 * Connector SDK Types
 *
 * Types and interfaces for building connectors to external services.
 * This module defines the contract between connectors and the sync engine.
 *
 * @module connector/sdk/types
 */

import { z } from 'zod'
import type { ConnectorType } from '../../ids.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
} from '../../sync/types.js'

// ============ Connector Capabilities ============

/**
 * Capabilities that a connector may support.
 * Used for feature detection and to determine available sync modes.
 */
export interface ConnectorCapabilities {
  /** Can perform full historical backfill */
  supportsBackfill: boolean
  /** Can fetch only changed data since last sync */
  supportsIncrementalSync: boolean
  /** Can receive real-time updates via webhooks */
  supportsWebhook: boolean
  /** Can write/modify data in the external system */
  supportsWrite: boolean
  /** Entity types this connector can fetch */
  supportedEntityTypes: string[]
}

export const ConnectorCapabilitiesSchema = z.object({
  supportsBackfill: z.boolean(),
  supportsIncrementalSync: z.boolean(),
  supportsWebhook: z.boolean(),
  supportsWrite: z.boolean(),
  supportedEntityTypes: z.array(z.string()),
})

// ============ Auth Configuration ============

/**
 * Authentication type supported by connectors.
 */
export type ConnectorAuthType = 'oauth2' | 'api_key' | 'local'

export const ConnectorAuthTypeSchema = z.enum(['oauth2', 'api_key', 'local'])

/**
 * OAuth2 configuration that references a centralized provider.
 * Client credentials are looked up from OAuthProviderRegistry.
 */
export interface OAuthProviderRefConfig {
  type: 'oauth2_provider'
  /** Provider ID (e.g., 'google', 'github') */
  provider: 'google' | 'github' | 'microsoft' | 'slack' | 'twitter'
  /** Required OAuth scopes for this connector */
  scopes: string[]
}

export const OAuthProviderRefConfigSchema = z.object({
  type: z.literal('oauth2_provider'),
  provider: z.enum(['google', 'github', 'microsoft', 'slack', 'twitter']),
  scopes: z.array(z.string()),
})

/**
 * OAuth2 configuration for connectors that use OAuth.
 * @deprecated Use OAuthProviderRefConfig instead for centralized credentials
 */
export interface OAuth2Config {
  type: 'oauth2'
  /** OAuth authorization endpoint */
  authorizationUrl: string
  /** OAuth token endpoint */
  tokenUrl: string
  /** Required OAuth scopes */
  scopes: string[]
  /** Client ID (typically from environment) */
  clientId: string
  /** Client secret (typically from environment) */
  clientSecret: string
  /** Optional: PKCE code challenge method */
  codeChallengeMethod?: 'S256' | 'plain'
  /** Optional: Additional authorization parameters */
  authParams?: Record<string, string>
}

export const OAuth2ConfigSchema = z.object({
  type: z.literal('oauth2'),
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string()),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  codeChallengeMethod: z.enum(['S256', 'plain']).optional(),
  authParams: z.record(z.string()).optional(),
})

/**
 * API key configuration for connectors that use API keys.
 */
export interface ApiKeyConfig {
  type: 'api_key'
  /** Header name for the API key */
  headerName: string
  /** Optional prefix (e.g., "Bearer", "Token") */
  headerPrefix?: string
}

export const ApiKeyConfigSchema = z.object({
  type: z.literal('api_key'),
  headerName: z.string().min(1),
  headerPrefix: z.string().optional(),
})

/**
 * Local auth configuration for connectors that access local data.
 */
export interface LocalAuthConfig {
  type: 'local'
  /** Path to local data source (e.g., SQLite database) */
  dataPath?: string
  /** Whether elevated permissions are required */
  requiresSystemAccess?: boolean
}

export const LocalAuthConfigSchema = z.object({
  type: z.literal('local'),
  dataPath: z.string().optional(),
  requiresSystemAccess: z.boolean().optional(),
})

/**
 * Reference to existing credentials (for credential reuse).
 * Used when you want to reuse OAuth credentials across multiple connector instances.
 */
export interface CredentialReferenceConfig {
  type: 'credential_reference'
  /** Account ID that holds the credentials to reuse */
  accountId: string
  /** Optional: Additional scopes beyond what the original account has */
  additionalScopes?: string[]
}

export const CredentialReferenceConfigSchema = z.object({
  type: z.literal('credential_reference'),
  accountId: z.string().min(1),
  additionalScopes: z.array(z.string()).optional(),
})

/**
 * Union of all auth configuration types.
 */
export type AuthConfig = OAuthProviderRefConfig | OAuth2Config | ApiKeyConfig | LocalAuthConfig | CredentialReferenceConfig

export const AuthConfigSchema = z.discriminatedUnion('type', [
  OAuthProviderRefConfigSchema,
  OAuth2ConfigSchema,
  ApiKeyConfigSchema,
  LocalAuthConfigSchema,
  CredentialReferenceConfigSchema,
])

// ============ Auth Tokens ============

/**
 * Tokens received from OAuth2 exchange or refresh.
 */
export interface AuthTokens {
  /** Access token for API calls */
  accessToken: string
  /** Optional refresh token for token renewal */
  refreshToken?: string
  /** Token type (usually "Bearer") */
  tokenType: string
  /** Seconds until access token expires */
  expiresIn?: number
  /** Absolute expiration time */
  expiresAt?: Date
  /** Granted scopes (may differ from requested) */
  scope?: string
}

export const AuthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  tokenType: z.string().default('Bearer'),
  expiresIn: z.number().int().positive().optional(),
  expiresAt: z.date().optional(),
  scope: z.string().optional(),
})

// ============ Account Discovery ============

/**
 * Information about an account discovered during sync.
 * Returned by connector's listAccounts method.
 */
export interface AccountInfo {
  /** External account ID (unique within the connector) */
  externalId: string
  /** Human-readable display name */
  displayName?: string
  /** Account email (if available) */
  email?: string
  /** Account avatar URL */
  avatarUrl?: string
  /** Username on the platform */
  username?: string
  /** Whether the account is the authenticated user */
  isPrimary?: boolean
  /** Additional platform-specific metadata */
  metadata?: Record<string, unknown>
}

export const AccountInfoSchema = z.object({
  externalId: z.string().min(1),
  displayName: z.string().optional(),
  email: z.string().email().optional(),
  avatarUrl: z.string().url().optional(),
  username: z.string().optional(),
  isPrimary: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
})

// ============ Webhook Types ============

/**
 * Raw webhook event received from an external service.
 */
export interface WebhookEvent {
  /** Webhook delivery ID (for idempotency) */
  deliveryId?: string
  /** Event type/action from the webhook */
  eventType: string
  /** Raw webhook payload */
  payload: unknown
  /** Request headers (for signature verification) */
  headers: Record<string, string>
  /** Webhook signature (if present) */
  signature?: string
  /** Timestamp when webhook was received */
  receivedAt: Date
}

export const WebhookEventSchema = z.object({
  deliveryId: z.string().optional(),
  eventType: z.string().min(1),
  payload: z.unknown(),
  headers: z.record(z.string()),
  signature: z.string().optional(),
  receivedAt: z.date(),
})

/**
 * Result of webhook signature verification.
 */
export interface WebhookVerificationResult {
  /** Whether the signature is valid */
  valid: boolean
  /** Error message if verification failed */
  error?: string
  /** Computed signature for debugging */
  computedSignature?: string
}

// ============ Webhook Subscription Types ============

/**
 * Options for subscribing to webhooks.
 */
export interface WebhookSubscribeOptions {
  /** Entity types to receive updates for */
  entityTypes?: string[]
  /** Additional service-specific options */
  options?: Record<string, unknown>
}

/**
 * Result of a webhook subscription.
 */
export interface WebhookSubscription {
  /** Subscription ID (from external service) */
  subscriptionId: string
  /** When the subscription expires (if applicable) */
  expiresAt?: Date
  /** Resource URI being watched (service-specific) */
  resourceUri?: string
}

// ============ Connector Context ============

/**
 * Context passed to connector methods.
 * Provides access to credentials and configuration.
 */
export interface ConnectorContext {
  /** Account ID for this connector instance */
  accountId: string
  /** Access token or API key for requests */
  accessToken?: string
  /** Additional credentials (varies by auth type) */
  credentials?: Record<string, string>
  /** Connector configuration */
  config?: Record<string, unknown>
}

// ============ Connector Interface ============

/**
 * Full interface for a connector implementation.
 * Connectors must implement this interface to integrate with the sync engine.
 */
export interface Connector {
  /** Connector type identifier */
  readonly type: ConnectorType
  /** Human-readable display name */
  readonly displayName: string
  /** Capabilities supported by this connector */
  readonly capabilities: ConnectorCapabilities
  /** Authentication configuration */
  readonly authConfig: AuthConfig

  // ============ Auth Methods ============

  /**
   * Get OAuth authorization URL for user consent.
   * Only applicable for OAuth2 connectors.
   * @param state - CSRF protection state parameter
   * @param redirectUri - Callback URL after authorization
   */
  getAuthorizationUrl?(state: string, redirectUri: string): string

  /**
   * Exchange authorization code for tokens.
   * Only applicable for OAuth2 connectors.
   * @param code - Authorization code from callback
   * @param redirectUri - Same redirect URI used in authorization
   */
  exchangeCodeForTokens?(code: string, redirectUri: string): Promise<AuthTokens>

  /**
   * Refresh expired access token using refresh token.
   * Only applicable for OAuth2 connectors.
   * @param refreshToken - Refresh token from initial exchange
   */
  refreshTokens?(refreshToken: string): Promise<AuthTokens>

  // ============ Discovery Methods ============

  /**
   * List accounts accessible with current credentials.
   * @param ctx - Connector context with credentials
   */
  listAccounts(ctx: ConnectorContext): Promise<AccountInfo[]>

  // ============ Sync Methods ============

  /**
   * Fetch a page of data for backfill operations.
   * @param ctx - Connector context with credentials
   * @param options - Pagination and filtering options
   */
  fetchPage(ctx: ConnectorContext, options: FetchPageOptions): Promise<FetchPageResult>

  /**
   * Fetch changes since the last sync.
   * @param ctx - Connector context with credentials
   * @param options - Options including cursor from last sync
   */
  fetchChanges?(ctx: ConnectorContext, options: FetchChangesOptions): Promise<FetchPageResult>

  // ============ Webhook Methods ============

  /**
   * Verify webhook signature.
   * @param event - Webhook event to verify
   * @param secret - Webhook secret for HMAC verification
   */
  verifyWebhookSignature?(event: WebhookEvent, secret: string): Promise<WebhookVerificationResult>

  /**
   * Parse webhook payload into source items.
   * @param event - Verified webhook event
   */
  parseWebhookPayload?(event: WebhookEvent): Promise<SourceItem[]>

  /**
   * Subscribe to webhooks for real-time updates.
   * Returns a subscription ID that can be used to unsubscribe.
   *
   * @param ctx - Connector context with credentials
   * @param callbackUrl - URL where webhooks should be sent
   * @param options - Subscription options (event types, etc.)
   */
  subscribe?(
    ctx: ConnectorContext,
    callbackUrl: string,
    options?: WebhookSubscribeOptions
  ): Promise<WebhookSubscription>

  /**
   * Unsubscribe from webhooks.
   *
   * @param ctx - Connector context with credentials
   * @param subscriptionId - ID returned from subscribe()
   */
  unsubscribe?(ctx: ConnectorContext, subscriptionId: string): Promise<void>

  /**
   * Renew a webhook subscription (if required by the service).
   * Some services require periodic renewal (e.g., Google Push).
   *
   * @param ctx - Connector context with credentials
   * @param subscriptionId - ID of subscription to renew
   */
  renewSubscription?(
    ctx: ConnectorContext,
    subscriptionId: string
  ): Promise<WebhookSubscription>

  // ============ Estimate Methods ============

  /**
   * Estimate the scope of a sync operation.
   * Returns approximate item counts per entity type.
   * Used by the CLI to show users what they're about to sync.
   *
   * @param ctx - Connector context with credentials
   * @param syncType - Type of sync (backfill or incremental)
   * @param entityTypes - Entity types to estimate (defaults to all supported)
   */
  estimateScope?(
    ctx: ConnectorContext,
    syncType: 'backfill' | 'incremental',
    entityTypes?: string[]
  ): Promise<SyncEstimate>

  // ============ Schema Methods ============

  /**
   * Get Zod schema for validating source data of an entity type.
   * @param entityType - Entity type (e.g., 'issue', 'message')
   */
  getSourceSchema(entityType: string): z.ZodSchema | undefined
}

// ============ Sync Estimates ============

/**
 * Estimate of items per entity type for a sync operation.
 */
export interface SyncEstimateEntry {
  /** Entity type (e.g., 'message', 'thread') */
  type: string
  /** Approximate item count (undefined if unknown) */
  count?: number
  /** Human-readable description (e.g., "~12,500 messages") */
  description: string
}

/**
 * Estimate of the scope of a sync operation.
 * Returned by `Connector.estimateScope()`.
 */
export interface SyncEstimate {
  /** Per-entity-type estimates */
  entities: SyncEstimateEntry[]
  /** Overall human-readable summary */
  summary?: string
}

// ============ Connector Registration ============

/**
 * Connector factory function type.
 */
export type ConnectorFactory = () => Connector

/**
 * Registry entry for a connector.
 */
export interface ConnectorRegistration {
  /** Connector type identifier */
  type: ConnectorType
  /** Factory function to create connector instance */
  factory: ConnectorFactory
  /** Connector display name */
  displayName: string
  /** Connector capabilities */
  capabilities: ConnectorCapabilities
  /** Auth type required */
  authType: ConnectorAuthType
}
