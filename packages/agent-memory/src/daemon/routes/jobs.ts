/**
 * Job Routes
 *
 * HTTP endpoints for managing sync jobs.
 */

import type { HttpServer } from '../server.js'
import type { SyncDaemon } from '../index.js'
import { badRequest, notFound } from '../server.js'

export function registerJobRoutes(server: HttpServer, daemon: SyncDaemon): void {
  const { syncJobRepo, engine } = daemon

  // List jobs
  server.get('/jobs', async (req) => {
    const { accountId, connector, status, limit = '50' } = req.query

    let jobs
    if (accountId && connector) {
      jobs = await syncJobRepo.findByConnector(connector as any, accountId)
    } else if (status === 'pending') {
      const result = await syncJobRepo.findPending({ limit: parseInt(limit, 10) })
      jobs = result.items
    } else if (status === 'running') {
      jobs = await syncJobRepo.findRunning()
    } else {
      // Default to pending jobs
      const result = await syncJobRepo.findPending({ limit: parseInt(limit, 10) })
      jobs = result.items
    }

    return { body: { jobs } }
  })

  // Get job by ID
  server.get('/jobs/:id', async (req) => {
    const job = await syncJobRepo.findById(req.params.id)
    if (!job) {
      throw notFound(`Job not found: ${req.params.id}`)
    }

    // Get queue stats
    const stats = await engine.getQueueStats()

    return { body: { job, queueStats: stats } }
  })

  // Cancel a job
  server.post('/jobs/:id/cancel', async (req) => {
    const job = await syncJobRepo.cancel(req.params.id)
    if (!job) {
      throw notFound(`Job not found or cannot be cancelled: ${req.params.id}`)
    }

    return { body: { job } }
  })

  // Retry a failed job
  server.post('/jobs/:id/retry', async (req) => {
    const existingJob = await syncJobRepo.findById(req.params.id)
    if (!existingJob) {
      throw notFound(`Job not found: ${req.params.id}`)
    }

    if (existingJob.status !== 'failed') {
      throw badRequest('Can only retry failed jobs')
    }

    // Schedule a new job with the same parameters
    let newJob
    if (existingJob.job_type === 'backfill') {
      newJob = await engine.scheduleBackfill(
        existingJob.connector,
        existingJob.account_id,
        { entityTypes: (existingJob.metadata as any)?.entityTypes }
      )
    } else {
      newJob = await engine.scheduleIncremental(
        existingJob.connector,
        existingJob.account_id,
        existingJob.cursor_state?.cursor as string | undefined,
        { entityTypes: (existingJob.metadata as any)?.entityTypes }
      )
    }

    return { body: { job: newJob, originalJob: existingJob } }
  })
}
