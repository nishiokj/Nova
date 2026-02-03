/**
 * Derived Task Repository
 *
 * CRUD operations for derived_tasks table.
 * Manages persistent derived processing schedules.
 */

import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'

export type DerivedTaskMode = 'once' | 'recurring' | 'event'
export type ReplayPolicy = 'always' | 'on_failure' | 'once' | 'cooldown'

export interface TriggerConfig {
  type: 'webhook' | 'database' | 'scheduler'
  connector?: string
  eventType?: string | string[]  // '*' for all events
  filters?: Record<string, unknown>
}

export interface DerivedTask {
  id: string
  name: string
  label: string | null
  purpose: string | null
  script_path: string
  mode: DerivedTaskMode
  interval_ms: number | null
  enabled: boolean
  last_job_id: string | null
  next_run_at: string | null
  metadata?: Record<string, unknown>
  sanity_policy?: Record<string, unknown>
  trigger_config?: TriggerConfig
  // Circuit breaker
  consecutive_failures: number
  max_failures: number
  circuit_open_until: string | null
  last_error: string | null
  last_success_at: string | null
  last_error_at: string | null
  last_error_code: string | null
  last_error_msg: string | null
  // Execution policies
  replay_policy: ReplayPolicy
  idempotent: boolean
  cooldown_ms: number | null
  timeout_ms: number
  heartbeat_interval_ms: number | null
  rate_limit_max: number | null
  rate_limit_window_ms: number | null
  resource_pool: string | null
  created_at: string
  updated_at: string
}

export interface DerivedTaskRow {
  id: string
  name: string
  label: string | null
  purpose: string | null
  script_path: string
  mode: string
  interval_ms: bigint | null
  enabled: boolean
  last_job_id: string | null
  next_run_at: Date | null
  metadata: Record<string, unknown> | null
  sanity_policy: Record<string, unknown> | null
  trigger_config: Record<string, unknown> | null
  // Circuit breaker
  consecutive_failures: number
  max_failures: number
  circuit_open_until: Date | null
  last_error: string | null
  last_success_at: Date | null
  last_error_at: Date | null
  last_error_code: string | null
  last_error_msg: string | null
  // Execution policies
  replay_policy: string | null
  idempotent: number | null
  cooldown_ms: number | null
  timeout_ms: number | null
  heartbeat_interval_ms: number | null
  rate_limit_max: number | null
  rate_limit_window_ms: number | null
  resource_pool: string | null
  created_at: Date
  updated_at: Date
}

