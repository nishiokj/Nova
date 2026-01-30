/**
 * Canonical Entity Repository
 *
 * CRUD operations for per-type canonical tables.
 * Supports message, conversation, issue, notification, and preference entities.
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
  source_timestamp: Date | null
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
  source_timestamp?: string
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
    source_timestamp: row.source_timestamp?.toISOString(),
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
  create(entityType: EntityType, data: CanonicalEntity, options?: { displayText?: string; sourceTimestamp?: Date }): Promise<StoredEntity>
  update(id: string, data: Partial<CanonicalEntity>, displayText?: string): Promise<StoredEntity | null>
  updateEmbedding(id: string, embedding: number[]): Promise<boolean>
  softDelete(id: string): Promise<boolean>
  restore(id: string): Promise<boolean>
  hardDelete(id: string): Promise<boolean>
}

export function createCanonicalEntityRepository(ctx: RepositoryContext): CanonicalEntityRepository {
  const { sql } = ctx
  const tableByType: Partial<Record<EntityType, string>> = {
    message: 'canonical_message',
    conversation: 'canonical_conversation',
    issue: 'canonical_issue',
    notification: 'canonical_notification',
    event: 'canonical_event',
    preference: 'canonical_preference',
  }
  const allTables = Object.values(tableByType).filter((t): t is string => !!t)

  function tableForType(entityType: EntityType): string | null {
    return tableByType[entityType] ?? null
  }

  async function findByIdInternal(id: string, includeDeleted: boolean): Promise<StoredEntity | null> {
    for (const table of allTables) {
      const [row] = await sql<CanonicalEntityRow[]>`
        SELECT * FROM ${sql(table)}
        WHERE id = ${id}
          ${includeDeleted ? sql`` : sql`AND deleted_at IS NULL`}
      `
      if (row) return rowToStoredEntity(row)
    }
    return null
  }

  return {
    async findById(id) {
      return findByIdInternal(id, false)
    },

    async findByIds(ids) {
      if (ids.length === 0) return []

      const results: StoredEntity[] = []
      for (const table of allTables) {
        const rows = await sql<CanonicalEntityRow[]>`
          SELECT * FROM ${sql(table)}
          WHERE id = ANY(${ids})
            AND deleted_at IS NULL
        `
        results.push(...rows.map(rowToStoredEntity))
      }
      return results
    },

    async findByType(entityType, options = {}) {
      const { limit = 100, offset = 0, orderBy = 'updated_at', orderDirection = 'desc' } = options

      const table = tableForType(entityType)
      if (!table) {
        throw new Error(`Unknown entity type: ${entityType}`)
      }

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM ${sql(table)}
        WHERE deleted_at IS NULL
      `
      const total = parseInt(countResult.count, 10)

      // Use safe column ordering
      const rows = await sql<CanonicalEntityRow[]>`
        SELECT * FROM ${sql(table)}
        WHERE deleted_at IS NULL
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

      if (entity_type) {
        const table = tableForType(entity_type)
        if (!table) {
          throw new Error(`Unknown entity type: ${entity_type}`)
        }
        const rows = await sql<CanonicalEntityRow[]>`
          SELECT * FROM ${sql(table)}
          WHERE search_vector @@ plainto_tsquery('english', ${query})
            ${!includeDeleted ? sql`AND deleted_at IS NULL` : sql``}
          ORDER BY ts_rank(search_vector, plainto_tsquery('english', ${query})) DESC
          LIMIT ${limit}
          OFFSET ${offset}
        `
        return rows.map(rowToStoredEntity)
      }

      const searchSql = `
        SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
        FROM canonical_message
        WHERE search_vector @@ plainto_tsquery('english', $1)
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        UNION ALL
        SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
        FROM canonical_conversation
        WHERE search_vector @@ plainto_tsquery('english', $1)
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        UNION ALL
        SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
        FROM canonical_issue
        WHERE search_vector @@ plainto_tsquery('english', $1)
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        UNION ALL
        SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
        FROM canonical_notification
        WHERE search_vector @@ plainto_tsquery('english', $1)
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        UNION ALL
        SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
        FROM canonical_preference
        WHERE search_vector @@ plainto_tsquery('english', $1)
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        ORDER BY rank DESC
        LIMIT $2
        OFFSET $3
      `

      const rows = await sql.unsafe<(CanonicalEntityRow & { rank: number })[]>(searchSql, [
        query,
        limit,
        offset,
      ])

      return rows.map(rowToStoredEntity)
    },

    async similarByEmbedding(embedding, options = {}) {
      const { limit = 10, threshold = 0.7, entityType } = options
      if (!entityType) {
        throw new Error('similarByEmbedding requires entityType with per-type canonical tables')
      }

      const table = tableForType(entityType)
      if (!table) {
        throw new Error(`Unknown entity type: ${entityType}`)
      }

      const rows = await sql<(CanonicalEntityRow & { similarity: number })[]>`
        SELECT *, 1 - (embedding <=> ${sql.array(embedding)}::vector) as similarity
        FROM ${sql(table)}
        WHERE embedding IS NOT NULL
          AND deleted_at IS NULL
          AND 1 - (embedding <=> ${sql.array(embedding)}::vector) >= ${threshold}
        ORDER BY embedding <=> ${sql.array(embedding)}::vector
        LIMIT ${limit}
      `

      return rows.map((row: CanonicalEntityRow & { similarity: number }) => ({
        ...rowToStoredEntity(row),
        similarity: row.similarity,
      }))
    },

    async create(entityType, data, options) {
      const id = generateCanonicalId()
      const now = new Date()
      const table = tableForType(entityType)
      if (!table) {
        throw new Error(`Unknown entity type: ${entityType}`)
      }
      const { displayText, sourceTimestamp } = options ?? {}

      const [row] = await sql<CanonicalEntityRow[]>`
        INSERT INTO ${sql(table)} (
          id, entity_type, data, created_at, updated_at, display_text, source_timestamp
        ) VALUES (
          ${id},
          ${entityType},
          ${sql.json(data as Parameters<typeof sql.json>[0])},
          ${now},
          ${now},
          ${displayText ?? null},
          ${sourceTimestamp ?? null}
        )
        RETURNING *
      `

      return rowToStoredEntity(row)
    },

    async update(id, data, displayText) {
      const now = new Date()
      const existing = await findByIdInternal(id, false)
      if (!existing) return null
      const table = tableForType(existing.entity_type)
      if (!table) {
        return null
      }

      // Merge the data with existing data
      const [row] = await sql<CanonicalEntityRow[]>`
        UPDATE ${sql(table)}
        SET data = data || ${sql.json(data as Parameters<typeof sql.json>[0])},
            updated_at = ${now}
            ${displayText !== undefined ? sql`, display_text = ${displayText}` : sql``}
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING *
      `

      return row ? rowToStoredEntity(row) : null
    },

    async updateEmbedding(id, embedding) {
      const existing = await findByIdInternal(id, true)
      if (!existing) return false
      const table = tableForType(existing.entity_type)
      if (!table) {
        return false
      }
      const result = await sql`
        UPDATE ${sql(table)}
        SET embedding = ${sql.array(embedding)}::vector
        WHERE id = ${id}
      `
      return result.count > 0
    },

    async softDelete(id) {
      const now = new Date()
      const existing = await findByIdInternal(id, false)
      if (!existing) return false
      const table = tableForType(existing.entity_type)
      if (!table) {
        return false
      }
      const result = await sql`
        UPDATE ${sql(table)}
        SET deleted_at = ${now}
        WHERE id = ${id} AND deleted_at IS NULL
      `
      return result.count > 0
    },

    async restore(id) {
      const existing = await findByIdInternal(id, true)
      if (!existing) return false
      const table = tableForType(existing.entity_type)
      if (!table) {
        return false
      }
      const result = await sql`
        UPDATE ${sql(table)}
        SET deleted_at = NULL
        WHERE id = ${id} AND deleted_at IS NOT NULL
      `
      return result.count > 0
    },

    async hardDelete(id) {
      const existing = await findByIdInternal(id, true)
      if (!existing) return false
      const table = tableForType(existing.entity_type)
      if (!table) {
        return false
      }
      const result = await sql`
        DELETE FROM ${sql(table)} WHERE id = ${id}
      `
      return result.count > 0
    },
  }
}
