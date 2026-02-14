/**
 * Sync Daemon
 *
 * Top-level class that composes all sync components into a complete daemon service.
 * Provides HTTP API, scheduled syncing, and webhook handling.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type { Sql } from 'postgres'
import { computeIdempotencyKeys, computeRawDataHash, generateCanonicalId, type ConnectorType } from '../ids.js'
import type { OAuthProviderId } from '../auth/oauth-providers.js'
import type { Connector, ConnectorContext, SyncEstimate } from '../connector/sdk/types.js'
import type { AuthProvider } from '../auth/provider.js'
import type { Account, AccountRepository } from '../db/repositories/account.js'
import type { SyncJob, SyncJobRepository } from '../db/repositories/sync-job.js'
import type { SyncTask, SyncTaskRepository } from '../db/repositories/sync-task.js'
import type { DerivedJob, DerivedJobRepository } from '../db/repositories/derived-job.js'
import type { DerivedTask, DerivedTaskRepository } from '../db/repositories/derived-task.js'
import type { RawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import type { CanonicalEntityRepository } from '../db/repositories/canonical-entity.js'
import type { EntitySourceMappingRepository } from '../db/repositories/entity-source-mapping.js'
import type { RegisteredConnectorRepository, RegisteredConnector } from '../db/repositories/registered-connector.js'
import type { CodingPreferencesRepository } from '../db/repositories/coding-preferences.js'
import type { CodingDecisionsRepository } from '../db/repositories/coding-decisions.js'
import type { AgentGoalsRepository } from '../db/repositories/agent-goals.js'
import type { AgentActionsRepository } from '../db/repositories/agent-actions.js'
import type { RawEnvelope } from '../models/raw.js'
import { validateEntity, type EntityType } from '../models/canonical.js'
import { createAccountRepository } from '../db/repositories/account.js'
import { createSyncJobRepository } from '../db/repositories/sync-job.js'
import { createSyncTaskRepository } from '../db/repositories/sync-task.js'
import { createDerivedJobRepository } from '../db/repositories/derived-job.js'
import { createDerivedTaskRepository } from '../db/repositories/derived-task.js'
import { createRawEnvelopeRepository } from '../db/repositories/raw-envelope.js'
import { createCanonicalEntityRepository } from '../db/repositories/canonical-entity.js'
import { createEntitySourceMappingRepository } from '../db/repositories/entity-source-mapping.js'
import { createRegisteredConnectorRepository } from '../db/repositories/registered-connector.js'
import { createCodingPreferencesRepository } from '../db/repositories/coding-preferences.js'
import { createCodingDecisionsRepository } from '../db/repositories/coding-decisions.js'
import { createAgentGoalsRepository } from '../db/repositories/agent-goals.js'
import { createAgentActionsRepository } from '../db/repositories/agent-actions.js'
import { createAgentTracesRepository } from '../db/repositories/agent-traces.js'
import type { AgentTracesRepository } from '../db/repositories/agent-traces.js'
import { createEscalationsRepository } from '../db/repositories/escalations.js'
import type { EscalationsRepository } from '../db/repositories/escalations.js'
import { createAgenticTaskRepository } from '../db/repositories/agentic-task.js'
import type { AgenticTaskRepository } from '../db/repositories/agentic-task.js'
import { createAgenticRunRepository } from '../db/repositories/agentic-run.js'
import type { AgenticRunRepository } from '../db/repositories/agentic-run.js'
import { createResearchRepository } from '../db/repositories/research.js'
import type { ResearchRepository } from '../db/repositories/research.js'
import { AgenticTaskIntegration, type AgenticIntegrationConfig } from '../agentic/integration.js'
import { SyncEngine, type SyncEngineConfig } from '../sync/engine.js'
import { Collector } from '../sync/collector.js'
import { Scheduler, type SchedulerConfig } from '../sync/scheduler.js'
import { DerivedTaskIntegration, type DerivedIntegrationConfig } from '../derived/integration.js'
import { DatabaseAuthProvider, type AuthProviderConfig } from '../auth/provider.js'
import { OAuthProviderRegistry, oauthProviders } from '../auth/oauth-providers.js'
import { HttpServer, type ServerConfig } from './server.js'
import { registerRoutes } from './routes/index.js'
import { createConnector, listFactoryTypes, hasFactory, type LoadConnectorsResult } from '../connectors/registry.js'
import { TransformationRegistry } from '../transform/registry.js'

// ============ Internal Event Types ============

export interface InternalEvent {
  type: string
  source?: 'webhook' | 'scheduler' | 'engine' | 'daemon'
  timestamp: string
  data?: Record<string, unknown>
}

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
  /** Derived task integration config */
  derived?: DerivedIntegrationConfig
  /** Agentic task integration config */
  agentic?: AgenticIntegrationConfig
}

