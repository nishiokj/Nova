# Transformation Layer Specification

This document specifies the Transformation Layer, replacing the current Processor/Mapper architecture with a cleaner separation between deterministic transformations and non-deterministic processing.

---

## Architectural Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: RAW (Bronze)                                      │
│  raw_envelopes table                                        │
│  - Append-only, immutable                                   │
│  - Exactly what the source gave us                          │
│  - No interpretation, no transformation                     │
└─────────────────────────────────────────────────────────────┘
                              │
                    Transformations (deterministic)
                    - Schema mapping
                    - Field extraction
                    - Normalization
                    - Replayable, idempotent
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: CANONICAL (Silver / Warehouse)                    │
│  canonical_entities table                                   │
│  - Normalized shapes (Message, Person, Task, etc.)          │
│  - Queryable across sources                                 │
│  - Factual data, reorganized                                │
└─────────────────────────────────────────────────────────────┘
                              │
                    Processing / Analysis (non-deterministic)
                    - LLM inference
                    - Enrichment
                    - Aggregation
                    - Expensive, versioned, may change
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: DERIVED (Gold / Insights)                         │
│  derived_entities table (new)                               │
│  - Preferences, Summaries, Sentiment, Topics                │
│  - Generated/inferred, not just mapped                      │
│  - Tracked by processor version + model version             │
└─────────────────────────────────────────────────────────────┘
```

---

## Obsolete Components (To Be Removed)

### `src/sync/processor.ts`

**DELETE ENTIRE FILE**

The `Processor` class conflates two concerns:
1. Deterministic schema transformation (should be Transformation Layer)
2. Entity upsert/lineage tracking (should be shared infrastructure)

```typescript
// OBSOLETE - DELETE
export class Processor { ... }
export class MapperRegistry { ... }
```

### `src/sync/types.ts`

**DELETE the following types:**

```typescript
// OBSOLETE - replaced by Transformation interface
export interface EntityMapper<TSource = unknown> {
  sourceSchema: z.ZodType<TSource>
  targetEntityType: EntityType
  map(source: TSource, context: MapperContext): MappedEntity | MappedEntity[]
}

// OBSOLETE - replaced by TransformContext
export interface MapperContext {
  sourceRef: SourceRef
  envelope: RawEnvelope
  accountId: string
  connector: ConnectorType
}

// OBSOLETE - replaced by TransformOutput
export interface MappedEntity {
  entityType: EntityType
  sourceRefKey: string
  data: Record<string, unknown>
  displayText?: string
  relatedEntities?: MappedEntity[]
}

// OBSOLETE - Processor-specific
export interface ProcessResult { ... }
export interface BatchProcessResult { ... }
```

### `src/connector/sdk/types.ts`

**REMOVE from Connector interface:**

```typescript
// OBSOLETE - Connectors should not own mappers
export interface Connector {
  // DELETE these methods:
  getMapper(entityType: string): EntityMapper | undefined
  registerMapper(mapper: EntityMapper): void

  // KEEP everything else
}
```

### `src/connector/sdk/base.ts`

**REMOVE mapper registration from BaseConnector:**

```typescript
// OBSOLETE - DELETE these members
protected mappers: Map<string, EntityMapper>
registerMapper(mapper: EntityMapper): void
getMapper(entityType: string): EntityMapper | undefined
```

### Connector-specific mappers

**DELETE mapper files from connectors:**

```
src/connectors/gmail/mappers.ts      # DELETE
src/connectors/github/mappers.ts     # DELETE
```

Connectors should only:
1. Fetch data from external APIs
2. Parse webhook payloads
3. Define source schemas (for documentation/validation)

---

## New Components

### `src/transform/types.ts`

```typescript
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
 *
 * Transformations are:
 * - Deterministic: same input always produces same output
 * - Idempotent: can be safely re-run
 * - Versioned: schema changes are tracked
 * - Traceable: full lineage from canonical to raw
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
```

### `src/transform/registry.ts`

```typescript
import type { ConnectorType } from '../ids.js'
import type { Transformation, TransformSource } from './types.js'

/**
 * Registry for transformation definitions.
 *
 * Transformations are registered explicitly and looked up by source selector.
 * Multiple transformations can match the same source (producing different outputs).
 */
export class TransformationRegistry {
  private transformations: Map<string, Transformation> = new Map()

