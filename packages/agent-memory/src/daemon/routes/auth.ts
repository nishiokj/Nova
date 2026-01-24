/**
 * Auth Routes
 *
 * HTTP endpoints for OAuth authentication flows.
 */

import { randomBytes } from 'crypto'
import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'

// In-memory state storage (in production, use Redis or database)
const pendingStates = new Map<string, { connector: string; redirectUri: string; createdAt: Date }>()

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

    if (!connectorInstance.getAuthorizationUrl) {
      throw badRequest(`Connector ${connector} does not support OAuth`)
    }

    // Generate state for CSRF protection
    const state = randomBytes(32).toString('hex')

    // Store state for validation
    pendingStates.set(state, {
      connector,
      redirectUri,
      createdAt: new Date(),
    })

    // Get authorization URL
    const url = connectorInstance.getAuthorizationUrl(state, redirectUri)

    return { body: { url, state } }
  })

  // Handle OAuth callback
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

    // Exchange code for tokens and create account
    const account = await daemon.handleAuthCallback(
      connector as any,
      body.code,
      body.redirectUri
    )

    return { body: { account } }
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
