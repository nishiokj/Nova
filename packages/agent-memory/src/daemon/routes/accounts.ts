/**
 * Account Routes
 *
 * HTTP endpoints for managing connected accounts.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'

export function registerAccountRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { accountRepo } = daemon

  // List all accounts
  server.get('/accounts', async (req) => {
    const { connector, active } = req.query

    let accounts
    if (connector) {
      accounts = await accountRepo.findAllByConnector(connector as any)
    } else if (active === 'true') {
      accounts = await accountRepo.findActive()
    } else {
      accounts = await accountRepo.findActive() // Default to active accounts
    }

    return { body: { accounts } }
  })

  // Get account by ID
  server.get('/accounts/:id', async (req) => {
    const account = await accountRepo.findById(req.params.id)
    if (!account) {
      throw notFound(`Account not found: ${req.params.id}`)
    }
    return { body: { account } }
  })

  // Create account (after OAuth callback)
  server.post('/accounts', async (req) => {
    const body = req.body as {
      connector?: string
      code?: string
      redirectUri?: string
    }

    if (!body.connector || !body.code || !body.redirectUri) {
      throw badRequest('Missing required fields: connector, code, redirectUri')
    }

    const account = await daemon.handleAuthCallback(
      body.connector as any,
      body.code,
      body.redirectUri
    )

    return { status: 201, body: { account } }
  })

  // Update account
  server.patch('/accounts/:id', async (req) => {
    const body = req.body as {
      display_name?: string
      email?: string
      is_active?: boolean
    }

    const account = await accountRepo.update(req.params.id, body)
    if (!account) {
      throw notFound(`Account not found: ${req.params.id}`)
    }

    return { body: { account } }
  })

  // Deactivate account (soft delete)
  server.delete('/accounts/:id', async (req) => {
    // Disable all tasks for this account
    await daemon.taskRepo.disableForAccount(req.params.id)

    const success = await accountRepo.deactivate(req.params.id)
    if (!success) {
      throw notFound(`Account not found: ${req.params.id}`)
    }

    return { body: { success: true } }
  })
}
