/**
 * Auth Registration
 *
 * Handles connector registration with OAuth flow and credential reuse.
 *
 * @module auth/registration
 */

import crypto from 'crypto'
import type { Connector } from '../connector/sdk/types.js'
import type { ConnectorType } from '../ids.js'
import type { AccountRepository } from '../db/repositories/account.js'
import type { AuthTokens } from '../connector/sdk/types.js'
import { AuthError } from '../errors/types.js'
import type { AuthProvider } from './provider.js'

// ============ Types ============

/**
 * Connector registration options.
 */
export interface ConnectorRegistrationOptions {
  /**
   * Account ID for credential reuse.
   * If provided, this connector will use the account's credentials.
   * If not provided, OAuth flow will be triggered.
   */
  accountId?: string
  /**
   * Force OAuth flow even if accountId is provided.
   * Useful for re-authorizing with different scopes.
   */
  forceOAuth?: boolean
}

/**
 * Result of connector registration.
 */
export interface ConnectorRegistrationResult {
  /** Registration successful */
  success: boolean
  /** Connector type */
  connectorType: ConnectorType
  /** Account ID (existing or newly created) */
  accountId: string
  /** Whether OAuth is required */
  requiresOAuth: boolean
  /** OAuth authorization URL (if OAuth required) */
  authUrl?: string
  /** State parameter for OAuth flow */
  authState?: string
  /** Error message if registration failed */
  error?: string
}

/**
 * OAuth callback result.
 */
export interface OAuthCallbackResult {
  /** Callback successful */
  success: boolean
  /** Account ID (newly created or updated) */
  accountId: string
  /** Error message if callback failed */
  error?: string
}

/**
 * Registration service configuration.
 */
export interface RegistrationServiceConfig {
  /**
   * Base URL for OAuth redirect.
   * Example: "https://myapp.com/oauth/callback"
   */
  redirectUri: string
  /**
   * Auth provider for credential management.
   */
  authProvider: AuthProvider
  /**
   * Account repository for account management.
   */
  accountRepo: AccountRepository
  /**
   * Connector registry for accessing connector instances.
   */
  getConnector: (type: ConnectorType) => Connector | undefined
}

/**
 * Pending OAuth state.
 */
interface PendingOAuth {
  connectorType: ConnectorType
  state: string
  createdAt: Date
  expiresAt: Date
}

// ============ Registration Service ============

/**
 * Service for managing connector registration and OAuth flows.
 *
 * Features:
 * - Determine if OAuth is required or credentials can be reused
 * - Generate OAuth authorization URLs with CSRF protection
 * - Handle OAuth callbacks and store credentials
 * - Support credential reuse across connector instances
 * - Manage pending OAuth states
 */
export class AuthRegistrationService {
  private readonly config: RegistrationServiceConfig
  private readonly pendingOAuthStates = new Map<string, PendingOAuth>()
  private readonly STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

  constructor(config: RegistrationServiceConfig) {
    this.config = config
  }

  /**
   * Register a connector.
   *
   * Determines if OAuth is required by checking:
   * 1. If accountId is provided and credentials exist
   * 2. If credentials have required scopes
   * 3. If forceOAuth is true
   *
   * @param connector - Connector to register
   * @param options - Registration options
   * @returns Registration result
   */
  async registerConnector(
    connector: Connector,
    options: ConnectorRegistrationOptions = {}
  ): Promise<ConnectorRegistrationResult> {
    const { accountId, forceOAuth = false } = options

    // Check if we can reuse existing credentials
    if (accountId && !forceOAuth) {
      const canReuse = await this.canReuseCredentials(accountId, connector)
      if (canReuse) {
        return {
          success: true,
          connectorType: connector.type,
          accountId,
          requiresOAuth: false,
        }
      }
    }

    // OAuth flow required
    return this.initiateOAuthFlow(connector)
  }

