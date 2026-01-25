/**
 * Processor - Process Phase
 *
 * Handles transforming RawEnvelopes into canonical entities.
 * Pipeline: Validate → Normalize → Upsert → Entity Resolution
 *
 * Design principles:
 * - Idempotent: reprocessing the same envelope produces the same result
 * - Atomic: each envelope is processed in its own transaction
 * - Fail fast: validation errors are caught early
 * - Traceable: full lineage from canonical entity to raw source
 */

import type { Sql } from 'postgres'
import type { RawEnvelope } from '../models/raw.js'
import type { CanonicalEntity, EntityType } from '../models/canonical.js'
import type { ConnectorType, SourceRef } from '../ids.js'
import { sourceRefToKey, generateCanonicalId } from '../ids.js'
import type { RawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import type { CanonicalEntityRepository, StoredEntity } from '../db/repositories/canonical-entity.js'
import type { EntitySourceMappingRepository } from '../db/repositories/entity-source-mapping.js'
import type { SyncJobRepository } from '../db/repositories/sync-job.js'
import { createRawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import { createCanonicalEntityRepository } from '../db/repositories/canonical-entity.js'
import { createEntitySourceMappingRepository } from '../db/repositories/entity-source-mapping.js'
import { createSyncJobRepository } from '../db/repositories/sync-job.js'
import type {
  MappedEntity,
  ProcessResult,
  BatchProcessResult,
  SyncEvent,
} from './types.js'
import type { Connector } from '../connector/sdk/types.js'
import { ProcessError, ValidationError } from './types.js'
import { TransformationRegistry } from '../transform/registry.js'
import type { Transformation, TransformContext, TransformOutput } from '../transform/types.js'

// ============ Configuration ============

export interface ProcessorConfig {
  /** Batch size for processing envelopes (default: 50) */
  batchSize?: number
  /** Whether to continue on individual envelope errors (default: true) */
  continueOnError?: boolean
  /** Maximum concurrent entity resolution operations (default: 10) */
  resolutionConcurrency?: number
  /** Transformation registry for processing envelopes */
  transformRegistry?: TransformationRegistry
}

const DEFAULT_CONFIG = {
  batchSize: 50,
  continueOnError: true,
  resolutionConcurrency: 10,
}

// ============ Processor ============

/**
 * Processor handles the process phase of the sync pipeline.
 * Transforms RawEnvelopes into canonical entities.
 */
export class Processor {
  private sql: Sql
  private config: typeof DEFAULT_CONFIG
  private envelopeRepo: RawEnvelopeRepository
  private entityRepo: CanonicalEntityRepository
  private mappingRepo: EntitySourceMappingRepository
  private syncJobRepo: SyncJobRepository
  private connectors: Map<ConnectorType, Connector> = new Map()
  private transformRegistry: TransformationRegistry
  private eventHandler?: (event: SyncEvent) => void

  constructor(sql: Sql, config: ProcessorConfig = {}) {
    this.sql = sql
    const { transformRegistry, ...rest } = config
    this.config = { ...DEFAULT_CONFIG, ...rest }
    this.transformRegistry = transformRegistry ?? new TransformationRegistry()
    this.envelopeRepo = createRawEnvelopeRepository({ sql })
    this.entityRepo = createCanonicalEntityRepository({ sql })
    this.mappingRepo = createEntitySourceMappingRepository({ sql })
    this.syncJobRepo = createSyncJobRepository({ sql })
  }

  /**
   * Register a transformation.
   */
  registerTransform<T>(transform: Transformation<T>): this {
    this.transformRegistry.register(transform)
    return this
  }

  /**
   * Register a connector for entity mapping.
   */
  registerConnector(connector: Connector): this {
    this.connectors.set(connector.type, connector)
    return this
  }

  /**
   * Set an event handler for sync events.
   */
  onEvent(handler: (event: SyncEvent) => void): this {
    this.eventHandler = handler
    return this
  }

  /**
   * Process all unprocessed envelopes.
   */
  async processAll(): Promise<BatchProcessResult> {
    const results: ProcessResult[] = []
    let offset = 0

    while (true) {
      const batch = await this.envelopeRepo.findUnprocessed({
        limit: this.config.batchSize,
        offset: 0, // Always 0 because we mark processed
      })

      if (batch.items.length === 0) break

      for (const envelope of batch.items) {
        const result = await this.processOne(envelope)
        results.push(result)

        if (!result.success && !this.config.continueOnError) {
          return this.aggregateResults(results)
        }
      }

      offset += batch.items.length

      if (!batch.hasMore) break
    }

    return this.aggregateResults(results)
  }

  /**
   * Process envelopes from a specific sync job.
   */
  async processSyncJob(syncJobId: string): Promise<BatchProcessResult> {
    const results: ProcessResult[] = []
    const envelopes = await this.envelopeRepo.findBySyncJob(syncJobId)

    for (const envelope of envelopes) {
      // Skip already processed
      if (envelope.processed_at) continue

      const result = await this.processOne(envelope)
      results.push(result)

      // Update job progress
      await this.syncJobRepo.updateProgress(syncJobId, {
        processed: 1,
        failed: result.success ? 0 : 1,
      })

      if (!result.success && !this.config.continueOnError) {
        break
      }
    }

    return this.aggregateResults(results)
  }

  /**
   * Process a single envelope by ID.
   */
  async processById(envelopeId: string): Promise<ProcessResult> {
    const envelope = await this.envelopeRepo.findById(envelopeId)
    if (!envelope) {
      return {
        success: false,
        envelopeId,
        entityIds: [],
        mappings: [],
        error: `Envelope not found: ${envelopeId}`,
      }
    }

    return this.processOne(envelope)
  }

  /**
   * Reprocess all envelopes from a sync job (replay).
   * Clears processed_at before reprocessing.
   */
  async reprocessSyncJob(syncJobId: string): Promise<BatchProcessResult> {
    const envelopes = await this.envelopeRepo.findBySyncJob(syncJobId)

    // Clear processed state
    for (const envelope of envelopes) {
      await this.sql`
        UPDATE raw_envelopes
        SET processed_at = NULL, processing_error = NULL
        WHERE id = ${envelope.id}
      `
    }

    return this.processSyncJob(syncJobId)
  }

  // ============ Internal Processing ============

  private async processOne(envelope: RawEnvelope): Promise<ProcessResult> {
    const result: ProcessResult = {
      success: false,
      envelopeId: envelope.id,
      entityIds: [],
      mappings: [],
    }

    try {
      // Find matching transformations for this envelope
      const transforms = this.transformRegistry.findBySource(
        envelope.connector,
        envelope.entity_type
      )

      if (transforms.length === 0) {
        throw new ProcessError(
          `No transformation registered for: ${envelope.connector}:${envelope.entity_type}`
        )
      }

      // Use the first matching transform (could support multiple in future)
      const transform = transforms[0]

      // 1. Validate source data against transform's input schema
      const parseResult = transform.inputSchema.safeParse(envelope.raw_data)
      if (!parseResult.success) {
        throw new ValidationError(
          `Validation failed for ${envelope.entity_type}: ${parseResult.error.message}`,
          parseResult.error,
          { envelopeId: envelope.id }
        )
      }

      // 2. Build transform context
      const ctx: TransformContext = {
        envelope,
        accountId: envelope.account_id,
        connector: envelope.connector,
        lookupEntity: async (sourceRefKey) => this.mappingRepo.findBySourceRefKey(sourceRefKey)
          .then(m => m ? this.entityRepo.findById(m.canonical_entity_id) : null),
        lookupEntitiesByType: async (type, limit) =>
          this.entityRepo.findByType(type, { limit }).then(r => r.items),
      }

      // 3. Execute transformation
      const transformResults = transform.transform(parseResult.data, ctx)
      const resultsArray = Array.isArray(transformResults) ? transformResults : [transformResults]

      // 4. Process all outputs (primary + related)
      for (const transformResult of resultsArray) {
        const outputs: TransformOutput[] = [transformResult.primary]
        if (transformResult.related) {
          outputs.push(...transformResult.related)
        }

        for (const output of outputs) {
          const mapped: MappedEntity = {
            entityType: output.entityType,
            data: output.data as MappedEntity['data'],
            displayText: output.displayText,
            sourceRefKey: output.sourceRefKey,
          }

          const { entity, isNew } = await this.upsertEntity(mapped, envelope)

          result.entityIds.push(entity.id)
          result.mappings.push({
            canonical_entity_id: entity.id,
            canonical_entity_type: output.entityType,
            raw_envelope_id: envelope.id,
            source_ref_key: output.sourceRefKey,
            mapping_confidence: 1.0,
          })

          this.emit({
            type: 'process:entity',
            entityId: entity.id,
            entityType: output.entityType,
          })
        }
      }

      // 5. Mark envelope as processed
      await this.envelopeRepo.markProcessed(envelope.id)

      result.success = true
      this.emit({ type: 'process:envelope', envelopeId: envelope.id, success: true })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      result.error = errorMessage

      // Mark as processed with error
      await this.envelopeRepo.markProcessed(envelope.id, errorMessage)

      this.emit({ type: 'process:envelope', envelopeId: envelope.id, success: false })
    }

    return result
  }

  private async upsertEntity(
    mapped: MappedEntity,
    envelope: RawEnvelope
  ): Promise<{ entity: StoredEntity; isNew: boolean }> {
    // Check if entity already exists for this source ref
    const existingMapping = await this.mappingRepo.findBySourceRefKey(mapped.sourceRefKey)

    if (existingMapping) {
      // Update existing entity
      const updated = await this.entityRepo.update(
        existingMapping.canonical_entity_id,
        mapped.data,
        mapped.displayText
      )

      if (updated) {
        // Update the mapping with new envelope reference
        await this.mappingRepo.create({
          canonical_entity_id: updated.id,
          canonical_entity_type: mapped.entityType,
          raw_envelope_id: envelope.id,
          source_ref_key: mapped.sourceRefKey,
          mapping_confidence: 1.0,
        })

        return { entity: updated, isNew: false }
      }
    }

    // Create new entity
    const created = await this.entityRepo.create(
      mapped.entityType,
      mapped.data,
      mapped.displayText
    )

    // Create the source mapping
    await this.mappingRepo.create({
      canonical_entity_id: created.id,
      canonical_entity_type: mapped.entityType,
      raw_envelope_id: envelope.id,
      source_ref_key: mapped.sourceRefKey,
      mapping_confidence: 1.0,
    })

    return { entity: created, isNew: true }
  }

  private aggregateResults(results: ProcessResult[]): BatchProcessResult {
    return {
      total: results.length,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    }
  }

  private emit(event: SyncEvent): void {
    if (this.eventHandler) {
      try {
        this.eventHandler(event)
      } catch {
        // Ignore event handler errors
      }
    }
  }
}

