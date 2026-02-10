/**
 * Agent Memory System
 *
 * A data synchronization and entity resolution system for aggregating
 * information from multiple external sources (GitHub, Gmail, X.com, iMessage).
 *
 * @module agent-memory
 */

// ID System - Foundation for all entity identification
export {
  // Types
  type ConnectorType,
  type CanonicalId,
  type SourceId,
  type SourceRef,
  type IdempotencyKeys,
  // Schemas
  ConnectorTypeSchema,
  UlidSchema,
  SourceRefSchema,
  ULID_REGEX,
  // ID Generation
  generateCanonicalId,
  generateCanonicalIdBatch,
  extractTimestamp,
  isValidUlid,
  // Source References
  sourceRefToKey,
  parseSourceRefKey,
  // Idempotency
  computeIdempotencyKeys,
  computeRawDataHash,
  sha256,
  // Comparison
  compareUlids,
  olderUlid,
  newerUlid,
} from './ids.js'

// Utilities
export { stableStringify } from './stable-stringify.js'

// Canonical Data Models
export {
  // Extended Source Reference
  CanonicalSourceRefSchema,
  type CanonicalSourceRef,
  // Base Entity
  BaseEntitySchema,
  type BaseEntity,
  // Platform
  PlatformSchema,
  type Platform,
  // Core Entities
  PersonSchema,
  type Person,
  IdentitySchema,
  type Identity,
  OrgSchema,
  type Org,
  AccountSchema,
  type Account,
  // Activity Entities
  MessageSchema,
  type Message,
  EventSchema,
  type Event,
  IssueSchema,
  type Issue,
  NotificationSchema,
  type Notification,
  ObservationSchema,
  type Observation,
  // Relationship Entity
  LinkSchema,
  type Link,
  AttachmentSchema,
  type Attachment,
  // Entity Type
  EntityTypeSchema,
  type EntityType,
  type CanonicalEntity,
  // Schema Registry
  EntitySchemas,
  validateEntity,
  // Conversational Memory
  MemoryEntityTypeSchema,
  type MemoryEntityType,
  MemoryStateSchema,
  type MemoryState,
  ProjectSchema,
  type Project,
  GoalSchema,
  type Goal,
  ConversationDigestDecisionSchema,
  type ConversationDigestDecision,
  ConversationDigestSchema,
  type ConversationDigest,
  EntityMentionSchema,
  type EntityMention,
  // Raw Envelope & Lineage
  CollectionMethodSchema,
  type CollectionMethod,
  RawEnvelopeSchema,
  type RawEnvelope,
  type RawEnvelopeInput,
  EntitySourceMappingSchema,
  type EntitySourceMapping,
  type EntitySourceMappingInput,
} from './models/index.js'

// Memory Helpers
export {
  computeMemoryState,
  type MemoryStateInput,
} from './memory/state.js'

// Database Layer
export {
  // Connection
  createDatabase,
  createDatabaseFromEnv,
  type Database,
  type DatabaseConfig,
  type Sql,
  // Migrations
  migrate,
  loadMigrations,
  getAppliedMigrations,
  getCurrentVersion,
  isSchemaUpToDate,
  getPendingMigrations,
  type Migration,
  type AppliedMigration,
  type MigrationResult,
  // Repository Context
  createRepositoryContext,
  type RepositoryContext,
  type PaginationOptions,
  type PaginatedResult,
  type Repository,
  // Raw Envelope Repository
  createRawEnvelopeRepository,
  type RawEnvelopeRepository,
  // Canonical Entity Repository
  createCanonicalEntityRepository,
  type CanonicalEntityRepository,
  type StoredEntity,
  type CanonicalEntityFilters,
  // Entity Source Mapping Repository
  createEntitySourceMappingRepository,
  type EntitySourceMappingRepository,
  // Sync Job Repository
  createSyncJobRepository,
  type SyncJobRepository,
  type SyncJob,
  type SyncJobInput,
  type SyncJobStatus,
  type SyncJobType,
  // Account Repository
  createAccountRepository,
  type AccountRepository,
  type Account as ConnectedAccount,
  type AccountInput as ConnectedAccountInput,
  type AccountCredentials,
  type AuthType,
  // Job Queue Repository
  createJobQueueRepository,
  type JobQueueRepository,
  type QueueJob,
  type JobStatus,
  type EnqueueOptions,
  // Sync Task Repository
  createSyncTaskRepository,
  type SyncTaskRepository,
  type SyncTask,
  type SyncTaskInput,
  type SyncType,
  type TaskMode,
  // Derived Job
  createDerivedJobRepository,
  type DerivedJobRepository,
  type DerivedJob,
  type DerivedJobInput,
  type DerivedJobStatus,
  // Derived Task
  createDerivedTaskRepository,
  type DerivedTaskRepository,
  type DerivedTask,
  type DerivedTaskInput,
  type DerivedTaskMode,
  // Transformations
  createTransformationRepository,
  type TransformationRepository,
  type TransformationRecord,
  type TransformationInput,
  // Agent Traces (cursor/agent-trace spec)
  createAgentTracesRepository,
  type AgentTracesRepository,
  type AgentTraceRow,
  type AgentTraceInput,
  type TraceFilterOptions,
} from './db/index.js'

