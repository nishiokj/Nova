/**
 * Derived Job Routes
 *
 * HTTP endpoints for managing derived jobs.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'
import { readFile, stat } from 'node:fs/promises'
import { getDerivedLogPath } from '../../derived/logging.js'

export function registerDerivedJobRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { derivedJobRepo, derivedTaskRepo, derivedIntegration, engine } = daemon

  // List derived jobs
  server.get('/derived/jobs', async (req) => {
    const { status, taskId, limit = '50' } = req.query

    let jobs
    if (taskId) {
      jobs = await derivedJobRepo.findByTask(taskId, parseInt(limit, 10))
    } else if (status === 'pending') {
      const result = await derivedJobRepo.findPending({ limit: parseInt(limit, 10) })
      jobs = result.items
    } else if (status === 'running') {
      jobs = await derivedJobRepo.findRunning()
    } else {
      const result = await derivedJobRepo.findRecent({ limit: parseInt(limit, 10) })
      jobs = result.items
    }

    return { body: { jobs } }
  })

  // Get derived job by ID
  server.get('/derived/jobs/:id', async (req) => {
    const job = await derivedJobRepo.findById(req.params.id)
    if (!job) {
      throw notFound(`Derived job not found: ${req.params.id}`)
    }

    const stats = await derivedIntegration.getQueueStats(engine)

    return { body: { job, queueStats: stats } }
  })

  // Get derived job logs
  server.get('/derived/jobs/:id/logs', async (req) => {
    const job = await derivedJobRepo.findById(req.params.id)
    if (!job) {
      throw notFound(`Derived job not found: ${req.params.id}`)
    }

    const limit = req.query.lines ? parseInt(req.query.lines, 10) : 200
    const logPath = (job.metadata?._logPath as string | undefined) ?? getDerivedLogPath(job.id)

    let exists = true
    try {
      await stat(logPath)
    } catch {
      exists = false
    }

    if (!exists) {
      return { body: { logPath, exists: false, lines: [], truncated: false } }
    }

    const content = await readFile(logPath, 'utf-8')
    let lines = content.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1)

    let truncated = false
    if (Number.isFinite(limit) && limit > 0 && lines.length > limit) {
      truncated = true
      lines = lines.slice(-limit)
    }

    return { body: { logPath, exists: true, lines, truncated } }
  })

  // Cancel a derived job
  server.post('/derived/jobs/:id/cancel', async (req) => {
    const job = await derivedJobRepo.cancel(req.params.id)
    if (!job) {
      throw notFound(`Derived job not found or cannot be cancelled: ${req.params.id}`)
    }

    return { body: { job } }
  })

  // Retry a failed derived job
  server.post('/derived/jobs/:id/retry', async (req) => {
    const existingJob = await derivedJobRepo.findById(req.params.id)
    if (!existingJob) {
      throw notFound(`Derived job not found: ${req.params.id}`)
    }

    if (existingJob.status !== 'failed') {
      throw badRequest('Can only retry failed jobs')
    }

    const task = await derivedTaskRepo.findById(existingJob.task_id)
    if (!task) {
      throw notFound(`Derived task not found: ${existingJob.task_id}`)
    }

    const newJob = await derivedIntegration.scheduleTask(engine, task, {
      metadata: existingJob.metadata,
    })

    return { body: { job: newJob, originalJob: existingJob } }
  })
}
