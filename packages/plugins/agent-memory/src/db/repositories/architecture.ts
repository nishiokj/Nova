import type { RepositoryContext } from './types.js'
import { generateCanonicalId } from '../../ids.js'

export type ArchitectureRunStatus = 'running' | 'success' | 'failed'
export type ArchitectureAlertSeverity = 'low' | 'medium' | 'high' | 'critical'
export type ArchitectureAlertStatus = 'open' | 'acknowledged' | 'resolved'

export interface ArchitectureRunRecord {
  id: string
  startedAt: string
  completedAt: string | null
  status: ArchitectureRunStatus
  lookbackDays: number
  configHash: string
  graphHash: string | null
  error: string | null
  stats: Record<string, unknown>
}

export interface ArchitectureConcernRecord {
  runId: string
  concernId: string
  label: string
  confidence: number
  sizeFiles: number
  internalWeight: number
  externalWeight: number
  cohesion: number
  stability: number
  volatility: number
  signalDensity: number
  metadata: Record<string, unknown>
}

export interface ArchitectureConcernFileRecord {
  runId: string
  concernId: string
  filePath: string
  membershipScore: number
  isCore: boolean
}

export interface ArchitectureBoundaryRecord {
  runId: string
  leftConcernId: string
  rightConcernId: string
  crossWeight: number
  internalLeft: number
  internalRight: number
  pressure: number
  pressureNorm: number
  hardness: number
  interfaceRatio: number
  directBypassRatio: number
  directionalLeftToRight: number
  directionalRightToLeft: number
  symmetryRatio: number
  topCrossFiles: unknown[]
}

