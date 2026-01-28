import type { RepositoryContext } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export type OutcomeSignal = 'positive' | 'negative' | 'neutral' | 'unknown'

export interface AgentActionRow {
  id: string
  action_type: string
  context: unknown // JSONB
  parameters: unknown // JSONB
  predicted_outcome: string | null
  actual_outcome: string | null
  outcome_signal: OutcomeSignal
  feedback: unknown // JSONB
  created_at: Date
  resolved_at: Date | null
  metadata: unknown // JSONB
}

export interface AgentActionInput {
  id?: string
  action_type: string
  context?: unknown
  parameters?: unknown
  predicted_outcome?: string | null
  actual_outcome?: string | null
  outcome_signal?: OutcomeSignal
  feedback?: unknown
  resolved_at?: Date | null
  metadata?: unknown
}

export interface ActionFilterOptions {
  action_type?: string
  outcome_signal?: OutcomeSignal
  resolved?: boolean
  limit?: number
  offset?: number
  since?: Date
}

export interface AgentActionsRepository {
  /** Find an action by ID */
  findById(id: string): Promise<AgentActionRow | null>

  /** Create a new action record */
  create(input: AgentActionInput): Promise<AgentActionRow>

  /** Update an existing action */
  update(id: string, updates: Partial<Omit<AgentActionInput, 'id'>>): Promise<AgentActionRow | null>

  /** Delete an action by ID */
  delete(id: string): Promise<boolean>

  /** Find actions matching filter criteria */
  findMany(options?: ActionFilterOptions): Promise<AgentActionRow[]>

  /** Record the outcome of an action */
  recordOutcome(id: string, outcome: { actual_outcome: string; outcome_signal: OutcomeSignal; feedback?: unknown }): Promise<AgentActionRow | null>

  /** Get unresolved actions (actions still pending outcome) */
  getUnresolved(limit?: number): Promise<AgentActionRow[]>

  /** Get positive outcomes (for learning what works) */
  getPositiveOutcomes(limit?: number, actionType?: string): Promise<AgentActionRow[]>

  /** Get negative outcomes (for learning what doesn't work) */
  getNegativeOutcomes(limit?: number, actionType?: string): Promise<AgentActionRow[]>

  /** Get recent actions */
  getRecent(limit?: number): Promise<AgentActionRow[]>

  /** Get actions by type */
  getByType(actionType: string, limit?: number): Promise<AgentActionRow[]>

  /** Calculate success rate for an action type */
  getSuccessRate(actionType: string, since?: Date): Promise<{ total: number; positive: number; negative: number; rate: number }>
}

