import { createHash } from 'node:crypto'
import type { Sql } from 'postgres'
import { stableStringify } from '../stable-stringify.js'
import { createArchitectureRepository } from '../db/repositories/architecture.js'
import { discoverConcerns } from './cluster.js'
import { buildFileGraph } from './file-graph.js'
import { computeConcernFileScores, computeMetrics } from './metrics.js'
import { DEFAULT_ARCHITECTURE_CONFIG, type ArchitectureConfig, type ConcernAssignment } from './types.js'

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1
  let intersection = 0
  for (const item of left) {
    if (right.has(item)) intersection += 1
  }
  const union = left.size + right.size - intersection
  return union <= 0 ? 0 : intersection / union
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}

function canonicalConcernOrder(concernFiles: Map<string, Set<string>>): string[] {
  return [...concernFiles.entries()]
    .map(([id, files]) => ({ id, size: files.size }))
    .sort((a, b) => {
      if (b.size !== a.size) return b.size - a.size
      return a.id.localeCompare(b.id)
    })
    .map((entry) => entry.id)
}

function renameConcerns(
  assignment: ConcernAssignment,
  renameMap: Map<string, string>
): ConcernAssignment {
  const byFile = new Map<string, string>()
  const concernFiles = new Map<string, Set<string>>()
  for (const [filePath, oldConcernId] of assignment.byFile.entries()) {
    const newConcernId = renameMap.get(oldConcernId) ?? oldConcernId
    byFile.set(filePath, newConcernId)
    if (!concernFiles.has(newConcernId)) concernFiles.set(newConcernId, new Set())
    concernFiles.get(newConcernId)?.add(filePath)
  }
  return { byFile, concernFiles }
}

function makeProvisionalConcernIds(
  assignment: ConcernAssignment,
  fileScoresByConcern: Map<string, Array<{ filePath: string; membershipScore: number; isCore: boolean }>>
): Map<string, string> {
  const output = new Map<string, string>()
  const seen = new Map<string, number>()

  for (const concernId of canonicalConcernOrder(assignment.concernFiles)) {
    const files = assignment.concernFiles.get(concernId) ?? new Set<string>()
    const scores = fileScoresByConcern.get(concernId) ?? []
    const coreFiles = scores
      .filter((score) => score.isCore)
      .map((score) => score.filePath)
      .sort()
      .slice(0, 5)

    const fallback = [...files].sort().slice(0, 5)
    const material = (coreFiles.length > 0 ? coreFiles : fallback).join('|')
    const baseId = `concern.${sha1(material).slice(0, 12)}`
    const count = (seen.get(baseId) ?? 0) + 1
    seen.set(baseId, count)
    output.set(concernId, count > 1 ? `${baseId}.${count}` : baseId)
  }

  return output
}

function chooseConcernIdsFromHistory(
  assignment: ConcernAssignment,
  provisional: Map<string, string>,
  previousConcernFiles: Map<string, Set<string>>
): { renameMap: Map<string, string>; previousByFinalId: Map<string, Set<string>> } {
  const renameMap = new Map<string, string>()
  const previousByFinalId = new Map<string, Set<string>>()
  const usedPrevious = new Set<string>()
  const takenFinalIds = new Set<string>()

  const orderedCurrent = canonicalConcernOrder(assignment.concernFiles)
  for (const currentConcernId of orderedCurrent) {
    const currentFiles = assignment.concernFiles.get(currentConcernId) ?? new Set<string>()
    let bestPrevious: string | null = null
    let bestOverlap = 0

    for (const [previousConcernId, previousFiles] of previousConcernFiles.entries()) {
      if (usedPrevious.has(previousConcernId)) continue
      const overlap = jaccard(currentFiles, previousFiles)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestPrevious = previousConcernId
      } else if (overlap === bestOverlap && bestPrevious && previousConcernId < bestPrevious) {
        bestPrevious = previousConcernId
      }
    }

    let finalId = provisional.get(currentConcernId) ?? currentConcernId
    if (bestPrevious && bestOverlap >= 0.60) {
      finalId = bestPrevious
      usedPrevious.add(bestPrevious)
      previousByFinalId.set(finalId, previousConcernFiles.get(bestPrevious) ?? new Set())
    }

    if (takenFinalIds.has(finalId)) {
      let index = 2
      let candidate = `${finalId}.${index}`
      while (takenFinalIds.has(candidate)) {
        index += 1
        candidate = `${finalId}.${index}`
      }
      finalId = candidate
    }

    takenFinalIds.add(finalId)
    renameMap.set(currentConcernId, finalId)
  }

  return { renameMap, previousByFinalId }
}

