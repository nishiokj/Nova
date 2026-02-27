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
import type { PRReview } from './types.js'

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
  const blastEntries = await entityBlastRadius(sql, seedIds, maxDepth)

  const direct = blastEntries.filter(e => e.depth === 1)
  const transitive = blastEntries.filter(e => e.depth > 1)

  const affectedFiles = new Set<string>()
  for (const e of blastEntries) affectedFiles.add(e.entity.filepath)

  // 4. Score risks
  const risks = scoreRisks(changedEntities, blastEntries)

  // 5. Detect newly-introduced dead code (unused exports in changed files)
  const addedFiles = fileChanges
    .filter(fc => fc.status === 'added' || fc.status === 'modified')
    .map(fc => fc.filepath)

  const deadCode = (
    await Promise.all(addedFiles.map(fp => unusedExports(sql, fp)))
  ).flat()

  // 6. Build summary
  const summary = buildSummary(changedEntities.length, direct.length, transitive.length, risks)

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
    deadCode,
  }
}

function buildSummary(
  changed: number,
  directCount: number,
  transitiveCount: number,
  risks: Array<{ score: number }>,
): string {
  const critical = risks.filter(r => r.score >= 70).length
  const warnings = risks.filter(r => r.score >= 40 && r.score < 70).length

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

  return parts.join('; ') + '.'
}
