/**
 * OAuth Provider Registry
 *
 * Centralizes OAuth2 client credentials by provider (Google, GitHub, Microsoft, etc.)
 * Connectors reference a provider rather than defining their own credentials.
 *
 * This allows:
 * - Single set of Google credentials for Gmail, Calendar, Drive, etc.
 * - Environment variables defined once per provider
 * - Scope aggregation across connectors using the same provider
 */

import { z } from 'zod'

// ============ Types ============

export const OAuthProviderIdSchema = z.enum([
  'google',
  'github',
  'microsoft',
  'slack',
  'twitter',
])

export type OAuthProviderId = z.infer<typeof OAuthProviderIdSchema>

/**
 * OAuth provider configuration.
 * Defines the OAuth2 endpoints and client credentials for a provider.
 */
export interface OAuthProviderConfig {
  /** Provider identifier */
  id: OAuthProviderId
  /** Display name */
  displayName: string
  /** Authorization endpoint */
  authorizationUrl: string
  /** Token endpoint */
  tokenUrl: string
  /** Device authorization endpoint (for CLI/headless flows) */
  deviceAuthUrl?: string
  /** Client ID (from environment) */
  clientId: string
  /** Client secret (from environment) */
  clientSecret: string
  /** Additional authorization parameters */
  authParams?: Record<string, string>
}

// ============ Provider Definitions ============

/**
 * Well-known OAuth provider configurations.
 * Client credentials are loaded from environment variables.
 */
