/**
 * Job Queue Repository
 *
 * CRUD operations for job_queue table.
 * Provides low-level database access for the MicroQueue system.
 */

import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead'

export interface QueueJob<T = unknown> {
  id: string
  job_type: string
  payload: T
  status: JobStatus
  priority: number
  visible_at: string
  locked_until?: string
  locked_by?: string
  attempt_count: number
  max_attempts: number
  last_error?: string
  created_at: string
  started_at?: string
  completed_at?: string
  idempotency_key?: string
}

export interface QueueJobRow {
  id: string
  job_type: string
  payload: unknown
  status: string
  priority: number
  visible_at: Date
  locked_until: Date | null
  locked_by: string | null
  attempt_count: number
  max_attempts: number
  last_error: string | null
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
  idempotency_key: string | null
}

function rowToJob<T>(row: QueueJobRow): QueueJob<T> {
  return {
    id: row.id,
    job_type: row.job_type,
    payload: row.payload as T,
    status: row.status as JobStatus,
    priority: row.priority,
    visible_at: row.visible_at.toISOString(),
    locked_until: row.locked_until?.toISOString(),
    locked_by: row.locked_by ?? undefined,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    last_error: row.last_error ?? undefined,
    created_at: row.created_at.toISOString(),
    started_at: row.started_at?.toISOString(),
    completed_at: row.completed_at?.toISOString(),
    idempotency_key: row.idempotency_key ?? undefined,
  }
}

export interface EnqueueOptions {
  priority?: number
  delay?: number
  idempotencyKey?: string
  maxAttempts?: number
}

export interface JobQueueRepository {
  /** Enqueue a new job */
  enqueue<T>(jobType: string, payload: T, options?: EnqueueOptions): Promise<QueueJob<T>>

  /**
   * Dequeue the next available job with atomic lock.
   * Uses SELECT FOR UPDATE SKIP LOCKED for safe concurrent access.
   */
  dequeue<T>(
    workerId: string,
    visibilityTimeout: number
  ): Promise<QueueJob<T> | null>

  /** Mark a job as completed */
  complete(id: string): Promise<QueueJob | null>

  /**
   * Mark a job as failed.
   * If retries remain and retryable, schedules next attempt.
   * If no retries remain, marks as dead.
   */
  fail(
    id: string,
    error: string,
    options?: { retryDelay?: number; markDead?: boolean }
  ): Promise<QueueJob | null>

  /** Release a locked job back to pending (e.g., on worker shutdown) */
  release(id: string): Promise<QueueJob | null>

  /** Extend the lock on a job (heartbeat) */
  extendLock(id: string, workerId: string, extensionMs: number): Promise<QueueJob | null>

  /** Find a job by ID */
  findById<T>(id: string): Promise<QueueJob<T> | null>

  /** Find jobs by status with pagination */
  findByStatus(status: JobStatus, options?: PaginationOptions): Promise<PaginatedResult<QueueJob>>

  /** Find jobs by type */
  findByType(jobType: string, options?: PaginationOptions): Promise<PaginatedResult<QueueJob>>

  /** Find dead jobs (for inspection/retry) */
  findDead(options?: PaginationOptions): Promise<PaginatedResult<QueueJob>>

  /** Resurrect a dead job back to pending */
  resurrect(id: string): Promise<QueueJob | null>

  /** Delete a job */
  delete(id: string): Promise<boolean>

  /** Bulk delete old completed jobs */
  pruneCompleted(olderThan: Date): Promise<number>

  /** Count jobs by status */
  countByStatus(): Promise<Record<JobStatus, number>>

  /** Reclaim stale jobs (locked but expired) */
  reclaimStale(): Promise<number>
}

