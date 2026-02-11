/**
 * MicroQueue - PostgreSQL-backed Job Queue
 *
 * A single-process job queue with at-least-once delivery, visibility timeouts,
 * exponential backoff, and dead letter handling.
 *
 * Design:
 * - Single-process worker (no cross-process coordination)
 * - Retry 3x with exponential backoff
 * - Enforce max job runtime, then mark failed
 * - On final failure, persist payload + error for later inspection
 *
 * @module sync/queue
 */

import { ulid } from 'ulid'
import { createJobQueueRepository, type JobQueueRepository, type QueueJob, type JobStatus } from '../db/repositories/job-queue.js'
import type { Sql } from 'postgres'

export interface QueueConfig {
  /** Visibility timeout in ms (default: 30000) */
  visibilityTimeout?: number
  /** Max attempts before marking dead (default: 3) */
  maxAttempts?: number
  /** Base retry delay in ms (default: 1000) */
  baseRetryDelay?: number
  /** Max retry delay in ms (default: 60000) */
  maxRetryDelay?: number
  /** Max job runtime in ms before timeout (default: 180000 = 3 min) */
  maxJobRuntime?: number
  /** Poll interval when queue is empty in ms (default: 100) */
  pollInterval?: number
  /** Heartbeat interval for extending locks in ms (default: 10000) */
  heartbeatInterval?: number
  /** Directory to dump failed job payloads (default: './data/dead-jobs') */
  deadJobDir?: string
}

const DEFAULT_CONFIG: Required<QueueConfig> = {
  visibilityTimeout: 30000,
  maxAttempts: 3,
  baseRetryDelay: 1000,
  maxRetryDelay: 60000,
  maxJobRuntime: 180000,
  pollInterval: 100,
  heartbeatInterval: 10000,
  deadJobDir: './data/dead-jobs',
}

export interface Job<T = unknown> {
  id: string
  type: string
  payload: T
  priority: number
  attemptCount: number
  createdAt: Date
}

export interface JobResult {
  success: boolean
  error?: Error
  /** Override computed retry delay */
  retryDelay?: number
  /** Skip retry and mark as dead immediately */
  noRetry?: boolean
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<JobResult>

export interface DeadJob<T = unknown> {
  id: string
  type: string
  payload: T
  error: string
  attemptCount: number
  createdAt: string
  diedAt: string
}

export interface MicroQueueStats {
  pending: number
  running: number
  completed: number
  failed: number
  dead: number
  processedTotal: number
  failedTotal: number
}

/**
 * MicroQueue - A PostgreSQL-backed job queue system.
 *
 * @example
 * ```ts
 * const queue = new MicroQueue(sql, { maxAttempts: 3 })
 *
 * // Register handlers
 * queue.register('process-envelope', async (job) => {
 *   await processEnvelope(job.payload)
 *   return { success: true }
 * })
 *
 * // Enqueue jobs
 * await queue.enqueue('process-envelope', { envelopeId: '...' })
 *
 * // Start processing
 * await queue.start()
 *
 * // Graceful shutdown
 * await queue.stop()
 * ```
 */
export interface HandlerOptions {
  /** Override maxJobRuntime for this handler (ms) */
  timeout?: number
}

export class MicroQueue {
  private repo: JobQueueRepository
  private config: Required<QueueConfig>
  private workerId: string
  private handlers: Map<string, JobHandler<unknown>>
  private handlerOptions: Map<string, HandlerOptions>
  private isRunning: boolean = false
  private isStopping: boolean = false
  private currentJob: { id: string; heartbeat: NodeJS.Timeout } | null = null
  private stats: { processed: number; failed: number } = { processed: 0, failed: 0 }

  constructor(sql: Sql, config: QueueConfig = {}) {
    this.repo = createJobQueueRepository({ sql })
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.workerId = ulid()
    this.handlers = new Map()
    this.handlerOptions = new Map()
  }

