/**
 * Sync Daemon Client SDK
 *
 * Typed HTTP client for interacting with the sync daemon API.
 * Provides namespaced methods for accounts, auth, tasks, and jobs.
 */

import type {
  Account,
  AccountListResponse,
  AccountResponse,
  ActionCreateInput,
  ActionOutcomeInput,
  ActionResponse,
  ActionStats,
  ActionStatsResponse,
  ActionUpdateInput,
  ActionsResponse,
  AgentAction,
  AgentGoal,
  AgentTrace,
  AuthStatusResponse,
  AuthUrlResponse,
  AvailableConnectorsResponse,
  BackfillResponse,
  CodingPreference,
  CodingDecision,
  ConnectorInfo,
  ConnectorListResponse,
  ConnectorRegistrationResponse,
  ConnectorResponse,
  ConnectorSanityResponse,
  ConnectorUnregisterResponse,
  DecisionsSearchResponse,
  MemorySearchResponse,
  MemoryRecentResponse,
  EvidenceRetrieveRequest,
  EvidenceRetrieveResponse,
  DerivedJob,
  DerivedJobListResponse,
  DerivedJobResponse,
  DerivedJobLogsResponse,
  DerivedRetryResponse,
  DerivedTask,
  DerivedTaskCreateResponse,
  DerivedTaskListResponse,
  DerivedTaskResponse,
  DerivedTaskMode,
  DeviceAuthPollResponse,
  DeviceAuthResponse,
  GoalCreateInput,
  GoalResponse,
  GoalsResponse,
  GoalUpdateInput,
  HealthResponse,
  InternalEvent,
  JobListResponse,
  JobResponse,
  PreferencesSearchResponse,
  ProcessAllResponse,
  ProcessErroredResponse,
  ProcessJobResponse,
  ProvidersResponse,
  RegisteredConnector,
  ReprocessFilteredRequest,
  ReprocessFilteredResponse,
  RetryResponse,
  SanityCheckResult,
  SyncJob,
  SyncTask,
  SyncType,
  TaskListResponse,
  TaskMode,
  TaskResponse,
  TaskSanityResponse,
  TraceResponse,
  TracesResponse,
  EscalationResponse,
  TransformationListResponse,
  TransformationSummary,
  TriggerConfig,
} from './types.js'
import { SyncClientError } from './types.js'
import type { TraceRecord, Escalation, EscalationCreateInput, EscalationResolveInput } from 'types'

export interface SyncClientConfig {
  /** Base URL of the sync daemon (e.g., 'http://localhost:3001') */
  baseUrl: string
  /** Request timeout in ms (default: 30000) */
  timeout?: number
  /** Custom headers to include in all requests */
  headers?: Record<string, string>
}

/**
 * Sync Daemon Client
 *
 * @example
 * ```ts
 * const client = new SyncClient('http://localhost:3001')
 *
 * // Health check
 * const health = await client.health()
 *
 * // OAuth flow
 * const { url, state } = await client.auth.getUrl('gmail', 'http://localhost:9876/callback')
 * // ... user authorizes in browser ...
 * const account = await client.auth.callback('gmail', code, state, redirectUri)
 *
 * // Create sync task
 * const { task, job } = await client.tasks.backfill(account.id)
 *
 * // Monitor job
 * const { job: updatedJob } = await client.jobs.get(job.id)
 * ```
 */
export class SyncClient {
  private baseUrl: string
  private timeout: number
  private headers: Record<string, string>

  constructor(config: string | SyncClientConfig) {
    if (typeof config === 'string') {
      this.baseUrl = config.replace(/\/$/, '')
      this.timeout = 30000
      this.headers = {}
    } else {
      this.baseUrl = config.baseUrl.replace(/\/$/, '')
      this.timeout = config.timeout ?? 30000
      this.headers = config.headers ?? {}
    }
  }

