/**
 * Contract Compilation — Verdict Recording
 *
 * Records test verdicts back to contract rows. The compilation step
 * (English → verification plan) is now handled by skills (/capture,
 * /generate-contract-tests) rather than the rule-based semantic compiler.
 */

import type { Sql } from 'postgres'
import { updateContractCompilation, updateContractStatus } from './queries.js'
import type { ContractStatus } from './types.js'

/** Verdict input matching the shape previously provided by semantic-compiler. */
export interface VerdictInput {
  inv_id: string
  verdict: 'pass' | 'fail' | 'error' | 'skipped'
}

/**
 * Record verdicts from a verification run back to contract rows.
 *
 * Maps VerdictInput[] → contract status updates:
 * - pass → passing
 * - fail → failing
 * - error → no status change
 * - skipped → no change
 */
export async function recordVerdicts(
  sql: Sql,
  verdicts: VerdictInput[],
): Promise<{ updated: number }> {
  if (verdicts.length === 0) return { updated: 0 }

  const now = new Date().toISOString()
  const statusMap: Record<string, ContractStatus | null> = {
    pass: 'passing',
    fail: 'failing',
    error: null,
    skipped: null,
  }

  // Batch: verify all contract IDs exist in one query
  const ids = verdicts.map(v => v.inv_id)
  const existing = await sql<Array<{ id: string }>>`
    SELECT id FROM entity_graph.contracts WHERE id = ANY(${ids})
  `
  const existingIds = new Set(existing.map(r => r.id))

  let updated = 0
  for (const v of verdicts) {
    if (!existingIds.has(v.inv_id)) continue

    const newStatus = statusMap[v.verdict]
    if (newStatus) {
      await updateContractStatus(sql, v.inv_id, newStatus)
    }

    await updateContractCompilation(sql, v.inv_id, {
      lastVerdict: v.verdict,
      lastVerdictAt: now,
    })

    updated++
  }

  return { updated }
}
