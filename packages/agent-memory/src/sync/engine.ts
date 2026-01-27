/**
 * Sync Engine
 *
 * Orchestrates the two-phase sync pipeline:
 * 1. Collect Phase: Fetch data from external sources → RawEnvelopes
 * 2. Process Phase: Validate → Normalize → Upsert → Entity Resolution
 *
 * Design principles:
 * - Journaled runs: Every sync is versioned and replayable
 * - Idempotent: Safe to re-run the same source data
 * - Resumable: Jobs can be restarted after crashes
 * - Observable: Emits events for monitoring and progress tracking
 */

import type { Sql } from 'postgres'
import type { ConnectorType } from '../ids.js'
import type { SyncJob, SyncJobType } from '../db/repositories/sync-job.js'
import { createSyncJobRepository, type SyncJobRepository } from '../db/repositories/sync-job.js'
import { createTransformationRepository, type TransformationRepository } from '../db/repositories/transformations.js'
import { MicroQueue, type Job, type JobResult } from './queue.js'
import { Collector, type CollectorConfig } from './collector.js'
import { Processor, type ProcessorConfig } from './processor.js'
import type {
  SyncEvent,
  SyncStats,
  BatchProcessResult,
} from './types.js'
import type { AuthProvider } from '../auth/provider.js'
import type { Connector } from '../connector/sdk/types.js'
import { TransformationRegistry } from '../transform/registry.js'
import type { Transformation } from '../transform/types.js'

// ============ Job Types ============

/** Job payload for collect phase */
interface CollectJobPayload {
  syncJobId: string
  connector: ConnectorType
  accountId: string
  jobType: SyncJobType
  entityTypes?: string[]
}

/** Job payload for process phase */
interface ProcessJobPayload {
  syncJobId: string
}

/** Job payload for derived task execution */
interface DerivedJobPayload {
  derivedJobId: string
}

// ============ Configuration ============

export interface SyncEngineConfig {
  /** Configuration for the collector */
  collector?: CollectorConfig
  /** Configuration for the processor */
  processor?: ProcessorConfig
  /** Auth provider for connector authentication */
  authProvider?: AuthProvider
  /** Whether to automatically process after collecting (default: false) */
  autoProcess?: boolean
  /** Poll interval for the queue in ms (default: 100) */
  pollInterval?: number
  /** Maximum job runtime in ms (default: 300000 = 5 min) */
  maxJobRuntime?: number
}

const DEFAULT_CONFIG = {
  collector: {} as CollectorConfig,
  processor: {} as ProcessorConfig,
  authProvider: undefined as AuthProvider | undefined,
  autoProcess: false,
  pollInterval: 100,
  maxJobRuntime: 300000,
}

// ============ Sync Engine ============

/**
 * SyncEngine orchestrates data synchronization from external sources.
 *
 * @example
 * ```ts
 * const engine = new SyncEngine(sql)
 *
 * // Register connectors
 * engine.registerConnector(new GitHubConnector())
 *
 * // Start the engine
 * await engine.start()
 *
 * // Schedule syncs
 * await engine.scheduleBackfill('github', 'account-123')
 * await engine.scheduleIncremental('github', 'account-123')
 *
 * // Graceful shutdown
 * await engine.stop()
 * ```
 */
export class SyncEngine {
  private sql: Sql
  private config: typeof DEFAULT_CONFIG
  private queue: MicroQueue
  private collector: Collector
  private processor: Processor
  private syncJobRepo: SyncJobRepository
  private transformationRepo: TransformationRepository
  private connectors: Map<ConnectorType, Connector> = new Map()
  private transformRegistry: TransformationRegistry
  private eventHandlers: Array<(event: SyncEvent) => void> = []
  private derivedJobHandlers: Map<string, (job: Job<DerivedJobPayload>) => Promise<JobResult>> = new Map()
  private isRunning = false
  private queueWorker: Promise<void> | null = null

  constructor(sql: Sql, config: SyncEngineConfig = {}) {
    this.sql = sql
    this.config = { ...DEFAULT_CONFIG, ...config }

    // Shared transformation registry
    this.transformRegistry = new TransformationRegistry()

    // Initialize components
    this.queue = new MicroQueue(sql, {
      pollInterval: this.config.pollInterval,
      maxJobRuntime: this.config.maxJobRuntime,
    })

    // Pass authProvider to collector config
    this.collector = new Collector(sql, {
      ...this.config.collector,
      authProvider: this.config.authProvider,
    })
    this.processor = new Processor(sql, {
      ...this.config.processor,
      transformRegistry: this.transformRegistry,
    })
    this.syncJobRepo = createSyncJobRepository({ sql })
    this.transformationRepo = createTransformationRepository({ sql })

    // Wire up event handlers
    this.collector.onEvent((event) => this.emit(event))
    this.processor.onEvent((event) => this.emit(event))

    // Register job handlers
    this.registerJobHandlers()
  }

