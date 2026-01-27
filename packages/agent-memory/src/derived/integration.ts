/**
 * Derived Task Integration for SyncEngine
 *
 * Integrates derived task processing into the shared queue.
 * This replaces the standalone DerivedEngine with a lightweight integration.
 */

import type { Sql } from 'postgres'
import type { Job, JobResult } from '../sync/queue.js'
import type { DerivedTask, DerivedJob } from '../db/repositories/derived-task.js'
import { createDerivedTaskRepository, createDerivedJobRepository } from '../db/repositories/index.js'
import { runDerivedScript } from './runner.js'

export interface DerivedIntegrationConfig {
  /** Maximum job runtime in ms (default: 300000 = 5 min) */
  maxJobRuntime?: number
}

export class DerivedTaskIntegration {
  private sql: Sql
  private config: DerivedIntegrationConfig
  private jobRepo: ReturnType<typeof createDerivedJobRepository>
  private taskRepo: ReturnType<typeof createDerivedTaskRepository>

  constructor(sql: Sql, config: DerivedIntegrationConfig = {}) {
    this.sql = sql
    this.config = { maxJobRuntime: 300000, ...config }
    this.jobRepo = createDerivedJobRepository({ sql })
    this.taskRepo = createDerivedTaskRepository({ sql })
  }

  /**
   * Register derived task handlers with the SyncEngine's queue.
   */
  registerHandlers(engine: any): void {
    engine.registerDerivedJobHandler('derived:run', async (job: Job) => {
      return this.handleRunJob(job)
    })
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
   */
  private async handleRunJob(job: Job): Promise<JobResult> {
    const payload = typeof job.payload === 'string'
      ? JSON.parse(job.payload) as { derivedJobId: string }
      : job.payload

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

    try {
      const startedJob = await this.jobRepo.start(derivedJob.id)
      if (!startedJob) {
        return { success: true }
      }

      const result = await runDerivedScript(this.sql, task, startedJob)
      if (result?.metadata) {
        await this.jobRepo.updateMetadata(startedJob.id, result.metadata)
      }
      if (result?.outputRef !== undefined) {
        await this.jobRepo.setOutputRef(startedJob.id, result.outputRef ?? null)
      }

      await this.jobRepo.complete(startedJob.id)
      return { success: true }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      await this.jobRepo.fail(derivedJob.id, err.message)
      return { success: false, error: err }
    }
  }
}
