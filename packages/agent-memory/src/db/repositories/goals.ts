import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export interface GoalRow {
  id: string
  title: string
  description: string | null
  status: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
  parent_goal_id: string | null
  project_id: string | null
  progress_notes: string[]
  target_date: Date | null
  completed_at: Date | null
  conversation_count: number
  last_discussed_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface GoalRecord {
  id: string
  title: string
  description?: string
  status: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
  parent_goal_id?: string
  project_id?: string
  progress_notes: string[]
  target_date?: string
  completed_at?: string
  conversation_count: number
  last_discussed_at?: string
  created_at: string
  updated_at: string
}

function rowToGoal(row: GoalRow): GoalRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    parent_goal_id: row.parent_goal_id ?? undefined,
    project_id: row.project_id ?? undefined,
    progress_notes: row.progress_notes ?? [],
    target_date: row.target_date?.toISOString(),
    completed_at: row.completed_at?.toISOString(),
    conversation_count: row.conversation_count ?? 0,
    last_discussed_at: row.last_discussed_at?.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export interface GoalInput {
  id?: string
  title: string
  description?: string | null
  status?: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
  parent_goal_id?: string | null
  project_id?: string | null
  progress_notes?: string[]
  target_date?: Date | null
  completed_at?: Date | null
  conversation_count?: number
  last_discussed_at?: Date | null
}

export interface GoalUpdateInput {
  title?: string
  description?: string | null
  status?: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
  parent_goal_id?: string | null
  project_id?: string | null
  progress_notes?: string[]
  target_date?: Date | null
  completed_at?: Date | null
  conversation_count?: number
  last_discussed_at?: Date | null
}

export interface GoalFilters extends PaginationOptions {
  status?: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
  parent_goal_id?: string | null
  project_id?: string | null
}

export interface GoalsRepository {
  findById(id: string): Promise<GoalRecord | null>
  findByTitle(title: string): Promise<GoalRecord | null>
  findMany(filters?: GoalFilters): Promise<PaginatedResult<GoalRecord>>
  create(input: GoalInput): Promise<GoalRecord>
  update(id: string, updates: GoalUpdateInput): Promise<GoalRecord | null>
  delete(id: string): Promise<boolean>
}

export function createGoalsRepository(ctx: RepositoryContext): GoalsRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const [row] = await sql<GoalRow[]>`
        SELECT * FROM goals WHERE id = ${id}
      `
      return row ? rowToGoal(row) : null
    },

    async findByTitle(title) {
      const [row] = await sql<GoalRow[]>`
        SELECT * FROM goals WHERE title = ${title}
      `
      return row ? rowToGoal(row) : null
    },

    async findMany(filters = {}) {
      const {
        status,
        parent_goal_id,
        project_id,
        limit = 100,
        offset = 0,
        orderBy = 'updated_at',
        orderDirection = 'desc',
      } = filters

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM goals
        WHERE 1=1
          ${status ? sql`AND status = ${status}` : sql``}
          ${parent_goal_id === undefined
            ? sql``
            : parent_goal_id === null
              ? sql`AND parent_goal_id IS NULL`
              : sql`AND parent_goal_id = ${parent_goal_id}`}
          ${project_id === undefined
            ? sql``
            : project_id === null
              ? sql`AND project_id IS NULL`
              : sql`AND project_id = ${project_id}`}
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<GoalRow[]>`
        SELECT * FROM goals
        WHERE 1=1
          ${status ? sql`AND status = ${status}` : sql``}
          ${parent_goal_id === undefined
            ? sql``
            : parent_goal_id === null
              ? sql`AND parent_goal_id IS NULL`
              : sql`AND parent_goal_id = ${parent_goal_id}`}
          ${project_id === undefined
            ? sql``
            : project_id === null
              ? sql`AND project_id IS NULL`
              : sql`AND project_id = ${project_id}`}
        ORDER BY
          CASE WHEN ${orderBy} = 'updated_at' AND ${orderDirection} = 'desc' THEN updated_at END DESC,
          CASE WHEN ${orderBy} = 'updated_at' AND ${orderDirection} = 'asc' THEN updated_at END ASC,
          CASE WHEN ${orderBy} = 'created_at' AND ${orderDirection} = 'desc' THEN created_at END DESC,
          CASE WHEN ${orderBy} = 'created_at' AND ${orderDirection} = 'asc' THEN created_at END ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToGoal),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async create(input) {
      const id = input.id ?? generateCanonicalId()
      const [row] = await sql<GoalRow[]>`
        INSERT INTO goals (
          id,
          title,
          description,
          status,
          parent_goal_id,
          project_id,
          progress_notes,
          target_date,
          completed_at,
          conversation_count,
          last_discussed_at
        ) VALUES (
          ${id},
          ${input.title},
          ${input.description ?? null},
          ${input.status ?? 'active'},
          ${input.parent_goal_id ?? null},
          ${input.project_id ?? null},
          ${input.progress_notes ?? []},
          ${input.target_date ?? null},
          ${input.completed_at ?? null},
          ${input.conversation_count ?? 0},
          ${input.last_discussed_at ?? null}
        )
        RETURNING *
      `
      return rowToGoal(row)
    },

    async update(id, updates) {
      const [row] = await sql<GoalRow[]>`
        UPDATE goals
        SET
          title = COALESCE(${updates.title ?? null}, title),
          description = COALESCE(${updates.description ?? null}, description),
          status = COALESCE(${updates.status ?? null}, status),
          parent_goal_id = COALESCE(${updates.parent_goal_id ?? null}, parent_goal_id),
          project_id = COALESCE(${updates.project_id ?? null}, project_id),
          progress_notes = COALESCE(${updates.progress_notes ?? null}, progress_notes),
          target_date = COALESCE(${updates.target_date ?? null}, target_date),
          completed_at = COALESCE(${updates.completed_at ?? null}, completed_at),
          conversation_count = COALESCE(${updates.conversation_count ?? null}, conversation_count),
          last_discussed_at = COALESCE(${updates.last_discussed_at ?? null}, last_discussed_at),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToGoal(row) : null
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM goals WHERE id = ${id}
      `
      return result.count > 0
    },
  }
}
