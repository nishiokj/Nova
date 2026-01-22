/**
 * Canonical Entity Repository
 *
 * CRUD operations for canonical_entities table.
 * Supports all entity types with type-safe operations.
 */

import type { EntityType, CanonicalEntity } from '../../models/canonical.js'
import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'

export interface CanonicalEntityRow {
  id: string
  entity_type: string
  data: Record<string, unknown>
  created_at: Date
  updated_at: Date
  display_text: string | null
  search_vector: unknown
  embedding: number[] | null
  deleted_at: Date | null
}

export interface StoredEntity {
  id: string
  entity_type: EntityType
  data: CanonicalEntity
  created_at: string
  updated_at: string
  display_text?: string
  embedding?: number[]
  deleted_at?: string
}

function rowToStoredEntity(row: CanonicalEntityRow): StoredEntity {
  return {
    id: row.id,
    entity_type: row.entity_type as EntityType,
    data: row.data as CanonicalEntity,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    display_text: row.display_text ?? undefined,
    embedding: row.embedding ?? undefined,
    deleted_at: row.deleted_at?.toISOString(),
  }
}

export interface CanonicalEntityFilters {
  entity_type?: EntityType
  includeDeleted?: boolean
}

export interface CanonicalEntityRepository {
  findById(id: string): Promise<StoredEntity | null>
  findByIds(ids: string[]): Promise<StoredEntity[]>
  findByType(
    entityType: EntityType,
    options?: PaginationOptions
  ): Promise<PaginatedResult<StoredEntity>>
  search(query: string, options?: PaginationOptions & CanonicalEntityFilters): Promise<StoredEntity[]>
  similarByEmbedding(
    embedding: number[],
    options?: { limit?: number; threshold?: number; entityType?: EntityType }
  ): Promise<Array<StoredEntity & { similarity: number }>>
  create(entityType: EntityType, data: CanonicalEntity, displayText?: string): Promise<StoredEntity>
  update(id: string, data: Partial<CanonicalEntity>, displayText?: string): Promise<StoredEntity | null>
  updateEmbedding(id: string, embedding: number[]): Promise<boolean>
  softDelete(id: string): Promise<boolean>
  restore(id: string): Promise<boolean>
  hardDelete(id: string): Promise<boolean>
}

export function createCanonicalEntityRepository(ctx: RepositoryContext): CanonicalEntityRepository {
  const { sql } = ctx

  return {
    async findById(id) {
      const [row] = await sql<CanonicalEntityRow[]>`
        SELECT * FROM canonical_entities
        WHERE id = ${id} AND deleted_at IS NULL
      `
      return row ? rowToStoredEntity(row) : null
    },

    async findByIds(ids) {
      if (ids.length === 0) return []

      const rows = await sql<CanonicalEntityRow[]>`
        SELECT * FROM canonical_entities
        WHERE id = ANY(${ids})
          AND deleted_at IS NULL
      `
      return rows.map(rowToStoredEntity)
    },

    async findByType(entityType, options = {}) {
      const { limit = 100, offset = 0, orderBy = 'updated_at', orderDirection = 'desc' } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM canonical_entities
        WHERE entity_type = ${entityType} AND deleted_at IS NULL
      `
      const total = parseInt(countResult.count, 10)

      // Use safe column ordering
      const rows = await sql<CanonicalEntityRow[]>`
        SELECT * FROM canonical_entities
        WHERE entity_type = ${entityType} AND deleted_at IS NULL
        ORDER BY
          CASE WHEN ${orderBy} = 'updated_at' AND ${orderDirection} = 'desc' THEN updated_at END DESC,
          CASE WHEN ${orderBy} = 'updated_at' AND ${orderDirection} = 'asc' THEN updated_at END ASC,
          CASE WHEN ${orderBy} = 'created_at' AND ${orderDirection} = 'desc' THEN created_at END DESC,
          CASE WHEN ${orderBy} = 'created_at' AND ${orderDirection} = 'asc' THEN created_at END ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToStoredEntity),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async search(query, options = {}) {
      const { limit = 50, offset = 0, entity_type, includeDeleted = false } = options

      const rows = await sql<CanonicalEntityRow[]>`
        SELECT * FROM canonical_entities
        WHERE search_vector @@ plainto_tsquery('english', ${query})
          ${entity_type ? sql`AND entity_type = ${entity_type}` : sql``}
          ${!includeDeleted ? sql`AND deleted_at IS NULL` : sql``}
        ORDER BY ts_rank(search_vector, plainto_tsquery('english', ${query})) DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return rows.map(rowToStoredEntity)
    },

    async similarByEmbedding(embedding, options = {}) {
      const { limit = 10, threshold = 0.7, entityType } = options

      const rows = await sql<(CanonicalEntityRow & { similarity: number })[]>`
        SELECT *, 1 - (embedding <=> ${sql.array(embedding)}::vector) as similarity
        FROM canonical_entities
        WHERE embedding IS NOT NULL
          AND deleted_at IS NULL
          ${entityType ? sql`AND entity_type = ${entityType}` : sql``}
          AND 1 - (embedding <=> ${sql.array(embedding)}::vector) >= ${threshold}
        ORDER BY embedding <=> ${sql.array(embedding)}::vector
        LIMIT ${limit}
      `

      return rows.map((row: CanonicalEntityRow & { similarity: number }) => ({
        ...rowToStoredEntity(row),
        similarity: row.similarity,
      }))
    },

    async create(entityType, data, displayText) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<CanonicalEntityRow[]>`
        INSERT INTO canonical_entities (
          id, entity_type, data, created_at, updated_at, display_text
        ) VALUES (
          ${id},
          ${entityType},
          ${JSON.stringify(data)}::jsonb,
          ${now},
          ${now},
          ${displayText ?? null}
        )
        RETURNING *
      `

      return rowToStoredEntity(row)
    },

    async update(id, data, displayText) {
      const now = new Date()

      // Merge the data with existing data
      const [row] = await sql<CanonicalEntityRow[]>`
        UPDATE canonical_entities
        SET data = data || ${JSON.stringify(data)}::jsonb,
            updated_at = ${now}
            ${displayText !== undefined ? sql`, display_text = ${displayText}` : sql``}
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING *
      `

      return row ? rowToStoredEntity(row) : null
    },

    async updateEmbedding(id, embedding) {
      const result = await sql`
        UPDATE canonical_entities
        SET embedding = ${sql.array(embedding)}::vector
        WHERE id = ${id}
      `
      return result.count > 0
    },

    async softDelete(id) {
      const now = new Date()
      const result = await sql`
        UPDATE canonical_entities
        SET deleted_at = ${now}
        WHERE id = ${id} AND deleted_at IS NULL
      `
      return result.count > 0
    },

    async restore(id) {
      const result = await sql`
        UPDATE canonical_entities
        SET deleted_at = NULL
        WHERE id = ${id} AND deleted_at IS NOT NULL
      `
      return result.count > 0
    },

    async hardDelete(id) {
      const result = await sql`
        DELETE FROM canonical_entities WHERE id = ${id}
      `
      return result.count > 0
    },
  }
}
