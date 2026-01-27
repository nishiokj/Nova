/**
 * Sync Engine Types
 *
 * Types and interfaces for the two-phase sync pipeline:
 * - Collect Phase: Fetch data from external sources → RawEnvelope
 * - Process Phase: Validate → Normalize → Upsert → Entity Resolution
 */

import type { z } from 'zod'
import type { ConnectorType, SourceRef } from '../ids.js'
import type { RawEnvelope, CollectionMethod, EntitySourceMappingInput } from '../models/raw.js'
import type { CanonicalEntity, EntityType } from '../models/canonical.js'
import type { SyncJob, SyncJobType } from '../db/repositories/sync-job.js'
// ============ Source Item ============

/**
 * A raw item fetched from an external source.
 * Connectors produce these, and the collector wraps them in RawEnvelopes.
 */
export interface SourceItem<T = unknown> {
  /** ID from the source system */
  source_id: string
  /** Entity type within the connector (e.g., 'issue', 'message') */
  entity_type: string
  /** Raw data from the source */
  raw_data: T
  /** Timestamp from the source (e.g., created_at, updated_at) */
  source_timestamp?: string
  /** Optional version for change detection */
  source_version?: string
}

// ============ Fetch Results ============

/**
 * Result of a page fetch from a connector.
 */
export interface FetchPageResult<T = unknown> {
  /** Items returned in this page */
  items: SourceItem<T>[]
  /** Cursor for the next page, or undefined if no more pages */
  nextCursor?: string
  /** Whether there are more pages */
  hasMore: boolean
  /** Rate limit info from the source */
  rateLimit?: RateLimitInfo
}

/**
 * Rate limit information from an external API.
 */
export interface RateLimitInfo {
  /** Remaining requests in the current window */
  remaining: number
  /** Total requests allowed in the window */
  limit: number
  /** When the rate limit resets (Unix timestamp) */
  resetsAt: number
}

// ============ Sync Run ============

/**
 * A sync run represents a single execution of syncing data from a connector.
 * Multiple sync jobs can be part of a single conceptual "sync run".
 */
export interface SyncRun {
  /** The sync job tracking this run */
  job: SyncJob
  /** Connector type */
  connector: ConnectorType
  /** Account ID within the connector */
  accountId: string
  /** Type of sync */
  type: SyncJobType
  /** Starting cursor (for incremental syncs) */
  startCursor?: string
}

// ============ Fetch Options ============

/**
 * Options for fetching a page of data.
 */
export interface FetchPageOptions {
  /** Cursor for pagination */
  cursor?: string
  /** Maximum items to fetch */
  limit?: number
  /** Entity types to fetch (if not specified, fetch all) */
  entityTypes?: string[]
}

/**
 * Options for fetching changes since last sync.
 */
export interface FetchChangesOptions extends FetchPageOptions {
  /** Cursor from the last sync (e.g., timestamp, ID, historyId) */
  since?: string
}

// ============ Entity Mapping ============

/**
 * Result of mapping a source item to a canonical entity.
 */
export interface MappedEntity {
  /** The canonical entity type */
  entityType: EntityType
  /** The canonical entity data */
  data: CanonicalEntity
  /** Display text for search indexing */
  displayText?: string
  /** Related entities that should also be created/updated */
  relatedEntities?: MappedEntity[]
  /** Source ref key for this entity */
  sourceRefKey: string
  /** Transformation ID used to create this mapping */
  transformationId?: string
  /** Transformation version used to create this mapping */
  transformationVersion?: number
}

/**
 * Entity mapper - transforms raw source data into canonical entities.
 */
export interface EntityMapper<TSource = unknown> {
  /** Source entity type this mapper handles */
  sourceEntityType: string
  /** Target canonical entity type */
  targetEntityType: EntityType
  /** Zod schema for validating source data */
  sourceSchema: z.ZodSchema<TSource>
  /**
   * Map source data to a canonical entity.
   * May return multiple entities (e.g., an issue with comments).
   */
  map(source: TSource, context: MapperContext): MappedEntity | MappedEntity[]
}

/**
 * Context provided to entity mappers.
 */
export interface MapperContext {
  /** Source reference for the raw data */
  sourceRef: SourceRef
  /** The raw envelope containing this data */
  envelope: RawEnvelope
  /** Account ID */
  accountId: string
  /** Connector type */
  connector: ConnectorType
}

// ============ Processing ============

/**
 * Result of processing a single raw envelope.
 */
export interface ProcessResult {
  /** Whether processing succeeded */
  success: boolean
  /** ID of the raw envelope */
  envelopeId: string
  /** IDs of canonical entities created/updated */
  entityIds: string[]
  /** Source mappings created */
  mappings: EntitySourceMappingInput[]
  /** Error message if processing failed */
  error?: string
}

/**
 * Batch processing result.
 */
export interface BatchProcessResult {
  /** Total envelopes processed */
  total: number
  /** Successfully processed */
  succeeded: number
  /** Failed to process */
  failed: number
  /** Individual results */
  results: ProcessResult[]
}

// ============ Sync Events ============

/**
 * Events emitted during sync operations.
 * Can be used for logging, metrics, or progress tracking.
 */
export type SyncEvent =
  | { type: 'sync:started'; job: SyncJob }
  | { type: 'sync:progress'; job: SyncJob; fetched: number; processed: number }
  | { type: 'sync:completed'; job: SyncJob; stats: SyncStats }
  | { type: 'sync:failed'; job: SyncJob; error: Error }
  | { type: 'collect:page'; job: SyncJob; items: number; cursor?: string }
  | { type: 'collect:rate_limited'; job: SyncJob; retryAfter: number }
  | { type: 'process:envelope'; envelopeId: string; success: boolean }
  | { type: 'process:entity'; entityId: string; entityType: EntityType }

/**
 * Statistics from a completed sync.
 */
export interface SyncStats {
  /** Total items fetched from source */
  itemsFetched: number
  /** Envelopes created (may be less than fetched due to dedup) */
  envelopesCreated: number
  /** Envelopes processed */
  envelopesProcessed: number
  /** Entities created */
  entitiesCreated: number
  /** Entities updated */
  entitiesUpdated: number
  /** Processing errors */
  errors: number
  /** Duration in milliseconds */
  durationMs: number
}

// ============ Error Types ============

/**
 * Base class for sync errors.
 */
export class SyncError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean = false,
    public readonly metadata: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

/**
 * Error during data collection phase.
 */
export class CollectError extends SyncError {
  constructor(message: string, retryable = true, metadata: Record<string, unknown> = {}) {
    super(message, 'COLLECT_ERROR', retryable, metadata)
    this.name = 'CollectError'
  }
}

/**
 * Error during data processing phase.
 */
export class ProcessError extends SyncError {
  constructor(message: string, retryable = false, metadata: Record<string, unknown> = {}) {
    super(message, 'PROCESS_ERROR', retryable, metadata)
    this.name = 'ProcessError'
  }
}

/**
 * Error when source data validation fails.
 */
export class ValidationError extends SyncError {
  constructor(
    message: string,
    public readonly zodError?: z.ZodError,
    metadata: Record<string, unknown> = {}
  ) {
    super(message, 'VALIDATION_ERROR', false, metadata)
    this.name = 'ValidationError'
  }
}

/**
 * Rate limit exceeded error.
 */
export class RateLimitError extends SyncError {
  constructor(
    message: string,
    public readonly retryAfter: number,
    metadata: Record<string, unknown> = {}
  ) {
    super(message, 'RATE_LIMIT_ERROR', true, { ...metadata, retryAfter })
    this.name = 'RateLimitError'
  }
}
