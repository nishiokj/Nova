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
  // Connector Interface
  type FetchPageOptions,
  type FetchChangesOptions,
  type ConnectorAdapter,
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
  AuthError,
} from './types.js'

// Collector
export {
  Collector,
  type CollectorConfig,
} from './collector.js'

// Processor
export {
  Processor,
  MapperRegistry,
  type ProcessorConfig,
} from './processor.js'

// Engine
export {
  SyncEngine,
  type SyncEngineConfig,
} from './engine.js'
