/**
 * Sync Module
 *
 * Job queue, data collection, and synchronization utilities.
 */

// Queue
export {
  MicroQueue,
  TimeoutError,
  QueueError,
  type QueueConfig,
  type Job,
  type JobResult,
  type JobHandler,
  type DeadJob,
  type MicroQueueStats,
} from './queue.js'

// Types
export {
  // Source Items
  type SourceItem,
  type FetchPageResult,
  type RateLimitInfo,
  // Sync Run
  type SyncRun,
  // Fetch Options
  type FetchPageOptions,
  type FetchChangesOptions,
  // Entity Mapping
  type EntityMapper,
  type MapperContext,
  type MappedEntity,
  // Processing
  type ProcessResult,
  type BatchProcessResult,
  // Events
  type SyncEvent,
  type SyncStats,
  // Errors
  SyncError,
  CollectError,
  ProcessError,
  ValidationError,
  RateLimitError,
} from './types.js'

// Re-export Connector and related types from SDK
export type {
  Connector,
  ConnectorCapabilities,
  ConnectorContext,
} from '../connector/sdk/types.js'

// Collector
export {
  Collector,
  type CollectorConfig,
} from './collector.js'

// Processor
export {
  Processor,
  type ProcessorConfig,
} from './processor.js'

// Engine
export {
  SyncEngine,
  type SyncEngineConfig,
} from './engine.js'

// Scheduler
export {
  Scheduler,
  type SchedulerConfig,
  type SchedulerEvent,
} from './scheduler.js'
