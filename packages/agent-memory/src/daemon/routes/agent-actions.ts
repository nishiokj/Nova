import type { HttpServer } from '../server.js'
import type { AgentActionsRepository } from '../../db/repositories/agent-actions.js'
import { badRequest } from '../server.js'

export function registerActionsRoutes(server: HttpServer, actionsRepo: AgentActionsRepository): void {
  // List actions with optional filters
  server.get('/actions', async (req) => {
    const { action_type, outcome_signal, resolved, since, limit = '100', offset = '0' } = req.query

    const actions = await actionsRepo.findMany({
      action_type: action_type as string | undefined,
      outcome_signal: outcome_signal as 'positive' | 'negative' | 'neutral' | 'unknown' | undefined,
      resolved: resolved === 'true' ? true : resolved === 'false' ? false : undefined,
      since: since ? new Date(since as string) : undefined,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    })

    return {
      body: {
        actions,
        total: actions.length,
      },
    }
  })

  // Get unresolved actions
  server.get('/actions/unresolved', async (req) => {
    const { limit = '50' } = req.query
    const actions = await actionsRepo.getUnresolved(parseInt(limit, 10))

    return {
      body: {
        actions,
        total: actions.length,
      },
    }
  })

  // Get recent actions
  server.get('/actions/recent', async (req) => {
    const { limit = '20' } = req.query
    const actions = await actionsRepo.getRecent(parseInt(limit, 10))

    return {
      body: {
        actions,
        total: actions.length,
      },
    }
  })

  // Get success rate for an action type
  server.get('/actions/stats', async (req) => {
    const { action_type, since } = req.query

    if (!action_type) {
      throw badRequest('action_type is required')
    }

    const stats = await actionsRepo.getSuccessRate(
      action_type as string,
      since ? new Date(since as string) : undefined
    )

    return { body: { stats } }
  })

  // Get a single action by ID
  server.get('/actions/:id', async (req) => {
    const { id } = req.params
    const action = await actionsRepo.findById(id)

    if (!action) {
      throw badRequest('Action not found')
    }

    return { body: { action } }
  })

  // Create a new action record
  server.post('/actions', async (req) => {
    const body = req.body as Record<string, unknown> | undefined

    if (!body?.action_type) {
      throw badRequest('action_type is required')
    }

    const action = await actionsRepo.create({
      id: typeof body.id === 'string' ? body.id : undefined,
      action_type: String(body.action_type),
      context: body.context,
      parameters: body.parameters,
      predicted_outcome: typeof body.predicted_outcome === 'string' ? body.predicted_outcome : undefined,
      actual_outcome: typeof body.actual_outcome === 'string' ? body.actual_outcome : undefined,
      outcome_signal: typeof body.outcome_signal === 'string' ? body.outcome_signal as 'positive' | 'negative' | 'neutral' | 'unknown' : undefined,
      feedback: body.feedback,
      resolved_at: typeof body.resolved_at === 'string' ? new Date(body.resolved_at) : undefined,
      metadata: body.metadata,
    })

    return {
      body: { action },
    }
  })

  // Update an action
  server.patch('/actions/:id', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined

    const updated = await actionsRepo.update(id, {
      action_type: typeof body?.action_type === 'string' ? body.action_type : undefined,
      context: body?.context,
      parameters: body?.parameters,
      predicted_outcome: typeof body?.predicted_outcome === 'string' ? body.predicted_outcome : undefined,
      actual_outcome: typeof body?.actual_outcome === 'string' ? body.actual_outcome : undefined,
      outcome_signal: typeof body?.outcome_signal === 'string' ? body.outcome_signal as 'positive' | 'negative' | 'neutral' | 'unknown' : undefined,
      feedback: body?.feedback,
      resolved_at: typeof body?.resolved_at === 'string' ? new Date(body.resolved_at) : undefined,
      metadata: body?.metadata,
    })

    if (!updated) {
      throw badRequest('Action not found')
    }

    return { body: { action: updated } }
  })

  // Record the outcome of an action
  server.post('/actions/:id/outcome', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined

    if (!body?.actual_outcome || !body?.outcome_signal) {
      throw badRequest('actual_outcome and outcome_signal are required')
    }

    const updated = await actionsRepo.recordOutcome(id, {
      actual_outcome: String(body.actual_outcome),
      outcome_signal: body.outcome_signal as 'positive' | 'negative' | 'neutral' | 'unknown',
      feedback: body.feedback,
    })

    if (!updated) {
      throw badRequest('Action not found')
    }

    return { body: { action: updated } }
  })

  // Delete an action
  server.delete('/actions/:id', async (req) => {
    const { id } = req.params
    const deleted = await actionsRepo.delete(id)

    if (!deleted) {
      throw badRequest('Action not found')
    }

    return { body: { deleted: true } }
  })
}
