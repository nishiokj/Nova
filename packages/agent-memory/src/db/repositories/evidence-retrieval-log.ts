import type { RepositoryContext } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export type RetrievalStatus = 'ok' | 'partial' | 'error'

export interface EvidenceRetrievalLogRow {
  id: string
  session_id: string
  work_item_id: string | null
  request_id: string | null
  injector_version: string | null
  request_at: Date
  task_objective: string | null
  query_text: string | null
  budget: unknown | null
  retrieved_count: number | null
  packed_count: number | null
  total_tokens: number | null
  attention_tax: number | null
  coverage: unknown | null
  discriminators_count: number | null
  retrieval_latency_ms: number | null
  packing_latency_ms: number | null
  total_latency_ms: number | null
  status: RetrievalStatus | null
  error_code: string | null
  error_message: string | null
  retrieved_ids: string[] | null
  packed_ids: string[] | null
  rejection_reasons: unknown | null
}

export interface EvidenceRetrievalLogInput {
  id?: string
  session_id: string
  work_item_id?: string | null
  request_id?: string | null
  injector_version?: string | null
  task_objective?: string | null
  query_text?: string | null
  budget?: unknown | null
  retrieved_count?: number | null
  packed_count?: number | null
  total_tokens?: number | null
  attention_tax?: number | null
  coverage?: unknown | null
  discriminators_count?: number | null
  retrieval_latency_ms?: number | null
  packing_latency_ms?: number | null
  total_latency_ms?: number | null
  status?: RetrievalStatus | null
  error_code?: string | null
  error_message?: string | null
  retrieved_ids?: string[] | null
  packed_ids?: string[] | null
  rejection_reasons?: unknown | null
}

export interface EvidenceRetrievalLogRepository {
  create(input: EvidenceRetrievalLogInput): Promise<EvidenceRetrievalLogRow>
}

export function createEvidenceRetrievalLogRepository(
  ctx: RepositoryContext
): EvidenceRetrievalLogRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async create(input) {
      const id = input.id ?? generateCanonicalId()
      const rows = await sql<EvidenceRetrievalLogRow[]>`
        INSERT INTO evidence_retrieval_log (
          id,
          session_id,
          work_item_id,
          request_id,
          injector_version,
          task_objective,
          query_text,
          budget,
          retrieved_count,
          packed_count,
          total_tokens,
          attention_tax,
          coverage,
          discriminators_count,
          retrieval_latency_ms,
          packing_latency_ms,
          total_latency_ms,
          status,
          error_code,
          error_message,
          retrieved_ids,
          packed_ids,
          rejection_reasons
        ) VALUES (
          ${id},
          ${input.session_id},
          ${input.work_item_id ?? null},
          ${input.request_id ?? null},
          ${input.injector_version ?? null},
          ${input.task_objective ?? null},
          ${input.query_text ?? null},
          ${input.budget !== undefined ? sql.json(input.budget as any) : null},
          ${input.retrieved_count ?? null},
          ${input.packed_count ?? null},
          ${input.total_tokens ?? null},
          ${input.attention_tax ?? null},
          ${input.coverage !== undefined ? sql.json(input.coverage as any) : null},
          ${input.discriminators_count ?? null},
          ${input.retrieval_latency_ms ?? null},
          ${input.packing_latency_ms ?? null},
          ${input.total_latency_ms ?? null},
          ${input.status ?? 'ok'},
          ${input.error_code ?? null},
          ${input.error_message ?? null},
          ${input.retrieved_ids ? sql.array(input.retrieved_ids) : null},
          ${input.packed_ids ? sql.array(input.packed_ids) : null},
          ${input.rejection_reasons !== undefined ? sql.json(input.rejection_reasons as any) : null}
        )
        RETURNING *
      `
      return rows[0]
    },
  }
}
