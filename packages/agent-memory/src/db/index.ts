/**
 * Database Module
 *
 * PostgreSQL storage layer with connection pooling, migrations, and repositories.
 */

// Connection
export {
  createDatabase,
  createDatabaseFromEnv,
  type Database,
  type DatabaseConfig,
  type Sql,
} from './connection.js'

// Migrations
export {
  migrate,
  loadMigrations,
  getAppliedMigrations,
  getCurrentVersion,
  isSchemaUpToDate,
  getPendingMigrations,
  type Migration,
  type AppliedMigration,
  type MigrationResult,
} from './migrations.js'

// Repositories
export {
  // Context
  createRepositoryContext,
  type RepositoryContext,
  type PaginationOptions,
  type PaginatedResult,
  type Repository,
  // Raw Envelope
  createRawEnvelopeRepository,
  type RawEnvelopeRepository,
  // Canonical Entity
  createCanonicalEntityRepository,
  type CanonicalEntityRepository,
  type StoredEntity,
  type CanonicalEntityFilters,
  // Entity Source Mapping
  createEntitySourceMappingRepository,
  type EntitySourceMappingRepository,
  // Sync Job
  createSyncJobRepository,
  type SyncJobRepository,
  type SyncJob,
  type SyncJobInput,
  type SyncJobStatus,
  type SyncJobType,
  // Account
  createAccountRepository,
  type AccountRepository,
  type Account,
  type AccountInput,
  type AccountCredentials,
  type AuthType,
  // Job Queue
  createJobQueueRepository,
  type JobQueueRepository,
  type QueueJob,
  type JobStatus,
  type EnqueueOptions,
} from './repositories/index.js'