  // ============ Connector Registration ============

  /**
   * Register a connector.
   * Must be called before starting the engine.
   */
  registerConnector(connector: Connector): this {
    this.connectors.set(connector.type, connector)
    this.collector.registerConnector(connector)

    // Register connector's transforms if it has any
    if ('registerTransforms' in connector && typeof connector.registerTransforms === 'function') {
      (connector as any).registerTransforms(this.transformRegistry)
      void this.persistTransformations(connector.type)
    }

    return this
  }

  /**
   * Manually register a transformation.
   */
  registerTransform<T>(transform: Transformation<T>): this {
    this.transformRegistry.register(transform)
    void this.persistTransformation(transform)
    return this
  }

  /**
   * Check if a connector is registered.
   */
  hasConnector(type: ConnectorType): boolean {
    return this.connectors.has(type)
  }

  /**
   * Get a registered connector.
   */
  getConnector(type: ConnectorType): Connector | undefined {
    return this.connectors.get(type)
  }

  /**
   * List transformations (optionally filtered by connector).
   */
  listTransformations(connector?: ConnectorType): Transformation[] {
    if (!connector) {
      return this.transformRegistry.list()
    }
    return this.transformRegistry.findByConnector(connector)
  }

  private async persistTransformations(connector: ConnectorType): Promise<void> {
    const transforms = this.transformRegistry.findByConnector(connector)
    await Promise.all(transforms.map((t) => this.persistTransformation(t)))
  }

  private async persistTransformation(transform: Transformation): Promise<void> {
    await this.transformationRepo.upsert({
      id: transform.id,
      name: transform.name,
      connector: transform.source.connector,
      entity_type: transform.source.entityType,
      output_type: transform.outputType,
      enabled: transform.enabled,
      version: transform.version,
      description: transform.description,
    })
  }

  /**
   * Find transformations for a specific connector + entity type.
   */
  findTransformations(connector: ConnectorType, entityType: string): Transformation[] {
    return this.transformRegistry.findBySource(connector, entityType)
  }

  // ============ Event Handling ============

  /**
   * Add an event handler for sync events.
   */
  onEvent(handler: (event: SyncEvent) => void): this {
    this.eventHandlers.push(handler)
    return this
  }

  // ============ Derived Task Support ============

  /**
   * Register a handler for a derived job type.
   * Allows the shared queue to process derived tasks.
   */
  registerDerivedJobHandler(
    jobType: string,
    handler: (job: Job<DerivedJobPayload>) => Promise<JobResult>
  ): this {
    this.derivedJobHandlers.set(jobType, handler)
    this.queue.register<DerivedJobPayload>(jobType, handler)
    return this
  }

  /**
   * Schedule a derived job on the shared queue.
   */
  async scheduleDerivedJob(
    jobType: string,
    derivedJobId: string,
    options: { priority?: number; idempotencyKey?: string } = {}
  ): Promise<void> {
    if (!this.derivedJobHandlers.has(jobType)) {
      throw new Error(`No handler registered for derived job type: ${jobType}`)
    }

    await this.queue.enqueue<DerivedJobPayload>(jobType, {
      derivedJobId,
    }, {
      priority: options.priority ?? 0,
      idempotencyKey: options.idempotencyKey,
    })
  }

  // ============ Sync Scheduling ============

  /**
   * Schedule a backfill sync.
   * Fetches all historical data from the connector.
   */
  async scheduleBackfill(
    connector: ConnectorType,
    accountId: string,
    options: { priority?: number; entityTypes?: string[] } = {}
  ): Promise<SyncJob> {
    this.assertConnectorRegistered(connector)

    const job = await this.syncJobRepo.create({
      connector,
      account_id: accountId,
      job_type: 'backfill',
      priority: options.priority ?? 0,
      metadata: { entityTypes: options.entityTypes },
    })

    await this.queue.enqueue<CollectJobPayload>('sync:collect', {
      syncJobId: job.id,
      connector,
      accountId,
      jobType: 'backfill',
      entityTypes: options.entityTypes,
    }, {
      priority: options.priority ?? 0,
      idempotencyKey: `backfill:${connector}:${accountId}:${job.id}`,
    })

    return job
  }

