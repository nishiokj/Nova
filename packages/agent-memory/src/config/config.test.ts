/**
 * Configuration Module Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  // Schema
  AppConfigSchema,
  DatabaseConfigSchema,
  QueueConfigSchema,
  HttpConfigSchema,
  SyncConfigSchema,
  EntityResolutionConfigSchema,
  EmbeddingsConfigSchema,
  ConnectorConfigSchema,
  ObservabilityConfigSchema,
  SecurityConfigSchema,
  LogLevelSchema,
  DEFAULT_CONFIG,
  parseConfig,
  safeParseConfig,
  type AppConfig,
  type PartialAppConfig,
  // Loader
  loadFromEnv,
  loadConfigSync,
  mergeConfigs,
  validateSecrets,
  getConfigSummary,
} from './index.js'

describe('Configuration Schema', () => {
  describe('DatabaseConfigSchema', () => {
    test('provides sensible defaults', () => {
      const config = DatabaseConfigSchema.parse({})
      expect(config.host).toBe('localhost')
      expect(config.port).toBe(5432)
      expect(config.database).toBe('agent_memory')
      expect(config.username).toBe('postgres')
      expect(config.max).toBe(10)
      expect(config.schema).toBe('public')
    })

    test('accepts connection string', () => {
      const config = DatabaseConfigSchema.parse({
        connectionString: 'postgres://user:pass@host:5432/db',
      })
      expect(config.connectionString).toBe('postgres://user:pass@host:5432/db')
    })

    test('accepts individual parameters', () => {
      const config = DatabaseConfigSchema.parse({
        host: 'db.example.com',
        port: 5433,
        database: 'mydb',
        username: 'myuser',
        password: 'secret',
      })
      expect(config.host).toBe('db.example.com')
      expect(config.port).toBe(5433)
      expect(config.database).toBe('mydb')
    })

    test('accepts ssl options', () => {
      expect(DatabaseConfigSchema.parse({ ssl: true }).ssl).toBe(true)
      expect(DatabaseConfigSchema.parse({ ssl: 'require' }).ssl).toBe('require')
      expect(DatabaseConfigSchema.parse({ ssl: 'prefer' }).ssl).toBe('prefer')
    })
  })

  describe('QueueConfigSchema', () => {
    test('provides sensible defaults', () => {
      const config = QueueConfigSchema.parse({})
      expect(config.visibilityTimeout).toBe(30000)
      expect(config.maxAttempts).toBe(3)
      expect(config.baseRetryDelay).toBe(1000)
      expect(config.maxRetryDelay).toBe(60000)
      expect(config.maxJobRuntime).toBe(180000)
      expect(config.pollInterval).toBe(100)
      expect(config.deadJobDir).toBe('./data/dead-jobs')
    })

    test('accepts custom values', () => {
      const config = QueueConfigSchema.parse({
        maxAttempts: 5,
        maxJobRuntime: 600000,
      })
      expect(config.maxAttempts).toBe(5)
      expect(config.maxJobRuntime).toBe(600000)
    })

    test('rejects invalid values', () => {
      expect(() => QueueConfigSchema.parse({ maxAttempts: 0 })).toThrow()
      expect(() => QueueConfigSchema.parse({ maxAttempts: -1 })).toThrow()
    })
  })

  describe('HttpConfigSchema', () => {
    test('provides sensible defaults', () => {
      const config = HttpConfigSchema.parse({})
      expect(config.connectTimeout).toBe(5000)
      expect(config.requestTimeout).toBe(30000)
      expect(config.maxRetries).toBe(3)
      expect(config.retryableStatuses).toEqual([429, 500, 502, 503, 504])
      expect(config.circuitBreakerThreshold).toBe(5)
    })

    test('accepts custom retry statuses', () => {
      const config = HttpConfigSchema.parse({
        retryableStatuses: [429, 500],
      })
      expect(config.retryableStatuses).toEqual([429, 500])
    })
  })

  describe('SyncConfigSchema', () => {
    test('provides sensible defaults', () => {
      const config = SyncConfigSchema.parse({})
      expect(config.autoProcess).toBe(false)
      expect(config.processBatchSize).toBe(100)
      expect(config.processConcurrency).toBe(5)
      expect(config.failFast).toBe(false)
    })
  })

  describe('EntityResolutionConfigSchema', () => {
    test('provides sensible defaults', () => {
      const config = EntityResolutionConfigSchema.parse({})
      expect(config.mergeThreshold).toBe(80)
      expect(config.reviewThreshold).toBe(50)
      expect(config.maxCandidates).toBe(100)
      expect(config.enableFuzzyMatch).toBe(true)
    })

    test('accepts custom thresholds', () => {
      const config = EntityResolutionConfigSchema.parse({
        mergeThreshold: 90,
        reviewThreshold: 60,
      })
      expect(config.mergeThreshold).toBe(90)
      expect(config.reviewThreshold).toBe(60)
    })

    test('validates threshold ranges', () => {
      expect(() => EntityResolutionConfigSchema.parse({ mergeThreshold: 101 })).toThrow()
      expect(() => EntityResolutionConfigSchema.parse({ mergeThreshold: -1 })).toThrow()
    })

    test('accepts custom weights', () => {
      const config = EntityResolutionConfigSchema.parse({
        weights: {
          emailExact: 1.5,
          nameFuzzy: 0.5,
        },
      })
      expect(config.weights.emailExact).toBe(1.5)
      expect(config.weights.nameFuzzy).toBe(0.5)
    })
  })

  describe('EmbeddingsConfigSchema', () => {
    test('provides sensible defaults', () => {
      const config = EmbeddingsConfigSchema.parse({})
      expect(config.dimension).toBe(1536)
      expect(config.model).toBe('text-embedding-ada-002')
      expect(config.batchSize).toBe(100)
      expect(config.autoEmbed).toBe(false)
    })
  })

  describe('ConnectorConfigSchema', () => {
    test('provides defaults for all connectors', () => {
      const config = ConnectorConfigSchema.parse({})
      expect(config.github.rateLimit).toBe(5)
      expect(config.github.syncNotifications).toBe(true)
      expect(config.gmail.rateLimit).toBe(10)
      expect(config.gmail.excludeLabels).toEqual(['SPAM', 'TRASH'])
      expect(config.imessage.syncAttachments).toBe(true)
    })

    test('accepts connector credentials', () => {
      const config = ConnectorConfigSchema.parse({
        github: {
          clientId: 'my-client-id',
          clientSecret: 'my-client-secret',
        },
      })
      expect(config.github.clientId).toBe('my-client-id')
      expect(config.github.clientSecret).toBe('my-client-secret')
    })
  })

  describe('ObservabilityConfigSchema', () => {
    test('provides sensible defaults', () => {
      const config = ObservabilityConfigSchema.parse({})
      expect(config.logLevel).toBe('info')
      expect(config.logFormat).toBe('json')
      expect(config.metricsEnabled).toBe(true)
      expect(config.tracingEnabled).toBe(false)
      expect(config.tracingSampleRate).toBe(0.1)
    })

    test('accepts valid log levels', () => {
      expect(ObservabilityConfigSchema.parse({ logLevel: 'debug' }).logLevel).toBe('debug')
      expect(ObservabilityConfigSchema.parse({ logLevel: 'warn' }).logLevel).toBe('warn')
      expect(ObservabilityConfigSchema.parse({ logLevel: 'error' }).logLevel).toBe('error')
    })

    test('rejects invalid log levels', () => {
      expect(() => ObservabilityConfigSchema.parse({ logLevel: 'verbose' })).toThrow()
    })
  })

  describe('SecurityConfigSchema', () => {
    test('provides sensible defaults', () => {
      const config = SecurityConfigSchema.parse({})
      expect(config.redactPII).toBe(true)
      expect(config.corsOrigins).toEqual([])
    })

    test('validates encryption key length', () => {
      const validKey = 'a'.repeat(64)
      const config = SecurityConfigSchema.parse({ encryptionKey: validKey })
      expect(config.encryptionKey).toBe(validKey)

      expect(() => SecurityConfigSchema.parse({ encryptionKey: 'too-short' })).toThrow()
    })
  })

  describe('LogLevelSchema', () => {
    test('accepts valid log levels', () => {
      expect(LogLevelSchema.parse('debug')).toBe('debug')
      expect(LogLevelSchema.parse('info')).toBe('info')
      expect(LogLevelSchema.parse('warn')).toBe('warn')
      expect(LogLevelSchema.parse('error')).toBe('error')
      expect(LogLevelSchema.parse('fatal')).toBe('fatal')
    })
  })

  describe('AppConfigSchema', () => {
    test('provides complete defaults', () => {
      const config = AppConfigSchema.parse({})
      expect(config.database.host).toBe('localhost')
      expect(config.queue.maxAttempts).toBe(3)
      expect(config.http.maxRetries).toBe(3)
      expect(config.sync.autoProcess).toBe(false)
      expect(config.entityResolution.mergeThreshold).toBe(80)
      expect(config.embeddings.dimension).toBe(1536)
      expect(config.observability.logLevel).toBe('info')
      expect(config.dataDir).toBe('./data')
      expect(config.env).toBe('development')
    })

    test('merges partial configs correctly', () => {
      const config = AppConfigSchema.parse({
        database: { host: 'custom-host' },
        observability: { logLevel: 'debug' },
      })
      expect(config.database.host).toBe('custom-host')
      expect(config.database.port).toBe(5432) // Default preserved
      expect(config.observability.logLevel).toBe('debug')
    })
  })

  describe('DEFAULT_CONFIG', () => {
    test('is a valid AppConfig', () => {
      expect(DEFAULT_CONFIG.database.host).toBe('localhost')
      expect(DEFAULT_CONFIG.env).toBe('development')
    })
  })

  describe('parseConfig', () => {
    test('parses valid config', () => {
      const config = parseConfig({ dataDir: '/custom/data' })
      expect(config.dataDir).toBe('/custom/data')
    })

    test('throws on invalid config', () => {
      expect(() => parseConfig({ observability: { logLevel: 'invalid' } })).toThrow()
    })
  })

  describe('safeParseConfig', () => {
    test('returns success for valid config', () => {
      const result = safeParseConfig({ dataDir: '/custom/data' })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.dataDir).toBe('/custom/data')
      }
    })

    test('returns error for invalid config', () => {
      const result = safeParseConfig({ observability: { logLevel: 'invalid' } })
      expect(result.success).toBe(false)
    })
  })
})

describe('Configuration Loader', () => {
  describe('loadFromEnv', () => {
    test('loads database config from standard PG vars', () => {
      const config = loadFromEnv({
        PGHOST: 'db.example.com',
        PGPORT: '5433',
        PGDATABASE: 'mydb',
        PGUSER: 'myuser',
        PGPASSWORD: 'secret',
      })

      expect(config.database?.host).toBe('db.example.com')
      expect(config.database?.port).toBe(5433)
      expect(config.database?.database).toBe('mydb')
      expect(config.database?.username).toBe('myuser')
      expect(config.database?.password).toBe('secret')
    })

    test('loads database config from DATABASE_URL', () => {
      const config = loadFromEnv({
        DATABASE_URL: 'postgres://user:pass@host:5432/db',
      })
      expect(config.database?.connectionString).toBe('postgres://user:pass@host:5432/db')
    })

    test('loads connector credentials', () => {
      const config = loadFromEnv({
        GITHUB_CLIENT_ID: 'gh-client',
        GITHUB_CLIENT_SECRET: 'gh-secret',
        TWITTER_BEARER_TOKEN: 'bearer-token',
      })

      expect(config.connectors?.github?.clientId).toBe('gh-client')
      expect(config.connectors?.github?.clientSecret).toBe('gh-secret')
      expect(config.connectors?.xcom?.bearerToken).toBe('bearer-token')
      // Note: OAuth credentials (GOOGLE_CLIENT_ID, etc.) are loaded by OAuthProviderRegistry, not config loader
    })

    test('loads observability config', () => {
      const config = loadFromEnv({
        LOG_LEVEL: 'debug',
        LOG_FORMAT: 'pretty',
        AGENT_MEMORY_METRICS_ENABLED: 'false',
      })

      expect(config.observability?.logLevel).toBe('debug')
      expect(config.observability?.logFormat).toBe('pretty')
      expect(config.observability?.metricsEnabled).toBe(false)
    })

    test('coerces numeric values', () => {
      const config = loadFromEnv({
        PGPORT: '5433',
        AGENT_MEMORY_QUEUE_MAX_ATTEMPTS: '5',
        AGENT_MEMORY_EMBEDDING_DIM: '768',
      })

      expect(config.database?.port).toBe(5433)
      expect(config.queue?.maxAttempts).toBe(5)
      expect(config.embeddings?.dimension).toBe(768)
    })

    test('coerces boolean values', () => {
      const config = loadFromEnv({
        AGENT_MEMORY_SYNC_AUTO_PROCESS: 'false',
        AGENT_MEMORY_SYNC_FAIL_FAST: 'true',
        AGENT_MEMORY_EMBEDDING_AUTO: '1',
        AGENT_MEMORY_REDACT_PII: 'no',
      })

      expect(config.sync?.autoProcess).toBe(false)
      expect(config.sync?.failFast).toBe(true)
      expect(config.embeddings?.autoEmbed).toBe(true)
      expect(config.security?.redactPII).toBe(false)
    })

    test('loads prefixed variables', () => {
      const config = loadFromEnv({
        AGENT_MEMORY_DB_HOST: 'custom-host',
        AGENT_MEMORY_DB_PORT: '5434',
        AGENT_MEMORY_LOG_LEVEL: 'warn',
        AGENT_MEMORY_DATA_DIR: '/var/data',
      })

      expect(config.database?.host).toBe('custom-host')
      expect(config.database?.port).toBe(5434)
      expect(config.observability?.logLevel).toBe('warn')
      expect(config.dataDir).toBe('/var/data')
    })

    test('ignores empty and undefined values', () => {
      const config = loadFromEnv({
        PGHOST: '',
        PGPORT: undefined,
      })

      expect(config.database?.host).toBeUndefined()
      expect(config.database?.port).toBeUndefined()
    })

    test('loads NODE_ENV as env', () => {
      const config = loadFromEnv({ NODE_ENV: 'production' })
      expect(config.env).toBe('production')
    })
  })

  describe('loadConfigSync', () => {
    let originalEnv: NodeJS.ProcessEnv

    beforeEach(() => {
      originalEnv = { ...process.env }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    test('loads config from current environment', () => {
      process.env.PGHOST = 'test-host'
      const config = loadConfigSync()
      expect(config.database.host).toBe('test-host')
    })

    test('applies overrides', () => {
      const config = loadConfigSync({
        database: { host: 'override-host' },
        observability: { logLevel: 'debug' },
      })
      expect(config.database.host).toBe('override-host')
      expect(config.observability.logLevel).toBe('debug')
    })
  })

  describe('mergeConfigs', () => {
    test('deep merges objects', () => {
      const base: PartialAppConfig = {
        database: { host: 'base-host', port: 5432 },
        observability: { logLevel: 'info' },
      }
      const override: PartialAppConfig = {
        database: { host: 'override-host' },
        sync: { autoProcess: false },
      }

      const merged = mergeConfigs(base, override)

      expect(merged.database?.host).toBe('override-host')
      expect(merged.database?.port).toBe(5432) // Preserved from base
      expect(merged.observability?.logLevel).toBe('info') // Preserved from base
      expect(merged.sync?.autoProcess).toBe(false) // Added from override
    })

    test('handles nested objects', () => {
      const base: PartialAppConfig = {
        entityResolution: {
          mergeThreshold: 80,
          weights: { emailExact: 1.0, nameFuzzy: 1.0 },
        },
      }
      const override: PartialAppConfig = {
        entityResolution: {
          weights: { emailExact: 1.5 },
        },
      }

      const merged = mergeConfigs(base, override)

      expect(merged.entityResolution?.mergeThreshold).toBe(80)
      expect(merged.entityResolution?.weights?.emailExact).toBe(1.5)
      expect(merged.entityResolution?.weights?.nameFuzzy).toBe(1.0)
    })

    test('overrides arrays completely', () => {
      const base: PartialAppConfig = {
        http: { retryableStatuses: [429, 500, 502, 503, 504] },
      }
      const override: PartialAppConfig = {
        http: { retryableStatuses: [429, 500] },
      }

      const merged = mergeConfigs(base, override)
      expect(merged.http?.retryableStatuses).toEqual([429, 500])
    })

    test('ignores undefined values in override', () => {
      const base: PartialAppConfig = {
        database: { host: 'base-host' },
      }
      const override: PartialAppConfig = {
        database: { host: undefined as unknown as string },
      }

      const merged = mergeConfigs(base, override)
      expect(merged.database?.host).toBe('base-host')
    })
  })

  describe('validateSecrets', () => {
    test('passes when all required secrets are present', () => {
      const config = AppConfigSchema.parse({
        connectors: {
          github: { clientId: 'id', clientSecret: 'secret' },
        },
      })

      expect(() => validateSecrets(config, ['github'])).not.toThrow()
    })

    test('throws when GitHub secrets are missing', () => {
      const config = AppConfigSchema.parse({})

      expect(() => validateSecrets(config, ['github'])).toThrow('GitHub Client ID')
    })

    test('throws when Gmail secrets are missing', () => {
      const config = AppConfigSchema.parse({})

      expect(() => validateSecrets(config, ['gmail'])).toThrow('Gmail Client ID')
    })

    test('throws when X.com secrets are missing', () => {
      const config = AppConfigSchema.parse({})

      expect(() => validateSecrets(config, ['xcom'])).toThrow('X.com Bearer Token')
    })

    test('passes for X.com with bearer token', () => {
      const config = AppConfigSchema.parse({
        connectors: {
          xcom: { bearerToken: 'token' },
        },
      })

      expect(() => validateSecrets(config, ['xcom'])).not.toThrow()
    })

    test('passes for X.com with client credentials', () => {
      const config = AppConfigSchema.parse({
        connectors: {
          xcom: { clientId: 'id' },
        },
      })

      expect(() => validateSecrets(config, ['xcom'])).not.toThrow()
    })

    test('throws when encryption key is missing', () => {
      const config = AppConfigSchema.parse({})

      expect(() => validateSecrets(config, ['encryption'])).toThrow('Encryption Key')
    })

    test('collects all missing secrets', () => {
      const config = AppConfigSchema.parse({})

      expect(() => validateSecrets(config, ['github', 'gmail'])).toThrow(
        /GitHub Client ID.*GitHub Client Secret.*Gmail Client ID.*Gmail Client Secret/
      )
    })
  })

  describe('getConfigSummary', () => {
    test('returns human-readable summary', () => {
      const config = AppConfigSchema.parse({
        database: { host: 'db.example.com', port: 5432 },
        observability: { logLevel: 'debug' },
        connectors: {
          github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
        },
      })

      const summary = getConfigSummary(config)

      expect(summary.env).toBe('development')
      expect((summary.database as Record<string, unknown>).host).toBe('db.example.com')
      expect((summary.observability as Record<string, unknown>).logLevel).toBe('debug')
      expect((summary.connectors as Record<string, Record<string, unknown>>).github.configured).toBe(true)
      expect((summary.connectors as Record<string, Record<string, unknown>>).gmail.configured).toBe(false)
    })

    test('redacts connection string', () => {
      const config = AppConfigSchema.parse({
        database: { connectionString: 'postgres://user:password@host/db' },
      })

      const summary = getConfigSummary(config)
      expect((summary.database as Record<string, unknown>).host).toBe('[connection string]')
    })

    test('shows encryption status without revealing key', () => {
      const config = AppConfigSchema.parse({
        security: { encryptionKey: 'a'.repeat(64) },
      })

      const summary = getConfigSummary(config)
      expect((summary.security as Record<string, unknown>).encryptionConfigured).toBe(true)
    })
  })
})

describe('Integration Tests', () => {
  test('full config loading flow', () => {
    // Simulate environment
    const env = {
      PGHOST: 'db.example.com',
      PGPORT: '5433',
      LOG_LEVEL: 'debug',
      GITHUB_CLIENT_ID: 'gh-client',
      GITHUB_CLIENT_SECRET: 'gh-secret',
    }

    // Load from env
    const envConfig = loadFromEnv(env)

    // Merge with programmatic overrides
    const overrides: PartialAppConfig = {
      dataDir: '/custom/data',
      sync: { failFast: true },
    }

    const merged = mergeConfigs(envConfig, overrides)

    // Parse final config
    const config = AppConfigSchema.parse(merged)

    // Verify results
    expect(config.database.host).toBe('db.example.com')
    expect(config.database.port).toBe(5433)
    expect(config.observability.logLevel).toBe('debug')
    expect(config.connectors.github.clientId).toBe('gh-client')
    expect(config.dataDir).toBe('/custom/data')
    expect(config.sync.failFast).toBe(true)

    // Validate secrets
    expect(() => validateSecrets(config, ['github'])).not.toThrow()
  })

  test('config defaults are production-ready', () => {
    const config = DEFAULT_CONFIG

    // Database defaults
    expect(config.database.max).toBeGreaterThanOrEqual(10)
    expect(config.database.connectTimeout).toBeGreaterThan(0)

    // Queue defaults
    expect(config.queue.maxAttempts).toBeGreaterThanOrEqual(3)
    expect(config.queue.maxJobRuntime).toBeGreaterThanOrEqual(60000)

    // HTTP defaults
    expect(config.http.maxRetries).toBeGreaterThanOrEqual(3)
    expect(config.http.circuitBreakerThreshold).toBeGreaterThan(0)

    // Entity resolution defaults make sense
    expect(config.entityResolution.mergeThreshold).toBeGreaterThan(
      config.entityResolution.reviewThreshold
    )

    // Security defaults are safe
    expect(config.security.redactPII).toBe(true)
  })
})
