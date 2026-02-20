/**
 * Agentic Task Integration for SyncEngine
 *
 * Bridges the scheduler, queue, and runner.
 * Mirrors DerivedTaskIntegration pattern.
 */

import { join } from 'path'
import { mkdir } from 'fs/promises'
import type { Sql } from 'postgres'
import type { AgenticTask, AgenticRun } from 'types'
import type { Job, JobResult } from '../sync/queue.js'
import type { SyncEngine } from '../sync/engine.js'
import {
  createAgenticTaskRepository,
  type AgenticTaskRepository,
} from '../db/repositories/agentic-task.js'
import {
  createAgenticRunRepository,
  type AgenticRunRepository,
} from '../db/repositories/agentic-run.js'
import { executeAgenticRun, type HarnessConnectionConfig } from './runner.js'

export interface AgenticIntegrationConfig {
  /** Maximum job runtime in ms (default: 600000 = 10 min) */
  maxJobRuntime?: number
  /** Base directory for agentic task data (default: 'data/agentic-tasks') */
  dataDir?: string
  /** Harness daemon connection config for dispatching agent sessions */
  harnessConfig?: HarnessConnectionConfig
}

export class AgenticTaskIntegration {
  private sql: Sql
  private config: Required<Pick<AgenticIntegrationConfig, 'maxJobRuntime' | 'dataDir'>> & Pick<AgenticIntegrationConfig, 'harnessConfig'>
  private taskRepo: AgenticTaskRepository
  private runRepo: AgenticRunRepository

  constructor(sql: Sql, config: AgenticIntegrationConfig = {}) {
    this.sql = sql
    this.config = {
      maxJobRuntime: config.maxJobRuntime ?? 600000,
      dataDir: config.dataDir ?? 'data/agentic-tasks',
      harnessConfig: config.harnessConfig,
    }
    const ctx = { sql }
    this.taskRepo = createAgenticTaskRepository(ctx)
    this.runRepo = createAgenticRunRepository(ctx)
  }

  /** Register 'agentic:run' handler on the shared MicroQueue */
  registerHandlers(engine: SyncEngine): void {
    engine.registerDerivedJobHandler('agentic:run', async (job: Job) => {
      return this.handleRunJob(job)
    }, { timeout: this.config.maxJobRuntime })
  }

  /** Create run + enqueue. Skips if active run exists for this task. */
  async scheduleTask(engine: SyncEngine, task: AgenticTask): Promise<AgenticRun | null> {
    if (await this.runRepo.hasActiveRun(task.id)) return null

    const run = await this.runRepo.create({ taskId: task.id })
    await engine.scheduleDerivedJob('agentic:run', run.id, {
      idempotencyKey: `agentic:${task.id}:${run.id}`,
    })
    return run
  }

  /** Expose taskRepo for scheduler's disable/update calls */
  get agenticTaskRepo(): AgenticTaskRepository {
    return this.taskRepo
  }

  /** Expose runRepo for route handlers */
  get agenticRunRepo(): AgenticRunRepository {
    return this.runRepo
  }

  /** MicroQueue handler: load task, dispatch agent session, record results */
  private async handleRunJob(job: Job): Promise<JobResult> {
    const payload = (typeof job.payload === 'string'
      ? JSON.parse(job.payload)
      : job.payload) as { derivedJobId?: string }

    const agenticRunId = payload.derivedJobId
    if (!agenticRunId) {
      return { success: false, error: new Error('Missing derivedJobId in job payload'), noRetry: true }
    }

    const run = await this.runRepo.findById(agenticRunId)
    if (!run) return { success: false, error: new Error('Run not found'), noRetry: true }

    const task = await this.taskRepo.findById(run.taskId)
    if (!task) return { success: false, error: new Error('Task not found'), noRetry: true }
    if (!task.compiledPromptPath) return { success: false, error: new Error('No compiled prompt'), noRetry: true }

    const outputDir = join(this.config.dataDir, task.id, 'runs', run.id)
    await mkdir(outputDir, { recursive: true })

    const logger = {
      info: (...args: unknown[]) => console.log('[AgenticRun]', run.id, ...args),
      warn: (...args: unknown[]) => console.warn('[AgenticRun]', run.id, ...args),
      error: (...args: unknown[]) => console.error('[AgenticRun]', run.id, ...args),
    }

    try {
      await this.runRepo.start(run.id)

      const result = await executeAgenticRun({ task, run, outputDir, logger, harnessConfig: this.config.harnessConfig })

      if (result.budgetExceeded) {
        await this.runRepo.markBudgetExceeded(run.id, result.mutations)
        await this.runRepo.fail(run.id, 'Mutation budget exceeded')
        await this.taskRepo.recordFailure(task.id, 'Mutation budget exceeded')
        return { success: false, error: new Error('Budget exceeded'), noRetry: true }
      }

      await this.runRepo.markVerifying(run.id, result.agentOutput, result.agentSummary ?? undefined)
      await this.runRepo.recordMutations(run.id, result.mutations)
      await this.runRepo.complete(run.id, result.verdict, result.verdictReport, null)

      if (result.verdict === 'fail') {
        await this.taskRepo.recordFailure(task.id, 'Verification verdict: fail')
      } else {
        await this.taskRepo.recordSuccess(task.id)
      }

      return { success: true }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      await this.runRepo.fail(run.id, err.message).catch(() => {})
      await this.taskRepo.recordFailure(task.id, err.message).catch(() => {})
      return { success: false, error: err }
    }
  }
}
