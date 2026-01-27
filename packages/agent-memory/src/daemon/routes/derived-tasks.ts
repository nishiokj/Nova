/**
 * Derived Task Routes
 *
 * HTTP endpoints for managing derived tasks.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'

export function registerDerivedTaskRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { derivedTaskRepo, derivedJobRepo, derivedIntegration, engine } = daemon

  // List derived tasks
  server.get('/derived/tasks', async (req) => {
    const { enabled, name } = req.query

    let tasks
    if (name) {
      tasks = await derivedTaskRepo.findByName(name)
    } else {
      tasks = await derivedTaskRepo.findAll(100)
    }

    if (enabled !== undefined) {
      const enabledBool = enabled === 'true'
      tasks = tasks.filter((t) => t.enabled === enabledBool)
    }

    return { body: { tasks } }
  })

  // Get derived task by ID
  server.get('/derived/tasks/:id', async (req) => {
    const task = await derivedTaskRepo.findById(req.params.id)
    if (!task) {
      throw notFound(`Derived task not found: ${req.params.id}`)
    }

    const jobs = await derivedJobRepo.findByTask(task.id, 10)

    return { body: { task, recentJobs: jobs } }
  })

  // Create derived task
  server.post('/derived/tasks', async (req) => {
    const body = req.body as {
      name?: string
      scriptPath?: string
      mode?: 'once' | 'recurring' | 'event'
      intervalMs?: number
      metadata?: Record<string, unknown>
    }

    if (!body.name) {
      throw badRequest('Missing required field: name')
    }
    if (!body.scriptPath) {
      throw badRequest('Missing required field: scriptPath')
    }
    if (!body.mode) {
      throw badRequest('Missing required field: mode')
    }
    if (body.mode === 'recurring' && (!body.intervalMs || body.intervalMs < 1000)) {
      throw badRequest('intervalMs must be at least 1000ms for recurring tasks')
    }

    const task = await derivedTaskRepo.create({
      name: body.name,
      scriptPath: body.scriptPath,
      mode: body.mode,
      intervalMs: body.intervalMs,
      metadata: body.metadata,
    })

    return { status: 201, body: { task } }
  })

  // Run derived task immediately
  server.post('/derived/tasks/:id/run', async (req) => {
    const body = req.body as {
      priority?: number
      metadata?: Record<string, unknown>
    }

    const task = await derivedTaskRepo.findById(req.params.id)
    if (!task) {
      throw notFound(`Derived task not found: ${req.params.id}`)
    }

    const job = await derivedIntegration.scheduleTask(engine, task, {
      priority: body?.priority,
      metadata: body?.metadata,
    })

    await derivedTaskRepo.markExecuted(task.id, job.id)

    if (task.mode === 'once') {
      await derivedTaskRepo.update(task.id, { enabled: false })
    } else if (task.mode === 'recurring' && task.interval_ms) {
      const nextRunAt = new Date(Date.now() + task.interval_ms)
      await derivedTaskRepo.updateNextRunAt(task.id, nextRunAt)
    }

    return { status: 201, body: { task, job } }
  })
}
