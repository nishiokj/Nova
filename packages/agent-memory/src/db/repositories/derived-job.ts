/**
 * Derived Job Repository
 *
 * CRUD operations for derived_jobs table.
 * Tracks derived post-processing jobs.
 */

import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'

export type DerivedJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface DerivedJob {
  id: string
  task_id: string
  status: DerivedJobStatus
  priority: number
  created_at: string
  started_at?: string
  completed_at?: string
  last_error?: string
  retry_count: number
  next_retry_at?: string
  metadata?: Record<string, unknown>
  output_ref?: string
}

export interface DerivedJobRow {
  id: string
  task_id: string
  status: string
  priority: number
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
  last_error: string | null
  retry_count: number
  next_retry_at: Date | null
  metadata: Record<string, unknown> | null
  output_ref: string | null
}

function rowToDerivedJob(row: DerivedJobRow): DerivedJob {
  return {
    id: row.id,
    task_id: row.task_id,
    status: row.status as DerivedJobStatus,
    priority: row.priority,
    created_at: row.created_at.toISOString(),
    started_at: row.started_at?.toISOString(),
    completed_at: row.completed_at?.toISOString(),
    last_error: row.last_error ?? undefined,
    retry_count: row.retry_count,
    next_retry_at: row.next_retry_at?.toISOString(),
    metadata: row.metadata ?? undefined,
    output_ref: row.output_ref ?? undefined,
  }
}

export interface DerivedJobInput {
  task_id: string
  priority?: number
  metadata?: Record<string, unknown>
}

export interface DerivedJobRepository {
  findById(id: string): Promise<DerivedJob | null>
  findRecent(options?: PaginationOptions): Promise<PaginatedResult<DerivedJob>>
  findPending(options?: PaginationOptions): Promise<PaginatedResult<DerivedJob>>
  findByTask(taskId: string, limit?: number): Promise<DerivedJob[]>
  findRunning(): Promise<DerivedJob[]>
  create(input: DerivedJobInput): Promise<DerivedJob>
  start(id: string): Promise<DerivedJob | null>
  complete(id: string): Promise<DerivedJob | null>
  fail(id: string, error: string): Promise<DerivedJob | null>
  cancel(id: string): Promise<DerivedJob | null>
  scheduleRetry(id: string, retryAt: Date): Promise<DerivedJob | null>
  updateMetadata(id: string, metadata: Record<string, unknown>): Promise<DerivedJob | null>
  setOutputRef(id: string, outputRef: string | null): Promise<DerivedJob | null>
}

export function createDerivedJobRepository(ctx: RepositoryContext): DerivedJobRepository {
  const { sql } = ctx

  return {
    async findById(id) {
      const [row] = await sql<DerivedJobRow[]>`
        SELECT * FROM derived_jobs WHERE id = ${id}
      `
      return row ? rowToDerivedJob(row) : null
    },

    async findRecent(options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM derived_jobs
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<DerivedJobRow[]>`
        SELECT * FROM derived_jobs
        ORDER BY created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToDerivedJob),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findPending(options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM derived_jobs WHERE status = 'pending'
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<DerivedJobRow[]>`
        SELECT * FROM derived_jobs
        WHERE status = 'pending'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY priority DESC, created_at ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToDerivedJob),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findByTask(taskId, limit = 100) {
      const rows = await sql<DerivedJobRow[]>`
        SELECT * FROM derived_jobs
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows.map(rowToDerivedJob)
    },

    async findRunning() {
      const rows = await sql<DerivedJobRow[]>`
        SELECT * FROM derived_jobs
        WHERE status = 'running'
        ORDER BY started_at ASC
      `
      return rows.map(rowToDerivedJob)
    },

    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<DerivedJobRow[]>`
        INSERT INTO derived_jobs (
          id, task_id, status, priority, created_at, retry_count, metadata
        ) VALUES (
          ${id},
          ${input.task_id},
          'pending',
          ${input.priority ?? 0},
          ${now},
          0,
          ${input.metadata ?? null}
        )
        RETURNING *
      `

      return rowToDerivedJob(row)
    },

    async start(id) {
      const now = new Date()
      const [row] = await sql<DerivedJobRow[]>`
        UPDATE derived_jobs
        SET status = 'running', started_at = ${now}
        WHERE id = ${id}
          AND status = 'pending'
        RETURNING *
      `
      return row ? rowToDerivedJob(row) : null
    },

    async complete(id) {
      const now = new Date()
      const [row] = await sql<DerivedJobRow[]>`
        UPDATE derived_jobs
        SET status = 'completed', completed_at = ${now}
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDerivedJob(row) : null
    },

    async fail(id, error) {
      const now = new Date()
      const [row] = await sql<DerivedJobRow[]>`
        UPDATE derived_jobs
        SET status = 'failed', completed_at = ${now}, last_error = ${error},
            retry_count = retry_count + 1
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDerivedJob(row) : null
    },

    async cancel(id) {
      const now = new Date()
      const [row] = await sql<DerivedJobRow[]>`
        UPDATE derived_jobs
        SET status = 'cancelled', completed_at = ${now}
        WHERE id = ${id}
          AND status IN ('pending', 'running')
        RETURNING *
      `
      return row ? rowToDerivedJob(row) : null
    },

    async scheduleRetry(id, retryAt) {
      const [row] = await sql<DerivedJobRow[]>`
        UPDATE derived_jobs
        SET next_retry_at = ${retryAt}, status = 'pending'
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDerivedJob(row) : null
    },

    async updateMetadata(id, metadata) {
      const [row] = await sql<DerivedJobRow[]>`
        UPDATE derived_jobs
        SET metadata = ${metadata}
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDerivedJob(row) : null
    },

    async setOutputRef(id, outputRef) {
      const [row] = await sql<DerivedJobRow[]>`
        UPDATE derived_jobs
        SET output_ref = ${outputRef}
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDerivedJob(row) : null
    },
  }
}
