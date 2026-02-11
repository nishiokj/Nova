/**
 * Merge Decision Repository
 *
 * CRUD operations for merge_decisions table.
 * Tracks all entity merge decisions for auditability and undo support.
 */

import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'
import type { DecisionType, MergeDecision } from '../../resolution/types.js'
import { generateCanonicalId } from '../../ids.js'

export interface MergeDecisionRow {
  id: string
  primary_entity_id: string
  merged_entity_id: string
  entity_type: string
  decision_type: string
  confidence: number
  reason: Record<string, unknown> | null
  decided_at: Date
  decided_by: string | null
  is_reversed: boolean
  reversed_at: Date | null
  reversed_by: string | null
}

export interface MergeDecisionInput {
  primary_entity_id: string
  merged_entity_id: string
  entity_type: string
  decision_type: DecisionType
  confidence: number
  reason?: {
    scores: Record<string, number>
    totalScore: number
    matchedOn: string[]
  }
  decided_by?: string
}

function rowToMergeDecision(row: MergeDecisionRow): MergeDecision {
  return {
    id: row.id,
    primary_entity_id: row.primary_entity_id,
    merged_entity_id: row.merged_entity_id,
    entity_type: row.entity_type,
    decision_type: row.decision_type as DecisionType,
    confidence: row.confidence,
    reason: row.reason as MergeDecision['reason'],
    decided_at: row.decided_at.toISOString(),
    decided_by: row.decided_by ?? undefined,
    is_reversed: row.is_reversed,
    reversed_at: row.reversed_at?.toISOString(),
    reversed_by: row.reversed_by ?? undefined,
  }
}

export interface MergeDecisionRepository {
  findById(id: string): Promise<MergeDecision | null>
  findByPrimaryEntity(entityId: string): Promise<MergeDecision[]>
  findByMergedEntity(entityId: string): Promise<MergeDecision[]>
  findByEntityType(
    entityType: string,
    options?: PaginationOptions
  ): Promise<PaginatedResult<MergeDecision>>
  findActive(): Promise<MergeDecision[]>
  create(input: MergeDecisionInput): Promise<MergeDecision>
  reverse(id: string, reversedBy?: string): Promise<MergeDecision | null>
  existsForPair(entityA: string, entityB: string): Promise<boolean>
}

export function createMergeDecisionRepository(ctx: RepositoryContext): MergeDecisionRepository {
  const { sql } = ctx

  return {
    async findById(id) {
      const [row] = await sql<MergeDecisionRow[]>`
        SELECT * FROM merge_decisions WHERE id = ${id}
      `
      return row ? rowToMergeDecision(row) : null
    },

    async findByPrimaryEntity(entityId) {
      const rows = await sql<MergeDecisionRow[]>`
        SELECT * FROM merge_decisions
        WHERE primary_entity_id = ${entityId}
        ORDER BY decided_at DESC
      `
      return rows.map(rowToMergeDecision)
    },

    async findByMergedEntity(entityId) {
      const rows = await sql<MergeDecisionRow[]>`
        SELECT * FROM merge_decisions
        WHERE merged_entity_id = ${entityId}
        ORDER BY decided_at DESC
      `
      return rows.map(rowToMergeDecision)
    },

    async findByEntityType(entityType, options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM merge_decisions
        WHERE entity_type = ${entityType}
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<MergeDecisionRow[]>`
        SELECT * FROM merge_decisions
        WHERE entity_type = ${entityType}
        ORDER BY decided_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `

      return {
        items: rows.map(rowToMergeDecision),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findActive() {
      const rows = await sql<MergeDecisionRow[]>`
        SELECT * FROM merge_decisions
        WHERE is_reversed = FALSE
        ORDER BY decided_at DESC
      `
      return rows.map(rowToMergeDecision)
    },

    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<MergeDecisionRow[]>`
        INSERT INTO merge_decisions (
          id, primary_entity_id, merged_entity_id, entity_type,
          decision_type, confidence, reason, decided_at, decided_by
        ) VALUES (
          ${id},
          ${input.primary_entity_id},
          ${input.merged_entity_id},
          ${input.entity_type},
          ${input.decision_type},
          ${input.confidence},
          ${input.reason ? JSON.stringify(input.reason) : null}::jsonb,
          ${now},
          ${input.decided_by ?? null}
        )
        RETURNING *
      `

      return rowToMergeDecision(row)
    },

    async reverse(id, reversedBy) {
      const now = new Date()

      const [row] = await sql<MergeDecisionRow[]>`
        UPDATE merge_decisions
        SET is_reversed = TRUE,
            reversed_at = ${now},
            reversed_by = ${reversedBy ?? null}
        WHERE id = ${id} AND is_reversed = FALSE
        RETURNING *
      `

      return row ? rowToMergeDecision(row) : null
    },

    async existsForPair(entityA, entityB) {
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM merge_decisions
          WHERE is_reversed = FALSE
            AND (
              (primary_entity_id = ${entityA} AND merged_entity_id = ${entityB})
              OR (primary_entity_id = ${entityB} AND merged_entity_id = ${entityA})
            )
        ) as exists
      `
      return result.exists
    },
  }
}