export function createAgentActionsRepository(
  ctx: RepositoryContext
): AgentActionsRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const rows = await sql<AgentActionRow[]>`
        SELECT * FROM agent_actions WHERE id = ${id}
      `
      return rows[0] || null
    },

    async create(input) {
      const id = input.id || generateCanonicalId()

      const rows = await sql<AgentActionRow[]>`
        INSERT INTO agent_actions (
          id,
          action_type,
          context,
          parameters,
          predicted_outcome,
          actual_outcome,
          outcome_signal,
          feedback,
          resolved_at,
          metadata
        )
        VALUES (
          ${id},
          ${input.action_type},
          ${input.context ? sql.json(input.context as any) : null},
          ${input.parameters ? sql.json(input.parameters as any) : null},
          ${input.predicted_outcome ?? null},
          ${input.actual_outcome ?? null},
          ${input.outcome_signal ?? 'unknown'},
          ${input.feedback ? sql.json(input.feedback as any) : null},
          ${input.resolved_at ?? null},
          ${input.metadata ? sql.json(input.metadata as any) : null}
        )
        RETURNING *
      `
      return rows[0]
    },

    async update(id, updates) {
      const rows = await sql<AgentActionRow[]>`
        UPDATE agent_actions
        SET
          action_type = COALESCE(${updates.action_type ?? null}, action_type),
          context = COALESCE(${updates.context !== undefined ? sql.json(updates.context as any) : null}, context),
          parameters = COALESCE(${updates.parameters !== undefined ? sql.json(updates.parameters as any) : null}, parameters),
          predicted_outcome = COALESCE(${updates.predicted_outcome ?? null}, predicted_outcome),
          actual_outcome = COALESCE(${updates.actual_outcome ?? null}, actual_outcome),
          outcome_signal = COALESCE(${updates.outcome_signal ?? null}, outcome_signal),
          feedback = COALESCE(${updates.feedback !== undefined ? sql.json(updates.feedback as any) : null}, feedback),
          resolved_at = COALESCE(${updates.resolved_at ?? null}, resolved_at),
          metadata = COALESCE(${updates.metadata !== undefined ? sql.json(updates.metadata as any) : null}, metadata)
        WHERE id = ${id}
        RETURNING *
      `
      return rows[0] || null
    },

    async delete(id) {
      const result = await sql`DELETE FROM agent_actions WHERE id = ${id}`
      return result.count > 0
    },

    async findMany(options = {}) {
      const {
        action_type,
        outcome_signal,
        resolved,
        limit = 100,
        offset = 0,
        since,
      } = options

      const rows = await sql<AgentActionRow[]>`
        SELECT * FROM agent_actions
        WHERE 1=1
          ${action_type ? sql`AND action_type = ${action_type}` : sql``}
          ${outcome_signal ? sql`AND outcome_signal = ${outcome_signal}` : sql``}
          ${resolved === undefined ? sql`` : resolved ? sql`AND resolved_at IS NOT NULL` : sql`AND resolved_at IS NULL`}
          ${since ? sql`AND created_at >= ${since}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `
      return rows
    },

    async recordOutcome(id, outcome) {
      const rows = await sql<AgentActionRow[]>`
        UPDATE agent_actions
        SET
          actual_outcome = ${outcome.actual_outcome},
          outcome_signal = ${outcome.outcome_signal},
          feedback = ${outcome.feedback ? sql.json(outcome.feedback as any) : null},
          resolved_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return rows[0] || null
    },

    async getUnresolved(limit = 50) {
      const rows = await sql<AgentActionRow[]>`
        SELECT * FROM agent_actions
        WHERE resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows
    },

    async getPositiveOutcomes(limit = 50, actionType) {
      const rows = await sql<AgentActionRow[]>`
        SELECT * FROM agent_actions
        WHERE outcome_signal = 'positive'
          ${actionType ? sql`AND action_type = ${actionType}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows
    },

    async getNegativeOutcomes(limit = 50, actionType) {
      const rows = await sql<AgentActionRow[]>`
        SELECT * FROM agent_actions
        WHERE outcome_signal = 'negative'
          ${actionType ? sql`AND action_type = ${actionType}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows
    },

    async getRecent(limit = 20) {
      const rows = await sql<AgentActionRow[]>`
        SELECT * FROM agent_actions
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows
    },

    async getByType(actionType, limit = 20) {
      const rows = await sql<AgentActionRow[]>`
        SELECT * FROM agent_actions
        WHERE action_type = ${actionType}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows
    },

    async getSuccessRate(actionType, since) {
      const sinceClause = since ? sql`AND created_at >= ${since}` : sql``

      const result = await sql<
        {
          total: bigint
          positive: bigint
          negative: bigint
        }[]
      >`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN outcome_signal = 'positive' THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN outcome_signal = 'negative' THEN 1 ELSE 0 END) as negative
        FROM agent_actions
        WHERE action_type = ${actionType}
          ${sinceClause}
      `

      const row = result[0]
      const total = Number(row.total)
      const positive = Number(row.positive)
      const rate = total > 0 ? positive / total : 0

      return {
        total,
        positive,
        negative: Number(row.negative),
        rate,
      }
    },
  }
}