  // ============ HTTP Helpers ============

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api${path}`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const options: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        signal: controller.signal,
      }

      if (body !== undefined) {
        options.body = JSON.stringify(body)
      }

      const response = await fetch(url, options)

      if (!response.ok) {
        const errorBody = await response.text()
        let errorData: { error?: string; message?: string; code?: string } = {}
        try {
          errorData = JSON.parse(errorBody)
        } catch {
          errorData = { error: errorBody }
        }
        // Prefer message field for detailed errors, fall back to error field
        const errorMessage = errorData.message || errorData.error || `HTTP ${response.status}`
        throw new SyncClientError(errorMessage, response.status, errorData.code, errorData)
      }

      const contentType = response.headers.get('content-type')
      if (contentType?.includes('application/json')) {
        return await response.json()
      }

      return (await response.text()) as T
    } catch (error) {
      if (error instanceof SyncClientError) {
        throw error
      }
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new SyncClientError('Request timeout', 408, 'TIMEOUT')
        }
        // Handle various connection error formats (Node, Bun, browser)
        const msg = error.message.toLowerCase()
        if (
          msg.includes('fetch failed') ||
          msg.includes('econnrefused') ||
          msg.includes('unable to connect') ||
          msg.includes('network') ||
          msg.includes('connection') ||
          error.name === 'ConnectionError' ||
          error.name === 'TypeError'
        ) {
          throw new SyncClientError(
            `Cannot connect to sync daemon at ${this.baseUrl}`,
            0,
            'CONNECTION_ERROR'
          )
        }
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body)
  }

  private delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path)
  }

  // ============ Health ============

  /**
   * Check daemon health.
   */
  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/health')
  }

  // ============ Accounts ============

  /**
   * Account management methods.
   */
  accounts = {
    /**
     * List accounts.
     * @param opts.connector - Filter by connector type
     * @param opts.active - Filter by active status
     */
    list: async (opts?: { connector?: string; active?: boolean }): Promise<Account[]> => {
      const params = new URLSearchParams()
      if (opts?.connector) params.set('connector', opts.connector)
      if (opts?.active !== undefined) params.set('active', String(opts.active))
      const query = params.toString()
      const response = await this.get<AccountListResponse>(`/accounts${query ? `?${query}` : ''}`)
      return response.accounts
    },

    /**
     * Get account by ID.
     */
    get: async (id: string): Promise<Account> => {
      const response = await this.get<AccountResponse>(`/accounts/${id}`)
      return response.account
    },

    /**
     * Create account from OAuth callback.
     * Prefer using auth.callback() instead.
     */
    create: async (connector: string, code: string, redirectUri: string): Promise<Account> => {
      const response = await this.post<AccountResponse>('/accounts', { connector, code, redirectUri })
      return response.account
    },

    /**
     * Update account details.
     */
    update: async (
      id: string,
      data: Partial<Pick<Account, 'display_name' | 'email' | 'is_active'>>
    ): Promise<Account> => {
      const response = await this.patch<AccountResponse>(`/accounts/${id}`, data)
      return response.account
    },

    /**
     * Deactivate (soft delete) an account.
     * Also disables all tasks for the account.
     */
    delete: async (id: string): Promise<void> => {
      await this.delete<{ success: boolean }>(`/accounts/${id}`)
    },
  }

  // ============ Connectors ============

  /**
   * Connector discovery and management methods.
   */
  connectors = {
    /**
     * List all registered (loaded) connectors.
     */
    list: async (): Promise<ConnectorInfo[]> => {
      const response = await this.get<ConnectorListResponse>('/connectors')
      return response.connectors
    },

    /**
     * List available connector factories (not yet registered).
     */
    available: async (): Promise<string[]> => {
      const response = await this.get<AvailableConnectorsResponse>('/connectors/available')
      return response.available
    },

    /**
     * Get info about a specific connector.
     * Returns connector info if loaded, or factory availability if not.
     */
    get: async (type: string): Promise<ConnectorResponse> => {
      return this.get<ConnectorResponse>(`/connectors/${type}`)
    },

    /**
     * List accounts for a connector.
     */
    accounts: async (type: string): Promise<Account[]> => {
      const response = await this.get<AccountListResponse>(`/connectors/${type}/accounts`)
      return response.accounts
    },

    /**
     * Run connector sanity checks (optionally with config).
     */
    sanity: async (type: string, config?: Record<string, unknown>): Promise<SanityCheckResult> => {
      const response = await this.post<ConnectorSanityResponse>(`/connectors/${type}/sanity`, { config })
      return response.sanity
    },

    /**
     * Register a new connector (persists to database).
     * @param type - Connector type (must have a registered factory)
     * @param config - Optional configuration for the connector
     */
    register: async (type: string, config?: Record<string, unknown>): Promise<ConnectorRegistrationResponse> => {
      return this.post<ConnectorRegistrationResponse>('/connectors/register', { type, config })
    },

    /**
     * Update connector configuration.
     * Reloads the connector with the new config.
     * @param type - Connector type
     * @param config - New configuration
     */
    updateConfig: async (type: string, config: Record<string, unknown>): Promise<ConnectorRegistrationResponse> => {
      return this.patch<ConnectorRegistrationResponse>(`/connectors/${type}/config`, { config })
    },

    /**
     * Enable or disable a connector.
     * @param type - Connector type
     * @param enabled - Whether to enable or disable
     */
    setEnabled: async (type: string, enabled: boolean): Promise<ConnectorRegistrationResponse> => {
      return this.patch<ConnectorRegistrationResponse>(`/connectors/${type}`, { enabled })
    },

    /**
     * Unregister a connector (removes from database and unloads).
     * @param type - Connector type
     */
    unregister: async (type: string): Promise<ConnectorUnregisterResponse> => {
      return this.delete<ConnectorUnregisterResponse>(`/connectors/${type}`)
    },
  }

  // ============ Auth ============

  /**
   * Authentication methods.
   */
  auth = {
    /**
     * List available OAuth providers.
     */
    providers: async (): Promise<string[]> => {
      const response = await this.get<ProvidersResponse>('/auth/providers')
      return response.providers
    },

    /**
     * Get OAuth authorization URL.
     * @param connector - Connector type (e.g., 'gmail', 'github')
     * @param redirectUri - OAuth callback URI
     * @returns Authorization URL and state for CSRF protection
     */
    getUrl: async (connector: string, redirectUri: string): Promise<AuthUrlResponse> => {
      const params = new URLSearchParams({ redirectUri })
      return this.get<AuthUrlResponse>(`/auth/${connector}/url?${params}`)
    },

    /**
     * Complete OAuth callback flow.
     * Exchanges authorization code for tokens and creates account.
     */
    callback: async (
      connector: string,
      code: string,
      state: string,
      redirectUri: string
    ): Promise<Account> => {
      const response = await this.post<AccountResponse>(`/auth/${connector}/callback`, {
        code,
        state,
        redirectUri,
      })
      return response.account
    },

    /**
     * Create account using credentials from an existing account.
     * Used when multiple connectors share the same OAuth provider.
     * @param connector - Connector type for the new account
     * @param sourceAccountId - Account ID with existing credentials to copy
     */
    fromExisting: async (connector: string, sourceAccountId: string): Promise<Account> => {
      const response = await this.post<AccountResponse>(`/auth/${connector}/from-existing`, {
        sourceAccountId,
      })
      return response.account
    },

    /**
     * Force token refresh for an account.
     */
    refresh: async (accountId: string): Promise<void> => {
      await this.post<{ success: boolean }>(`/auth/refresh/${accountId}`)
    },

    /**
     * Check if account has valid credentials.
     */
    status: async (accountId: string): Promise<AuthStatusResponse> => {
      return this.get<AuthStatusResponse>(`/auth/status/${accountId}`)
    },

    /**
     * Initiate device authorization flow (headless/CLI).
     * Returns codes for user to enter at verification URL.
     */
    deviceAuth: async (connector: string): Promise<DeviceAuthResponse> => {
      return this.post<DeviceAuthResponse>(`/auth/${connector}/device`)
    },

    /**
     * Poll device auth status.
     * Returns { status: 'pending' } or { status: 'complete', account }.
     */
    pollDeviceAuth: async (
      connector: string,
      deviceCode: string
    ): Promise<DeviceAuthPollResponse> => {
      return this.post<DeviceAuthPollResponse>(`/auth/${connector}/device/poll`, { deviceCode })
    },

    /**
     * Complete device auth with polling loop.
     * Blocks until user authorizes or timeout.
     */
    waitForDeviceAuth: async (
      connector: string,
      deviceCode: string,
      opts?: { interval?: number; timeout?: number; onPoll?: () => void }
    ): Promise<Account> => {
      const interval = opts?.interval ?? 5000
      const timeout = opts?.timeout ?? 300000 // 5 minutes
      const startTime = Date.now()

      while (Date.now() - startTime < timeout) {
        opts?.onPoll?.()
        const result = await this.auth.pollDeviceAuth(connector, deviceCode)
        if (result.status === 'complete') {
          return result.account!
        }
        await new Promise((resolve) => setTimeout(resolve, interval))
      }

      throw new SyncClientError('Device authorization timed out', 408, 'DEVICE_AUTH_TIMEOUT')
    },
  }

  // ============ Tasks ============

  /**
   * Sync task management methods.
   */
  tasks = {
    /**
     * List sync tasks.
     * @param opts.accountId - Filter by account
     * @param opts.connector - Filter by connector type
     * @param opts.enabled - Filter by enabled status
     */
    list: async (opts?: {
      accountId?: string
      connector?: string
      enabled?: boolean
    }): Promise<SyncTask[]> => {
      const params = new URLSearchParams()
      if (opts?.accountId) params.set('accountId', opts.accountId)
      if (opts?.connector) params.set('connector', opts.connector)
      if (opts?.enabled !== undefined) params.set('enabled', String(opts.enabled))
      const query = params.toString()
      const response = await this.get<TaskListResponse>(`/tasks${query ? `?${query}` : ''}`)
      return response.tasks
    },

    /**
     * Run task sanity checks before creating a task.
     */
    sanity: async (opts: {
      accountId?: string
      connector?: string
      syncType: SyncType
      entityTypes?: string[]
      mode?: TaskMode
    }): Promise<SanityCheckResult> => {
      const response = await this.post<TaskSanityResponse>('/tasks/sanity', opts)
      return response.sanity
    },

    /**
     * Get task by ID with recent jobs.
     */
    get: async (id: string): Promise<TaskResponse> => {
      return this.get<TaskResponse>(`/tasks/${id}`)
    },

    /**
     * Create a one-shot backfill task and schedule immediately.
     * @param opts - Options with either accountId or connector (auto-resolved)
     */
    backfill: async (opts: {
      accountId?: string
      connector?: string
      entityTypes?: string[]
    }): Promise<BackfillResponse> => {
      return this.post<BackfillResponse>('/tasks/backfill', opts)
    },

    /**
     * Create a recurring sync subscription.
     * @param opts - Options with either accountId or connector (auto-resolved)
     */
    subscribe: async (opts: {
      accountId?: string
      connector?: string
      syncType: SyncType
      intervalMs: number
      entityTypes?: string[]
    }): Promise<SyncTask> => {
      const response = await this.post<{ task: SyncTask }>('/tasks/subscribe', opts)
      return response.task
    },

    /**
     * Create a webhook-driven sync task.
     * @param opts - Options with either accountId or connector (auto-resolved)
     */
    webhook: async (opts: {
      accountId?: string
      connector?: string
      entityTypes?: string[]
    }): Promise<SyncTask> => {
      const response = await this.post<{ task: SyncTask }>('/tasks/webhook', opts)
      return response.task
    },

    /**
     * Update task settings.
     */
    update: async (
      id: string,
      data: Partial<Pick<SyncTask, 'enabled' | 'entity_types' | 'interval_ms'>>
    ): Promise<SyncTask> => {
      const response = await this.patch<{ task: SyncTask }>(`/tasks/${id}`, {
        enabled: data.enabled,
        entityTypes: data.entity_types,
        intervalMs: data.interval_ms,
      })
      return response.task
    },

    /**
     * Manually trigger a task to run now.
     */
    trigger: async (id: string): Promise<SyncJob> => {
      const response = await this.post<{ job: SyncJob }>(`/tasks/${id}/trigger`)
      return response.job
    },

    /**
     * Enable a task.
     */
    enable: async (id: string): Promise<SyncTask> => {
      const response = await this.patch<{ task: SyncTask }>(`/tasks/${id}`, { enabled: true })
      return response.task
    },

    /**
     * Disable a task.
     */
    disable: async (id: string): Promise<SyncTask> => {
      const response = await this.patch<{ task: SyncTask }>(`/tasks/${id}`, { enabled: false })
      return response.task
    },

    /**
     * Delete (cancel) a task.
     */
    delete: async (id: string): Promise<void> => {
      await this.delete<{ success: boolean }>(`/tasks/${id}`)
    },
  }

  // ============ Derived Tasks ============

  /**
   * Derived task management methods.
   */
  derivedTasks = {
    /**
     * List derived tasks.
     * @param opts.enabled - Filter by enabled status
     * @param opts.name - Filter by name
     */
    list: async (opts?: { enabled?: boolean; name?: string }): Promise<DerivedTask[]> => {
      const params = new URLSearchParams()
      if (opts?.enabled !== undefined) params.set('enabled', String(opts.enabled))
      if (opts?.name) params.set('name', opts.name)
      const query = params.toString()
      const response = await this.get<DerivedTaskListResponse>(`/derived/tasks${query ? `?${query}` : ''}`)
      return response.tasks
    },

    /**
     * Get derived task by ID with recent jobs.
     */
    get: async (id: string): Promise<DerivedTaskResponse> => {
      return this.get<DerivedTaskResponse>(`/derived/tasks/${id}`)
    },

    /**
     * Create a derived task.
     */
    create: async (opts: {
      name: string
      scriptPath: string
      mode: DerivedTaskMode
      intervalMs?: number
      metadata?: Record<string, unknown>
      triggerConfig?: TriggerConfig
    }): Promise<DerivedTaskCreateResponse> => {
      return this.post<DerivedTaskCreateResponse>('/derived/tasks', opts)
    },

    /**
     * Run a derived task immediately.
     */
    run: async (id: string, opts?: { priority?: number; metadata?: Record<string, unknown> }): Promise<DerivedJob> => {
      const response = await this.post<{ job: DerivedJob }>(`/derived/tasks/${id}/run`, opts)
      return response.job
    },
  }

  // ============ Jobs ============

  /**
   * Sync job management methods.
   */
  jobs = {
    /**
     * List sync jobs.
     * @param opts.accountId - Filter by account (requires connector)
     * @param opts.connector - Filter by connector type (requires accountId)
     * @param opts.status - Filter by status ('pending', 'running')
     * @param opts.limit - Max number of jobs to return
     */
    list: async (opts?: {
      accountId?: string
      connector?: string
      status?: string
      limit?: number
    }): Promise<SyncJob[]> => {
      const params = new URLSearchParams()
      if (opts?.accountId) params.set('accountId', opts.accountId)
      if (opts?.connector) params.set('connector', opts.connector)
      if (opts?.status) params.set('status', opts.status)
      if (opts?.limit) params.set('limit', String(opts.limit))
      const query = params.toString()
      const response = await this.get<JobListResponse>(`/jobs${query ? `?${query}` : ''}`)
      return response.jobs
    },

    /**
     * Get job by ID with queue stats.
     */
    get: async (id: string): Promise<JobResponse> => {
      return this.get<JobResponse>(`/jobs/${id}`)
    },

    /**
     * Cancel a pending or running job.
     */
    cancel: async (id: string): Promise<SyncJob> => {
      const response = await this.post<{ job: SyncJob }>(`/jobs/${id}/cancel`)
      return response.job
    },

    /**
     * Retry a failed job.
     * Creates a new job with the same parameters.
     */
    retry: async (id: string): Promise<RetryResponse> => {
      return this.post<RetryResponse>(`/jobs/${id}/retry`)
    },
  }

  // ============ Derived Jobs ============

  /**
   * Derived job management methods.
   */
  derivedJobs = {
    /**
     * List derived jobs.
     * @param opts.status - Filter by status ('pending', 'running')
     * @param opts.taskId - Filter by task
     * @param opts.limit - Max number of jobs to return
     */
    list: async (opts?: {
      status?: string
      taskId?: string
      limit?: number
    }): Promise<DerivedJob[]> => {
      const params = new URLSearchParams()
      if (opts?.status) params.set('status', opts.status)
      if (opts?.taskId) params.set('taskId', opts.taskId)
      if (opts?.limit) params.set('limit', String(opts.limit))
      const query = params.toString()
      const response = await this.get<DerivedJobListResponse>(`/derived/jobs${query ? `?${query}` : ''}`)
      return response.jobs
    },

    /**
     * Get derived job by ID with queue stats.
     */
    get: async (id: string): Promise<DerivedJobResponse> => {
      return this.get<DerivedJobResponse>(`/derived/jobs/${id}`)
    },

    /**
     * Fetch derived job logs (tail).
     */
    logs: async (id: string, opts?: { lines?: number }): Promise<DerivedJobLogsResponse> => {
      const params = new URLSearchParams()
      if (opts?.lines) params.set('lines', String(opts.lines))
      const query = params.toString()
      return this.get<DerivedJobLogsResponse>(`/derived/jobs/${id}/logs${query ? `?${query}` : ''}`)
    },

    /**
     * Cancel a pending or running derived job.
     */
    cancel: async (id: string): Promise<DerivedJob> => {
      const response = await this.post<{ job: DerivedJob }>(`/derived/jobs/${id}/cancel`)
      return response.job
    },

    /**
     * Retry a failed derived job.
     */
    retry: async (id: string): Promise<DerivedRetryResponse> => {
      return this.post<DerivedRetryResponse>(`/derived/jobs/${id}/retry`)
    },
  }

  // ============ Processing ============

  /**
   * Processing methods for raw envelopes.
   */
  processing = {
    /**
     * Process a specific sync job by ID.
     */
    processJob: async (id: string, opts?: { transformationIds?: string[] }): Promise<ProcessJobResponse> => {
      return this.post<ProcessJobResponse>(`/process/jobs/${id}`, opts)
    },

    /**
     * Process all unprocessed envelopes.
     */
    processAll: async (opts?: { transformationIds?: string[] }): Promise<ProcessAllResponse> => {
      return this.post<ProcessAllResponse>('/process/all', opts)
    },

    /**
     * Reprocess all errored envelopes.
     */
    processErrored: async (opts?: { transformationIds?: string[] }): Promise<ProcessErroredResponse> => {
      return this.post<ProcessErroredResponse>('/process/errored', opts)
    },

    /**
     * Reprocess all envelopes matching a scope filter.
     */
    reprocess: async (opts?: ReprocessFilteredRequest): Promise<ReprocessFilteredResponse> => {
      return this.post<ReprocessFilteredResponse>('/process/reprocess', opts)
    },
  }

  // ============ Transformations ============

  /**
   * Transformation listing methods.
   */
  transformations = {
    /**
     * List registered transformations.
     */
    list: async (opts?: {
      connector?: string
      entityTypes?: string[]
    }): Promise<TransformationSummary[]> => {
      const params = new URLSearchParams()
      if (opts?.connector) params.set('connector', opts.connector)
      if (opts?.entityTypes?.length) params.set('entityType', opts.entityTypes.join(','))
      const query = params.toString()
      const response = await this.get<TransformationListResponse>(`/transformations${query ? `?${query}` : ''}`)
      return response.transformations
    },
  }

  // ============ Preferences ============

  /**
   * Preferences search methods.
   */
  preferences = {
    /**
     * Search coding preferences with full-text search.
     * @param opts.q - Search query (required)
     * @param opts.category - Filter by category
     * @param opts.kind - Filter by kind
     * @param opts.confidence - Filter by confidence
     * @param opts.limit - Max results (default: 20)
     * @param opts.offset - Pagination offset (default: 0)
     */
    search: async (opts: {
      q: string
      category?: string
      kind?: string
      confidence?: string
      mode?: 'fts' | 'trgm'
      minSimilarity?: number
      limit?: number
      offset?: number
    }): Promise<PreferencesSearchResponse> => {
      const params = new URLSearchParams()
      params.set('q', opts.q)
      if (opts.category) params.set('category', opts.category)
      if (opts.kind) params.set('kind', opts.kind)
      if (opts.confidence) params.set('confidence', opts.confidence)
      if (opts.mode) params.set('mode', opts.mode)
      if (opts.minSimilarity !== undefined) params.set('min_similarity', String(opts.minSimilarity))
      if (opts.limit !== undefined) params.set('limit', String(opts.limit))
      if (opts.offset !== undefined) params.set('offset', String(opts.offset))
      const query = params.toString()
      return this.get<PreferencesSearchResponse>(`/preferences/search?${query}`)
    },
  }

  // ============ Decisions ============

  /**
   * Decisions search methods.
   */
  decisions = {
    /**
     * Search coding decisions with full-text search.
     * @param opts.q - Search query (required)
     * @param opts.category - Filter by category
     * @param opts.confidence - Filter by confidence
     * @param opts.limit - Max results (default: 20)
     * @param opts.offset - Pagination offset (default: 0)
     */
    search: async (opts: {
      q: string
      category?: string
      confidence?: string
      mode?: 'fts' | 'trgm'
      minSimilarity?: number
      limit?: number
      offset?: number
    }): Promise<DecisionsSearchResponse> => {
      const params = new URLSearchParams()
      params.set('q', opts.q)
      if (opts.category) params.set('category', opts.category)
      if (opts.confidence) params.set('confidence', opts.confidence)
      if (opts.mode) params.set('mode', opts.mode)
      if (opts.minSimilarity !== undefined) params.set('min_similarity', String(opts.minSimilarity))
      if (opts.limit !== undefined) params.set('limit', String(opts.limit))
      if (opts.offset !== undefined) params.set('offset', String(opts.offset))
      const query = params.toString()
      return this.get<DecisionsSearchResponse>(`/decisions/search?${query}`)
    },
  }

  // ============ Evidence ============

  /**
   * Evidence retrieval (v2).
   */
  evidence = {
    /**
     * Retrieve evidence for memory injection.
     */
    retrieve: async (opts: EvidenceRetrieveRequest): Promise<EvidenceRetrieveResponse> => {
      return this.post<EvidenceRetrieveResponse>('/evidence/retrieve', opts)
    },
  }

  // ============ Memory ============

  /**
   * Conversational memory search.
   */
  memory = {
    /**
     * Search conversational memory summaries.
     * @param opts.q - Search query (required)
     * @param opts.limit - Max results (default: 8)
     * @param opts.connectors - Comma-separated connector list
     */
    search: async (opts: {
      q: string
      limit?: number
      connectors?: string
    }): Promise<MemorySearchResponse> => {
      const params = new URLSearchParams()
      params.set('q', opts.q)
      if (opts.limit !== undefined) params.set('limit', String(opts.limit))
      if (opts.connectors) params.set('connectors', opts.connectors)
      const query = params.toString()
      return this.get<MemorySearchResponse>(`/memory/search?${query}`)
    },

    /**
     * Fetch most recent conversational memory summaries.
     * @param opts.limit - Max results (default: 10)
     * @param opts.connectors - Comma-separated connector list
     */
    recent: async (opts?: {
      limit?: number
      connectors?: string
    }): Promise<MemoryRecentResponse> => {
      const params = new URLSearchParams()
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
      if (opts?.connectors) params.set('connectors', opts.connectors)
      const query = params.toString()
      return this.get<MemoryRecentResponse>(`/memory/recent${query ? `?${query}` : ''}`)
    },
  }

  // ============ Goals ============

  /**
   * Agent goals management methods.
   */
  goals = {
    /**
     * List goals with optional filters.
     * @param opts.status - Filter by status
     * @param opts.parent_id - Filter by parent goal ID
     * @param opts.limit - Max results (default: 50)
     * @param opts.offset - Pagination offset (default: 0)
     */
    list: async (opts?: {
      status?: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'
      parent_id?: string | null
      limit?: number
      offset?: number
    }): Promise<AgentGoal[]> => {
      const params = new URLSearchParams()
      if (opts?.status) params.set('status', opts.status)
      if (opts?.parent_id === null) params.set('parent_id', 'null')
      else if (opts?.parent_id) params.set('parent_id', opts.parent_id)
      if (opts?.limit) params.set('limit', String(opts.limit))
      if (opts?.offset) params.set('offset', String(opts.offset))
      const query = params.toString()
      const response = await this.get<GoalsResponse>(`/goals${query ? `?${query}` : ''}`)
      return response.goals
    },

    /**
     * Get active goals ordered by priority.
     * @param limit - Max results (default: 50)
     */
    getActive: async (limit = 50): Promise<AgentGoal[]> => {
      const response = await this.get<GoalsResponse>(`/goals/active?limit=${limit}`)
      return response.goals
    },

    /**
     * Get goals due soon.
     * @param hours - Hours horizon (default: 24)
     * @param limit - Max results (default: 20)
     */
    getDueSoon: async (hours = 24, limit = 20): Promise<AgentGoal[]> => {
      const response = await this.get<GoalsResponse>(`/goals/due-soon?hours=${hours}&limit=${limit}`)
      return response.goals
    },

    /**
     * Get a goal by ID.
     */
    get: async (id: string): Promise<AgentGoal> => {
      const response = await this.get<GoalResponse>(`/goals/${id}`)
      return response.goal
    },

    /**
     * Create a new goal.
     */
    create: async (input: GoalCreateInput): Promise<AgentGoal> => {
      const response = await this.post<GoalResponse>('/goals', input)
      return response.goal
    },

    /**
     * Update a goal.
     */
    update: async (id: string, input: GoalUpdateInput): Promise<AgentGoal> => {
      const response = await this.patch<GoalResponse>(`/goals/${id}`, input)
      return response.goal
    },

    /**
     * Mark a goal as completed.
     */
    complete: async (id: string): Promise<AgentGoal> => {
      const response = await this.post<GoalResponse>(`/goals/${id}/complete`)
      return response.goal
    },

    /**
     * Update goal priority.
     */
    updatePriority: async (id: string, priority: number): Promise<AgentGoal> => {
      const response = await this.patch<GoalResponse>(`/goals/${id}/priority`, { priority })
      return response.goal
    },

    /**
     * Delete a goal.
     */
    delete: async (id: string): Promise<boolean> => {
      await this.delete<{ deleted: boolean }>(`/goals/${id}`)
      return true
    },
  }

  // ============ Actions ============

  /**
   * Agent actions tracking methods.
   */
  actions = {
    /**
     * List actions with optional filters.
     * @param opts.action_type - Filter by action type
     * @param opts.outcome_signal - Filter by outcome signal
     * @param opts.resolved - Filter by resolved status
     * @param opts.since - Filter actions since date
     * @param opts.limit - Max results (default: 100)
     * @param opts.offset - Pagination offset (default: 0)
     */
    list: async (opts?: {
      action_type?: string
      outcome_signal?: 'positive' | 'negative' | 'neutral' | 'unknown'
      resolved?: boolean
      since?: Date
      limit?: number
      offset?: number
    }): Promise<AgentAction[]> => {
      const params = new URLSearchParams()
      if (opts?.action_type) params.set('action_type', opts.action_type)
      if (opts?.outcome_signal) params.set('outcome_signal', opts.outcome_signal)
      if (opts?.resolved !== undefined) params.set('resolved', String(opts.resolved))
      if (opts?.since) params.set('since', opts.since.toISOString())
      if (opts?.limit) params.set('limit', String(opts.limit))
      if (opts?.offset) params.set('offset', String(opts.offset))
      const query = params.toString()
      const response = await this.get<ActionsResponse>(`/actions${query ? `?${query}` : ''}`)
      return response.actions
    },

    /**
     * Get unresolved actions.
     * @param limit - Max results (default: 50)
     */
    getUnresolved: async (limit = 50): Promise<AgentAction[]> => {
      const response = await this.get<ActionsResponse>(`/actions/unresolved?limit=${limit}`)
      return response.actions
    },

    /**
     * Get recent actions.
     * @param limit - Max results (default: 20)
     */
    getRecent: async (limit = 20): Promise<AgentAction[]> => {
      const response = await this.get<ActionsResponse>(`/actions/recent?limit=${limit}`)
      return response.actions
    },

    /**
     * Get success rate for an action type.
     * @param actionType - Action type to analyze
     * @param since - Optional start date for analysis
     */
    getSuccessRate: async (actionType: string, since?: Date): Promise<ActionStats> => {
      const params = new URLSearchParams()
      params.set('action_type', actionType)
      if (since) params.set('since', since.toISOString())
      const response = await this.get<ActionStatsResponse>(`/actions/stats?${params}`)
      return response.stats
    },

    /**
     * Get an action by ID.
     */
    get: async (id: string): Promise<AgentAction> => {
      const response = await this.get<ActionResponse>(`/actions/${id}`)
      return response.action
    },

    /**
     * Create a new action record.
     */
    create: async (input: ActionCreateInput): Promise<AgentAction> => {
      const response = await this.post<ActionResponse>('/actions', input)
      return response.action
    },

    /**
     * Update an action.
     */
    update: async (id: string, input: ActionUpdateInput): Promise<AgentAction> => {
      const response = await this.patch<ActionResponse>(`/actions/${id}`, input)
      return response.action
    },

    /**
     * Record the outcome of an action.
     */
    recordOutcome: async (id: string, input: ActionOutcomeInput): Promise<AgentAction> => {
      const response = await this.post<ActionResponse>(`/actions/${id}/outcome`, input)
      return response.action
    },

    /**
     * Delete an action.
     */
    delete: async (id: string): Promise<boolean> => {
      await this.delete<{ deleted: boolean }>(`/actions/${id}`)
      return true
    },
  }

  // ============ Traces ============

  /**
   * Agent traces management methods.
   */
  traces = {
    /**
     * List traces with optional filters.
     * @param opts.session_key - Filter by session key
     * @param opts.tool_name - Filter by tool name
     * @param opts.limit - Max results (default: 50)
     * @param opts.offset - Pagination offset (default: 0)
     */
    list: async (opts?: {
      session_key?: string
      tool_name?: string
      limit?: number
      offset?: number
    }): Promise<{ traces: AgentTrace[]; total: number }> => {
      const params = new URLSearchParams()
      if (opts?.session_key) params.set('session_key', opts.session_key)
      if (opts?.tool_name) params.set('tool_name', opts.tool_name)
      if (opts?.limit) params.set('limit', String(opts.limit))
      if (opts?.offset) params.set('offset', String(opts.offset))
      const query = params.toString()
      const response = await this.get<TracesResponse>(`/traces${query ? `?${query}` : ''}`)
      return response
    },

    /**
     * Get recent traces.
     * @param limit - Max results (default: 50)
     */
    getRecent: async (limit = 50): Promise<{ traces: AgentTrace[]; total: number }> => {
      const response = await this.get<TracesResponse>(`/traces/recent?limit=${limit}`)
      return response
    },

    /**
     * Get traces by session key.
     * @param sessionKey - Session key
     * @param limit - Max results (default: 50)
     */
    getBySession: async (sessionKey: string, limit = 50): Promise<{ traces: AgentTrace[]; total: number }> => {
      const response = await this.get<TracesResponse>(`/traces/session/${sessionKey}?limit=${limit}`)
      return response
    },

    /**
     * Get traces by model ID.
     * @param modelId - Model ID (e.g., 'anthropic/claude-opus-4-5-20251101')
     * @param limit - Max results (default: 50)
     */
    getByModel: async (modelId: string, limit = 50): Promise<{ traces: AgentTrace[]; total: number }> => {
      const response = await this.get<TracesResponse>(`/traces/model/${encodeURIComponent(modelId)}?limit=${limit}`)
      return response
    },

    /**
     * Get a trace by ID.
     */
    get: async (id: string): Promise<AgentTrace> => {
      const response = await this.get<TraceResponse>(`/traces/${id}`)
      return response.trace
    },

    /**
     * Get a trace by git revision (commit SHA).
     */
    getByRevision: async (revision: string): Promise<AgentTrace> => {
      const response = await this.get<TraceResponse>(`/traces/revision/${revision}`)
      return response.trace
    },

    /**
     * Create a new trace record.
     */
    create: async (input: {
      id?: string
      revision: string
      session_key?: string | null
      tool_name?: string
      tool_version?: string
      trace: TraceRecord
    }): Promise<AgentTrace> => {
      const response = await this.post<TraceResponse>('/traces', input)
      return response.trace
    },

    /**
     * Update an existing trace.
     */
    update: async (
      id: string,
      updates: Partial<{
        session_key?: string
        tool_name?: string
        tool_version?: string
        trace: TraceRecord
      }>
    ): Promise<AgentTrace> => {
      const response = await this.patch<TraceResponse>(`/traces/${id}`, updates)
      return response.trace
    },

    /**
     * Delete a trace by ID.
     */
    delete: async (id: string): Promise<boolean> => {
      await this.delete<{ deleted: boolean }>(`/traces/${id}`)
      return true
    },
  }

  // ============ Escalations ============

  escalations = {
    create: async (input: EscalationCreateInput): Promise<Escalation> => {
      const response = await this.post<EscalationResponse>('/escalations', input)
      return response.escalation
    },

    resolve: async (id: string, input: EscalationResolveInput): Promise<Escalation> => {
      const response = await this.post<EscalationResponse>(`/escalations/${id}/resolve`, input)
      return response.escalation
    },

    dismiss: async (id: string): Promise<Escalation> => {
      const response = await this.post<EscalationResponse>(`/escalations/${id}/dismiss`, {})
      return response.escalation
    },

    get: async (id: string): Promise<Escalation> => {
      const response = await this.get<EscalationResponse>(`/escalations/${id}`)
      return response.escalation
    },
  }

  // ============ Events ============

  /**
   * Internal event streaming methods.
   */
  events = {
    /**
     * Subscribe to internal daemon events using Server-Sent Events (SSE).
     * Returns an async iterator of events.
     * @param opts.types - Event types to filter by (e.g., ['webhook:received', 'scheduler:task_executed'])
     * @param opts.source - Filter by event source ('webhook', 'scheduler', 'engine', 'daemon')
     * @example
     * ```ts
     * for await (const event of await client.events.subscribe()) {
     *   console.log('Event:', event.type, event.data)
     * }
     * ```
     */
    subscribe: async (opts?: {
      types?: string[]
      source?: 'webhook' | 'scheduler' | 'engine' | 'daemon'
    }): Promise<AsyncIterable<InternalEvent>> => {
      const params = new URLSearchParams()
      if (opts?.types?.length) params.set('types', opts.types.join(','))
      if (opts?.source) params.set('source', opts.source)
      const query = params.toString()
      const url = `${this.baseUrl}/api/events/stream${query ? `?${query}` : ''}`

      const response = await fetch(url, {
        headers: {
          ...this.headers,
        },
      })

      if (!response.ok) {
        const errorBody = await response.text()
        throw new SyncClientError(`Failed to subscribe to events: ${errorBody}`, response.status)
      }

      const contentType = response.headers.get('content-type')
      if (!contentType?.includes('text/event-stream')) {
        throw new SyncClientError('Expected text/event-stream response', response.status)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new SyncClientError('Response body is not readable', response.status)
      }

      const decoder = new TextDecoder()
      let buffer = ''

      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6).trim()
                  if (data) {
                    try {
                      const event = JSON.parse(data) as InternalEvent
                      yield event
                    } catch (error) {
                      console.error('[SyncClient] Failed to parse event:', error)
                    }
                  }
                }
              }
            }
          } finally {
            reader.releaseLock()
          }
        },
      }
    },

    /**
     * List recent internal events (not live stream).
     * @param opts.limit - Max events to return (default: 100)
     * @param opts.types - Event types to filter by
     * @param opts.source - Filter by event source
     */
    list: async (opts?: {
      limit?: number
      types?: string[]
      source?: 'webhook' | 'scheduler' | 'engine' | 'daemon'
    }): Promise<InternalEvent[]> => {
      const params = new URLSearchParams()
      if (opts?.limit) params.set('limit', String(opts.limit))
      if (opts?.types?.length) params.set('types', opts.types.join(','))
      if (opts?.source) params.set('source', opts.source)
      const query = params.toString()
      const response = await this.get<{ events: InternalEvent[] }>(`/events${query ? `?${query}` : ''}`)
      return response.events
    },
  }
}

// Re-export types
export * from './types.js'
export { captureOAuthCallback, getCallbackUri, type OAuthResult, type OAuthCallbackOptions } from './oauth.js'

// Add CodingDecision to default export for CLI import compatibility
export type { CodingDecision } from './types.js'