function commonPrefixLabel(files: Set<string>): string | null {
  const paths = [...files].sort()
  if (paths.length === 0) return null
  const split = paths.map((path) => path.split('/').filter(Boolean))
  const maxParts = Math.min(...split.map((parts) => parts.length))
  const prefix: string[] = []

  for (let i = 0; i < maxParts; i++) {
    const candidate = split[0][i]
    if (split.every((parts) => parts[i] === candidate)) {
      prefix.push(candidate)
      if (prefix.length >= 2) break
    } else {
      break
    }
  }

  if (prefix.length === 0) return null
  return prefix.join('_')
}

function sanitizeLabel(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized.length > 0 ? normalized : 'concern'
}

function labelTokenSet(label: string): Set<string> {
  return new Set(label.split('_').filter((token) => token.length > 0))
}

function tokenJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1
  let intersection = 0
  for (const token of left) {
    if (right.has(token)) intersection += 1
  }
  const union = left.size + right.size - intersection
  return union > 0 ? intersection / union : 0
}

function deriveLabels(
  assignment: ConcernAssignment,
  termVectors: Map<string, { filePath: string; vector: Map<string, number> }>
): Map<string, string> {
  const labels = new Map<string, string>()
  const usedLabelTokens: Array<Set<string>> = []
  const usedLabels = new Set<string>()

  for (const concernId of canonicalConcernOrder(assignment.concernFiles)) {
    const files = assignment.concernFiles.get(concernId) ?? new Set<string>()
    const termScores = new Map<string, number>()
    for (const filePath of files) {
      const vector = termVectors.get(filePath)?.vector
      if (!vector) continue
      for (const [term, weight] of vector.entries()) {
        termScores.set(term, (termScores.get(term) ?? 0) + weight)
      }
    }

    const topTerms = [...termScores.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1]
        return a[0].localeCompare(b[0])
      })
      .slice(0, 8)
      .map(([term]) => term)

    const candidates: string[] = []
    const prefix = commonPrefixLabel(files)
    if (prefix) candidates.push(prefix)
    if (topTerms.length >= 2) {
      candidates.push(`${topTerms[0]}_${topTerms[1]}`)
    }
    for (const term of topTerms) {
      candidates.push(term)
    }

    let selected: string | null = null
    for (const candidate of candidates) {
      const normalized = sanitizeLabel(candidate)
      if (usedLabels.has(normalized)) continue
      const tokens = labelTokenSet(normalized)
      const overlaps = usedLabelTokens.some((usedTokens) => tokenJaccard(tokens, usedTokens) > 0.5)
      if (overlaps) continue
      selected = normalized
      usedLabels.add(normalized)
      usedLabelTokens.push(tokens)
      break
    }

    if (!selected) {
      selected = `concern_${concernId.slice(-6)}`
      usedLabels.add(selected)
      usedLabelTokens.push(labelTokenSet(selected))
    }

    labels.set(concernId, selected)
  }

  return labels
}

export interface ArchitectureRunResult {
  runId: string
  concernCount: number
  boundaryCount: number
  alertCount: number
  graphHash: string
  stats: Record<string, unknown>
}

export interface ArchitectureLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

