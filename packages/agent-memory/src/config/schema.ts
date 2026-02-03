/**
 * Configuration Schema
 *
 * Zod schemas for all configuration options with sensible defaults.
 * This module defines the shape of the configuration and validates inputs.
 *
 * @module config/schema
 */

import { z } from 'zod'

// ============ Database Configuration ============

export const DatabaseConfigSchema = z.object({
  /** Connection string (postgres://...) */
  connectionString: z.string().optional(),
  /** Host (default: localhost) */
  host: z.string().default('localhost'),
  /** Port (default: 5432) */
  port: z.number().int().positive().default(5432),
  /** Database name */
  database: z.string().default('agent_memory'),
  /** Username */
  username: z.string().default('postgres'),
  /** Password */
  password: z.string().default(''),
  /** Max connections in pool (default: 10) */
  max: z.number().int().positive().default(10),
  /** Idle timeout in seconds (default: 30) */
  idleTimeout: z.number().int().nonnegative().default(30),
  /** Connect timeout in seconds (default: 10) */
  connectTimeout: z.number().int().positive().default(10),
  /** Enable SSL */
  ssl: z.union([z.boolean(), z.literal('require'), z.literal('prefer')]).optional(),
  /** Schema to use (default: public) */
  schema: z.string().default('public'),
})

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>

// ============ Queue Configuration ============

export const QueueConfigSchema = z.object({
  /** Visibility timeout in ms (default: 30000) */
  visibilityTimeout: z.number().int().positive().default(30000),
  /** Max attempts before marking dead (default: 3) */
  maxAttempts: z.number().int().positive().default(3),
  /** Base retry delay in ms (default: 1000) */
  baseRetryDelay: z.number().int().positive().default(1000),
  /** Max retry delay in ms (default: 60000) */
  maxRetryDelay: z.number().int().positive().default(60000),
  /** Max job runtime in ms before timeout (default: 180000 = 3 min) */
  maxJobRuntime: z.number().int().positive().default(180000),
  /** Poll interval when queue is empty in ms (default: 100) */
  pollInterval: z.number().int().positive().default(100),
  /** Heartbeat interval for extending locks in ms (default: 10000) */
  heartbeatInterval: z.number().int().positive().default(10000),
  /** Directory to dump failed job payloads */
  deadJobDir: z.string().default('./data/dead-jobs'),
})

export type QueueConfig = z.infer<typeof QueueConfigSchema>

// ============ HTTP Client Configuration ============

export const HttpConfigSchema = z.object({
  /** Connection timeout in milliseconds */
  connectTimeout: z.number().int().positive().default(5000),
  /** Request timeout in milliseconds */
  requestTimeout: z.number().int().positive().default(30000),
  /** Maximum retry attempts */
  maxRetries: z.number().int().nonnegative().default(3),
  /** HTTP status codes that trigger a retry */
  retryableStatuses: z.array(z.number().int()).default([429, 500, 502, 503, 504]),
  /** Base delay for exponential backoff (ms) */
  baseRetryDelay: z.number().int().positive().default(1000),
  /** Maximum delay between retries (ms) */
  maxRetryDelay: z.number().int().positive().default(30000),
  /** Maximum requests per second (rate limiting) */
  maxRequestsPerSecond: z.number().positive().default(10),
  /** Number of failures before circuit breaker opens */
  circuitBreakerThreshold: z.number().int().positive().default(5),
  /** Time before circuit breaker attempts half-open (ms) */
  circuitBreakerResetMs: z.number().int().positive().default(30000),
  /** Maximum concurrent connections */
  maxConnections: z.number().int().positive().default(10),
})

export type HttpConfig = z.infer<typeof HttpConfigSchema>

// ============ Sync Engine Configuration ============

export const SyncConfigSchema = z.object({
  /** Whether to automatically process after collecting (default: false) */
  autoProcess: z.boolean().default(false),
  /** Poll interval for the queue in ms (default: 100) */
  pollInterval: z.number().int().positive().default(100),
  /** Maximum job runtime in ms (default: 300000 = 5 min) */
  maxJobRuntime: z.number().int().positive().default(300000),
  /** Batch size for processing envelopes (default: 100) */
  processBatchSize: z.number().int().positive().default(100),
  /** Max concurrent processing operations (default: 5) */
  processConcurrency: z.number().int().positive().default(5),
  /** Whether to fail on first error or continue (default: false) */
  failFast: z.boolean().default(false),
})

