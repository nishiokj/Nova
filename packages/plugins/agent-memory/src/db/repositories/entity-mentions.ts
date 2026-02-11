import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'
import { generateCanonicalId } from '../../ids.js'
import type { Sql } from 'postgres'

export interface EntityMentionRow {
  id: string
  conversation_id: string
  entity_type: 'project' | 'goal' | 'person' | 'issue' | 'concept'
  entity_id: string | null
  surface_form: string
  message_ids: string[]
  confidence: number
  embedding: number[] | null
  created_at: Date
}

export interface EntityMentionRecord {
  id: string
  conversation_id: string
  entity_type: 'project' | 'goal' | 'person' | 'issue' | 'concept'
  entity_id?: string
  surface_form: string
  message_ids: string[]
  confidence: number
  embedding?: number[]
  created_at: string
}

function rowToMention(row: EntityMentionRow): EntityMentionRecord {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id ?? undefined,
    surface_form: row.surface_form,
    message_ids: row.message_ids ?? [],
    confidence: row.confidence ?? 0,
    embedding: row.embedding ?? undefined,
    created_at: row.created_at.toISOString(),
  }
}

export interface EntityMentionInput {
  id?: string
  conversation_id: string
  entity_type: 'project' | 'goal' | 'person' | 'issue' | 'concept'
  entity_id?: string | null
  surface_form: string
  message_ids?: string[]
  confidence?: number
  embedding?: number[] | null
}

export interface EntityMentionFilters extends PaginationOptions {
  conversation_id?: string
  entity_type?: 'project' | 'goal' | 'person' | 'issue' | 'concept'
  entity_id?: string | null
}

export interface SimilarityOptions {
  limit?: number
  threshold?: number
}

export interface EntityMentionsRepository {
  findById(id: string): Promise<EntityMentionRecord | null>
  findMany(filters?: EntityMentionFilters): Promise<PaginatedResult<EntityMentionRecord>>
  findByConversationId(conversationId: string): Promise<EntityMentionRecord[]>
  findByEntity(entityType: EntityMentionRow['entity_type'], entityId: string): Promise<EntityMentionRecord[]>
  searchBySurface(query: string, options?: PaginationOptions): Promise<EntityMentionRecord[]>
  similarByEmbedding(embedding: number[], options?: SimilarityOptions): Promise<Array<EntityMentionRecord & { similarity: number }>>
  create(input: EntityMentionInput): Promise<EntityMentionRecord>
  createMany(inputs: EntityMentionInput[]): Promise<void>
  delete(id: string): Promise<boolean>
  deleteByConversation(conversationId: string, types?: EntityMentionRow['entity_type'][]): Promise<number>
  updateEntityId(id: string, entityId: string | null): Promise<EntityMentionRecord | null>
}

