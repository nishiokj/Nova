import type { Sql } from 'postgres'
import type { ArchitectureAlertRecord, ArchitectureAlertSeverity } from '../db/repositories/architecture.js'
import type { ConcernAssignment, ConcernBoundary, ConcernMetrics, WeightedFileEdge } from './types.js'

const EPSILON = 1e-6

interface SuccessfulRunRow {
  id: string
  config_hash: string
  completed_at: Date | null
}

interface BoundaryHistoryRow {
  run_id: string
  interface_ratio: number
}

interface ConcernFileRow {
  concern_id: string
  file_path: string
}

interface TraceRow {
  id: string
  revision: string
  session_key: string | null
  created_at: Date
  trace: unknown
}

export interface ArchitectureAlertInput {
  sql: Sql
  runId: string
  configHash: string
  assignment: ConcernAssignment
  edges: WeightedFileEdge[]
  concerns: ConcernMetrics[]
  boundaries: ConcernBoundary[]
}

export type ArchitectureAlertDraft = Omit<ArchitectureAlertRecord, 'id' | 'createdAt' | 'resolvedAt'>

export function shouldTriggerLeakyBoundary(pressureNorm: number, hardness: number): boolean {
  return pressureNorm >= 0.65 && hardness <= 0.35
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))))
  return sorted[rank]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2
  }
  return sorted[middle]
}

function boundaryKey(leftConcernId: string, rightConcernId: string): string {
  return `${leftConcernId}\u0000${rightConcernId}`
}

function extractTraceFiles(trace: unknown): string[] {
  if (!trace || typeof trace !== 'object') return []
  const files = (trace as { files?: unknown }).files
  if (!Array.isArray(files)) return []
  const out: string[] = []
  for (const file of files) {
    if (!file || typeof file !== 'object') continue
    const path = (file as { path?: unknown }).path
    if (typeof path !== 'string' || path.length === 0) continue
    out.push(path.replace(/\\/g, '/'))
  }
  return out
}

interface ChangeSet {
  key: string
  at: Date
  files: Set<string>
}

async function loadRecentSuccessfulRuns(sql: Sql, limit = 60): Promise<SuccessfulRunRow[]> {
  return sql<SuccessfulRunRow[]>`
    SELECT id, config_hash, completed_at
    FROM architecture_runs
    WHERE status = 'success'
    ORDER BY completed_at DESC NULLS LAST
    LIMIT ${limit}
  `
}

async function loadBoundaryHistory(
  sql: Sql,
  leftConcernId: string,
  rightConcernId: string,
  sinceDays: number
): Promise<BoundaryHistoryRow[]> {
  return sql<BoundaryHistoryRow[]>`
    SELECT b.run_id, b.interface_ratio
    FROM architecture_boundaries b
    JOIN architecture_runs r ON r.id = b.run_id
    WHERE b.left_concern_id = ${leftConcernId}
      AND b.right_concern_id = ${rightConcernId}
      AND r.status = 'success'
      AND r.completed_at >= now() - make_interval(days => ${sinceDays})
    ORDER BY r.completed_at DESC NULLS LAST
  `
}

async function loadConcernFiles(sql: Sql, runId: string): Promise<Map<string, string>> {
  const rows = await sql<ConcernFileRow[]>`
    SELECT concern_id, file_path
    FROM architecture_concern_files
    WHERE run_id = ${runId}
  `
  const byFile = new Map<string, string>()
  for (const row of rows) {
    byFile.set(row.file_path, row.concern_id)
  }
  return byFile
}

