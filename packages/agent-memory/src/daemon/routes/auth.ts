/**
 * Auth Routes
 *
 * HTTP endpoints for OAuth authentication flows.
 * Uses centralized OAuth providers for credential management.
 */

import { randomBytes } from 'crypto'
import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'
import type { OAuthProviderId } from '../../auth/oauth-providers.js'

// In-memory state storage (in production, use Redis or database)
const pendingStates = new Map<string, {
  connector: string
  provider: OAuthProviderId
  scopes: string[]
  redirectUri: string
  createdAt: Date
}>()

// Clean up old states periodically (15 minute expiry)
const STATE_EXPIRY_MS = 15 * 60 * 1000

function cleanupStates(): void {
  const now = Date.now()
  for (const [state, data] of pendingStates) {
    if (now - data.createdAt.getTime() > STATE_EXPIRY_MS) {
      pendingStates.delete(state)
    }
  }
}

setInterval(cleanupStates, 60000) // Clean up every minute

export function registerAuthRoutes(server: HttpServer, daemon: SyncDaemon): void {
  // List available OAuth providers
  server.get('/auth/providers', async () => {
    const providers = daemon.oauthProviders.list()
    return { body: { providers } }
  })

  // Get OAuth authorization URL
  server.get('/auth/:connector/url', async (req) => {
    const { connector } = req.params
    const { redirectUri } = req.query

    if (!redirectUri) {
      throw badRequest('Missing required query parameter: redirectUri')
    }

    const connectorInstance = daemon.getConnector(connector as any)
    if (!connectorInstance) {
      throw notFound(`Connector not found: ${connector}`)
    }

    // Check if connector uses provider-based auth
    const authConfig = connectorInstance.authConfig
    if (!authConfig || (authConfig.type !== 'oauth2_provider' && authConfig.type !== 'oauth2')) {
      throw badRequest(`Connector ${connector} does not support OAuth`)
    }

    // Generate state for CSRF protection
    const state = randomBytes(32).toString('hex')

    let url: string
    let provider: OAuthProviderId
    let scopes: string[]

    if (authConfig.type === 'oauth2_provider') {
      // Use centralized provider
      provider = authConfig.provider
      scopes = authConfig.scopes

      if (!daemon.oauthProviders.has(provider)) {
        throw badRequest(
          `OAuth provider '${provider}' is not configured. ` +
          `Set ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET environment variables.`
        )
      }

      url = daemon.oauthProviders.getAuthorizationUrl(provider, scopes, state, redirectUri)
    } else {
      // Legacy: connector has its own credentials
      if (!connectorInstance.getAuthorizationUrl) {
        throw badRequest(`Connector ${connector} does not implement getAuthorizationUrl`)
      }
      url = connectorInstance.getAuthorizationUrl(state, redirectUri)
      provider = 'google' as OAuthProviderId // fallback, won't be used
      scopes = authConfig.scopes
    }

    // Store state for validation
    pendingStates.set(state, {
      connector,
      provider,
      scopes,
      redirectUri,
      createdAt: new Date(),
    })

    return { body: { url, state, provider } }
  })

  // Handle OAuth callback (POST - for CLI/programmatic use)
  server.post('/auth/:connector/callback', async (req) => {
    const { connector } = req.params
    const body = req.body as {
      code?: string
      state?: string
      redirectUri?: string
    }

    if (!body.code || !body.state || !body.redirectUri) {
      throw badRequest('Missing required fields: code, state, redirectUri')
    }

    // Validate state
    const pending = pendingStates.get(body.state)
    if (!pending) {
      throw badRequest('Invalid or expired state parameter')
    }

    if (pending.connector !== connector) {
      throw badRequest('State parameter does not match connector')
    }

    if (pending.redirectUri !== body.redirectUri) {
      throw badRequest('Redirect URI does not match')
    }

    // Clean up state
    pendingStates.delete(body.state)

    const connectorInstance = daemon.getConnector(connector as any)
    if (!connectorInstance) {
      throw notFound(`Connector not found: ${connector}`)
    }

    // Exchange code for tokens using the provider
    const authConfig = connectorInstance.authConfig
    let tokens: { accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }

    if (authConfig?.type === 'oauth2_provider') {
      // Use centralized provider for token exchange
      tokens = await daemon.oauthProviders.exchangeCode(
        pending.provider,
        body.code,
        body.redirectUri
      )
    } else {
      // Legacy: connector handles its own token exchange
      const account = await daemon.handleAuthCallback(
        connector as any,
        body.code,
        body.redirectUri
      )
      return { body: { account } }
    }

    // Create account with tokens
    const account = await daemon.createAccountWithTokens(
      connector as any,
      tokens,
      pending.scopes
    )

    return { body: { account } }
  })

  // Handle OAuth callback (GET - for browser redirect)
  // This is called when Google redirects back to our app
  server.get('/auth/callback', async (req) => {
    const { code, state, error, error_description } = req.query

    // Handle OAuth errors
    if (error) {
      return {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
        rawBody: `<!DOCTYPE html>
<html><head><title>OAuth Error</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
  <h1 style="color: #dc2626;">Authentication Failed</h1>
  <p><strong>Error:</strong> ${error}</p>
  <p>${error_description || 'The authentication request was denied or failed.'}</p>
  <p>You can close this window.</p>
</body></html>`,
      }
    }

    if (!code || !state) {
      return {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
        rawBody: `<!DOCTYPE html>
<html><head><title>OAuth Error</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
  <h1 style="color: #dc2626;">Invalid Callback</h1>
  <p>Missing required parameters (code or state).</p>
</body></html>`,
      }
    }

    // Validate state
    const pending = pendingStates.get(state)
    if (!pending) {
      return {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
        rawBody: `<!DOCTYPE html>
<html><head><title>OAuth Error</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
  <h1 style="color: #dc2626;">Invalid State</h1>
  <p>The state parameter is invalid or expired. Please try the OAuth flow again.</p>
</body></html>`,
      }
    }

    // Clean up state
    pendingStates.delete(state)

    const connectorInstance = daemon.getConnector(pending.connector as any)
    if (!connectorInstance) {
      return {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
        rawBody: `<!DOCTYPE html>
<html><head><title>OAuth Error</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
  <h1 style="color: #dc2626;">Connector Not Found</h1>
  <p>Connector "${pending.connector}" is not registered.</p>
</body></html>`,
      }
    }

    try {
      // Exchange code for tokens
      const authConfig = connectorInstance.authConfig
      let account

      if (authConfig?.type === 'oauth2_provider') {
        const tokens = await daemon.oauthProviders.exchangeCode(
          pending.provider,
          code,
          pending.redirectUri
        )
        account = await daemon.createAccountWithTokens(
          pending.connector as any,
          tokens,
          pending.scopes
        )
      } else {
        account = await daemon.handleAuthCallback(
          pending.connector as any,
          code,
          pending.redirectUri
        )
      }

      return {
        headers: { 'Content-Type': 'text/html' },
        rawBody: `<!DOCTYPE html>
<html><head><title>OAuth Success</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
  <h1 style="color: #16a34a;">Authentication Successful!</h1>
  <p>Account connected: <strong>${account.email || account.display_name || account.id}</strong></p>
  <p>Connector: ${account.connector}</p>
  <p>Account ID: <code style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${account.id}</code></p>
  <p style="margin-top: 20px;">You can close this window and return to the CLI.</p>
</body></html>`,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
        rawBody: `<!DOCTYPE html>
<html><head><title>OAuth Error</title></head>
<body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
  <h1 style="color: #dc2626;">Authentication Failed</h1>
  <p>${message}</p>
  <p>Please try again.</p>
</body></html>`,
      }
    }
  })

  // Refresh token for an account
  server.post('/auth/refresh/:accountId', async (req) => {
    const { accountId } = req.params

    await daemon.authProvider.refreshIfNeeded(accountId)

    return { body: { success: true } }
  })

  // Check if account has valid credentials
  server.get('/auth/status/:accountId', async (req) => {
    const { accountId } = req.params

    const hasCredentials = await daemon.authProvider.hasCredentials(accountId)

    return { body: { accountId, hasCredentials } }
  })
}