  /** Get the unique worker ID for this instance */
  get id(): string {
    return this.workerId
  }

  /** Check if the queue is currently running */
  get running(): boolean {
    return this.isRunning
  }

  /**
   * Register a handler for a job type.
   * Only one handler per job type is allowed.
   */
  register<T>(jobType: string, handler: JobHandler<T>, options?: HandlerOptions): this {
    if (this.handlers.has(jobType)) {
      throw new Error(`Handler already registered for job type: ${jobType}`)
    }
    this.handlers.set(jobType, handler as JobHandler<unknown>)
    if (options) {
      this.handlerOptions.set(jobType, options)
    }
    return this
  }

  /**
   * Unregister a handler for a job type.
   */
  unregister(jobType: string): boolean {
    this.handlerOptions.delete(jobType)
    return this.handlers.delete(jobType)
  }

  /**
   * Enqueue a job for processing.
   *
   * @param jobType - The type of job (must have a registered handler)
   * @param payload - The job payload
   * @param options - Enqueue options
   * @returns The created job
   */
  async enqueue<T>(
    jobType: string,
    payload: T,
    options: {
      priority?: number
      delay?: number
      idempotencyKey?: string
    } = {}
  ): Promise<QueueJob<T>> {
    return this.repo.enqueue(jobType, payload, {
      priority: options.priority,
      delay: options.delay,
      idempotencyKey: options.idempotencyKey,
      maxAttempts: this.config.maxAttempts,
    })
  }

  /**
   * Start the queue worker loop.
   * Blocks until stop() is called.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Queue is already running')
    }

    this.isRunning = true
    this.isStopping = false

    // Reclaim any stale jobs from previous runs
    const reclaimed = await this.repo.reclaimStale()
    if (reclaimed > 0) {
      console.log(`[MicroQueue] Reclaimed ${reclaimed} stale jobs`)
    }

    while (this.isRunning && !this.isStopping) {
      const processed = await this.processOne()
      if (!processed) {
        // No job available, wait before polling again
        await sleep(this.config.pollInterval)
      }
    }

    this.isRunning = false
  }

  /**
   * Process a single job from the queue.
   * Returns true if a job was processed, false if queue was empty.
   */
  async processOne(): Promise<boolean> {
    const queueJob = await this.repo.dequeue<unknown>(
      this.workerId,
      this.config.visibilityTimeout
    )

    if (!queueJob) {
      return false
    }

    const handler = this.handlers.get(queueJob.job_type)
    if (!handler) {
      // No handler registered - mark as dead
      console.error('[MicroQueue] No handler registered for job type:', {
        jobId: queueJob.id,
        jobType: queueJob.job_type,
      })
      await this.repo.fail(
        queueJob.id,
        `No handler registered for job type: ${queueJob.job_type}`,
        { markDead: true }
      )
      await this.dumpDeadJob(queueJob, `No handler registered for job type: ${queueJob.job_type}`)
      return true
    }

    // Start heartbeat to extend lock while processing
    const heartbeat = setInterval(async () => {
      try {
        await this.repo.extendLock(
          queueJob.id,
          this.workerId,
          this.config.visibilityTimeout
        )
      } catch {
        // Heartbeat failed - job may have been stolen
      }
    }, this.config.heartbeatInterval)

    this.currentJob = { id: queueJob.id, heartbeat }

    const job: Job<unknown> = {
      id: queueJob.id,
      type: queueJob.job_type,
      payload: queueJob.payload,
      priority: queueJob.priority,
      attemptCount: queueJob.attempt_count,
      createdAt: new Date(queueJob.created_at),
    }

    try {
      const timeout = this.handlerOptions.get(queueJob.job_type)?.timeout ?? this.config.maxJobRuntime
      const result = await withTimeout(
        handler(job),
        timeout,
        `Job ${queueJob.id} exceeded max runtime of ${timeout}ms`
      )

      if (result.success) {
        await this.repo.complete(queueJob.id)
        this.stats.processed++
      } else {
        await this.handleFailure(queueJob, result.error?.message ?? 'Unknown error', result)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.handleFailure(queueJob, errorMessage, { success: false })
    } finally {
      clearInterval(heartbeat)
      this.currentJob = null
    }

    return true
  }

  /**
   * Stop the queue gracefully.
   * Waits for the current job to complete.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    this.isStopping = true

    // Wait for current job to finish (with timeout)
    const maxWait = this.config.maxJobRuntime + 5000
    const start = Date.now()

    while (this.currentJob && Date.now() - start < maxWait) {
      await sleep(100)
    }

    // If job is still running after timeout, release it
    if (this.currentJob) {
      clearInterval(this.currentJob.heartbeat)
      await this.repo.release(this.currentJob.id)
    }

    this.isRunning = false
    this.isStopping = false
  }

  /**
   * Force stop the queue immediately.
   * Does not wait for current job to complete.
   */
  forceStop(): void {
    if (this.currentJob) {
      clearInterval(this.currentJob.heartbeat)
    }
    this.isRunning = false
    this.isStopping = false
  }

  /**
   * Get queue statistics.
   */
  async getStats(): Promise<MicroQueueStats> {
    const counts = await this.repo.countByStatus()
    return {
      ...counts,
      processedTotal: this.stats.processed,
      failedTotal: this.stats.failed,
    }
  }

  /**
   * Get dead jobs for inspection.
   */
  async getDeadJobs(limit = 100, offset = 0): Promise<QueueJob[]> {
    const result = await this.repo.findDead({ limit, offset })
    return result.items
  }

  /**
   * Retry a dead job.
   */
  async retryDeadJob(jobId: string): Promise<QueueJob | null> {
    return this.repo.resurrect(jobId)
  }

  /**
   * Prune old completed jobs.
   */
  async pruneCompleted(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs)
    return this.repo.pruneCompleted(cutoff)
  }

