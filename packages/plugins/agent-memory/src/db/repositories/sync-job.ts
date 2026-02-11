/**
 * Sync Job Repository
 *
 * CRUD operations for sync_jobs table.
 * Tracks data synchronization jobs from connectors.
 */

import type { ConnectorType } from '../../ids.js'
import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'

export type SyncJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type SyncJobType = 'backfill' | 'incremental' | 'webhook'

export interface SyncJob {
  id: string
  connector: ConnectorType
  account_id: string
  job_type: SyncJobType
  status: SyncJobStatus
  priority: number
  cursor_state?: string | Record<string, unknown>
  items_fetched: number
  items_processed: number
  items_failed: number
  created_at: string
  started_at?: string
  completed_at?: string
  last_error?: string
  retry_count: number
  next_retry_at?: string
  metadata?: Record<string, unknown>
}

export interface SyncJobRow {
  id: string
  connector: string
  account_id: string
  job_type: string
  status: string
  priority: number
  cursor_state: string | Record<string, unknown> | null
  items_fetched: number
  items_processed: number
  items_failed: number
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
  last_error: string | null
  retry_count: number
  next_retry_at: Date | null
  metadata: Record<string, unknown> | null
}

function rowToSyncJob(row: SyncJobRow): SyncJob {
  return {
    id: row.id,
    connector: row.connector as ConnectorType,
    account_id: row.account_id,
    job_type: row.job_type as SyncJobType,
    status: row.status as SyncJobStatus,
    priority: row.priority,
    cursor_state: row.cursor_state ?? undefined,
    items_fetched: row.items_fetched,
    items_processed: row.items_processed,
    items_failed: row.items_failed,
    created_at: row.created_at.toISOString(),
    started_at: row.started_at?.toISOString(),
    completed_at: row.completed_at?.toISOString(),
    last_error: row.last_error ?? undefined,
    retry_count: row.retry_count,
    next_retry_at: row.next_retry_at?.toISOString(),
    metadata: row.metadata ?? undefined,
  }
}

