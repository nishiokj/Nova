/**
 * Derived Run Log Repository
 *
 * Stores structured per-run metrics and small output samples for sanity checks.
 */

import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext } from './types.js'

export type DerivedRunStatus = 'ok' | 'skipped' | 'failed'

export interface DerivedRunLogInput {
  id?: string
  jobId: string
  taskId: string
  status: DerivedRunStatus
  inputCount?: number | null
  outputCount?: number | null
  outputUnusableCount?: number | null
  modelVersion?: string | null
  durationMs?: number | null
  skipReason?: string | null
  errorCode?: string | null
  errorMsg?: string | null
}

export interface DerivedRunLogRow {
  id: string
  job_id: string
  task_id: string
  status: string
  input_count: number | null
  output_count: number | null
  output_unusable_count: number | null
  model_version: string | null
  duration_ms: number | null
  skip_reason: string | null
  error_code: string | null
  error_msg: string | null
  created_at: Date
}

export interface DerivedRunLogRecord {
  id: string
  job_id: string
  task_id: string
  status: DerivedRunStatus
  input_count: number | null
  output_count: number | null
  output_unusable_count: number | null
  model_version: string | null
  duration_ms: number | null
  skip_reason: string | null
  error_code: string | null
  error_msg: string | null
  created_at: string
}

export interface DerivedRunSampleInput {
  runId: string
  sampleIndex: number
  label?: string | null
  sample: unknown
}

export interface DerivedRunLogRepository {
  create(input: DerivedRunLogInput): Promise<DerivedRunLogRecord>
  insertSamples(samples: DerivedRunSampleInput[]): Promise<void>
  findByTask(taskId: string, limit?: number): Promise<DerivedRunLogRecord[]>
  findByJob(jobId: string): Promise<DerivedRunLogRecord | null>
}

function rowToDerivedRunLog(row: DerivedRunLogRow): DerivedRunLogRecord {
  return {
    id: row.id,
    job_id: row.job_id,
    task_id: row.task_id,
    status: row.status as DerivedRunStatus,
    input_count: row.input_count,
    output_count: row.output_count,
    output_unusable_count: row.output_unusable_count,
    model_version: row.model_version,
    duration_ms: row.duration_ms,
    skip_reason: row.skip_reason,
    error_code: row.error_code,
    error_msg: row.error_msg,
    created_at: row.created_at.toISOString(),
  }
}

export function createDerivedRunLogRepository(ctx: RepositoryContext): DerivedRunLogRepository {
  const { sql } = ctx

  return {
    async create(input) {
      const id = input.id ?? generateCanonicalId()
      const [row] = await sql<DerivedRunLogRow[]>`
        INSERT INTO derived_run_log (
          id,
          job_id,
          task_id,
          status,
          input_count,
          output_count,
          output_unusable_count,
          model_version,
          duration_ms,
          skip_reason,
          error_code,
          error_msg
        ) VALUES (
          ${id},
          ${input.jobId},
          ${input.taskId},
          ${input.status},
          ${input.inputCount ?? null},
          ${input.outputCount ?? null},
          ${input.outputUnusableCount ?? null},
          ${input.modelVersion ?? null},
          ${input.durationMs ?? null},
          ${input.skipReason ?? null},
          ${input.errorCode ?? null},
          ${input.errorMsg ?? null}
        )
        RETURNING *
      `

      return rowToDerivedRunLog(row)
    },

    async insertSamples(samples) {
      if (samples.length === 0) return

      const rows = samples.map((sample) => ({
        run_id: sample.runId,
        sample_index: sample.sampleIndex,
        label: sample.label ?? null,
        sample: sql.json(sample.sample as any),
      }))

      await sql`
        INSERT INTO derived_run_samples (run_id, sample_index, label, sample)
        SELECT
          run_id,
          sample_index,
          label,
          sample
        FROM ${sql(rows)}
        ON CONFLICT (run_id, sample_index) DO NOTHING
      `
    },

    async findByTask(taskId, limit = 20) {
      const rows = await sql<DerivedRunLogRow[]>`
        SELECT * FROM derived_run_log
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows.map(rowToDerivedRunLog)
    },

    async findByJob(jobId) {
      const [row] = await sql<DerivedRunLogRow[]>`
        SELECT * FROM derived_run_log
        WHERE job_id = ${jobId}
        LIMIT 1
      `
      return row ? rowToDerivedRunLog(row) : null
    },
  }
}
