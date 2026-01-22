/**
 * Raw Envelope Repository
 *
 * CRUD operations for raw_envelopes table.
 */

import type { RawEnvelope, RawEnvelopeInput } from '../../models/raw.js'
import type { ConnectorType } from '../../ids.js'
import { generateCanonicalId } from '../../ids.js'
import type { RepositoryContext, PaginationOptions, PaginatedResult } from './types.js'

export interface RawEnvelopeRow {
  id: string
  idempotency_key: string
  connector: string
  account_id: string
  entity_type: string
  source_id: string
  source_version: string | null
  raw_data: unknown
  raw_data_hash: string
  source_timestamp: Date | null
  received_at: Date
  processed_at: Date | null
  processing_error: string | null
  sync_job_id: string
  collection_method: string
}

function rowToEnvelope(row: RawEnvelopeRow): RawEnvelope {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    connector: row.connector as ConnectorType,
    account_id: row.account_id,
    entity_type: row.entity_type,
    source_id: row.source_id,
    source_version: row.source_version ?? undefined,
    raw_data: row.raw_data,
    raw_data_hash: row.raw_data_hash,
    source_timestamp: row.source_timestamp?.toISOString(),
    received_at: row.received_at.toISOString(),
    processed_at: row.processed_at?.toISOString(),
    processing_error: row.processing_error ?? undefined,
    sync_job_id: row.sync_job_id,
    collection_method: row.collection_method as RawEnvelope['collection_method'],
  }
}

export interface RawEnvelopeRepository {
  findById(id: string): Promise<RawEnvelope | null>
  findByIdempotencyKey(key: string): Promise<RawEnvelope | null>
  findBySourceRef(
    connector: ConnectorType,
    accountId: string,
    entityType: string,
    sourceId: string
  ): Promise<RawEnvelope | null>
  findUnprocessed(options?: PaginationOptions): Promise<PaginatedResult<RawEnvelope>>
  findBySyncJob(syncJobId: string): Promise<RawEnvelope[]>
  create(input: RawEnvelopeInput): Promise<RawEnvelope>
  createMany(inputs: RawEnvelopeInput[]): Promise<RawEnvelope[]>
  markProcessed(id: string, error?: string): Promise<RawEnvelope | null>
}

export function createRawEnvelopeRepository(ctx: RepositoryContext): RawEnvelopeRepository {
  const { sql } = ctx

  return {
    async findById(id) {
      const [row] = await sql<RawEnvelopeRow[]>`
        SELECT * FROM raw_envelopes WHERE id = ${id}
      `
      return row ? rowToEnvelope(row) : null
    },

    async findByIdempotencyKey(key) {
      const [row] = await sql<RawEnvelopeRow[]>`
        SELECT * FROM raw_envelopes WHERE idempotency_key = ${key}
      `
      return row ? rowToEnvelope(row) : null
    },

    async findBySourceRef(connector, accountId, entityType, sourceId) {
      const [row] = await sql<RawEnvelopeRow[]>`
        SELECT * FROM raw_envelopes
        WHERE connector = ${connector}
          AND account_id = ${accountId}
          AND entity_type = ${entityType}
          AND source_id = ${sourceId}
        ORDER BY received_at DESC
        LIMIT 1
      `
      return row ? rowToEnvelope(row) : null
    },

    async findUnprocessed(options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM raw_envelopes WHERE processed_at IS NULL
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<RawEnvelopeRow[]>`
        SELECT * FROM raw_envelopes
        WHERE processed_at IS NULL
        ORDER BY received_at ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `

      return {
        items: rows.map(rowToEnvelope),
        total,
        hasMore: offset + rows.length < total,
      }
    },

    async findBySyncJob(syncJobId) {
      const rows = await sql<RawEnvelopeRow[]>`
        SELECT * FROM raw_envelopes
        WHERE sync_job_id = ${syncJobId}
        ORDER BY received_at ASC
      `
      return rows.map(rowToEnvelope)
    },

    async create(input) {
      const id = generateCanonicalId()
      const now = new Date()

      const [row] = await sql<RawEnvelopeRow[]>`
        INSERT INTO raw_envelopes (
          id, idempotency_key, connector, account_id, entity_type, source_id,
          source_version, raw_data, raw_data_hash, source_timestamp,
          received_at, sync_job_id, collection_method
        ) VALUES (
          ${id},
          ${input.idempotency_key},
          ${input.connector},
          ${input.account_id},
          ${input.entity_type},
          ${input.source_id},
          ${input.source_version ?? null},
          ${JSON.stringify(input.raw_data)}::jsonb,
          ${input.raw_data_hash},
          ${input.source_timestamp ? new Date(input.source_timestamp) : null},
          ${now},
          ${input.sync_job_id},
          ${input.collection_method}
        )
        ON CONFLICT (idempotency_key) DO UPDATE SET id = raw_envelopes.id
        RETURNING *
      `

      return rowToEnvelope(row)
    },

    async createMany(inputs) {
      if (inputs.length === 0) return []

      const now = new Date()
      const values = inputs.map((input) => ({
        id: generateCanonicalId(),
        idempotency_key: input.idempotency_key,
        connector: input.connector,
        account_id: input.account_id,
        entity_type: input.entity_type,
        source_id: input.source_id,
        source_version: input.source_version ?? null,
        raw_data: JSON.stringify(input.raw_data),
        raw_data_hash: input.raw_data_hash,
        source_timestamp: input.source_timestamp ? new Date(input.source_timestamp) : null,
        received_at: now,
        sync_job_id: input.sync_job_id,
        collection_method: input.collection_method,
      }))

      const rows = await sql<RawEnvelopeRow[]>`
        INSERT INTO raw_envelopes ${sql(values)}
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `

      return rows.map(rowToEnvelope)
    },

    async markProcessed(id, error) {
      const now = new Date()

      const [row] = await sql<RawEnvelopeRow[]>`
        UPDATE raw_envelopes
        SET processed_at = ${now},
            processing_error = ${error ?? null}
        WHERE id = ${id}
        RETURNING *
      `

      return row ? rowToEnvelope(row) : null
    },
  }
}