interface AuthStatePayload {
  connector: string
  redirectUri: string
  issuedAt: number
  nonce: string
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
  readonly sql: Sql
  readonly engine: SyncEngine
  readonly scheduler: Scheduler
  readonly derivedIntegration: DerivedTaskIntegration
  readonly authProvider: AuthProvider
  readonly collector: Collector
  readonly oauthProviders: OAuthProviderRegistry

  // Repositories (exposed for route handlers)
  readonly accountRepo: AccountRepository
  readonly syncJobRepo: SyncJobRepository
  readonly taskRepo: SyncTaskRepository
  readonly derivedJobRepo: DerivedJobRepository
  readonly derivedTaskRepo: DerivedTaskRepository
  readonly envelopeRepo: RawEnvelopeRepository
  readonly entityRepo: CanonicalEntityRepository
  readonly mappingRepo: EntitySourceMappingRepository
  readonly connectorRepo: RegisteredConnectorRepository
  readonly preferencesRepo: CodingPreferencesRepository
  readonly decisionsRepo: CodingDecisionsRepository
  readonly goalsRepo: AgentGoalsRepository
  readonly actionsRepo: AgentActionsRepository
  readonly tracesRepo: AgentTracesRepository
  readonly escalationsRepo: EscalationsRepository
  readonly agenticTaskRepo: AgenticTaskRepository
  readonly agenticRunRepo: AgenticRunRepository
  readonly agenticIntegration: AgenticTaskIntegration
  readonly researchRepo: ResearchRepository

  readonly server: HttpServer
  private connectors: Map<ConnectorType, Connector> = new Map()
  private config: DaemonConfig
  private isRunning = false
  private registeredConnectorsLoaded = false
  private internalEventHandlers: Array<(event: InternalEvent) => void> = []

