import type { Sql } from 'postgres'
import type { RawEnvelope } from '../models/raw.js'
import type { RawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import type { CanonicalEntityRepository } from '../db/repositories/canonical-entity.js'
import type { EntitySourceMappingRepository } from '../db/repositories/entity-source-mapping.js'
import { createRawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import { createCanonicalEntityRepository } from '../db/repositories/canonical-entity.js'
import { createEntitySourceMappingRepository } from '../db/repositories/entity-source-mapping.js'
import type { TransformationRegistry } from './registry.js'
import type {
  Transformation,
  TransformContext,
  TransformOutput,
  RunTransformOptions,
  TransformRunResult,
  TransformEvent,
} from './types.js'

/**
 * Configuration for the transformation executor.
 */
export interface TransformExecutorConfig {
  /** Batch size for fetching envelopes (default: 100) */
  batchSize?: number
  /** Continue on individual errors (default: true) */
  continueOnError?: boolean
}

const DEFAULT_CONFIG: Required<TransformExecutorConfig> = {
  batchSize: 100,
  continueOnError: true,
}

/**
 * Executes transformations against raw envelopes.
 */
export class TransformExecutor {
  private sql: Sql
  private config: Required<TransformExecutorConfig>
  private registry: TransformationRegistry
  private envelopeRepo: RawEnvelopeRepository
  private entityRepo: CanonicalEntityRepository
  private mappingRepo: EntitySourceMappingRepository
  private eventHandler?: (event: TransformEvent) => void

  constructor(
    sql: Sql,
    registry: TransformationRegistry,
    config: TransformExecutorConfig = {}
  ) {
    this.sql = sql
    this.registry = registry
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.envelopeRepo = createRawEnvelopeRepository({ sql })
    this.entityRepo = createCanonicalEntityRepository({ sql })
    this.mappingRepo = createEntitySourceMappingRepository({ sql })
  }

  /**
   * Set event handler for transform events.
   */
  onEvent(handler: (event: TransformEvent) => void): this {
    this.eventHandler = handler
    return this
  }

  /**
   * Run transformations with the given options.
   */
  async run(options: RunTransformOptions = {}): Promise<TransformRunResult> {
    this.emit({ type: 'run:started', options })

    const result: TransformRunResult = {
      totalProcessed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      quarantined: 0,
      entitiesCreated: 0,
      entitiesUpdated: 0,
      errors: [],
    }

    const continueOnError = options.continueOnError ?? this.config.continueOnError

    let offset = 0
    while (true) {
      const batch = await this.fetchEnvelopes(options, offset)
      if (batch.length === 0) break

      for (const envelope of batch) {
        const transformResult = await this.transformEnvelope(envelope, options)

        result.totalProcessed++

        switch (transformResult.status) {
          case 'succeeded':
            result.succeeded++
            result.entitiesCreated += transformResult.entitiesCreated
            result.entitiesUpdated += transformResult.entitiesUpdated
            break
          case 'failed':
            result.failed++
            result.errors.push(...transformResult.errors)
            if (!continueOnError) {
              this.emit({ type: 'run:completed', result })
              return result
            }
            break
          case 'skipped':
            result.skipped++
            break
          case 'quarantined':
            result.quarantined++
            result.errors.push(...transformResult.errors)
            break
        }
      }

      offset += batch.length
      if (options.limit && offset >= options.limit) break
    }

    this.emit({ type: 'run:completed', result })
    return result
  }

  /**
   * Transform a single envelope by ID.
   */
  async transformById(envelopeId: string): Promise<TransformRunResult> {
    return this.run({ envelopeIds: [envelopeId] })
  }

  /**
   * Re-transform all envelopes for a specific transformation.
   */
  async rerunTransformation(
    transformationId: string,
    options: Omit<RunTransformOptions, 'transformationIds'> = {}
  ): Promise<TransformRunResult> {
    const transformation = this.registry.get(transformationId)
    if (!transformation) {
      throw new Error(`Transformation not found: ${transformationId}`)
    }

    await this.sql`
      UPDATE raw_envelopes
      SET processed_at = NULL, processing_error = NULL
      WHERE connector = ${transformation.source.connector}
        AND entity_type = ${transformation.source.entityType}
    `

    return this.run({
      ...options,
      source: transformation.source,
      transformationIds: [transformationId],
    })
  }

  // ============ Private Methods ============

  private async fetchEnvelopes(
    options: RunTransformOptions,
    offset: number
  ): Promise<RawEnvelope[]> {
    if (options.envelopeIds?.length) {
      const envelopes: RawEnvelope[] = []
      for (const id of options.envelopeIds) {
        const env = await this.envelopeRepo.findById(id)
        if (env) envelopes.push(env)
      }
      return envelopes
    }

    const result = await this.envelopeRepo.findUnprocessed({
      limit: Math.min(this.config.batchSize, options.limit ?? Infinity),
      offset,
    })

    let filtered = result.items
    if (options.source?.connector) {
      filtered = filtered.filter((e) => e.connector === options.source!.connector)
    }
    if (options.source?.entityType) {
      filtered = filtered.filter((e) => e.entity_type === options.source!.entityType)
    }

    if (options.since) {
      filtered = filtered.filter((e) => new Date(e.received_at) >= options.since!)
    }
    if (options.until) {
      filtered = filtered.filter((e) => new Date(e.received_at) <= options.until!)
    }

    return filtered
  }

  private async transformEnvelope(
    envelope: RawEnvelope,
    options: RunTransformOptions
  ): Promise<{
    status: 'succeeded' | 'failed' | 'skipped' | 'quarantined'
    entitiesCreated: number
    entitiesUpdated: number
    errors: Array<{ envelopeId: string; transformationId: string; error: string }>
  }> {
    let transformations = this.registry.findBySource(envelope.connector, envelope.entity_type)

    if (options.transformationIds?.length) {
      transformations = transformations.filter((t) => options.transformationIds!.includes(t.id))
    }

    if (transformations.length === 0) {
      this.emit({
        type: 'transform:skipped',
        envelopeId: envelope.id,
        reason: 'no matching transformation',
      })
      return { status: 'skipped', entitiesCreated: 0, entitiesUpdated: 0, errors: [] }
    }

    let entitiesCreated = 0
    let entitiesUpdated = 0
    const errors: Array<{ envelopeId: string; transformationId: string; error: string }> = []
    let anySucceeded = false
    let anyQuarantined = false

    for (const transformation of transformations) {
      const result = await this.executeTransformation(envelope, transformation)

      if (result.success) {
        anySucceeded = true
        entitiesCreated += result.created
        entitiesUpdated += result.updated
      } else {
        errors.push({
          envelopeId: envelope.id,
          transformationId: transformation.id,
          error: result.error!,
        })

        if (transformation.onError === 'quarantine') {
          anyQuarantined = true
        }
      }
    }

    if (anySucceeded) {
      await this.envelopeRepo.markProcessed(envelope.id)
    } else if (errors.length > 0) {
      await this.envelopeRepo.markProcessed(
        envelope.id,
        errors.map((e) => e.error).join('; ')
      )
    }

    if (anyQuarantined) {
      return { status: 'quarantined', entitiesCreated, entitiesUpdated, errors }
    }
    if (anySucceeded) {
      return { status: 'succeeded', entitiesCreated, entitiesUpdated, errors }
    }
    return { status: 'failed', entitiesCreated: 0, entitiesUpdated: 0, errors }
  }

  private async executeTransformation(
    envelope: RawEnvelope,
    transformation: Transformation
  ): Promise<{ success: boolean; created: number; updated: number; error?: string }> {
    this.emit({
      type: 'transform:started',
      envelopeId: envelope.id,
      transformationId: transformation.id,
    })

    try {
      if (transformation.source.filter && !transformation.source.filter(envelope.raw_data)) {
        this.emit({
          type: 'transform:skipped',
          envelopeId: envelope.id,
          reason: 'filter rejected',
        })
        return { success: true, created: 0, updated: 0 }
      }

      const parseResult = transformation.inputSchema.safeParse(envelope.raw_data)
      if (!parseResult.success) {
        const error = `Schema validation failed: ${parseResult.error.message}`
        this.emit({
          type: 'transform:failed',
          envelopeId: envelope.id,
          transformationId: transformation.id,
          error,
        })
        return { success: false, created: 0, updated: 0, error }
      }

      const ctx: TransformContext = {
        envelope,
        accountId: envelope.account_id,
        connector: envelope.connector,
        lookupEntity: (key) =>
          this.mappingRepo.findBySourceRefKey(key).then((m) =>
            m ? this.entityRepo.findById(m.canonical_entity_id) : null
          ),
        lookupEntitiesByType: (type, limit) =>
          this.entityRepo.findByType(type, { limit: limit ?? 100 }).then((r) => r.items),
      }

      const results = transformation.transform(parseResult.data, ctx)
      const resultArray = Array.isArray(results) ? results : [results]

      const allOutputs: TransformOutput[] = []
      for (const result of resultArray) {
        allOutputs.push(result.primary)
        if (result.related) {
          allOutputs.push(...result.related)
        }
      }

      let created = 0
      let updated = 0
      const entityIds: string[] = []

      for (const output of allOutputs) {
        const { entityId, isNew } = await this.upsertEntity(output, envelope, transformation)
        entityIds.push(entityId)
        if (isNew) created++
        else updated++
      }

      this.emit({
        type: 'transform:completed',
        envelopeId: envelope.id,
        transformationId: transformation.id,
        entityIds,
      })
      return { success: true, created, updated }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (transformation.onError === 'quarantine') {
        this.emit({
          type: 'transform:quarantined',
          envelopeId: envelope.id,
          transformationId: transformation.id,
          error: errorMessage,
        })
      } else {
        this.emit({
          type: 'transform:failed',
          envelopeId: envelope.id,
          transformationId: transformation.id,
          error: errorMessage,
        })
      }

      if (transformation.onError === 'fail') {
        throw error
      }

      return { success: false, created: 0, updated: 0, error: errorMessage }
    }
  }

  private async upsertEntity(
    output: TransformOutput,
    envelope: RawEnvelope,
    transformation: Transformation
  ): Promise<{ entityId: string; isNew: boolean }> {
    const existingMapping = await this.mappingRepo.findBySourceRefKey(output.sourceRefKey)

    if (existingMapping) {
      const updated = await this.entityRepo.update(
        existingMapping.canonical_entity_id,
        output.data,
        output.displayText
      )

      if (updated) {
        await this.mappingRepo.create({
          canonical_entity_id: updated.id,
          canonical_entity_type: output.entityType,
          raw_envelope_id: envelope.id,
          source_ref_key: output.sourceRefKey,
          mapping_confidence: 1.0,
          transformation_id: transformation.id,
          transformation_version: transformation.version,
        })

        return { entityId: updated.id, isNew: false }
      }
    }

    const created = await this.entityRepo.create(output.entityType, output.data, output.displayText)

    await this.mappingRepo.create({
      canonical_entity_id: created.id,
      canonical_entity_type: output.entityType,
      raw_envelope_id: envelope.id,
      source_ref_key: output.sourceRefKey,
      mapping_confidence: 1.0,
      transformation_id: transformation.id,
      transformation_version: transformation.version,
    })

    return { entityId: created.id, isNew: true }
  }

  private emit(event: TransformEvent): void {
    if (this.eventHandler) {
      try {
        this.eventHandler(event)
      } catch {
        // Ignore event handler errors
      }
    }
  }
}
