/**
 * Derived Task Integration for SyncEngine
 *
 * Integrates derived task processing into the shared queue.
 * This replaces the standalone DerivedEngine with a lightweight integration.
 */

import type { Sql } from 'postgres'
import type { Job, JobResult } from '../sync/queue.js'
import type { DerivedTask, ReplayPolicy } from '../db/repositories/derived-task.js'
import type { DerivedJob, FailureClass } from '../db/repositories/derived-job.js'
import {
  createDerivedTaskRepository,
  createDerivedJobRepository,
  createResourcePoolRepository,
} from '../db/repositories/index.js'
import { runDerivedScript } from './runner.js'

export interface DerivedIntegrationConfig {
  /** Maximum job runtime in ms (default: 1800000 = 30 min) */
  maxJobRuntime?: number
}

/** Result of a policy check */
export interface PolicyCheckResult {
  allowed: boolean
  reason?: string
  retryAfter?: number
}

export class DerivedTaskIntegration {
  private sql: Sql
  private config: DerivedIntegrationConfig
  private jobRepo: ReturnType<typeof createDerivedJobRepository>
  private taskRepo: ReturnType<typeof createDerivedTaskRepository>
  private poolRepo: ReturnType<typeof createResourcePoolRepository>

  constructor(sql: Sql, config: DerivedIntegrationConfig = {}) {
    this.sql = sql
    this.config = { maxJobRuntime: 1800000, ...config }
    this.jobRepo = createDerivedJobRepository({ sql })
    this.taskRepo = createDerivedTaskRepository({ sql })
    this.poolRepo = createResourcePoolRepository({ sql })
  }

  /**
   * Register derived task handlers with the SyncEngine's queue.
   */
  registerHandlers(engine: any): void {
    engine.registerDerivedJobHandler('derived:run', async (job: Job) => {
      return this.handleRunJob(job)
    }, { timeout: this.config.maxJobRuntime })
  }

  /**
   * Check replay policy against last completed job.
   */
  async checkReplayPolicy(task: DerivedTask): Promise<PolicyCheckResult> {
    const { replay_policy, cooldown_ms } = task

    if (replay_policy === 'always') {
      return { allowed: true }
    }

    const lastCompleted = await this.jobRepo.findLastCompleted(task.id)

    if (replay_policy === 'once') {
      if (lastCompleted) {
        return {
          allowed: false,
          reason: `Task has already completed successfully (replay_policy=once)`,
        }
      }
      return { allowed: true }
    }

    if (replay_policy === 'on_failure') {
      // Allow if no previous run or last run failed
      if (!lastCompleted) {
        return { allowed: true }
      }
      // Check if there's a more recent failed job
      const jobs = await this.jobRepo.findByTask(task.id, 1)
      if (jobs.length > 0 && jobs[0].status === 'failed') {
        return { allowed: true }
      }
      return {
        allowed: false,
        reason: `Last execution succeeded (replay_policy=on_failure)`,
      }
    }

    if (replay_policy === 'cooldown') {
      if (!cooldown_ms) {
        return { allowed: true }
      }
      if (lastCompleted) {
        const completedAt = new Date(lastCompleted.completed_at!).getTime()
        const cooldownEnd = completedAt + cooldown_ms
        const now = Date.now()

        if (now < cooldownEnd) {
          return {
            allowed: false,
            reason: `Cooldown period not elapsed (${cooldown_ms}ms)`,
            retryAfter: cooldownEnd - now,
          }
        }
      }
      return { allowed: true }
    }

    return { allowed: true }
  }

  /**
   * Check rate limit for task executions within window.
   */
  async checkRateLimit(task: DerivedTask): Promise<PolicyCheckResult> {
    const { rate_limit_max, rate_limit_window_ms } = task

    if (!rate_limit_max || !rate_limit_window_ms) {
      return { allowed: true }
    }

    const windowStart = new Date(Date.now() - rate_limit_window_ms)
    const count = await this.jobRepo.countSince(task.id, windowStart)

    if (count >= rate_limit_max) {
      // Find oldest job in window to calculate when window slides
      const oldest = await this.jobRepo.findOldestInWindow(task.id, windowStart)
      let retryAfter: number | undefined

      if (oldest) {
        const oldestTime = new Date(oldest.created_at).getTime()
        retryAfter = (oldestTime + rate_limit_window_ms) - Date.now()
        if (retryAfter < 0) retryAfter = 1000 // Minimum 1 second
      }

      return {
        allowed: false,
        reason: `Rate limit exceeded (${count}/${rate_limit_max} in ${rate_limit_window_ms}ms)`,
        retryAfter,
      }
    }

    return { allowed: true }
  }

