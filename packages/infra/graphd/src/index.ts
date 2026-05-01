/**
 * GraphD - Graph Database for Code Intelligence
 *
 * This module provides SQLite-backed persistence for:
 * - File and symbol indexing
 * - Module dependency tracking
 * - Session management
 * - Context snapshots
 *
 * Ported from: src/harness/graphd/
 */

export type {
  SymbolDef,
  ModuleEdge,
  ExportDef,
  DerivedEdge,
  ImpactItem,
  FileRecord,
  RunArtifact,
  GraphDSession,
  GraphDMessage,
  GraphDContextSnapshot,
  GraphDEvent,
  GraphDStats,
  HealthResponse,
  UserRecord,
  ProviderCredentialRecord,
  // Session workflow types (v6)
  SessionStatus,
  SessionMetrics,
  // File trace types (v7)
  GraphDFileTrace,
  FileTraceInput,
} from './types.js';

export {
  symbolDefToDict,
  dictToSymbolDef,
  createModuleEdge,
  moduleEdgeToDict,
  createExportDef,
  exportDefToDict,
  derivedEdgeToDict,
  impactItemToDict,
} from './types.js';

export {
  GRAPHD_SCHEMA_VERSION,
  GRAPHD_VERSION,
  GRAPHD_SCHEMA_DDL,
  ENABLE_FOREIGN_KEYS,
  ENABLE_WAL,
  ENABLE_NORMAL_SYNC,
  EXPORTABLE_TABLES,
  isExportableTable,
} from './schema.js';

export {
  normalizePath,
  denormalizePath,
  sha1Text,
  sha1Bytes,
  makeSymbolId,
  guessLanguage,
  isTestPath,
  safeInt,
  safeFloat,
  safeJsonParse,
  generateSessionKey,
  parseClientType,
  nowSeconds,
  secondsToDate,
  dateToSeconds,
} from './utils.js';

export { GraphStore, SchemaVersionError } from './store.js';

export {
  GraphDRequestHandler,
  GraphDHTTPServer,
  checkHealthy,
} from './server.js';

export type { GraphDConfig, GraphDStartOptions } from './manager.js';
export { GraphDManager, createGraphDConfig } from './manager.js';