export function createJobQueueRepository(ctx: RepositoryContext): JobQueueRepository {
  const { sql } = ctx

  return {
    async enqueue<T>(jobType: string, payload: T, options: EnqueueOptions = {}) {
      const id = generateCanonicalId()
      const visibleAt = new Date(Date.now() + (options.delay ?? 0))

      const [row] = await sql<QueueJobRow[]>`
        INSERT INTO job_queue (
          id, job_type, payload, status, priority, visible_at, max_attempts, idempotency_key
        ) VALUES (
          ${id},
          ${jobType},
          ${JSON.stringify(payload)}::jsonb,
          'pending',
          ${options.priority ?? 0},
          ${visibleAt},
          ${options.maxAttempts ?? 3},
          ${options.idempotencyKey ?? null}
        )
        ON CONFLICT (idempotency_key) DO UPDATE
          SET id = job_queue.id
        RETURNING *
      `

      return rowToJob<T>(row)
    },

    async dequeue<T>(workerId: string, visibilityTimeout: number) {
      const lockUntil = new Date(Date.now() + visibilityTimeout)

      const [row] = await sql<QueueJobRow[]>`
        UPDATE job_queue
        SET status = 'running',
            locked_until = ${lockUntil},
            locked_by = ${workerId},
            started_at = COALESCE(started_at, NOW()),
            attempt_count = attempt_count + 1
        WHERE id = (
          SELECT id FROM job_queue
          WHERE status = 'pending' AND visible_at <= NOW()
          ORDER BY priority DESC, visible_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *
      `

      return row ? rowToJob<T>(row) : null
    },

    async complete(id: string) {
      const [row] = await sql<QueueJobRow[]>`
        UPDATE job_queue
        SET status = 'completed',
            completed_at = NOW(),
            locked_until = NULL,
            locked_by = NULL
        WHERE id = ${id} AND status = 'running'
        RETURNING *
      `

      return row ? rowToJob(row) : null
    },

    async fail(id: string, error: string, options: { retryDelay?: number; markDead?: boolean } = {}) {
      // First, get the current job state
      const [current] = await sql<QueueJobRow[]>`
        SELECT * FROM job_queue WHERE id = ${id} FOR UPDATE
      `

      if (!current) return null

      const attemptsExhausted = current.attempt_count >= current.max_attempts
      const shouldMarkDead = options.markDead || attemptsExhausted

      if (shouldMarkDead) {
        // Mark as dead - no more retries
        const [row] = await sql<QueueJobRow[]>`
          UPDATE job_queue
          SET status = 'dead',
              completed_at = NOW(),
              last_error = ${error},
              locked_until = NULL,
              locked_by = NULL
          WHERE id = ${id}
          RETURNING *
        `
        return row ? rowToJob(row) : null
      }

      // Schedule retry with backoff
      const retryDelay = options.retryDelay ?? computeBackoff(current.attempt_count)
      const visibleAt = new Date(Date.now() + retryDelay)

      const [row] = await sql<QueueJobRow[]>`
        UPDATE job_queue
        SET status = 'pending',
            visible_at = ${visibleAt},
            last_error = ${error},
            locked_until = NULL,
            locked_by = NULL
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToJob(row) : null
    },

    async release(id: string) {
      const [row] = await sql<QueueJobRow[]>`
        UPDATE job_queue
        SET status = 'pending',
            locked_until = NULL,
            locked_by = NULL
        WHERE id = ${id} AND status = 'running'
        RETURNING *
      `

      return row ? rowToJob(row) : null
    },

    async extendLock(id: string, workerId: string, extensionMs: number) {
      const newLockUntil = new Date(Date.now() + extensionMs)

      const [row] = await sql<QueueJobRow[]>`
        UPDATE job_queue
        SET locked_until = ${newLockUntil}
        WHERE id = ${id}
          AND status = 'running'
          AND locked_by = ${workerId}
        RETURNING *
      `

      return row ? rowToJob(row) : null
    },

    async findById<T>(id: string) {
      const [row] = await sql<QueueJobRow[]>`
        SELECT * FROM job_queue WHERE id = ${id}
      `
      return row ? rowToJob<T>(row) : null
    },

    async findByStatus(status: JobStatus, options: PaginationOptions = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM job_queue WHERE status = ${status}
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<QueueJobRow[]>`
        SELECT * FROM job_queue
        WHERE status = ${status}
        ORDER BY priority DESC, created_at ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToJob),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findByType(jobType: string, options: PaginationOptions = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM job_queue WHERE job_type = ${jobType}
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<QueueJobRow[]>`
        SELECT * FROM job_queue
        WHERE job_type = ${jobType}
        ORDER BY created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToJob),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findDead(options: PaginationOptions = {}) {
      return this.findByStatus('dead', options)
    },

    async resurrect(id: string) {
      const [row] = await sql<QueueJobRow[]>`
        UPDATE job_queue
        SET status = 'pending',
            visible_at = NOW(),
            attempt_count = 0,
            last_error = NULL,
            completed_at = NULL,
            locked_until = NULL,
            locked_by = NULL
        WHERE id = ${id} AND status = 'dead'
        RETURNING *
      `

      return row ? rowToJob(row) : null
    },

    async delete(id: string) {
      const result = await sql`
        DELETE FROM job_queue WHERE id = ${id}
      `
      return result.count > 0
    },

    async pruneCompleted(olderThan: Date) {
      const result = await sql`
        DELETE FROM job_queue
        WHERE status = 'completed' AND completed_at < ${olderThan}
      `
      return result.count
    },

    async countByStatus() {
      const rows = await sql<{ status: string; count: string }[]>`
        SELECT status, COUNT(*) as count
        FROM job_queue
        GROUP BY status
      `

      const counts: Record<JobStatus, number> = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        dead: 0,
      }

      for (const row of rows) {
        counts[row.status as JobStatus] = parseInt(row.count, 10)
      }

      return counts
    },

    async reclaimStale() {
      const result = await sql`
        UPDATE job_queue
        SET status = 'pending',
            locked_until = NULL,
            locked_by = NULL
        WHERE status = 'running'
          AND locked_until < NOW()
      `
      return result.count
    },
  }
}

/**
 * Compute exponential backoff delay.
 * Formula: baseDelay * 2^(attempt - 1) with jitter
 */
function computeBackoff(attempt: number, baseMs = 1000, maxMs = 60000): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs)
  const jitter = Math.random() * 0.3 * exponential
  return Math.floor(exponential + jitter)
}