export interface SyncJobInput {
  connector: ConnectorType
  account_id: string
  job_type: SyncJobType
  priority?: number
  cursor_state?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface SyncJobRepository {
  findById(id: string): Promise<SyncJob | null>
  findRecent(options?: PaginationOptions): Promise<PaginatedResult<SyncJob>>
  findPending(options?: PaginationOptions): Promise<PaginatedResult<SyncJob>>
  findByConnector(connector: ConnectorType, accountId: string): Promise<SyncJob[]>
  findRunning(): Promise<SyncJob[]>
  create(input: SyncJobInput): Promise<SyncJob>
  start(id: string): Promise<SyncJob | null>
  complete(id: string): Promise<SyncJob | null>
  fail(id: string, error: string): Promise<SyncJob | null>
  cancel(id: string): Promise<SyncJob | null>
  updateProgress(
    id: string,
    progress: { fetched?: number; processed?: number; failed?: number }
  ): Promise<SyncJob | null>
  updateCursor(id: string, cursor: string | Record<string, unknown>): Promise<SyncJob | null>
  scheduleRetry(id: string, retryAt: Date): Promise<SyncJob | null>
}

/**
 * Maximum allowed size for cursor_state in bytes.
 * Cursors should be tiny (< 1 KB). Anything over 64 KB is a bug
 * (e.g. double-wrapping accumulation from wrapping/unwrapping mismatch).
 */
const MAX_CURSOR_STATE_BYTES = 64 * 1024

export function createSyncJobRepository(ctx: RepositoryContext): SyncJobRepository {
  const { sql } = ctx

  return {
    async findById(id) {
      const [row] = await sql<SyncJobRow[]>`
        SELECT * FROM sync_jobs WHERE id = ${id}
      `
      return row ? rowToSyncJob(row) : null
    },

    async findRecent(options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM sync_jobs
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<SyncJobRow[]>`
        SELECT * FROM sync_jobs
        ORDER BY created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToSyncJob),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findPending(options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM sync_jobs WHERE status = 'pending'
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<SyncJobRow[]>`
        SELECT * FROM sync_jobs
        WHERE status = 'pending'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY priority DESC, created_at ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToSyncJob),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findByConnector(connector, accountId) {
      const rows = await sql<SyncJobRow[]>`
        SELECT * FROM sync_jobs
        WHERE connector = ${connector} AND account_id = ${accountId}
        ORDER BY created_at DESC
      `
      return rows.map(rowToSyncJob)
    },

    async findRunning() {
      const rows = await sql<SyncJobRow[]>`
        SELECT * FROM sync_jobs
        WHERE status = 'running'
        ORDER BY started_at ASC
      `
      return rows.map(rowToSyncJob)
    },

    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()

      let cursorJsonb: string | null = null
      if (input.cursor_state) {
        cursorJsonb = JSON.stringify(input.cursor_state)
        const bytes = Buffer.byteLength(cursorJsonb, 'utf8')
        if (bytes > MAX_CURSOR_STATE_BYTES) {
          console.error('[SyncJob] cursor_state exceeds max size, dropping', {
            id,
            connector: input.connector,
            accountId: input.account_id,
            bytes,
            maxBytes: MAX_CURSOR_STATE_BYTES,
          })
          cursorJsonb = null
        }
      }

      const [row] = await sql<SyncJobRow[]>`
        INSERT INTO sync_jobs (
          id, connector, account_id, job_type, status, priority,
          cursor_state, created_at, metadata
        ) VALUES (
          ${id},
          ${input.connector},
          ${input.account_id},
          ${input.job_type},
          'pending',
          ${input.priority ?? 0},
          ${cursorJsonb}::jsonb,
          ${now},
          ${input.metadata ? JSON.stringify(input.metadata) : null}::jsonb
        )
        RETURNING *
      `

      return rowToSyncJob(row)
    },

    async start(id) {
      const now = new Date()

      const [row] = await sql<SyncJobRow[]>`
        UPDATE sync_jobs
        SET status = 'running', started_at = ${now}
        WHERE id = ${id} AND status IN ('pending', 'failed')
        RETURNING *
      `

      return row ? rowToSyncJob(row) : null
    },

    async complete(id) {
      const now = new Date()

      const [row] = await sql<SyncJobRow[]>`
        UPDATE sync_jobs
        SET status = 'completed', completed_at = ${now}
        WHERE id = ${id} AND status = 'running'
        RETURNING *
      `

      return row ? rowToSyncJob(row) : null
    },

    async fail(id, error) {
      const now = new Date()

      const [row] = await sql<SyncJobRow[]>`
        UPDATE sync_jobs
        SET status = 'failed',
            completed_at = ${now},
            last_error = ${error},
            retry_count = retry_count + 1
        WHERE id = ${id} AND status IN ('pending', 'running')
        RETURNING *
      `

      return row ? rowToSyncJob(row) : null
    },

    async cancel(id) {
      const now = new Date()

      const [row] = await sql<SyncJobRow[]>`
        UPDATE sync_jobs
        SET status = 'cancelled', completed_at = ${now}
        WHERE id = ${id} AND status IN ('pending', 'running')
        RETURNING *
      `

      return row ? rowToSyncJob(row) : null
    },

    async updateProgress(id, progress) {
      const updates: string[] = []
      if (progress.fetched !== undefined) {
        updates.push('items_fetched = items_fetched + ' + progress.fetched)
      }
      if (progress.processed !== undefined) {
        updates.push('items_processed = items_processed + ' + progress.processed)
      }
      if (progress.failed !== undefined) {
        updates.push('items_failed = items_failed + ' + progress.failed)
      }

      if (updates.length === 0) {
        return this.findById(id)
      }

      const [row] = await sql<SyncJobRow[]>`
        UPDATE sync_jobs
        SET items_fetched = items_fetched + ${progress.fetched ?? 0},
            items_processed = items_processed + ${progress.processed ?? 0},
            items_failed = items_failed + ${progress.failed ?? 0}
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToSyncJob(row) : null
    },

    async updateCursor(id, cursor) {
      // Normalize cursor for JSONB storage:
      // - Object cursors serialize directly
      // - String cursors that are valid JSON pass through (stored as the parsed JSON value)
      // - Plain string cursors get JSON.stringify'd (stored as a JSON string value)
      let cursorJsonb: string
      if (typeof cursor === 'object') {
        cursorJsonb = JSON.stringify(cursor)
      } else {
        try {
          JSON.parse(cursor)
          cursorJsonb = cursor // Already valid JSON, store as parsed value
        } catch {
          cursorJsonb = JSON.stringify(cursor) // Wrap plain string as JSON string
        }
      }

      const bytes = Buffer.byteLength(cursorJsonb, 'utf8')
      if (bytes > MAX_CURSOR_STATE_BYTES) {
        console.error('[SyncJob] cursor too large, refusing to store', {
          id,
          bytes,
          maxBytes: MAX_CURSOR_STATE_BYTES,
          preview: cursorJsonb.slice(0, 200),
        })
        return this.findById(id)
      }

      const [row] = await sql<SyncJobRow[]>`
        UPDATE sync_jobs
        SET cursor_state = ${cursorJsonb}::jsonb
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToSyncJob(row) : null
    },

    async scheduleRetry(id, retryAt) {
      const [row] = await sql<SyncJobRow[]>`
        UPDATE sync_jobs
        SET status = 'pending', next_retry_at = ${retryAt}
        WHERE id = ${id} AND status = 'failed'
        RETURNING *
      `

      return row ? rowToSyncJob(row) : null
    },
  }
}
