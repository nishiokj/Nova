/**
 * Derived Job Routes
 *
 * HTTP endpoints for managing derived jobs.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'

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