  /**
   * Check resource pool limits (concurrency and budget).
   */
  async checkResourcePool(task: DerivedTask): Promise<PolicyCheckResult> {
    const { resource_pool } = task

    if (!resource_pool) {
      return { allowed: true }
    }

    const pool = await this.poolRepo.findByName(resource_pool)
    if (!pool) {
      // Pool doesn't exist - allow but warn
      console.warn(`[DerivedTaskIntegration] Resource pool not found: ${resource_pool}`)
      return { allowed: true }
    }

    const runningCount = await this.jobRepo.countRunningByPool(pool.id)
    return this.poolRepo.canAcquire(pool.id, runningCount)
  }

  /**
   * Check all policies for a task.
   */
  async checkAllPolicies(task: DerivedTask): Promise<PolicyCheckResult> {
    // Check replay policy
    const replayCheck = await this.checkReplayPolicy(task)
    if (!replayCheck.allowed) return replayCheck

    // Check rate limit
    const rateLimitCheck = await this.checkRateLimit(task)
    if (!rateLimitCheck.allowed) return rateLimitCheck

    // Check resource pool
    const poolCheck = await this.checkResourcePool(task)
    if (!poolCheck.allowed) return poolCheck

    return { allowed: true }
  }

  /**
   * Create and schedule a derived job via SyncEngine.
   *
   * Skips scheduling if there's already a pending/running job for this task
   * to prevent backlog buildup when tasks consistently fail.
   *
   * Returns either a DerivedJob on success, or a PolicyCheckResult if blocked.
   */
  async scheduleTask(
    engine: any,
    task: DerivedTask,
    options: { priority?: number; metadata?: Record<string, unknown>; force?: boolean } = {}
  ): Promise<DerivedJob | PolicyCheckResult> {
    // Check policies unless force is set
    if (!options.force) {
      const policyCheck = await this.checkAllPolicies(task)
      if (!policyCheck.allowed) {
        console.log('[DerivedTaskIntegration] Blocked by policy:', {
          taskId: task.id,
          taskName: task.name,
          reason: policyCheck.reason,
        })
        return policyCheck
      }
    }

    // Check for existing pending/running jobs to prevent backlog
    const existingJobs = await this.jobRepo.findByTask(task.id, 5)
    const hasPendingOrRunning = existingJobs.some(
      j => j.status === 'pending' || j.status === 'running'
    )

    if (hasPendingOrRunning) {
      console.log('[DerivedTaskIntegration] Skipping schedule - existing pending/running job:', {
        taskId: task.id,
        taskName: task.name,
        existingJobs: existingJobs.filter(j => j.status === 'pending' || j.status === 'running').map(j => j.id),
      })
      // Return the most recent pending/running job
      const existing = existingJobs.find(j => j.status === 'pending' || j.status === 'running')!
      return existing
    }

    const job = await this.jobRepo.create({
      task_id: task.id,
      priority: options.priority,
      metadata: options.metadata,
    })

    await engine.scheduleDerivedJob('derived:run', job.id, {
      priority: options.priority ?? 0,
      idempotencyKey: `derived:${task.id}:${job.id}`,
    })

    return job
  }

  /**
   * Type guard to check if result is a PolicyCheckResult (blocked).
   */
  static isBlocked(result: DerivedJob | PolicyCheckResult): result is PolicyCheckResult {
    return 'allowed' in result && result.allowed === false
  }

  /**
   * Get queue stats from the engine's shared queue.
   */
  async getQueueStats(engine: any): Promise<{
    pending: number
    running: number
    completed: number
    failed: number
    dead: number
  }> {
    const stats = await engine.getQueueStats()
    return {
      pending: stats.pending,
      running: stats.running,
      completed: stats.completed,
      failed: stats.failed,
      dead: stats.dead,
    }
  }

