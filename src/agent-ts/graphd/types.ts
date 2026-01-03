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
