/**
 * Derived Task Repository
 *
 * CRUD operations for derived_tasks table.
 * Manages persistent derived processing schedules.
 */

import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'

export type DerivedTaskMode = 'once' | 'recurring' | 'event'

export interface TriggerConfig {
  type: 'webhook' | 'database' | 'scheduler'
  connector?: string
  eventType?: string | string[]  // '*' for all events
  filters?: Record<string, unknown>
}

export interface DerivedTask {
  id: string
  name: string
  script_path: string
  mode: DerivedTaskMode
  interval_ms: number | null
  enabled: boolean
  last_job_id: string | null
  next_run_at: string | null
  metadata?: Record<string, unknown>
  trigger_config?: TriggerConfig
  created_at: string
  updated_at: string
}

export interface DerivedTaskRow {
  id: string
  name: string
  script_path: string
  mode: string
  interval_ms: bigint | null
  enabled: boolean
  last_job_id: string | null
  next_run_at: Date | null
  metadata: Record<string, unknown> | null
  trigger_config: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
}

function rowToDerivedTask(row: DerivedTaskRow): DerivedTask {
  return {
    id: row.id,
    name: row.name,
    script_path: row.script_path,
    mode: row.mode as DerivedTaskMode,
    interval_ms: row.interval_ms !== null ? Number(row.interval_ms) : null,
    enabled: row.enabled,
    last_job_id: row.last_job_id,
    next_run_at: row.next_run_at?.toISOString() ?? null,
    metadata: row.metadata ?? undefined,
    trigger_config: (row.trigger_config as unknown) as TriggerConfig | undefined,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export interface DerivedTaskInput {
  name: string
  scriptPath: string
  mode: DerivedTaskMode
  intervalMs?: number
  metadata?: Record<string, unknown>
  triggerConfig?: TriggerConfig
}

export interface DerivedTaskRepository {
  create(input: DerivedTaskInput): Promise<DerivedTask>
  findById(id: string): Promise<DerivedTask | null>
  findAll(limit?: number): Promise<DerivedTask[]>
  findByName(name: string): Promise<DerivedTask[]>
  update(id: string, updates: Partial<Pick<DerivedTask, 'interval_ms' | 'enabled' | 'metadata' | 'trigger_config'>>): Promise<DerivedTask | null>
  delete(id: string): Promise<boolean>

  findDueForExecution(limit?: number): Promise<DerivedTask[]>

  // Webhook trigger lookups
  findWebhookTriggers(connector: string, eventType: string): Promise<DerivedTask[]>
  findAllWebhookTriggers(): Promise<DerivedTask[]>

  markExecuted(id: string, jobId: string): Promise<DerivedTask | null>
  updateNextRunAt(id: string, nextRunAt: Date): Promise<boolean>
}

export function createDerivedTaskRepository(ctx: RepositoryContext): DerivedTaskRepository {
  const { sql } = ctx

  return {
    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()
      const nextRunAt = input.mode === 'recurring' ? now : null

      const [row] = await sql<DerivedTaskRow[]>`
        INSERT INTO derived_tasks (
          id, name, script_path, mode, interval_ms,
          enabled, next_run_at, metadata, trigger_config, created_at, updated_at
        ) VALUES (
          ${id},
          ${input.name},
          ${input.scriptPath},
          ${input.mode},
          ${input.intervalMs ?? null},
          true,
          ${nextRunAt},
          ${input.metadata ? sql.json(input.metadata as any) : null},
          ${input.triggerConfig ? sql.json(input.triggerConfig as any) : null},
          ${now},
          ${now}
        )
        RETURNING *
      `

      return rowToDerivedTask(row)
    },

    async findById(id) {
      const [row] = await sql<DerivedTaskRow[]>`
        SELECT * FROM derived_tasks WHERE id = ${id}
      `
      return row ? rowToDerivedTask(row) : null
    },

    async findAll(limit = 100) {
      const rows = await sql<DerivedTaskRow[]>`
        SELECT * FROM derived_tasks
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows.map(rowToDerivedTask)
    },

    async findByName(name) {
      const rows = await sql<DerivedTaskRow[]>`
        SELECT * FROM derived_tasks
        WHERE name = ${name}
        ORDER BY created_at DESC
      `
      return rows.map(rowToDerivedTask)
    },

    async update(id, updates) {
      const now = new Date()

      const [row] = await sql<DerivedTaskRow[]>`
        UPDATE derived_tasks
        SET interval_ms = COALESCE(${updates.interval_ms ?? null}, interval_ms),
            enabled = COALESCE(${updates.enabled ?? null}, enabled),
            metadata = COALESCE(${updates.metadata ? sql.json(updates.metadata as any) : null}, metadata),
            trigger_config = COALESCE(${updates.trigger_config ? sql.json(updates.trigger_config as any) : null}, trigger_config),
            updated_at = ${now}
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToDerivedTask(row) : null
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM derived_tasks WHERE id = ${id}
      `
      return result.count > 0
    },

    async findDueForExecution(limit = 50) {
      const rows = await sql<DerivedTaskRow[]>`
        SELECT * FROM derived_tasks
        WHERE enabled = true
          AND mode IN ('once', 'recurring')
          AND (next_run_at IS NULL OR next_run_at <= NOW())
        ORDER BY next_run_at ASC NULLS FIRST
        LIMIT ${limit}
      `
      return rows.map(rowToDerivedTask)
    },

    async findWebhookTriggers(connector: string, eventType: string): Promise<DerivedTask[]> {
      // Find tasks that match:
      // 1. Enabled
      // 2. Mode = 'event'
      // 3. trigger_config.type = 'webhook'
      // 4. Matching connector
      // 5. Matching eventType (either '*' or exact match)
      const rows = await sql<DerivedTaskRow[]>`
        SELECT * FROM derived_tasks
        WHERE enabled = true
          AND mode = 'event'
          AND trigger_config->>'type' = 'webhook'
          AND trigger_config->>'connector' = ${connector}
          AND (
            trigger_config->>'eventType' = '*'
            OR trigger_config->>'eventType' = ${eventType}
            OR ${eventType} = ANY(
              SELECT jsonb_array_elements_text(trigger_config->'eventType')
            )
          )
      `
      return rows.map(rowToDerivedTask)
    },

    async findAllWebhookTriggers(): Promise<DerivedTask[]> {
      const rows = await sql<DerivedTaskRow[]>`
        SELECT * FROM derived_tasks
        WHERE enabled = true
          AND mode = 'event'
          AND trigger_config->>'type' = 'webhook'
      `
      return rows.map(rowToDerivedTask)
    },

    async markExecuted(id, jobId) {
      const now = new Date()

      const [row] = await sql<DerivedTaskRow[]>`
        UPDATE derived_tasks
        SET last_job_id = ${jobId}, updated_at = ${now}
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToDerivedTask(row) : null
    },

    async updateNextRunAt(id, nextRunAt) {
      const [row] = await sql<DerivedTaskRow[]>`
        UPDATE derived_tasks
        SET next_run_at = ${nextRunAt}
        WHERE id = ${id}
        RETURNING *
      `

      return !!row
    },
  }
}