  /**
   * Schedule an incremental sync.
   * Fetches changes since the last sync.
   */
  async scheduleIncremental(
    connector: ConnectorType,
    accountId: string,
    cursor?: string,
    options: { priority?: number; entityTypes?: string[] } = {}
  ): Promise<SyncJob> {
    this.assertConnectorRegistered(connector)

    const job = await this.syncJobRepo.create({
      connector,
      account_id: accountId,
      job_type: 'incremental',
      priority: options.priority ?? 5, // Higher default priority than backfill
      cursor_state: cursor ? parseCursorForStorage(cursor) : undefined,
      metadata: { entityTypes: options.entityTypes },
    })

    await this.queue.enqueue<CollectJobPayload>('sync:collect', {
      syncJobId: job.id,
      connector,
      accountId,
      jobType: 'incremental',
      entityTypes: options.entityTypes,
    }, {
      priority: options.priority ?? 5,
      idempotencyKey: `incremental:${connector}:${accountId}:${job.id}`,
    })

    return job
  }

  /**
   * Schedule processing for a specific sync job.
   * Normally called automatically after collect phase.
   */
  async scheduleProcess(syncJobId: string, priority = 0): Promise<void> {
    await this.queue.enqueue<ProcessJobPayload>('sync:process', {
      syncJobId,
    }, {
      priority,
      idempotencyKey: `process:${syncJobId}`,
    })
  }

  /**
   * Schedule reprocessing of all envelopes from a sync job.
   * Useful for fixing mapper bugs or schema changes.
   */
  async scheduleReprocess(syncJobId: string, priority = 0): Promise<void> {
    await this.queue.enqueue<ProcessJobPayload>('sync:reprocess', {
      syncJobId,
    }, {
      priority,
      idempotencyKey: `reprocess:${syncJobId}:${Date.now()}`,
    })
  }

  // ============ Direct Execution ============

  /**
   * Run a backfill sync immediately (synchronous).
   * Blocks until complete. For background execution, use scheduleBackfill.
   */
  async runBackfill(
    connector: ConnectorType,
    accountId: string,
    options: { entityTypes?: string[] } = {}
  ): Promise<{ job: SyncJob; processResult?: BatchProcessResult }> {
    const job = await this.collector.backfill(connector, accountId, options)

    let processResult: BatchProcessResult | undefined
    if (this.config.autoProcess) {
      processResult = await this.processor.processSyncJob(job.id)
    }

    return { job, processResult }
  }

  /**
   * Run an incremental sync immediately (synchronous).
   */
  async runIncremental(
    connector: ConnectorType,
    accountId: string,
    cursor?: string,
    options: { entityTypes?: string[] } = {}
  ): Promise<{ job: SyncJob; processResult?: BatchProcessResult }> {
    const job = await this.collector.incrementalSync(connector, accountId, cursor, options)

    let processResult: BatchProcessResult | undefined
    if (this.config.autoProcess) {
      processResult = await this.processor.processSyncJob(job.id)
    }

    return { job, processResult }
  }

  /**
   * Process all unprocessed envelopes.
   */
  async processAll(options: { transformationIds?: string[] } = {}): Promise<BatchProcessResult> {
    return this.processor.processAll(options)
  }

  /**
   * Reprocess all errored envelopes.
   */
  async processErrored(options: { transformationIds?: string[] } = {}): Promise<BatchProcessResult> {
    return this.processor.processErrored(options)
  }

  /**
   * Reprocess all envelopes that match a scope filter.
   */
  async reprocessFiltered(
    filter: { connector?: string; entityType?: string },
    options: { transformationIds?: string[] } = {}
  ): Promise<BatchProcessResult> {
    return this.processor.reprocessFiltered(filter, options)
  }

  /**
   * Process envelopes for a specific sync job.
   */
  async processSyncJob(
    syncJobId: string,
    options: { transformationIds?: string[] } = {}
  ): Promise<BatchProcessResult> {
    return this.processor.processSyncJob(syncJobId, options)
  }

  // ============ Job Status ============

  /**
   * Get status of a sync job.
   */
  async getJobStatus(jobId: string): Promise<SyncJob | null> {
    return this.syncJobRepo.findById(jobId)
  }

  /**
   * Get all pending sync jobs.
   */
  async getPendingJobs(limit = 100): Promise<SyncJob[]> {
    const result = await this.syncJobRepo.findPending({ limit })
    return result.items
  }

  /**
   * Get all running sync jobs.
   */
  async getRunningJobs(): Promise<SyncJob[]> {
    return this.syncJobRepo.findRunning()
  }

