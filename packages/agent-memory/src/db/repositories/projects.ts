import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export interface ProjectRow {
  id: string
  name: string
  description: string | null
  status: 'active' | 'paused' | 'completed' | 'abandoned'
  repo_url: string | null
  parent_project_id: string | null
  conversation_count: number
  last_discussed_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface ProjectRecord {
  id: string
  name: string
  description?: string
  status: 'active' | 'paused' | 'completed' | 'abandoned'
  repo_url?: string
  parent_project_id?: string
  conversation_count: number
  last_discussed_at?: string
  created_at: string
  updated_at: string
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status,
    repo_url: row.repo_url ?? undefined,
    parent_project_id: row.parent_project_id ?? undefined,
    conversation_count: row.conversation_count ?? 0,
    last_discussed_at: row.last_discussed_at?.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export interface ProjectInput {
  id?: string
  name: string
  description?: string | null
  status?: 'active' | 'paused' | 'completed' | 'abandoned'
  repo_url?: string | null
  parent_project_id?: string | null
  conversation_count?: number
  last_discussed_at?: Date | null
}

export interface ProjectUpdateInput {
  name?: string
  description?: string | null
  status?: 'active' | 'paused' | 'completed' | 'abandoned'
  repo_url?: string | null
  parent_project_id?: string | null
  conversation_count?: number
  last_discussed_at?: Date | null
}

export interface ProjectFilters extends PaginationOptions {
  status?: 'active' | 'paused' | 'completed' | 'abandoned'
  parent_project_id?: string | null
}

export interface ProjectsRepository {
  findById(id: string): Promise<ProjectRecord | null>
  findByName(name: string): Promise<ProjectRecord | null>
  findMany(filters?: ProjectFilters): Promise<PaginatedResult<ProjectRecord>>
  create(input: ProjectInput): Promise<ProjectRecord>
  update(id: string, updates: ProjectUpdateInput): Promise<ProjectRecord | null>
  delete(id: string): Promise<boolean>
}

export function createProjectsRepository(ctx: RepositoryContext): ProjectsRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const [row] = await sql<ProjectRow[]>`
        SELECT * FROM projects WHERE id = ${id}
      `
      return row ? rowToProject(row) : null
    },

    async findByName(name) {
      const [row] = await sql<ProjectRow[]>`
        SELECT * FROM projects WHERE name = ${name}
      `
      return row ? rowToProject(row) : null
    },

    async findMany(filters = {}) {
      const {
        status,
        parent_project_id,
        limit = 100,
        offset = 0,
        orderBy = 'updated_at',
        orderDirection = 'desc',
      } = filters

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM projects
        WHERE 1=1
          ${status ? sql`AND status = ${status}` : sql``}
          ${parent_project_id === undefined
            ? sql``
            : parent_project_id === null
              ? sql`AND parent_project_id IS NULL`
              : sql`AND parent_project_id = ${parent_project_id}`}
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<ProjectRow[]>`
        SELECT * FROM projects
        WHERE 1=1
          ${status ? sql`AND status = ${status}` : sql``}
          ${parent_project_id === undefined
            ? sql``
            : parent_project_id === null
              ? sql`AND parent_project_id IS NULL`
              : sql`AND parent_project_id = ${parent_project_id}`}
        ORDER BY
          CASE WHEN ${orderBy} = 'updated_at' AND ${orderDirection} = 'desc' THEN updated_at END DESC,
          CASE WHEN ${orderBy} = 'updated_at' AND ${orderDirection} = 'asc' THEN updated_at END ASC,
          CASE WHEN ${orderBy} = 'created_at' AND ${orderDirection} = 'desc' THEN created_at END DESC,
          CASE WHEN ${orderBy} = 'created_at' AND ${orderDirection} = 'asc' THEN created_at END ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToProject),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async create(input) {
      const id = input.id ?? generateCanonicalId()
      const [row] = await sql<ProjectRow[]>`
        INSERT INTO projects (
          id,
          name,
          description,
          status,
          repo_url,
          parent_project_id,
          conversation_count,
          last_discussed_at
        ) VALUES (
          ${id},
          ${input.name},
          ${input.description ?? null},
          ${input.status ?? 'active'},
          ${input.repo_url ?? null},
          ${input.parent_project_id ?? null},
          ${input.conversation_count ?? 0},
          ${input.last_discussed_at ?? null}
        )
        RETURNING *
      `
      return rowToProject(row)
    },

    async update(id, updates) {
      const [row] = await sql<ProjectRow[]>`
        UPDATE projects
        SET
          name = COALESCE(${updates.name ?? null}, name),
          description = COALESCE(${updates.description ?? null}, description),
          status = COALESCE(${updates.status ?? null}, status),
          repo_url = COALESCE(${updates.repo_url ?? null}, repo_url),
          parent_project_id = COALESCE(${updates.parent_project_id ?? null}, parent_project_id),
          conversation_count = COALESCE(${updates.conversation_count ?? null}, conversation_count),
          last_discussed_at = COALESCE(${updates.last_discussed_at ?? null}, last_discussed_at),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToProject(row) : null
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM projects WHERE id = ${id}
      `
      return result.count > 0
    },
  }
}
