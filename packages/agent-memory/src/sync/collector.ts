/**
 * Collector - Collect Phase
 *
 * Handles fetching data from external sources and storing it as RawEnvelopes.
 * Supports backfill, incremental sync, and webhook ingestion.
 *
 * Design principles:
 * - All fetched data is wrapped in RawEnvelopes (immutable, append-only)
 * - Idempotent: duplicate data is detected and skipped
 * - Cursors are persisted for resumable operations
 * - Rate limits are respected and honored
 */

import type { Sql } from 'postgres'
import type { RawEnvelopeInput, CollectionMethod } from '../models/raw.js'
import type { ConnectorType } from '../ids.js'
import { computeIdempotencyKeys, computeRawDataHash, sourceRefToKey } from '../ids.js'
import type { RawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import type { SyncJobRepository, SyncJob } from '../db/repositories/sync-job.js'
import { createRawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import { createSyncJobRepository } from '../db/repositories/sync-job.js'
import type {
  ConnectorAdapter,
  SourceItem,
  FetchPageResult,
  SyncEvent,
} from './types.js'
import { CollectError, RateLimitError } from './types.js'

// ============ Configuration ============

export interface CollectorConfig {
  /** Maximum items to fetch per page (default: 100) */
  pageSize?: number
  /** Maximum pages to fetch in a single run (default: 100) */
  maxPages?: number
  /** Delay between pages in ms (default: 100) */
  pageDelay?: number
  /** Maximum retries for failed fetches (default: 3) */
  maxRetries?: number
  /** Base delay for retry backoff in ms (default: 1000) */
  baseRetryDelay?: number
}

const DEFAULT_CONFIG: Required<CollectorConfig> = {
  pageSize: 100,
  maxPages: 100,
  pageDelay: 100,
  maxRetries: 3,
  baseRetryDelay: 1000,
}

// ============ Collector ============

/**
 * Collector handles the collect phase of the sync pipeline.
 * Fetches data from connectors and stores it as RawEnvelopes.
 */
export class Collector {
  private config: Required<CollectorConfig>
  private envelopeRepo: RawEnvelopeRepository
  private syncJobRepo: SyncJobRepository
  private connectors: Map<ConnectorType, ConnectorAdapter> = new Map()
  private eventHandler?: (event: SyncEvent) => void

  constructor(sql: Sql, config: CollectorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.envelopeRepo = createRawEnvelopeRepository({ sql })
    this.syncJobRepo = createSyncJobRepository({ sql })
  }

  /**
   * Register a connector adapter.
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
   * Run a backfill sync for a connector.
   * Fetches all historical data.
   */
  async backfill(
    connector: ConnectorType,
    accountId: string,
    options: { entityTypes?: string[]; priority?: number } = {}
  ): Promise<SyncJob> {
    const job = await this.syncJobRepo.create({
      connector,
      account_id: accountId,
      job_type: 'backfill',
      priority: options.priority ?? 0,
      metadata: { entityTypes: options.entityTypes },
    })

    await this.runCollect(job, 'backfill', options.entityTypes)
    return job
  }

  /**
   * Run an incremental sync for a connector.
   * Fetches changes since the last sync.
   */
  async incrementalSync(
    connector: ConnectorType,
    accountId: string,
    cursor?: string,
    options: { entityTypes?: string[]; priority?: number } = {}
  ): Promise<SyncJob> {
    const job = await this.syncJobRepo.create({
      connector,
      account_id: accountId,
      job_type: 'incremental',
      priority: options.priority ?? 0,
      cursor_state: cursor ? { cursor } : undefined,
      metadata: { entityTypes: options.entityTypes },
    })

    await this.runCollect(job, 'incremental', options.entityTypes)
    return job
  }

  /**
   * Ingest a webhook payload directly.
   * Bypasses the connector's fetch methods.
   */
  async ingestWebhook(
    connector: ConnectorType,
    accountId: string,
    items: SourceItem[],
    syncJobId?: string
  ): Promise<{ created: number; duplicates: number }> {
    // Create a sync job if not provided
    let jobId = syncJobId
    if (!jobId) {
      const job = await this.syncJobRepo.create({
        connector,
        account_id: accountId,
        job_type: 'webhook',
        priority: 10, // High priority for webhooks
      })
      jobId = job.id
      await this.syncJobRepo.start(job.id)
    }

    const result = await this.storeItems(connector, accountId, items, jobId, 'webhook')

    // Complete the job if we created it
    if (!syncJobId) {
      await this.syncJobRepo.updateProgress(jobId, {
        fetched: items.length,
        processed: result.created,
      })
      await this.syncJobRepo.complete(jobId)
    }

    return result
  }

  /**
   * Resume a previously started sync job.
   */
  async resumeJob(jobId: string): Promise<SyncJob | null> {
    const job = await this.syncJobRepo.findById(jobId)
    if (!job) return null

    if (job.status !== 'pending' && job.status !== 'failed') {
      throw new CollectError(`Cannot resume job in status: ${job.status}`)
    }

    const collectionMethod = job.job_type === 'backfill' ? 'backfill' : 'incremental'
    const entityTypes = (job.metadata as { entityTypes?: string[] })?.entityTypes

    await this.runCollect(job, collectionMethod, entityTypes)
    return await this.syncJobRepo.findById(jobId)
  }

  // ============ Internal Methods ============

  private async runCollect(
    job: SyncJob,
    collectionMethod: CollectionMethod,
    entityTypes?: string[]
  ): Promise<void> {
    const adapter = this.connectors.get(job.connector)
    if (!adapter) {
      await this.syncJobRepo.fail(job.id, `No connector registered for: ${job.connector}`)
      throw new CollectError(`No connector registered for: ${job.connector}`)
    }

    // Start the job
    const startedJob = await this.syncJobRepo.start(job.id)
    if (!startedJob) {
      throw new CollectError(`Failed to start job: ${job.id}`)
    }

    this.emit({ type: 'sync:started', job: startedJob })

    let cursor = job.cursor_state?.cursor as string | undefined
    let pageCount = 0
    let totalFetched = 0
    let totalCreated = 0

    try {
      while (pageCount < this.config.maxPages) {
        // Fetch a page
        let result: FetchPageResult
        try {
          result = await this.fetchPageWithRetry(
            adapter,
            job.account_id,
            collectionMethod,
            cursor,
            entityTypes
          )
        } catch (error) {
          if (error instanceof RateLimitError) {
            this.emit({ type: 'collect:rate_limited', job, retryAfter: error.retryAfter })
            // Save cursor and schedule retry
            if (cursor) {
              await this.syncJobRepo.updateCursor(job.id, { cursor })
            }
            const retryAt = new Date(Date.now() + error.retryAfter * 1000)
            await this.syncJobRepo.fail(job.id, error.message)
            await this.syncJobRepo.scheduleRetry(job.id, retryAt)
            return
          }
          throw error
        }

        this.emit({ type: 'collect:page', job, items: result.items.length, cursor })

        // Store items as RawEnvelopes
        if (result.items.length > 0) {
          const storeResult = await this.storeItems(
            job.connector,
            job.account_id,
            result.items,
            job.id,
            collectionMethod
          )
          totalCreated += storeResult.created
        }

        totalFetched += result.items.length
        pageCount++

        // Update progress
        await this.syncJobRepo.updateProgress(job.id, { fetched: result.items.length })

        // Check if we're done
        if (!result.hasMore || !result.nextCursor) {
          break
        }

        // Update cursor for resumability
        cursor = result.nextCursor
        await this.syncJobRepo.updateCursor(job.id, { cursor })

        // Page delay to avoid hammering the API
        if (this.config.pageDelay > 0) {
          await sleep(this.config.pageDelay)
        }
      }

      // Complete the job
      await this.syncJobRepo.complete(job.id)
      const completedJob = await this.syncJobRepo.findById(job.id)

      this.emit({
        type: 'sync:completed',
        job: completedJob!,
        stats: {
          itemsFetched: totalFetched,
          envelopesCreated: totalCreated,
          envelopesProcessed: 0, // Filled in by processor
          entitiesCreated: 0,
          entitiesUpdated: 0,
          errors: 0,
          durationMs: 0,
        },
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.syncJobRepo.fail(job.id, errorMessage)
      const failedJob = await this.syncJobRepo.findById(job.id)
      this.emit({ type: 'sync:failed', job: failedJob!, error: error as Error })
      throw error
    }
  }

  private async fetchPageWithRetry(
    adapter: ConnectorAdapter,
    accountId: string,
    collectionMethod: CollectionMethod,
    cursor?: string,
    entityTypes?: string[]
  ): Promise<FetchPageResult> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        if (collectionMethod === 'incremental' && adapter.fetchChanges) {
          return await adapter.fetchChanges(accountId, {
            since: cursor,
            limit: this.config.pageSize,
            entityTypes,
          })
        } else {
          return await adapter.fetchPage(accountId, {
            cursor,
            limit: this.config.pageSize,
            entityTypes,
          })
        }
      } catch (error) {
        lastError = error as Error

        // Don't retry rate limits here - bubble up for special handling
        if (error instanceof RateLimitError) {
          throw error
        }

        // Don't retry auth errors
        if ((error as { code?: string }).code === 'AUTH_ERROR') {
          throw error
        }

        // Exponential backoff
        const delay = this.config.baseRetryDelay * Math.pow(2, attempt)
        await sleep(delay)
      }
    }

    throw new CollectError(
      `Failed to fetch page after ${this.config.maxRetries} attempts: ${lastError?.message}`,
      true,
      { attempts: this.config.maxRetries }
    )
  }

  private async storeItems(
    connector: ConnectorType,
    accountId: string,
    items: SourceItem[],
    syncJobId: string,
    collectionMethod: CollectionMethod
  ): Promise<{ created: number; duplicates: number }> {
    const envelopes: RawEnvelopeInput[] = items.map((item) => {
      const rawDataHash = computeRawDataHash(item.raw_data)
      const keys = computeIdempotencyKeys(
        connector,
        accountId,
        item.entity_type,
        item.source_id,
        item.raw_data
      )

      return {
        idempotency_key: keys.raw_key,
        connector,
        account_id: accountId,
        entity_type: item.entity_type,
        source_id: item.source_id,
        source_version: item.source_version,
        raw_data: item.raw_data,
        raw_data_hash: rawDataHash,
        source_timestamp: item.source_timestamp,
        sync_job_id: syncJobId,
        collection_method: collectionMethod,
      }
    })

    const created = await this.envelopeRepo.createMany(envelopes)

    return {
      created: created.length,
      duplicates: items.length - created.length,
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

// ============ Utilities ============

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