// Auth Layer
export {
  // Auth Provider
  DatabaseAuthProvider,
  type AuthProvider,
  type AuthProviderConfig,
  type EncryptionResult,
  createAuthProvider,
  createAuthProviderFromEnv,
  // Key Derivation
  deriveKey,
  generateSalt,
  // Auth Registration
  AuthRegistrationService,
  type ConnectorRegistrationOptions,
  type ConnectorRegistrationResult,
  type OAuthCallbackResult,
  type RegistrationServiceConfig,
  createRegistrationService,
} from './auth/index.js'

// Sync & Queue
export {
  // Queue
  MicroQueue,
  TimeoutError,
  QueueError,
  type QueueConfig,
  type Job,
  type JobResult,
  type JobHandler,
  type DeadJob,
  type MicroQueueStats,
  // Sync Engine
  SyncEngine,
  Collector,
  Processor,
  type SyncEngineConfig,
  type CollectorConfig,
  type ProcessorConfig,
  // Sync Types
  type SourceItem,
  type FetchPageResult,
  type RateLimitInfo,
  type SyncRun,
  type FetchPageOptions,
  type FetchChangesOptions,
  type EntityMapper,
  type MapperContext,
  type MappedEntity,
  type ProcessResult,
  type BatchProcessResult,
  type SyncEvent,
  type SyncStats,
  // Sync Errors
  SyncError,
  CollectError,
  ProcessError,
  ValidationError,
  RateLimitError,
  // Scheduler
  Scheduler,
  type SchedulerConfig,
  type SchedulerEvent,
} from './sync/index.js'

// Derived Processing
export {
  DerivedTaskIntegration,
  type DerivedIntegrationConfig,
} from './derived/integration.js'

// Agentic Tasks
export {
  createAgenticTaskRepository,
  type AgenticTaskRepository,
} from './db/repositories/agentic-task.js'
export {
  createAgenticRunRepository,
  type AgenticRunRepository,
} from './db/repositories/agentic-run.js'
export {
  executeAgenticRun,
  type AgenticRunContext,
  type AgenticRunResult,
} from './agentic/runner.js'
export {
  AgenticTaskIntegration,
  type AgenticIntegrationConfig,
} from './agentic/integration.js'
export {
  runDerivedScript,
  loadScriptMetadata,
  type DerivedRunContext,
  type DerivedRunResult,
  type ProcessingLog,
  type MetadataFieldDef,
  type DerivedMetadataSchema,
} from './derived/runner.js'

