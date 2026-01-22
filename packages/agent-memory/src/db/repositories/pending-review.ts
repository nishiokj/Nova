/**
 * Pending Review Repository
 *
 * CRUD operations for pending_reviews table.
 * Tracks identity-person matches awaiting human review.
 */

import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'
import type { PendingReview, MatchScores } from '../../resolution/types.js'
import { generateCanonicalId } from '../../ids.js'

export interface PendingReviewRow {
  id: string
  identity_id: string
  suggested_person_id: string
  match_scores: Record<string, unknown>
  created_at: Date
  reviewed_at: Date | null
  decision: string | null
}

export interface PendingReviewInput {
  identity_id: string
  suggested_person_id: string
  match_scores: MatchScores & {
    totalScore: number
    matchedOn: string[]
  }
}

function rowToPendingReview(row: PendingReviewRow): PendingReview {
  const scores = row.match_scores as PendingReview['match_scores']
  return {
    id: row.id,
    identity_id: row.identity_id,
    suggested_person_id: row.suggested_person_id,
    match_scores: scores,
    created_at: row.created_at.toISOString(),
    reviewed_at: row.reviewed_at?.toISOString(),
    decision: row.decision as PendingReview['decision'],
  }
}

export interface PendingReviewRepository {
  findById(id: string): Promise<PendingReview | null>
  findByIdentity(identityId: string): Promise<PendingReview[]>
  findByPerson(personId: string): Promise<PendingReview[]>
  findPending(options?: PaginationOptions): Promise<PaginatedResult<PendingReview>>
  findAll(options?: PaginationOptions): Promise<PaginatedResult<PendingReview>>
  create(input: PendingReviewInput): Promise<PendingReview>
  approve(id: string): Promise<PendingReview | null>
  reject(id: string): Promise<PendingReview | null>
  existsForPair(identityId: string, personId: string): Promise<boolean>
  deleteByIdentity(identityId: string): Promise<number>
}

export function createPendingReviewRepository(ctx: RepositoryContext): PendingReviewRepository {
  const { sql } = ctx

  return {
    async findById(id) {
      const [row] = await sql<PendingReviewRow[]>`
        SELECT * FROM pending_reviews WHERE id = ${id}
      `
      return row ? rowToPendingReview(row) : null
    },

    async findByIdentity(identityId) {
      const rows = await sql<PendingReviewRow[]>`
        SELECT * FROM pending_reviews
        WHERE identity_id = ${identityId}
        ORDER BY created_at DESC
      `
      return rows.map(rowToPendingReview)
    },

    async findByPerson(personId) {
      const rows = await sql<PendingReviewRow[]>`
        SELECT * FROM pending_reviews
        WHERE suggested_person_id = ${personId}
        ORDER BY created_at DESC
      `
      return rows.map(rowToPendingReview)
    },

    async findPending(options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pending_reviews
        WHERE reviewed_at IS NULL
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<PendingReviewRow[]>`
        SELECT * FROM pending_reviews
        WHERE reviewed_at IS NULL
        ORDER BY
          (match_scores->>'totalScore')::double precision DESC,
          created_at ASC
        LIMIT ${limit} OFFSET ${offset}
      `

      return {
        items: rows.map(rowToPendingReview),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findAll(options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pending_reviews
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<PendingReviewRow[]>`
        SELECT * FROM pending_reviews
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `

      return {
        items: rows.map(rowToPendingReview),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<PendingReviewRow[]>`
        INSERT INTO pending_reviews (
          id, identity_id, suggested_person_id, match_scores, created_at
        ) VALUES (
          ${id},
          ${input.identity_id},
          ${input.suggested_person_id},
          ${JSON.stringify(input.match_scores)}::jsonb,
          ${now}
        )
        RETURNING *
      `

      return rowToPendingReview(row)
    },

    async approve(id) {
      const now = new Date()

      const [row] = await sql<PendingReviewRow[]>`
        UPDATE pending_reviews
        SET reviewed_at = ${now}, decision = 'approve'
        WHERE id = ${id} AND reviewed_at IS NULL
        RETURNING *
      `

      return row ? rowToPendingReview(row) : null
    },

    async reject(id) {
      const now = new Date()

      const [row] = await sql<PendingReviewRow[]>`
        UPDATE pending_reviews
        SET reviewed_at = ${now}, decision = 'reject'
        WHERE id = ${id} AND reviewed_at IS NULL
        RETURNING *
      `

      return row ? rowToPendingReview(row) : null
    },

    async existsForPair(identityId, personId) {
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM pending_reviews
          WHERE identity_id = ${identityId}
            AND suggested_person_id = ${personId}
            AND reviewed_at IS NULL
        ) as exists
      `
      return result.exists
    },

    async deleteByIdentity(identityId) {
      const result = await sql`
        DELETE FROM pending_reviews
        WHERE identity_id = ${identityId}
      `
      return result.count
    },
  }
}
