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
  TaskSchema,
  type Task,
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
} from './db/index.js'

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
  MapperRegistry,
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
  type ConnectorAdapter,
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
  AuthError,
} from './sync/index.js'

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
  // GitHub Mappers
  githubMappers,
  getGitHubMapper,
  getGitHubEntityTypes,
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
