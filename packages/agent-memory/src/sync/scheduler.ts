/**
 * Scheduler
 *
 * Poll loop that triggers sync jobs based on task schedules.
 * Manages webhook subscriptions for real-time updates.
 */

import type { ConnectorType } from '../ids.js'
import type { AuthProvider } from '../auth/provider.js'
import type { Connector, WebhookSubscription } from '../connector/sdk/types.js'
import type { SyncTask, SyncTaskRepository } from '../db/repositories/sync-task.js'
import type { SyncEngine } from './engine.js'
import type { SyncJob } from '../db/repositories/sync-job.js'

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

// ============ Events ============

export type SchedulerEvent =
  | { type: 'scheduler:started' }
  | { type: 'scheduler:stopped' }
  | { type: 'scheduler:tick'; processed: number }
  | { type: 'scheduler:task_executed'; task: SyncTask; job: SyncJob }
  | { type: 'scheduler:task_disabled'; task: SyncTask }
  | { type: 'scheduler:task_error'; task: SyncTask; error: Error }
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
    config: SchedulerConfig = {}
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
      } catch (error) {
        this.emit({
          type: 'scheduler:task_error',
          task,
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    }

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
          this.emit({
            type: 'scheduler:webhook_error',
            task,
            error: error instanceof Error ? error : new Error(String(error)),
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

    const ctx = await this.authProvider.getContext(task.account_id)
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
      const ctx = await this.authProvider.getContext(task.account_id)
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

    const ctx = await this.authProvider.getContext(task.account_id)
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
        console.error('[Scheduler] Poll error:', error)
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
      job = await this.engine.scheduleIncremental(task.connector, task.account_id, undefined, {
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
