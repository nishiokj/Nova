/**
 * Scheduler
 *
 * Poll loop that triggers sync jobs based on task schedules.
 * Manages webhook subscriptions for real-time updates.
 */

import type { ConnectorType } from '../ids.js'
import type { AuthProvider } from '../auth/provider.js'
import type { Connector, ConnectorContext, WebhookSubscription } from '../connector/sdk/types.js'
import type { SyncTask, SyncTaskRepository } from '../db/repositories/sync-task.js'
import type { AccountRepository } from '../db/repositories/account.js'
import type { SyncEngine } from './engine.js'
import type { SyncJob } from '../db/repositories/sync-job.js'
import type { DerivedTask, DerivedTaskRepository } from '../db/repositories/derived-task.js'
import type { DerivedJob } from '../db/repositories/derived-job.js'
import { DerivedTaskIntegration } from '../derived/integration.js'
import type { AgenticTask, AgenticRun } from 'types'
import type { AgenticTaskRepository } from '../db/repositories/agentic-task.js'
import type { AgenticTaskIntegration } from '../agentic/integration.js'
import { isAgentMemoryError } from '../errors/index.js'

// ============ Configuration ============

export interface SchedulerConfig {
  /** Poll interval for checking due tasks (default: 10000ms) */
  pollInterval?: number
  /** Maximum tasks to process per poll (default: 50) */
  batchSize?: number
  /** Base URL for webhook callbacks */
  webhookBaseUrl?: string
}

const DEFAULT_CONFIG: Required<Omit<SchedulerConfig, 'webhookBaseUrl'>> & Pick<SchedulerConfig, 'webhookBaseUrl'> = {
  pollInterval: 10000,
  batchSize: 50,
  webhookBaseUrl: undefined,
}

const MAX_LOG_STRING_CHARS = 2_000_000
const MAX_LOG_DEPTH = 6
const MAX_LOG_ARRAY_LENGTH = 1000
const MAX_LOG_OBJECT_KEYS = 2000

const ERROR_TOP_LEVEL_KEYS = [
  'code',
  'errno',
  'syscall',
  'path',
  'status',
  'statusCode',
  'type',
  'name',
  'message',
  'stack',
] as const

const ERROR_DB_KEYS = [
  'schema',
  'table',
  'column',
  'constraint',
  'detail',
  'hint',
  'where',
  'routine',
  'severity',
] as const

const ERROR_QUERY_KEYS = ['sql', 'query', 'statement', 'parameters', 'values'] as const

const ERROR_META_KEYS = ['meta', 'data', 'details', 'response', 'request'] as const

function truncateString(value: string): string {
  if (value.length <= MAX_LOG_STRING_CHARS) return value
  const omitted = value.length - MAX_LOG_STRING_CHARS
  return `${value.slice(0, MAX_LOG_STRING_CHARS)}...[truncated ${omitted} chars]`
}

function sanitizeForLog(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return truncateString(value)
  if (typeof value !== 'object' || value === null) return value

  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_LOG_DEPTH) return '[MaxDepth]'
  seen.add(value)

  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_LOG_ARRAY_LENGTH)
    const items = value.slice(0, limit).map((item) => sanitizeForLog(item, seen, depth + 1))
    if (value.length > limit) {
      items.push(`[+${value.length - limit} more items]`)
    }
    return items
  }

  const entries = Object.entries(value)
  const result: Record<string, unknown> = {}
  const limit = Math.min(entries.length, MAX_LOG_OBJECT_KEYS)
  for (let i = 0; i < limit; i++) {
    const [key, entryValue] = entries[i]
    result[key] = sanitizeForLog(entryValue, seen, depth + 1)
  }
  if (entries.length > limit) {
    result.__omitted__ = `+${entries.length - limit} keys`
  }
  return result
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string') return new Error(error)
  try {
    return new Error(JSON.stringify(error))
  } catch {
    return new Error(String(error))
  }
}