export interface ArchitectureAlertRecord {
  id: string
  runId: string
  alertType: string
  severity: ArchitectureAlertSeverity
  status: ArchitectureAlertStatus
  concernId: string | null
  leftConcernId: string | null
  rightConcernId: string | null
  filePath: string | null
  score: number
  threshold: number
  title: string
  description: string
  evidence: Record<string, unknown>
  note: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface ArchitectureConcernDetail extends ArchitectureConcernRecord {
  files: ArchitectureConcernFileRecord[]
  topBoundaries: ArchitectureBoundaryRecord[]
}

export interface ArchitectureRunInput {
  id?: string
  startedAt?: Date
  lookbackDays: number
  configHash: string
}

export interface ArchitectureRunSuccessInput {
  graphHash: string
  stats: Record<string, unknown>
}

export interface ArchitectureDataInput {
  concerns: ArchitectureConcernRecord[]
  concernFiles: ArchitectureConcernFileRecord[]
  boundaries: ArchitectureBoundaryRecord[]
  alerts: Omit<ArchitectureAlertRecord, 'id' | 'createdAt' | 'resolvedAt'>[]
}

interface ArchitectureRunRow {
  id: string
  started_at: Date
  completed_at: Date | null
  status: ArchitectureRunStatus
  lookback_days: number
  config_hash: string
  graph_hash: string | null
  error: string | null
  stats: Record<string, unknown> | null
}

interface ArchitectureConcernRow {
  run_id: string
  concern_id: string
  label: string
  confidence: number
  size_files: number
  internal_weight: number
  external_weight: number
  cohesion: number
  stability: number
  volatility: number
  signal_density: number
  metadata: Record<string, unknown> | null
}

interface ArchitectureConcernFileRow {
  run_id: string
  concern_id: string
  file_path: string
  membership_score: number
  is_core: boolean
}

interface ArchitectureBoundaryRow {
  run_id: string
  left_concern_id: string
  right_concern_id: string
  cross_weight: number
  internal_left: number
  internal_right: number
  pressure: number
  pressure_norm: number
  hardness: number
  interface_ratio: number
  direct_bypass_ratio: number
  directional_left_to_right: number
  directional_right_to_left: number
  symmetry_ratio: number
  top_cross_files: unknown[] | null
}

interface ArchitectureAlertRow {
  id: string
  run_id: string
  alert_type: string
  severity: ArchitectureAlertSeverity
  status: ArchitectureAlertStatus
  concern_id: string | null
  left_concern_id: string | null
  right_concern_id: string | null
  file_path: string | null
  score: number
  threshold: number
  title: string
  description: string
  evidence: Record<string, unknown> | null
  note: string | null
  created_at: Date
  resolved_at: Date | null
}

function rowToRun(row: ArchitectureRunRow): ArchitectureRunRecord {
  return {
    id: row.id,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    status: row.status,
    lookbackDays: row.lookback_days,
    configHash: row.config_hash,
    graphHash: row.graph_hash,
    error: row.error,
    stats: row.stats ?? {},
  }
}

function rowToConcern(row: ArchitectureConcernRow): ArchitectureConcernRecord {
  return {
    runId: row.run_id,
    concernId: row.concern_id,
    label: row.label,
    confidence: row.confidence,
    sizeFiles: row.size_files,
    internalWeight: row.internal_weight,
    externalWeight: row.external_weight,
    cohesion: row.cohesion,
    stability: row.stability,
    volatility: row.volatility,
    signalDensity: row.signal_density,
    metadata: row.metadata ?? {},
  }
}

function rowToConcernFile(row: ArchitectureConcernFileRow): ArchitectureConcernFileRecord {
  return {
    runId: row.run_id,
    concernId: row.concern_id,
    filePath: row.file_path,
    membershipScore: row.membership_score,
    isCore: row.is_core,
  }
}

function rowToBoundary(row: ArchitectureBoundaryRow): ArchitectureBoundaryRecord {
  return {
    runId: row.run_id,
    leftConcernId: row.left_concern_id,
    rightConcernId: row.right_concern_id,
    crossWeight: row.cross_weight,
    internalLeft: row.internal_left,
    internalRight: row.internal_right,
    pressure: row.pressure,
    pressureNorm: row.pressure_norm,
    hardness: row.hardness,
    interfaceRatio: row.interface_ratio,
    directBypassRatio: row.direct_bypass_ratio,
    directionalLeftToRight: row.directional_left_to_right,
    directionalRightToLeft: row.directional_right_to_left,
    symmetryRatio: row.symmetry_ratio,
    topCrossFiles: row.top_cross_files ?? [],
  }
}

function rowToAlert(row: ArchitectureAlertRow): ArchitectureAlertRecord {
  return {
    id: row.id,
    runId: row.run_id,
    alertType: row.alert_type,
    severity: row.severity,
    status: row.status,
    concernId: row.concern_id,
    leftConcernId: row.left_concern_id,
    rightConcernId: row.right_concern_id,
    filePath: row.file_path,
    score: row.score,
    threshold: row.threshold,
    title: row.title,
    description: row.description,
    evidence: row.evidence ?? {},
    note: row.note,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  }
}

export interface ArchitectureConcernsQuery {
  runId: string
  minConfidence?: number
  limit?: number
}

export interface ArchitectureBoundariesQuery {
  runId: string
  minPressure?: number
  maxHardness?: number
  limit?: number
}

export interface ArchitectureAlertsQuery {
  runId?: string
  status?: ArchitectureAlertStatus
  severity?: ArchitectureAlertSeverity
  type?: string
  limit?: number
}

export interface ArchitectureRepository {
  createRun(input: ArchitectureRunInput): Promise<ArchitectureRunRecord>
  markRunSuccess(runId: string, input: ArchitectureRunSuccessInput): Promise<void>
  markRunFailed(runId: string, error: string): Promise<void>
  replaceRunData(runId: string, input: ArchitectureDataInput): Promise<void>

  findRunById(runId: string): Promise<ArchitectureRunRecord | null>
  findLatestSuccessfulRunId(): Promise<string | null>
  findLatestSuccessfulRunExcluding(runId: string): Promise<ArchitectureRunRecord | null>
  listRuns(limit?: number, status?: ArchitectureRunStatus): Promise<ArchitectureRunRecord[]>

  listConcerns(query: ArchitectureConcernsQuery): Promise<ArchitectureConcernRecord[]>
  getConcernDetail(runId: string, concernId: string): Promise<ArchitectureConcernDetail | null>
  listBoundaries(query: ArchitectureBoundariesQuery): Promise<ArchitectureBoundaryRecord[]>
  listAlerts(query?: ArchitectureAlertsQuery): Promise<ArchitectureAlertRecord[]>
  resolveAlert(alertId: string, note?: string): Promise<ArchitectureAlertRecord | null>