export async function runArchitectureDerivation(
  sql: Sql,
  partialConfig: Partial<ArchitectureConfig> = {},
  logger?: ArchitectureLogger
): Promise<ArchitectureRunResult> {
  const config: ArchitectureConfig = {
    ...DEFAULT_ARCHITECTURE_CONFIG,
    ...partialConfig,
  }

  const configHash = sha1(stableStringify(config))
  const architectureRepo = createArchitectureRepository({ sql })
  const run = await architectureRepo.createRun({
    lookbackDays: config.lookbackDays,
    configHash,
  })

  try {
    logger?.info('architecture:build-file-graph', { runId: run.id, lookbackDays: config.lookbackDays })
    const fileGraph = await buildFileGraph(sql, config)

    logger?.info('architecture:cluster-concerns', { runId: run.id, edges: fileGraph.edges.length })
    const initialAssignment = discoverConcerns(fileGraph.files, fileGraph.edges, config.strongEdgeWeight)
    const initialScores = computeConcernFileScores(initialAssignment, fileGraph.edges)
    const provisional = makeProvisionalConcernIds(initialAssignment, initialScores)

    const previousRun = await architectureRepo.findLatestSuccessfulRunExcluding(run.id)
    const previousConcernFiles = previousRun
      ? await architectureRepo.getConcernFileSets(previousRun.id)
      : new Map<string, Set<string>>()

    const { renameMap, previousByFinalId } = chooseConcernIdsFromHistory(
      initialAssignment,
      provisional,
      previousConcernFiles
    )
    const assignment = renameConcerns(initialAssignment, renameMap)

    const labels = deriveLabels(assignment, fileGraph.termVectors)
    const metrics = computeMetrics({
      assignment,
      edges: fileGraph.edges,
      directedStaticEdges: fileGraph.directedStaticEdges,
      interfaceLikeFiles: fileGraph.interfaceLikeFiles,
      concernLabels: labels,
      previousConcernFilesById: previousByFinalId,
    })

    const enrichedConcerns = metrics.concerns.map((concern) => {
      const sourceConcernId = [...renameMap.entries()].find(([, finalId]) => finalId === concern.concernId)?.[0]
      return {
        ...concern,
        metadata: {
          ...concern.metadata,
          sourceConcernId: sourceConcernId ?? concern.concernId,
          previousRunId: previousRun?.id ?? null,
          fileCount: concern.sizeFiles,
        },
      }
    })

    await architectureRepo.replaceRunData(run.id, {
      concerns: enrichedConcerns.map((concern) => ({
        ...concern,
        runId: run.id,
      })),
      concernFiles: metrics.concernFiles.map((row) => ({
        runId: run.id,
        concernId: row.concernId,
        filePath: row.filePath,
        membershipScore: row.membershipScore,
        isCore: row.isCore,
      })),
      boundaries: metrics.boundaries.map((boundary) => ({
        runId: run.id,
        ...boundary,
      })),
      alerts: [],
    })

    const singletonConcerns = [...assignment.concernFiles.values()].filter((files) => files.size === 1).length
    const stats = {
      files: fileGraph.stats.filesConsidered,
      entities: fileGraph.stats.entityCount,
      candidatePairs: fileGraph.stats.candidatePairs,
      edges: fileGraph.stats.keptEdges,
      sparseThresholdEdges: fileGraph.stats.sparseThresholdEdges,
      sparseTopKOnlyEdges: fileGraph.stats.sparseTopKOnlyEdges,
      skippedLargeChangeGroups: fileGraph.stats.skippedLargeChangeGroups,
      skippedLargeTouchGroups: fileGraph.stats.skippedLargeTouchGroups,
      concerns: enrichedConcerns.length,
      singletonConcerns,
      boundaries: metrics.boundaries.length,
      alerts: 0,
    }

    await architectureRepo.markRunSuccess(run.id, {
      graphHash: fileGraph.graphHash,
      stats,
    })

    logger?.info('architecture:run-success', {
      runId: run.id,
      concerns: enrichedConcerns.length,
      boundaries: metrics.boundaries.length,
    })

    return {
      runId: run.id,
      concernCount: enrichedConcerns.length,
      boundaryCount: metrics.boundaries.length,
      alertCount: 0,
      graphHash: fileGraph.graphHash,
      stats,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await architectureRepo.markRunFailed(run.id, message)
    logger?.error('architecture:run-failed', { runId: run.id, error: message })
    throw error
  }
}
