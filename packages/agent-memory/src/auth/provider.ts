/**
 * Auth Provider
 *
 * Provides authentication context for connectors by fetching and decrypting
 * credentials from the database.
 *
 * @module auth/provider
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto'
import type { Sql } from 'postgres'
import type { ConnectorContext } from '../connector/sdk/types.js'
import type { ConnectorType } from '../ids.js'
import type {
  AccountRepository,
  AccountCredentials,
} from '../db/repositories/account.js'
import { AuthError } from '../errors/types.js'
import type { OAuthProviderRegistry } from './oauth-providers.js'

// ============ Types ============

/**
 * Auth provider configuration.
 */
export interface AuthProviderConfig {
  /**
   * Encryption key (32 bytes).
   * Provide via KMS, environment variable, or secret management service.
   */
  encryptionKey: Buffer
  /**
   * Account repository for credential storage.
   */
  accountRepo: AccountRepository
  /**
   * Connector registry for token refresh.
   */
  getConnector: (type: ConnectorType) => {
    refreshTokens?: (refreshToken: string) => Promise<{
      accessToken: string
      refreshToken?: string
      expiresAt?: Date
    }>
    authConfig?: {
      type: 'oauth2' | 'oauth2_provider' | 'api_key' | 'local' | 'credential_reference'
      provider?: 'google' | 'github' | 'microsoft' | 'slack' | 'twitter'
    }
  } | undefined
  /**
   * OAuth provider registry for provider-based token refresh.
   */
  oauthProviders?: OAuthProviderRegistry
}

/**
 * Auth provider interface.
 * Responsible for fetching and decrypting credentials for connectors.
 */
export interface AuthProvider {
  /**
   * Get connector context with credentials for an account.
   * @param accountId - Account ID to get credentials for
   * @param additionalScopes - Optional additional scopes (for credential reuse)
   */
  getContext(
    accountId: string,
    additionalScopes?: string[]
  ): Promise<ConnectorContext>

  /**
   * Refresh expired access token.
   * @param accountId - Account ID to refresh token for
   */
  refreshIfNeeded(accountId: string): Promise<void>

  /**
   * Check if account has credentials.
   * @param accountId - Account ID to check
   */
  hasCredentials(accountId: string): Promise<boolean>

  /**
   * Verify that credentials cover required scopes.
   * @param accountId - Account ID to verify
   * @param requiredScopes - Scopes required by connector
   */
  verifyScopes(accountId: string, requiredScopes: string[]): Promise<boolean>

  /**
   * Store encrypted credentials for an account.
   * @param accountId - Account ID to store credentials for
   * @param credentials - Credentials to encrypt and store
   */
  storeCredentials(
    accountId: string,
    credentials: {
      accessToken: string
      refreshToken?: string
      expiresAt?: Date
    }
  ): Promise<void>

  /**
   * Get decrypted credentials for an account.
   * Used for credential sharing between connectors using the same OAuth provider.
   * @param accountId - Account ID to get credentials for
   */
  getCredentials(accountId: string): Promise<{
    accessToken: string
    refreshToken?: string
    expiresAt?: Date
  } | null>
}

/**
 * Cached credentials with metadata.
 */
interface CachedCredentials {
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  grantedScopes: string[]
  cachedAt: Date
}

/**
 * Encryption result.
 */
export interface EncryptionResult {
  encrypted: Buffer
  iv: Buffer
  authTag: Buffer
}

// ============ Constants ============

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ============ Auth Provider ============

/**
 * Database-backed auth provider.
 *
 * Features:
 * - Credential encryption using AES-256-GCM
 * - Automatic token refresh
 * - Credential caching to reduce database load
 * - Scope verification
 */
export class DatabaseAuthProvider implements AuthProvider {
  private readonly config: AuthProviderConfig
  private readonly credentialCache = new Map<string, CachedCredentials>()

  constructor(config: AuthProviderConfig) {
    this.config = config
  }

  /**
   * Get connector context with credentials for an account.
   * @param accountId - Account ID to get credentials for
   * @param additionalScopes - Optional additional scopes (for credential reuse)
   */
  async getContext(
    accountId: string,
    additionalScopes: string[] = []
  ): Promise<ConnectorContext> {
    // Check cache first
    const cached = this.credentialCache.get(accountId)
    if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
      // Check if cached credentials are about to expire
      const expiresSoon = cached.expiresAt
        ? cached.expiresAt.getTime() < Date.now() + 5 * 60 * 1000
        : false

      if (!expiresSoon) {
        return {
          accountId,
          accessToken: cached.accessToken,
        }
      }

      // Refresh expired token
      await this.refreshIfNeeded(accountId)
    }

    // Fetch credentials from database
    const creds = await this.fetchCredentials(accountId)
    if (!creds) {
      throw new AuthError(`No credentials found for account: ${accountId}`)
    }

    // Decrypt access token
    const accessToken = this.decrypt(
      creds.credentials_encrypted,
      creds.credentials_iv
    )

