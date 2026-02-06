import type { HttpServer } from '../server.js'
import type { EscalationsRepository } from '../../db/repositories/escalations.js'
import { badRequest } from '../server.js'

export function registerEscalationsRoutes(server: HttpServer, escalationsRepo: EscalationsRepository): void {
  // Create an escalation
  server.post('/escalations', async (req) => {
    const body = req.body as Record<string, unknown> | undefined

    if (!body?.type || typeof body.type !== 'string') {
      throw badRequest('type is required')
    }
    if (!body?.sessionKey || typeof body.sessionKey !== 'string') {
      throw badRequest('sessionKey is required')
    }
    if (!body?.title || typeof body.title !== 'string') {
      throw badRequest('title is required')
    }
    if (!body?.context || typeof body.context !== 'string') {
      throw badRequest('context is required')
    }

    const escalation = await escalationsRepo.create({
      type: body.type as any,
      sessionKey: body.sessionKey,
      workItemId: typeof body.workItemId === 'string' ? body.workItemId : undefined,
      title: body.title,
      context: body.context,
      tradeoffs: Array.isArray(body.tradeoffs) ? body.tradeoffs : undefined,
      options: Array.isArray(body.options) ? body.options : undefined,
      references: Array.isArray(body.references) ? body.references : undefined,
    })

    return { body: { escalation } }
  })

  // Resolve an escalation
  server.post('/escalations/:id/resolve', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined

    const escalation = await escalationsRepo.resolve(id, {
      optionId: typeof body?.optionId === 'string' ? body.optionId : undefined,
      freeformResponse: typeof body?.freeformResponse === 'string' ? body.freeformResponse : undefined,
    })

    if (!escalation) {
      throw badRequest('Escalation not found or already resolved')
    }

    return { body: { escalation } }
  })

  // Dismiss an escalation
  server.post('/escalations/:id/dismiss', async (req) => {
    const { id } = req.params

    const escalation = await escalationsRepo.dismiss(id)

    if (!escalation) {
      throw badRequest('Escalation not found or already resolved')
    }

    return { body: { escalation } }
  })

  // Get a single escalation
  server.get('/escalations/:id', async (req) => {
    const { id } = req.params
    const escalation = await escalationsRepo.findById(id)

    if (!escalation) {
      throw badRequest('Escalation not found')
    }

    return { body: { escalation } }
  })

  // List escalations with filtering
  server.get('/escalations', async (req) => {
    const { session_key, status, type, limit = '50', offset = '0' } = req.query

    const escalations = await escalationsRepo.list({
      sessionKey: session_key as string | undefined,
      status: status as any,
      type: type as any,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    })

    return {
      body: {
        escalations,
        total: escalations.length,
      },
    }
  })
}