  /**
   * Register a transformation.
   */
  register<TInput>(transformation: Transformation<TInput>): this {
    if (this.transformations.has(transformation.id)) {
      throw new Error(`Transformation already registered: ${transformation.id}`)
    }
    this.transformations.set(transformation.id, transformation as Transformation)
    return this
  }

  /**
   * Unregister a transformation.
   */
  unregister(id: string): boolean {
    return this.transformations.delete(id)
  }

  /**
   * Get a transformation by ID.
   */
  get(id: string): Transformation | undefined {
    return this.transformations.get(id)
  }

  /**
   * Find all transformations matching a source.
   */
  findBySource(connector: ConnectorType, entityType: string): Transformation[] {
    const matches: Transformation[] = []

    for (const t of this.transformations.values()) {
      if (!t.enabled) continue
      if (t.source.connector !== connector) continue
      if (t.source.entityType !== entityType) continue
      matches.push(t)
    }

    return matches
  }

  /**
   * Find all transformations for a connector.
   */
  findByConnector(connector: ConnectorType): Transformation[] {
    const matches: Transformation[] = []

    for (const t of this.transformations.values()) {
      if (t.source.connector === connector) {
        matches.push(t)
      }
    }

    return matches
  }

  /**
   * List all registered transformations.
   */
  list(): Transformation[] {
    return Array.from(this.transformations.values())
  }

  /**
   * Check if any transformation exists for a source.
   */
  hasTransformation(connector: ConnectorType, entityType: string): boolean {
    return this.findBySource(connector, entityType).length > 0
  }