export type SyncConfig = z.infer<typeof SyncConfigSchema>

// ============ Entity Resolution Configuration ============

export const MatchWeightsSchema = z.object({
  emailExact: z.number().min(0).max(2).default(1.0),
  emailDomain: z.number().min(0).max(2).default(1.0),
  phoneExact: z.number().min(0).max(2).default(1.0),
  usernameMatch: z.number().min(0).max(2).default(1.0),
  nameExact: z.number().min(0).max(2).default(1.0),
  nameFuzzy: z.number().min(0).max(2).default(1.0),
  orgOverlap: z.number().min(0).max(2).default(1.0),
})

export type MatchWeightsConfig = z.infer<typeof MatchWeightsSchema>

export const EntityResolutionConfigSchema = z.object({
  /** Score threshold for automatic merge (default: 80) */
  mergeThreshold: z.number().min(0).max(100).default(80),
  /** Score threshold for human review queue (default: 50) */
  reviewThreshold: z.number().min(0).max(100).default(50),
  /** Custom weights for match scoring */
  weights: MatchWeightsSchema.partial().default({}),
  /** Maximum candidates to evaluate per identity (default: 100) */
  maxCandidates: z.number().int().positive().default(100),
  /** Enable fuzzy name matching (default: true) */
  enableFuzzyMatch: z.boolean().default(true),
})

export type EntityResolutionConfig = z.infer<typeof EntityResolutionConfigSchema>

// ============ Embeddings Configuration ============

export const EmbeddingsConfigSchema = z.object({
  /** Embedding dimension (default: 1536 for OpenAI ada-002) */
  dimension: z.number().int().positive().default(1536),
  /** Embedding model identifier */
  model: z.string().default('text-embedding-ada-002'),
  /** Batch size for embedding requests */
  batchSize: z.number().int().positive().default(100),
  /** Whether to generate embeddings automatically */
  autoEmbed: z.boolean().default(false),
})

export type EmbeddingsConfig = z.infer<typeof EmbeddingsConfigSchema>

// ============ Connector Configuration ============

export const ConnectorConfigSchema = z.object({
  /** GitHub connector settings */
  github: z.object({
    /** Enable this connector */
    enabled: z.boolean().default(false),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    /** Requests per second limit */
    rateLimit: z.number().positive().default(5),
    /** Enable notifications sync */
    syncNotifications: z.boolean().default(true),
    /** Enable starred repos sync */
    syncStarred: z.boolean().default(false),
  }).default({}),

  /** Gmail connector settings */
  gmail: z.object({
    /** Enable this connector */
    enabled: z.boolean().default(false),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    rateLimit: z.number().positive().default(10),
    /** Labels to sync (empty = all) */
    labels: z.array(z.string()).default([]),
    /** Exclude labels */
    excludeLabels: z.array(z.string()).default(['SPAM', 'TRASH']),
  }).default({}),

  /** Telegram connector settings */
  telegram: z.object({
    /** Enable this connector */
    enabled: z.boolean().default(false),
    /** Bot token from @BotFather */
    botToken: z.string().optional(),
    /** Harness daemon host */
    harnessHost: z.string().default('127.0.0.1'),
    /** Harness daemon port */
    harnessPort: z.number().int().positive().default(9555),
    /** Working directory for agent */
    workingDir: z.string().optional(),
    /** Allowed user IDs (empty = dangerous mode) */
    allowedUserIds: z.array(z.number()).optional(),
    /** Allow all users (dangerous) */
    dangerousMode: z.boolean().default(false),
  }).default({}),

  /** X.com (Twitter) connector settings */
  xcom: z.object({
    /** Enable this connector */
    enabled: z.boolean().default(false),
    bearerToken: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    rateLimit: z.number().positive().default(5),
  }).default({}),

  /** iMessage connector settings */
  imessage: z.object({
    /** Enable this connector */
    enabled: z.boolean().default(false),
    /** Path to chat.db (default: ~/Library/Messages/chat.db) */
    databasePath: z.string().optional(),
    /** Sync attachments */
    syncAttachments: z.boolean().default(true),
    /** Max message text bytes before truncation (0 = unlimited) */
    maxTextBytes: z.number().int().nonnegative().default(1024 * 1024),
  }).default({}),

  /** Claude Code Sessions connector settings */
  claude_sessions: z.object({
    /** Enable this connector */
    enabled: z.boolean().default(false),
    /** Path to Claude projects (default: ~/.claude/projects) */
    projectsPath: z.string().optional(),
    /** Specific projects to sync (empty = all) */
    projectFilter: z.array(z.string()).optional(),
    /** Sessions per page (default: 10) */
    pageSize: z.number().int().positive().default(10),
    /** Include file history snapshots */
    includeFileHistory: z.boolean().default(false),
  }).default({}),

  /** Rex Sessions connector settings */
  rex_sessions: z.object({
    /** Enable this connector */
    enabled: z.boolean().default(false),
    /** Path to GraphD SQLite database (default: ~/.graphd/graphd.db) */
    databasePath: z.string().optional(),
    /** Filter sessions by working_dir substrings */
    projectFilter: z.array(z.string()).optional(),
    /** Filter sessions by session_key substrings */
    sessionFilter: z.array(z.string()).optional(),
    /** Filter sessions by client_type */
    clientTypeFilter: z.array(z.string()).optional(),
    /** Messages per page (default: 100) */
    pageSize: z.number().int().positive().default(100),
    /** Debounce window for DB change events (ms) */
    webhookDebounceMs: z.number().int().positive().default(500),
    /** When true, webhook ingestion starts at latest row id */
    webhookStartAtLatest: z.boolean().default(true),
    /** Max rows to pull per webhook batch */
    webhookBatchSize: z.number().int().positive().default(500),
  }).default({}),
})

