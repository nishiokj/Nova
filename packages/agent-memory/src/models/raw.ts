/**
 * Raw Envelope & Lineage
 *
 * Immutable capture of all source data for auditability and replay.
 * Every piece of data from external systems is first stored as a RawEnvelope
 * before being normalized into canonical entities.
 *
 * Design principles:
 * - Raw data is immutable and append-only
 * - Full lineage from canonical entity back to source
 * - Idempotency keys prevent duplicate processing
 */

import { z } from 'zod'
import { UlidSchema, ConnectorTypeSchema } from '../ids.js'

// ============ Collection Method ============

export const CollectionMethodSchema = z.enum(['backfill', 'incremental', 'webhook', 'manual'])
export type CollectionMethod = z.infer<typeof CollectionMethodSchema>

// ============ Raw Envelope ============

/**
 * RawEnvelope: Immutable capture of source data.
 *
 * Every piece of data fetched from external systems is wrapped in a RawEnvelope
 * before any processing. This provides:
 * - Complete audit trail
 * - Ability to replay/reprocess data
 * - Debugging failed normalization
 */
export const RawEnvelopeSchema = z.object({
  /** Unique ID for this envelope */
  id: UlidSchema,

  /** Deduplication key - sha256(connector + account_id + source_id + raw_data_hash) */
  idempotency_key: z.string().min(1),

  /** Source connector type */
  connector: ConnectorTypeSchema,

  /** Account within the connector */
  account_id: z.string().min(1),

  /** Entity type as understood by the connector (e.g., 'issue', 'message', 'tweet') */
  entity_type: z.string().min(1),

  /** ID from the source system */
  source_id: z.string().min(1),

  /** Optional version/ETag for change detection */
  source_version: z.string().optional(),

  /** The raw data exactly as received from source */
  raw_data: z.unknown(),

  /** SHA-256 hash of the raw data for integrity checking */
  raw_data_hash: z.string().min(1),

  /** Timestamp from the source system (e.g., created_at, updated_at) */
  source_timestamp: z.string().datetime().optional(),

  /** When we received this data */
  received_at: z.string().datetime(),

  /** When this was processed into canonical entities (null = not yet processed) */
  processed_at: z.string().datetime().optional(),

  /** Error message if processing failed */
  processing_error: z.string().optional(),

  /** ID of the sync job that fetched this data */
  sync_job_id: UlidSchema,

  /** How this data was collected */
  collection_method: CollectionMethodSchema,
})

export type RawEnvelope = z.infer<typeof RawEnvelopeSchema>

// ============ Entity Source Mapping ============

/**
 * EntitySourceMapping: Tracks lineage between canonical entities and raw data.
 *
 * A canonical entity may be derived from one or more raw envelopes.
 * This mapping enables:
 * - Tracing a canonical entity back to its source(s)
 * - Finding all canonical entities affected by a raw envelope
 * - Confidence scoring for derived data
 */
export const EntitySourceMappingSchema = z.object({
  /** Unique ID for this mapping */
  id: UlidSchema,

  /** The canonical entity this maps to */
  canonical_entity_id: UlidSchema,

  /** Type of the canonical entity */
  canonical_entity_type: z.string().min(1),

  /** The raw envelope this entity was derived from */
  raw_envelope_id: UlidSchema,

  /** Source reference key: connector:account_id:entity_type:source_id */
  source_ref_key: z.string().min(1),

  /** When this mapping was created */
  created_at: z.string().datetime(),

  /** Confidence in this mapping (1.0 = exact match, lower = inferred) */
  mapping_confidence: z.number().min(0).max(1).default(1.0),
})

export type EntitySourceMapping = z.infer<typeof EntitySourceMappingSchema>

// ============ Helper Types ============

/**
 * Input type for creating a new RawEnvelope.
 * Excludes auto-generated fields.
 */
export type RawEnvelopeInput = Omit<RawEnvelope, 'id' | 'received_at' | 'processed_at' | 'processing_error'>

/**
 * Input type for creating an EntitySourceMapping.
 * Excludes auto-generated fields.
 */
export type EntitySourceMappingInput = Omit<EntitySourceMapping, 'id' | 'created_at'>