  /**
   * Enable/disable a transformation.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const t = this.transformations.get(id)
    if (!t) return false
    t.enabled = enabled
    return true
  }
}
```

### `src/transform/executor.ts`

```typescript
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
  TransformResult,
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
 *
 * The executor:
 * 1. Fetches unprocessed envelopes matching criteria
 * 2. Looks up matching transformations from registry
 * 3. Validates input against transformation schema
 * 4. Executes transform function
 * 5. Upserts canonical entities
 * 6. Creates lineage mappings
 * 7. Marks envelope as processed
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

    // Fetch envelopes in batches
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
   * Useful when transformation logic changes.
   */
  async rerunTransformation(transformationId: string, options: Omit<RunTransformOptions, 'transformationIds'> = {}): Promise<TransformRunResult> {
    const transformation = this.registry.get(transformationId)
    if (!transformation) {
      throw new Error(`Transformation not found: ${transformationId}`)
    }

    // Clear processed state for matching envelopes
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
    // If specific IDs provided, fetch those
    if (options.envelopeIds?.length) {
      const envelopes: RawEnvelope[] = []
      for (const id of options.envelopeIds) {
        const env = await this.envelopeRepo.findById(id)
        if (env) envelopes.push(env)
      }
      return envelopes
    }

    // Otherwise fetch unprocessed with filters
    const result = await this.envelopeRepo.findUnprocessed({
      limit: Math.min(this.config.batchSize, options.limit ?? Infinity),
      offset,
    })

    // Apply source filter if provided
    let filtered = result.items
    if (options.source?.connector) {
      filtered = filtered.filter(e => e.connector === options.source!.connector)
    }
    if (options.source?.entityType) {
      filtered = filtered.filter(e => e.entity_type === options.source!.entityType)
    }

    // Apply time filters
    if (options.since) {
      filtered = filtered.filter(e => new Date(e.created_at) >= options.since!)
    }
    if (options.until) {
      filtered = filtered.filter(e => new Date(e.created_at) <= options.until!)
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
    // Find matching transformations
    let transformations = this.registry.findBySource(envelope.connector, envelope.entity_type)

    // Filter by specific transformation IDs if provided
    if (options.transformationIds?.length) {
      transformations = transformations.filter(t => options.transformationIds!.includes(t.id))
    }

    // Skip if no transformations match
    if (transformations.length === 0) {
      this.emit({ type: 'transform:skipped', envelopeId: envelope.id, reason: 'no matching transformation' })
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

    // Mark envelope as processed
    if (anySucceeded) {
      await this.envelopeRepo.markProcessed(envelope.id)
    } else if (errors.length > 0) {
      await this.envelopeRepo.markProcessed(envelope.id, errors.map(e => e.error).join('; '))
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
    this.emit({ type: 'transform:started', envelopeId: envelope.id, transformationId: transformation.id })

    try {
      // Apply source filter if defined
      if (transformation.source.filter && !transformation.source.filter(envelope.raw_data)) {
        this.emit({ type: 'transform:skipped', envelopeId: envelope.id, reason: 'filter rejected' })
        return { success: true, created: 0, updated: 0 }
      }

      // Validate input schema
      const parseResult = transformation.inputSchema.safeParse(envelope.raw_data)
      if (!parseResult.success) {
        const error = `Schema validation failed: ${parseResult.error.message}`
        this.emit({ type: 'transform:failed', envelopeId: envelope.id, transformationId: transformation.id, error })
        return { success: false, created: 0, updated: 0, error }
      }

      // Build context
      const ctx: TransformContext = {
        envelope,
        accountId: envelope.account_id,
        connector: envelope.connector,
        lookupEntity: (key) => this.mappingRepo.findBySourceRefKey(key).then(m =>
          m ? this.entityRepo.findById(m.canonical_entity_id) : null
        ),
        lookupEntitiesByType: (type, limit) => this.entityRepo.findByType(type, { limit: limit ?? 100 }).then(r => r.items),
      }

      // Execute transformation
      const results = transformation.transform(parseResult.data, ctx)
      const resultArray = Array.isArray(results) ? results : [results]

      // Flatten all outputs
      const allOutputs: TransformOutput[] = []
      for (const result of resultArray) {
        allOutputs.push(result.primary)
        if (result.related) {
          allOutputs.push(...result.related)
        }
      }

      // Upsert entities and create mappings
      let created = 0
      let updated = 0
      const entityIds: string[] = []

      for (const output of allOutputs) {
        const { entityId, isNew } = await this.upsertEntity(output, envelope, transformation)
        entityIds.push(entityId)
        if (isNew) created++
        else updated++
      }

      this.emit({ type: 'transform:completed', envelopeId: envelope.id, transformationId: transformation.id, entityIds })
      return { success: true, created, updated }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      if (transformation.onError === 'quarantine') {
        this.emit({ type: 'transform:quarantined', envelopeId: envelope.id, transformationId: transformation.id, error: errorMessage })
      } else {
        this.emit({ type: 'transform:failed', envelopeId: envelope.id, transformationId: transformation.id, error: errorMessage })
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
    // Check if entity already exists for this source ref
    const existingMapping = await this.mappingRepo.findBySourceRefKey(output.sourceRefKey)

    if (existingMapping) {
      // Update existing entity
      const updated = await this.entityRepo.update(
        existingMapping.canonical_entity_id,
        output.data,
        output.displayText
      )

      if (updated) {
        // Create new mapping for audit trail
        await this.mappingRepo.create({
          canonical_entity_id: updated.id,
          canonical_entity_type: output.entityType,
          raw_envelope_id: envelope.id,
          source_ref_key: output.sourceRefKey,
          mapping_confidence: 1.0,
        })

        return { entityId: updated.id, isNew: false }
      }
    }

    // Create new entity
    const created = await this.entityRepo.create(
      output.entityType,
      output.data,
      output.displayText
    )

    // Create source mapping
    await this.mappingRepo.create({
      canonical_entity_id: created.id,
      canonical_entity_type: output.entityType,
      raw_envelope_id: envelope.id,
      source_ref_key: output.sourceRefKey,
      mapping_confidence: 1.0,
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
```

### `src/transform/index.ts`

```typescript
/**
 * Transformation Layer
 *
 * Deterministic, idempotent transformations from raw envelopes to canonical entities.
 */

export {
  // Types
  type TransformSource,
  type TransformContext,
  type TransformOutput,
  type TransformResult,
  type TransformErrorPolicy,
  type Transformation,
  type RunTransformOptions,
  type TransformRunResult,
  type TransformEvent,
} from './types.js'

export {
  // Registry
  TransformationRegistry,
} from './registry.js'

export {
  // Executor
  TransformExecutor,
  type TransformExecutorConfig,
} from './executor.js'
```

---

## Migration Path

### Step 1: Create new transform module

Create the files in `src/transform/` as specified above.

### Step 2: Migrate existing mappers to transformations

For each connector's mappers, create equivalent transformations:

```typescript
// OLD: src/connectors/gmail/mappers.ts (DELETE)
export const gmailMessageMapper: EntityMapper<GmailMessage> = {
  sourceSchema: GmailMessageSchema,
  targetEntityType: 'message',
  map(source, ctx) { ... }
}

// NEW: src/transform/gmail.ts (CREATE)
import { GmailMessageSchema, type GmailMessage } from '../connectors/gmail/schemas.js'
import type { Transformation } from './types.js'

export const gmailMessageTransformation: Transformation<GmailMessage> = {
  id: 'gmail:message:v1',
  name: 'Gmail Message → Canonical Message',
  source: {
    connector: 'gmail',
    entityType: 'message',
  },
  inputSchema: GmailMessageSchema,
  outputType: 'message',
  transform(source, ctx) {
    // Same logic as old mapper
    return {
      primary: {
        entityType: 'message',
        sourceRefKey: `gmail:${ctx.accountId}:message:${source.id}`,
        data: { ... },
        displayText: source.snippet,
      },
      related: [
        // Extract sender as Person
        {
          entityType: 'person',
          sourceRefKey: `gmail:${ctx.accountId}:person:${senderEmail}`,
          data: { ... },
        }
      ],
    }
  },
  onError: 'quarantine',
  enabled: true,
  version: 1,
}
```

### Step 3: Update SyncEngine to use TransformExecutor

```typescript
// OLD: SyncEngine uses Processor
this.processor = new Processor(sql, config)
this.processor.registerConnector(connector)

// NEW: SyncEngine uses TransformExecutor
this.registry = new TransformationRegistry()
this.executor = new TransformExecutor(sql, this.registry, config)

// Register transformations explicitly
this.registry.register(gmailMessageTransformation)
this.registry.register(gmailThreadTransformation)
```

### Step 4: Remove obsolete code

1. Delete `src/sync/processor.ts`
2. Delete mapper-related types from `src/sync/types.ts`
3. Delete `getMapper`/`registerMapper` from Connector interface
4. Delete mapper files from connectors

### Step 5: Update exports

```typescript
// src/index.ts - REMOVE
export { Processor, MapperRegistry } from './sync/processor.js'

// src/index.ts - ADD
export {
  TransformationRegistry,
  TransformExecutor,
  type Transformation,
  type TransformContext,
  type TransformResult,
  type RunTransformOptions,
  type TransformRunResult,
} from './transform/index.js'
```

---

## Database Changes

### New table: `transformation_runs`

Track transformation execution history:

```sql
CREATE TABLE transformation_runs (
  id TEXT PRIMARY KEY,
  transformation_id TEXT NOT NULL,
  transformation_version INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  envelopes_processed INTEGER NOT NULL DEFAULT 0,
  entities_created INTEGER NOT NULL DEFAULT 0,
  entities_updated INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  error_details JSONB
);

CREATE INDEX idx_transformation_runs_transformation ON transformation_runs (transformation_id);
CREATE INDEX idx_transformation_runs_status ON transformation_runs (status);
```

### Update `entity_source_mappings`

Add transformation tracking:

```sql
ALTER TABLE entity_source_mappings
ADD COLUMN transformation_id TEXT,
ADD COLUMN transformation_version INTEGER;
```

---

## Summary of Changes

| Component | Action | Notes |
|-----------|--------|-------|
| `Processor` class | DELETE | Replaced by `TransformExecutor` |
| `MapperRegistry` class | DELETE | Replaced by `TransformationRegistry` |
| `EntityMapper` type | DELETE | Replaced by `Transformation` |
| `MapperContext` type | DELETE | Replaced by `TransformContext` |
| `MappedEntity` type | DELETE | Replaced by `TransformOutput` |
| `Connector.getMapper()` | DELETE | Connectors don't own transforms |
| `Connector.registerMapper()` | DELETE | Connectors don't own transforms |
| `BaseConnector.mappers` | DELETE | Connectors don't own transforms |
| Connector mapper files | DELETE | Move to `src/transform/*.ts` |
| `TransformationRegistry` | CREATE | Explicit transformation registration |
| `TransformExecutor` | CREATE | Runs transformations on demand |
| `src/transform/` module | CREATE | New module for transformation layer |
| `transformation_runs` table | CREATE | Track execution history |

---

## Design Principles

1. **Transformations are explicit** - No magic lookup. You see exactly what transforms exist.

2. **Connectors only fetch** - Connectors fetch data and parse webhooks. They don't transform.

3. **On-demand execution** - Transformations run when you ask, not automatically.

4. **Multiple outputs per source** - One raw envelope can produce multiple canonical entities via different transformations.

5. **Versioned and traceable** - Every transformation has a version. Every entity links back to the transformation that created it.

6. **Error policies** - Choose how to handle failures: skip, fail the whole run, or quarantine bad data.

7. **Deterministic and idempotent** - Same input always produces same output. Safe to re-run.
