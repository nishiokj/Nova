import type { RepositoryContext } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'
import type { TraceRecord } from 'types'

export interface AgentTraceRow {
  id: string
  revision: string
  session_key: string | null
  tool_name: string
  tool_version: string
  trace: TraceRecord
  created_at: Date
  updated_at: Date
}

export interface AgentTraceInput {
  id?: string
  revision: string
  session_key?: string | null
  tool_name?: string
  tool_version?: string
  trace: TraceRecord
}

export interface TraceFilterOptions {
  session_key?: string
  tool_name?: string
  limit?: number
  offset?: number
}

export interface AgentTracesRepository {
  /** Find a trace by ID */
  findById(id: string): Promise<AgentTraceRow | null>

  /** Find a trace by git revision (commit SHA) */
  findByRevision(revision: string): Promise<AgentTraceRow | null>

  /** Create a new trace record */
  create(input: AgentTraceInput): Promise<AgentTraceRow>

  /** Update an existing trace */
  update(id: string, updates: Partial<Omit<AgentTraceInput, 'id' | 'revision'>>): Promise<AgentTraceRow | null>

  /** Delete a trace by ID */
  delete(id: string): Promise<boolean>

  /** Find traces matching filter criteria */
  findMany(options?: TraceFilterOptions): Promise<AgentTraceRow[]>

  /** Count traces matching filter criteria */
  count(options?: TraceFilterOptions): Promise<number>

  /** Get recent traces */
  getRecent(limit?: number): Promise<AgentTraceRow[]>

  /** Find traces by session key */
  findBySession(sessionKey: string, limit?: number): Promise<AgentTraceRow[]>

  /** Count traces by session key */
  countBySession(sessionKey: string): Promise<number>

  /** Find traces by model ID (searches within JSONB) */
  findByModelId(modelId: string, limit?: number): Promise<AgentTraceRow[]>

  /** Count traces by model ID */
  countByModelId(modelId: string): Promise<number>
}

export function createAgentTracesRepository(
  ctx: RepositoryContext
): AgentTracesRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const rows = await sql<AgentTraceRow[]>`
        SELECT * FROM agent_traces WHERE id = ${id}
      `
      return rows[0] || null
    },

    async findByRevision(revision) {
      const rows = await sql<AgentTraceRow[]>`
        SELECT * FROM agent_traces WHERE revision = ${revision}
      `
      return rows[0] || null
    },

    async create(input) {
      const id = input.id || generateCanonicalId()

      const rows = await sql<AgentTraceRow[]>`
        INSERT INTO agent_traces (
          id,
          revision,
          session_key,
          tool_name,
          tool_version,
          trace
        )
        VALUES (
          ${id},
          ${input.revision},
          ${input.session_key ?? null},
          ${input.tool_name ?? 'agent'},
          ${input.tool_version ?? '0.1.0'},
          ${sql.json(input.trace as any)}
        )
        RETURNING *
      `
      return rows[0]
    },

    async update(id, updates) {
      const rows = await sql<AgentTraceRow[]>`
        UPDATE agent_traces
        SET
          session_key = COALESCE(${updates.session_key ?? null}, session_key),
          tool_name = COALESCE(${updates.tool_name ?? null}, tool_name),
          tool_version = COALESCE(${updates.tool_version ?? null}, tool_version),
          trace = COALESCE(${updates.trace ? sql.json(updates.trace as any) : null}, trace),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return rows[0] || null
    },

    async delete(id) {
      const result = await sql`DELETE FROM agent_traces WHERE id = ${id}`
      return result.count > 0
    },

    async findMany(options = {}) {
      const {
        session_key,
        tool_name,
        limit = 100,
        offset = 0,
      } = options

      const rows = await sql<AgentTraceRow[]>`
        SELECT * FROM agent_traces
        WHERE 1=1
          ${session_key ? sql`AND session_key = ${session_key}` : sql``}
          ${tool_name ? sql`AND tool_name = ${tool_name}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `
      return rows
    },

    async count(options = {}) {
      const { session_key, tool_name } = options
      const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM agent_traces
        WHERE 1=1
          ${session_key ? sql`AND session_key = ${session_key}` : sql``}
          ${tool_name ? sql`AND tool_name = ${tool_name}` : sql``}
      `
      return row ? parseInt(row.count, 10) : 0
    },

    async getRecent(limit = 50) {
      const rows = await sql<AgentTraceRow[]>`
        SELECT * FROM agent_traces
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows
    },

    async findBySession(sessionKey, limit = 50) {
      const rows = await sql<AgentTraceRow[]>`
        SELECT * FROM agent_traces
        WHERE session_key = ${sessionKey}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows
    },

    async countBySession(sessionKey) {
      const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM agent_traces
        WHERE session_key = ${sessionKey}
      `
      return row ? parseInt(row.count, 10) : 0
    },

    async findByModelId(modelId, limit = 50) {
      // Search for model_id within the JSONB trace.files[].conversations[].contributor.model_id
      const rows = await sql<AgentTraceRow[]>`
        SELECT * FROM agent_traces
        WHERE trace @> ${sql.json({ files: [{ conversations: [{ contributor: { model_id: modelId } }] }] })}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return rows
    },

    async countByModelId(modelId) {
      const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM agent_traces
        WHERE trace @> ${sql.json({ files: [{ conversations: [{ contributor: { model_id: modelId } }] }] })}
      `
      return row ? parseInt(row.count, 10) : 0
    },
  }
}
