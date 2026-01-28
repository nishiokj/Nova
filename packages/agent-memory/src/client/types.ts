/**
 * Sync Client Response Types
 *
 * Types matching the daemon API responses.
 */

import type { ConnectorType } from '../ids.js'

// ============ Health ============

export interface HealthResponse {
  status: string
  timestamp: string
}

// ============ Accounts ============

export interface Account {
  id: string
  connector: ConnectorType
  external_account_id: string
  display_name?: string
  email?: string
  auth_type: 'oauth2' | 'api_key' | 'basic' | 'token'
  token_expires_at?: string
  is_active: boolean
  last_synced_at?: string
  sync_cursor?: string
  created_at: string
  updated_at: string
}

export interface AccountListResponse {
  accounts: Account[]
}

export interface AccountResponse {
  account: Account
}

// ============ Auth ============

export interface OAuthProvider {
  id: string
  name: string
  configured: boolean
}

export interface ProvidersResponse {
  providers: string[]
}

export interface AuthUrlResponse {
  url: string
  state: string
  provider?: string
  /** Set when existing credentials were found for the same OAuth provider */
  existingCredentials?: boolean
  /** Account ID with existing credentials that can be reused */
  existingAccountId?: string
  /** Whether the existing credentials have all required scopes */
  hasAllScopes?: boolean
}

export interface AuthStatusResponse {
  accountId: string
  hasCredentials: boolean
}

export interface DeviceAuthResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
  connector: string
  provider: string
}

export interface DeviceAuthPollResponse {
  status: 'pending' | 'complete'
  account?: Account
}

// ============ Connectors ============

