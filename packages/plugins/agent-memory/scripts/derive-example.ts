#!/usr/bin/env bun
/**
 * Example Derived Task: Entity Statistics
 *
 * A simple derived task that computes statistics about canonical entities.
 * Demonstrates the basic pattern for derived task scripts.
 *
 * Usage:
 *   Register as a derived task via the API or CLI
 *   Run via sync daemon's derived engine
 */

import type { Sql } from 'postgres'
import type {
  DerivedRunContext,
  DerivedRunResult,
  DerivedMetadataSchema,
} from '../src/derived/runner.js'

// ─── Metadata Schema ─────────────────────────────────────────────────────────

export const metadata: DerivedMetadataSchema = {
  fields: {
    limit: { type: 'number', default: 1000, description: 'Max entity types to return' },
  },
}

/**
 * Main run function - called by DerivedEngine
 */
export async function run(
  ctx: DerivedRunContext
): Promise<DerivedRunResult> {
  const { sql, task, job, logger } = ctx

  logger.info(`Starting entity statistics (job: ${job.id})`)

  // Get config from task metadata
  const config = task.metadata as Record<string, unknown> | undefined
  const limit = (config?.limit as number) ?? 1000

  logger.info(`Computing statistics (limit: ${limit})`)

  // Query the database for canonical entities
  const stats = await sql<Record<string, unknown>[]>`
    SELECT
      COUNT(*) as total_entities,
      type,
      COUNT(DISTINCT source_id) as unique_sources
    FROM canonical_entities
    WHERE processed_at IS NOT NULL
    GROUP BY type
    ORDER BY total_entities DESC
    LIMIT ${limit}
  `

  logger.info(`Found ${stats.length} entity types`)

  // Print summary
  for (const row of stats) {
    logger.info(`  ${row.type}: ${row.total_entities} entities from ${row.unique_sources} sources`)
  }

  // Return result metadata
  return {
    outputRef: `stats_${job.id}`,
    metadata: {
      entityTypes: stats.length,
      stats: stats,
    },
  }
}
