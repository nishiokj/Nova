/**
 * Base Connector
 *
 * Abstract base class for connector implementations.
 * Provides common functionality and enforces the connector contract.
 *
 * @module connector/sdk/connector
 */

import { z } from 'zod'
import { createHmac, timingSafeEqual } from 'crypto'
import type { ConnectorType } from '../../ids.js'
import type {
  FetchPageOptions,
  FetchChangesOptions,
  FetchPageResult,
  SourceItem,
  EntityMapper,
} from '../../sync/types.js'
import type {
  Connector,
  ConnectorCapabilities,
  AuthConfig,
  OAuth2Config,
  AuthTokens,
  AccountInfo,
  WebhookEvent,
  WebhookVerificationResult,
  ConnectorContext,
} from './types.js'
import {
  ResilientHttpClient,
  createHttpClient,
  type HttpClientConfig,
  type HttpResponse,
  type HttpClientHooks,
} from './http.js'

// ============ Error Logger ============

/**
 * Error severity levels.
 */
export type ErrorSeverity = 'debug' | 'info' | 'warn' | 'error'

/**
 * Structured error context for logging.
 */
export interface ConnectorErrorContext {
  /** Connector type */
  connector: ConnectorType
  /** Operation that failed */
  operation: string
  /** Account ID if available */
  accountId?: string
  /** Request URL if applicable */
  url?: string
  /** HTTP status code if applicable */
  statusCode?: number
  /** Duration in milliseconds */
  durationMs?: number
  /** Retry attempt number */
  attempt?: number
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Logger interface for connector errors.
 * Implement this to integrate with your logging infrastructure.
 */
export interface ConnectorLogger {
  /** Log a debug message */
  debug(message: string, context?: ConnectorErrorContext): void
  /** Log an info message */
  info(message: string, context?: ConnectorErrorContext): void
  /** Log a warning */
  warn(message: string, error: Error | undefined, context?: ConnectorErrorContext): void
  /** Log an error */
  error(message: string, error: Error, context?: ConnectorErrorContext): void
}

/**
 * Default console logger implementation.
 */
export const defaultLogger: ConnectorLogger = {
  debug(message, context) {
    console.debug(`[connector:${context?.connector ?? 'unknown'}] ${message}`, context)
  },
  info(message, context) {
    console.info(`[connector:${context?.connector ?? 'unknown'}] ${message}`, context)
  },
  warn(message, error, context) {
    console.warn(`[connector:${context?.connector ?? 'unknown'}] ${message}`, { error, ...context })
  },
  error(message, error, context) {
    console.error(`[connector:${context?.connector ?? 'unknown'}] ${message}`, { error, ...context })
  },
}

/**
 * No-op logger that discards all messages (for testing).
 */
export const noopLogger: ConnectorLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/**
 * Options for BaseConnector constructor.
 */
export interface BaseConnectorOptions {
  /** HTTP client configuration */
  httpConfig?: Partial<HttpClientConfig>
  /** Logger for errors and events */
  logger?: ConnectorLogger
}

// ============ Abstract Base Connector ============

/**
 * Abstract base class for building connectors.
 *
 * Provides:
 * - HTTP client with resilience patterns
 * - OAuth2 flow implementation
 * - Webhook signature verification
 * - Entity mapper registry
 * - Error logging
 *
 * Subclasses must implement:
 * - type, displayName, capabilities, authConfig properties
 * - listAccounts() for account discovery
 * - fetchPage() for data fetching
 * - Entity mappers and schemas
 */
export abstract class BaseConnector implements Connector {
  // ============ Required Properties ============

  /** Connector type identifier */
  abstract readonly type: ConnectorType
  /** Human-readable display name */
  abstract readonly displayName: string
  /** Capabilities supported by this connector */
  abstract readonly capabilities: ConnectorCapabilities
  /** Authentication configuration */
  abstract readonly authConfig: AuthConfig

  // ============ Protected Properties ============

  /** HTTP client for API requests */
  protected readonly http: ResilientHttpClient
  /** Entity mappers by source entity type */
  protected readonly mappers: Map<string, EntityMapper> = new Map()
  /** Source schemas by entity type */
  protected readonly sourceSchemas: Map<string, z.ZodSchema> = new Map()
  /** Logger for errors and events */
  protected readonly logger: ConnectorLogger