export const OAUTH_PROVIDERS: Record<OAuthProviderId, Omit<OAuthProviderConfig, 'clientId' | 'clientSecret'>> = {
  google: {
    id: 'google',
    displayName: 'Google',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    deviceAuthUrl: 'https://oauth2.googleapis.com/device/code',
    authParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
  github: {
    id: 'github',
    displayName: 'GitHub',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
  },
  microsoft: {
    id: 'microsoft',
    displayName: 'Microsoft',
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  },
  slack: {
    id: 'slack',
    displayName: 'Slack',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
  },
  twitter: {
    id: 'twitter',
    displayName: 'Twitter/X',
    authorizationUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    authParams: {
      code_challenge_method: 'S256',
    },
  },
}

// ============ Registry ============

/**
 * OAuth Provider Registry.
 * Loads credentials from environment and provides configured providers.
 */
export class OAuthProviderRegistry {
  private providers: Map<OAuthProviderId, OAuthProviderConfig> = new Map()

  /**
   * Load a provider with credentials from environment variables.
   * Environment variable format: {PROVIDER}_CLIENT_ID, {PROVIDER}_CLIENT_SECRET
   */
  loadFromEnv(providerId: OAuthProviderId): OAuthProviderConfig | null {
    const base = OAUTH_PROVIDERS[providerId]
    if (!base) return null

    const envPrefix = providerId.toUpperCase()
    const clientId = process.env[`${envPrefix}_CLIENT_ID`]
    const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`]

    if (!clientId || !clientSecret) {
      return null
    }

    const config: OAuthProviderConfig = {
      ...base,
      clientId,
      clientSecret,
    }

    this.providers.set(providerId, config)
    return config
  }

  /**
   * Load all available providers from environment.
   */
  loadAllFromEnv(): OAuthProviderId[] {
    const loaded: OAuthProviderId[] = []

    for (const providerId of Object.keys(OAUTH_PROVIDERS) as OAuthProviderId[]) {
      if (this.loadFromEnv(providerId)) {
        loaded.push(providerId)
      }
    }

    return loaded
  }

  /**
   * Manually register a provider with explicit credentials.
   */
  register(config: OAuthProviderConfig): void {
    this.providers.set(config.id, config)
  }

  /**
   * Get a registered provider.
   */
  get(providerId: OAuthProviderId): OAuthProviderConfig | undefined {
    return this.providers.get(providerId)
  }

  /**
   * Get a provider or throw if not configured.
   */
  getOrThrow(providerId: OAuthProviderId): OAuthProviderConfig {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(
        `OAuth provider '${providerId}' is not configured. ` +
        `Set ${providerId.toUpperCase()}_CLIENT_ID and ${providerId.toUpperCase()}_CLIENT_SECRET environment variables.`
      )
    }
    return provider
  }

  /**
   * Check if a provider is configured.
   */
  has(providerId: OAuthProviderId): boolean {
    return this.providers.has(providerId)
  }

  /**
   * List all configured providers.
   */
  list(): OAuthProviderId[] {
    return Array.from(this.providers.keys())
  }

  /**
   * Generate authorization URL for a provider with specific scopes.
   */
  getAuthorizationUrl(
    providerId: OAuthProviderId,
    scopes: string[],
    state: string,
    redirectUri: string
  ): string {
    const provider = this.getOrThrow(providerId)

    const url = new URL(provider.authorizationUrl)
    url.searchParams.set('client_id', provider.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)

    if (scopes.length > 0) {
      url.searchParams.set('scope', scopes.join(' '))
    }

    // Add provider-specific auth params
    if (provider.authParams) {
      for (const [key, value] of Object.entries(provider.authParams)) {
        url.searchParams.set(key, value)
      }
    }

    return url.toString()
  }

  /**
   * Exchange authorization code for tokens.
   */
  async exchangeCode(
    providerId: OAuthProviderId,
    code: string,
    redirectUri: string
  ): Promise<{
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    scope?: string
  }> {
    const provider = this.getOrThrow(providerId)

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: redirectUri,
    })

    const response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('[OAuthProvider] Token exchange failed:', response.status, error)
      throw new Error(`Token exchange failed: ${error}`)
    }

    console.log('[OAuthProvider] Token exchange successful')
    const data = await response.json() as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      scope: data.scope,
    }
  }

  /**
   * Refresh an access token.
   */
  async refreshToken(
    providerId: OAuthProviderId,
    refreshToken: string
  ): Promise<{
    accessToken: string
    refreshToken?: string
    expiresIn?: number
  }> {
    const provider = this.getOrThrow(providerId)

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      refresh_token: refreshToken,
    })

    const response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Token refresh failed: ${error}`)
    }

    const data = await response.json() as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    }
  }

  /**
   * Check if provider supports device authorization flow.
   */
  supportsDeviceAuth(providerId: OAuthProviderId): boolean {
    const provider = this.providers.get(providerId)
    return !!provider?.deviceAuthUrl
  }

  /**
   * Initiate device authorization flow.
   * Returns codes for user to enter at verification URL.
   * Uses separate device client credentials if available (PROVIDER_DEVICE_CLIENT_ID).
   */
  async initiateDeviceAuth(
    providerId: OAuthProviderId,
    scopes: string[]
  ): Promise<{
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
    expiresIn: number
    interval: number
  }> {
    const provider = this.getOrThrow(providerId)

    if (!provider.deviceAuthUrl) {
      throw new Error(`Provider '${providerId}' does not support device authorization flow`)
    }

    // Use device-specific credentials if available
    const envPrefix = providerId.toUpperCase()
    const deviceClientId = process.env[`${envPrefix}_DEVICE_CLIENT_ID`] || provider.clientId

    const body = new URLSearchParams({
      client_id: deviceClientId,
      scope: scopes.join(' '),
    })

    const response = await fetch(provider.deviceAuthUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Device auth initiation failed: ${error}`)
    }

    const data = await response.json() as {
      device_code: string
      user_code: string
      verification_uri: string
      verification_uri_complete?: string
      expires_in: number
      interval: number
    }

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      expiresIn: data.expires_in,
      interval: data.interval,
    }
  }

  /**
   * Poll for device authorization completion.
   * Call this repeatedly until it returns tokens or throws.
   * Uses separate device client credentials if available (PROVIDER_DEVICE_CLIENT_ID).
   */
  async pollDeviceAuth(
    providerId: OAuthProviderId,
    deviceCode: string
  ): Promise<{
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    scope?: string
  } | { pending: true }> {
    const provider = this.getOrThrow(providerId)

    // Use device-specific credentials if available
    const envPrefix = providerId.toUpperCase()
    const deviceClientId = process.env[`${envPrefix}_DEVICE_CLIENT_ID`] || provider.clientId
    const deviceClientSecret = process.env[`${envPrefix}_DEVICE_CLIENT_SECRET`] || provider.clientSecret

    const body = new URLSearchParams({
      client_id: deviceClientId,
      client_secret: deviceClientSecret,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })

    const response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    })

    const data = await response.json() as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      scope?: string
      error?: string
      error_description?: string
    }

    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      return { pending: true }
    }

    if (data.error) {
      throw new Error(`Device auth failed: ${data.error_description || data.error}`)
    }

    if (!data.access_token) {
      throw new Error('Device auth response missing access_token')
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      scope: data.scope,
    }
  }
}

// ============ Singleton ============

/**
 * Global OAuth provider registry instance.
 */
export const oauthProviders = new OAuthProviderRegistry()
