/**
 * Sync Task Repository
 *
 * CRUD operations for sync_tasks table.
 * Manages persistent sync subscriptions and scheduling.
 */

import type { ConnectorType } from '../../ids.js'
import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'

export type SyncType = 'backfill' | 'incremental'
export type TaskMode = 'once' | 'recurring' | 'webhook'

export interface SyncTask {
  id: string
  connector: ConnectorType
  account_id: string
  entity_types: string[] | null
  sync_type: SyncType
  mode: TaskMode
  interval_ms: number | null
  enabled: boolean
  last_job_id: string | null
  next_run_at: string | null
  webhook_subscription_id: string | null
  created_at: string
  updated_at: string
}

export interface SyncTaskRow {
  id: string
  connector: string
  account_id: string
  entity_types: string[] | null
  sync_type: string
  mode: string
  interval_ms: bigint | null
  enabled: boolean
  last_job_id: string | null
  next_run_at: Date | null
  webhook_subscription_id: string | null
  created_at: Date
  updated_at: Date
}

function rowToSyncTask(row: SyncTaskRow): SyncTask {
  return {
    id: row.id,
    connector: row.connector as ConnectorType,
    account_id: row.account_id,
    entity_types: row.entity_types,
    sync_type: row.sync_type as SyncType,
    mode: row.mode as TaskMode,
    interval_ms: row.interval_ms !== null ? Number(row.interval_ms) : null,
    enabled: row.enabled,
    last_job_id: row.last_job_id,
    next_run_at: row.next_run_at?.toISOString() ?? null,
    webhook_subscription_id: row.webhook_subscription_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export interface SyncTaskInput {
  connector: ConnectorType
  accountId: string
  entityTypes?: string[]
  syncType: SyncType
  mode: TaskMode
  intervalMs?: number
}

export interface SyncTaskRepository {
  // CRUD
  create(input: SyncTaskInput): Promise<SyncTask>
  findById(id: string): Promise<SyncTask | null>
  findAll(limit?: number): Promise<SyncTask[]>
  findByAccount(accountId: string): Promise<SyncTask[]>
  findByConnector(connector: ConnectorType, accountId?: string): Promise<SyncTask[]>
  update(id: string, updates: Partial<Pick<SyncTask, 'entity_types' | 'interval_ms' | 'enabled'>>): Promise<SyncTask | null>
  delete(id: string): Promise<boolean>

  // Scheduler queries
  findDueForExecution(limit?: number): Promise<SyncTask[]>
  findWebhookTasks(connector?: ConnectorType): Promise<SyncTask[]>

  // State updates
  markExecuted(id: string, jobId: string): Promise<SyncTask | null>
  updateNextRunAt(id: string, nextRunAt: Date): Promise<boolean>
  setWebhookSubscriptionId(id: string, subscriptionId: string | null): Promise<boolean>

  // Bulk operations
  disableForAccount(accountId: string): Promise<number>
  enableForAccount(accountId: string): Promise<number>
}

export function createSyncTaskRepository(ctx: RepositoryContext): SyncTaskRepository {
  const { sql } = ctx

  return {
    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()

      // For recurring tasks, set next_run_at to now so it runs immediately
      const nextRunAt = input.mode === 'recurring' ? now : null

      const [row] = await sql<SyncTaskRow[]>`
        INSERT INTO sync_tasks (
          id, connector, account_id, entity_types, sync_type,
          mode, interval_ms, enabled, next_run_at, created_at, updated_at
        ) VALUES (
          ${id},
          ${input.connector},
          ${input.accountId},
          ${input.entityTypes ?? null},
          ${input.syncType},
          ${input.mode},
          ${input.intervalMs ?? null},
          true,
          ${nextRunAt},
          ${now},
          ${now}
        )
        RETURNING *
      `

      return rowToSyncTask(row)
    },

    async findById(id) {
      const [row] = await sql<SyncTaskRow[]>`
        SELECT * FROM sync_tasks WHERE id = ${id}
      `
      return row ? rowToSyncTask(row) : null
    },

    async findAll(limit = 100) {
      const rows = await sql<SyncTaskRow[]>`
        SELECT * FROM sync_tasks
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows.map(rowToSyncTask)
    },

    async findByAccount(accountId) {
      const rows = await sql<SyncTaskRow[]>`
        SELECT * FROM sync_tasks
        WHERE account_id = ${accountId}
        ORDER BY created_at DESC
      `
      return rows.map(rowToSyncTask)
    },

    async findByConnector(connector, accountId) {
      if (accountId) {
        const rows = await sql<SyncTaskRow[]>`
          SELECT * FROM sync_tasks
          WHERE connector = ${connector} AND account_id = ${accountId}
          ORDER BY created_at DESC
        `
        return rows.map(rowToSyncTask)
      }

      const rows = await sql<SyncTaskRow[]>`
        SELECT * FROM sync_tasks
        WHERE connector = ${connector}
        ORDER BY created_at DESC
      `
      return rows.map(rowToSyncTask)
    },

    async update(id, updates) {
      const now = new Date()

      const [row] = await sql<SyncTaskRow[]>`
        UPDATE sync_tasks
        SET entity_types = COALESCE(${updates.entity_types ?? null}, entity_types),
            interval_ms = COALESCE(${updates.interval_ms ?? null}, interval_ms),
            enabled = COALESCE(${updates.enabled ?? null}, enabled),
            updated_at = ${now}
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToSyncTask(row) : null
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM sync_tasks WHERE id = ${id}
      `
      return result.count > 0
    },

    async findDueForExecution(limit = 50) {
      // Find tasks that are:
      // 1. Enabled
      // 2. Mode is 'once' or 'recurring' (not webhook)
      // 3. next_run_at is NULL (never run) OR next_run_at <= now
      const rows = await sql<SyncTaskRow[]>`
        SELECT * FROM sync_tasks
        WHERE enabled = true
          AND mode IN ('once', 'recurring')
          AND (next_run_at IS NULL OR next_run_at <= NOW())
        ORDER BY next_run_at ASC NULLS FIRST
        LIMIT ${limit}
      `
      return rows.map(rowToSyncTask)
    },

    async findWebhookTasks(connector) {
      if (connector) {
        const rows = await sql<SyncTaskRow[]>`
          SELECT * FROM sync_tasks
          WHERE enabled = true
            AND mode = 'webhook'
            AND connector = ${connector}
          ORDER BY created_at DESC
        `
        return rows.map(rowToSyncTask)
      }

      const rows = await sql<SyncTaskRow[]>`
        SELECT * FROM sync_tasks
        WHERE enabled = true
          AND mode = 'webhook'
        ORDER BY connector, created_at DESC
      `
      return rows.map(rowToSyncTask)
    },

    async markExecuted(id, jobId) {
      const now = new Date()

      const [row] = await sql<SyncTaskRow[]>`
        UPDATE sync_tasks
        SET last_job_id = ${jobId},
            updated_at = ${now}
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToSyncTask(row) : null
    },

    async updateNextRunAt(id, nextRunAt) {
      const now = new Date()

      const result = await sql`
        UPDATE sync_tasks
        SET next_run_at = ${nextRunAt},
            updated_at = ${now}
        WHERE id = ${id}
      `

      return result.count > 0
    },

    async setWebhookSubscriptionId(id, subscriptionId) {
      const now = new Date()

      const result = await sql`
        UPDATE sync_tasks
        SET webhook_subscription_id = ${subscriptionId},
            updated_at = ${now}
        WHERE id = ${id}
      `

      return result.count > 0
    },

    async disableForAccount(accountId) {
      const now = new Date()

      const result = await sql`
        UPDATE sync_tasks
        SET enabled = false,
            updated_at = ${now}
        WHERE account_id = ${accountId} AND enabled = true
      `

      return result.count
    },

    async enableForAccount(accountId) {
      const now = new Date()

      const result = await sql`
        UPDATE sync_tasks
        SET enabled = true,
            updated_at = ${now}
        WHERE account_id = ${accountId} AND enabled = false
      `

      return result.count
    },
  }
}