  getConcernFileSets(runId: string): Promise<Map<string, Set<string>>>
}

export function createArchitectureRepository(ctx: RepositoryContext): ArchitectureRepository {
  const { sql } = ctx

  return {
    async createRun(input) {
      const id = input.id ?? generateCanonicalId()
      const startedAt = input.startedAt ?? new Date()
      const [row] = await sql<ArchitectureRunRow[]>`
        INSERT INTO architecture_runs (
          id, started_at, status, lookback_days, config_hash, stats
        ) VALUES (
          ${id},
          ${startedAt},
          'running',
          ${input.lookbackDays},
          ${input.configHash},
          '{}'::jsonb
        )
        RETURNING *
      `
      return rowToRun(row)
    },

    async markRunSuccess(runId, input) {
      await sql`
        UPDATE architecture_runs
        SET
          status = 'success',
          completed_at = now(),
          graph_hash = ${input.graphHash},
          stats = ${sql.json(input.stats as any)}
        WHERE id = ${runId}
      `
    },

    async markRunFailed(runId, error) {
      await sql`
        UPDATE architecture_runs
        SET
          status = 'failed',
          completed_at = now(),
          error = ${error}
        WHERE id = ${runId}
      `
    },

    async replaceRunData(runId, input) {
      await sql`DELETE FROM architecture_concern_files WHERE run_id = ${runId}`
      await sql`DELETE FROM architecture_boundaries WHERE run_id = ${runId}`
      await sql`DELETE FROM architecture_alerts WHERE run_id = ${runId}`
      await sql`DELETE FROM architecture_concerns WHERE run_id = ${runId}`

      for (const concern of input.concerns) {
        await sql`
          INSERT INTO architecture_concerns (
            run_id, concern_id, label, confidence, size_files, internal_weight, external_weight,
            cohesion, stability, volatility, signal_density, metadata
          ) VALUES (
            ${runId},
            ${concern.concernId},
            ${concern.label},
            ${concern.confidence},
            ${concern.sizeFiles},
            ${concern.internalWeight},
            ${concern.externalWeight},
            ${concern.cohesion},
            ${concern.stability},
            ${concern.volatility},
            ${concern.signalDensity},
            ${sql.json(concern.metadata as any)}
          )
        `
      }

      for (const file of input.concernFiles) {
        await sql`
          INSERT INTO architecture_concern_files (
            run_id, concern_id, file_path, membership_score, is_core
          ) VALUES (
            ${runId},
            ${file.concernId},
            ${file.filePath},
            ${file.membershipScore},
            ${file.isCore}
          )
        `
      }

      for (const boundary of input.boundaries) {
        await sql`
          INSERT INTO architecture_boundaries (
            run_id, left_concern_id, right_concern_id, cross_weight, internal_left, internal_right,
            pressure, pressure_norm, hardness, interface_ratio, direct_bypass_ratio,
            directional_left_to_right, directional_right_to_left, symmetry_ratio, top_cross_files
          ) VALUES (
            ${runId},
            ${boundary.leftConcernId},
            ${boundary.rightConcernId},
            ${boundary.crossWeight},
            ${boundary.internalLeft},
            ${boundary.internalRight},
            ${boundary.pressure},
            ${boundary.pressureNorm},
            ${boundary.hardness},
            ${boundary.interfaceRatio},
            ${boundary.directBypassRatio},
            ${boundary.directionalLeftToRight},
            ${boundary.directionalRightToLeft},
            ${boundary.symmetryRatio},
            ${sql.json(boundary.topCrossFiles as any)}
          )
        `
      }

      for (const alert of input.alerts) {
        const alertId = generateCanonicalId()
        await sql`
          INSERT INTO architecture_alerts (
            id, run_id, alert_type, severity, status, concern_id, left_concern_id, right_concern_id,
            file_path, score, threshold, title, description, evidence, note
          ) VALUES (
            ${alertId},
            ${runId},
            ${alert.alertType},
            ${alert.severity},
            ${alert.status},
            ${alert.concernId},
            ${alert.leftConcernId},
            ${alert.rightConcernId},
            ${alert.filePath},
            ${alert.score},
            ${alert.threshold},
            ${alert.title},
            ${alert.description},
            ${sql.json(alert.evidence as any)},
            ${alert.note}
          )
        `
      }
    },

    async findRunById(runId) {
      const [row] = await sql<ArchitectureRunRow[]>`
        SELECT * FROM architecture_runs WHERE id = ${runId}
      `
      return row ? rowToRun(row) : null
    },

    async findLatestSuccessfulRunId() {
      const [row] = await sql<{ id: string }[]>`
        SELECT id
        FROM architecture_runs
        WHERE status = 'success'
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 1
      `
      return row?.id ?? null
    },

    async findLatestSuccessfulRunExcluding(runId) {
      const [row] = await sql<ArchitectureRunRow[]>`
        SELECT *
        FROM architecture_runs
        WHERE status = 'success' AND id != ${runId}
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 1
      `
      return row ? rowToRun(row) : null
    },

    async listRuns(limit = 20, status) {
      const rows = await sql<ArchitectureRunRow[]>`
        SELECT *
        FROM architecture_runs
        WHERE TRUE
          ${status ? sql`AND status = ${status}` : sql``}
        ORDER BY started_at DESC
        LIMIT ${limit}
      `
      return rows.map(rowToRun)
    },

    async listConcerns(query) {
      const rows = await sql<ArchitectureConcernRow[]>`
        SELECT *
        FROM architecture_concerns
        WHERE run_id = ${query.runId}
          ${query.minConfidence !== undefined ? sql`AND confidence >= ${query.minConfidence}` : sql``}
        ORDER BY confidence DESC, concern_id ASC
        LIMIT ${query.limit ?? 200}
      `
      return rows.map(rowToConcern)
    },

    async getConcernDetail(runId, concernId) {
      const [concernRow] = await sql<ArchitectureConcernRow[]>`
        SELECT *
        FROM architecture_concerns
        WHERE run_id = ${runId}
          AND concern_id = ${concernId}
      `
      if (!concernRow) return null

      const fileRows = await sql<ArchitectureConcernFileRow[]>`
        SELECT *
        FROM architecture_concern_files
        WHERE run_id = ${runId}
          AND concern_id = ${concernId}
        ORDER BY membership_score DESC, file_path ASC
      `

      const boundaryRows = await sql<ArchitectureBoundaryRow[]>`
        SELECT *
        FROM architecture_boundaries
        WHERE run_id = ${runId}
          AND (left_concern_id = ${concernId} OR right_concern_id = ${concernId})
        ORDER BY pressure_norm DESC, hardness ASC
        LIMIT 20
      `

      return {
        ...rowToConcern(concernRow),
        files: fileRows.map(rowToConcernFile),
        topBoundaries: boundaryRows.map(rowToBoundary),
      }
    },

    async listBoundaries(query) {
      const rows = await sql<ArchitectureBoundaryRow[]>`
        SELECT *
        FROM architecture_boundaries
        WHERE run_id = ${query.runId}
          ${query.minPressure !== undefined ? sql`AND pressure_norm >= ${query.minPressure}` : sql``}
          ${query.maxHardness !== undefined ? sql`AND hardness <= ${query.maxHardness}` : sql``}
        ORDER BY pressure_norm DESC, hardness ASC
        LIMIT ${query.limit ?? 200}
      `
      return rows.map(rowToBoundary)
    },

    async listAlerts(query = {}) {
      const rows = await sql<ArchitectureAlertRow[]>`
        SELECT *
        FROM architecture_alerts
        WHERE TRUE
          ${query.runId ? sql`AND run_id = ${query.runId}` : sql``}
          ${query.status ? sql`AND status = ${query.status}` : sql``}
          ${query.severity ? sql`AND severity = ${query.severity}` : sql``}
          ${query.type ? sql`AND alert_type = ${query.type}` : sql``}
        ORDER BY created_at DESC
        LIMIT ${query.limit ?? 200}
      `
      return rows.map(rowToAlert)
    },

    async resolveAlert(alertId, note) {
      const [row] = await sql<ArchitectureAlertRow[]>`
        UPDATE architecture_alerts
        SET status = 'resolved',
            note = ${note ?? null},
            resolved_at = now()
        WHERE id = ${alertId}
          AND status != 'resolved'
        RETURNING *
      `
      return row ? rowToAlert(row) : null
    },

    async getConcernFileSets(runId) {
      const rows = await sql<{ concern_id: string; file_path: string }[]>`
        SELECT concern_id, file_path
        FROM architecture_concern_files
        WHERE run_id = ${runId}
      `
      const byConcern = new Map<string, Set<string>>()
      for (const row of rows) {
        if (!byConcern.has(row.concern_id)) {
          byConcern.set(row.concern_id, new Set())
        }
        byConcern.get(row.concern_id)?.add(row.file_path)
      }
      return byConcern
    },
  }
}
