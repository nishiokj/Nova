/**
 * GraphD data structures.
 *
 * Ported from: src/harness/graphd/types.py
 */

// ============================================
// SYMBOL DEFINITION
// ============================================

/**
 * Symbol definition extracted from source code.
 */
export interface SymbolDef {
  id: string;
  path: string;
  kind: string; // 'function', 'class', 'method', 'variable', etc.
  name: string;
  qualname: string;
  sig: string; // Signature
  spanStart: number;
  spanEnd: number;
  hash: string;
}

/**
 * Convert SymbolDef to JSON-serializable dict.
 */
export function symbolDefToDict(s: SymbolDef): Record<string, unknown> {
  return {
    id: s.id,
    path: s.path,
    kind: s.kind,
    name: s.name,
    qualname: s.qualname,
    sig: s.sig,
    span_start: s.spanStart,
    span_end: s.spanEnd,
    hash: s.hash,
  };
}

/**
 * Convert dict to SymbolDef (from database row).
 */
export function dictToSymbolDef(d: Record<string, unknown>): SymbolDef {
  return {
    id: d.id as string,
    path: d.path as string,
    kind: d.kind as string,
    name: d.name as string,
    qualname: d.qualname as string,
    sig: d.sig as string,
    spanStart: d.span_start as number,
    spanEnd: d.span_end as number,
    hash: d.hash as string,
  };
}

// ============================================
// MODULE EDGE
// ============================================

/**
 * Edge representing module imports/dependencies.
 */
export interface ModuleEdge {
  srcPath: string;
  dstPath: string;
  kind: string; // Default 'imports'
  confidence: number; // Default 0.95
}

/**
 * Create a module edge with defaults.
 */
export function createModuleEdge(
  srcPath: string,
  dstPath: string,
  kind = 'imports',
  confidence = 0.95
): ModuleEdge {
  return { srcPath, dstPath, kind, confidence };
}

/**
 * Convert ModuleEdge to JSON-serializable dict.
 */
export function moduleEdgeToDict(e: ModuleEdge): Record<string, unknown> {
  return {
    src_path: e.srcPath,
    dst_path: e.dstPath,
    kind: e.kind,
    confidence: e.confidence,
  };
}

export function dictToModuleEdge(row: Record<string, unknown>): ModuleEdge {
  return {
    srcPath: String(row.src_path || row.srcPath),
    dstPath: String(row.dst_path || row.dstPath),
    kind: String(row.kind),
    confidence: Number(row.confidence ?? 0.95),
  };
}

// ============================================
// EXPORT DEFINITION
// ============================================

/**
 * Export definition for module exports.
 */
export interface ExportDef {
  path: string;
  symbolId: string | null;
  kind: string;
  confidence: number; // Default 0.8
}

/**
 * Create an export definition with defaults.
 */
export function createExportDef(
  path: string,
  symbolId: string | null,
  kind: string,
  confidence = 0.8
): ExportDef {
  return { path, symbolId, kind, confidence };
}

/**
 * Convert ExportDef to JSON-serializable dict.
 */
export function exportDefToDict(e: ExportDef): Record<string, unknown> {
  return {
    path: e.path,
    symbol_id: e.symbolId,
    kind: e.kind,
    confidence: e.confidence,
  };
}

// ============================================
// DERIVED EDGE
// ============================================

/**
 * Derived edge (cached inference result).
 */
export interface DerivedEdge {
  src: string;
  dst: string;
  kind: string;
  confidence: number;
  provenance: string;
  expiresAt: number;
}

/**
 * Convert DerivedEdge to JSON-serializable dict.
 */
export function derivedEdgeToDict(e: DerivedEdge): Record<string, unknown> {
  return {
    src: e.src,
    dst: e.dst,
    kind: e.kind,
    confidence: e.confidence,
    provenance: e.provenance,
    expires_at: e.expiresAt,
  };
}

export function createDerivedEdge(
  src: string,
  dst: string,
  kind: string,
  provenance: string,
  confidence: number = 0.7,
  expiresAt: number = 0
): DerivedEdge {
  return {
    src,
    dst,
    kind,
    confidence,
    provenance,
    expiresAt,
  };
}

export function dictToDerivedEdge(row: Record<string, unknown>): DerivedEdge {
  return {
    src: String(row.src),
    dst: String(row.dst),
    kind: String(row.kind),
    confidence: Number(row.confidence ?? 0.7),
    provenance: String(row.provenance || ''),
    expiresAt: Number(row.expires_at ?? row.expiresAt ?? 0),
  };
}

// ============================================
// IMPACT ITEM
// ============================================

/**
 * Impact analysis result item.
 */
export interface ImpactItem {
  kind: string;
  target: string;
  confidence: number;
  rationale: string;
  suggestedVerification: string;
  provenance?: string;
}

/**
 * Convert ImpactItem to JSON-serializable dict.
 */
export function impactItemToDict(i: ImpactItem): Record<string, unknown> {
  return {
    kind: i.kind,
    target: i.target,
    confidence: i.confidence,
    rationale: i.rationale,
    suggested_verification: i.suggestedVerification,
    provenance: i.provenance,
  };
}

// ============================================
// FILE RECORD
// ============================================

/**
 * File record in the graph database.
 */
export interface FileRecord {
  path: string;
  lang: string;
  hash: string;
  mtime: number;
}

// ============================================
// RUN ARTIFACT
// ============================================

/**
 * Run artifact (test results, build outputs, etc.).
 */
export interface RunArtifact {
  path: string;
  kind: string;
  details: Record<string, unknown>;
  updatedAt: number;
}