export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>

// ============ Observability Configuration ============

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal'])

export type LogLevel = z.infer<typeof LogLevelSchema>

export const ObservabilityConfigSchema = z.object({
  /** Minimum log level to output */
  logLevel: LogLevelSchema.default('info'),
  /** Log output format */
  logFormat: z.enum(['json', 'pretty']).default('json'),
  /** Enable metrics collection */
  metricsEnabled: z.boolean().default(true),
  /** Enable distributed tracing */
  tracingEnabled: z.boolean().default(false),
  /** Tracing exporter endpoint */
  tracingEndpoint: z.string().url().optional(),
  /** Sampling rate for tracing (0-1) */
  tracingSampleRate: z.number().min(0).max(1).default(0.1),
  /** Health check interval in ms */
  healthCheckInterval: z.number().int().positive().default(30000),
})

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>

// ============ Security Configuration ============

export const SecurityConfigSchema = z.object({
  /** Encryption key for credentials (32 bytes, hex-encoded) */
  encryptionKey: z.string().length(64).optional(),
  /** Enable PII redaction in logs */
  redactPII: z.boolean().default(true),
  /** Allowed CORS origins */
  corsOrigins: z.array(z.string()).default([]),
})

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>

// ============ Top-Level Application Configuration ============

export const AppConfigSchema = z.object({
  /** Database configuration */
  database: DatabaseConfigSchema.default({}),
  /** Queue configuration */
  queue: QueueConfigSchema.default({}),
  /** HTTP client configuration */
  http: HttpConfigSchema.default({}),
  /** Sync engine configuration */
  sync: SyncConfigSchema.default({}),
  /** Entity resolution configuration */
  entityResolution: EntityResolutionConfigSchema.default({}),
  /** Embeddings configuration */
  embeddings: EmbeddingsConfigSchema.default({}),
  /** Connector-specific configuration */
  connectors: ConnectorConfigSchema.default({}),
  /** Observability configuration */
  observability: ObservabilityConfigSchema.default({}),
  /** Security configuration */
  security: SecurityConfigSchema.default({}),
  /** Data directory for file storage (default: ./data) */
  dataDir: z.string().default('./data'),
  /** Environment name */
  env: z.enum(['development', 'test', 'staging', 'production']).default('development'),
})

export type AppConfig = z.infer<typeof AppConfigSchema>

// ============ Partial Config for Merging ============

export type PartialAppConfig = z.input<typeof AppConfigSchema>

// ============ Default Configuration ============

export const DEFAULT_CONFIG: AppConfig = AppConfigSchema.parse({})

/**
 * Validate and parse configuration.
 * Returns a fully-populated config with defaults filled in.
 */
export function parseConfig(config: unknown): AppConfig {
  return AppConfigSchema.parse(config)
}

/**
 * Safely validate configuration without throwing.
 * Returns the parsed config or validation errors.
 */
export function safeParseConfig(config: unknown): z.SafeParseReturnType<unknown, AppConfig> {
  return AppConfigSchema.safeParse(config)
}
