/**
 * Agentic Task Repository
 *
 * CRUD + scheduling + circuit breaker for agentic_tasks table.
 * Follows the DerivedTask repository pattern.
 */

import type {
  AgenticTask,
  AgenticTaskCreateInput,
  AgenticTaskUpdateInput,
  AgenticTaskStatus,
} from 'types'
import type { CompilerQuestion } from 'semantic-compiler'
import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext } from './types.js'

export interface AgenticTaskRow {
  id: string
  name: string
  intent: string
  success_criteria: string | null
  invariants: unknown
  system_surface: unknown
  compiled_vp_path: string | null
  compiled_vp_hash: string | null
  pending_questions: unknown
  capability_scope: unknown
  mutation_budget: unknown
  mode: string
  interval_ms: bigint | null
  status: string
  consecutive_failures: number
  max_failures: number
  circuit_open_until: Date | null
  last_error: string | null
  last_success_at: Date | null
  last_error_at: Date | null
  next_run_at: Date | null
  last_run_id: string | null
  timeout_ms: number
  idempotent: boolean
  cooldown_ms: number | null
  metadata: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
}

function rowToAgenticTask(row: AgenticTaskRow): AgenticTask {
  return {
    id: row.id,
    name: row.name,
    intent: row.intent,
    successCriteria: row.success_criteria,
    invariants: (row.invariants ?? []) as AgenticTask['invariants'],
    systemSurface: (row.system_surface ?? {}) as AgenticTask['systemSurface'],
    compiledVpPath: row.compiled_vp_path,
    compiledVpHash: row.compiled_vp_hash,
    pendingQuestions: (row.pending_questions ?? []) as AgenticTask['pendingQuestions'],
    capabilityScope: (row.capability_scope ?? {}) as AgenticTask['capabilityScope'],
    mutationBudget: (row.mutation_budget ?? {}) as AgenticTask['mutationBudget'],
    mode: row.mode as AgenticTask['mode'],
    intervalMs: row.interval_ms !== null ? Number(row.interval_ms) : null,
    status: row.status as AgenticTaskStatus,
    consecutiveFailures: row.consecutive_failures ?? 0,
    maxFailures: row.max_failures ?? 3,
    circuitOpenUntil: row.circuit_open_until?.toISOString() ?? null,
    lastError: row.last_error,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    lastErrorAt: row.last_error_at?.toISOString() ?? null,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    lastRunId: row.last_run_id,
    timeoutMs: row.timeout_ms ?? 300000,
    idempotent: row.idempotent ?? true,
    cooldownMs: row.cooldown_ms,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export interface AgenticTaskRepository {
  create(input: AgenticTaskCreateInput): Promise<AgenticTask>
  findById(id: string): Promise<AgenticTask | null>
  findByName(name: string): Promise<AgenticTask | null>
  findAll(filters?: { status?: AgenticTaskStatus; mode?: string }, limit?: number): Promise<AgenticTask[]>
  update(id: string, updates: AgenticTaskUpdateInput): Promise<AgenticTask | null>
  delete(id: string): Promise<boolean>

  /** Scheduler entry point: active tasks with clear circuit and due next_run_at */
  findDueForExecution(limit?: number): Promise<AgenticTask[]>

  /** Transition draft -> active after successful compilation */
  activate(id: string, vpPath: string, vpHash: string): Promise<AgenticTask | null>
  /** Store pending questions from failed compilation */
  setDraft(id: string, questions: CompilerQuestion[]): Promise<AgenticTask | null>
  /** Update compiled VP cache (on invariant/surface change) */
  updateCompiledVp(id: string, vpPath: string, vpHash: string): Promise<AgenticTask | null>

  // Schedule management
  markExecuted(id: string, runId: string): Promise<AgenticTask | null>
  updateNextRunAt(id: string, nextRunAt: Date): Promise<boolean>

  // Circuit breaker (same pattern as DerivedTask)
  recordFailure(id: string, error: string, options?: { openCircuit?: boolean }): Promise<AgenticTask | null>
  recordSuccess(id: string): Promise<AgenticTask | null>
  resetCircuit(id: string): Promise<AgenticTask | null>
  findCircuitOpen(): Promise<AgenticTask[]>

  // Status management
  pause(id: string, reason: string): Promise<AgenticTask | null>
  resume(id: string): Promise<AgenticTask | null>
  disable(id: string): Promise<AgenticTask | null>
}

export function createAgenticTaskRepository(ctx: RepositoryContext): AgenticTaskRepository {
  const { sql } = ctx

  return {
    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()
      const nextRunAt = input.mode === 'recurring' ? now : null

      const [row] = await sql<AgenticTaskRow[]>`
        INSERT INTO agentic_tasks (
          id, name, intent, success_criteria,
          invariants, system_surface, pending_questions,
          capability_scope, mutation_budget,
          mode, interval_ms, status,
          max_failures, timeout_ms, idempotent, cooldown_ms,
          next_run_at, metadata, created_at, updated_at
        ) VALUES (
          ${id},
          ${input.name},
          ${input.intent},
          ${input.successCriteria ?? null},
          ${sql.json(input.invariants as any)},
          ${sql.json(input.systemSurface as any)},
          ${sql.json([] as any)},
          ${input.capabilityScope ? sql.json(input.capabilityScope as any) : sql.json({})},
          ${input.mutationBudget ? sql.json(input.mutationBudget as any) : sql.json({})},
          ${input.mode},
          ${input.intervalMs ?? null},
          'draft',
          ${input.maxFailures ?? 3},
          ${input.timeoutMs ?? 300000},
          ${input.idempotent !== false},
          ${input.cooldownMs ?? null},
          ${nextRunAt},
          ${input.metadata ? sql.json(input.metadata as any) : null},
          ${now},
          ${now}
        )
        RETURNING *
      `

      return rowToAgenticTask(row)
    },

    async findById(id) {
      const [row] = await sql<AgenticTaskRow[]>`
        SELECT * FROM agentic_tasks WHERE id = ${id}
      `
      return row ? rowToAgenticTask(row) : null
    },

    async findByName(name) {
      const [row] = await sql<AgenticTaskRow[]>`
        SELECT * FROM agentic_tasks WHERE name = ${name}
      `
      return row ? rowToAgenticTask(row) : null
    },

    async findAll(filters, limit = 100) {
      if (filters?.status && filters?.mode) {
        const rows = await sql<AgenticTaskRow[]>`
          SELECT * FROM agentic_tasks
          WHERE status = ${filters.status} AND mode = ${filters.mode}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
        return rows.map(rowToAgenticTask)
      }
      if (filters?.status) {
        const rows = await sql<AgenticTaskRow[]>`
          SELECT * FROM agentic_tasks
          WHERE status = ${filters.status}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
        return rows.map(rowToAgenticTask)
      }
      if (filters?.mode) {
        const rows = await sql<AgenticTaskRow[]>`
          SELECT * FROM agentic_tasks
          WHERE mode = ${filters.mode}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
        return rows.map(rowToAgenticTask)
      }
      const rows = await sql<AgenticTaskRow[]>`
        SELECT * FROM agentic_tasks
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows.map(rowToAgenticTask)
    },

    async update(id, updates) {
      const now = new Date()

      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET intent = COALESCE(${updates.intent ?? null}, intent),
            success_criteria = ${updates.successCriteria !== undefined ? updates.successCriteria : sql`success_criteria`},
            invariants = COALESCE(${updates.invariants ? sql.json(updates.invariants as any) : null}, invariants),
            system_surface = COALESCE(${updates.systemSurface ? sql.json(updates.systemSurface as any) : null}, system_surface),
            capability_scope = COALESCE(${updates.capabilityScope ? sql.json(updates.capabilityScope as any) : null}, capability_scope),
            mutation_budget = COALESCE(${updates.mutationBudget ? sql.json(updates.mutationBudget as any) : null}, mutation_budget),
            interval_ms = COALESCE(${updates.intervalMs ?? null}, interval_ms),
            timeout_ms = COALESCE(${updates.timeoutMs ?? null}, timeout_ms),
            idempotent = COALESCE(${updates.idempotent ?? null}, idempotent),
            cooldown_ms = COALESCE(${updates.cooldownMs ?? null}, cooldown_ms),
            max_failures = COALESCE(${updates.maxFailures ?? null}, max_failures),
            metadata = COALESCE(${updates.metadata ? sql.json(updates.metadata as any) : null}, metadata),
            updated_at = ${now}
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToAgenticTask(row) : null
    },

    async delete(id) {
      // Delete runs first (FK constraint)
      await sql`DELETE FROM agentic_runs WHERE task_id = ${id}`
      const result = await sql`DELETE FROM agentic_tasks WHERE id = ${id}`
      return result.count > 0
    },

    async findDueForExecution(limit = 50) {
      const rows = await sql<AgenticTaskRow[]>`
        SELECT * FROM agentic_tasks
        WHERE status = 'active'
          AND compiled_vp_path IS NOT NULL
          AND mode IN ('once', 'recurring')
          AND (next_run_at IS NULL OR next_run_at <= NOW())
          AND (circuit_open_until IS NULL OR circuit_open_until <= NOW())
        ORDER BY next_run_at ASC NULLS FIRST
        LIMIT ${limit}
      `
      return rows.map(rowToAgenticTask)
    },

    async activate(id, vpPath, vpHash) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET status = 'active',
            compiled_vp_path = ${vpPath},
            compiled_vp_hash = ${vpHash},
            pending_questions = '[]'::jsonb,
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },

    async setDraft(id, questions) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET status = 'draft',
            pending_questions = ${sql.json(questions as any)},
            compiled_vp_path = NULL,
            compiled_vp_hash = NULL,
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },

    async updateCompiledVp(id, vpPath, vpHash) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET compiled_vp_path = ${vpPath},
            compiled_vp_hash = ${vpHash},
            pending_questions = '[]'::jsonb,
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },

    async markExecuted(id, runId) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET last_run_id = ${runId}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },

    async updateNextRunAt(id, nextRunAt) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET next_run_at = ${nextRunAt}
        WHERE id = ${id}
        RETURNING *
      `
      return !!row
    },

    async recordFailure(id, error, options = {}) {
      const { openCircuit } = options

      if (openCircuit) {
        const [row] = await sql<AgenticTaskRow[]>`
          UPDATE agentic_tasks
          SET
            consecutive_failures = consecutive_failures + 1,
            last_error = ${error},
            last_error_at = NOW(),
            circuit_open_until = NOW() + INTERVAL '24 hours',
            updated_at = NOW()
          WHERE id = ${id}
          RETURNING *
        `
        return row ? rowToAgenticTask(row) : null
      }

      // Increment failures, open circuit if threshold reached
      // Circuit stays open for: 5min * 2^(failures-1), max 24 hours
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET
          consecutive_failures = consecutive_failures + 1,
          last_error = ${error},
          last_error_at = NOW(),
          circuit_open_until = CASE
            WHEN consecutive_failures + 1 >= max_failures AND max_failures > 0
            THEN NOW() + (LEAST(POWER(2, consecutive_failures) * INTERVAL '5 minutes', INTERVAL '24 hours'))
            ELSE circuit_open_until
          END,
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },

    async recordSuccess(id) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET
          consecutive_failures = 0,
          circuit_open_until = NULL,
          last_error = NULL,
          last_success_at = NOW(),
          last_error_at = NULL,
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },

    async resetCircuit(id) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET
          consecutive_failures = 0,
          circuit_open_until = NULL,
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },

    async findCircuitOpen() {
      const rows = await sql<AgenticTaskRow[]>`
        SELECT * FROM agentic_tasks
        WHERE circuit_open_until IS NOT NULL
          AND circuit_open_until > NOW()
        ORDER BY circuit_open_until ASC
      `
      return rows.map(rowToAgenticTask)
    },

    async pause(id, reason) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET
          status = 'paused',
          last_error = ${reason},
          updated_at = NOW()
        WHERE id = ${id} AND status = 'active'
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },

    async resume(id) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET
          status = 'active',
          updated_at = NOW()
        WHERE id = ${id} AND status = 'paused'
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },

    async disable(id) {
      const [row] = await sql<AgenticTaskRow[]>`
        UPDATE agentic_tasks
        SET
          status = 'disabled',
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticTask(row) : null
    },
  }
}