  // ============ Constructor ============

  constructor(options?: BaseConnectorOptions) {
    this.logger = options?.logger ?? defaultLogger

    // Create HTTP client with logging hooks
    const httpHooks: HttpClientHooks = {
      onRequest: (url, opts, attempt) => {
        this.logger.debug(`HTTP ${opts.method ?? 'GET'} ${url}`, {
          connector: this.type,
          operation: 'http_request',
          url,
          attempt,
        })
      },
      onResponse: (url, response, attempt) => {
        const context: ConnectorErrorContext = {
          connector: this.type,
          operation: 'http_response',
          url,
          statusCode: response.status,
          durationMs: response.durationMs,
          attempt,
        }

        if (response.ok) {
          this.logger.debug(`HTTP ${response.status} ${url}`, context)
        } else {
          this.logger.warn(`HTTP ${response.status} ${url}`, undefined, context)
        }
      },
      onRetry: (url, error, attempt, delayMs) => {
        this.logger.warn(`HTTP retry ${url} (attempt ${attempt}, delay ${delayMs}ms)`, error, {
          connector: this.type,
          operation: 'http_retry',
          url,
          attempt,
          metadata: { delayMs },
        })
      },
      onCircuitStateChange: (oldState, newState) => {
        this.logger.warn(`Circuit breaker state change: ${oldState} -> ${newState}`, undefined, {
          connector: this.type,
          operation: 'circuit_breaker',
          metadata: { oldState, newState },
        })
      },
    }

    this.http = createHttpClient(options?.httpConfig, httpHooks)
  }

  // ============ OAuth2 Methods ============

  /**
   * Get OAuth authorization URL for user consent.
   * Default implementation for OAuth2 connectors.
   */
  getAuthorizationUrl(state: string, redirectUri: string): string {
    if (this.authConfig.type !== 'oauth2') {
      throw new Error(`${this.type} connector does not support OAuth2`)
    }

    const config = this.authConfig as OAuth2Config
    const url = new URL(config.authorizationUrl)

    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)

    if (config.scopes.length > 0) {
      url.searchParams.set('scope', config.scopes.join(' '))
    }

    // Add any additional auth params
    if (config.authParams) {
      for (const [key, value] of Object.entries(config.authParams)) {
        url.searchParams.set(key, value)
      }
    }

    return url.toString()
  }

  /**
   * Exchange authorization code for tokens.
   * Default implementation for OAuth2 connectors.
   */
  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<AuthTokens> {
    if (this.authConfig.type !== 'oauth2') {
      throw new Error(`${this.type} connector does not support OAuth2`)
    }

    const config = this.authConfig as OAuth2Config
    const context: ConnectorErrorContext = {
      connector: this.type,
      operation: 'exchange_code_for_tokens',
      url: config.tokenUrl,
    }

    this.logger.debug('Exchanging authorization code for tokens', context)

    try {
      const response = await this.http.post<TokenResponse>(config.tokenUrl, {
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
      })

      this.logger.info('Successfully exchanged code for tokens', context)
      return this.parseTokenResponse(response.data)
    } catch (error) {
      this.logger.error('Failed to exchange code for tokens', error instanceof Error ? error : new Error(String(error)), context)
      throw error
    }
  }

  /**
   * Refresh expired access token.
   * Default implementation for OAuth2 connectors.
   */
  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    if (this.authConfig.type !== 'oauth2') {
      throw new Error(`${this.type} connector does not support OAuth2`)
    }

    const config = this.authConfig as OAuth2Config
    const context: ConnectorErrorContext = {
      connector: this.type,
      operation: 'refresh_tokens',
      url: config.tokenUrl,
    }

    this.logger.debug('Refreshing access token', context)

