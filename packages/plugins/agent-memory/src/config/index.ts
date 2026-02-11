/**
 * Configuration Module
 *
 * Runtime configuration management for agent-memory.
 * Supports loading from files, environment variables, and programmatic overrides.
 *
 * @example
 * ```ts
 * import { loadConfig, AppConfig } from './config'
 *
 * // Load config with all defaults
 * const config = await loadConfig()
 *
 * // Load with overrides
 * const config = await loadConfig({
 *   overrides: {
 *     database: { host: 'localhost', port: 5432 },
 *     observability: { logLevel: 'debug' }
 *   }
 * })
 *
 * // Access config values
 * console.log(config.database.host)
 * console.log(config.observability.logLevel)
 * ```
 */

// Schema & Types
export {
  // Database
  DatabaseConfigSchema,
  type DatabaseConfig,
  // Queue
  QueueConfigSchema,
  type QueueConfig,
  // HTTP
  HttpConfigSchema,
  type HttpConfig,
  // Sync
  SyncConfigSchema,
  type SyncConfig,
  // Entity Resolution
  MatchWeightsSchema,
  type MatchWeightsConfig,
  EntityResolutionConfigSchema,
  type EntityResolutionConfig,
  // Embeddings
  EmbeddingsConfigSchema,
  type EmbeddingsConfig,
  // Connectors
  ConnectorConfigSchema,
  type ConnectorConfig,
  // Observability
  LogLevelSchema,
  type LogLevel,
  ObservabilityConfigSchema,
  type ObservabilityConfig,
  // Security
  SecurityConfigSchema,
  type SecurityConfig,
  // Top-Level
  AppConfigSchema,
  type AppConfig,
  type PartialAppConfig,
  // Defaults
  DEFAULT_CONFIG,
  // Validation
  parseConfig,
  safeParseConfig,
} from './schema.js'

// Loader
export {
  // Main loaders
  loadConfig,
  loadConfigSync,
  loadFromEnv,
  loadFromFile,
  loadFromFileIfExists,
  // Utilities
  mergeConfigs,
  createConfigLoader,
  validateSecrets,
  getConfigSummary,
  // Types
  type LoadConfigOptions,
} from './loader.js'
