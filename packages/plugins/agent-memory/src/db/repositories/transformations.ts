/**
 * Transformations Repository
 *
 * CRUD operations for transformations catalog.
 */

import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'

export interface TransformationRecord {
  id: string
  name: string
  connector: string
  entity_type: string
  output_type: string | string[]
  enabled: boolean
  version: number
  description?: string
  created_at: string
  updated_at: string
}

export interface TransformationRow {
  id: string
  name: string
  connector: string
  entity_type: string
  output_type: string | string[]
  enabled: boolean
  version: number
  description: string | null
  created_at: Date
  updated_at: Date
}

function rowToTransformation(row: TransformationRow): TransformationRecord {
  return {
    id: row.id,
    name: row.name,
    connector: row.connector,
    entity_type: row.entity_type,
    output_type: row.output_type,
    enabled: row.enabled,
    version: row.version,
    description: row.description ?? undefined,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export interface TransformationInput {
  id: string
  name: string
  connector: string
  entity_type: string
  output_type: string | string[]
  enabled?: boolean
  version?: number
  description?: string
}

export interface TransformationRepository {
  upsert(input: TransformationInput): Promise<TransformationRecord>
  findById(id: string): Promise<TransformationRecord | null>
  findBySource(connector: string, entityType: string): Promise<TransformationRecord[]>
  list(options?: PaginationOptions): Promise<PaginatedResult<TransformationRecord>>
  setEnabled(id: string, enabled: boolean): Promise<TransformationRecord | null>
  delete(id: string): Promise<boolean>
}

export function createTransformationRepository(ctx: RepositoryContext): TransformationRepository {
  const { sql } = ctx

  return {
    async upsert(input) {
      const now = new Date()
      const [row] = await sql<TransformationRow[]>`
        INSERT INTO transformations (
          id, name, connector, entity_type, output_type,
          enabled, version, description, created_at, updated_at
        ) VALUES (
          ${input.id},
          ${input.name},
          ${input.connector},
          ${input.entity_type},
          ${JSON.stringify(input.output_type)},
          ${input.enabled ?? true},
          ${input.version ?? 1},
          ${input.description ?? null},
          ${now},
          ${now}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          connector = EXCLUDED.connector,
          entity_type = EXCLUDED.entity_type,
          output_type = EXCLUDED.output_type,
          enabled = EXCLUDED.enabled,
          version = EXCLUDED.version,
          description = EXCLUDED.description,
          updated_at = ${now}
        RETURNING *
      `

      return rowToTransformation(row)
    },

    async findById(id) {
      const [row] = await sql<TransformationRow[]>`
        SELECT * FROM transformations WHERE id = ${id}
      `
      return row ? rowToTransformation(row) : null
    },

    async findBySource(connector, entityType) {
      const rows = await sql<TransformationRow[]>`
        SELECT * FROM transformations
        WHERE connector = ${connector} AND entity_type = ${entityType}
        ORDER BY name ASC
      `
      return rows.map(rowToTransformation)
    },

    async list(options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM transformations
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<TransformationRow[]>`
        SELECT * FROM transformations
        ORDER BY updated_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToTransformation),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async setEnabled(id, enabled) {
      const now = new Date()
      const [row] = await sql<TransformationRow[]>`
        UPDATE transformations
        SET enabled = ${enabled}, updated_at = ${now}
        WHERE id = ${id}
        RETURNING *
      `
      return row ? rowToTransformation(row) : null
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM transformations WHERE id = ${id}
      `
      return result.count > 0
    },
  }
}