export interface ConnectorInfo {
  type: string
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

export interface ConnectorListResponse {
  connectors: ConnectorInfo[]
}

export interface ConnectorResponse {
  connector: ConnectorInfo
  registration?: RegisteredConnector
  factoryAvailable?: boolean
}

export interface AvailableConnectorsResponse {
  available: string[]
}

export interface RegisteredConnector {
  type: string
  enabled: boolean
  config: Record<string, unknown>
  registered_at: string
  updated_at: string
}

export interface ConnectorRegistrationResponse {
  connector: ConnectorInfo | null
  registration: RegisteredConnector
}

export interface ConnectorUnregisterResponse {
  success: boolean
  message: string
}

// ============ Sanity ============

export type SanityCheckStatus = 'ok' | 'warning' | 'error'

export interface SanityCheck {
  id: string
  status: SanityCheckStatus
  message: string
  details?: Record<string, unknown>
}

export interface SyncEstimateEntry {
  type: string
  count?: number
  description: string
}

export interface SyncEstimate {
  entities: SyncEstimateEntry[]
  summary?: string
}

export interface SanityCheckResult {
  ok: boolean
  checks: SanityCheck[]
  estimate?: SyncEstimate
}

export interface ConnectorSanityResponse {
  sanity: SanityCheckResult
}

export interface TaskSanityResponse {
  sanity: SanityCheckResult
}

// ============ Tasks ============

export type SyncType = 'backfill' | 'incremental'
export type TaskMode = 'once' | 'recurring' | 'webhook'

export interface SyncTask {
  id: string
  connector: ConnectorType
  account_id: string
  entity_types: string[] | null
  sync_type: SyncType
  mode: TaskMode
  interval_ms: number | null
  enabled: boolean
  last_job_id: string | null
  next_run_at: string | null
  webhook_subscription_id: string | null
  created_at: string
  updated_at: string
}

export interface TaskListResponse {
  tasks: SyncTask[]
}

export interface TaskResponse {
  task: SyncTask
  recentJobs?: SyncJob[]
}

export interface BackfillResponse {
  task: SyncTask
  job: SyncJob
}

// ============ Processing ============

export interface ProcessResultItem {
  success: boolean
  envelopeId: string
  entityIds: string[]
  mappings: Array<Record<string, unknown>>
  error?: string
}

export interface BatchProcessResult {
  total: number
  succeeded: number
  failed: number
  results: ProcessResultItem[]
}

export interface ProcessJobResponse {
  job: SyncJob
  result: BatchProcessResult
}

export interface ProcessAllResponse {
  result: BatchProcessResult
}

export interface ProcessErroredResponse {
  result: BatchProcessResult
}

export interface ReprocessFilteredRequest {
  connector?: string
  entityType?: string
  transformationIds?: string[]
}

export interface ReprocessFilteredResponse {
  result: BatchProcessResult
}

export interface ProcessErroredResponse {
  result: BatchProcessResult
}

// ============ Transformations ============

export interface TransformationSummary {
  id: string
  name: string
  source: {
    connector: ConnectorType
    entityType: string
  }
  outputType: string | string[]
  enabled: boolean
  version: number
  description?: string
}

export interface TransformationListResponse {
  transformations: TransformationSummary[]
}

// ============ Derived Tasks ============

export type DerivedTaskMode = 'once' | 'recurring' | 'event'

export interface DerivedTask {
  id: string
  name: string
  script_path: string
  mode: DerivedTaskMode
  interval_ms: number | null
  enabled: boolean
  last_job_id: string | null
  next_run_at: string | null
  metadata?: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface DerivedTaskListResponse {
  tasks: DerivedTask[]
}

export interface DerivedTaskResponse {
  task: DerivedTask
  recentJobs?: DerivedJob[]
}

export interface DerivedTaskSandboxResult {
  job: DerivedJob
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout'
  durationMs: number
  lastError?: string
  logPath?: string
}

export interface DerivedTaskCreateResponse {
  task: DerivedTask
  sandbox?: DerivedTaskSandboxResult
  sandboxError?: string
}

// ============ Jobs ============

export type SyncJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type SyncJobType = 'backfill' | 'incremental' | 'webhook'

export interface SyncJob {
  id: string
  connector: ConnectorType
  account_id: string
  job_type: SyncJobType
  status: SyncJobStatus
  priority: number
  cursor_state?: Record<string, unknown>
  items_fetched: number
  items_processed: number
  items_failed: number
  created_at: string
  started_at?: string
  completed_at?: string
  last_error?: string
  retry_count: number
  next_retry_at?: string
  metadata?: Record<string, unknown>
}

export interface QueueStats {
  pending: number
  running: number
  completed: number
  failed: number
  avgProcessTime?: number
}

export interface JobListResponse {
  jobs: SyncJob[]
}

export interface JobResponse {
  job: SyncJob
  queueStats?: QueueStats
}

export interface RetryResponse {
  job: SyncJob
  originalJob: SyncJob
}

// ============ Derived Jobs ============

export type DerivedJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface DerivedJob {
  id: string
  task_id: string
  status: DerivedJobStatus
  priority: number
  created_at: string
  started_at?: string
  completed_at?: string
  last_error?: string
  retry_count: number
  next_retry_at?: string
  metadata?: Record<string, unknown>
  output_ref?: string
}

export interface DerivedJobListResponse {
  jobs: DerivedJob[]
}

export interface DerivedJobResponse {
  job: DerivedJob
  queueStats?: QueueStats
}

export interface DerivedJobLogsResponse {
  logPath: string
  exists: boolean
  lines: string[]
  truncated: boolean
}

export interface DerivedRetryResponse {
  job: DerivedJob
  originalJob: DerivedJob
}

// ============ Data ============

export interface Entity {
  id: string
  entity_type: string
  data: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface EntityListResponse {
  entities: Entity[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

export interface EntityResponse {
  entity: Entity
  sources?: unknown[]
  mappings?: unknown[]
}

// ============ Error ============

export interface ApiError {
  error: string
  code?: string
  message?: string
}

// ============ Preferences ============

export interface CodingPreference {
  id: string
  category: string
  kind: string
  preference: string
  entity_free_formulation: string
  scope: string
  context: string
  failure_mode_prevented: string
  signal_strength: 'explicit' | 'implicit'
  evidence_count: number
  evidence_notes: unknown
  counterexample: string
  confidence: 'low' | 'medium' | 'high'
  created_at: string
  rank: number
}

export interface PreferencesSearchResponse {
  preferences: CodingPreference[]
  total: number
  query: string
  filters: {
    category?: string
    kind?: string
    confidence?: string
  }
}

export class SyncClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly data?: unknown
  ) {
    super(message)
    this.name = 'SyncClientError'
  }
}

// ============ Decisions ============

export interface CodingDecision {
  id: string
  category: string
  decision: string
  rationale: string
  alternatives_considered: string
  tradeoffs: string
  scope: string
  project_context: string
  task_context: string
  confidence: 'low' | 'medium' | 'high'
  signal_strength: 'explicit' | 'implicit'
  reversibility: 'easy' | 'moderate' | 'hard'
  created_at: string
  rank?: number
  similarity?: number
}

export interface DecisionsSearchResponse {
  decisions: CodingDecision[]
  total: number
  query?: string
  filters?: {
    category?: string
    confidence?: string
  }
}
