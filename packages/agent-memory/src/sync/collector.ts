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
  SourceItem,
  FetchPageResult,
  SyncEvent,
} from './types.js'
import { CollectError, RateLimitError } from './types.js'
import { SyncError, ErrorCode } from '../errors/index.js'
import type { AuthProvider } from '../auth/provider.js'
import type { AccountRepository } from '../db/repositories/account.js'
import type { Connector, ConnectorContext } from '../connector/sdk/types.js'

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
  /** Auth provider for connector authentication */
  authProvider?: AuthProvider
  /** Account repository for updating sync cursor after sync completes */
  accountRepo?: AccountRepository
}

const DEFAULT_CONFIG = {
  pageSize: 100,
  maxPages: 100,
  pageDelay: 100,
  maxRetries: 3,
  baseRetryDelay: 1000,
  authProvider: undefined as AuthProvider | undefined,
  accountRepo: undefined as AccountRepository | undefined,
}

// ============ Collector ============

/**
 * Collector handles the collect phase of the sync pipeline.
 * Fetches data from connectors and stores it as RawEnvelopes.
 */
export class Collector {
  private config: typeof DEFAULT_CONFIG
  private envelopeRepo: RawEnvelopeRepository
  private syncJobRepo: SyncJobRepository
  private connectors: Map<ConnectorType, Connector> = new Map()
  private eventHandler?: (event: SyncEvent) => void
  private sql: Sql

  constructor(sql: Sql, config: CollectorConfig = {}) {
    this.sql = sql
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.envelopeRepo = createRawEnvelopeRepository({ sql })
    this.syncJobRepo = createSyncJobRepository({ sql })
  }

