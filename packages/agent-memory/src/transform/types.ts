/**
 * Transformation Layer Types
 */

import { z } from 'zod'
import type { ConnectorType } from '../ids.js'
import type { EntityType } from '../models/canonical.js'
import type { RawEnvelope } from '../models/raw.js'
import type { StoredEntity } from '../db/repositories/canonical-entity.js'

/**
 * Source selector for matching raw envelopes.
 */
export interface TransformSource {
  /** Connector type (e.g., 'gmail', 'github') */
  connector: ConnectorType
  /** Entity type from the connector (e.g., 'message', 'issue') */
  entityType: string
  /** Optional filter for conditional matching */
  filter?: (raw: unknown) => boolean
}

/**
 * Context provided to transform functions.
 */
export interface TransformContext {
  /** The raw envelope being transformed */
  envelope: RawEnvelope
  /** Account ID */
  accountId: string
  /** Connector type */
  connector: ConnectorType
  /** Lookup an existing entity by source reference key */
  lookupEntity: (sourceRefKey: string) => Promise<StoredEntity | null>
  /** Lookup entities by type */
  lookupEntitiesByType: (type: EntityType, limit?: number) => Promise<StoredEntity[]>
}

/**
 * Output from a transformation.
 */
export interface TransformOutput {
  /** Canonical entity type produced */
  entityType: EntityType
  /** Source reference key for deduplication */
  sourceRefKey: string
  /** The canonical entity data */
  data: Record<string, unknown>
  /** Optional display text for search/preview */
  displayText?: string
}

/**
 * Result of a single transformation execution.
 */
export interface TransformResult {
  /** Primary entity produced */
  primary: TransformOutput
  /** Related entities extracted (e.g., Person from Message.from) */
  related?: TransformOutput[]
  /** Warnings (logged but doesn't fail) */
  warnings?: string[]
}

/**
 * Error handling policy for transformations.
 */
export type TransformErrorPolicy = 'skip' | 'fail' | 'quarantine'

/**
 * A transformation definition.
 */
export interface Transformation<TInput = unknown> {
  /** Unique identifier */
  id: string

  /** Human-readable name */
  name: string

  /** What raw envelopes this applies to */
  source: TransformSource

  /** Input schema - validates raw_data before transform */
  inputSchema: z.ZodType<TInput>

  /** What canonical type(s) this produces */
  outputType: EntityType | EntityType[]

  /** The transformation function */
  transform: (input: TInput, ctx: TransformContext) => TransformResult | TransformResult[]

  /** Error handling policy */
  onError: TransformErrorPolicy

  /** Is this transformation active? */
  enabled: boolean

  /** Version number for schema evolution */
  version: number

  /** Optional description */
  description?: string
}

/**
 * Options for running transformations.
 */
export interface RunTransformOptions {
  /** Only process envelopes matching this source */
  source?: Partial<TransformSource>
  /** Maximum envelopes to process */
  limit?: number
  /** Only process envelopes created after this time */
  since?: Date
  /** Only process envelopes created before this time */
  until?: Date
  /** Specific envelope IDs to process */
  envelopeIds?: string[]
  /** Specific transformation IDs to run (default: all matching) */
  transformationIds?: string[]
  /** Continue on individual transform errors */
  continueOnError?: boolean
}

/**
 * Result of a transformation run.
 */
export interface TransformRunResult {
  /** Total envelopes processed */
  totalProcessed: number
  /** Successful transformations */
  succeeded: number
  /** Failed transformations */
  failed: number
  /** Skipped (no matching transformation) */
  skipped: number
  /** Quarantined (bad data) */
  quarantined: number
  /** Entities created */
  entitiesCreated: number
  /** Entities updated */
  entitiesUpdated: number
  /** Errors encountered */
  errors: Array<{
    envelopeId: string
    transformationId: string
    error: string
  }>
}

/**
 * Event emitted during transformation runs.
 */
export type TransformEvent =
  | { type: 'transform:started'; envelopeId: string; transformationId: string }
  | { type: 'transform:completed'; envelopeId: string; transformationId: string; entityIds: string[] }
  | { type: 'transform:failed'; envelopeId: string; transformationId: string; error: string }
  | { type: 'transform:skipped'; envelopeId: string; reason: string }
  | { type: 'transform:quarantined'; envelopeId: string; transformationId: string; error: string }
  | { type: 'run:started'; options: RunTransformOptions }
  | { type: 'run:completed'; result: TransformRunResult }
