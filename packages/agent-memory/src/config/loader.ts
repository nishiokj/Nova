/**
 * Configuration Loader
 *
 * Load configuration from multiple sources with precedence:
 * 1. Programmatic overrides (highest)
 * 2. Environment variables
 * 3. Config file (JSON or JS)
 * 4. Default values (lowest)
 *
 * @module config/loader
 */

import { z } from 'zod'
import {
  type AppConfig,
  type PartialAppConfig,
  AppConfigSchema,
  DEFAULT_CONFIG,
} from './schema.js'

// ============ Environment Variable Mapping ============

/**
 * Environment variable prefix for agent-memory config.
 */
const ENV_PREFIX = 'AGENT_MEMORY_'

/**
 * Well-known PostgreSQL environment variables.
 */
const PG_ENV_VARS = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'] as const

/**
 * Map environment variables to config paths.
 * Format: ENV_VAR -> config.path.key
 */
const ENV_MAPPING: Record<string, string> = {
  // Database (PostgreSQL standard vars)
  DATABASE_URL: 'database.connectionString',
  POSTGRES_URL: 'database.connectionString',
  PGHOST: 'database.host',
  PGPORT: 'database.port',
  PGDATABASE: 'database.database',
  PGUSER: 'database.username',
  PGPASSWORD: 'database.password',

  // Database (prefixed vars)
  [`${ENV_PREFIX}DATABASE_URL`]: 'database.connectionString',
  [`${ENV_PREFIX}DB_HOST`]: 'database.host',
  [`${ENV_PREFIX}DB_PORT`]: 'database.port',
  [`${ENV_PREFIX}DB_NAME`]: 'database.database',
  [`${ENV_PREFIX}DB_USER`]: 'database.username',
  [`${ENV_PREFIX}DB_PASSWORD`]: 'database.password',
  [`${ENV_PREFIX}DB_MAX`]: 'database.max',
  [`${ENV_PREFIX}DB_SSL`]: 'database.ssl',

  // Queue
  [`${ENV_PREFIX}QUEUE_VISIBILITY_TIMEOUT`]: 'queue.visibilityTimeout',
  [`${ENV_PREFIX}QUEUE_MAX_ATTEMPTS`]: 'queue.maxAttempts',
  [`${ENV_PREFIX}QUEUE_MAX_JOB_RUNTIME`]: 'queue.maxJobRuntime',
  [`${ENV_PREFIX}DEAD_JOB_DIR`]: 'queue.deadJobDir',

  // HTTP
  [`${ENV_PREFIX}HTTP_TIMEOUT`]: 'http.requestTimeout',
  [`${ENV_PREFIX}HTTP_MAX_RETRIES`]: 'http.maxRetries',
  [`${ENV_PREFIX}HTTP_RATE_LIMIT`]: 'http.maxRequestsPerSecond',

  // Sync
  [`${ENV_PREFIX}SYNC_AUTO_PROCESS`]: 'sync.autoProcess',
  [`${ENV_PREFIX}SYNC_BATCH_SIZE`]: 'sync.processBatchSize',
  [`${ENV_PREFIX}SYNC_FAIL_FAST`]: 'sync.failFast',

  // Entity Resolution
  [`${ENV_PREFIX}RESOLUTION_MERGE_THRESHOLD`]: 'entityResolution.mergeThreshold',
  [`${ENV_PREFIX}RESOLUTION_REVIEW_THRESHOLD`]: 'entityResolution.reviewThreshold',
  [`${ENV_PREFIX}RESOLUTION_MAX_CANDIDATES`]: 'entityResolution.maxCandidates',

  // Embeddings
  [`${ENV_PREFIX}EMBEDDING_DIM`]: 'embeddings.dimension',
  [`${ENV_PREFIX}EMBEDDING_MODEL`]: 'embeddings.model',
  [`${ENV_PREFIX}EMBEDDING_AUTO`]: 'embeddings.autoEmbed',

  // Connectors - GitHub
  GITHUB_CLIENT_ID: 'connectors.github.clientId',
  GITHUB_CLIENT_SECRET: 'connectors.github.clientSecret',
  [`${ENV_PREFIX}GITHUB_RATE_LIMIT`]: 'connectors.github.rateLimit',

  // OAuth Providers (centralized - loaded by OAuthProviderRegistry)
  // GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, etc. are handled by OAuthProviderRegistry

  // Connectors - X.com
  TWITTER_BEARER_TOKEN: 'connectors.xcom.bearerToken',
  XCOM_BEARER_TOKEN: 'connectors.xcom.bearerToken',
  TWITTER_CLIENT_ID: 'connectors.xcom.clientId',
  TWITTER_CLIENT_SECRET: 'connectors.xcom.clientSecret',

  // Connectors - iMessage
  [`${ENV_PREFIX}IMESSAGE_DB_PATH`]: 'connectors.imessage.databasePath',

  // Observability
  LOG_LEVEL: 'observability.logLevel',
  LOG_FORMAT: 'observability.logFormat',
  [`${ENV_PREFIX}LOG_LEVEL`]: 'observability.logLevel',
  [`${ENV_PREFIX}LOG_FORMAT`]: 'observability.logFormat',
  [`${ENV_PREFIX}METRICS_ENABLED`]: 'observability.metricsEnabled',
  [`${ENV_PREFIX}TRACING_ENABLED`]: 'observability.tracingEnabled',
  [`${ENV_PREFIX}TRACING_ENDPOINT`]: 'observability.tracingEndpoint',
  [`${ENV_PREFIX}TRACING_SAMPLE_RATE`]: 'observability.tracingSampleRate',

  // Security
  [`${ENV_PREFIX}ENCRYPTION_KEY`]: 'security.encryptionKey',
  [`${ENV_PREFIX}REDACT_PII`]: 'security.redactPII',

  // General
  [`${ENV_PREFIX}DATA_DIR`]: 'dataDir',
  NODE_ENV: 'env',
  [`${ENV_PREFIX}ENV`]: 'env',
}

