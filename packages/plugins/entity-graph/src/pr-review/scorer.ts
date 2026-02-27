/**
 * Risk Scorer
 *
 * Scores affected entities by combining change severity, graph proximity,
 * fanout, and entity kind to produce a 0–100 risk signal.
 */

import type { Entity } from '../types.js'
import type { BlastRadiusEntry } from '../queries.js'
import type { EntityChange, RiskSignal } from './types.js'

// --- Weights ---

const CHANGE_SEVERITY: Record<string, number> = {
  entity_deleted:     40,
  signature_changed:  35,
  export_changed:     30,
  entity_added:       5,
  body_changed:       15,
}

const KIND_WEIGHT: Record<string, number> = {
  interface:  20,
  type:       18,
  class:      15,
  enum:       12,
  function:   10,
  method:     8,
  file:       5,
}

/**
 * Score risk for all blast-radius entities based on how they relate
 * to the changed entities in this PR.
 */
export function scoreRisks(
  changedEntities: EntityChange[],
  blastEntries: BlastRadiusEntry[],
): RiskSignal[] {
  // Build a lookup: entityId → change info for the directly changed entities
  const changeMap = new Map<string, EntityChange>()
  for (const ec of changedEntities) {
    changeMap.set(ec.entity.id, ec)
  }

  const signals: RiskSignal[] = []

  // Score each entity in the blast radius
  for (const entry of blastEntries) {
    const { entity, depth, via } = entry
    const factors: string[] = []
    let score = 0

    // 1. Proximity: closer = riskier
    const proximityScore = depth === 1 ? 25 : Math.max(5, 25 - (depth - 1) * 8)
    score += proximityScore
    factors.push(`depth ${depth} dependent (${via} edge)`)

    // 2. Kind weight: interfaces/types affected = higher risk
    const kindScore = KIND_WEIGHT[entity.kind] ?? 5
    score += kindScore
    if (kindScore >= 15) {
      factors.push(`${entity.kind} change has wide contract impact`)
    }

    // 3. Export boundary: exported entities propagate further
    if (entity.exported) {
      score += 10
      factors.push('exported — visible to external consumers')
    }

    // 4. Find the worst upstream change that reaches this entity
    const upstreamSeverity = worstUpstreamSeverity(changedEntities)
    score += upstreamSeverity.score
    if (upstreamSeverity.factor) {
      factors.push(upstreamSeverity.factor)
    }

    signals.push({
      entity,
      score: Math.min(100, score),
      factors,
    })
  }

  // Also score the directly changed entities themselves
  for (const ec of changedEntities) {
    const factors: string[] = []
    let score = 0

    const severity = CHANGE_SEVERITY[ec.changeKind] ?? 10
    score += severity
    factors.push(`directly ${ec.changeKind.replace(/_/g, ' ')}`)

    const kindScore = KIND_WEIGHT[ec.entity.kind] ?? 5
    score += kindScore

    if (ec.entity.exported) {
      score += 15
      factors.push('exported entity')
    }

    signals.push({
      entity: ec.entity,
      score: Math.min(100, score),
      factors,
    })
  }

  // Sort descending by score
  signals.sort((a, b) => b.score - a.score)
  return signals
}

function worstUpstreamSeverity(
  changedEntities: EntityChange[],
): { score: number; factor: string | null } {
  let worst = 0
  let factor: string | null = null

  for (const ec of changedEntities) {
    const s = CHANGE_SEVERITY[ec.changeKind] ?? 0
    if (s > worst) {
      worst = s
      factor = `upstream ${ec.changeKind.replace(/_/g, ' ')} in ${ec.entity.name}`
    }
  }

  return { score: Math.round(worst * 0.5), factor }
}
