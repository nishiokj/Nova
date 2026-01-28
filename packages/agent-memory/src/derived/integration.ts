/**
 * Derived Task Integration for SyncEngine
 *
 * Integrates derived task processing into the shared queue.
 * This replaces the standalone DerivedEngine with a lightweight integration.
 */

import type { Sql } from 'postgres'
import type { Job, JobResult } from '../sync/queue.js'
import type { DerivedTask } from '../db/repositories/derived-task.js'
import type { DerivedJob } from '../db/repositories/derived-job.js'
import { createDerivedTaskRepository, createDerivedJobRepository } from '../db/repositories/index.js'
import { runDerivedScript } from './runner.js'

export interface DerivedIntegrationConfig {
  /** Maximum job runtime in ms (default: 1800000 = 30 min) */
  maxJobRuntime?: number
}

export class DerivedTaskIntegration {
  private sql: Sql
  private config: DerivedIntegrationConfig
  private jobRepo: ReturnType<typeof createDerivedJobRepository>
  private taskRepo: ReturnType<typeof createDerivedTaskRepository>

  constructor(sql: Sql, config: DerivedIntegrationConfig = {}) {
    this.sql = sql
    this.config = { maxJobRuntime: 1800000, ...config }
    this.jobRepo = createDerivedJobRepository({ sql })
    this.taskRepo = createDerivedTaskRepository({ sql })
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
   * Create and schedule a derived job via SyncEngine.
   */
  async scheduleTask(
    engine: any,
    task: DerivedTask,
    options: { priority?: number; metadata?: Record<string, unknown> } = {}
  ): Promise<DerivedJob> {
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
      if (result?.metadata) {
        await this.jobRepo.updateMetadata(jobForScript.id, result.metadata)
      }
      if (result?.outputRef !== undefined) {
        await this.jobRepo.setOutputRef(jobForScript.id, result.outputRef ?? null)
      }

      await this.jobRepo.complete(jobForScript.id)
      return { success: true }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      await this.jobRepo.fail(derivedJob.id, err.message).catch(() => {})
      // Allow queue retry so reclaimStale() can resume after a crash.
      // The queue's max_attempts prevents infinite retries.
      return { success: false, error: err }
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