// ============ Type Coercion ============

/**
 * Coerce a string value to the appropriate type based on the config path.
 */
function coerceValue(path: string, value: string): unknown {
  // Integer fields
  const intFields = [
    'database.port', 'database.max', 'database.idleTimeout', 'database.connectTimeout',
    'queue.visibilityTimeout', 'queue.maxAttempts', 'queue.baseRetryDelay',
    'queue.maxRetryDelay', 'queue.maxJobRuntime', 'queue.pollInterval', 'queue.heartbeatInterval',
    'http.connectTimeout', 'http.requestTimeout', 'http.maxRetries',
    'http.baseRetryDelay', 'http.maxRetryDelay', 'http.circuitBreakerThreshold',
    'http.circuitBreakerResetMs', 'http.maxConnections',
    'sync.pollInterval', 'sync.maxJobRuntime', 'sync.processBatchSize', 'sync.processConcurrency',
    'entityResolution.mergeThreshold', 'entityResolution.reviewThreshold', 'entityResolution.maxCandidates',
    'embeddings.dimension', 'embeddings.batchSize',
    'observability.healthCheckInterval',
  ]

  // Float fields
  const floatFields = [
    'http.maxRequestsPerSecond',
    'connectors.github.rateLimit', 'connectors.gmail.rateLimit', 'connectors.xcom.rateLimit',
    'observability.tracingSampleRate',
  ]

  // Boolean fields
  const boolFields = [
    'database.ssl',
    'sync.autoProcess', 'sync.failFast',
    'entityResolution.enableFuzzyMatch',
    'embeddings.autoEmbed',
    'connectors.github.syncNotifications', 'connectors.github.syncStarred',
    'connectors.imessage.syncAttachments',
    'observability.metricsEnabled', 'observability.tracingEnabled',
    'security.redactPII',
  ]

  if (intFields.includes(path)) {
    const num = parseInt(value, 10)
    return isNaN(num) ? value : num
  }

  if (floatFields.includes(path)) {
    const num = parseFloat(value)
    return isNaN(num) ? value : num
  }

  if (boolFields.includes(path)) {
    const lower = value.toLowerCase()
    if (lower === 'true' || lower === '1' || lower === 'yes') return true
    if (lower === 'false' || lower === '0' || lower === 'no') return false
    return value
  }

  // SSL can be boolean or string
  if (path === 'database.ssl') {
    const lower = value.toLowerCase()
    if (lower === 'true' || lower === '1') return true
    if (lower === 'false' || lower === '0') return false
    if (lower === 'require' || lower === 'prefer') return lower
    return value
  }

  return value
}