    try {
      const response = await this.http.post<TokenResponse>(config.tokenUrl, {
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
      })

      this.logger.info('Successfully refreshed tokens', context)
      return this.parseTokenResponse(response.data)
    } catch (error) {
      this.logger.error('Failed to refresh tokens', error instanceof Error ? error : new Error(String(error)), context)
      throw error
    }
  }

  /**
   * Parse OAuth token response into AuthTokens.
   * Can be overridden for connectors with non-standard responses.
   */
  protected parseTokenResponse(response: TokenResponse): AuthTokens {
    const tokens: AuthTokens = {
      accessToken: response.access_token,
      tokenType: response.token_type ?? 'Bearer',
    }

    if (response.refresh_token) {
      tokens.refreshToken = response.refresh_token
    }

    if (response.expires_in) {
      tokens.expiresIn = response.expires_in
      tokens.expiresAt = new Date(Date.now() + response.expires_in * 1000)
    }

    if (response.scope) {
      tokens.scope = response.scope
    }

    return tokens
  }

  // ============ Discovery Methods ============

  /**
   * List accounts accessible with current credentials.
   * Must be implemented by subclasses.
   */
  abstract listAccounts(ctx: ConnectorContext): Promise<AccountInfo[]>

  // ============ Sync Methods ============

  /**
   * Fetch a page of data for backfill operations.
   * Must be implemented by subclasses.
   */
  abstract fetchPage(ctx: ConnectorContext, options: FetchPageOptions): Promise<FetchPageResult>

  /**
   * Fetch changes since the last sync.
   * Optional - only implement if supportsIncrementalSync is true.
   */
  fetchChanges?(ctx: ConnectorContext, options: FetchChangesOptions): Promise<FetchPageResult>

  // ============ Webhook Methods ============

  /**
   * Verify webhook signature using HMAC-SHA256.
   * Default implementation - can be overridden for other algorithms.
   */
  async verifyWebhookSignature(event: WebhookEvent, secret: string): Promise<WebhookVerificationResult> {
    const context: ConnectorErrorContext = {
      connector: this.type,
      operation: 'verify_webhook_signature',
      metadata: {
        eventType: event.eventType,
        deliveryId: event.deliveryId,
      },
    }

    if (!event.signature) {
      const errorMsg = 'No signature provided'
      this.logger.warn(`Webhook verification failed: ${errorMsg}`, undefined, context)
      return { valid: false, error: errorMsg }
    }

    const payload = typeof event.payload === 'string'
      ? event.payload
      : JSON.stringify(event.payload)

    const computedSignature = this.computeWebhookSignature(payload, secret)

    try {
      const valid = this.safeCompareSignatures(event.signature, computedSignature)

      if (!valid) {
        this.logger.warn('Webhook signature mismatch', undefined, {
          ...context,
          metadata: {
            ...context.metadata,
            signatureProvided: event.signature.substring(0, 20) + '...',
          },
        })
      } else {
        this.logger.debug('Webhook signature verified', context)
      }

      return {
        valid,
        computedSignature: valid ? undefined : computedSignature,
        error: valid ? undefined : 'Signature mismatch',
      }
    } catch (error) {
      const errorMsg = `Verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      this.logger.error(errorMsg, error instanceof Error ? error : new Error(String(error)), context)
      return {
        valid: false,
        error: errorMsg,
      }
    }
  }

  /**
   * Compute webhook signature.
   * Default uses HMAC-SHA256. Override for other algorithms.
   */
  protected computeWebhookSignature(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex')
  }

  /**
   * Timing-safe signature comparison to prevent timing attacks.
   */
  protected safeCompareSignatures(a: string, b: string): boolean {
    // Normalize signatures (some webhooks include algorithm prefix)
    const normalizedA = a.replace(/^sha256=/, '')
    const normalizedB = b.replace(/^sha256=/, '')

    if (normalizedA.length !== normalizedB.length) {
      return false
    }

    return timingSafeEqual(Buffer.from(normalizedA), Buffer.from(normalizedB))
  }

  /**
   * Parse webhook payload into source items.
   * Must be implemented by subclasses that support webhooks.
   */
  parseWebhookPayload?(event: WebhookEvent): Promise<SourceItem[]>

  // ============ Schema Methods ============

  /**
   * Get Zod schema for validating source data.
   */
  getSourceSchema(entityType: string): z.ZodSchema | undefined {
    return this.sourceSchemas.get(entityType)
  }

  /**
   * Get mapper for transforming source data to canonical entities.
   */
  getMapper(entityType: string): EntityMapper | undefined {
    return this.mappers.get(entityType)
  }

  /**
   * Register an entity mapper.
   */
  protected registerMapper(mapper: EntityMapper): void {
    this.mappers.set(mapper.sourceEntityType, mapper)
  }

  /**
   * Register a source schema.
   */
  protected registerSchema(entityType: string, schema: z.ZodSchema): void {
    this.sourceSchemas.set(entityType, schema)
  }

  // ============ HTTP Helpers ============

  /**
   * Make an authenticated request.
   * Automatically adds Authorization header based on auth config.
   */
  protected async authenticatedRequest<T>(
    ctx: ConnectorContext,
    url: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      body?: unknown
      params?: Record<string, string | number | boolean | undefined>
      headers?: Record<string, string>
    } = {}
  ): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = {
      ...options.headers,
    }

    // Add authentication header
    if (ctx.accessToken) {
      if (this.authConfig.type === 'api_key') {
        const { headerName, headerPrefix } = this.authConfig
        headers[headerName] = headerPrefix
          ? `${headerPrefix} ${ctx.accessToken}`
          : ctx.accessToken
      } else {
        // OAuth2 or other token-based auth
        headers['Authorization'] = `Bearer ${ctx.accessToken}`
      }
    }

    const method = options.method ?? 'GET'
    const context: ConnectorErrorContext = {
      connector: this.type,
      operation: 'authenticated_request',
      accountId: ctx.accountId,
      url,
      metadata: { method },
    }

    try {
      const response = await this.http.request<T>(url, {
        method,
        body: options.body,
        params: options.params,
        headers,
      })

      context.statusCode = response.status
      context.durationMs = response.durationMs

      if (!response.ok) {
        this.logger.warn(`Request failed with status ${response.status}`, undefined, context)
      }

      return response
    } catch (error) {
      this.logger.error(`Request failed: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error : new Error(String(error)), context)
      throw error
    }
  }

  // ============ Utility Methods ============

  /**
   * Check if the connector supports a specific capability.
   */
  hasCapability(capability: keyof Omit<ConnectorCapabilities, 'supportedEntityTypes'>): boolean {
    return this.capabilities[capability] === true
  }

  /**
   * Check if the connector supports a specific entity type.
   */
  supportsEntityType(entityType: string): boolean {
    return this.capabilities.supportedEntityTypes.includes(entityType)
  }

  /**
   * Get HTTP client stats for monitoring.
   */
  getHttpStats(): ReturnType<ResilientHttpClient['getStats']> {
    return this.http.getStats()
  }
}

