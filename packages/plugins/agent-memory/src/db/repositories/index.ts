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
  createDerivedJobRepository,
  type DerivedJobRepository,
  type DerivedJob,
  type DerivedJobInput,
  type DerivedJobRow,
  type DerivedJobStatus,
  type FailureClass,
} from './derived-job.js'

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

export {
  createDerivedTaskRepository,
  type DerivedTaskRepository,
  type DerivedTask,
  type DerivedTaskInput,
  type DerivedTaskUpdateInput,
  type DerivedTaskRow,
  type DerivedTaskMode,
  type ReplayPolicy,
} from './derived-task.js'

export {
  createTransformationRepository,
  type TransformationRepository,
  type TransformationRecord,
  type TransformationInput,
  type TransformationRow,
} from './transformations.js'

export {
  createRegisteredConnectorRepository,
  type RegisteredConnectorRepository,
  type RegisteredConnector,
  type RegisteredConnectorInput,
  type RegisteredConnectorRow,
} from './registered-connector.js'

export {
  createDerivedProcessingLogRepository,
  type DerivedProcessingLogRepository,
  type DerivedProcessingLogRow,
  type DerivedProcessingLogEntry,
  type MarkProcessedInput,
  type ProcessingLogStats,
} from './derived-processing-log.js'

export {
  createDerivedRunLogRepository,
  type DerivedRunLogRepository,
  type DerivedRunLogRecord,
  type DerivedRunLogInput,
  type DerivedRunSampleInput,
  type DerivedRunStatus,
} from './derived-run-log.js'

export {
  createCodingDecisionsRepository,
  type CodingDecisionsRepository,
  type CodingDecisionRow,
  type CodingDecisionRowWithRank,
  type CodingDecisionRowWithSimilarity,
  type DecisionSearchOptions,
  type DecisionSimilarityOptions,
} from './coding-decisions.js'

export {
  createAgentGoalsRepository,
  type AgentGoalsRepository,
  type AgentGoalRow,
  type AgentGoalInput,
  type GoalFilterOptions,
} from './agent-goals.js'

export {
  createProjectsRepository,
  type ProjectsRepository,
  type ProjectRecord,
  type ProjectRow,
  type ProjectInput,
  type ProjectUpdateInput,
  type ProjectFilters,
} from './projects.js'

export {
  createGoalsRepository,
  type GoalsRepository,
  type GoalRecord,
  type GoalRow,
  type GoalInput,
  type GoalUpdateInput,
  type GoalFilters,
} from './goals.js'

export {
  createConversationDigestRepository,
  type ConversationDigestRepository,
  type ConversationDigestRecord,
  type ConversationDigestRow,
  type ConversationDigestInput,
  type ConversationDigestUpdateInput,
} from './conversation-digests.js'

export {
  createEntityMentionsRepository,
  type EntityMentionsRepository,
  type EntityMentionRecord,
  type EntityMentionRow,
  type EntityMentionInput,
  type EntityMentionFilters,
  type SimilarityOptions as EntityMentionSimilarityOptions,
} from './entity-mentions.js'

export {
  createAgentActionsRepository,
  type AgentActionsRepository,
  type AgentActionRow,
  type AgentActionInput,
  type ActionFilterOptions,
  type OutcomeSignal,
} from './agent-actions.js'

export {
  createConfigFactsRepository,
  type ConfigFactsRepository,
  type ConfigFactRow,
  type ConfigFactInput,
  type ConfigType,
  type ValueType,
} from './config-facts.js'

export {
  createRuntimeFactsRepository,
  type RuntimeFactsRepository,
  type RuntimeFactRow,
  type RuntimeFactInput,
  type RuntimeFactType,
} from './runtime-facts.js'

export {
  createTestSpecsRepository,
  type TestSpecsRepository,
  type TestSpecRow,
  type TestSpecInput,
  type TestResult,
} from './test-specs.js'

export {
  createEvidenceRetrievalLogRepository,
  type EvidenceRetrievalLogRepository,
  type EvidenceRetrievalLogRow,
  type EvidenceRetrievalLogInput,
  type RetrievalStatus,
} from './evidence-retrieval-log.js'

export {
  createResourcePoolRepository,
  type ResourcePoolRepository,
  type ResourcePool,
  type ResourcePoolInput,
  type ResourcePoolRow,
  type CanAcquireResult,
} from './resource-pool.js'

export {
  createAgentTracesRepository,
  type AgentTracesRepository,
  type AgentTraceRow,
  type AgentTraceInput,
  type TraceFilterOptions,
} from './agent-traces.js'

export {
  createEscalationsRepository,
  type EscalationsRepository,
  type EscalationRow,
  type EscalationListOptions,
} from './escalations.js'

export {
  createWorkItemTemplatesRepository,
  type WorkItemTemplatesRepository,
  type WorkItemTemplateRow,
} from './workitem-templates.js'

export {
  createTestReportsRepository,
  type TestReportsRepository,
  type TestReportRow,
  type TestReportListOptions,
} from './test-reports.js'

export {
  createAgenticTaskRepository,
  type AgenticTaskRepository,
  type AgenticTaskRow,
} from './agentic-task.js'

export {
  createAgenticRunRepository,
  type AgenticRunRepository,
  type AgenticRunRow,
} from './agentic-run.js'

export {
  createResearchRepository,
  type ResearchRepository,
  type ResearchProjectRow,
  type ResearchNodeRow,
  type ResearchSourceRow,
  type ResearchClaimRow,
  type ResearchProject,
  type ResearchNode,
  type ResearchSource,
  type ResearchClaim,
  type CreateProjectInput,
  type CreateNodeInput,
  type CreateSourceInput,
  type CreateClaimInput,
} from './research.js'

export {
  createArchitectureRepository,
  type ArchitectureRepository,
  type ArchitectureRunStatus,
  type ArchitectureAlertSeverity,
  type ArchitectureAlertStatus,
  type ArchitectureRunRecord,
  type ArchitectureConcernRecord,
  type ArchitectureConcernFileRecord,
  type ArchitectureBoundaryRecord,
  type ArchitectureAlertRecord,
  type ArchitectureConcernDetail,
  type ArchitectureRunInput,
  type ArchitectureRunSuccessInput,
  type ArchitectureDataInput,
  type ArchitectureConcernsQuery,
  type ArchitectureBoundariesQuery,
  type ArchitectureAlertsQuery,
} from './architecture.js'