function collectKeys(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: readonly string[]
): void {
  for (const key of keys) {
    if (target[key] === undefined && source[key] !== undefined) {
      target[key] = source[key]
    }
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  const err = toError(error)
  const errAny = err as unknown as Record<string, unknown>

  const output: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  }

  if (isAgentMemoryError(err)) {
    output.code = err.code
    output.category = err.category
    output.severity = err.severity
    output.retryable = err.retryable
    output.context = err.context
    output.timestamp = err.timestamp?.toISOString?.() ?? err.timestamp
  }

  collectKeys(output, errAny, ERROR_TOP_LEVEL_KEYS)

  const db: Record<string, unknown> = {}
  collectKeys(db, errAny, ERROR_DB_KEYS)
  if (Object.keys(db).length > 0) {
    output.db = db
  }

  const query: Record<string, unknown> = {}
  collectKeys(query, errAny, ERROR_QUERY_KEYS)
  if (Object.keys(query).length > 0) {
    output.query = query
  }

  const meta: Record<string, unknown> = {}
  collectKeys(meta, errAny, ERROR_META_KEYS)
  if (Object.keys(meta).length > 0) {
    output.meta = meta
  }

  const cause = (err as { cause?: unknown }).cause
  if (cause) {
    output.cause = serializeError(cause)
  }

  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(errAny)) {
    if (output[key] !== undefined) continue
    if (key === 'cause') continue
    extras[key] = value
  }
  if (Object.keys(extras).length > 0) {
    output.extras = extras
  }

  if (error && typeof error === 'object' && error !== err) {
    const rawExtras: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(error as Record<string, unknown>)) {
      if (output[key] !== undefined || extras[key] !== undefined) continue
      rawExtras[key] = value
    }
    if (Object.keys(rawExtras).length > 0) {
      output.raw = rawExtras
    }
  }

  return sanitizeForLog(output) as Record<string, unknown>
}

function buildTaskContext(task: SyncTask): Record<string, unknown> {
  return sanitizeForLog({
    id: task.id,
    connector: task.connector,
    accountId: task.account_id,
    syncType: task.sync_type,
    mode: task.mode,
    entityTypes: task.entity_types,
    intervalMs: task.interval_ms,
    enabled: task.enabled,
    lastJobId: task.last_job_id,
    nextRunAt: task.next_run_at,
    webhookSubscriptionId: task.webhook_subscription_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  }) as Record<string, unknown>
}

// ============ Events ============

export type SchedulerEvent =
  | { type: 'scheduler:started' }
  | { type: 'scheduler:stopped' }
  | { type: 'scheduler:tick'; processed: number }
  | { type: 'scheduler:task_executed'; task: SyncTask; job: SyncJob }
  | { type: 'scheduler:task_disabled'; task: SyncTask }
  | { type: 'scheduler:task_error'; task: SyncTask; error: Error }
  | { type: 'scheduler:derived_task_executed'; task: DerivedTask; job: DerivedJob }
  | { type: 'scheduler:derived_task_disabled'; task: DerivedTask }
  | { type: 'scheduler:derived_task_error'; task: DerivedTask; error: Error }
  | { type: 'scheduler:agentic_task_executed'; task: AgenticTask; run: AgenticRun }
  | { type: 'scheduler:agentic_task_disabled'; task: AgenticTask }
  | { type: 'scheduler:agentic_task_error'; task: AgenticTask; error: Error }
  | { type: 'scheduler:webhook_subscribed'; task: SyncTask; subscription: WebhookSubscription }
  | { type: 'scheduler:webhook_unsubscribed'; task: SyncTask }
  | { type: 'scheduler:webhook_error'; task: SyncTask; error: Error }

// ============ Scheduler ============

/**
 * Scheduler manages the execution of sync tasks.
 *
 * Features:
 * - Poll loop for recurring and one-shot tasks
 * - Webhook subscription management
 * - Graceful shutdown
 *
 * @example
 * ```ts
 * const scheduler = new Scheduler(engine, taskRepo, authProvider, connectors, {
 *   pollInterval: 10000,
 *   webhookBaseUrl: 'https://api.example.com',
 * })
 *
 * await scheduler.start()
 *
 * // Later...
 * await scheduler.stop()
 * ```
 */
export class Scheduler {
  private config: typeof DEFAULT_CONFIG
  private isRunning = false
  private pollTimeout: NodeJS.Timeout | null = null
  private eventHandlers: Array<(event: SchedulerEvent) => void> = []

