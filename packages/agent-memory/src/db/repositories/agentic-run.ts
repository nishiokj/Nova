/**
 * Agentic Run Repository
 *
 * Per-execution records for agentic tasks.
 * Lifecycle: pending -> running -> verifying -> completed | failed
 */

import type {
  AgenticRun,
  AgenticRunCreateInput,
  AgenticRunVerdict,
  MutationObservation,
} from 'types'
import type { VerdictReport } from 'semantic-compiler'
import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext } from './types.js'

export interface AgenticRunRow {
  id: string
  task_id: string
  status: string
  agent_output: string | null
  agent_summary: string | null
  mutations_observed: unknown | null
  budget_exceeded: boolean
  verdict: string | null
  verdict_report: unknown | null
  evidence_path: string | null
  started_at: Date | null
  agent_completed_at: Date | null
  verification_started_at: Date | null
  completed_at: Date | null
  duration_ms: number | null
  error: string | null
  metadata: Record<string, unknown> | null
  created_at: Date
}

function rowToAgenticRun(row: AgenticRunRow): AgenticRun {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status as AgenticRun['status'],
    agentOutput: row.agent_output,
    agentSummary: row.agent_summary,
    mutationsObserved: (row.mutations_observed as MutationObservation) ?? null,
    budgetExceeded: row.budget_exceeded ?? false,
    verdict: (row.verdict as AgenticRunVerdict) ?? null,
    verdictReport: (row.verdict_report as VerdictReport) ?? null,
    evidencePath: row.evidence_path,
    startedAt: row.started_at?.toISOString() ?? null,
    agentCompletedAt: row.agent_completed_at?.toISOString() ?? null,
    verificationStartedAt: row.verification_started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    durationMs: row.duration_ms,
    error: row.error,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  }
}

export interface AgenticRunRepository {
  create(input: AgenticRunCreateInput): Promise<AgenticRun>
  findById(id: string): Promise<AgenticRun | null>
  findByTask(taskId: string, limit?: number): Promise<AgenticRun[]>
  findLastCompleted(taskId: string): Promise<AgenticRun | null>

  /** pending -> running */
  start(id: string): Promise<AgenticRun | null>
  /** running -> verifying (agent finished, verification starting) */
  markVerifying(id: string, agentOutput: string, summary?: string): Promise<AgenticRun | null>
  /** verifying -> completed */
  complete(id: string, verdict: AgenticRunVerdict, verdictReport: VerdictReport, evidencePath: string): Promise<AgenticRun | null>
  /** any -> failed */
  fail(id: string, error: string): Promise<AgenticRun | null>

  /** Record mutation counts during agent execution */
  recordMutations(id: string, mutations: MutationObservation): Promise<AgenticRun | null>
  /** Mark budget exceeded (triggers agent kill) */
  markBudgetExceeded(id: string, mutations: MutationObservation): Promise<AgenticRun | null>

  /** Prevent double-scheduling: check for pending/running/verifying runs */
  hasActiveRun(taskId: string): Promise<boolean>
}

export function createAgenticRunRepository(ctx: RepositoryContext): AgenticRunRepository {
  const { sql } = ctx

  return {
    async create(input) {
      const id = generateCanonicalId()

      const [row] = await sql<AgenticRunRow[]>`
        INSERT INTO agentic_runs (id, task_id, status, metadata, created_at)
        VALUES (
          ${id},
          ${input.taskId},
          'pending',
          ${input.metadata ? sql.json(input.metadata as any) : null},
          NOW()
        )
        RETURNING *
      `

      return rowToAgenticRun(row)
    },

    async findById(id) {
      const [row] = await sql<AgenticRunRow[]>`
        SELECT * FROM agentic_runs WHERE id = ${id}
      `
      return row ? rowToAgenticRun(row) : null
    },

    async findByTask(taskId, limit = 50) {
      const rows = await sql<AgenticRunRow[]>`
        SELECT * FROM agentic_runs
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows.map(rowToAgenticRun)
    },

    async findLastCompleted(taskId) {
      const [row] = await sql<AgenticRunRow[]>`
        SELECT * FROM agentic_runs
        WHERE task_id = ${taskId} AND status = 'completed'
        ORDER BY completed_at DESC
        LIMIT 1
      `
      return row ? rowToAgenticRun(row) : null
    },

    async start(id) {
      const [row] = await sql<AgenticRunRow[]>`
        UPDATE agentic_runs
        SET status = 'running', started_at = NOW()
        WHERE id = ${id} AND status = 'pending'
        RETURNING *
      `
      return row ? rowToAgenticRun(row) : null
    },

    async markVerifying(id, agentOutput, summary) {
      const [row] = await sql<AgenticRunRow[]>`
        UPDATE agentic_runs
        SET status = 'verifying',
            agent_output = ${agentOutput},
            agent_summary = ${summary ?? null},
            agent_completed_at = NOW(),
            verification_started_at = NOW()
        WHERE id = ${id} AND status = 'running'
        RETURNING *
      `
      return row ? rowToAgenticRun(row) : null
    },

    async complete(id, verdict, verdictReport, evidencePath) {
      const [row] = await sql<AgenticRunRow[]>`
        UPDATE agentic_runs
        SET status = 'completed',
            verdict = ${verdict},
            verdict_report = ${sql.json(verdictReport as any)},
            evidence_path = ${evidencePath},
            completed_at = NOW(),
            duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
        WHERE id = ${id} AND status = 'verifying'
        RETURNING *
      `
      return row ? rowToAgenticRun(row) : null
    },

    async fail(id, error) {
      const [row] = await sql<AgenticRunRow[]>`
        UPDATE agentic_runs
        SET status = 'failed',
            error = ${error},
            completed_at = NOW(),
            duration_ms = CASE
              WHEN started_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
              ELSE NULL
            END
        WHERE id = ${id} AND status NOT IN ('completed', 'failed')
        RETURNING *
      `
      return row ? rowToAgenticRun(row) : null
    },

    async recordMutations(id, mutations) {
      const [row] = await sql<AgenticRunRow[]>`
        UPDATE agentic_runs
        SET mutations_observed = ${sql.json(mutations as any)}
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticRun(row) : null
    },

    async markBudgetExceeded(id, mutations) {
      const [row] = await sql<AgenticRunRow[]>`
        UPDATE agentic_runs
        SET budget_exceeded = true,
            mutations_observed = ${sql.json(mutations as any)}
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToAgenticRun(row) : null
    },

    async hasActiveRun(taskId) {
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM agentic_runs
          WHERE task_id = ${taskId}
            AND status IN ('pending', 'running', 'verifying')
        ) AS exists
      `
      return result?.exists ?? false
    },
  }
}