function detectHubFileCandidates(
  assignment: ConcernAssignment,
  edges: WeightedFileEdge[]
): Array<{
  filePath: string
  crossDegreeWeight: number
  internalDegreeWeight: number
  bridgeRatio: number
  distinctBoundaryCount: number
}> {
  const stats = new Map<string, {
    crossDegreeWeight: number
    internalDegreeWeight: number
    externalConcerns: Set<string>
  }>()

  for (const filePath of assignment.byFile.keys()) {
    stats.set(filePath, {
      crossDegreeWeight: 0,
      internalDegreeWeight: 0,
      externalConcerns: new Set(),
    })
  }

  for (const edge of edges) {
    const leftConcern = assignment.byFile.get(edge.fileA)
    const rightConcern = assignment.byFile.get(edge.fileB)
    if (!leftConcern || !rightConcern) continue

    const leftStats = stats.get(edge.fileA)
    const rightStats = stats.get(edge.fileB)
    if (!leftStats || !rightStats) continue

    if (leftConcern === rightConcern) {
      leftStats.internalDegreeWeight += edge.weight
      rightStats.internalDegreeWeight += edge.weight
      continue
    }

    leftStats.crossDegreeWeight += edge.weight
    rightStats.crossDegreeWeight += edge.weight
    leftStats.externalConcerns.add(rightConcern)
    rightStats.externalConcerns.add(leftConcern)
  }

  return [...stats.entries()].map(([filePath, value]) => ({
    filePath,
    crossDegreeWeight: value.crossDegreeWeight,
    internalDegreeWeight: value.internalDegreeWeight,
    bridgeRatio: value.crossDegreeWeight / (value.internalDegreeWeight + EPSILON),
    distinctBoundaryCount: value.externalConcerns.size,
  }))
}

async function buildChangeSets(sql: Sql): Promise<ChangeSet[]> {
  const traceRows = await sql<TraceRow[]>`
    SELECT id, revision, session_key, created_at, trace
    FROM agent_traces
    WHERE created_at >= now() - interval '44 days'
  `

  const byKey = new Map<string, ChangeSet>()
  for (const row of traceRows) {
    let key = ''
    if (row.revision && !row.revision.startsWith('session:')) {
      key = `rev:${row.revision}`
    } else if (row.session_key) {
      key = `session:${row.session_key}`
    } else {
      key = `trace:${row.id}`
    }

    const existing = byKey.get(key) ?? {
      key,
      at: row.created_at,
      files: new Set<string>(),
    }
    if (row.created_at > existing.at) {
      existing.at = row.created_at
    }
    for (const filePath of extractTraceFiles(row.trace)) {
      existing.files.add(filePath)
    }
    byKey.set(key, existing)
  }

  return [...byKey.values()].sort((a, b) => a.at.getTime() - b.at.getTime())
}

