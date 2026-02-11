/**
 * Derived Task Sandbox
 *
 * Runs a derived task briefly after creation to validate configuration.
 */

import { getDerivedLogPath } from './logging.js'
import type { DerivedJob } from '../db/repositories/derived-job.js'

export interface DerivedTaskSandboxResult {
  job: DerivedJob
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout'
  durationMs: number
  lastError?: string
  logPath?: string
}

export interface DerivedTaskSandboxOptions {
  /** How long to observe the run before returning (ms). Default: 12000. */
  timeoutMs?: number
}

export class TaskSandbox {
  private jobRepo: { findById: (id: string) => Promise<DerivedJob | null> }

  constructor(jobRepo: { findById: (id: string) => Promise<DerivedJob | null> }) {
    this.jobRepo = jobRepo
  }

  async observe(jobId: string, options: DerivedTaskSandboxOptions = {}): Promise<DerivedTaskSandboxResult> {
    const timeoutMs = options.timeoutMs ?? 12000
    const startedAt = Date.now()

    let current = await this.jobRepo.findById(jobId)
    if (!current) {
      return {
        job: {
          id: jobId,
          task_id: 'unknown',
          status: 'failed',
          priority: 0,
          created_at: new Date().toISOString(),
          retry_count: 0,
        },
        status: 'failed',
        durationMs: Date.now() - startedAt,
        lastError: 'Derived job not found for sandbox validation',
        logPath: getDerivedLogPath(jobId),
      }
    }

    let status: DerivedTaskSandboxResult['status'] = current.status as DerivedTaskSandboxResult['status']

    while (Date.now() - startedAt < timeoutMs) {
      await sleep(1000)
      current = await this.jobRepo.findById(jobId)
      if (!current) break
      status = current.status as DerivedTaskSandboxResult['status']
      if (status === 'completed' || status === 'failed') break
    }

    if (status !== 'completed' && status !== 'failed') {
      status = 'timeout'
    }

    const logPath = (current?.metadata?._logPath as string | undefined) ?? getDerivedLogPath(jobId)

    return {
      job: current ?? {
        id: jobId,
        task_id: 'unknown',
        status: 'failed',
        priority: 0,
        created_at: new Date().toISOString(),
        retry_count: 0,
      },
      status,
      durationMs: Date.now() - startedAt,
      lastError: current?.last_error,
      logPath,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
