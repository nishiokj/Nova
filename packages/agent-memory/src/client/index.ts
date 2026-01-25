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
  AuthStatusResponse,
  AuthUrlResponse,
  BackfillResponse,
  HealthResponse,
  JobListResponse,
  JobResponse,
  ProvidersResponse,
  RetryResponse,
  SyncJob,
  SyncTask,
  SyncType,
  TaskListResponse,
  TaskResponse,
} from './types.js'
import { SyncClientError } from './types.js'

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
        let errorData: { error?: string; code?: string } = {}
        try {
          errorData = JSON.parse(errorBody)
        } catch {
          errorData = { error: errorBody }
        }
        throw new SyncClientError(
          errorData.error || `HTTP ${response.status}`,
          response.status,
          errorData.code
        )
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
     * Get task by ID with recent jobs.
     */
    get: async (id: string): Promise<TaskResponse> => {
      return this.get<TaskResponse>(`/tasks/${id}`)
    },

    /**
     * Create a one-shot backfill task and schedule immediately.
     */
    backfill: async (
      accountId: string,
      entityTypes?: string[]
    ): Promise<BackfillResponse> => {
      return this.post<BackfillResponse>('/tasks/backfill', { accountId, entityTypes })
    },

    /**
     * Create a recurring sync subscription.
     */
    subscribe: async (
      accountId: string,
      opts: {
        syncType: SyncType
        intervalMs: number
        entityTypes?: string[]
      }
    ): Promise<SyncTask> => {
      const response = await this.post<{ task: SyncTask }>('/tasks/subscribe', {
        accountId,
        ...opts,
      })
      return response.task
    },

    /**
     * Create a webhook-driven sync task.
     */
    webhook: async (
      accountId: string,
      entityTypes?: string[]
    ): Promise<SyncTask> => {
      const response = await this.post<{ task: SyncTask }>('/tasks/webhook', {
        accountId,
        entityTypes,
      })
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
}

// Re-export types
export * from './types.js'
export { captureOAuthCallback, getCallbackUri, type OAuthResult, type OAuthCallbackOptions } from './oauth.js'