    // Check expiration and refresh if needed
    if (creds.token_expires_at && creds.token_expires_at < new Date()) {
      const refreshed = await this.refresh(accountId)
      return refreshed
    }

    // Cache credentials
    this.credentialCache.set(accountId, {
      accessToken,
      refreshToken: creds.refresh_token_encrypted
        ? this.decryptRefreshToken(creds.refresh_token_encrypted!)
        : undefined,
      expiresAt: creds.token_expires_at ?? undefined,
      grantedScopes: [],
      cachedAt: new Date(),
    })

    return {
      accountId,
      accessToken,
    }
  }

  /**
   * Refresh expired access token.
   * @param accountId - Account ID to refresh token for
   */
  async refreshIfNeeded(accountId: string): Promise<void> {
    const cached = this.credentialCache.get(accountId)
    if (cached?.expiresAt && cached.expiresAt < new Date(Date.now() + 5 * 60 * 1000)) {
      await this.refresh(accountId)
      return
    }

    // Fetch from database to check expiration
    const creds = await this.fetchCredentials(accountId)
    if (creds?.token_expires_at && creds.token_expires_at < new Date(Date.now() + 5 * 60 * 1000)) {
      await this.refresh(accountId)
    }
  }

  /**
   * Force refresh of credentials.
   * @param accountId - Account ID to refresh token for
   */
  async refresh(accountId: string): Promise<ConnectorContext> {
    // Get credentials from DB (needed for connector_type and as fallback for refresh token)
    const creds = await this.fetchCredentials(accountId)
    if (!creds) {
      throw new AuthError(`Account not found: ${accountId}`)
    }

    // Resolve refresh token: prefer cache, fall back to database
    const cached = this.credentialCache.get(accountId)
    const refreshTokenValue = cached?.refreshToken
      ?? (creds.refresh_token_encrypted
        ? this.decryptRefreshToken(creds.refresh_token_encrypted)
        : undefined)

    if (!refreshTokenValue) {
      throw new AuthError(`No refresh token available for account: ${accountId}`)
    }

    if (!creds.connector_type) {
      throw new AuthError(`Account ${accountId} has no connector type`)
    }

    const connector = this.config.getConnector(creds.connector_type)
    if (!connector) {
      throw new AuthError(`Connector ${creds.connector_type} not registered`)
    }

    let refreshed: { accessToken: string; refreshToken?: string; expiresAt?: Date }
    if (connector.authConfig?.type === 'oauth2_provider') {
      const provider = connector.authConfig.provider
      if (!provider) {
        throw new AuthError(`Connector ${creds.connector_type} missing OAuth provider`)
      }
      if (!this.config.oauthProviders) {
        throw new AuthError('OAuth provider registry is not configured')
      }
      const result = await this.config.oauthProviders.refreshToken(provider, refreshTokenValue)
      refreshed = {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresIn
          ? new Date(Date.now() + result.expiresIn * 1000)
          : undefined,
      }
    } else if (connector.refreshTokens) {
      refreshed = await connector.refreshTokens(refreshTokenValue)
    } else {
      throw new AuthError(`Connector ${creds.connector_type} does not support token refresh`)
    }

    // Update stored credentials
    await this.storeCredentials(accountId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? refreshTokenValue,
      expiresAt: refreshed.expiresAt,
    })

    // Clear cache
    this.credentialCache.delete(accountId)

    // Return new context
    return {
      accountId,
      accessToken: refreshed.accessToken,
    }
  }

  /**
   * Check if account has credentials.
   * @param accountId - Account ID to check
   */
  async hasCredentials(accountId: string): Promise<boolean> {
    const creds = await this.fetchCredentials(accountId)
    return creds !== null
  }

  /**
   * Verify that credentials cover required scopes.
   * @param accountId - Account ID to verify
   * @param requiredScopes - Scopes required by connector
   */
  async verifyScopes(accountId: string, requiredScopes: string[]): Promise<boolean> {
    // For now, we assume scopes are correct if credentials exist
    // In a full implementation, we'd track granted_scopes in the database
    return requiredScopes.length === 0
  }

  /**
   * Store encrypted credentials for an account.
   * @param accountId - Account ID to store credentials for
   * @param credentials - Credentials to encrypt and store
   */
  async storeCredentials(
    accountId: string,
    credentials: {
      accessToken: string
      refreshToken?: string
      expiresAt?: Date
    }
  ): Promise<void> {
    const encrypted = this.encrypt(credentials.accessToken)

    const update: {
      credentials_encrypted: Buffer
      credentials_iv: Buffer
      refresh_token_encrypted?: Buffer
      token_expires_at?: Date
    } = {
      credentials_encrypted: encrypted.encrypted,
      credentials_iv: encrypted.iv,
    }

    if (credentials.refreshToken) {
      const encryptedRefresh = this.encrypt(credentials.refreshToken)
      // Prepend IV so refresh token blob is self-contained: [IV (16)][ciphertext][authTag (16)]
      update.refresh_token_encrypted = Buffer.concat([encryptedRefresh.iv, encryptedRefresh.encrypted])
    }

    if (credentials.expiresAt) {
      update.token_expires_at = credentials.expiresAt
    }

    await this.config.accountRepo.updateCredentials(accountId, update)

    // Clear cache
    this.credentialCache.delete(accountId)
  }

  /**
   * Get decrypted credentials for an account.
   * Used for credential sharing between connectors using the same OAuth provider.
   * @param accountId - Account ID to get credentials for
   */
  async getCredentials(accountId: string): Promise<{
    accessToken: string
    refreshToken?: string
    expiresAt?: Date
  } | null> {
    const creds = await this.fetchCredentials(accountId)
    if (!creds) {
      return null
    }

    const accessToken = this.decrypt(creds.credentials_encrypted, creds.credentials_iv)
    const refreshToken = creds.refresh_token_encrypted
      ? this.decryptRefreshToken(creds.refresh_token_encrypted)
      : undefined

    return {
      accessToken,
      refreshToken,
      expiresAt: creds.token_expires_at ?? undefined,
    }
  }

  /**
   * Clear cached credentials for an account.
   * @param accountId - Account ID to clear cache for
   */
  clearCache(accountId: string): void {
    this.credentialCache.delete(accountId)
  }

  /**
   * Clear all cached credentials.
   */
  clearAllCache(): void {
    this.credentialCache.clear()
  }

  // ============ Private Methods ============

  /**
   * Fetch credentials from database.
   */
  private async fetchCredentials(accountId: string): Promise<AccountCredentials | null> {
    const creds = await this.config.accountRepo.getCredentials(accountId)

    if (!creds || !creds.credentials_encrypted || !creds.credentials_iv) {
      return null
    }

    return creds as AccountCredentials
  }

  /**
   * Encrypt plaintext using AES-256-GCM.
   * Auth tag is appended to the encrypted buffer.
   */
  private encrypt(plaintext: string): EncryptionResult {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, this.config.encryptionKey, iv)

    let encrypted = cipher.update(plaintext, 'utf8')
    encrypted = Buffer.concat([encrypted, cipher.final()])
    const authTag = cipher.getAuthTag()

    // Append auth tag to encrypted data for storage
    const encryptedWithTag = Buffer.concat([encrypted, authTag])

    return { encrypted: encryptedWithTag, iv, authTag }
  }

  /**
   * Decrypt ciphertext using AES-256-GCM.
   * Expects auth tag appended to the encrypted buffer.
   */
  private decrypt(encrypted: Buffer, iv: Buffer): string {
    // Extract auth tag from end of encrypted buffer
    const authTag = encrypted.subarray(encrypted.length - AUTH_TAG_LENGTH)
    const ciphertext = encrypted.subarray(0, encrypted.length - AUTH_TAG_LENGTH)

    const decipher = createDecipheriv(ALGORITHM, this.config.encryptionKey, iv)
    decipher.setAuthTag(authTag)

    let decrypted = decipher.update(ciphertext)
    decrypted = Buffer.concat([decrypted, decipher.final()])

    return decrypted.toString('utf8')
  }

  /**
   * Decrypt refresh token blob which has IV prepended: [IV (16)][ciphertext][authTag (16)]
   */
  private decryptRefreshToken(blob: Buffer): string {
    const iv = blob.subarray(0, IV_LENGTH)
    const encrypted = blob.subarray(IV_LENGTH)
    return this.decrypt(encrypted, iv)
  }
}

