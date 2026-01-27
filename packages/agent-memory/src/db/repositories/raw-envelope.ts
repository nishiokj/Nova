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
  findUnprocessedFiltered(
    filter: { connector?: ConnectorType; entityType?: string },
    options?: PaginationOptions
  ): Promise<PaginatedResult<RawEnvelope>>
  findErrored(options?: PaginationOptions): Promise<PaginatedResult<RawEnvelope>>
  findBySyncJob(syncJobId: string): Promise<RawEnvelope[]>
  create(input: RawEnvelopeInput): Promise<RawEnvelope>
  createMany(inputs: RawEnvelopeInput[]): Promise<RawEnvelope[]>
  markProcessed(id: string, error?: string): Promise<RawEnvelope | null>
  clearProcessed(
    filter: { connector?: ConnectorType; entityType?: string }
  ): Promise<number>
}

export function createRawEnvelopeRepository(ctx: RepositoryContext): RawEnvelopeRepository {
  const { sql } = ctx

  /** Max raw_data size we'll attempt to store (256 MB, the PostgreSQL JSONB string limit) */
  const MAX_RAW_DATA_BYTES = 256 * 1024 * 1024

  const envelopeContext = (input: RawEnvelopeInput, index?: number): string => {
    const prefix = index === undefined ? 'RawEnvelopeInput' : `RawEnvelopeInput[${index}]`
    return `${prefix} connector=${input.connector} account_id=${input.account_id} entity_type=${input.entity_type} source_id=${input.source_id}`
  }

  const isOversizedJsonbError = (e: unknown): boolean =>
    e instanceof Error && (
      e.message.includes('string too long to represent as json') || // covers both 'json string' and 'jsonb string'
      e.message.includes('invalid input syntax for type json') ||
      e.message.includes('Invalid string length') // V8 limit
    )

  const assertEnvelopeInput = (input: RawEnvelopeInput, index?: number): void => {
    const missing: string[] = []
    if (input.idempotency_key == null) missing.push('idempotency_key')
    if (input.connector == null) missing.push('connector')
    if (input.account_id == null) missing.push('account_id')
    if (input.entity_type == null) missing.push('entity_type')
    if (input.source_id == null) missing.push('source_id')
    if (input.raw_data_hash == null) missing.push('raw_data_hash')
    if (input.sync_job_id == null) missing.push('sync_job_id')
    if (input.collection_method == null) missing.push('collection_method')
    if (input.raw_data === undefined) missing.push('raw_data')

    if (input.raw_data !== undefined) {
      try {
        const rawJson = JSON.stringify(input.raw_data)
        if (rawJson === undefined) {
          missing.push('raw_data_serializable')
        } else {
          const rawBytes = Buffer.byteLength(rawJson, 'utf8')
          if (rawBytes > MAX_RAW_DATA_BYTES) {
            throw new Error(`${envelopeContext(input, index)} raw_data too large for jsonb: ${rawBytes} bytes`)
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('raw_data too large')) throw e
        if (isOversizedJsonbError(e)) {
          throw new Error(`${envelopeContext(input, index)} raw_data contains oversized string`)
        }
        missing.push('raw_data_serializable')
      }
    }

    if (missing.length > 0) {
      const prefix = index === undefined ? 'RawEnvelopeInput' : `RawEnvelopeInput[${index}]`
      throw new Error(`${prefix} missing required fields: ${missing.join(', ')}`)
    }
  }

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

    async findUnprocessedFiltered(filter, options = {}) {
      const { limit = 100, offset = 0 } = options
      const { connector, entityType } = filter

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM raw_envelopes
        WHERE processed_at IS NULL
          ${connector ? sql`AND connector = ${connector}` : sql``}
          ${entityType ? sql`AND entity_type = ${entityType}` : sql``}
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<RawEnvelopeRow[]>`
        SELECT * FROM raw_envelopes
        WHERE processed_at IS NULL
          ${connector ? sql`AND connector = ${connector}` : sql``}
          ${entityType ? sql`AND entity_type = ${entityType}` : sql``}
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

    async findErrored(options = {}) {
      const { limit = 100, offset = 0 } = options

      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM raw_envelopes WHERE processing_error IS NOT NULL
      `
      const total = parseInt(countResult.count, 10)

      const rows = await sql<RawEnvelopeRow[]>`
        SELECT * FROM raw_envelopes
        WHERE processing_error IS NOT NULL
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
      assertEnvelopeInput(input)

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
          ${sql.json(input.raw_data as Parameters<typeof sql.json>[0])},
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

      // Validate all inputs before building the insert — skip invalid ones
      const validInputs: RawEnvelopeInput[] = []
      for (let i = 0; i < inputs.length; i++) {
        try {
          assertEnvelopeInput(inputs[i], i)
          validInputs.push(inputs[i])
        } catch (e) {
          console.error('[RawEnvelopeRepo] Dropping invalid envelope:', {
            index: i,
            source_id: inputs[i]?.source_id,
            entity_type: inputs[i]?.entity_type,
            connector: inputs[i]?.connector,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }

      if (validInputs.length === 0) return []

      const buildValues = (subset: RawEnvelopeInput[]) =>
        subset.map((input) => ({
          id: generateCanonicalId(),
          idempotency_key: input.idempotency_key,
          connector: input.connector,
          account_id: input.account_id,
          entity_type: input.entity_type,
          source_id: input.source_id,
          source_version: input.source_version ?? null,
          raw_data: sql.json(input.raw_data as Parameters<typeof sql.json>[0]),
          raw_data_hash: input.raw_data_hash,
          source_timestamp: input.source_timestamp ? new Date(input.source_timestamp) : null,
          received_at: now,
          sync_job_id: input.sync_job_id,
          collection_method: input.collection_method,
        }))

      // Try batch insert first
      try {
        const rows = await sql<RawEnvelopeRow[]>`
          INSERT INTO raw_envelopes ${sql(buildValues(validInputs))}
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING *
        `
        return rows.map(rowToEnvelope)
      } catch (batchError) {
        // Batch failed — fall back to individual inserts so one bad item
        // doesn't kill the entire batch.
        console.error('[RawEnvelopeRepo] Batch insert failed, falling back to individual inserts:', {
          batchSize: validInputs.length,
          error: batchError instanceof Error ? batchError.message : String(batchError),
        })

        const results: RawEnvelope[] = []
        for (const input of validInputs) {
          try {
            const id = generateCanonicalId()
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
                ${sql.json(input.raw_data as Parameters<typeof sql.json>[0])},
                ${input.raw_data_hash},
                ${input.source_timestamp ? new Date(input.source_timestamp) : null},
                ${now},
                ${input.sync_job_id},
                ${input.collection_method}
              )
              ON CONFLICT (idempotency_key) DO UPDATE SET id = raw_envelopes.id
              RETURNING *
            `
            if (row) results.push(rowToEnvelope(row))
          } catch (itemError) {
            console.error('[RawEnvelopeRepo] Skipping oversized/invalid envelope:', {
              source_id: input.source_id,
              entity_type: input.entity_type,
              connector: input.connector,
              account_id: input.account_id,
              raw_data_bytes: (() => { try { return Buffer.byteLength(JSON.stringify(input.raw_data), 'utf8') } catch { return 'unserializable' } })(),
              error: itemError instanceof Error ? itemError.message : String(itemError),
            })
          }
        }
        return results
      }
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

    async clearProcessed(filter) {
      const { connector, entityType } = filter
      const result = await sql`
        UPDATE raw_envelopes
        SET processed_at = NULL,
            processing_error = NULL
        WHERE 1=1
          ${connector ? sql`AND connector = ${connector}` : sql``}
          ${entityType ? sql`AND entity_type = ${entityType}` : sql``}
      `
      return result.count
    },
  }
}