  /**
   * Handle failure based on failure classification.
   * Returns appropriate noRetry value for the queue.
   */
  private async handleFailureClass(
    task: DerivedTask,
    jobId: string,
    error: string,
    failureClass?: FailureClass,
    retryAfter?: number
  ): Promise<{ noRetry: boolean }> {
    const fc = failureClass ?? 'unknown'

    switch (fc) {
      case 'permanent':
        // Permanent failure - open circuit immediately, no retry
        await this.jobRepo.failWithClass(jobId, error, fc).catch(() => {})
        await this.taskRepo.recordFailure(task.id, error, { openCircuit: true }).catch(() => {})
        return { noRetry: true }

      case 'rate_limited':
        // Rate limited - schedule retry after the specified time
        await this.jobRepo.failWithClass(jobId, error, fc, retryAfter).catch(() => {})
        if (retryAfter) {
          await this.jobRepo.scheduleRetry(jobId, new Date(retryAfter)).catch(() => {})
        }
        // Don't count as failure for circuit breaker
        return { noRetry: true } // We handle retry ourselves

      case 'resource':
        // Resource exhaustion - pause the task, no retry
        await this.jobRepo.failWithClass(jobId, error, fc).catch(() => {})
        await this.taskRepo.pause(task.id, `Resource exhaustion: ${error}`).catch(() => {})
        return { noRetry: true }

      case 'transient':
      case 'unknown':
      default:
        // Standard exponential backoff handled by circuit breaker
        await this.jobRepo.failWithClass(jobId, error, fc).catch(() => {})
        await this.taskRepo.recordFailure(task.id, error).catch(() => {})
        return { noRetry: false } // Allow queue retry
    }
  }

  /**
   * Handle a derived job execution.
   *
   * Runs the script with its own timeout (from task metadata or integration config).
   * This is separate from the MicroQueue's maxJobRuntime — derived tasks may need
   * significantly longer than sync jobs (e.g., batch API calls to Gemini).
   *
   * If the queue's timeout fires first (Promise.race), this handler keeps running
   * in the background. The finally block ensures derived_jobs status is reconciled.
   */
  private async handleRunJob(job: Job): Promise<JobResult> {
    const payload = (typeof job.payload === 'string'
      ? JSON.parse(job.payload)
      : job.payload) as { derivedJobId?: string }

    const { derivedJobId } = payload

    if (!derivedJobId) {
      return { success: false, error: new Error('Missing derivedJobId in job payload'), noRetry: true }
    }

    const derivedJob = await this.jobRepo.findById(derivedJobId)
    if (!derivedJob) {
      return { success: false, error: new Error(`Derived job not found: ${derivedJobId}`), noRetry: true }
    }

    const task = await this.taskRepo.findById(derivedJob.task_id)
    if (!task) {
      return { success: false, error: new Error(`Derived task not found: ${derivedJob.task_id}`), noRetry: true }
    }

    let started = false

    try {
      let jobForScript: DerivedJob

      const startedJob = await this.jobRepo.start(derivedJob.id)
      if (startedJob) {
        jobForScript = startedJob
        started = true
      } else if (derivedJob.status === 'running') {
        // Crash recovery: the derived job was running when the daemon died.
        // reclaimStale() reclaimed the queue job, bringing us here.
        // Pass the existing job (with checkpoint metadata) to the script
        // so it can resume from where it left off.
        jobForScript = derivedJob
        started = true
      } else {
        // Already completed/failed/cancelled — stale queue entry, nothing to do
        return { success: true }
      }

      const result = await runDerivedScript(this.sql, task, jobForScript)

      // Record cost if provided
      if (result?.cost_cents) {
        await this.jobRepo.recordCost(jobForScript.id, result.cost_cents).catch(() => {})
        // Add to resource pool spend if applicable
        if (task.resource_pool) {
          const pool = await this.poolRepo.findByName(task.resource_pool)
          if (pool) {
            await this.poolRepo.addSpend(pool.id, result.cost_cents).catch(() => {})
          }
        }
      }

      if (result?.metadata) {
        await this.jobRepo.updateMetadata(jobForScript.id, result.metadata)
      }
      if (result?.outputRef !== undefined) {
        await this.jobRepo.setOutputRef(jobForScript.id, result.outputRef ?? null)
      }

      await this.jobRepo.complete(jobForScript.id)
      // Circuit breaker: reset on success
      await this.taskRepo.recordSuccess(task.id).catch(() => {})
      return { success: true }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))

      // Check if error has failure classification info
      const errWithClass = error as { failureClass?: FailureClass; retryAfter?: number }
      const { noRetry } = await this.handleFailureClass(
        task,
        derivedJob.id,
        err.message,
        errWithClass.failureClass,
        errWithClass.retryAfter
      )

      return { success: false, error: err, noRetry }
    } finally {
      // Reconcile: if the queue's timeout fired (Promise.race) while we were
      // still running, derived_jobs may be stuck as 'running'. Check and fix.
      // Note: on process crash, this block doesn't execute — the derived job
      // stays 'running' and reclaimStale() + resume handles recovery.
      if (started) {
        try {
          const current = await this.jobRepo.findById(derivedJob.id)
          if (current && current.status === 'running') {
            await this.jobRepo.fail(derivedJob.id, 'Job timed out or was interrupted by queue')
          }
        } catch {
          // Best-effort reconciliation
        }
      }
    }
  }
}