export function createEntityMentionsRepository(
  ctx: RepositoryContext
): EntityMentionsRepository {
  const { sql } = ctx as { sql: Sql }

  return {
    async findById(id) {
      const [row] = await sql<EntityMentionRow[]>`
        SELECT * FROM entity_mentions WHERE id = ${id}
      `
      return row ? rowToMention(row) : null
    },

    async findMany(filters = {}) {
      const {
        conversation_id,
        entity_type,
        entity_id,
        limit = 100,
        offset = 0,
        orderBy = 'created_at',
        orderDirection = 'desc',
      } = filters

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM entity_mentions
        WHERE 1=1
          ${conversation_id ? sql`AND conversation_id = ${conversation_id}` : sql``}
          ${entity_type ? sql`AND entity_type = ${entity_type}` : sql``}
          ${entity_id === undefined
            ? sql``
            : entity_id === null
              ? sql`AND entity_id IS NULL`
              : sql`AND entity_id = ${entity_id}`}
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<EntityMentionRow[]>`
        SELECT * FROM entity_mentions
        WHERE 1=1
          ${conversation_id ? sql`AND conversation_id = ${conversation_id}` : sql``}
          ${entity_type ? sql`AND entity_type = ${entity_type}` : sql``}
          ${entity_id === undefined
            ? sql``
            : entity_id === null
              ? sql`AND entity_id IS NULL`
              : sql`AND entity_id = ${entity_id}`}
        ORDER BY
          CASE WHEN ${orderBy} = 'created_at' AND ${orderDirection} = 'desc' THEN created_at END DESC,
          CASE WHEN ${orderBy} = 'created_at' AND ${orderDirection} = 'asc' THEN created_at END ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToMention),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findByConversationId(conversationId) {
      const rows = await sql<EntityMentionRow[]>`
        SELECT * FROM entity_mentions
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at DESC
      `
      return rows.map(rowToMention)
    },

    async findByEntity(entityType, entityId) {
      const rows = await sql<EntityMentionRow[]>`
        SELECT * FROM entity_mentions
        WHERE entity_type = ${entityType} AND entity_id = ${entityId}
        ORDER BY created_at DESC
      `
      return rows.map(rowToMention)
    },

    async searchBySurface(query, options = {}) {
      const { limit = 50, offset = 0 } = options
      const rows = await sql<EntityMentionRow[]>`
        SELECT * FROM entity_mentions
        WHERE surface_form ILIKE '%' || ${query} || '%'
        ORDER BY created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `
      return rows.map(rowToMention)
    },

    async similarByEmbedding(embedding, options = {}) {
      const { limit = 10, threshold = 0.7 } = options
      const vectorLiteral = `[${embedding.join(',')}]`
      const rows = await sql<(EntityMentionRow & { similarity: number })[]>`
        SELECT *, 1 - (embedding <=> ${vectorLiteral}::vector) as similarity
        FROM entity_mentions
        WHERE embedding IS NOT NULL
          AND 1 - (embedding <=> ${vectorLiteral}::vector) >= ${threshold}
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT ${limit}
      `
      return rows.map((row) => ({ ...rowToMention(row), similarity: row.similarity }))
    },

    async create(input) {
      const id = input.id ?? generateCanonicalId()
      const [row] = await sql<EntityMentionRow[]>`
        INSERT INTO entity_mentions (
          id,
          conversation_id,
          entity_type,
          entity_id,
          surface_form,
          message_ids,
          confidence,
          embedding
        ) VALUES (
          ${id},
          ${input.conversation_id},
          ${input.entity_type},
          ${input.entity_id ?? null},
          ${input.surface_form},
          ${input.message_ids ?? []},
          ${input.confidence ?? 0},
          ${input.embedding ? sql`${`[${input.embedding.join(',')}]`}::vector` : null}
        )
        RETURNING *
      `
      return rowToMention(row)
    },

    async createMany(inputs) {
      if (inputs.length === 0) return

      const hasEmbedding = inputs.some((input) => Array.isArray(input.embedding))
      if (hasEmbedding) {
        for (const input of inputs) {
          await this.create(input)
        }
        return
      }

      const rows = inputs.map((input) => ({
        id: input.id ?? generateCanonicalId(),
        conversation_id: input.conversation_id,
        entity_type: input.entity_type,
        entity_id: input.entity_id ?? null,
        surface_form: input.surface_form,
        message_ids: input.message_ids ?? [],
        confidence: input.confidence ?? 0,
        embedding: null,
      }))

      await sql`INSERT INTO entity_mentions ${sql(rows)}`
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM entity_mentions WHERE id = ${id}
      `
      return result.count > 0
    },

    async deleteByConversation(conversationId, types) {
      const result = await sql`
        DELETE FROM entity_mentions
        WHERE conversation_id = ${conversationId}
          ${types && types.length > 0 ? sql`AND entity_type = ANY(${types})` : sql``}
      `
      return result.count
    },

    async updateEntityId(id, entityId) {
      const [row] = await sql<EntityMentionRow[]>`
        UPDATE entity_mentions
        SET entity_id = ${entityId}
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToMention(row) : null
    },
  }
}
