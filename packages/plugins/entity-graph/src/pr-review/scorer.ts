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

const CONTRACT_CHANGE_KINDS = new Set(['signature_changed', 'export_changed', 'entity_deleted'])

/**
 * Score risk for all blast-radius entities based on how they relate
 * to the changed entities in this PR.
 */
export function scoreRisks(
  changedEntities: EntityChange[],
  blastEntries: BlastRadiusEntry[],
): RiskSignal[] {
  const seedSeverity = seedSeverityByEntity(changedEntities)
  const fallbackWorst = worstUpstreamSeverity(changedEntities)
  const changedEntityIds = new Set(changedEntities.map(ec => ec.entity.id))

  const blastByEntity = new Map<string, {
    entity: Entity
    depth: number
    vias: Set<string>
    upstream: { score: number; factor: string | null }
  }>()

  // Aggregate blast entries by entity to avoid duplicate rows from multi-path traversal.
  for (const entry of blastEntries) {
    const upstream = upstreamSeverityForEntry(entry, seedSeverity, fallbackWorst)
    const existing = blastByEntity.get(entry.entity.id)

    if (!existing) {
      blastByEntity.set(entry.entity.id, {
        entity: entry.entity,
        depth: entry.depth,
        vias: new Set([entry.via]),
        upstream,
      })
      continue
    }

    if (entry.depth < existing.depth) {
      existing.depth = entry.depth
      existing.vias = new Set([entry.via])
    } else if (entry.depth === existing.depth) {
      existing.vias.add(entry.via)
    }

    if (upstream.score > existing.upstream.score) {
      existing.upstream = upstream
    }
  }

  const signalsByEntity = new Map<string, RiskSignal>()

  // Score blast-radius entities.
  for (const aggregate of blastByEntity.values()) {
    const factors: string[] = []
    let score = 0

    const proximityScore = aggregate.depth === 1
      ? 25
      : Math.max(5, 25 - (aggregate.depth - 1) * 8)
    score += proximityScore

    const viaList = Array.from(aggregate.vias).sort().join(', ')
    factors.push(`depth ${aggregate.depth} dependent (${viaList} edge)`)

    const kindScore = KIND_WEIGHT[aggregate.entity.kind] ?? 5
    score += kindScore
    if (kindScore >= 15) {
      factors.push(`${aggregate.entity.kind} change has wide contract impact`)
    }

    if (aggregate.entity.exported) {
      score += 10
      factors.push('exported — visible to external consumers')
    }

    score += aggregate.upstream.score
    if (aggregate.upstream.factor) {
      factors.push(aggregate.upstream.factor)
    }

    signalsByEntity.set(aggregate.entity.id, {
      entity: aggregate.entity,
      score: Math.min(100, score),
      factors,
    })
  }

  // Score directly changed entities and merge with any dependent signal.
  for (const ec of changedEntities) {
    const directFactors: string[] = []
    let directScore = 0

    const severity = CHANGE_SEVERITY[ec.changeKind] ?? 10
    directScore += severity
    directFactors.push(`directly ${ec.changeKind.replace(/_/g, ' ')}`)

    const kindScore = KIND_WEIGHT[ec.entity.kind] ?? 5
    directScore += kindScore

    if (ec.entity.exported) {
      directScore += 15
      directFactors.push('exported entity')
    }

    const contractCoverage = contractCoverageAdjustment(ec, blastEntries, changedEntityIds)
    directScore += contractCoverage.delta
    if (contractCoverage.factor) {
      directFactors.push(contractCoverage.factor)
    }

    const directSignal: RiskSignal = {
      entity: ec.entity,
      score: Math.min(100, directScore),
      factors: directFactors,
    }

    const existing = signalsByEntity.get(ec.entity.id)
    if (!existing) {
      signalsByEntity.set(ec.entity.id, directSignal)
      continue
    }

    signalsByEntity.set(ec.entity.id, {
      entity: ec.entity,
      score: Math.max(existing.score, directSignal.score),
      factors: uniqueFactors([...directSignal.factors, ...existing.factors]),
    })
  }

  const signals = Array.from(signalsByEntity.values())
  signals.sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id))
  return signals
}

function seedSeverityByEntity(
  changedEntities: EntityChange[],
): Map<string, { raw: number; factor: string | null }> {
  const map = new Map<string, { raw: number; factor: string | null }>()

  for (const ec of changedEntities) {
    const raw = CHANGE_SEVERITY[ec.changeKind] ?? 0
    const existing = map.get(ec.entity.id)
    if (existing && existing.raw >= raw) continue
    map.set(ec.entity.id, {
      raw,
      factor: `upstream ${ec.changeKind.replace(/_/g, ' ')} in ${ec.entity.name}`,
    })
  }

  return map
}

function upstreamSeverityForEntry(
  entry: BlastRadiusEntry,
  seedSeverity: Map<string, { raw: number; factor: string | null }>,
  fallbackWorst: { score: number; factor: string | null },
): { score: number; factor: string | null } {
  const seed = seedSeverity.get(entry.seedId)
  if (!seed) return fallbackWorst
  return { score: Math.round(seed.raw * 0.5), factor: seed.factor }
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

function uniqueFactors(factors: string[]): string[] {
  return Array.from(new Set(factors))
}

function contractCoverageAdjustment(
  entityChange: EntityChange,
  blastEntries: BlastRadiusEntry[],
  changedEntityIds: Set<string>,
): { delta: number; factor: string | null } {
  if (!CONTRACT_CHANGE_KINDS.has(entityChange.changeKind)) {
    return { delta: 0, factor: null }
  }

  const directDependents = new Set(
    blastEntries
      .filter(entry => entry.seedId === entityChange.entity.id && entry.depth === 1)
      .map(entry => entry.entity.id)
      .filter(id => id !== entityChange.entity.id),
  )

  if (directDependents.size === 0) {
    return { delta: -10, factor: 'no direct dependents found in graph' }
  }

  let unresolved = 0
  for (const dependentId of directDependents) {
    if (!changedEntityIds.has(dependentId)) {
      unresolved += 1
    }
  }

  if (unresolved === 0) {
    return { delta: -15, factor: 'all direct dependents also changed in this PR' }
  }

  const penalty = Math.min(20, 10 + (unresolved - 1) * 3)
  const label = unresolved === 1 ? '1 direct dependent not updated in this PR' : `${unresolved} direct dependents not updated in this PR`
  return { delta: penalty, factor: label }
}