/**
 * Set a nested value on an object using dot notation.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }

  const lastPart = parts[parts.length - 1]
  current[lastPart] = value
}

// ============ Config Loading ============

/**
 * Load configuration from environment variables.
 */
export function loadFromEnv(env: Record<string, string | undefined> = process.env): PartialAppConfig {
  const config: Record<string, unknown> = {}

  for (const [envVar, configPath] of Object.entries(ENV_MAPPING)) {
    const value = env[envVar]
    if (value !== undefined && value !== '') {
      const coercedValue = coerceValue(configPath, value)
      setNestedValue(config, configPath, coercedValue)
    }
  }

  return config as PartialAppConfig
}

/**
 * Load configuration from a JSON file.
 */
export async function loadFromFile(filePath: string): Promise<PartialAppConfig> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const absolutePath = path.resolve(filePath)
  const content = await fs.readFile(absolutePath, 'utf-8')

  // Support both JSON and JS config files
  if (filePath.endsWith('.json')) {
    return JSON.parse(content) as PartialAppConfig
  }

  // For JS files, evaluate and return default export
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
    const module = await import(absolutePath)
    return (module.default ?? module) as PartialAppConfig
  }

  // Default to JSON parsing
  return JSON.parse(content) as PartialAppConfig
}

/**
 * Load configuration from file if it exists, otherwise return empty.
 */
export async function loadFromFileIfExists(filePath: string): Promise<PartialAppConfig> {
  const fs = await import('node:fs/promises')

  try {
    await fs.access(filePath)
    return loadFromFile(filePath)
  } catch {
    return {}
  }
}

/**
 * Deep merge two config objects.
 * Values from `override` take precedence over `base`.
 */
export function mergeConfigs(base: PartialAppConfig, override: PartialAppConfig): PartialAppConfig {
  const result: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue

    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      // Deep merge objects
      result[key] = mergeConfigs(
        result[key] as PartialAppConfig,
        value as PartialAppConfig
      )
    } else {
      // Override primitive values and arrays
      result[key] = value
    }
  }

  return result as PartialAppConfig
}

// ============ Config Loader Interface ============

export interface LoadConfigOptions {
  /** Path to config file (optional) */
  configFile?: string
  /** Programmatic config overrides */
  overrides?: PartialAppConfig
  /** Custom environment variables (defaults to process.env) */
  env?: Record<string, string | undefined>
  /** Skip loading from environment variables */
  skipEnv?: boolean
  /** Skip loading from config file */
  skipFile?: boolean
}

/**
 * Load configuration with full precedence chain.
 *
 * Precedence (highest to lowest):
 * 1. Programmatic overrides
 * 2. Environment variables
 * 3. Config file
 * 4. Default values
 *
 * @example
 * ```ts
 * // Load with defaults + env vars
 * const config = await loadConfig()
 *
 * // Load with custom config file
 * const config = await loadConfig({ configFile: './my-config.json' })
 *
 * // Load with programmatic overrides
 * const config = await loadConfig({
 *   overrides: {
 *     database: { host: 'custom-host' },
 *     observability: { logLevel: 'debug' }
 *   }
 * })
 * ```
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  let config: PartialAppConfig = {}

  // 1. Load from config file (lowest precedence)
  if (!options.skipFile) {
    const configFile = options.configFile ??
      process.env.AGENT_MEMORY_CONFIG_FILE ??
      './agent-memory.config.json'

    config = await loadFromFileIfExists(configFile)
  }

  // 2. Merge environment variables
  if (!options.skipEnv) {
    const envConfig = loadFromEnv(options.env)
    config = mergeConfigs(config, envConfig)
  }

  // 3. Merge programmatic overrides (highest precedence)
  if (options.overrides) {
    config = mergeConfigs(config, options.overrides)
  }

  // 4. Parse and validate with Zod (fills in defaults)
  return AppConfigSchema.parse(config)
}

/**
 * Synchronous config loading from environment only.
 * Useful when async loading is not possible.
 */
