import type { RepositoryContext } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export interface AgentGoalRow {
  id: string
  parent_id: string | null
  title: string
  description: string | null
  success_criteria: unknown // JSONB
  priority: number
  status: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
  deadline: Date | null
  created_at: Date
  updated_at: Date
  completed_at: Date | null
  metadata: unknown // JSONB
}

export interface AgentGoalInput {
  id?: string
  parent_id?: string | null
  title: string
  description?: string | null
  success_criteria?: unknown
  priority?: number
  status?: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
  deadline?: Date | null
  completed_at?: Date | null
  metadata?: unknown
}

export interface GoalFilterOptions {
  status?: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
  parent_id?: string | null
  include_children?: boolean
  limit?: number
  offset?: number
}

export interface AgentGoalsRepository {
  /** Find a goal by ID */
  findById(id: string): Promise<AgentGoalRow | null>

  /** Create a new goal */
  create(input: AgentGoalInput): Promise<AgentGoalRow>

  /** Update an existing goal */
  update(id: string, updates: Partial<Omit<AgentGoalInput, 'id'>>): Promise<AgentGoalRow | null>

  /** Delete a goal by ID (also deletes child goals via CASCADE) */
  delete(id: string): Promise<boolean>

  /** Find goals matching filter criteria */
  findMany(options?: GoalFilterOptions): Promise<AgentGoalRow[]>

  /** Get active goals ordered by priority (for autonomous execution) */
  getActiveGoals(limit?: number): Promise<AgentGoalRow[]>

  /** Get child goals for a parent */
  getChildren(parentId: string): Promise<AgentGoalRow[]>

  /** Mark a goal as completed */
  markCompleted(id: string): Promise<AgentGoalRow | null>

  /** Update priority of a goal */
  updatePriority(id: string, priority: number): Promise<AgentGoalRow | null>

  /** Get goals due soon (for attention allocation) */
  getDueSoon(hours: number, limit?: number): Promise<AgentGoalRow[]>
}

export function createAgentGoalsRepository(
  ctx: RepositoryContext
): AgentGoalsRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const rows = await sql<AgentGoalRow[]>`
        SELECT * FROM agent_goals WHERE id = ${id}
      `
      return rows[0] || null
    },

    async create(input) {
      const id = input.id || generateCanonicalId()

      const rows = await sql<AgentGoalRow[]>`
        INSERT INTO agent_goals (
          id,
          parent_id,
          title,
          description,
          success_criteria,
          priority,
          status,
          deadline,
          completed_at,
          metadata
        )
        VALUES (
          ${id},
          ${input.parent_id ?? null},
          ${input.title},
          ${input.description ?? null},
          ${input.success_criteria ? sql.json(input.success_criteria as any) : null},
          ${input.priority ?? 0.0},
          ${input.status ?? 'active'},
          ${input.deadline ?? null},
          ${input.completed_at ?? null},
          ${input.metadata ? sql.json(input.metadata as any) : null}
        )
        RETURNING *
      `
      return rows[0]
    },

    async update(id, updates) {
      const rows = await sql<AgentGoalRow[]>`
        UPDATE agent_goals
        SET
          title = COALESCE(${updates.title ?? null}, title),
          description = COALESCE(${updates.description ?? null}, description),
          success_criteria = COALESCE(${updates.success_criteria !== undefined ? sql.json(updates.success_criteria as any) : null}, success_criteria),
          priority = COALESCE(${updates.priority ?? null}, priority),
          status = COALESCE(${updates.status ?? null}, status),
          deadline = COALESCE(${updates.deadline ?? null}, deadline),
          completed_at = COALESCE(${updates.completed_at ?? null}, completed_at),
          metadata = COALESCE(${updates.metadata !== undefined ? sql.json(updates.metadata as any) : null}, metadata),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return rows[0] || null
    },

    async delete(id) {
      const result = await sql`DELETE FROM agent_goals WHERE id = ${id}`
      return result.count > 0
    },

    async findMany(options = {}) {
      const {
        status,
        parent_id,
        limit = 100,
        offset = 0,
      } = options

      const rows = await sql<AgentGoalRow[]>`
        SELECT * FROM agent_goals
        WHERE 1=1
          ${status ? sql`AND status = ${status}` : sql``}
          ${parent_id === undefined ? sql`` : parent_id === null ? sql`AND parent_id IS NULL` : sql`AND parent_id = ${parent_id}`}
        ORDER BY priority DESC, created_at ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `
      return rows
    },

    async getActiveGoals(limit = 50) {
      const rows = await sql<AgentGoalRow[]>`
        SELECT * FROM agent_goals
        WHERE status = 'active'
        ORDER BY priority DESC, deadline ASC NULLS LAST, created_at ASC
        LIMIT ${limit}
      `
      return rows
    },

    async getChildren(parentId) {
      const rows = await sql<AgentGoalRow[]>`
        SELECT * FROM agent_goals
        WHERE parent_id = ${parentId}
        ORDER BY priority DESC, created_at ASC
      `
      return rows
    },

    async markCompleted(id) {
      const rows = await sql<AgentGoalRow[]>`
        UPDATE agent_goals
        SET
          status = 'completed',
          completed_at = NOW(),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return rows[0] || null
    },

    async updatePriority(id, priority) {
      const rows = await sql<AgentGoalRow[]>`
        UPDATE agent_goals
        SET
          priority = ${priority},
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return rows[0] || null
    },

    async getDueSoon(hours = 24, limit = 20) {
      const rows = await sql<AgentGoalRow[]>`
        SELECT * FROM agent_goals
        WHERE status = 'active'
          AND deadline IS NOT NULL
          AND deadline <= NOW() + INTERVAL '1 hour' * ${hours}
        ORDER BY deadline ASC, priority DESC
        LIMIT ${limit}
      `
      return rows
    },
  }
}