export async function generatePhase2Alerts(input: ArchitectureAlertInput): Promise<ArchitectureAlertDraft[]> {
  const { sql, runId, configHash, assignment, edges, concerns, boundaries } = input
  const alerts: ArchitectureAlertDraft[] = []

  const recentRuns = await loadRecentSuccessfulRuns(sql, 60)
  const completedRunIds = recentRuns.map((row) => row.id)

  const currentCrossStatic = boundaries.map((boundary) => boundary.directionalLeftToRight + boundary.directionalRightToLeft)
  const crossStaticP75 = percentile(currentCrossStatic, 75)

  for (const boundary of boundaries) {
    const crossStaticWeight = boundary.directionalLeftToRight + boundary.directionalRightToLeft
    const key = boundaryKey(boundary.leftConcernId, boundary.rightConcernId)

    if (shouldTriggerLeakyBoundary(boundary.pressureNorm, boundary.hardness)) {
      let consecutive = 1
      for (const priorRunId of completedRunIds) {
        const rows = await sql<{ pressure_norm: number; hardness: number }[]>`
          SELECT pressure_norm, hardness
          FROM architecture_boundaries
          WHERE run_id = ${priorRunId}
            AND left_concern_id = ${boundary.leftConcernId}
            AND right_concern_id = ${boundary.rightConcernId}
          LIMIT 1
        `
        if (rows.length === 0) break
        if (shouldTriggerLeakyBoundary(rows[0].pressure_norm, rows[0].hardness)) {
          consecutive += 1
        } else {
          break
        }
      }

      if (consecutive >= 3) {
        const severity: ArchitectureAlertSeverity = boundary.pressureNorm >= 0.80 ? 'critical' : 'high'
        alerts.push({
          runId,
          alertType: 'leaky_boundary',
          severity,
          status: 'open',
          concernId: null,
          leftConcernId: boundary.leftConcernId,
          rightConcernId: boundary.rightConcernId,
          filePath: null,
          score: boundary.pressureNorm,
          threshold: 0.65,
          title: `Leaky boundary: ${boundary.leftConcernId} ↔ ${boundary.rightConcernId}`,
          description: 'Boundary pressure is high and hardness is low for consecutive runs.',
          evidence: {
            boundaryKey: key,
            pressureNorm: boundary.pressureNorm,
            hardness: boundary.hardness,
            consecutiveRuns: consecutive,
          },
          note: null,
        })
      }
    }

    if (
      boundary.directBypassRatio >= 0.70 &&
      crossStaticWeight >= crossStaticP75 &&
      crossStaticWeight > 0
    ) {
      const history = await loadBoundaryHistory(sql, boundary.leftConcernId, boundary.rightConcernId, 14)
      const priorRatios = history.map((row) => row.interface_ratio)
      const baselineMedian = median(priorRatios)
      if (priorRatios.length > 0 && (baselineMedian - boundary.interfaceRatio) >= 0.15) {
        alerts.push({
          runId,
          alertType: 'boundary_bypass',
          severity: 'high',
          status: 'open',
          concernId: null,
          leftConcernId: boundary.leftConcernId,
          rightConcernId: boundary.rightConcernId,
          filePath: null,
          score: boundary.directBypassRatio,
          threshold: 0.70,
          title: `Boundary bypass: ${boundary.leftConcernId} → ${boundary.rightConcernId}`,
          description: 'Cross-boundary flow increasingly bypasses interface-like files.',
          evidence: {
            boundaryKey: key,
            directBypassRatio: boundary.directBypassRatio,
            interfaceRatio: boundary.interfaceRatio,
            interfaceMedian14d: baselineMedian,
            crossStaticWeight,
            crossStaticP75,
          },
          note: null,
        })
      }
    }

    if (
      boundary.directionalLeftToRight >= 20 &&
      boundary.directionalRightToLeft >= 20 &&
      boundary.symmetryRatio >= 0.60
    ) {
      const severe = boundary.directionalLeftToRight >= 50 && boundary.directionalRightToLeft >= 50
      alerts.push({
        runId,
        alertType: 'architectural_cycle',
        severity: severe ? 'critical' : 'high',
        status: 'open',
        concernId: null,
        leftConcernId: boundary.leftConcernId,
        rightConcernId: boundary.rightConcernId,
        filePath: null,
        score: boundary.symmetryRatio,
        threshold: 0.60,
        title: `Cross-concern cycle: ${boundary.leftConcernId} ↔ ${boundary.rightConcernId}`,
        description: 'Strong bidirectional static coupling detected across concerns.',
        evidence: {
          boundaryKey: key,
          leftToRight: boundary.directionalLeftToRight,
          rightToLeft: boundary.directionalRightToLeft,
          symmetryRatio: boundary.symmetryRatio,
        },
        note: null,
      })
    }
  }

  const hubCandidates = detectHubFileCandidates(assignment, edges)
  const p99CrossDegree = percentile(hubCandidates.map((candidate) => candidate.crossDegreeWeight), 99)
  for (const candidate of hubCandidates) {
    if (candidate.crossDegreeWeight < p99CrossDegree) continue
    if (candidate.bridgeRatio < 2.5) continue
    if (candidate.distinctBoundaryCount < 3) continue
    alerts.push({
      runId,
      alertType: 'hub_file',
      severity: candidate.bridgeRatio >= 4 ? 'high' : 'medium',
      status: 'open',
      concernId: assignment.byFile.get(candidate.filePath) ?? null,
      leftConcernId: null,
      rightConcernId: null,
      filePath: candidate.filePath,
      score: candidate.bridgeRatio,
      threshold: 2.5,
      title: `Bridge hotspot: ${candidate.filePath}`,
      description: 'File is acting as a high-pressure bridge across multiple concern boundaries.',
      evidence: {
        crossDegreeWeight: candidate.crossDegreeWeight,
        internalDegreeWeight: candidate.internalDegreeWeight,
        bridgeRatio: candidate.bridgeRatio,
        distinctBoundaryCount: candidate.distinctBoundaryCount,
        p99CrossDegree,
      },
      note: null,
    })
  }

  const previousRun = recentRuns[0] ?? null
  if (previousRun && previousRun.config_hash === configHash) {
    const previousByFile = await loadConcernFiles(sql, previousRun.id)
    const currentByFile = assignment.byFile
    const sharedFiles = [...currentByFile.keys()].filter((filePath) => previousByFile.has(filePath))
    if (sharedFiles.length > 0) {
      const moved = sharedFiles.filter((filePath) => previousByFile.get(filePath) !== currentByFile.get(filePath)).length
      const reassignmentRate = moved / sharedFiles.length
      if (reassignmentRate > 0.12) {
        alerts.push({
          runId,
          alertType: 'concern_churn',
          severity: 'medium',
          status: 'open',
          concernId: null,
          leftConcernId: null,
          rightConcernId: null,
          filePath: null,
          score: reassignmentRate,
          threshold: 0.12,
          title: 'Concern assignment churn',
          description: 'Too many files were reassigned between concerns without a config change.',
          evidence: {
            previousRunId: previousRun.id,
            trackedFiles: sharedFiles.length,
            movedFiles: moved,
            fileReassignmentRate: reassignmentRate,
          },
          note: null,
        })
      }
    }
  }

  const concernByFile = assignment.byFile
  const concernSetById = new Map<string, Set<string>>()
  for (const [filePath, concernId] of concernByFile.entries()) {
    if (!concernSetById.has(concernId)) concernSetById.set(concernId, new Set())
    concernSetById.get(concernId)?.add(filePath)
  }

  const changeSets = await buildChangeSets(sql)
  const now = Date.now()
  const currentWindowMs = 14 * 24 * 60 * 60 * 1000
  const baselineWindowMs = 44 * 24 * 60 * 60 * 1000
  const currentStart = now - currentWindowMs
  const baselineStart = now - baselineWindowMs

  for (const concern of concerns) {
    const concernFiles = concernSetById.get(concern.concernId) ?? new Set<string>()
    const perSetExternalCounts: Array<{ at: number; external: number }> = []

    for (const changeSet of changeSets) {
      const at = changeSet.at.getTime()
      if (at < baselineStart) continue
      const touchedConcerns = new Set<string>()
      let touchesConcern = false
      for (const filePath of changeSet.files) {
        const fileConcern = concernByFile.get(filePath)
        if (!fileConcern) continue
        touchedConcerns.add(fileConcern)
        if (concernFiles.has(filePath)) {
          touchesConcern = true
        }
      }
      if (!touchesConcern) continue
      const external = [...touchedConcerns].filter((id) => id !== concern.concernId).length
      perSetExternalCounts.push({ at, external })
    }

    const currentValues = perSetExternalCounts
      .filter((entry) => entry.at >= currentStart)
      .map((entry) => entry.external)
    const baselineValues = perSetExternalCounts
      .filter((entry) => entry.at >= baselineStart && entry.at < currentStart)
      .map((entry) => entry.external)

    if (currentValues.length < 20 || baselineValues.length === 0) continue
    const currentAvg = currentValues.reduce((sum, value) => sum + value, 0) / currentValues.length
    const baselineAvg = baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length
    if (baselineAvg <= 0) continue

    const ratio = currentAvg / baselineAvg
    if (ratio >= 1.35) {
      alerts.push({
        runId,
        alertType: 'blast_radius_inflation',
        severity: ratio >= 1.75 ? 'high' : 'medium',
        status: 'open',
        concernId: concern.concernId,
        leftConcernId: null,
        rightConcernId: null,
        filePath: null,
        score: ratio,
        threshold: 1.35,
        title: `Blast-radius inflation: ${concern.label}`,
        description: 'Changes touching this concern are increasingly spilling across other concerns.',
        evidence: {
          concernId: concern.concernId,
          changeSetCount: currentValues.length,
          currentAvgExternalConcernCount: currentAvg,
          baselineAvgExternalConcernCount: baselineAvg,
          ratio,
        },
        note: null,
      })
    }
  }

  alerts.sort((a, b) => {
    const severityOrder: Record<ArchitectureAlertSeverity, number> = {
      low: 0,
      medium: 1,
      high: 2,
      critical: 3,
    }
    const sevDiff = severityOrder[b.severity] - severityOrder[a.severity]
    if (sevDiff !== 0) return sevDiff
    if (a.alertType !== b.alertType) return a.alertType.localeCompare(b.alertType)
    return (b.score - a.score)
  })

  return alerts
}

