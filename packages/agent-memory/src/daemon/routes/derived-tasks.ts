/**
 * Derived Task Routes
 *
 * HTTP endpoints for managing derived tasks.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'
import { TaskSandbox, type DerivedTaskSandboxResult } from '../../derived/sandbox.js'
import { DerivedTaskIntegration } from '../../derived/integration.js'
import type { ReplayPolicy } from '../../db/repositories/derived-task.js'

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
      triggerConfig?: {
        type: 'webhook' | 'database' | 'scheduler'
        connector?: string
        eventType?: string | string[]
        filters?: Record<string, unknown>
      }
      // Execution policies
      replayPolicy?: ReplayPolicy
      idempotent?: boolean
      cooldownMs?: number
      timeoutMs?: number
      heartbeatIntervalMs?: number
      rateLimitMax?: number
      rateLimitWindowMs?: number
      resourcePool?: string
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
    if (body.mode === 'event' && !body.triggerConfig) {
      throw badRequest('triggerConfig is required for event mode tasks')
    }
    if (body.mode !== 'event' && body.triggerConfig) {
      throw badRequest('triggerConfig is only valid for event mode tasks')
    }

    // Validate policy fields
    if (body.replayPolicy === 'cooldown' && !body.cooldownMs) {
      throw badRequest('cooldownMs is required when replayPolicy is "cooldown"')
    }
    if (body.rateLimitMax && !body.rateLimitWindowMs) {
      throw badRequest('rateLimitWindowMs is required when rateLimitMax is set')
    }

    let task = await derivedTaskRepo.create({
      name: body.name,
      scriptPath: body.scriptPath,
      mode: body.mode,
      intervalMs: body.intervalMs,
      metadata: body.metadata,
      triggerConfig: body.triggerConfig,
      replayPolicy: body.replayPolicy,
      idempotent: body.idempotent,
      cooldownMs: body.cooldownMs,
      timeoutMs: body.timeoutMs,
      heartbeatIntervalMs: body.heartbeatIntervalMs,
      rateLimitMax: body.rateLimitMax,
      rateLimitWindowMs: body.rateLimitWindowMs,
      resourcePool: body.resourcePool,
    })

    let sandbox: DerivedTaskSandboxResult | undefined
    let sandboxError: string | undefined
    try {
      const timeoutMs = 12000
      const result = await derivedIntegration.scheduleTask(engine, task, {
        metadata: { _sandbox: true, _sandboxTimeoutMs: timeoutMs },
      })

      // Skip sandbox if blocked by policy (shouldn't happen on create, but handle it)
      if (DerivedTaskIntegration.isBlocked(result)) {
        sandboxError = result.reason
      } else {
        const job = result
        await derivedTaskRepo.markExecuted(task.id, job.id)

        if (task.mode === 'once') {
          await derivedTaskRepo.update(task.id, { enabled: false })
        } else if (task.mode === 'recurring' && task.interval_ms) {
          const nextRunAt = new Date(Date.now() + task.interval_ms)
          await derivedTaskRepo.updateNextRunAt(task.id, nextRunAt)
        }

        task = (await derivedTaskRepo.findById(task.id)) ?? task

        const sandboxRunner = new TaskSandbox(derivedJobRepo)
        sandbox = await sandboxRunner.observe(job.id, { timeoutMs })
      }
    } catch (error) {
      sandboxError = error instanceof Error ? error.message : String(error)
    }

    return { status: 201, body: { task, sandbox, sandboxError } }
  })

  // Run derived task immediately
  server.post('/derived/tasks/:id/run', async (req) => {
    const body = req.body as {
      priority?: number
      metadata?: Record<string, unknown>
      force?: boolean
    }

    const task = await derivedTaskRepo.findById(req.params.id)
    if (!task) {
      throw notFound(`Derived task not found: ${req.params.id}`)
    }

    const result = await derivedIntegration.scheduleTask(engine, task, {
      priority: body?.priority,
      metadata: body?.metadata,
      force: body?.force,
    })

    // Check if blocked by policy
    if (DerivedTaskIntegration.isBlocked(result)) {
      return {
        status: 429,
        body: {
          error: 'policy_blocked',
          message: result.reason,
          retryAfter: result.retryAfter,
        },
      }
    }

    const job = result
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
