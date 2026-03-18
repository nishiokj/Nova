/**
 * Entity Graph Hooks
 *
 * Creates hook handlers that integrate with AgentHooks.preToolUse/postToolUse.
 * - preToolUse: acquires file lease for Write/Edit/BatchEdit tools
 * - postToolUse: releases lease, re-parses file
 * - onFilesModified: batch handler for files_modified internal hook
 */

import type { Sql } from 'postgres'
import type { EntityGraphConfig, EntityGraphHooks, EntityGraphHookResult } from './types.js'
import { acquireLease, releaseLease } from './leasing.js'
import { parseFile, persistParseResult } from './pipeline.js'
import { blastRadius, entitiesInFile } from './queries.js'
import { markDirtyContracts } from './contracts/staleness.js'
import path from 'path'

/** Tools that modify files and need lease coordination */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'BatchEdit'])

/**
 * Extract the target filepath from tool arguments.
 * Different tools use different argument shapes.
 */
function extractFilepath(toolName: string, args: Record<string, unknown>): string | null {
  if (toolName === 'Write' || toolName === 'Edit') {
    const fp = args.file_path ?? args.filePath ?? args.path
    return typeof fp === 'string' ? fp : null
  }
  if (toolName === 'BatchEdit') {
    // BatchEdit may have a file_path or operate on multiple files
    const fp = args.file_path ?? args.filePath ?? args.path
    return typeof fp === 'string' ? fp : null
  }
  return null
}

/**
 * Create entity graph hook handlers.
 *
 * @param sql - Postgres connection (shared with agent-memory)
 * @param config - Entity graph configuration
 * @returns Hook handlers for composition with AgentHooks
 */
export function createEntityGraphHooks(sql: Sql, config: EntityGraphConfig): EntityGraphHooks {
  const leaseDuration = config.leaseDurationSec ?? 30
  const leaseTimeout = config.leaseWaitTimeoutMs ?? 10_000

  return {
    /**
     * Pre-tool-use hook: acquire file lease for write operations.
     * Blocks if another agent holds the lease (with timeout).
     */
    async preToolUse(
      agentId: string,
      toolName: string,
      args: Record<string, unknown>
    ): Promise<EntityGraphHookResult> {
      if (!FILE_WRITE_TOOLS.has(toolName)) {
        return { action: 'allow' }
      }

      const filepath = extractFilepath(toolName, args)
      if (!filepath) {
        return { action: 'allow' }
      }

      // Normalize to relative path
      const relPath = path.isAbsolute(filepath)
        ? path.relative(config.sourceRoot, filepath)
        : filepath

      const acquired = await acquireLease(sql, relPath, agentId, leaseDuration, leaseTimeout)
      if (!acquired) {
        return {
          action: 'block',
          message: `File "${relPath}" is currently being edited by another agent. Please wait and retry.`,
        }
      }

      return { action: 'allow' }
    },

    /**
     * Post-tool-use hook: release lease, compute blast radius, reparse.
     * Blast radius runs BEFORE reparse because persistParseResult wipes
     * inbound edges — those edges are needed for the dependency walk.
     */
    async postToolUse(
      agentId: string,
      toolName: string,
      args: Record<string, unknown>
    ): Promise<EntityGraphHookResult> {
      if (!FILE_WRITE_TOOLS.has(toolName)) {
        return { action: 'allow' }
      }

      const filepath = extractFilepath(toolName, args)
      if (!filepath) {
        return { action: 'allow' }
      }

      const relPath = path.isAbsolute(filepath)
        ? path.relative(config.sourceRoot, filepath)
        : filepath

      // Release the lease synchronously (important for other agents)
      await releaseLease(sql, relPath, agentId)

      // Compute blast radius BEFORE reparse — reparse wipes inbound edges
      let affected: string[] = []
      try {
        affected = await blastRadius(sql, relPath)
      } catch {
        // Non-fatal — blast radius is advisory
      }

      // Mark linked contracts dirty (fast query, non-fatal)
      let contractDirtyCount = 0
      try {
        const entities = await entitiesInFile(sql, relPath)
        const entityIds = entities.map(e => e.id)
        if (entityIds.length > 0) {
          contractDirtyCount = await markDirtyContracts(sql, entityIds)
        }
      } catch {
        // Non-fatal
      }

      // Fire-and-forget reparse — don't block tool response
      void reparse(sql, relPath, config)

      const parts: string[] = []
      if (affected.length > 0) {
        parts.push(`[entity-graph] ${affected.length} file(s) depend on "${relPath}": ${affected.join(', ')}`)
      }
      if (contractDirtyCount > 0) {
        parts.push(`[contracts] ${contractDirtyCount} contract(s) marked dirty`)
      }

      return {
        action: 'allow',
        context: parts.length > 0 ? parts.join('\n') : undefined,
      }
    },

    /**
     * Handler for files_modified internal hook event.
     * Re-parses modified files in parallel.
     */
    async onFilesModified(paths: string[]): Promise<void> {
      // Collect entity IDs from all modified files for dirty check
      const allEntityIds: string[] = []

      await Promise.all(paths.map(async (filepath) => {
        const relPath = path.isAbsolute(filepath)
          ? path.relative(config.sourceRoot, filepath)
          : filepath
        try {
          // Collect entities before reparse (edges still intact)
          const entities = await entitiesInFile(sql, relPath)
          allEntityIds.push(...entities.map(e => e.id))

          const result = await parseFile(relPath, config.sourceRoot)
          if (result) {
            await persistParseResult(sql, result)
          }
        } catch {
          // Non-fatal — continue with remaining files
        }
      }))

      // Mark linked contracts dirty (non-fatal)
      if (allEntityIds.length > 0) {
        try {
          await markDirtyContracts(sql, allEntityIds)
        } catch {
          // Non-fatal
        }
      }
    },
  }
}

/**
 * Background reparse. Called fire-and-forget from postToolUse.
 */
async function reparse(
  sql: Sql,
  relPath: string,
  config: EntityGraphConfig,
): Promise<void> {
  try {
    const result = await parseFile(relPath, config.sourceRoot)
    if (result) {
      await persistParseResult(sql, result)
    }
  } catch {
    // Non-fatal — graph may be stale but agent continues
  }
}