// ============================================
// SESSION TYPES (for GraphD session management)
// ============================================

/**
 * GraphD session as stored in database.
 */
export interface GraphDSession {
  sessionKey: string;
  clientType: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number | null;
  workingDir: string | null;
  status: string;
  metadataJson: string | null;
  metadata?: Record<string, unknown>;
  /** Truncated preview of the last user message (for session lists) */
  lastUserMessagePreview?: string | null;
}

/**
 * GraphD conversation message as stored in database.
 */
export interface GraphDMessage {
  id: number;
  sessionKey: string;
  messageIndex: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: number;
  metadataJson: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * GraphD context snapshot as stored in database.
 */
export interface GraphDContextSnapshot {
  id: number;
  sessionKey: string;
  snapshotVersion: number;
  createdAt: number;
  contextJson: string | null;
  context?: Record<string, unknown>;
}

/**
 * GraphD session event as stored in database.
 */
export interface GraphDEvent {
  id: number;
  sessionKey: string;
  requestId: string | null;
  eventType: string;
  stepNum: number | null;
  timestamp: number;
  dataJson: string | null;
  data?: Record<string, unknown>;
}

// ============================================
// SIAS KERNEL TYPES
// ============================================

export interface SiasSessionRecord {
  sessionId: string;
  startedAt: number;
  lastCheckpointAt: number;
  iterationCount: number;
  status: string;
  metadataJson: string | null;
  metadata?: Record<string, unknown>;
}

export interface SiasCheckpointRecord {
  id: number;
  sessionId: string;
  version: number;
  iteration: number;
  createdAt: number;
  payloadJson: string;
  payload?: Record<string, unknown>;
}

export interface SiasPatchRecord {
  patchId: string;
  sessionId: string;
  iteration: number;
  timestamp: number;
  objective: string | null;
  reasoning: string | null;
  filesChangedJson: string | null;
  filesChanged?: string[];
  diffSummary: string | null;
  status: string;
  rollbackReason: string | null;
  benchmarkBeforeJson: string | null;
  benchmarkAfterJson: string | null;
  testSummaryJson: string | null;
  benchmarkBefore?: Record<string, unknown>;
  benchmarkAfter?: Record<string, unknown>;
  testSummary?: Record<string, unknown>;
}

export interface SiasDecisionRecord {
  decisionId: string;
  sessionId: string;
  iteration: number;
  agent: string;
  decisionType: string;
  reasoning: string | null;
  outcome: string | null;
  relatedDecisionsJson: string | null;
  relatedDecisions?: string[];
  createdAt: number;
}

export interface SiasPrincipalContextRecord {
  sessionId: string;
  patchSummary: string | null;
  currentFocus: string | null;
  learnedConstraintsJson: string | null;
  learnedConstraints?: string[];
  horizonObjectivesJson: string | null;
  horizonObjectives?: string[];
  lastUpdated: number;
}

export interface SiasHealthSnapshotRecord {
  id: number;
  sessionId: string;
  capturedAt: number;
  metricsJson: string;
  metrics?: Record<string, unknown>;
}

export interface SiasBenchmarkRunRecord {
  id: number;
  sessionId: string;
  tier: string;
  startedAt: number;
  completedAt: number;
  score: number;
  resultJson: string;
  result?: Record<string, unknown>;
}

export interface SiasWorktreeRecord {
  version: string;
  path: string;
  status: string;
  createdAt: number;
  promotedAt: number | null;
  archivedAt: number | null;
  iterationsRun: number | null;
  benchmarkScore: number | null;
  failureCount: number | null;
  failureReason: string | null;
  failureIteration: number | null;
  gitCommit: string | null;
  patchesIncludedJson: string | null;
  patchesIncluded?: string[];
  benchmarkScoresJson: string | null;
  benchmarkScores?: Record<string, unknown>[];
}

export interface SiasDecisionEmbeddingRecord {
  decisionId: string;
  embeddingJson: string;
  embedding?: number[];
  createdAt: number;
}

// ============================================
// AUTH TYPES (v5)
// ============================================

/**
 * User record from Google OAuth.
 */
export interface UserRecord {
  id: string; // Google 'sub' claim
  email: string;
  name: string | null;
  pictureUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * User session (device login token).
 */
export interface UserSessionRecord {
  id: string; // Random UUID
  userId: string;
  deviceName: string | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number | null;
  revoked: boolean;
}

/**
 * Encrypted provider credential (API key).
 */
export interface ProviderCredentialRecord {
  id: string; // Random UUID
  userId: string;
  provider: string; // 'anthropic', 'openai', 'cerebras', etc.
  encryptedKey: string; // AES-256-GCM encrypted
  iv: string; // Initialization vector (base64)
  createdAt: number;
  updatedAt: number;
}

/**
 * Supported provider types for API keys.
 */
export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'openai-compat'
  | 'gemini'
  | 'cerebras'
  | 'together'
  | 'groq'
  | 'fireworks';

// ============================================
// STATS
// ============================================

/**
 * Database statistics.
 */
export interface GraphDStats {
  files: number;
  symbols: number;
  moduleEdges: number;
  exports: number;
}

// ============================================
// HEALTH CHECK
// ============================================

/**
 * Health check response.
 */
export interface HealthResponse {
  status: 'ok' | 'stopped';
  version: string;
  schemaVersion: string;
  root: string;
  dbPath: string;
  active: boolean;
  paused: boolean;
  stats: GraphDStats;
  cache?: Record<string, unknown>;
  lastIndex?: Record<string, unknown>;
}