  /**
   * Cancel a pending or running sync job.
   */
  async cancelJob(jobId: string): Promise<SyncJob | null> {
    return this.syncJobRepo.cancel(jobId)
  }

  // ============ Engine Lifecycle ============

  /**
   * Start the sync engine.
   * Begins processing queued jobs in the background.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('SyncEngine is already running')
    }

    this.isRunning = true

    // Start the queue worker without blocking scheduler startup.
    this.queueWorker = this.queue.start()
    this.queueWorker.catch((error) => {
      console.error('[SyncEngine] Queue worker exited with error:', error)
      this.isRunning = false
    })
  }

  /**
   * Stop the sync engine gracefully.
   * Waits for current job to complete.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    this.isRunning = false
    await this.queue.stop()
    if (this.queueWorker) {
      await this.queueWorker.catch(() => undefined)
      this.queueWorker = null
    }
  }

  /**
   * Check if the engine is running.
   */
  get running(): boolean {
    return this.isRunning
  }

  /**
   * Get queue statistics.
   */
  async getQueueStats(): Promise<{
    pending: number
    running: number
    completed: number
    failed: number
    dead: number
  }> {
    const stats = await this.queue.getStats()
    return {
      pending: stats.pending,
      running: stats.running,
      completed: stats.completed,
      failed: stats.failed,
      dead: stats.dead,
    }
  }

  // ============ Internal ============

  private registerJobHandlers(): void {
    // Collect phase handler
    this.queue.register<CollectJobPayload>('sync:collect', async (job) => {
      return this.handleCollectJob(job)
    })

    // Process phase handler
    this.queue.register<ProcessJobPayload>('sync:process', async (job) => {
      return this.handleProcessJob(job)
    })

    // Reprocess handler
    this.queue.register<ProcessJobPayload>('sync:reprocess', async (job) => {
      return this.handleReprocessJob(job)
    })
  }

  private async handleCollectJob(job: Job<CollectJobPayload>): Promise<JobResult> {
    const payload = typeof job.payload === 'string'
      ? JSON.parse(job.payload) as CollectJobPayload
      : job.payload
    const { syncJobId } = payload

    if (!syncJobId) {
      return { success: false, error: new Error(`Missing syncJobId in collect job payload`), noRetry: true }
    }

    try {
      // Resume or start the job
      const syncJob = await this.syncJobRepo.findById(syncJobId)
      if (!syncJob) {
        return { success: false, error: new Error(`Sync job not found: ${syncJobId}`) }
      }

      // Run collection for the existing job instead of creating a new one.
      const resumed = await this.collector.resumeJob(syncJobId)
      if (!resumed) {
        return { success: false, error: new Error(`Failed to resume job: ${syncJobId}`) }
      }

      // Schedule process phase if auto-process is enabled
      if (this.config.autoProcess) {
        await this.scheduleProcess(syncJobId, job.priority)
      }

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  private async handleProcessJob(job: Job<ProcessJobPayload>): Promise<JobResult> {
    const payload = typeof job.payload === 'string'
      ? JSON.parse(job.payload) as ProcessJobPayload
      : job.payload
    const { syncJobId } = payload

    try {
      const result = await this.processor.processSyncJob(syncJobId)

      if (result.failed > 0 && result.succeeded === 0) {
        return {
          success: false,
          error: new Error(`All ${result.failed} envelopes failed to process`),
        }
      }

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  private async handleReprocessJob(job: Job<ProcessJobPayload>): Promise<JobResult> {
    const payload = typeof job.payload === 'string'
      ? JSON.parse(job.payload) as ProcessJobPayload
      : job.payload
    const { syncJobId } = payload

    try {
      const result = await this.processor.reprocessSyncJob(syncJobId)

      if (result.failed > 0 && result.succeeded === 0) {
        return {
          success: false,
          error: new Error(`All ${result.failed} envelopes failed to reprocess`),
        }
      }

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  private assertConnectorRegistered(type: ConnectorType): void {
    if (!this.connectors.has(type)) {
      throw new Error(`Connector not registered: ${type}`)
    }
  }

  private emit(event: SyncEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch {
        // Ignore handler errors
      }
    }
  }
}

/**
 * Parse a cursor string for JSONB storage.
 * If the cursor is valid JSON that parses to an object, store the object directly.
 * Otherwise, wrap it as { cursor: "..." } so it fits Record<string, unknown>.
 */
function parseCursorForStorage(cursor: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(cursor)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}
  return { cursor }
}