// ============ OAuth Token Response ============

/**
 * Standard OAuth2 token response.
 */
interface TokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

// ============ Connector Registry ============

/**
 * Registry for managing connector instances.
 */
export class ConnectorRegistry {
  private readonly connectors: Map<ConnectorType, Connector> = new Map()

  /**
   * Register a connector instance.
   */
  register(connector: Connector): void {
    if (this.connectors.has(connector.type)) {
      throw new Error(`Connector ${connector.type} is already registered`)
    }
    this.connectors.set(connector.type, connector)
  }

  /**
   * Get a registered connector.
   */
  get(type: ConnectorType): Connector | undefined {
    return this.connectors.get(type)
  }

  /**
   * Get a registered connector or throw.
   */
  getOrThrow(type: ConnectorType): Connector {
    const connector = this.connectors.get(type)
    if (!connector) {
      throw new Error(`Connector ${type} is not registered`)
    }
    return connector
  }

  /**
   * Check if a connector is registered.
   */
  has(type: ConnectorType): boolean {
    return this.connectors.has(type)
  }

  /**
   * Get all registered connector types.
   */
  types(): ConnectorType[] {
    return Array.from(this.connectors.keys())
  }

  /**
   * Get all registered connectors.
   */
  all(): Connector[] {
    return Array.from(this.connectors.values())
  }

  /**
   * Clear all registered connectors (for testing).
   */
  clear(): void {
    this.connectors.clear()
  }
}

/**
 * Global connector registry instance.
 */
export const connectorRegistry = new ConnectorRegistry()