  /**
   * Handle OAuth callback.
   *
   * @param connectorType - Connector type
   * @param state - State parameter from callback
   * @param code - Authorization code from callback
   * @returns Callback result
   */
  async handleOAuthCallback(
    connectorType: ConnectorType,
    state: string,
    code: string
  ): Promise<OAuthCallbackResult> {
    // Verify state
    const pending = this.pendingOAuthStates.get(state)
    if (!pending) {
      return {
        success: false,
        accountId: '',
        error: 'Invalid or expired OAuth state',
      }
    }

    if (pending.connectorType !== connectorType) {
      this.pendingOAuthStates.delete(state)
      return {
        success: false,
        accountId: '',
        error: 'Connector type mismatch',
      }
    }

    if (pending.expiresAt < new Date()) {
      this.pendingOAuthStates.delete(state)
      return {
        success: false,
        accountId: '',
        error: 'OAuth state expired',
      }
    }

    // Get connector
    const connector = this.config.getConnector(connectorType)
    if (!connector) {
      return {
        success: false,
        accountId: '',
        error: `Connector ${connectorType} not found`,
      }
    }

    if (!connector.exchangeCodeForTokens) {
      return {
        success: false,
        accountId: '',
        error: `Connector ${connectorType} does not support OAuth`,
      }
    }

    try {
      // Exchange code for tokens
      const tokens = await connector.exchangeCodeForTokens(
        code,
        this.config.redirectUri
      )

      // Store credentials
      const accountId = await this.storeCredentials(connectorType, tokens)

      // Clean up state
      this.pendingOAuthStates.delete(state)

      return {
        success: true,
        accountId,
      }
    } catch (error) {
      this.pendingOAuthStates.delete(state)
      return {
        success: false,
        accountId: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Create a credential reference (reuse existing credentials).
   *
   * @param accountId - Account ID that holds credentials to reuse
   * @param additionalScopes - Additional scopes beyond what the original account has
   * @returns Account ID for credential reference
   */
  async createCredentialReference(
    accountId: string,
    additionalScopes: string[] = []
  ): Promise<string> {
    // Verify source account has credentials
    const hasCreds = await this.config.authProvider.hasCredentials(accountId)
    if (!hasCreds) {
      throw new AuthError(`Source account ${accountId} has no credentials`)
    }

    // Get source account info
    const sourceAccount = await this.config.accountRepo.findById(accountId)
    if (!sourceAccount) {
      throw new AuthError(`Source account ${accountId} not found`)
    }

    // Verify scopes
    const hasRequiredScopes = await this.config.authProvider.verifyScopes(
      accountId,
      additionalScopes
    )
    if (!hasRequiredScopes) {
      throw new AuthError(
        `Source account ${accountId} lacks required scopes: ${additionalScopes.join(', ')}`
      )
    }

    // Create new account with credential reference
    const newAccount = await this.config.accountRepo.create({
      connector: sourceAccount.connector,
      external_account_id: sourceAccount.external_account_id,
      display_name: `${sourceAccount.display_name} (Shared)`,
      email: sourceAccount.email,
      auth_type: sourceAccount.auth_type,
    })

    return newAccount.id
  }

  /**
   * Clean up expired OAuth states.
   */
  cleanupExpiredStates(): void {
    const now = new Date()
    for (const [state, pending] of this.pendingOAuthStates.entries()) {
      if (pending.expiresAt < now) {
        this.pendingOAuthStates.delete(state)
      }
    }
  }

  // ============ Private Methods ============

  /**
   * Check if credentials can be reused.
   */
  private async canReuseCredentials(
    accountId: string,
    connector: Connector
  ): Promise<boolean> {
    // Check if account has credentials
    const hasCreds = await this.config.authProvider.hasCredentials(accountId)
    if (!hasCreds) {
      return false
    }

    // Check if connector has required scopes
    if (connector.authConfig.type === 'oauth2') {
      const hasScopes = await this.config.authProvider.verifyScopes(
        accountId,
        connector.authConfig.scopes
      )
      if (!hasScopes) {
        return false
      }
    }

    return true
  }

  /**
   * Initiate OAuth flow by generating authorization URL.
   */
  private async initiateOAuthFlow(
    connector: Connector
  ): Promise<ConnectorRegistrationResult> {
    if (!connector.getAuthorizationUrl) {
      return {
        success: false,
        connectorType: connector.type,
        accountId: '',
        requiresOAuth: false,
        error: `Connector ${connector.type} does not support OAuth`,
      }
    }

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + this.STATE_TTL_MS)

    // Store pending OAuth
    this.pendingOAuthStates.set(state, {
      connectorType: connector.type,
      state,
      createdAt: new Date(),
      expiresAt,
    })

    // Generate authorization URL
    const authUrl = connector.getAuthorizationUrl(state, this.config.redirectUri)

    return {
      success: true,
      connectorType: connector.type,
      accountId: '',
      requiresOAuth: true,
      authUrl,
      authState: state,
    }
  }

  /**
   * Store credentials after OAuth callback.
   */
  private async storeCredentials(
    connectorType: ConnectorType,
    tokens: AuthTokens
  ): Promise<string> {
    // Create account record
    const account = await this.config.accountRepo.create({
      connector: connectorType,
      external_account_id: 'user',  // Will be updated after listAccounts
      auth_type: 'oauth2',
    })

    // Store encrypted credentials
    await this.config.authProvider.storeCredentials(account.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    })

    return account.id
  }
}

// ============ Factory ============

/**
 * Create a registration service.
 */
export function createRegistrationService(
  config: RegistrationServiceConfig
): AuthRegistrationService {
  const service = new AuthRegistrationService(config)

  // Start cleanup interval
  setInterval(() => service.cleanupExpiredStates(), 60 * 1000).unref()

  return service
}
