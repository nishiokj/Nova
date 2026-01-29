/**
 * Watcher Sessions Connector
 *
 * Connector for reading watcher session data from .watcher/ directories.
 * Syncs decisions.jsonl and work-log.jsonl into agent_actions table.
 *
 * @module connectors/watcher-sessions
 */

// ============ Connector ============

export {
  WatcherSessionsConnector,
  createWatcherSessionsConnector,
  type WatcherSessionsConnectorConfig,
} from './connector.js'

// ============ Schemas ============

export {
  // Entry schemas (raw JSONL format)
  ExecutionMetricsSchema,
  QualityGateSchema,
  DecisionEntrySchema,
  WorkLogEntrySchema,
  // Source schemas (for SourceItem)
  WatcherDecisionSourceSchema,
  WatcherWorkLogSourceSchema,
  // Types
  type ExecutionMetrics,
  type QualityGate,
  type DecisionEntry,
  type WorkLogEntry,
  type WatcherDecisionSource,
  type WatcherWorkLogSource,
} from './schemas.js'

// ============ Transformations ============

export { watcherSessionsTransforms } from './transforms.js'
