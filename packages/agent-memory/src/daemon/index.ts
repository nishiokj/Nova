/**
 * Sync Daemon
 *
 * Top-level class that composes all sync components into a complete daemon service.
 * Provides HTTP API, scheduled syncing, and webhook handling.
 */

import type { Sql } from 'postgres'
import type { ConnectorType } from '../ids.js'
import type { Connector } from '../connector/sdk/types.js'
import type { AuthProvider } from '../auth/provider.js'
import type { Account, AccountRepository } from '../db/repositories/account.js'
import type { SyncJob, SyncJobRepository } from '../db/repositories/sync-job.js'
import type { SyncTask, SyncTaskRepository } from '../db/repositories/sync-task.js'
import type { RawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import type { CanonicalEntityRepository } from '../db/repositories/canonical-entity.js'
import type { EntitySourceMappingRepository } from '../db/repositories/entity-source-mapping.js'
import { createAccountRepository } from '../db/repositories/account.js'
import { createSyncJobRepository } from '../db/repositories/sync-job.js'
import { createSyncTaskRepository } from '../db/repositories/sync-task.js'
import { createRawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import { createCanonicalEntityRepository } from '../db/repositories/canonical-entity.js'
import { createEntitySourceMappingRepository } from '../db/repositories/entity-source-mapping.js'
import { SyncEngine, type SyncEngineConfig } from '../sync/engine.js'
import { Collector } from '../sync/collector.js'
import { Scheduler, type SchedulerConfig } from '../sync/scheduler.js'
import { DatabaseAuthProvider, type AuthProviderConfig } from '../auth/provider.js'
import { OAuthProviderRegistry, oauthProviders } from '../auth/oauth-providers.js'
import { HttpServer, type ServerConfig } from './server.js'
import { registerRoutes } from './routes/index.js'

// ============ Configuration ============

export interface DaemonConfig {
  /** PostgreSQL connection */
  sql: Sql
  /** Encryption key for credentials (32 bytes) */
  encryptionKey: Buffer
  /** HTTP server port */
  port: number
  /** Host to bind to (default: '0.0.0.0') */
  host?: string
  /** Base URL for webhook callbacks (e.g., 'https://api.example.com') */
  webhookBaseUrl: string
  /** Base path for API routes (default: '/api') */
  basePath?: string
  /** Scheduler config */
  scheduler?: SchedulerConfig
  /** Engine config */
  engine?: SyncEngineConfig
}

// ============ Sync Daemon ============

/**
 * SyncDaemon is the main entry point for running the sync service.
 *
 * It composes:
 * - HTTP Server for REST API
 * - SyncEngine for job execution
 * - Scheduler for recurring tasks
 * - AuthProvider for credential management
 *
 * @example
 * ```ts
 * const daemon = await SyncDaemon.create({
 *   sql,
 *   encryptionKey: Buffer.from(process.env.ENCRYPTION_KEY, 'hex'),
 *   port: 3001,
 *   webhookBaseUrl: 'https://api.example.com',
 * })
 *
 * daemon.registerConnector(new GmailConnector())
 * await daemon.start()
 *
 * // Later...
 * await daemon.stop()
 * ```
 */
export class SyncDaemon {
  // Public readonly access to internal components
  readonly engine: SyncEngine
  readonly scheduler: Scheduler
  readonly authProvider: AuthProvider
  readonly collector: Collector
  readonly oauthProviders: OAuthProviderRegistry

  // Repositories (exposed for route handlers)
  readonly accountRepo: AccountRepository
  readonly syncJobRepo: SyncJobRepository
  readonly taskRepo: SyncTaskRepository
  readonly envelopeRepo: RawEnvelopeRepository
  readonly entityRepo: CanonicalEntityRepository
  readonly mappingRepo: EntitySourceMappingRepository

  readonly server: HttpServer
  private connectors: Map<ConnectorType, Connector> = new Map()
  private config: DaemonConfig
  private isRunning = false

  private constructor(
    config: DaemonConfig,
    server: HttpServer,
    engine: SyncEngine,
    scheduler: Scheduler,
    authProvider: AuthProvider,
    collector: Collector,
    oauthProviderRegistry: OAuthProviderRegistry,
    accountRepo: AccountRepository,
    syncJobRepo: SyncJobRepository,
    taskRepo: SyncTaskRepository,
    envelopeRepo: RawEnvelopeRepository,
    entityRepo: CanonicalEntityRepository,
    mappingRepo: EntitySourceMappingRepository
  ) {
    this.config = config
    this.server = server
    this.engine = engine
    this.scheduler = scheduler
    this.authProvider = authProvider
    this.collector = collector
    this.oauthProviders = oauthProviderRegistry
    this.accountRepo = accountRepo
    this.syncJobRepo = syncJobRepo
    this.taskRepo = taskRepo
    this.envelopeRepo = envelopeRepo
    this.entityRepo = entityRepo
    this.mappingRepo = mappingRepo
  }

  /**
   * Create a new daemon instance.
   * Does not start any background processes.
   */
  static async create(config: DaemonConfig): Promise<SyncDaemon> {
    const { sql, encryptionKey, port, host, basePath, webhookBaseUrl } = config

    // Initialize OAuth providers from environment
    const loadedProviders = oauthProviders.loadAllFromEnv()
    if (loadedProviders.length > 0) {
      console.log(`[daemon] Loaded OAuth providers: ${loadedProviders.join(', ')}`)
    }

    // Create repositories
    const ctx = { sql }
    const accountRepo = createAccountRepository(ctx)
    const syncJobRepo = createSyncJobRepository(ctx)
    const taskRepo = createSyncTaskRepository(ctx)
    const envelopeRepo = createRawEnvelopeRepository(ctx)
    const entityRepo = createCanonicalEntityRepository(ctx)
    const mappingRepo = createEntitySourceMappingRepository(ctx)

    // Create auth provider with connector registry
    const connectors = new Map<ConnectorType, Connector>()
    const authProvider = new DatabaseAuthProvider({
      encryptionKey,
      accountRepo,
      getConnector: (type) => connectors.get(type),
    })

    // Create engine
    const engine = new SyncEngine(sql, {
      ...config.engine,
      authProvider,
    })

    // Create collector (for direct webhook ingestion)
    const collector = new Collector(sql, {
      authProvider,
    })

    // Create scheduler
    const scheduler = new Scheduler(
      engine,
      taskRepo,
      authProvider,
      connectors,
      {
        ...config.scheduler,
        webhookBaseUrl,
      }
    )

    // Create HTTP server
    const server = new HttpServer({
      port,
      ...(host && { host }),
      ...(basePath && { basePath }),
    })

    const daemon = new SyncDaemon(
      config,
      server,
      engine,
      scheduler,
      authProvider,
      collector,
      oauthProviders,
      accountRepo,
      syncJobRepo,
      taskRepo,
      envelopeRepo,
      entityRepo,
      mappingRepo
    )

    // Store connectors map reference in daemon for registration
    ;(daemon as any)._connectors = connectors

    // Register routes
    registerRoutes(server, daemon)

    return daemon
  }

  /**
   * Register a connector.
   * Must be called before start().
   */
  registerConnector(connector: Connector): this {
    this.connectors.set(connector.type, connector)
    ;(this as any)._connectors?.set(connector.type, connector)
    this.engine.registerConnector(connector)
    this.collector.registerConnector(connector)
    return this
  }

  /**
   * Get a registered connector.
   */
  getConnector(type: ConnectorType): Connector | undefined {
    return this.connectors.get(type)
  }

  /**
   * Check if a connector is registered.
   */
  hasConnector(type: ConnectorType): boolean {
    return this.connectors.has(type)
  }

  /**
   * Start all daemon components.
   * - HTTP server
   * - SyncEngine (queue worker)
   * - Scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Daemon is already running')
    }

    // Start in order: server → engine → scheduler
    await this.server.start()
    await this.engine.start()
    await this.scheduler.start()

    this.isRunning = true
  }

  /**
   * Stop all components gracefully.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    // Stop in reverse order: scheduler → engine → server
    await this.scheduler.stop()
    await this.engine.stop()
    await this.server.stop()

    this.isRunning = false
  }

  /**
   * Check if daemon is running.
   */
  get running(): boolean {
    return this.isRunning
  }

  /**
   * Get the port the server is listening on.
   */
  get port(): number {
    return this.config.port
  }

  // ============ Convenience Methods ============

  /**
   * Create a one-shot backfill task and schedule immediately.
   */
  async backfill(
    accountId: string,
    options: { entityTypes?: string[] } = {}
  ): Promise<{ task: SyncTask; job: SyncJob }> {
    // Get account to determine connector
    const account = await this.accountRepo.findById(accountId)
    if (!account) {
      throw new Error(`Account not found: ${accountId}`)
    }

    // Create task
    const task = await this.taskRepo.create({
      connector: account.connector,
      accountId,
      entityTypes: options.entityTypes,
      syncType: 'backfill',
      mode: 'once',
    })

    // Schedule job immediately
    const job = await this.engine.scheduleBackfill(account.connector, accountId, {
      entityTypes: options.entityTypes,
    })

    // Update task with job ID and disable (one-shot)
    await this.taskRepo.markExecuted(task.id, job.id)
    await this.taskRepo.update(task.id, { enabled: false })

    const updatedTask = await this.taskRepo.findById(task.id)
    return { task: updatedTask!, job }
  }

  /**
   * Create a recurring sync task.
   */
  async subscribe(
    accountId: string,
    options: {
      syncType: 'backfill' | 'incremental'
      entityTypes?: string[]
      intervalMs: number
    }
  ): Promise<SyncTask> {
    // Get account to determine connector
    const account = await this.accountRepo.findById(accountId)
    if (!account) {
      throw new Error(`Account not found: ${accountId}`)
    }

    const task = await this.taskRepo.create({
      connector: account.connector,
      accountId,
      entityTypes: options.entityTypes,
      syncType: options.syncType,
      mode: 'recurring',
      intervalMs: options.intervalMs,
    })

    return task
  }

  /**
   * Create a webhook-driven sync task.
   */
  async subscribeWebhook(
    accountId: string,
    options: { entityTypes?: string[] } = {}
  ): Promise<SyncTask> {
    // Get account to determine connector
    const account = await this.accountRepo.findById(accountId)
    if (!account) {
      throw new Error(`Account not found: ${accountId}`)
    }

    const task = await this.taskRepo.create({
      connector: account.connector,
      accountId,
      entityTypes: options.entityTypes,
      syncType: 'incremental',
      mode: 'webhook',
    })

    // Subscribe to webhooks
    await this.scheduler.subscribeTask(task.id)

    const updatedTask = await this.taskRepo.findById(task.id)
    return updatedTask!
  }

  /**
   * Cancel a task.
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = await this.taskRepo.findById(taskId)
    if (!task) {
      return false
    }

    // Unsubscribe from webhooks if applicable
    if (task.mode === 'webhook' && task.webhook_subscription_id) {
      try {
        await this.scheduler.unsubscribeTask(taskId)
      } catch {
        // Ignore unsubscribe errors during cancellation
      }
    }

    // Disable the task
    await this.taskRepo.update(taskId, { enabled: false })
    return true
  }

  /**
   * Get OAuth URL for a connector.
   */
  getAuthUrl(connector: ConnectorType, redirectUri: string, state?: string): string {
    const connectorInstance = this.connectors.get(connector)
    if (!connectorInstance) {
      throw new Error(`Connector not registered: ${connector}`)
    }

    if (!connectorInstance.getAuthorizationUrl) {
      throw new Error(`Connector ${connector} does not support OAuth`)
    }

    const authState = state || Math.random().toString(36).substring(2)
    return connectorInstance.getAuthorizationUrl(authState, redirectUri)
  }

  /**
   * Handle OAuth callback.
   * Creates or updates account with new credentials.
   */
  async handleAuthCallback(
    connector: ConnectorType,
    code: string,
    redirectUri: string
  ): Promise<Account> {
    const connectorInstance = this.connectors.get(connector)
    if (!connectorInstance) {
      throw new Error(`Connector not registered: ${connector}`)
    }

    if (!connectorInstance.exchangeCodeForTokens) {
      throw new Error(`Connector ${connector} does not support OAuth`)
    }

    // Exchange code for tokens
    const tokens = await connectorInstance.exchangeCodeForTokens(code, redirectUri)

    // Get account info
    const ctx = {
      accountId: 'temp', // Temporary until we create the account
      accessToken: tokens.accessToken,
    }

    const accounts = await connectorInstance.listAccounts(ctx)
    const primaryAccount = accounts.find((a) => a.isPrimary) || accounts[0]

    if (!primaryAccount) {
      throw new Error('No account found after OAuth')
    }

    // Check if account already exists
    let account = await this.accountRepo.findByConnector(connector, primaryAccount.externalId)

    if (!account) {
      // Create new account
      account = await this.accountRepo.create({
        connector,
        external_account_id: primaryAccount.externalId,
        display_name: primaryAccount.displayName,
        email: primaryAccount.email,
        auth_type: 'oauth2',
      })
    }

    // Store credentials
    await this.authProvider.storeCredentials(account.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    })

    // Activate the account
    await this.accountRepo.activate(account.id)

    return (await this.accountRepo.findById(account.id))!
  }

  /**
   * Create account with pre-exchanged tokens.
   * Used when tokens are obtained via centralized OAuth provider registry.
   */
  async createAccountWithTokens(
    connector: ConnectorType,
    tokens: {
      accessToken: string
      refreshToken?: string
      expiresIn?: number
      scope?: string
    },
    scopes: string[]
  ): Promise<Account> {
    const connectorInstance = this.connectors.get(connector)
    if (!connectorInstance) {
      throw new Error(`Connector not registered: ${connector}`)
    }

    // Get account info using the access token
    const ctx = {
      accountId: 'temp', // Temporary until we create the account
      accessToken: tokens.accessToken,
    }

    const accounts = await connectorInstance.listAccounts(ctx)
    const primaryAccount = accounts.find((a) => a.isPrimary) || accounts[0]

    if (!primaryAccount) {
      throw new Error('No account found after OAuth')
    }

    // Check if account already exists
    let account = await this.accountRepo.findByConnector(connector, primaryAccount.externalId)

    if (!account) {
      // Create new account
      account = await this.accountRepo.create({
        connector,
        external_account_id: primaryAccount.externalId,
        display_name: primaryAccount.displayName,
        email: primaryAccount.email,
        auth_type: 'oauth2',
      })
    }

    // Calculate expiration time
    const expiresAt = tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000)
      : undefined

    // Store credentials
    await this.authProvider.storeCredentials(account.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt,
    })

    // Activate the account
    await this.accountRepo.activate(account.id)

    return (await this.accountRepo.findById(account.id))!
  }
}

// Re-export server and scheduler types
export { HttpServer, type ServerConfig, type ParsedRequest, type RouteHandler, type RouteResponse } from './server.js'
export { Scheduler, type SchedulerConfig, type SchedulerEvent } from '../sync/scheduler.js'
