import type { HttpServer } from '../server.js'
import type { AgentGoalsRepository } from '../../db/repositories/agent-goals.js'
import { badRequest } from '../server.js'

export function registerGoalsRoutes(server: HttpServer, goalsRepo: AgentGoalsRepository): void {
  // List goals with optional filters
  server.get('/goals', async (req) => {
    const { status, parent_id, limit = '50', offset = '0' } = req.query

    const goals = await goalsRepo.findMany({
      status: status as 'active' | 'paused' | 'completed' | 'failed' | 'abandoned' | undefined,
      parent_id: parent_id === 'null' ? null : parent_id as string | undefined,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    })

    return {
      body: {
        goals,
        total: goals.length,
      },
    }
  })

  // Get active goals ordered by priority
  server.get('/goals/active', async (req) => {
    const { limit = '50' } = req.query
    const goals = await goalsRepo.getActiveGoals(parseInt(limit, 10))

    return {
      body: {
        goals,
        total: goals.length,
      },
    }
  })

  // Get goals due soon
  server.get('/goals/due-soon', async (req) => {
    const { hours = '24', limit = '20' } = req.query
    const goals = await goalsRepo.getDueSoon(parseInt(hours, 10), parseInt(limit, 10))

    return {
      body: {
        goals,
        total: goals.length,
      },
    }
  })

  // Get a single goal by ID
  server.get('/goals/:id', async (req) => {
    const { id } = req.params
    const goal = await goalsRepo.findById(id)

    if (!goal) {
      throw badRequest('Goal not found')
    }

    return { body: { goal } }
  })

  // Create a new goal
  server.post('/goals', async (req) => {
    const body = req.body as Record<string, unknown> | undefined

    if (!body?.title) {
      throw badRequest('title is required')
    }

    const goal = await goalsRepo.create({
      id: typeof body.id === 'string' ? body.id : undefined,
      parent_id: typeof body.parent_id === 'string' ? body.parent_id : undefined,
      title: String(body.title),
      description: typeof body.description === 'string' ? body.description : undefined,
      success_criteria: body.success_criteria,
      priority: typeof body.priority === 'number' ? body.priority : undefined,
      status: typeof body.status === 'string' ? body.status as 'active' | 'paused' | 'completed' | 'failed' | 'abandoned' : undefined,
      deadline: typeof body.deadline === 'string' ? new Date(body.deadline) : undefined,
      metadata: body.metadata,
    })

    return {
      body: { goal },
    }
  })

  // Update a goal
  server.patch('/goals/:id', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined

    const updated = await goalsRepo.update(id, {
      title: typeof body?.title === 'string' ? body.title : undefined,
      description: typeof body?.description === 'string' ? body.description : undefined,
      success_criteria: body?.success_criteria,
      priority: typeof body?.priority === 'number' ? body.priority : undefined,
      status: typeof body?.status === 'string' ? body.status as 'active' | 'paused' | 'completed' | 'failed' | 'abandoned' : undefined,
      deadline: typeof body?.deadline === 'string' ? new Date(body.deadline) : undefined,
      completed_at: typeof body?.completed_at === 'string' ? new Date(body.completed_at) : undefined,
      metadata: body?.metadata,
    })

    if (!updated) {
      throw badRequest('Goal not found')
    }

    return { body: { goal: updated } }
  })

  // Mark a goal as completed
  server.post('/goals/:id/complete', async (req) => {
    const { id } = req.params
    const updated = await goalsRepo.markCompleted(id)

    if (!updated) {
      throw badRequest('Goal not found')
    }

    return { body: { goal: updated } }
  })

  // Update goal priority
  server.patch('/goals/:id/priority', async (req) => {
    const { id } = req.params
    const body = req.body as Record<string, unknown> | undefined

    if (typeof body?.priority !== 'number') {
      throw badRequest('priority (number) is required')
    }

    const updated = await goalsRepo.updatePriority(id, body.priority)

    if (!updated) {
      throw badRequest('Goal not found')
    }

    return { body: { goal: updated } }
  })

  // Delete a goal (cascades to children)
  server.delete('/goals/:id', async (req) => {
    const { id } = req.params
    const deleted = await goalsRepo.delete(id)

    if (!deleted) {
      throw badRequest('Goal not found')
    }

    return { body: { deleted: true } }
  })
}