export function loadConfigSync(overrides: PartialAppConfig = {}): AppConfig {
  const envConfig = loadFromEnv()
  const merged = mergeConfigs(envConfig, overrides)
  return AppConfigSchema.parse(merged)
}

/**
 * Create a config loader with preset options.
 * Useful for consistent config loading across an application.
 */
export function createConfigLoader(baseOptions: LoadConfigOptions = {}) {
  return {
    /**
     * Load config with additional options merged.
     */
    async load(options: LoadConfigOptions = {}): Promise<AppConfig> {
      const mergedOptions: LoadConfigOptions = {
        ...baseOptions,
        ...options,
        overrides: mergeConfigs(
          baseOptions.overrides ?? {},
          options.overrides ?? {}
        ),
      }
      return loadConfig(mergedOptions)
    },

    /**
     * Reload config (useful for runtime reconfiguration).
     */
    async reload(): Promise<AppConfig> {
      return loadConfig(baseOptions)
    },
  }
}

// ============ Config Validation Helpers ============

/**
 * Validate that required secrets are present.
 * Throws if any required secrets are missing.
 */
export function validateSecrets(
  config: AppConfig,
  required: Array<'github' | 'gmail' | 'xcom' | 'encryption'>
): void {
  const missing: string[] = []

  if (required.includes('github')) {
    if (!config.connectors.github.clientId) missing.push('GitHub Client ID')
    if (!config.connectors.github.clientSecret) missing.push('GitHub Client Secret')
  }

  if (required.includes('gmail')) {
    if (!config.connectors.gmail.clientId) missing.push('Gmail Client ID')
    if (!config.connectors.gmail.clientSecret) missing.push('Gmail Client Secret')
  }

  if (required.includes('xcom')) {
    if (!config.connectors.xcom.bearerToken && !config.connectors.xcom.clientId) {
      missing.push('X.com Bearer Token or Client ID')
    }
  }

  if (required.includes('encryption')) {
    if (!config.security.encryptionKey) missing.push('Encryption Key')
  }

  if (missing.length > 0) {
    throw new Error(`Missing required secrets: ${missing.join(', ')}`)
  }
}

/**
 * Get a human-readable summary of the configuration.
 * Redacts sensitive values.
 */
export function getConfigSummary(config: AppConfig): Record<string, unknown> {
  return {
    env: config.env,
    dataDir: config.dataDir,
    database: {
      host: config.database.connectionString ? '[connection string]' : config.database.host,
      port: config.database.port,
      database: config.database.database,
      max: config.database.max,
      ssl: config.database.ssl,
    },
    queue: {
      maxAttempts: config.queue.maxAttempts,
      maxJobRuntime: config.queue.maxJobRuntime,
    },
    sync: {
      autoProcess: config.sync.autoProcess,
      processBatchSize: config.sync.processBatchSize,
    },
    entityResolution: {
      mergeThreshold: config.entityResolution.mergeThreshold,
      reviewThreshold: config.entityResolution.reviewThreshold,
    },
    embeddings: {
      dimension: config.embeddings.dimension,
      model: config.embeddings.model,
      autoEmbed: config.embeddings.autoEmbed,
    },
    connectors: {
      github: { configured: !!config.connectors.github.clientId },
      gmail: { configured: !!config.connectors.gmail.clientId },
      xcom: { configured: !!(config.connectors.xcom.bearerToken || config.connectors.xcom.clientId) },
      imessage: { configured: !!config.connectors.imessage.databasePath },
    },
    observability: {
      logLevel: config.observability.logLevel,
      logFormat: config.observability.logFormat,
      metricsEnabled: config.observability.metricsEnabled,
      tracingEnabled: config.observability.tracingEnabled,
    },
    security: {
      encryptionConfigured: !!config.security.encryptionKey,
      redactPII: config.security.redactPII,
    },
  }
}