function rowToDerivedTask(row: DerivedTaskRow): DerivedTask {
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? null,
    purpose: row.purpose ?? null,
    script_path: row.script_path,
    mode: row.mode as DerivedTaskMode,
    interval_ms: row.interval_ms !== null ? Number(row.interval_ms) : null,
    enabled: row.enabled,
    last_job_id: row.last_job_id,
    next_run_at: row.next_run_at?.toISOString() ?? null,
    metadata: row.metadata ?? undefined,
    sanity_policy: row.sanity_policy ?? undefined,
    trigger_config: (row.trigger_config as unknown) as TriggerConfig | undefined,
    consecutive_failures: row.consecutive_failures ?? 0,
    max_failures: row.max_failures ?? 3,
    circuit_open_until: row.circuit_open_until?.toISOString() ?? null,
    last_error: row.last_error ?? null,
    last_success_at: row.last_success_at?.toISOString() ?? null,
    last_error_at: row.last_error_at?.toISOString() ?? null,
    last_error_code: row.last_error_code ?? null,
    last_error_msg: row.last_error_msg ?? null,
    // Execution policies with defaults
    replay_policy: (row.replay_policy as ReplayPolicy) ?? 'always',
    idempotent: row.idempotent !== null ? row.idempotent === 1 : true,
    cooldown_ms: row.cooldown_ms ?? null,
    timeout_ms: row.timeout_ms ?? 30000,
    heartbeat_interval_ms: row.heartbeat_interval_ms ?? null,
    rate_limit_max: row.rate_limit_max ?? null,
    rate_limit_window_ms: row.rate_limit_window_ms ?? null,
    resource_pool: row.resource_pool ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export interface DerivedTaskInput {
  name: string
  label?: string | null
  purpose?: string | null
  scriptPath: string
  mode: DerivedTaskMode
  intervalMs?: number
  metadata?: Record<string, unknown>
  sanityPolicy?: Record<string, unknown>
  triggerConfig?: TriggerConfig
  // Execution policies
  replayPolicy?: ReplayPolicy
  idempotent?: boolean
  cooldownMs?: number
  timeoutMs?: number
  heartbeatIntervalMs?: number
  rateLimitMax?: number
  rateLimitWindowMs?: number
  resourcePool?: string
}

export interface DerivedTaskUpdateInput {
  label?: string | null
  purpose?: string | null
  interval_ms?: number
  enabled?: boolean
  metadata?: Record<string, unknown>
  sanity_policy?: Record<string, unknown>
  trigger_config?: TriggerConfig
  max_failures?: number
  // Execution policies
  replay_policy?: ReplayPolicy
  idempotent?: boolean
  cooldown_ms?: number
  timeout_ms?: number
  heartbeat_interval_ms?: number
  rate_limit_max?: number
  rate_limit_window_ms?: number
  resource_pool?: string | null
}

export interface DerivedTaskRepository {
  create(input: DerivedTaskInput): Promise<DerivedTask>
  findById(id: string): Promise<DerivedTask | null>
  findAll(limit?: number): Promise<DerivedTask[]>
  findByName(name: string): Promise<DerivedTask[]>
  update(id: string, updates: DerivedTaskUpdateInput): Promise<DerivedTask | null>
  delete(id: string): Promise<boolean>

  findDueForExecution(limit?: number): Promise<DerivedTask[]>

  // Webhook trigger lookups
  findWebhookTriggers(connector: string, eventType: string): Promise<DerivedTask[]>
  findAllWebhookTriggers(): Promise<DerivedTask[]>

  markExecuted(id: string, jobId: string): Promise<DerivedTask | null>
  updateNextRunAt(id: string, nextRunAt: Date): Promise<boolean>

  // Circuit breaker
  /** Record a job failure - increments counter, opens circuit if threshold reached */
  recordFailure(id: string, error: string, options?: { openCircuit?: boolean; errorCode?: string }): Promise<DerivedTask | null>
  /** Record a job success - resets failure counter and closes circuit */
  recordSuccess(id: string): Promise<DerivedTask | null>
  /** Manually reset the circuit breaker */
  resetCircuit(id: string): Promise<DerivedTask | null>
  /** Find tasks with open circuits */
  findCircuitOpen(): Promise<DerivedTask[]>

  /** Pause a task (disable it) with a reason stored in last_error */
  pause(id: string, reason: string): Promise<DerivedTask | null>
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
          id, name, label, purpose, script_path, mode, interval_ms,
          enabled, next_run_at, metadata, sanity_policy, trigger_config,
          replay_policy, idempotent, cooldown_ms, timeout_ms,
          heartbeat_interval_ms, rate_limit_max, rate_limit_window_ms, resource_pool,
          created_at, updated_at
        ) VALUES (
          ${id},
          ${input.name},
          ${input.label ?? null},
          ${input.purpose ?? null},
          ${input.scriptPath},
          ${input.mode},
          ${input.intervalMs ?? null},
          true,
          ${nextRunAt},
          ${input.metadata ? sql.json(input.metadata as any) : null},
          ${input.sanityPolicy ? sql.json(input.sanityPolicy as any) : null},
          ${input.triggerConfig ? sql.json(input.triggerConfig as any) : null},
          ${input.replayPolicy ?? 'always'},
          ${input.idempotent !== false ? 1 : 0},
          ${input.cooldownMs ?? null},
          ${input.timeoutMs ?? 30000},
          ${input.heartbeatIntervalMs ?? null},
          ${input.rateLimitMax ?? null},
          ${input.rateLimitWindowMs ?? null},
          ${input.resourcePool ?? null},
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
        SET label = COALESCE(${updates.label ?? null}, label),
            purpose = COALESCE(${updates.purpose ?? null}, purpose),
            interval_ms = COALESCE(${updates.interval_ms ?? null}, interval_ms),
            enabled = COALESCE(${updates.enabled ?? null}, enabled),
            metadata = COALESCE(${updates.metadata ? sql.json(updates.metadata as any) : null}, metadata),
            sanity_policy = COALESCE(${updates.sanity_policy ? sql.json(updates.sanity_policy as any) : null}, sanity_policy),
            trigger_config = COALESCE(${updates.trigger_config ? sql.json(updates.trigger_config as any) : null}, trigger_config),
            max_failures = COALESCE(${updates.max_failures ?? null}, max_failures),
            replay_policy = COALESCE(${updates.replay_policy ?? null}, replay_policy),
            idempotent = COALESCE(${updates.idempotent !== undefined ? (updates.idempotent ? 1 : 0) : null}, idempotent),
            cooldown_ms = COALESCE(${updates.cooldown_ms ?? null}, cooldown_ms),
            timeout_ms = COALESCE(${updates.timeout_ms ?? null}, timeout_ms),
            heartbeat_interval_ms = COALESCE(${updates.heartbeat_interval_ms ?? null}, heartbeat_interval_ms),
            rate_limit_max = COALESCE(${updates.rate_limit_max ?? null}, rate_limit_max),
            rate_limit_window_ms = COALESCE(${updates.rate_limit_window_ms ?? null}, rate_limit_window_ms),
            resource_pool = ${updates.resource_pool !== undefined ? updates.resource_pool : sql`resource_pool`},
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
          AND (circuit_open_until IS NULL OR circuit_open_until <= NOW())
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

    async recordFailure(id, error, options = {}) {
      const { openCircuit, errorCode } = options

      if (openCircuit) {
        // Immediately open circuit (e.g., for permanent failures)
        const [row] = await sql<DerivedTaskRow[]>`
          UPDATE derived_tasks
          SET
            consecutive_failures = consecutive_failures + 1,
            last_error = ${error},
            last_error_at = NOW(),
            last_error_code = ${errorCode ?? null},
            last_error_msg = ${error},
            circuit_open_until = NOW() + INTERVAL '24 hours',
            updated_at = NOW()
          WHERE id = ${id}
          RETURNING *
        `
        return row ? rowToDerivedTask(row) : null
      }

      // Increment failures, open circuit if threshold reached
      // Circuit stays open for: 5min * 2^(failures-1), max 24 hours
      const [row] = await sql<DerivedTaskRow[]>`
        UPDATE derived_tasks
        SET
          consecutive_failures = consecutive_failures + 1,
          last_error = ${error},
          last_error_at = NOW(),
          last_error_code = ${errorCode ?? null},
          last_error_msg = ${error},
          circuit_open_until = CASE
            WHEN consecutive_failures + 1 >= max_failures AND max_failures > 0
            THEN NOW() + (LEAST(POWER(2, consecutive_failures) * INTERVAL '5 minutes', INTERVAL '24 hours'))
            ELSE circuit_open_until
          END,
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDerivedTask(row) : null
    },

    async recordSuccess(id) {
      const [row] = await sql<DerivedTaskRow[]>`
        UPDATE derived_tasks
        SET
          consecutive_failures = 0,
          circuit_open_until = NULL,
          last_error = NULL,
          last_success_at = NOW(),
          last_error_at = NULL,
          last_error_code = NULL,
          last_error_msg = NULL,
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDerivedTask(row) : null
    },

    async resetCircuit(id) {
      const [row] = await sql<DerivedTaskRow[]>`
        UPDATE derived_tasks
        SET
          consecutive_failures = 0,
          circuit_open_until = NULL,
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDerivedTask(row) : null
    },

    async findCircuitOpen() {
      const rows = await sql<DerivedTaskRow[]>`
        SELECT * FROM derived_tasks
        WHERE circuit_open_until IS NOT NULL
          AND circuit_open_until > NOW()
        ORDER BY circuit_open_until ASC
      `
      return rows.map(rowToDerivedTask)
    },

    async pause(id, reason) {
      const [row] = await sql<DerivedTaskRow[]>`
        UPDATE derived_tasks
        SET
          enabled = false,
          last_error = ${reason},
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDerivedTask(row) : null
    },
  }
}
