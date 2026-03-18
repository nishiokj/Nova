/**
 * Contract Dirty Detection
 *
 * When entities change, contracts linked to those entities (directly or
 * transitively via blast radius) are marked dirty.
 */

import type { Sql } from 'postgres'
import { entityBlastRadius } from '../queries.js'

const MAX_DIRTY_CONTRACTS = 200

/**
 * Find contract IDs that should become dirty because their linked entities
 * (or transitive dependents) have changed.
 */
export async function computeDirtyContracts(
  sql: Sql,
  changedEntityIds: string[],
  maxDepth: number = 2,
): Promise<string[]> {
  if (changedEntityIds.length === 0) return []

  // Direct: contracts linked to the changed entities
  const directRows = await sql<Array<{ contract_id: string }>>`
    SELECT DISTINCT contract_id
    FROM entity_graph.contract_entity_links
    WHERE entity_id = ANY(${changedEntityIds})
  `
  const directIds = new Set(directRows.map(r => r.contract_id))

  // Transitive: use entity blast radius to find affected entities, then their contracts
  const blastEntries = await entityBlastRadius(sql, changedEntityIds, maxDepth)
  const transitiveEntityIds = blastEntries.map(e => e.entity.id)

  if (transitiveEntityIds.length > 0) {
    const transitiveRows = await sql<Array<{ contract_id: string }>>`
      SELECT DISTINCT contract_id
      FROM entity_graph.contract_entity_links
      WHERE entity_id = ANY(${transitiveEntityIds})
    `
    for (const r of transitiveRows) directIds.add(r.contract_id)
  }

  // Safety valve
  const allIds = [...directIds]
  return allIds.slice(0, MAX_DIRTY_CONTRACTS)
}

/**
 * Mark contracts linked to changed entities as dirty.
 * Returns count of contracts transitioned.
 */
export async function markDirtyContracts(
  sql: Sql,
  changedEntityIds: string[],
  maxDepth: number = 2,
): Promise<number> {
  const contractIds = await computeDirtyContracts(sql, changedEntityIds, maxDepth)
  if (contractIds.length === 0) return 0

  // Don't touch already-dirty or insufficient contracts
  const result = await sql`
    UPDATE entity_graph.contracts
    SET status = 'dirty', updated_at = ${new Date().toISOString()}
    WHERE id = ANY(${contractIds})
      AND status NOT IN ('dirty', 'insufficient')
  `

  return result.count
}