  /**
   * Register a connector.
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
      cursor_state: cursor ? parseCursorForStorage(cursor) : undefined,
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
      const current = await this.syncJobRepo.findById(job.id)
      const status = current?.status ?? 'unknown'
      const lastError = current?.last_error ? ` last_error=${current.last_error}` : ''
      throw new CollectError(`Failed to start job: ${job.id} (status=${status}${lastError})`)
    }

    this.emit({ type: 'sync:started', job: startedJob })

    // Recover cursor string from cursor_state.
    // cursor_state is JSONB: could be a parsed JSON object (e.g., { sinceRowId: 500 }),
    // a legacy wrapper { cursor: "..." }, or a plain string.
    let cursor = recoverCursor(job.cursor_state as string | Record<string, unknown> | undefined)

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
              await this.syncJobRepo.updateCursor(job.id, cursor)
            }
            const retryAt = new Date(Date.now() + error.retryAfter * 1000)
            await this.syncJobRepo.fail(job.id, error.message)
            await this.syncJobRepo.scheduleRetry(job.id, retryAt)
            return
          }
          // Handle stale sync token (HTTP 410) - clear cursor and restart as backfill
          if (error instanceof SyncError && error.code === ErrorCode.SYNC_CURSOR) {
            console.log('[Collector] Sync token invalidated, clearing cursor and restarting as backfill', {
              connector: job.connector,
              accountId: job.account_id,
              jobId: job.id,
            })
            // Clear the account's sync cursor
            if (this.config.accountRepo) {
              await this.config.accountRepo.updateSyncState(job.account_id, undefined)
            }
            // Clear job cursor and restart as backfill
            await this.syncJobRepo.updateCursor(job.id, undefined as unknown as string)
            cursor = undefined
            collectionMethod = 'backfill'
            pageCount = 0
            continue
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

        // Capture final cursor even when done (e.g., Gmail's updated historyId)
        if (result.nextCursor) {
          cursor = result.nextCursor
          await this.syncJobRepo.updateCursor(job.id, cursor)
        }

        // Check if we're done
        if (!result.hasMore) {
          break
        }

        // Page delay to avoid hammering the API
        if (this.config.pageDelay > 0) {
          await sleep(this.config.pageDelay)
        }
      }

      // Update account sync_cursor with the final cursor value
      if (cursor && this.config.accountRepo) {
        const cursorBytes = Buffer.byteLength(cursor, 'utf8')
        if (cursorBytes > 64 * 1024) {
          console.error('[Collector] cursor too large to save to account, skipping', {
            connector: job.connector,
            accountId: job.account_id,
            jobId: job.id,
            bytes: cursorBytes,
          })
        } else {
          await this.config.accountRepo.updateSyncState(job.account_id, cursor)
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
    adapter: Connector,
    accountId: string,
    collectionMethod: CollectionMethod,
    cursor?: string,
    entityTypes?: string[]
  ): Promise<FetchPageResult> {
    // Get auth context if needed; local connectors should not require credentials.
    let ctx: ConnectorContext | undefined
    if (adapter.authConfig.type === 'local') {
      ctx = { accountId }
    } else if (adapter.authConfig.type === 'credential_reference') {
      if (!this.config.authProvider) {
        throw new CollectError('Auth provider required for credential_reference connector', false, {
          accountId,
          connector: adapter.type,
        })
      }
      try {
        ctx = await this.config.authProvider.getContext(
          adapter.authConfig.accountId,
          adapter.authConfig.additionalScopes ?? []
        )
      } catch (error) {
        throw new CollectError(
          `Failed to get auth context: ${error instanceof Error ? error.message : String(error)}`,
          true,
          { accountId, connector: adapter.type }
        )
      }
    } else if (this.config.authProvider) {
      try {
        ctx = await this.config.authProvider.getContext(accountId)
      } catch (error) {
        throw new CollectError(
          `Failed to get auth context: ${error instanceof Error ? error.message : String(error)}`,
          true,
          { accountId, connector: adapter.type }
        )
      }
    } else {
      // Fallback: create minimal context with accountId
      ctx = { accountId }
    }

    let lastError: Error | undefined

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        if (collectionMethod === 'incremental' && adapter.fetchChanges) {
          let cursorOption: string | undefined
          let sinceOption: string | undefined
          if (cursor) {
            try {
              const parsed = JSON.parse(cursor) as unknown
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                cursorOption = cursor
              } else {
                sinceOption = cursor
              }
            } catch {
              sinceOption = cursor
            }
          }

          return await adapter.fetchChanges(ctx!, {
            cursor: cursorOption,
            since: sinceOption,
            limit: this.config.pageSize,
            entityTypes,
          })
        } else {
          return await adapter.fetchPage(ctx!, {
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
    const MAX_RAW_DATA_BYTES = 256 * 1024 * 1024
    const invalidItems: Array<{ index: number; missing: string[] }> = []
    const rawDataBytes: Record<number, number> = {}
    for (const [index, item] of items.entries()) {
      const missing: string[] = []
      if (!item) {
        missing.push('item')
      } else {
        if (!item.source_id) missing.push('source_id')
        if (!item.entity_type) missing.push('entity_type')
        if (item.raw_data === undefined) missing.push('raw_data')
        if (item.raw_data !== undefined) {
          try {
            const rawJson = JSON.stringify(item.raw_data)
            if (rawJson === undefined) {
              missing.push('raw_data_serializable')
            } else {
              const bytes = Buffer.byteLength(rawJson, 'utf8')
              rawDataBytes[index] = bytes
              if (bytes > MAX_RAW_DATA_BYTES) {
                missing.push('raw_data_too_large')
              }
            }
          } catch {
            missing.push('raw_data_serializable')
          }
        }
      }
      if (missing.length > 0) {
        invalidItems.push({ index, missing })
      }
    }

    if (invalidItems.length > 0) {
      const sample = invalidItems[0]
      const sampleItem = items[sample.index]
      console.warn('[Collector] Dropping invalid source items', {
        connector,
        accountId,
        syncJobId,
        totalItems: items.length,
        totalInvalid: invalidItems.length,
        invalidSample: invalidItems.slice(0, 3).map((entry) => ({
          index: entry.index,
          missing: entry.missing,
          source_id: items[entry.index]?.source_id,
          entity_type: items[entry.index]?.entity_type,
          raw_bytes: rawDataBytes[entry.index],
        })),
      })

      // Keep only valid items; if none remain, fail the job with context.
      const invalidIndexes = new Set(invalidItems.map((i) => i.index))
      items = items.filter((_, index) => !invalidIndexes.has(index))
      if (items.length === 0) {
        throw new CollectError(
          `All source items invalid. Example index ${sample.index}: ${sample.missing.join(', ')}`,
          false,
          {
            connector,
            accountId,
            syncJobId,
            totalItems: invalidItems.length,
            invalidSample: invalidItems.slice(0, 3),
            sampleSourceId: sampleItem?.source_id,
            sampleEntityType: sampleItem?.entity_type,
            sampleRawBytes: rawDataBytes[sample.index],
          }
        )
      }
    }

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

/**
 * Recover a cursor string from cursor_state (JSONB).
 *
 * cursor_state can be:
 * - A raw cursor object (e.g. { sinceRowId: 500 }) → re-serialize to JSON string
 * - A legacy wrapper { cursor: "..." } → extract the inner string
 * - A string (from postgres driver edge cases) → parse and recurse, or use as-is
 * - undefined/null → undefined
 *
 * This function safely unwraps any depth of legacy { cursor } wrapping to prevent
 * cursor accumulation (where each sync cycle wraps the previous cursor in another layer).
 */
function recoverCursor(cursorState: string | Record<string, unknown> | undefined): string | undefined {
  if (cursorState == null) return undefined

  if (typeof cursorState === 'string') {
    // Try to parse and recurse — handles cases where JSONB was returned as string
    try {
      const parsed = JSON.parse(cursorState)
      if (typeof parsed === 'object' && parsed !== null) {
        return recoverCursor(parsed as Record<string, unknown>)
      }
    } catch {}
    return cursorState
  }

  // Object: unwrap legacy { cursor: "..." } wrapper
  if ('cursor' in cursorState && typeof cursorState.cursor === 'string') {
    // Recurse in case the inner value is itself wrapped
    return recoverCursor(cursorState.cursor)
  }

  // Raw cursor object — re-serialize for connector use
  return JSON.stringify(cursorState)
}
