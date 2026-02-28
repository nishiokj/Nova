/**
 * PR Review Orchestrator
 *
 * Wires together diff parsing, entity classification, blast radius,
 * risk scoring, and dead code detection into a single PRReview artifact.
 */

import type { Sql } from 'postgres'
import { entityBlastRadius, unusedExports } from '../queries.js'
import { parseDiff } from './diff.js'
import { classifyChanges } from './classifier.js'
import { scoreRisks } from './scorer.js'
import type { PRReview, EntityChange, ImpactGap } from './types.js'

const CONTRACT_CHANGE_KINDS = new Set(['signature_changed', 'export_changed', 'entity_deleted'])

/**
 * Run the full PR review pipeline from a unified diff string.
 *
 * @param sql       - Postgres connection
 * @param diffText  - Output of `git diff base...head` (unified format)
 * @param maxDepth  - How many hops to walk the blast radius (default: 2)
 */
export async function reviewDiff(
  sql: Sql,
  diffText: string,
  maxDepth: number = 2,
): Promise<PRReview> {
  // 1. Parse diff → structured file changes
  const fileChanges = parseDiff(diffText)

  // 2. Classify → entity-level changes
  const changedEntities = await classifyChanges(sql, fileChanges)

  // 3. Compute entity-level blast radius
  const seedIds = changedEntities.map(ec => ec.entity.id)
  const rawBlastEntries = await entityBlastRadius(sql, seedIds, maxDepth)
  const blastEntries = dedupeBlastEntries(rawBlastEntries)

  const direct = blastEntries.filter(e => e.depth === 1)
  const transitive = blastEntries.filter(e => e.depth > 1)

  const affectedFiles = new Set<string>()
  for (const e of blastEntries) affectedFiles.add(e.entity.filepath)

  // 4. Score risks
  const risks = scoreRisks(changedEntities, rawBlastEntries)
  const impactGaps = computeImpactGaps(changedEntities, rawBlastEntries)

  // 5. Detect newly-introduced dead code (unused exports in changed files)
  const addedFiles = fileChanges
    .filter(fc => fc.status === 'added' || fc.status === 'modified' || fc.status === 'renamed')
    .map(fc => fc.filepath)
  const uniqueAddedFiles = Array.from(new Set(addedFiles))

  const deadCode = dedupeEntitiesById((
    await Promise.all(uniqueAddedFiles.map(fp => unusedExports(sql, fp)))
  ).flat())

  // 6. Build summary
  const summary = buildSummary(changedEntities.length, direct.length, transitive.length, risks, impactGaps)

  return {
    summary,
    changedEntities,
    blastRadius: {
      direct,
      transitive,
      totalFiles: affectedFiles.size,
      totalEntities: blastEntries.length,
    },
    risks,
    impactGaps,
    deadCode,
  }
}

function dedupeBlastEntries(entries: Awaited<ReturnType<typeof entityBlastRadius>>): Awaited<ReturnType<typeof entityBlastRadius>> {
  const byEntity = new Map<string, typeof entries[number]>()

  for (const entry of entries) {
    const existing = byEntity.get(entry.entity.id)
    if (!existing || entry.depth < existing.depth) {
      byEntity.set(entry.entity.id, entry)
      continue
    }
    if (entry.depth === existing.depth && entry.via < existing.via) {
      byEntity.set(entry.entity.id, entry)
    }
  }

  return Array.from(byEntity.values()).sort(
    (a, b) => a.depth - b.depth || a.entity.filepath.localeCompare(b.entity.filepath) || a.entity.id.localeCompare(b.entity.id),
  )
}

function dedupeEntitiesById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>()
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, item)
  }
  return Array.from(map.values())
}

function buildSummary(
  changed: number,
  directCount: number,
  transitiveCount: number,
  risks: Array<{ score: number }>,
  impactGaps: ImpactGap[],
): string {
  const critical = risks.filter(r => r.score >= 70).length
  const warnings = risks.filter(r => r.score >= 40 && r.score < 70).length
  const unresolvedCount = impactGaps.reduce((sum, gap) => sum + gap.unresolvedDependents.length, 0)

  const parts: string[] = [
    `${changed} entit${changed === 1 ? 'y' : 'ies'} changed`,
  ]

  if (directCount > 0 || transitiveCount > 0) {
    parts.push(`${directCount} direct and ${transitiveCount} transitive dependents affected`)
  }

  if (critical > 0) {
    parts.push(`${critical} critical risk${critical === 1 ? '' : 's'}`)
  }
  if (warnings > 0) {
    parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  }
  if (impactGaps.length > 0) {
    parts.push(
      `${impactGaps.length} contract gap${impactGaps.length === 1 ? '' : 's'} (${unresolvedCount} unresolved dependent${unresolvedCount === 1 ? '' : 's'})`,
    )
  }

  return parts.join('; ') + '.'
}

function computeImpactGaps(
  changedEntities: EntityChange[],
  blastEntries: Awaited<ReturnType<typeof entityBlastRadius>>,
): ImpactGap[] {
  const changedEntityIds = new Set(changedEntities.map(ec => ec.entity.id))
  const changesByEntityId = new Map(changedEntities.map(ec => [ec.entity.id, ec] as const))

  const directDependentsBySeed = new Map<string, Map<string, typeof blastEntries[number]['entity']>>()
  for (const entry of blastEntries) {
    if (entry.depth !== 1) continue
    if (entry.entity.id === entry.seedId) continue
    let dependents = directDependentsBySeed.get(entry.seedId)
    if (!dependents) {
      dependents = new Map()
      directDependentsBySeed.set(entry.seedId, dependents)
    }
    if (!dependents.has(entry.entity.id)) {
      dependents.set(entry.entity.id, entry.entity)
    }
  }

  const gaps: ImpactGap[] = []
  for (const changed of changedEntities) {
    if (!CONTRACT_CHANGE_KINDS.has(changed.changeKind)) continue
    const directDependents = Array.from(directDependentsBySeed.get(changed.entity.id)?.values() ?? [])
    if (directDependents.length === 0) continue
    const unresolved = directDependents.filter(dep => !changedEntityIds.has(dep.id))
    if (unresolved.length === 0) continue

    gaps.push({
      seed: changed.entity,
      seedChangeKind: changesByEntityId.get(changed.entity.id)?.changeKind ?? changed.changeKind,
      directDependents,
      unresolvedDependents: unresolved,
    })
  }

  gaps.sort((a, b) => b.unresolvedDependents.length - a.unresolvedDependents.length || a.seed.id.localeCompare(b.seed.id))
  return gaps
}
