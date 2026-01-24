/**
 * Repository Layer
 *
 * Type-safe database access for all tables.
 */

export { createRepositoryContext, type RepositoryContext, type PaginationOptions, type PaginatedResult, type Repository } from './types.js'

export {
  createRawEnvelopeRepository,
  type RawEnvelopeRepository,
  type RawEnvelopeRow,
} from './raw-envelope.js'

export {
  createCanonicalEntityRepository,
  type CanonicalEntityRepository,
  type CanonicalEntityRow,
  type StoredEntity,
  type CanonicalEntityFilters,
} from './canonical-entity.js'

export {
  createEntitySourceMappingRepository,
  type EntitySourceMappingRepository,
  type EntitySourceMappingRow,
} from './entity-source-mapping.js'

export {
  createSyncJobRepository,
  type SyncJobRepository,
  type SyncJob,
  type SyncJobInput,
  type SyncJobRow,
  type SyncJobStatus,
  type SyncJobType,
} from './sync-job.js'

export {
  createAccountRepository,
  type AccountRepository,
  type Account,
  type AccountInput,
  type AccountRow,
  type AccountCredentials,
  type AuthType,
} from './account.js'

export {
  createJobQueueRepository,
  type JobQueueRepository,
  type QueueJob,
  type QueueJobRow,
  type JobStatus,
  type EnqueueOptions,
} from './job-queue.js'

export {
  createMergeDecisionRepository,
  type MergeDecisionRepository,
  type MergeDecisionRow,
  type MergeDecisionInput,
} from './merge-decision.js'

export {
  createPendingReviewRepository,
  type PendingReviewRepository,
  type PendingReviewRow,
  type PendingReviewInput,
} from './pending-review.js'

export {
  createSyncTaskRepository,
  type SyncTaskRepository,
  type SyncTask,
  type SyncTaskInput,
  type SyncTaskRow,
  type SyncType,
  type TaskMode,
} from './sync-task.js'
