/**
 * Entity Graph — Main Entry Point
 *
 * EntityGraph class provides a facade over parsing, persistence, querying,
 * leasing, and hook integration. Accepts a Sql instance via DI to share
 * agent-memory's connection pool.
 */

import type { Sql } from 'postgres'
import type {
  EntityGraphConfig,
  EntityGraphHooks,
  Entity,
  EntityKind,
  GraphStats,
} from './types.js'
import { SCHEMA_DDL } from './schema.js'
import { buildFullGraph, parseFile, persistParseResult } from './pipeline.js'
import {
  entitiesInFile,
  entityById,
  importersOfFile,
  callersOf,
  usersOf,
  blastRadius,
  dependentsOf,
  unusedExports,
  graphStats,
} from './queries.js'
import { cleanExpiredLeases } from './leasing.js'
import { createEntityGraphHooks } from './hooks.js'

export class EntityGraph {
  private sql: Sql
  private config: EntityGraphConfig
  private hooks: EntityGraphHooks | null = null
  private scanPromise: Promise<{ files: number; entities: number; edges: number; durationMs: number } | null> | null = null

  constructor(sql: Sql, config: EntityGraphConfig) {
    this.sql = sql
    this.config = config
  }

  /**
   * Initialize the entity graph:
   * 1. Run DDL to create schema + tables (idempotent)
   * 2. Clean expired leases
   * 3. Optionally kick off a full startup scan (non-blocking)
   */
  async initialize(): Promise<void> {
    // Create schema and tables
    await this.sql.unsafe(SCHEMA_DDL)

    // Clean stale leases from previous runs
    const cleaned = await cleanExpiredLeases(this.sql)
    if (cleaned > 0) {
      console.log(`[entity-graph] Cleaned ${cleaned} expired leases`)
    }

    // Run startup scan in background if configured (default: true)
    if (this.config.startupScan !== false) {
      this.scanPromise = buildFullGraph(this.sql, this.config)
        .then(stats => {
          console.log(
            `[entity-graph] Startup scan complete: ${stats.files} files, ${stats.entities} entities, ${stats.edges} edges (${stats.durationMs}ms)`
          )
          return stats
        })
        .catch(err => {
          console.error(`[entity-graph] Startup scan failed:`, err)
          return null
        })
    }
  }

  /**
   * Wait for the background startup scan to finish (if running).
   * Returns scan stats, or null if scan was skipped or failed.
   */
  async waitForScan(): Promise<{ files: number; entities: number; edges: number; durationMs: number } | null> {
    return this.scanPromise ?? null
  }

  /**
   * Get hook handlers for composing with AgentHooks.
   * Lazily created on first access.
   */
  getHooks(): EntityGraphHooks {
    if (!this.hooks) {
      this.hooks = createEntityGraphHooks(this.sql, this.config)
    }
    return this.hooks
  }

  // --- Query Delegation ---

  async entitiesInFile(filepath: string): Promise<Entity[]> {
    return entitiesInFile(this.sql, filepath)
  }

  async entityById(id: string): Promise<Entity | null> {
    return entityById(this.sql, id)
  }

  async importersOfFile(filepath: string): Promise<Entity[]> {
    return importersOfFile(this.sql, filepath)
  }

  async callersOf(entityId: string): Promise<Entity[]> {
    return callersOf(this.sql, entityId)
  }

  async usersOf(entityId: string): Promise<Entity[]> {
    return usersOf(this.sql, entityId)
  }

  async blastRadius(filepath: string): Promise<string[]> {
    return blastRadius(this.sql, filepath)
  }

  async dependentsOf(entityId: string, entityKind: EntityKind): Promise<Entity[]> {
    return dependentsOf(this.sql, entityId, entityKind)
  }

  async unusedExports(filepath?: string): Promise<Entity[]> {
    return unusedExports(this.sql, filepath)
  }

  async graphStats(): Promise<GraphStats> {
    return graphStats(this.sql)
  }

  /**
   * Re-parse a single file on demand.
   */
  async reparse(filepath: string): Promise<void> {
    const result = await parseFile(filepath, this.config.sourceRoot)
    if (result) {
      await persistParseResult(this.sql, result)
    }
  }
}

// --- Barrel Exports ---

export type {
  Entity,
  Edge,
  ParseResult,
  EntityKind,
  EdgeType,
  EntityGraphConfig,
  EntityGraphHooks,
  EntityGraphHookResult,
  FileLease,
  BlastRadiusResult,
  GraphStats,
  Sql,
} from './types.js'

export { SCHEMA_DDL } from './schema.js'
export { parseFile, persistParseResult, buildFullGraph, deleteFileContribution } from './pipeline.js'
export {
  entitiesInFile,
  entityById,
  importersOfFile,
  callersOf,
  usersOf,
  blastRadius,
  dependentsOf,
  unusedExports,
  graphStats,
} from './queries.js'
export { acquireLease, releaseLease, cleanExpiredLeases } from './leasing.js'
export { createEntityGraphHooks } from './hooks.js'
export { entityId } from './parser/extractor.js'
export { languageForFile, createParser, parseSource } from './parser/parser.js'
export type { SupportedLanguage } from './parser/parser.js'
