/**
 * Entity Graph Types
 *
 * Core type definitions for the entity graph system.
 * Entity ID format: `kind:filepath:name` (e.g., `class:src/user.ts:UserService`)
 */

import type { Sql } from 'postgres'

// --- Entity Kinds ---

export type EntityKind =
  | 'file'
  | 'class'
  | 'function'
  | 'method'
  | 'type'
  | 'interface'
  | 'enum'

// --- Edge Types ---

export type EdgeType =
  | 'imports'
  | 'calls'
  | 'uses'
  | 'owns'
  | 'extends'
  | 'implements'

// --- Core Types ---

export interface Entity {
  id: string
  kind: EntityKind
  name: string
  filepath: string
  startLine: number | null
  endLine: number | null
  exported: boolean
  async: boolean
  rawText: string | null
}

export interface Edge {
  type: EdgeType
  sourceId: string
  targetId: string
  /** Extra data: symbol name for imports, site_line for calls */
  meta?: Record<string, unknown>
}

export interface ParseResult {
  filepath: string
  entities: Entity[]
  edges: Edge[]
}

// --- Configuration ---

export interface EntityGraphConfig {
  /** Root directory of the source tree (for relative path computation) */
  sourceRoot: string
  /** Glob patterns to include */
  include?: string[]
  /** Glob patterns to exclude */
  exclude?: string[]
  /** Default lease duration in seconds (default: 30) */
  leaseDurationSec?: number
  /** Whether to run a full scan on initialize() (default: true) */
  startupScan?: boolean
  /** Lease wait timeout in milliseconds (default: 10000) */
  leaseWaitTimeoutMs?: number
}

// --- Leasing ---

export interface FileLease {
  filepath: string
  agentId: string
  acquiredAt: Date
  expiresAt: Date
}

// --- Query Results ---

export interface BlastRadiusResult {
  /** The source file that was changed */
  sourceFilepath: string
  /** All filepaths affected by changes to sourceFilepath */
  affectedFilepaths: string[]
}

export interface GraphStats {
  entities: number
  imports: number
  calls: number
  uses: number
  owns: number
  extends: number
  implements: number
  fileLeases: number
}

// --- Hooks ---

export interface EntityGraphHooks {
  preToolUse: (agentId: string, toolName: string, args: Record<string, unknown>) => Promise<EntityGraphHookResult>
  postToolUse: (agentId: string, toolName: string, args: Record<string, unknown>) => Promise<EntityGraphHookResult>
  onFilesModified: (paths: string[]) => Promise<void>
}

export interface EntityGraphHookResult {
  action: 'allow' | 'block'
  message?: string
  /** Optional context to append to the tool result (e.g., blast radius info) */
  context?: string
}

// --- Re-export Sql for consumers ---
export type { Sql }