// Connector SDK
export {
  // HTTP Client Configuration
  HttpClientConfigSchema,
  type HttpClientConfig,
  // HTTP Types
  type HttpMethod,
  type RequestOptions,
  type HttpResponse,
  type RateLimitHeaders,
  // HTTP Errors
  HttpError,
  TimeoutError as HttpTimeoutError,
  NetworkError,
  HttpRateLimitError,
  CircuitBreakerOpenError,
  // Rate Limiting
  TokenBucket,
  // Circuit Breaker
  CircuitBreaker,
  // HTTP Client
  ResilientHttpClient,
  type HttpClientHooks,
  // Factory Functions
  createHttpClient,
  createLoggingHooks,
  // Connector Capabilities
  type ConnectorCapabilities,
  ConnectorCapabilitiesSchema,
  // Auth Configuration
  type ConnectorAuthType,
  ConnectorAuthTypeSchema,
  type OAuth2Config,
  OAuth2ConfigSchema,
  type ApiKeyConfig,
  ApiKeyConfigSchema,
  type LocalAuthConfig,
  LocalAuthConfigSchema,
  type AuthConfig,
  AuthConfigSchema,
  // Auth Tokens
  type AuthTokens,
  AuthTokensSchema,
  // Account Discovery
  type AccountInfo,
  AccountInfoSchema,
  // Webhooks
  type WebhookEvent,
  WebhookEventSchema,
  type WebhookVerificationResult,
  type WebhookSubscribeOptions,
  type WebhookSubscription,
  // Connector Context
  type ConnectorContext,
  // Connector Interface
  type Connector,
  type ConnectorFactory,
  type ConnectorRegistration,
  // Connector Logging
  type ErrorSeverity,
  type ConnectorErrorContext,
  type ConnectorLogger,
  defaultLogger,
  noopLogger,
  type BaseConnectorOptions,
  // Base Connector
  BaseConnector,
  ConnectorRegistry,
  connectorRegistry,
} from './connector/index.js'

// Connectors
export {
  // GitHub Connector
  GitHubConnector,
  createGitHubConnector,
  type GitHubConnectorConfig,
  // GitHub Schemas
  GitHubUserSchema,
  GitHubAuthenticatedUserSchema,
  GitHubRepoSchema,
  GitHubLabelSchema,
  GitHubMilestoneSchema,
  GitHubIssueSchema,
  GitHubPullRequestSchema,
  GitHubCommentSchema,
  GitHubNotificationSchema,
  GitHubNotificationSubjectSchema,
  GitHubIssueEventSchema,
  GitHubPullRequestEventSchema,
  GitHubIssueCommentEventSchema,
  type GitHubUser,
  type GitHubAuthenticatedUser,
  type GitHubRepo,
  type GitHubLabel,
  type GitHubMilestone,
  type GitHubIssue,
  type GitHubPullRequest,
  type GitHubComment,
  type GitHubNotification,
  type GitHubNotificationSubject,
  type GitHubIssueEvent,
  type GitHubPullRequestEvent,
  type GitHubIssueCommentEvent,
  // GitHub Transformations
  githubTransforms,
  issueTransform,
  pullRequestTransform,
  commentTransform,
  notificationTransform,
} from './connectors/index.js'

// Entity Resolution
export {
  EntityResolutionEngine,
  type MatchScores,
  type MatchWeights,
  type MatchResult,
  type ResolutionConfig,
  type ResolutionEvent,
  type MergeDecision,
  type PendingReview,
  type DecisionType,
  MergeDecisionSchema,
  PendingReviewSchema,
  DecisionTypeSchema,
  MERGE_THRESHOLD,
  REVIEW_THRESHOLD,
  DEFAULT_WEIGHTS,
} from './resolution/index.js'

// Entity Resolution Repositories
export {
  createMergeDecisionRepository,
  type MergeDecisionRepository,
  type MergeDecisionInput,
  createPendingReviewRepository,
  type PendingReviewRepository,
  type PendingReviewInput,
} from './db/repositories/index.js'