  private constructor(
    config: DaemonConfig,
    server: HttpServer,
    engine: SyncEngine,
    scheduler: Scheduler,
    derivedIntegration: DerivedTaskIntegration,
    authProvider: AuthProvider,
    collector: Collector,
    oauthProviderRegistry: OAuthProviderRegistry,
    accountRepo: AccountRepository,
    syncJobRepo: SyncJobRepository,
    taskRepo: SyncTaskRepository,
    derivedJobRepo: DerivedJobRepository,
    derivedTaskRepo: DerivedTaskRepository,
    envelopeRepo: RawEnvelopeRepository,
    entityRepo: CanonicalEntityRepository,
    mappingRepo: EntitySourceMappingRepository,
    connectorRepo: RegisteredConnectorRepository,
    preferencesRepo: CodingPreferencesRepository,
    decisionsRepo: CodingDecisionsRepository,
    goalsRepo: AgentGoalsRepository,
    actionsRepo: AgentActionsRepository,
    tracesRepo: AgentTracesRepository,
    escalationsRepo: EscalationsRepository,
    agenticTaskRepo: AgenticTaskRepository,
    agenticRunRepo: AgenticRunRepository,
    agenticIntegration: AgenticTaskIntegration,
    researchRepo: ResearchRepository,
  ) {
    this.config = config
    this.sql = config.sql
    this.server = server
    this.engine = engine
    this.scheduler = scheduler
    this.derivedIntegration = derivedIntegration
    this.authProvider = authProvider
    this.collector = collector
    this.oauthProviders = oauthProviderRegistry
    this.accountRepo = accountRepo
    this.syncJobRepo = syncJobRepo
    this.taskRepo = taskRepo
    this.derivedJobRepo = derivedJobRepo
    this.derivedTaskRepo = derivedTaskRepo
    this.envelopeRepo = envelopeRepo
    this.entityRepo = entityRepo
    this.mappingRepo = mappingRepo
    this.connectorRepo = connectorRepo
    this.preferencesRepo = preferencesRepo
    this.decisionsRepo = decisionsRepo
    this.goalsRepo = goalsRepo
    this.actionsRepo = actionsRepo
    this.tracesRepo = tracesRepo
    this.escalationsRepo = escalationsRepo
    this.agenticTaskRepo = agenticTaskRepo
    this.agenticRunRepo = agenticRunRepo
    this.agenticIntegration = agenticIntegration
    this.researchRepo = researchRepo
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
    const derivedJobRepo = createDerivedJobRepository(ctx)
    const derivedTaskRepo = createDerivedTaskRepository(ctx)
    const envelopeRepo = createRawEnvelopeRepository(ctx)
    const entityRepo = createCanonicalEntityRepository(ctx)
    const mappingRepo = createEntitySourceMappingRepository(ctx)
    const connectorRepo = createRegisteredConnectorRepository(ctx)
    const preferencesRepo = createCodingPreferencesRepository(ctx)
    const decisionsRepo = createCodingDecisionsRepository(ctx)
    const goalsRepo = createAgentGoalsRepository(ctx)
    const actionsRepo = createAgentActionsRepository(ctx)
    const tracesRepo = createAgentTracesRepository(ctx)
    const escalationsRepo = createEscalationsRepository(ctx)
    const agenticTaskRepo = createAgenticTaskRepository(ctx)
    const agenticRunRepo = createAgenticRunRepository(ctx)
    const researchRepo = createResearchRepository(ctx)

    // Create auth provider with connector registry
    const connectors = new Map<ConnectorType, Connector>()
    const authProvider = new DatabaseAuthProvider({
      encryptionKey,
      accountRepo,
      getConnector: (type) => connectors.get(type),
      oauthProviders,
    })

    // Create engine
    const engine = new SyncEngine(sql, {
      ...config.engine,
      authProvider,
      collector: {
        ...config.engine?.collector,
        accountRepo,
      },
    })

    // Create derived task integration (uses shared queue)
    const derivedIntegration = new DerivedTaskIntegration(sql, config.derived)
    derivedIntegration.registerHandlers(engine)

    // Create agentic task integration (uses shared queue)
    const agenticIntegration = new AgenticTaskIntegration(sql, config.agentic)
    agenticIntegration.registerHandlers(engine)

    // Create collector (for direct webhook ingestion)
    const collector = new Collector(sql, {
      authProvider,
      accountRepo,
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
      },
      accountRepo,
      derivedTaskRepo,
      derivedIntegration,
      agenticTaskRepo,
      agenticIntegration,
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
      derivedIntegration,
      authProvider,
      collector,
      oauthProviders,
      accountRepo,
      syncJobRepo,
      taskRepo,
      derivedJobRepo,
      derivedTaskRepo,
      envelopeRepo,
      entityRepo,
      mappingRepo,
      connectorRepo,
      preferencesRepo,
      decisionsRepo,
      goalsRepo,
      actionsRepo,
      tracesRepo,
      escalationsRepo,
      agenticTaskRepo,
      agenticRunRepo,
      agenticIntegration,
      researchRepo,
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
    this.scheduler.registerConnector(connector)
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
   * Unload a connector (remove from memory).
   * Does not affect the database registration.
   */
  unloadConnector(type: ConnectorType): boolean {
    if (!this.connectors.has(type)) {
      return false
    }
    this.connectors.delete(type)
    ;(this as any)._connectors?.delete(type)
    this.engine.unregisterConnector(type)
    this.scheduler.unloadConnector(type)
    return true
  }

  /**
   * List available connector factories that are not yet registered.
   */
  listAvailableFactories(): ConnectorType[] {
    const allFactories = listFactoryTypes()
    const registered = Array.from(this.connectors.keys())
    return allFactories.filter((f) => !registered.includes(f))
  }

  /**
   * Load connectors from the database.
   * Called at daemon startup to restore registered connectors.
   */
  async loadRegisteredConnectors(): Promise<LoadConnectorsResult> {
    this.registeredConnectorsLoaded = true
    const result: LoadConnectorsResult = {
      loaded: [],
      errors: [],
      skipped: [],
    }

    const registered = await this.connectorRepo.findEnabled()

    for (const reg of registered) {
      if (this.connectors.has(reg.type)) {
        continue
      }
      if (!hasFactory(reg.type)) {
        result.skipped.push(reg.type)
        continue
      }

      try {
        const connector = await createConnector(reg.type, reg.config)
        this.registerConnector(connector)
        result.loaded.push(reg.type)
      } catch (error) {
        result.errors.push({
          type: reg.type,
          error: error instanceof Error ? error : new Error(String(error)),
        })
      }
    }

    return result
  }

  /**
   * Register a connector dynamically (persists to database).
   * Creates the connector from its factory and registers it.
   */
  async registerConnectorDynamic(
    type: ConnectorType,
    config?: Record<string, unknown>
  ): Promise<RegisteredConnector> {
    if (!hasFactory(type)) {
      throw new Error(`No factory registered for connector type: ${type}`)
    }

    // Create and register the connector instance
    const connector = await createConnector(type, config ?? {})
    this.registerConnector(connector)

    // Persist to database
    const registered = await this.connectorRepo.register({
      type,
      enabled: true,
      config: config ?? {},
    })

    return registered
  }

  /**
   * Reload a connector (unload and re-create from database config).
   */
  async reloadConnector(type: ConnectorType): Promise<boolean> {
    const registration = await this.connectorRepo.findByType(type)
    if (!registration) {
      return false
    }

    if (!hasFactory(type)) {
      throw new Error(`No factory registered for connector type: ${type}`)
    }

    // Unload existing
    this.unloadConnector(type)

    // Skip if disabled
    if (!registration.enabled) {
      return true
    }

    // Re-create and register
    const connector = await createConnector(type, registration.config)
    this.registerConnector(connector)

    return true
  }

  /**
   * Start all daemon components.
   * - HTTP server
   * - SyncEngine (queue worker - processes sync AND derived jobs)
   * - Scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Daemon is already running')
    }

    if (!this.registeredConnectorsLoaded) {
      await this.loadRegisteredConnectors()
    }

    // Start in order: server → engines → scheduler
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

    // Stop in reverse order: scheduler → engines → server
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
   * Find existing credentials for an OAuth provider.
   * Searches all active accounts that use the same provider.
   */
  async findExistingProviderCredentials(
    provider: OAuthProviderId,
    requiredScopes: string[]
  ): Promise<{ accountId: string; hasAllScopes: boolean } | null> {
    const accounts = await this.accountRepo.findActive()

    for (const account of accounts) {
      const connector = this.connectors.get(account.connector as ConnectorType)
      if (!connector) continue

      // Check if this connector uses the same OAuth provider
      const authConfig = connector.authConfig
      if (authConfig?.type !== 'oauth2_provider') continue
      if (authConfig.provider !== provider) continue

      // Check if we have valid credentials
      const creds = await this.authProvider.getCredentials(account.id)
      if (!creds) continue

      // For now, assume existing scopes are sufficient
      // TODO: Parse token scopes and check coverage
      return {
        accountId: account.id,
        hasAllScopes: true,
      }
    }

    return null
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
   * Sign OAuth state payload for stateless validation.
   */
  signAuthState(payload: AuthStatePayload): string {
    const payloadJson = JSON.stringify(payload)
    const payloadB64 = Buffer.from(payloadJson).toString('base64url')
    const signature = createHmac('sha256', this.config.encryptionKey)
      .update(payloadB64)
      .digest('base64url')
    return `${payloadB64}.${signature}`
  }

  /**
   * Verify and decode a signed OAuth state payload.
   */
  verifyAuthState(state: string, maxAgeMs: number): AuthStatePayload | null {
    const [payloadB64, signature] = state.split('.')
    if (!payloadB64 || !signature) return null

    const expected = createHmac('sha256', this.config.encryptionKey)
      .update(payloadB64)
      .digest('base64url')

    if (signature.length !== expected.length) return null

    try {
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return null
      }
    } catch {
      return null
    }

    try {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as AuthStatePayload
      if (typeof payload.connector !== 'string' || typeof payload.redirectUri !== 'string') return null
      if (typeof payload.issuedAt !== 'number') return null
      if (Date.now() - payload.issuedAt > maxAgeMs) return null
      return payload
    } catch {
      return null
    }
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

    // Store initial sync cursor from profile metadata (e.g., Gmail historyId)
    if (primaryAccount.metadata?.history_id) {
      await this.accountRepo.updateSyncState(account.id, String(primaryAccount.metadata.history_id))
    }

    // Activate the account
    await this.accountRepo.activate(account.id)

    return (await this.accountRepo.findById(account.id))!
  }

  /**
   * Create an account for a connector by copying credentials from an existing account.
   * Used when multiple connectors share the same OAuth provider (e.g., Gmail and Calendar both use Google).
   */
  async createAccountFromExisting(
    connector: ConnectorType,
    sourceAccountId: string
  ): Promise<Account> {
    const connectorInstance = this.connectors.get(connector)
    if (!connectorInstance) {
      throw new Error(`Connector not registered: ${connector}`)
    }

    // Get source account's credentials
    const creds = await this.authProvider.getCredentials(sourceAccountId)
    if (!creds) {
      throw new Error('Source account has no credentials')
    }

    // Get account info using the access token
    const ctx = {
      accountId: 'temp',
      accessToken: creds.accessToken,
    }

    const accounts = await connectorInstance.listAccounts(ctx)
    const primaryAccount = accounts.find((a) => a.isPrimary) || accounts[0]

    if (!primaryAccount) {
      throw new Error('No account found with provided credentials')
    }

    // Check if account already exists for this connector
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

    // Copy credentials to the new account
    await this.authProvider.storeCredentials(account.id, {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    })

    // Activate the account
    await this.accountRepo.activate(account.id)

    return (await this.accountRepo.findById(account.id))!
  }

  // ============ Internal Event System ============

  /**
   * Subscribe to internal daemon events.
   * Returns an unsubscribe function.
   */
  onInternalEvent(handler: (event: InternalEvent) => void): () => void {
    this.internalEventHandlers.push(handler)
    return () => {
      const idx = this.internalEventHandlers.indexOf(handler)
      if (idx >= 0) this.internalEventHandlers.splice(idx, 1)
    }
  }

  /**
   * Emit an internal event.
   * Used by internal components to broadcast events.
   */
  emitInternalEvent(event: Omit<InternalEvent, 'timestamp'>): void {
    const fullEvent: InternalEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    }

    // Notify all handlers
    for (const handler of this.internalEventHandlers) {
      try {
        handler(fullEvent)
      } catch (error) {
        console.error('[SyncDaemon] Internal event handler error:', {
          event: fullEvent,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  // ============ Sanity Checks ============

  /**
   * Run sanity checks for connector registration/config.
   */
  async checkConnectorSanity(options: ConnectorSanityOptions): Promise<SanityCheckResult> {
    const checks: SanityCheck[] = []
    const addCheck = (id: string, status: SanityCheckStatus, message: string, details?: Record<string, unknown>) => {
      checks.push({ id, status, message, ...(details ? { details } : {}) })
    }

    let connector: Connector | undefined
    let registry: TransformationRegistry | undefined

    if (options.config) {
      if (!hasFactory(options.type)) {
        addCheck('connector', 'error', `No factory registered for connector type: ${options.type}`)
        return this.buildSanityResult(checks)
      }

      try {
        connector = await createConnector(options.type, options.config)
      } catch (error) {
        addCheck('connector', 'error', 'Failed to construct connector', {
          error: error instanceof Error ? error.message : String(error),
        })
        return this.buildSanityResult(checks)
      }

      registry = new TransformationRegistry()
      if ('registerTransforms' in connector && typeof (connector as { registerTransforms?: unknown }).registerTransforms === 'function') {
        ;(connector as { registerTransforms: (registry: TransformationRegistry) => void }).registerTransforms(registry)
      } else {
        addCheck('transforms', 'warning', 'Connector does not expose registerTransforms()')
      }
    } else {
      connector = this.getConnector(options.type)
      if (!connector) {
        addCheck('connector', 'error', `Connector not registered: ${options.type}`)
        return this.buildSanityResult(checks)
      }
    }

    const entityTypes = connector.capabilities.supportedEntityTypes
    if (entityTypes.length === 0) {
      addCheck('capabilities', 'warning', 'Connector has no supported entity types')
      return this.buildSanityResult(checks)
    }

    for (const entityType of entityTypes) {
      const transforms = registry
        ? registry.findBySource(connector.type, entityType)
        : this.engine.findTransformations(connector.type, entityType)

      if (transforms.length === 0) {
        addCheck(`transform:${entityType}`, 'warning', `No transformation registered for ${entityType}`)
      } else {
        addCheck(`transform:${entityType}`, 'ok', `Found ${transforms.length} transformation(s)`)
      }
    }

    return this.buildSanityResult(checks)
  }

  /**
   * Run sanity checks for task creation or backfill.
   */
  async checkTaskSanity(options: TaskSanityOptions): Promise<SanityCheckResult> {
    const checks: SanityCheck[] = []
    const addCheck = (id: string, status: SanityCheckStatus, message: string, details?: Record<string, unknown>) => {
      checks.push({ id, status, message, ...(details ? { details } : {}) })
    }

    const connector = this.getConnector(options.connector)
    if (!connector) {
      addCheck('connector', 'error', `Connector not registered: ${options.connector}`)
      return this.buildSanityResult(checks)
    }

    const account = await this.accountRepo.findById(options.accountId)
    if (!account) {
      addCheck('account', 'error', `Account not found: ${options.accountId}`)
      return this.buildSanityResult(checks)
    }
    if (account.connector !== options.connector) {
      addCheck('account', 'error', `Account ${options.accountId} is not a ${options.connector} account`)
      return this.buildSanityResult(checks)
    }

    const entityTypes = options.entityTypes?.length
      ? options.entityTypes
      : connector.capabilities.supportedEntityTypes

    if (entityTypes.length === 0) {
      addCheck('entity-types', 'error', 'No entity types specified or supported')
      return this.buildSanityResult(checks)
    }

    const unsupported = entityTypes.filter((entityType) =>
      !connector.capabilities.supportedEntityTypes.includes(entityType)
    )
    if (unsupported.length > 0) {
      addCheck('entity-types', 'error', 'Unsupported entity types requested', {
        unsupported,
      })
    }

    if (options.syncType === 'backfill' && !connector.capabilities.supportsBackfill) {
      addCheck('capabilities', 'error', 'Connector does not support backfill')
    }
    if (options.syncType === 'incremental' && !connector.capabilities.supportsIncrementalSync) {
      addCheck('capabilities', 'error', 'Connector does not support incremental sync')
    }
    if (options.mode === 'webhook' && !connector.capabilities.supportsWebhook) {
      addCheck('capabilities', 'error', 'Connector does not support webhooks')
    }
    if (options.mode === 'webhook' && !connector.subscribe) {
      addCheck('capabilities', 'error', 'Connector does not implement webhook subscribe()')
    }
    if (options.syncType === 'incremental' && options.mode !== 'webhook' && !connector.fetchChanges) {
      addCheck('capabilities', 'error', 'Connector does not implement fetchChanges()')
    }

    for (const entityType of entityTypes) {
      const transforms = this.engine.findTransformations(connector.type, entityType)
      if (transforms.length === 0) {
        addCheck(`transform:${entityType}`, 'error', `No transformation registered for ${entityType}`)
      } else {
        addCheck(`transform:${entityType}`, 'ok', `Found ${transforms.length} transformation(s)`)
      }
    }

    if (checks.some((check) => check.status === 'error')) {
      return this.buildSanityResult(checks)
    }

    let ctx: ConnectorContext = { accountId: options.accountId }
    // Local auth connectors don't need OAuth credentials - just use minimal context
    if (connector.authConfig.type === 'local') {
      addCheck('auth', 'ok', 'Local auth connector (no credentials needed)')
    } else if (this.authProvider) {
      try {
        ctx = await this.authProvider.getContext(options.accountId)
        addCheck('auth', 'ok', 'Auth context resolved')
      } catch (error) {
        addCheck('auth', 'error', 'Failed to get auth context', {
          error: error instanceof Error ? error.message : String(error),
        })
        return this.buildSanityResult(checks)
      }
    } else {
      addCheck('auth', 'warning', 'No auth provider configured; using minimal context')
    }

    try {
      const accounts = await connector.listAccounts(ctx)
      addCheck('accounts', 'ok', `Listed ${accounts.length} account(s)`)
    } catch (error) {
      addCheck('accounts', 'error', 'Failed to list accounts', {
        error: error instanceof Error ? error.message : String(error),
      })
      return this.buildSanityResult(checks)
    }

    if (options.mode === 'webhook') {
      return this.buildSanityResult(checks)
    }

    for (const entityType of entityTypes) {
      const fetchLabel = `fetch:${entityType}`
      const fetchResult = await this.fetchSanitySample(
        connector,
        ctx,
        options.syncType,
        entityType,
        account.sync_cursor ?? undefined
      )

      if (!fetchResult.ok) {
        addCheck(fetchLabel, 'error', 'Sample fetch failed', { error: fetchResult.error })
        continue
      }

      if (fetchResult.items.length === 0) {
        addCheck(fetchLabel, 'warning', 'Sample fetch returned no items')
        continue
      }

      addCheck(fetchLabel, 'ok', `Fetched ${fetchResult.items.length} sample item(s)`)

      const invalidSamples: Array<{ index: number; missing: string[] }> = []
      for (const [index, item] of fetchResult.items.entries()) {
        const missing: string[] = []
        if (!item.entity_type) missing.push('entity_type')
        if (!item.source_id) missing.push('source_id')
        if (item.raw_data === undefined) missing.push('raw_data')
        if (item.raw_data !== undefined) {
          try {
            const rawJson = JSON.stringify(item.raw_data)
            if (rawJson === undefined) {
              missing.push('raw_data_serializable')
            }
          } catch {
            missing.push('raw_data_serializable')
          }
        }
        if (missing.length > 0) {
          invalidSamples.push({ index, missing })
        }
      }

      if (invalidSamples.length > 0) {
        addCheck(`fetch:${entityType}:shape`, 'error', 'Sample items missing required fields', {
          totalInvalid: invalidSamples.length,
          invalidSample: invalidSamples.slice(0, 3),
        })
        continue
      }

      const sampleItem = fetchResult.items.find((item) => item.entity_type === entityType) ?? fetchResult.items[0]
      const transform = this.engine.findTransformations(connector.type, sampleItem.entity_type)[0]

      if (!transform) {
        addCheck(`transform:${entityType}:run`, 'error', `No transformation registered for ${sampleItem.entity_type}`)
        continue
      }

      const envelope = this.buildSanityEnvelope(options, sampleItem)
      const transformCtx = this.buildTransformContext(envelope, options.accountId)

      const parseResult = transform.inputSchema.safeParse(sampleItem.raw_data)
      if (!parseResult.success) {
        addCheck(`transform:${entityType}:input`, 'error', 'Transform input validation failed', {
          error: parseResult.error.message,
        })
        continue
      }

      let results
      try {
        results = transform.transform(parseResult.data, transformCtx)
      } catch (error) {
        addCheck(`transform:${entityType}:run`, 'error', 'Transform threw an error', {
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      const resultList = Array.isArray(results) ? results : [results]
      if (resultList.length === 0) {
        addCheck(`transform:${entityType}:run`, 'warning', 'Transform returned no results')
        continue
      }

      for (const result of resultList) {
        const outputs = [result.primary, ...(result.related ?? [])]
        for (const output of outputs) {
          if (!output.sourceRefKey) {
            addCheck(`transform:${entityType}:output`, 'error', 'Transform output missing sourceRefKey')
            continue
          }

          const validation = validateEntity(output.entityType, output.data)
          if (!validation.success) {
            addCheck(`transform:${entityType}:output`, 'error', 'Canonical validation failed', {
              error: validation.error.message,
              entityType: output.entityType,
            })
            continue
          }

          addCheck(`transform:${entityType}:output`, 'ok', `Validated ${output.entityType} output`)
        }
      }
    }

    // Collect scope estimates if the connector supports it
    let estimate: SyncEstimate | undefined
    if (connector.estimateScope) {
      try {
        estimate = await connector.estimateScope(ctx, options.syncType, entityTypes)

        // Enrich with account sync state
        if (account.sync_cursor) {
          estimate.summary = estimate.summary
            ? `${estimate.summary} (cursor: ${account.sync_cursor.slice(0, 40)}${account.sync_cursor.length > 40 ? '...' : ''})`
            : `Sync cursor: ${account.sync_cursor.slice(0, 40)}`
        }
        if (account.last_synced_at) {
          estimate.summary = estimate.summary
            ? `${estimate.summary} | last synced: ${new Date(account.last_synced_at).toLocaleString()}`
            : `Last synced: ${new Date(account.last_synced_at).toLocaleString()}`
        }
      } catch {
        // Non-fatal - estimates are best-effort
      }
    }

    return this.buildSanityResult(checks, estimate)
  }

  // ============ Connector Discovery ============

  /**
   * List all registered connectors with their capabilities.
   */
  listConnectors(): ConnectorInfo[] {
    const result: ConnectorInfo[] = []
    for (const [type, connector] of this.connectors) {
      result.push({
        type,
        displayName: connector.displayName,
        entityTypes: connector.capabilities.supportedEntityTypes,
        capabilities: {
          backfill: connector.capabilities.supportsBackfill,
          incremental: connector.capabilities.supportsIncrementalSync,
          webhook: connector.capabilities.supportsWebhook,
          write: connector.capabilities.supportsWrite,
        },
        authType: connector.authConfig.type === 'oauth2_provider'
          ? 'oauth2'
          : connector.authConfig.type === 'oauth2'
            ? 'oauth2'
            : connector.authConfig.type,
      })
    }
    return result
  }

  /**
   * Get info about a specific connector.
   */
  getConnectorInfo(type: ConnectorType): ConnectorInfo | undefined {
    const connector = this.connectors.get(type)
    if (!connector) return undefined

    return {
      type,
      displayName: connector.displayName,
      entityTypes: connector.capabilities.supportedEntityTypes,
      capabilities: {
        backfill: connector.capabilities.supportsBackfill,
        incremental: connector.capabilities.supportsIncrementalSync,
        webhook: connector.capabilities.supportsWebhook,
        write: connector.capabilities.supportsWrite,
      },
      authType: connector.authConfig.type === 'oauth2_provider'
        ? 'oauth2'
        : connector.authConfig.type === 'oauth2'
          ? 'oauth2'
          : connector.authConfig.type,
    }
  }

  /**
   * Resolve connector to a single account.
   * Returns the account if exactly one exists, throws if none or multiple.
   * For local auth connectors, auto-creates an account if none exists.
   */
  async resolveAccount(
    connector: ConnectorType,
    accountId?: string
  ): Promise<Account> {
    // If accountId provided, validate it
    if (accountId) {
      const account = await this.accountRepo.findById(accountId)
      if (!account) {
        throw new Error(`Account not found: ${accountId}`)
      }
      if (account.connector !== connector) {
        throw new Error(`Account ${accountId} is not a ${connector} account`)
      }
      return account
    }

    // Find accounts for this connector
    const accounts = await this.accountRepo.findAllByConnector(connector)
    const active = accounts.filter((a) => a.is_active)

    if (active.length === 0) {
      // Check if connector uses local auth - if so, auto-create account
      const connectorInstance = this.connectors.get(connector)
      if (connectorInstance?.authConfig.type === 'local') {
        const accountInfo = await connectorInstance.listAccounts({ accountId: 'temp' })
        const primaryAccount = accountInfo.find((a) => a.isPrimary) || accountInfo[0]

        if (primaryAccount) {
          const account = await this.accountRepo.create({
            connector,
            external_account_id: primaryAccount.externalId,
            display_name: primaryAccount.displayName,
            email: primaryAccount.email,
            auth_type: 'local',
          })
          await this.accountRepo.activate(account.id)
          return (await this.accountRepo.findById(account.id))!
        }
      }

      throw new Error(`No ${connector} accounts found. Run: auth login ${connector}`)
    }

    if (active.length > 1) {
      const ids = active.map((a) => `  - ${a.id} (${a.email || a.display_name})`).join('\n')
      throw new Error(
        `Multiple ${connector} accounts found. Specify one:\n${ids}`
      )
    }

    return active[0]
  }

  private buildSanityResult(checks: SanityCheck[], estimate?: SyncEstimate): SanityCheckResult {
    return {
      ok: !checks.some((check) => check.status === 'error'),
      checks,
      ...(estimate ? { estimate } : {}),
    }
  }

  private async fetchSanitySample(
    connector: Connector,
    ctx: ConnectorContext,
    syncType: TaskSanityOptions['syncType'],
    entityType: string,
    cursor?: string
  ): Promise<{ ok: boolean; items: Array<{ entity_type: string; raw_data: unknown; source_id: string; source_timestamp?: string; source_version?: string }>; error?: string }> {
    try {
      const sampleLimit = 5
      if (syncType === 'incremental' && connector.fetchChanges) {
        const result = await connector.fetchChanges(ctx, {
          since: cursor,
          limit: sampleLimit,
          entityTypes: [entityType],
        })
        return { ok: true, items: result.items }
      }

      const result = await connector.fetchPage(ctx, {
        limit: sampleLimit,
        entityTypes: [entityType],
      })
      return { ok: true, items: result.items }
    } catch (error) {
      return {
        ok: false,
        items: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private buildSanityEnvelope(
    options: TaskSanityOptions,
    item: { entity_type: string; raw_data: unknown; source_id: string; source_timestamp?: string; source_version?: string }
  ): RawEnvelope {
    const rawHash = computeRawDataHash(item.raw_data)
    const idempotency = computeIdempotencyKeys(
      options.connector,
      options.accountId,
      item.entity_type,
      item.source_id,
      item.raw_data
    )

    return {
      id: generateCanonicalId(),
      idempotency_key: idempotency.raw_key,
      connector: options.connector,
      account_id: options.accountId,
      entity_type: item.entity_type,
      source_id: item.source_id,
      source_version: item.source_version,
      raw_data: item.raw_data,
      raw_data_hash: rawHash,
      source_timestamp: item.source_timestamp,
      received_at: new Date().toISOString(),
      sync_job_id: generateCanonicalId(),
      collection_method: options.syncType,
    }
  }

  private buildTransformContext(envelope: RawEnvelope, accountId: string) {
    return {
      envelope,
      accountId,
      connector: envelope.connector,
      lookupEntity: async (sourceRefKey: string) => {
        const mapping = await this.mappingRepo.findBySourceRefKey(sourceRefKey)
        if (!mapping) return null
        return this.entityRepo.findById(mapping.canonical_entity_id)
      },
      lookupEntitiesByType: async (type: EntityType, limit?: number) => {
        const result = await this.entityRepo.findByType(type, { limit })
        return result.items
      },
    }
  }
}

/**
 * Info about a registered connector.
 */
export interface ConnectorInfo {
  type: ConnectorType
  displayName: string
  entityTypes: string[]
  capabilities: {
    backfill: boolean
    incremental: boolean
    webhook: boolean
    write: boolean
  }
  authType: string
}

export type SanityCheckStatus = 'ok' | 'warning' | 'error'

export interface SanityCheck {
  id: string
  status: SanityCheckStatus
  message: string
  details?: Record<string, unknown>
}

export interface SanityCheckResult {
  ok: boolean
  checks: SanityCheck[]
  estimate?: SyncEstimate
}

export { type SyncEstimate, type SyncEstimateEntry } from '../connector/sdk/types.js'

export interface ConnectorSanityOptions {
  type: ConnectorType
  config?: Record<string, unknown>
}

export interface TaskSanityOptions {
  connector: ConnectorType
  accountId: string
  entityTypes?: string[]
  syncType: 'backfill' | 'incremental'
  mode?: 'once' | 'recurring' | 'webhook'
}

// Re-export server and scheduler types
export { HttpServer, type ServerConfig, type ParsedRequest, type RouteHandler, type RouteResponse } from './server.js'
export { Scheduler, type SchedulerConfig, type SchedulerEvent } from '../sync/scheduler.js'
export { type LoadConnectorsResult } from '../connectors/registry.js'
export { type RegisteredConnector, type RegisteredConnectorRepository } from '../db/repositories/registered-connector.js'
