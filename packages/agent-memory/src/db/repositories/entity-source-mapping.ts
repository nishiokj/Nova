/**
 * Entity Source Mapping Repository
 *
 * CRUD operations for entity_source_mappings table.
 * Tracks lineage between canonical entities and raw envelopes.
 */

import type { EntitySourceMapping, EntitySourceMappingInput } from '../../models/raw.js'
import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext } from './types.js'

export interface EntitySourceMappingRow {
  id: string
  canonical_entity_id: string
  canonical_entity_type: string
  raw_envelope_id: string
  source_ref_key: string
  transformation_id: string | null
  transformation_version: number | null
  created_at: Date
  mapping_confidence: number
}

function rowToMapping(row: EntitySourceMappingRow): EntitySourceMapping {
  return {
    id: row.id,
    canonical_entity_id: row.canonical_entity_id,
    canonical_entity_type: row.canonical_entity_type as EntitySourceMapping['canonical_entity_type'],
    raw_envelope_id: row.raw_envelope_id,
    source_ref_key: row.source_ref_key,
    transformation_id: row.transformation_id ?? undefined,
    transformation_version: row.transformation_version ?? undefined,
    created_at: row.created_at.toISOString(),
    mapping_confidence: row.mapping_confidence,
  }
}

export interface EntitySourceMappingRepository {
  findById(id: string): Promise<EntitySourceMapping | null>
  findByCanonicalEntity(canonicalEntityId: string): Promise<EntitySourceMapping[]>
  findByRawEnvelope(rawEnvelopeId: string): Promise<EntitySourceMapping[]>
  findBySourceRefKey(sourceRefKey: string, transformationId?: string): Promise<EntitySourceMapping | null>
  create(input: EntitySourceMappingInput): Promise<EntitySourceMapping>
  createMany(inputs: EntitySourceMappingInput[]): Promise<EntitySourceMapping[]>
  delete(id: string): Promise<boolean>
  deleteByCanonicalEntity(canonicalEntityId: string): Promise<number>
}

export function createEntitySourceMappingRepository(
  ctx: RepositoryContext
): EntitySourceMappingRepository {
  const { sql } = ctx

  return {
    async findById(id) {
      const [row] = await sql<EntitySourceMappingRow[]>`
        SELECT * FROM entity_source_mappings WHERE id = ${id}
      `
      return row ? rowToMapping(row) : null
    },

    async findByCanonicalEntity(canonicalEntityId) {
      const rows = await sql<EntitySourceMappingRow[]>`
        SELECT * FROM entity_source_mappings
        WHERE canonical_entity_id = ${canonicalEntityId}
        ORDER BY created_at ASC
      `
      return rows.map(rowToMapping)
    },

    async findByRawEnvelope(rawEnvelopeId) {
      const rows = await sql<EntitySourceMappingRow[]>`
        SELECT * FROM entity_source_mappings
        WHERE raw_envelope_id = ${rawEnvelopeId}
        ORDER BY created_at ASC
      `
      return rows.map(rowToMapping)
    },

    async findBySourceRefKey(sourceRefKey, transformationId) {
      const [row] = await sql<EntitySourceMappingRow[]>`
        SELECT * FROM entity_source_mappings
        WHERE source_ref_key = ${sourceRefKey}
          ${transformationId ? sql`AND transformation_id = ${transformationId}` : sql``}
        ORDER BY created_at DESC
        LIMIT 1
      `
      return row ? rowToMapping(row) : null
    },

    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<EntitySourceMappingRow[]>`
        INSERT INTO entity_source_mappings (
          id, canonical_entity_id, canonical_entity_type, raw_envelope_id,
          source_ref_key, transformation_id, transformation_version, created_at, mapping_confidence
        ) VALUES (
          ${id},
          ${input.canonical_entity_id},
          ${input.canonical_entity_type},
          ${input.raw_envelope_id},
          ${input.source_ref_key},
          ${input.transformation_id ?? null},
          ${input.transformation_version ?? null},
          ${now},
          ${input.mapping_confidence ?? 1.0}
        )
        ON CONFLICT (source_ref_key, transformation_id) DO UPDATE
        SET canonical_entity_id = EXCLUDED.canonical_entity_id,
            canonical_entity_type = EXCLUDED.canonical_entity_type,
            raw_envelope_id = EXCLUDED.raw_envelope_id,
            mapping_confidence = EXCLUDED.mapping_confidence,
            transformation_id = EXCLUDED.transformation_id,
            transformation_version = EXCLUDED.transformation_version
        RETURNING *
      `

      return rowToMapping(row)
    },

    async createMany(inputs) {
      if (inputs.length === 0) return []

      const now = new Date()
      const values = inputs.map((input) => ({
        id: generateCanonicalId(),
        canonical_entity_id: input.canonical_entity_id,
        canonical_entity_type: input.canonical_entity_type,
        raw_envelope_id: input.raw_envelope_id,
        source_ref_key: input.source_ref_key,
        transformation_id: input.transformation_id ?? null,
        transformation_version: input.transformation_version ?? null,
        created_at: now,
        mapping_confidence: input.mapping_confidence ?? 1.0,
      }))

      const rows = await sql<EntitySourceMappingRow[]>`
        INSERT INTO entity_source_mappings ${sql(values)}
        ON CONFLICT (source_ref_key, transformation_id) DO UPDATE
        SET canonical_entity_id = EXCLUDED.canonical_entity_id,
            canonical_entity_type = EXCLUDED.canonical_entity_type,
            raw_envelope_id = EXCLUDED.raw_envelope_id,
            mapping_confidence = EXCLUDED.mapping_confidence,
            transformation_id = EXCLUDED.transformation_id,
            transformation_version = EXCLUDED.transformation_version
        RETURNING *
      `

      return rows.map(rowToMapping)
    },

    async delete(id) {
      const result = await sql`
        DELETE FROM entity_source_mappings WHERE id = ${id}
      `
      return result.count > 0
    },

    async deleteByCanonicalEntity(canonicalEntityId) {
      const result = await sql`
        DELETE FROM entity_source_mappings
        WHERE canonical_entity_id = ${canonicalEntityId}
      `
      return result.count
    },
  }
}
