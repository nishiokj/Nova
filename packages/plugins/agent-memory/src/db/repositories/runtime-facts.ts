import type { RepositoryContext } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export type RuntimeFactType = 'error' | 'exception' | 'performance' | 'log_pattern' | 'behavior'

export interface RuntimeFactRow {
  id: string
  fact_type: RuntimeFactType
  message: string | null
  sanitized_message: string | null
  stack_frames: unknown | null
  context: unknown | null
  related_entity_ids: string[] | null
  first_seen_at: Date
  last_seen_at: Date
  occurrence_count: number
  session_id: string | null
  commit_hash: string | null
  search_vector?: unknown
  embedding?: number[] | null
}

export interface RuntimeFactInput {
  id?: string
  fact_type: RuntimeFactType
  message?: string | null
  sanitized_message?: string | null
  stack_frames?: unknown | null
  context?: unknown | null
  related_entity_ids?: string[] | null
  session_id?: string | null
  commit_hash?: string | null
}

export interface RuntimeFactsRepository {
  findById(id: string): Promise<RuntimeFactRow | null>
  upsert(input: RuntimeFactInput): Promise<RuntimeFactRow>
}

export function createRuntimeFactsRepository(
  ctx: RepositoryContext
): RuntimeFactsRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const rows = await sql<RuntimeFactRow[]>`
        SELECT * FROM runtime_facts WHERE id = ${id}
      `
      return rows[0] || null
    },

    async upsert(input) {
      const id = input.id ?? generateCanonicalId()
      const rows = await sql<RuntimeFactRow[]>`
        INSERT INTO runtime_facts (
          id,
          fact_type,
          message,
          sanitized_message,
          stack_frames,
          context,
          related_entity_ids,
          session_id,
          commit_hash
        ) VALUES (
          ${id},
          ${input.fact_type},
          ${input.message ?? null},
          ${input.sanitized_message ?? null},
          ${input.stack_frames !== undefined ? sql.json(input.stack_frames as any) : null},
          ${input.context !== undefined ? sql.json(input.context as any) : null},
          ${input.related_entity_ids ? sql.array(input.related_entity_ids) : null},
          ${input.session_id ?? null},
          ${input.commit_hash ?? null}
        )
        ON CONFLICT (id) DO UPDATE SET
          message = EXCLUDED.message,
          sanitized_message = EXCLUDED.sanitized_message,
          stack_frames = EXCLUDED.stack_frames,
          context = EXCLUDED.context,
          related_entity_ids = EXCLUDED.related_entity_ids,
          session_id = EXCLUDED.session_id,
          commit_hash = EXCLUDED.commit_hash,
          last_seen_at = now(),
          occurrence_count = runtime_facts.occurrence_count + 1
        RETURNING *
      `
      return rows[0]
    },
  }
}
