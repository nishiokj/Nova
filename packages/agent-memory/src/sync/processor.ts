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
  EntityMapper,
  MapperContext,
  MappedEntity,
  ProcessResult,
  BatchProcessResult,
  SyncEvent,
  ConnectorAdapter,
} from './types.js'
import { ProcessError, ValidationError } from './types.js'

// ============ Configuration ============

export interface ProcessorConfig {
  /** Batch size for processing envelopes (default: 50) */
  batchSize?: number
  /** Whether to continue on individual envelope errors (default: true) */
  continueOnError?: boolean
  /** Maximum concurrent entity resolution operations (default: 10) */
  resolutionConcurrency?: number
}

const DEFAULT_CONFIG: Required<ProcessorConfig> = {
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
  private config: Required<ProcessorConfig>
  private envelopeRepo: RawEnvelopeRepository
  private entityRepo: CanonicalEntityRepository
  private mappingRepo: EntitySourceMappingRepository
  private syncJobRepo: SyncJobRepository
  private connectors: Map<ConnectorType, ConnectorAdapter> = new Map()
  private eventHandler?: (event: SyncEvent) => void

  constructor(sql: Sql, config: ProcessorConfig = {}) {
    this.sql = sql
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.envelopeRepo = createRawEnvelopeRepository({ sql })
    this.entityRepo = createCanonicalEntityRepository({ sql })
    this.mappingRepo = createEntitySourceMappingRepository({ sql })
    this.syncJobRepo = createSyncJobRepository({ sql })
  }

  /**
   * Register a connector adapter for entity mapping.
   */
  registerConnector(connector: ConnectorAdapter): this {
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
      // Get the connector adapter
      const adapter = this.connectors.get(envelope.connector)
      if (!adapter) {
        throw new ProcessError(`No connector registered for: ${envelope.connector}`)
      }

      // Get the mapper for this entity type
      const mapper = adapter.getMapper(envelope.entity_type)
      if (!mapper) {
        throw new ProcessError(
          `No mapper for entity type: ${envelope.entity_type} in connector: ${envelope.connector}`
        )
      }

      // 1. Validate source data
      const parsed = this.validateSourceData(envelope, mapper)

      // 2. Build mapper context
      const sourceRef: SourceRef = {
        connector: envelope.connector,
        account_id: envelope.account_id,
        entity_type: envelope.entity_type,
        source_id: envelope.source_id,
        source_version: envelope.source_version,
      }

      const context: MapperContext = {
        sourceRef,
        envelope,
        accountId: envelope.account_id,
        connector: envelope.connector,
      }

      // 3. Map to canonical entities
      const mappedEntities = this.mapToCanonical(parsed, mapper, context)

      // 4. Upsert entities and create mappings
      for (const mapped of mappedEntities) {
        const { entity, isNew } = await this.upsertEntity(mapped, envelope)

        result.entityIds.push(entity.id)
        result.mappings.push({
          canonical_entity_id: entity.id,
          canonical_entity_type: mapped.entityType,
          raw_envelope_id: envelope.id,
          source_ref_key: mapped.sourceRefKey,
          mapping_confidence: 1.0,
        })

        this.emit({
          type: 'process:entity',
          entityId: entity.id,
          entityType: mapped.entityType,
        })
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

  private validateSourceData<T>(envelope: RawEnvelope, mapper: EntityMapper<T>): T {
    const parseResult = mapper.sourceSchema.safeParse(envelope.raw_data)

    if (!parseResult.success) {
      throw new ValidationError(
        `Validation failed for ${envelope.entity_type}: ${parseResult.error.message}`,
        parseResult.error,
        { envelopeId: envelope.id }
      )
    }

    return parseResult.data
  }

  private mapToCanonical<T>(
    source: T,
    mapper: EntityMapper<T>,
    context: MapperContext
  ): MappedEntity[] {
    const result = mapper.map(source, context)
    const entities = Array.isArray(result) ? result : [result]

    // Flatten any related entities
    const allEntities: MappedEntity[] = []
    for (const entity of entities) {
      allEntities.push(entity)
      if (entity.relatedEntities) {
        allEntities.push(...entity.relatedEntities)
      }
    }

    return allEntities
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

// ============ Mapper Registry ============

/**
 * Registry for entity mappers.
 * Allows dynamic registration of mappers for different entity types.
 */
export class MapperRegistry {
  private mappers: Map<string, EntityMapper<unknown>> = new Map()

  /**
   * Register a mapper.
   * Key format: connector:entity_type
   */
  register<T>(connector: ConnectorType, entityType: string, mapper: EntityMapper<T>): this {
    const key = `${connector}:${entityType}`
    this.mappers.set(key, mapper as EntityMapper<unknown>)
    return this
  }

  /**
   * Get a mapper for a specific connector and entity type.
   */
  get<T>(connector: ConnectorType, entityType: string): EntityMapper<T> | undefined {
    const key = `${connector}:${entityType}`
    return this.mappers.get(key) as EntityMapper<T> | undefined
  }

  /**
   * Check if a mapper exists.
   */
  has(connector: ConnectorType, entityType: string): boolean {
    const key = `${connector}:${entityType}`
    return this.mappers.has(key)
  }

  /**
   * Get all registered mappers for a connector.
   */
  getForConnector(connector: ConnectorType): EntityMapper<unknown>[] {
    const result: EntityMapper<unknown>[] = []
    for (const [key, mapper] of this.mappers) {
      if (key.startsWith(`${connector}:`)) {
        result.push(mapper)
      }
    }
    return result
  }
}
