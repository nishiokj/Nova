/**
 * Task Routes
 *
 * HTTP endpoints for managing sync tasks.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'

export function registerTaskRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { taskRepo, syncJobRepo } = daemon

  // List tasks
  server.get('/tasks', async (req) => {
    const { accountId, enabled, connector } = req.query

    let tasks
    if (accountId) {
      tasks = await taskRepo.findByAccount(accountId)
    } else if (connector) {
      tasks = await taskRepo.findByConnector(connector as any)
    } else {
      // Get all tasks (limited to due tasks for now)
      tasks = await taskRepo.findDueForExecution(1000)
    }

    // Filter by enabled if specified
    if (enabled !== undefined) {
      const enabledBool = enabled === 'true'
      tasks = tasks.filter((t) => t.enabled === enabledBool)
    }

    return { body: { tasks } }
  })

  // Get task by ID
  server.get('/tasks/:id', async (req) => {
    const task = await taskRepo.findById(req.params.id)
    if (!task) {
      throw notFound(`Task not found: ${req.params.id}`)
    }

    // Get recent jobs for this task
    let recentJobs: any[] = []
    if (task.account_id) {
      const jobs = await syncJobRepo.findByConnector(task.connector, task.account_id)
      recentJobs = jobs.slice(0, 10) // Last 10 jobs
    }

    return { body: { task, recentJobs } }
  })

  // Create one-shot backfill task
  // Accepts either accountId directly, or connector (which auto-resolves to account)
  server.post('/tasks/backfill', async (req) => {
    const body = req.body as {
      accountId?: string
      connector?: string
      entityTypes?: string[]
    }

    let accountId: string

    if (body.accountId) {
      accountId = body.accountId
    } else if (body.connector) {
      // Resolve connector to account
      const account = await daemon.resolveAccount(body.connector as any)
      accountId = account.id
    } else {
      throw badRequest('Missing required field: accountId or connector')
    }

    const { task, job } = await daemon.backfill(accountId, {
      entityTypes: body.entityTypes,
    })

    return { status: 201, body: { task, job } }
  })

  // Create recurring sync task
  // Accepts either accountId directly, or connector (which auto-resolves to account)
  server.post('/tasks/subscribe', async (req) => {
    const body = req.body as {
      accountId?: string
      connector?: string
      syncType?: 'backfill' | 'incremental'
      entityTypes?: string[]
      intervalMs?: number
    }

    let accountId: string

    if (body.accountId) {
      accountId = body.accountId
    } else if (body.connector) {
      const account = await daemon.resolveAccount(body.connector as any)
      accountId = account.id
    } else {
      throw badRequest('Missing required field: accountId or connector')
    }

    if (!body.syncType) {
      throw badRequest('Missing required field: syncType')
    }

    if (!body.intervalMs || body.intervalMs < 1000) {
      throw badRequest('intervalMs must be at least 1000ms')
    }

    const task = await daemon.subscribe(accountId, {
      syncType: body.syncType,
      entityTypes: body.entityTypes,
      intervalMs: body.intervalMs,
    })

    return { status: 201, body: { task } }
  })

  // Create webhook-driven sync task
  // Accepts either accountId directly, or connector (which auto-resolves to account)
  server.post('/tasks/webhook', async (req) => {
    const body = req.body as {
      accountId?: string
      connector?: string
      entityTypes?: string[]
    }

    let accountId: string

    if (body.accountId) {
      accountId = body.accountId
    } else if (body.connector) {
      const account = await daemon.resolveAccount(body.connector as any)
      accountId = account.id
    } else {
      throw badRequest('Missing required field: accountId or connector')
    }

    const task = await daemon.subscribeWebhook(accountId, {
      entityTypes: body.entityTypes,
    })

    return { status: 201, body: { task } }
  })

  // Update task
  server.patch('/tasks/:id', async (req) => {
    const body = req.body as {
      enabled?: boolean
      entityTypes?: string[]
      intervalMs?: number
    }

    const task = await taskRepo.update(req.params.id, {
      enabled: body.enabled,
      entity_types: body.entityTypes,
      interval_ms: body.intervalMs,
    })

    if (!task) {
      throw notFound(`Task not found: ${req.params.id}`)
    }

    return { body: { task } }
  })

  // Manually trigger a task (skip schedule)
  server.post('/tasks/:id/trigger', async (req) => {
    const task = await taskRepo.findById(req.params.id)
    if (!task) {
      throw notFound(`Task not found: ${req.params.id}`)
    }

    if (!task.enabled) {
      throw badRequest('Cannot trigger disabled task')
    }

    // Schedule the job directly
    let job
    if (task.sync_type === 'backfill') {
      job = await daemon.engine.scheduleBackfill(task.connector, task.account_id, {
        entityTypes: task.entity_types ?? undefined,
      })
    } else {
      job = await daemon.engine.scheduleIncremental(task.connector, task.account_id, undefined, {
        entityTypes: task.entity_types ?? undefined,
      })
    }

    // Update task state
    await taskRepo.markExecuted(task.id, job.id)

    return { body: { job } }
  })

  // Cancel/disable task
  server.delete('/tasks/:id', async (req) => {
    const success = await daemon.cancelTask(req.params.id)
    if (!success) {
      throw notFound(`Task not found: ${req.params.id}`)
    }

    return { body: { success: true } }
  })
}
