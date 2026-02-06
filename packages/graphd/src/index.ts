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

// ============================================
// TYPES
// ============================================
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
  SiasSessionRecord,
  SiasCheckpointRecord,
  SiasPatchRecord,
  SiasDecisionRecord,
  SiasPrincipalContextRecord,
  SiasHealthSnapshotRecord,
  SiasBenchmarkRunRecord,
  SiasWorktreeRecord,
  SiasDecisionEmbeddingRecord,
  GraphDStats,
  HealthResponse,
  UserRecord,
  ProviderCredentialRecord,
  // Session workflow types (v6)
  SessionStatus,
  SessionMetrics,
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

// ============================================
// SCHEMA
// ============================================
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

// ============================================
// UTILITIES
// ============================================
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

// ============================================
// STORE
// ============================================
export { GraphStore, SchemaVersionError } from './store.js';

// ============================================
// SERVER
// ============================================
export {
  GraphDRequestHandler,
  GraphDHTTPServer,
  checkHealthy,
} from './server.js';

// ============================================
// MANAGER
// ============================================
export type { GraphDConfig } from './manager.js';
export { GraphDManager, createGraphDConfig } from './manager.js';
