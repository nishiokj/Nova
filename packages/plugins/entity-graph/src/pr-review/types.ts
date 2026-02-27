/**
 * PR Review Types
 *
 * Shared type definitions for the entity-aware PR review pipeline.
 */

import type { Entity, EdgeType } from '../types.js'
import type { BlastRadiusEntry } from '../queries.js'

// --- Diff ---

export interface FileChange {
  filepath: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  oldFilepath?: string // for renames
  hunks: Hunk[]
}

export interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

// --- Classification ---

export type ChangeKind =
  | 'signature_changed'  // params/return type changed — callers at risk
  | 'body_changed'       // implementation changed — behavior risk only
  | 'entity_added'       // new entity introduced
  | 'entity_deleted'     // entity removed — broken references
  | 'export_changed'     // export flag toggled — module boundary risk

export interface EntityChange {
  entity: Entity
  changeKind: ChangeKind
  fileStatus: FileChange['status']
}

// --- Scoring ---

export interface RiskSignal {
  entity: Entity
  score: number          // 0–100
  factors: string[]      // human-readable explanations
}

// --- Review ---

export interface PRReview {
  summary: string
  changedEntities: EntityChange[]
  blastRadius: {
    direct: BlastRadiusEntry[]      // depth 1
    transitive: BlastRadiusEntry[]  // depth 2+
    totalFiles: number
    totalEntities: number
  }
  risks: RiskSignal[]               // sorted by score desc
  deadCode: Entity[]                // new unused exports
}
