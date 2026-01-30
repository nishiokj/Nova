import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export interface ConversationDigestRow {
  id: string
  conversation_id: string
  summary: string
  decisions: unknown
  outcome: string | null
  processor_version: string
  model_version: string
  created_at: Date
  updated_at: Date
}

export interface ConversationDigestRecord {
  id: string
  conversation_id: string
  summary: string
  decisions: Array<{ description: string; message_id: string; confidence: number }>
  outcome?: 'resolved' | 'ongoing' | 'blocked' | 'abandoned'
  processor_version: string
  model_version: string
  created_at: string
  updated_at: string
}

function rowToDigest(row: ConversationDigestRow): ConversationDigestRecord {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    summary: row.summary,
    decisions: (row.decisions as ConversationDigestRecord['decisions']) ?? [],
    outcome: (row.outcome as ConversationDigestRecord['outcome']) ?? undefined,
    processor_version: row.processor_version,
    model_version: row.model_version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export interface ConversationDigestInput {
  id?: string
  conversation_id: string
  summary: string
  decisions?: Array<{ description: string; message_id: string; confidence: number }>
  outcome?: 'resolved' | 'ongoing' | 'blocked' | 'abandoned' | null
  processor_version: string
  model_version: string
}

export interface ConversationDigestUpdateInput {
  summary?: string
  decisions?: Array<{ description: string; message_id: string; confidence: number }>
  outcome?: 'resolved' | 'ongoing' | 'blocked' | 'abandoned' | null
  processor_version?: string
  model_version?: string
}

export interface ConversationDigestRepository {
  findById(id: string): Promise<ConversationDigestRecord | null>
  findByConversationId(conversationId: string): Promise<ConversationDigestRecord | null>
  findRecent(options?: PaginationOptions): Promise<PaginatedResult<ConversationDigestRecord>>
  create(input: ConversationDigestInput): Promise<ConversationDigestRecord>
  upsertByConversation(input: ConversationDigestInput): Promise<ConversationDigestRecord>
  update(id: string, updates: ConversationDigestUpdateInput): Promise<ConversationDigestRecord | null>
  delete(id: string): Promise<boolean>
  deleteByConversation(conversationId: string): Promise<boolean>
}

export function createConversationDigestRepository(
  ctx: RepositoryContext
): ConversationDigestRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const [row] = await sql<ConversationDigestRow[]>`
        SELECT * FROM conversation_digests WHERE id = ${id}
      `
      return row ? rowToDigest(row) : null
    },

    async findByConversationId(conversationId) {
      const [row] = await sql<ConversationDigestRow[]>`
        SELECT * FROM conversation_digests WHERE conversation_id = ${conversationId}
      `
      return row ? rowToDigest(row) : null
    },

    async findRecent(options = {}) {
      const { limit = 50, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM conversation_digests
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<ConversationDigestRow[]>`
        SELECT * FROM conversation_digests
        ORDER BY updated_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToDigest),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async create(input) {
      const id = input.id ?? generateCanonicalId()
      const [row] = await sql<ConversationDigestRow[]>`
        INSERT INTO conversation_digests (
          id,
          conversation_id,
          summary,
          decisions,
          outcome,
          processor_version,
          model_version
        ) VALUES (
          ${id},
          ${input.conversation_id},
          ${input.summary},
          ${sql.json(input.decisions ?? [])},
          ${input.outcome ?? null},
          ${input.processor_version},
          ${input.model_version}
        )
        RETURNING *
      `
      return rowToDigest(row)
    },

    async upsertByConversation(input) {
      const id = input.id ?? generateCanonicalId()
      const [row] = await sql<ConversationDigestRow[]>`
        INSERT INTO conversation_digests (
          id,
          conversation_id,
          summary,
          decisions,
          outcome,
          processor_version,
          model_version
        ) VALUES (
          ${id},
          ${input.conversation_id},
          ${input.summary},
          ${sql.json(input.decisions ?? [])},
          ${input.outcome ?? null},
          ${input.processor_version},
          ${input.model_version}
        )
        ON CONFLICT (conversation_id)
        DO UPDATE SET
          summary = EXCLUDED.summary,
          decisions = EXCLUDED.decisions,
          outcome = EXCLUDED.outcome,
          processor_version = EXCLUDED.processor_version,
          model_version = EXCLUDED.model_version,
          updated_at = NOW()
        RETURNING *
      `
      return rowToDigest(row)
    },

    async update(id, updates) {
      const [row] = await sql<ConversationDigestRow[]>`
        UPDATE conversation_digests
        SET
          summary = COALESCE(${updates.summary ?? null}, summary),
          decisions = COALESCE(${updates.decisions ? sql.json(updates.decisions as any) : null}, decisions),
          outcome = COALESCE(${updates.outcome ?? null}, outcome),
          processor_version = COALESCE(${updates.processor_version ?? null}, processor_version),
          model_version = COALESCE(${updates.model_version ?? null}, model_version),
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToDigest(row) : null
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM conversation_digests WHERE id = ${id}
      `
      return result.count > 0
    },

    async deleteByConversation(conversationId) {
      const result = await sql`
        DELETE FROM conversation_digests WHERE conversation_id = ${conversationId}
      `
      return result.count > 0
    },
  }
}