// Normalization Pipeline
export {
  // Types
  type PIIType,
  type DetectedPII,
  type LinkType,
  type ExtractedLink,
  type HtmlToTextOptions,
  type TimestampOptions,
  type PIIOptions,
  type LinkExtractionOptions,
  type TextNormalizationOptions,
  type NormalizationOptions,
  type TextNormalizationResult,
  type TimestampNormalizationResult,
  type EntityNormalizationResult,
  type FieldNormalizationSpec,
  type EntityNormalizationSpec,
  // Schemas
  PIITypeSchema,
  LinkTypeSchema,
  // Default Options
  DEFAULT_HTML_OPTIONS,
  DEFAULT_TIMESTAMP_OPTIONS,
  DEFAULT_PII_OPTIONS,
  DEFAULT_LINK_OPTIONS,
  DEFAULT_TEXT_OPTIONS,
  DEFAULT_NORMALIZATION_OPTIONS,
  // HTML Conversion
  htmlToText,
  htmlToTextWithLinks,
  decodeHtmlEntities,
  extractLinksFromHtml,
  containsHtml,
  // Timestamp Normalization
  normalizeTimestamp,
  parseTimestamp,
  formatTimestamp,
  extractTimezone,
  isValidDate,
  toDate,
  isTimestampLike,
  nowISO,
  nowUnix,
  // PII Detection
  detectPII,
  redactPII,
  maskPII,
  analyzePII,
  containsPII,
  // Link Extraction
  extractLinks,
  extractUrlsOnly,
  extractDomains,
  normalizeUrl,
  extractDomain,
  replaceLinks,
  containsLinks,
  countLinks,
  // Text Normalization
  normalizeText,
  normalizeUnicode,
  removeDiacritics,
  collapseWhitespace,
  normalizeLineEndings,
  normalizeBlankLines,
  trimLines,
  removeControlChars,
  removeNullBytes,
  removeZeroWidth,
  truncate,
  truncateWords,
  deduplicateChars,
  unquote,
  toLowerCase,
  toUpperCase,
  toTitleCase,
  toSentenceCase,
  slugify,
  isEmpty,
  isNotEmpty,
  wordCount,
  charCount,
  // Pipeline
  NormalizationPipeline,
  createNormalizationPipeline,
  defaultPipeline,
} from './normalization/index.js'

// Error Handling
export {
  // Constants
  ErrorCategory,
  ErrorCode,
  // Schemas
  ErrorCategorySchema,
  ErrorCodeSchema,
  ErrorSeveritySchema,
  SerializedErrorSchema,
  // Types
  type ErrorSeverity as ErrorSeverityType,
  type ErrorContext,
  type SerializedError,
  // Base error class
  AgentMemoryError,
  // Specialized error classes
  AuthenticationError,
  TokenExpiredError,
  NetworkError as NetworkErr,
  TimeoutError as TimeoutErr,
  RateLimitError as RateLimitErr,
  ValidationError as ValidationErr,
  DatabaseError,
  SyncError as SyncErr,
  ConnectorError,
  QueueError as QueueErr,
  ResolutionError,
  InternalError,
  AssertionError,
  NotImplementedError,
  // Type guards
  isAgentMemoryError,
  isRetryableError,
  isRateLimitError,
  isAuthError,
  isValidationError,
  // Utilities
  wrapError,
  deserializeError,
  // Recovery
  type RetryConfig,
  type CircuitBreakerConfig,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  exponentialBackoff,
  rateLimitAwareDelay,
  type RetryResult,
  withRetry,
  retryOrThrow,
  withTimeout,
  withTimeoutAndRetry,
  type CircuitState,
  CircuitBreaker as ErrorCircuitBreaker,
  type BatchResult,
  processBatch,
} from './errors/index.js'