// ============ Key Derivation ============

/**
 * Derive a 32-byte encryption key from a passphrase.
 * Uses scrypt with appropriate parameters for security.
 *
 * @param passphrase - Passphrase to derive key from
 * @param salt - Salt for key derivation (16 bytes, must be stored with encrypted data)
 * @returns 32-byte encryption key
 */
export async function deriveKey(
  passphrase: string,
  salt: Buffer
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

/**
 * Generate a random salt for key derivation.
 */
export function generateSalt(): Buffer {
  return randomBytes(16)
}

// ============ Factory ============

/**
 * Create an auth provider from configuration.
 */
export function createAuthProvider(config: AuthProviderConfig): DatabaseAuthProvider {
  return new DatabaseAuthProvider(config)
}

/**
 * Create an auth provider with environment-based encryption key.
 * Reads CREDENTIAL_ENCRYPTION_KEY environment variable (must be 32-byte hex string).
 */
export async function createAuthProviderFromEnv(
  accountRepo: AccountRepository,
  getConnector: (type: ConnectorType) => {
    refreshTokens?: (refreshToken: string) => Promise<{
      accessToken: string
      refreshToken?: string
      expiresAt?: Date
    }>
  } | undefined
): Promise<DatabaseAuthProvider> {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!keyHex) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY environment variable is required')
  }

  const key = Buffer.from(keyHex, 'hex')
  if (key.length !== KEY_LENGTH) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY must be ${KEY_LENGTH} bytes (64 hex chars)`)
  }

  return createAuthProvider({
    encryptionKey: key,
    accountRepo,
    getConnector,
  })
}