  constructor(
    private engine: SyncEngine,
    private taskRepo: SyncTaskRepository,
    private authProvider: AuthProvider,
    private connectors: Map<ConnectorType, Connector>,
    config: SchedulerConfig = {},
    private accountRepo?: AccountRepository,
    private derivedTaskRepo?: DerivedTaskRepository,
    private derivedIntegration?: DerivedTaskIntegration,
    private agenticTaskRepo?: AgenticTaskRepository,
    private agenticIntegration?: AgenticTaskIntegration,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ============ Event Handling ============

  /**
   * Add an event handler for scheduler events.
   */
  onEvent(handler: (event: SchedulerEvent) => void): this {
    this.eventHandlers.push(handler)
    return this
  }

  /**
   * Register a connector for dynamic registration.
   * Called when a connector is registered after daemon startup.
   */
  registerConnector(connector: Connector): void {
    this.connectors.set(connector.type, connector)
  }

  /**
   * Unload a connector (remove from memory).
   * Does not affect the database registration.
   */
  unloadConnector(type: ConnectorType): boolean {
    return this.connectors.delete(type)
  }

  // ============ Lifecycle ============

  /**
   * Start the scheduler loop.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Scheduler is already running')
    }

    this.isRunning = true
    this.emit({ type: 'scheduler:started' })

    // Kick an immediate tick so due tasks run without waiting for pollInterval.
    void this.tick().catch((error) => {
      console.error('[Scheduler] Initial tick error:', {
        error: serializeError(error),
        pollInterval: this.config.pollInterval,
        batchSize: this.config.batchSize,
      })
    })

    // Start the poll loop
    this.schedulePoll()
  }

  /**
   * Stop the scheduler gracefully.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    this.isRunning = false

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout)
      this.pollTimeout = null
    }

    this.emit({ type: 'scheduler:stopped' })
  }

  /**
   * Check if the scheduler is running.
   */
  get running(): boolean {
    return this.isRunning
  }

  // ============ Manual Execution ============

  /**
   * Process due tasks immediately.
   * Returns the number of tasks processed.
   * Useful for testing or manual triggers.
   */
  async tick(): Promise<number> {
    const tasks = await this.taskRepo.findDueForExecution(this.config.batchSize)
    let processed = 0

    for (const task of tasks) {
      try {
        await this.executeTask(task)
        processed++
        console.log('[Scheduler] Task executed:', {
          taskId: task.id,
          connector: task.connector,
          accountId: task.account_id,
          syncType: task.sync_type,
          mode: task.mode,
        })
      } catch (error) {
        const err = toError(error)
        console.error('[Scheduler] Task error:', {
          task: buildTaskContext(task),
          error: serializeError(error),
        })
        this.emit({
          type: 'scheduler:task_error',
          task,
          error: err,
        })
      }
    }

    processed += await this.tickDerivedTasks()
    processed += await this.tickAgenticTasks()

    this.emit({ type: 'scheduler:tick', processed })
    return processed
  }

  // ============ Webhook Management ============

  /**
   * Ensure webhook subscriptions are active for all webhook tasks.
   */
  async ensureWebhookSubscriptions(): Promise<void> {
    const tasks = await this.taskRepo.findWebhookTasks()

    for (const task of tasks) {
      if (!task.webhook_subscription_id) {
        try {
          await this.subscribeTask(task.id)
        } catch (error) {
          console.error('[Scheduler] Webhook subscription error:', {
            task: buildTaskContext(task),
            webhookBaseUrl: this.config.webhookBaseUrl,
            error: serializeError(error),
          })
          const err = toError(error)
          this.emit({
            type: 'scheduler:webhook_error',
            task,
            error: err,
          })
        }
      }
    }
  }

  /**
   * Subscribe a specific task to webhooks.
   */
  async subscribeTask(taskId: string): Promise<string> {
    const task = await this.taskRepo.findById(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    if (task.mode !== 'webhook') {
      throw new Error(`Task ${taskId} is not a webhook task`)
    }

    const connector = this.connectors.get(task.connector)
    if (!connector) {
      throw new Error(`Connector not registered: ${task.connector}`)
    }

    if (!connector.subscribe) {
      throw new Error(`Connector ${task.connector} does not support webhooks`)
    }

    if (!this.config.webhookBaseUrl) {
      throw new Error('webhookBaseUrl is required for webhook subscriptions')
    }

    let ctx: ConnectorContext
    if (connector.authConfig.type === 'local') {
      ctx = { accountId: task.account_id }
    } else if (connector.authConfig.type === 'credential_reference') {
      if (!this.authProvider) {
        throw new Error('Auth provider required for credential_reference connector')
      }
      ctx = await this.authProvider.getContext(
        connector.authConfig.accountId,
        connector.authConfig.additionalScopes ?? []
      )
    } else {
      if (!this.authProvider) {
        throw new Error('Auth provider is not configured')
      }
      ctx = await this.authProvider.getContext(task.account_id)
    }
    const callbackUrl = `${this.config.webhookBaseUrl}/webhooks/${task.connector}/${task.account_id}`

    const subscription = await connector.subscribe(ctx, callbackUrl, {
      entityTypes: task.entity_types ?? undefined,
    })

    await this.taskRepo.setWebhookSubscriptionId(task.id, subscription.subscriptionId)

    this.emit({ type: 'scheduler:webhook_subscribed', task, subscription })

    return subscription.subscriptionId
  }

  /**
   * Unsubscribe a task from webhooks.
   */
  async unsubscribeTask(taskId: string): Promise<void> {
    const task = await this.taskRepo.findById(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    if (!task.webhook_subscription_id) {
      return // Already unsubscribed
    }

    const connector = this.connectors.get(task.connector)
    if (!connector) {
      throw new Error(`Connector not registered: ${task.connector}`)
    }

    if (connector.unsubscribe) {
      let ctx: ConnectorContext
      if (connector.authConfig.type === 'local') {
        ctx = { accountId: task.account_id }
      } else if (connector.authConfig.type === 'credential_reference') {
        if (!this.authProvider) {
          throw new Error('Auth provider required for credential_reference connector')
        }
        ctx = await this.authProvider.getContext(
          connector.authConfig.accountId,
          connector.authConfig.additionalScopes ?? []
        )
      } else {
        if (!this.authProvider) {
          throw new Error('Auth provider is not configured')
        }
        ctx = await this.authProvider.getContext(task.account_id)
      }
      await connector.unsubscribe(ctx, task.webhook_subscription_id)
    }

    await this.taskRepo.setWebhookSubscriptionId(task.id, null)

    this.emit({ type: 'scheduler:webhook_unsubscribed', task })
  }

  /**
   * Renew webhook subscription for a task.
   */
  async renewSubscription(taskId: string): Promise<WebhookSubscription> {
    const task = await this.taskRepo.findById(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    if (!task.webhook_subscription_id) {
      // No existing subscription, create new one
      const subscriptionId = await this.subscribeTask(taskId)
      return { subscriptionId }
    }

    const connector = this.connectors.get(task.connector)
    if (!connector) {
      throw new Error(`Connector not registered: ${task.connector}`)
    }

    if (!connector.renewSubscription) {
      // Connector doesn't support renewal, unsubscribe and resubscribe
      await this.unsubscribeTask(taskId)
      const subscriptionId = await this.subscribeTask(taskId)
      return { subscriptionId }
    }

    let ctx: ConnectorContext
    if (connector.authConfig.type === 'local') {
      ctx = { accountId: task.account_id }
    } else if (connector.authConfig.type === 'credential_reference') {
      if (!this.authProvider) {
        throw new Error('Auth provider required for credential_reference connector')
      }
      ctx = await this.authProvider.getContext(
        connector.authConfig.accountId,
        connector.authConfig.additionalScopes ?? []
      )
    } else {
      if (!this.authProvider) {
        throw new Error('Auth provider is not configured')
      }
      ctx = await this.authProvider.getContext(task.account_id)
    }
    const subscription = await connector.renewSubscription(ctx, task.webhook_subscription_id)

    await this.taskRepo.setWebhookSubscriptionId(task.id, subscription.subscriptionId)

    this.emit({ type: 'scheduler:webhook_subscribed', task, subscription })

    return subscription
  }

  // ============ Internal ============

  private schedulePoll(): void {
    if (!this.isRunning) return

    this.pollTimeout = setTimeout(async () => {
      try {
        await this.tick()
      } catch (error) {
        // Log error but continue polling
        console.error('[Scheduler] Poll error:', {
          error: serializeError(error),
          pollInterval: this.config.pollInterval,
          batchSize: this.config.batchSize,
        })
      }

      this.schedulePoll()
    }, this.config.pollInterval)
  }

  private async executeTask(task: SyncTask): Promise<void> {
    // Verify account exists and get connector
    const connector = this.connectors.get(task.connector)
    if (!connector) {
      throw new Error(`Connector not registered: ${task.connector}`)
    }

    // Schedule the appropriate sync job
    let job: SyncJob
    if (task.sync_type === 'backfill') {
      job = await this.engine.scheduleBackfill(task.connector, task.account_id, {
        entityTypes: task.entity_types ?? undefined,
      })
    } else {
      // Look up account's sync_cursor for incremental syncs
      let cursor = this.accountRepo
        ? (await this.accountRepo.findById(task.account_id))?.sync_cursor
        : undefined

      // Guard against bloated cursors (e.g. from past double-wrapping bugs).
      // A valid cursor is < 1 KB; anything over 64 KB is corrupt data.
      if (cursor && Buffer.byteLength(cursor, 'utf8') > 64 * 1024) {
        console.error('[Scheduler] Corrupt sync_cursor detected, resetting', {
          taskId: task.id,
          connector: task.connector,
          accountId: task.account_id,
          cursorBytes: Buffer.byteLength(cursor, 'utf8'),
        })
        // Clear the corrupt cursor so it doesn't poison future runs
        if (this.accountRepo) {
          await this.accountRepo.updateSyncState(task.account_id, undefined)
        }
        cursor = undefined
      }

      job = await this.engine.scheduleIncremental(task.connector, task.account_id, cursor, {
        entityTypes: task.entity_types ?? undefined,
      })
    }

    // Update task state based on mode
    await this.taskRepo.markExecuted(task.id, job.id)

    if (task.mode === 'once') {
      // One-shot tasks are disabled after execution
      await this.taskRepo.update(task.id, { enabled: false })
      this.emit({ type: 'scheduler:task_disabled', task })
    } else if (task.mode === 'recurring' && task.interval_ms) {
      // Update next_run_at for recurring tasks
      const nextRunAt = new Date(Date.now() + task.interval_ms)
      await this.taskRepo.updateNextRunAt(task.id, nextRunAt)
    }

    this.emit({ type: 'scheduler:task_executed', task, job })
  }

  private async tickDerivedTasks(): Promise<number> {
    if (!this.derivedTaskRepo || !this.derivedIntegration) return 0

    const tasks = await this.derivedTaskRepo.findDueForExecution(this.config.batchSize)
    let processed = 0

    for (const task of tasks) {
      try {
        await this.executeDerivedTask(task)
        processed++
        console.log('[Scheduler] Derived task executed:', {
          taskId: task.id,
          name: task.name,
          mode: task.mode,
        })
      } catch (error) {
        const err = toError(error)
        console.error('[Scheduler] Derived task error:', {
          task: sanitizeForLog(task),
          error: serializeError(error),
        })
        this.emit({
          type: 'scheduler:derived_task_error',
          task,
          error: err,
        })
      }
    }

    return processed
  }

  private async executeDerivedTask(task: DerivedTask): Promise<void> {
    if (!this.derivedIntegration || !this.derivedTaskRepo) {
      throw new Error('Derived task integration is not configured')
    }

    const result = await this.derivedIntegration.scheduleTask(this.engine, task)

    // Skip if blocked by policy
    if (DerivedTaskIntegration.isBlocked(result)) {
      this.emit({
        type: 'scheduler:derived_task_blocked',
        task,
        reason: result.reason,
        retryAfter: result.retryAfter,
      } as any) // Cast needed as this is a new event type
      return
    }

    const job = result
    await this.derivedTaskRepo.markExecuted(task.id, job.id)

    if (task.mode === 'once') {
      await this.derivedTaskRepo.update(task.id, { enabled: false })
      this.emit({ type: 'scheduler:derived_task_disabled', task })
    } else if (task.mode === 'recurring' && task.interval_ms) {
      const nextRunAt = new Date(Date.now() + task.interval_ms)
      await this.derivedTaskRepo.updateNextRunAt(task.id, nextRunAt)
    }

    this.emit({ type: 'scheduler:derived_task_executed', task, job })
  }

  private async tickAgenticTasks(): Promise<number> {
    if (!this.agenticTaskRepo || !this.agenticIntegration) return 0

    const tasks = await this.agenticTaskRepo.findDueForExecution(this.config.batchSize)
    let processed = 0

    for (const task of tasks) {
      try {
        const run = await this.agenticIntegration.scheduleTask(this.engine, task)
        if (!run) continue // Already has active run

        await this.agenticTaskRepo.markExecuted(task.id, run.id)

        if (task.mode === 'once') {
          await this.agenticTaskRepo.disable(task.id)
          this.emit({ type: 'scheduler:agentic_task_disabled', task })
        } else if (task.mode === 'recurring' && task.intervalMs) {
          await this.agenticTaskRepo.updateNextRunAt(task.id, new Date(Date.now() + task.intervalMs))
        }

        this.emit({ type: 'scheduler:agentic_task_executed', task, run })
        processed++

        console.log('[Scheduler] Agentic task executed:', {
          taskId: task.id,
          name: task.name,
          mode: task.mode,
        })
      } catch (error) {
        const err = toError(error)
        console.error('[Scheduler] Agentic task error:', {
          task: sanitizeForLog(task),
          error: serializeError(error),
        })
        this.emit({ type: 'scheduler:agentic_task_error', task, error: err })
      }
    }

    return processed
  }

  private emit(event: SchedulerEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch {
        // Ignore handler errors
      }
    }
  }
}