// Observability
export {
  // Log types
  LogLevel,
  LOG_LEVEL_PRIORITY,
  LogLevelSchema,
  type LogEntry,
  LogEntrySchema,
  // Metric types
  MetricType,
  MetricTypeSchema,
  type MetricLabels,
  type MetricDefinition,
  type MetricSample,
  type HistogramData,
  type SummaryData,
  // Span types
  SpanStatus,
  SpanKind,
  type SpanAttributes,
  type SpanEvent,
  type SpanData,
  // Health types
  HealthStatus,
  HealthStatusSchema,
  type ComponentHealth,
  type HealthCheckResult,
  ComponentHealthSchema,
  HealthCheckResultSchema,
  // Alert types
  AlertSeverity,
  AlertSeveritySchema,
  type Alert,
  AlertSchema,
  // Interfaces
  type Logger,
  type MetricsCollector,
  type Tracer,
  type Span,
  type HealthChecker,
  type AlertHandler,
  // Logger
  type LoggerConfig,
  DEFAULT_LOGGER_CONFIG,
  StructuredLogger,
  createLogger,
  createLoggerFromEnv,
  noopLogger as noopStructuredLogger,
  defaultLogger as defaultStructuredLogger,
  logTiming,
  scopedLogger,
  // Metrics
  DEFAULT_HISTOGRAM_BUCKETS,
  METRICS,
  InMemoryMetricsCollector,
  createMetricsCollector,
  noopMetrics,
  defaultMetrics,
  // Tracing
  type SpanExporter,
  type TracerConfig,
  DEFAULT_TRACER_CONFIG,
  TracingSpan,
  SimpleTracer,
  createTracer,
  noopTracer,
  defaultTracer,
  ConsoleSpanExporter,
  extractTraceContext,
  injectTraceContext,
  // Health checks
  type HealthCheckerConfig,
  type HealthCheckFn,
  DEFAULT_HEALTH_CHECKER_CONFIG,
  SimpleHealthChecker,
  createHealthChecker,
  defaultHealthChecker,
  createDatabaseHealthCheck,
  createMemoryHealthCheck,
  createEventLoopHealthCheck,
  createExternalServiceHealthCheck,
  // Alerts
  type AlertManagerConfig,
  DEFAULT_ALERT_MANAGER_CONFIG,
  AlertManager,
  ConsoleAlertHandler,
  InMemoryAlertHandler,
  WebhookAlertHandler,
  CallbackAlertHandler,
  createAlertManager,
  defaultAlertManager,
  alertFromError,
  alertHealthFailure,
  alertRateLimited,
} from './observability/index.js'

// Configuration
export {
  // Database Config
  DatabaseConfigSchema,
  type DatabaseConfig as DatabaseConfigType,
  // Queue Config
  QueueConfigSchema,
  type QueueConfig as QueueConfigType,
  // HTTP Config
  HttpConfigSchema,
  type HttpConfig,
  // Sync Config
  SyncConfigSchema,
  type SyncConfig,
  // Entity Resolution Config
  MatchWeightsSchema,
  type MatchWeightsConfig,
  EntityResolutionConfigSchema,
  type EntityResolutionConfig,
  // Embeddings Config
  EmbeddingsConfigSchema,
  type EmbeddingsConfig,
  // Connector Config
  ConnectorConfigSchema,
  type ConnectorConfig,
  // Observability Config
  LogLevelSchema as ConfigLogLevelSchema,
  type LogLevel as ConfigLogLevel,
  ObservabilityConfigSchema,
  type ObservabilityConfig,
  // Security Config
  SecurityConfigSchema,
  type SecurityConfig,
  // App Config
  AppConfigSchema,
  type AppConfig,
  type PartialAppConfig,
  DEFAULT_CONFIG,
  parseConfig,
  safeParseConfig,
  // Loader
  loadConfig,
  loadConfigSync,
  loadFromEnv,
  loadFromFile,
  loadFromFileIfExists,
  mergeConfigs,
  createConfigLoader,
  validateSecrets,
  getConfigSummary,
  type LoadConfigOptions,
} from './config/index.js'

// Sync Daemon
export {
  SyncDaemon,
  HttpServer,
  type DaemonConfig,
  type ServerConfig,
  type ParsedRequest,
  type RouteHandler,
  type RouteResponse,
  type SanityCheck,
  type SanityCheckResult,
  type SanityCheckStatus,
  type ConnectorSanityOptions,
  type TaskSanityOptions,
} from './daemon/index.js'

// Client SDK
export {
  SyncClient,
  type SyncClientConfig,
  // Response Types (prefixed with Client to avoid conflicts)
  type Account as ClientAccount,
  type SyncTask as ClientSyncTask,
  type SyncJob as ClientSyncJob,
  type SyncType as ClientSyncType,
  type TaskMode as ClientTaskMode,
  type SyncJobStatus as ClientSyncJobStatus,
  type SyncJobType as ClientSyncJobType,
  type HealthResponse,
  type AuthUrlResponse,
  type AuthStatusResponse,
  type TaskResponse,
  type JobResponse,
  type BackfillResponse,
  type QueueStats,
  SyncClientError,
  // OAuth helpers
  captureOAuthCallback,
  getCallbackUri,
  type OAuthResult,
  type OAuthCallbackOptions,
} from './client/index.js'