  private async handleFailure(
    queueJob: QueueJob,
    errorMessage: string,
    result: JobResult
  ): Promise<void> {
    this.stats.failed++

    const isLastAttempt = queueJob.attempt_count >= this.config.maxAttempts
    const shouldDie = result.noRetry || isLastAttempt

    console.error('[MicroQueue] Job failed:', {
      jobId: queueJob.id,
      jobType: queueJob.job_type,
      attempt: queueJob.attempt_count,
      maxAttempts: this.config.maxAttempts,
      willRetry: !shouldDie,
      error: errorMessage,
    })

    if (shouldDie) {
      await this.repo.fail(queueJob.id, errorMessage, { markDead: true })
      await this.dumpDeadJob(queueJob, errorMessage)
    } else {
      await this.repo.fail(queueJob.id, errorMessage, {
        retryDelay: result.retryDelay,
      })
    }
  }

  private async dumpDeadJob(queueJob: QueueJob, error: string): Promise<void> {
    const deadJob: DeadJob = {
      id: queueJob.id,
      type: queueJob.job_type,
      payload: queueJob.payload,
      error,
      attemptCount: queueJob.attempt_count,
      createdAt: queueJob.created_at,
      diedAt: new Date().toISOString(),
    }

    try {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')

      await fs.mkdir(this.config.deadJobDir, { recursive: true })

      const filename = `${queueJob.id}.json`
      const filepath = path.join(this.config.deadJobDir, filename)

      await fs.writeFile(filepath, JSON.stringify(deadJob, null, 2))
    } catch (err) {
      // Log but don't fail - dumping is best-effort
      console.error('[MicroQueue] Failed to dump dead job:', err)
    }
  }
}

/** Sleep utility */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Execute a promise with a timeout */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(message ?? `Operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId!)
  }
}

/** Custom error for timeout conditions */
export class TimeoutError extends Error {
  name = 'TimeoutError'
}

/** Custom error for queue operations */
export class QueueError extends Error {
  name = 'QueueError'
}
