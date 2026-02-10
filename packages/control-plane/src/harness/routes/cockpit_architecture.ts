import nodePath from 'path';
import type { SessionFile } from '../entity_subgraph.js';

export type ArchitectureAlertSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ArchitectureAlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface CockpitArchitectureTouchedSummary {
  totalFiles: number;
  readFiles: number;
  editedFiles: number;
}

export interface CockpitArchitectureConcernSummary {
  concernId: string;
  label: string;
  activeScore: number;
  touchedFiles: number;
  editedFiles: number;
  readFiles: number;
  totalFiles: number;
  touchRatio: number;
}

export interface CockpitArchitectureBoundarySummary {
  leftConcernId: string;
  rightConcernId: string;
  leftLabel: string;
  rightLabel: string;
  crossWeight: number;
  pressureNorm: number;
  hardness: number;
  interfaceRatio: number;
  directBypassRatio: number;
  symmetryRatio: number;
  topCrossFiles: unknown[];
}

export interface CockpitArchitectureAlertSummary {
  id: string;
  alertType: string;
  severity: ArchitectureAlertSeverity;
  status: ArchitectureAlertStatus;
  concernId: string | null;
  leftConcernId: string | null;
  rightConcernId: string | null;
  filePath: string | null;
  score: number;
  threshold: number;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface CockpitArchitectureOverview {
  runId: string | null;
  generatedAt: string;
  touched: CockpitArchitectureTouchedSummary;
  concerns: CockpitArchitectureConcernSummary[];
  boundaries: CockpitArchitectureBoundarySummary[];
  alerts: CockpitArchitectureAlertSummary[];
}

export interface SessionArchitectureContext {
  touchedFiles: Map<string, 'read' | 'edited'>;
  summary: CockpitArchitectureTouchedSummary;
}

interface ConcernMappingRow {
  file_path: string;
  concern_id: string;
  label: string;
  size_files: number;
}

interface BoundaryRow {
  left_concern_id: string;
  right_concern_id: string;
  left_label: string;
  right_label: string;
  cross_weight: number;
  pressure_norm: number;
  hardness: number;
  interface_ratio: number;
  direct_bypass_ratio: number;
  symmetry_ratio: number;
  top_cross_files: unknown[] | null;
}

interface AlertRow {
  id: string;
  alert_type: string;
  severity: ArchitectureAlertSeverity;
  status: ArchitectureAlertStatus;
  concern_id: string | null;
  left_concern_id: string | null;
  right_concern_id: string | null;
  file_path: string | null;
  score: number;
  threshold: number;
  title: string;
  description: string;
  evidence: Record<string, unknown> | null;
  created_at: Date;
}

function clampInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeFilePath(pathValue: string, workingDir: string): string | null {
  const trimmed = pathValue.trim();
  if (!trimmed) return null;

  const normalized = nodePath.normalize(trimmed).replace(/\\/g, '/');
  if (nodePath.isAbsolute(trimmed)) {
    const relative = nodePath.relative(workingDir, trimmed).replace(/\\/g, '/');
    if (relative && !relative.startsWith('../') && relative !== '..' && !nodePath.isAbsolute(relative)) {
      return relative;
    }
    return normalized;
  }

  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

export function buildSessionArchitectureContext(
  sessionFiles: SessionFile[],
  workingDir: string
): SessionArchitectureContext {
  const touchedFiles = new Map<string, 'read' | 'edited'>();

  for (const entry of sessionFiles) {
    const normalized = normalizeFilePath(entry.filepath, workingDir);
    if (!normalized) continue;
    const previous = touchedFiles.get(normalized);
    if (!previous || (previous === 'read' && entry.status === 'edited')) {
      touchedFiles.set(normalized, entry.status);
    }
  }

  let readFiles = 0;
  let editedFiles = 0;
  for (const status of touchedFiles.values()) {
    if (status === 'edited') editedFiles += 1;
    else readFiles += 1;
  }

  return {
    touchedFiles,
    summary: {
      totalFiles: touchedFiles.size,
      readFiles,
      editedFiles,
    },
  };
}

interface ConcernBucket {
  concernId: string;
  label: string;
  totalFiles: number;
  touchedFiles: number;
  editedFiles: number;
  readFiles: number;
  activeScore: number;
}

export function deriveActiveConcerns(
  mappings: ConcernMappingRow[],
  touchedFiles: Map<string, 'read' | 'edited'>,
  limit = 8
): CockpitArchitectureConcernSummary[] {
  const buckets = new Map<string, ConcernBucket>();

  for (const row of mappings) {
    const touch = touchedFiles.get(row.file_path);
    if (!touch) continue;
    const key = row.concern_id;
    const bucket = buckets.get(key) ?? {
      concernId: row.concern_id,
      label: row.label,
      totalFiles: row.size_files,
      touchedFiles: 0,
      editedFiles: 0,
      readFiles: 0,
      activeScore: 0,
    };

    bucket.touchedFiles += 1;
    if (touch === 'edited') {
      bucket.editedFiles += 1;
      bucket.activeScore += 2;
    } else {
      bucket.readFiles += 1;
      bucket.activeScore += 1;
    }
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .sort((a, b) => {
      if (b.activeScore !== a.activeScore) return b.activeScore - a.activeScore;
      if (b.editedFiles !== a.editedFiles) return b.editedFiles - a.editedFiles;
      if (b.touchedFiles !== a.touchedFiles) return b.touchedFiles - a.touchedFiles;
      return a.concernId.localeCompare(b.concernId);
    })
    .slice(0, clampInteger(limit, 8, 1, 40))
    .map((bucket) => ({
      concernId: bucket.concernId,
      label: bucket.label,
      activeScore: bucket.activeScore,
      touchedFiles: bucket.touchedFiles,
      editedFiles: bucket.editedFiles,
      readFiles: bucket.readFiles,
      totalFiles: bucket.totalFiles,
      touchRatio: bucket.totalFiles > 0
        ? Number((bucket.touchedFiles / bucket.totalFiles).toFixed(4))
        : 0,
    }));
}

function severityRank(severity: ArchitectureAlertSeverity): number {
  if (severity === 'critical') return 4;
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function rowToAlert(row: AlertRow): CockpitArchitectureAlertSummary {
  return {
    id: row.id,
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
    createdAt: row.created_at.toISOString(),
  };
}

function rowToBoundary(row: BoundaryRow): CockpitArchitectureBoundarySummary {
  return {
    leftConcernId: row.left_concern_id,
    rightConcernId: row.right_concern_id,
    leftLabel: row.left_label,
    rightLabel: row.right_label,
    crossWeight: row.cross_weight,
    pressureNorm: row.pressure_norm,
    hardness: row.hardness,
    interfaceRatio: row.interface_ratio,
    directBypassRatio: row.direct_bypass_ratio,
    symmetryRatio: row.symmetry_ratio,
    topCrossFiles: row.top_cross_files ?? [],
  };
}

async function findLatestRunId(sql: any, runId?: string): Promise<string | null> {
  if (runId) {
    const explicit = await sql<{ id: string }[]>`
      SELECT id
      FROM architecture_runs
      WHERE id = ${runId}
        AND status = 'success'
      LIMIT 1
    `;
    return explicit[0]?.id ?? null;
  }

  const latest = await sql<{ id: string }[]>`
    SELECT id
    FROM architecture_runs
    WHERE status = 'success'
    ORDER BY completed_at DESC NULLS LAST, started_at DESC
    LIMIT 1
  `;
  return latest[0]?.id ?? null;
}

async function loadConcernMappings(
  sql: any,
  runId: string,
  filePaths: string[]
): Promise<ConcernMappingRow[]> {
  if (filePaths.length === 0) return [];
  return sql<ConcernMappingRow[]>`
    SELECT
      cf.file_path,
      cf.concern_id,
      c.label,
      c.size_files
    FROM architecture_concern_files cf
    JOIN architecture_concerns c
      ON c.run_id = cf.run_id
      AND c.concern_id = cf.concern_id
    WHERE cf.run_id = ${runId}
      AND cf.file_path = ANY(${sql.array(filePaths)})
  `;
}

async function loadBoundariesForConcerns(
  sql: any,
  runId: string,
  concernIds: string[],
  limit: number
): Promise<CockpitArchitectureBoundarySummary[]> {
  if (concernIds.length === 0) return [];

  const rows = await sql<BoundaryRow[]>`
    SELECT
      b.left_concern_id,
      b.right_concern_id,
      b.cross_weight,
      b.pressure_norm,
      b.hardness,
      b.interface_ratio,
      b.direct_bypass_ratio,
      b.symmetry_ratio,
      b.top_cross_files,
      lc.label AS left_label,
      rc.label AS right_label
    FROM architecture_boundaries b
    JOIN architecture_concerns lc
      ON lc.run_id = b.run_id
      AND lc.concern_id = b.left_concern_id
    JOIN architecture_concerns rc
      ON rc.run_id = b.run_id
      AND rc.concern_id = b.right_concern_id
    WHERE b.run_id = ${runId}
      AND (
        b.left_concern_id = ANY(${sql.array(concernIds)})
        OR b.right_concern_id = ANY(${sql.array(concernIds)})
      )
    ORDER BY b.pressure_norm DESC, b.hardness ASC, b.cross_weight DESC
    LIMIT ${clampInteger(limit, 12, 1, 80)}
  `;

  return rows.map(rowToBoundary);
}

interface LoadAlertsInput {
  sql: any;
  runId: string;
  status?: ArchitectureAlertStatus;
  severity?: ArchitectureAlertSeverity;
  type?: string;
  limit?: number;
  activeConcernIds?: Set<string>;
  touchedFiles?: Set<string>;
}

export async function loadAlertsForRun(input: LoadAlertsInput): Promise<CockpitArchitectureAlertSummary[]> {
  const rows: AlertRow[] = await input.sql<AlertRow[]>`
    SELECT
      id,
      alert_type,
      severity,
      status,
      concern_id,
      left_concern_id,
      right_concern_id,
      file_path,
      score,
      threshold,
      title,
      description,
      evidence,
      created_at
    FROM architecture_alerts
    WHERE run_id = ${input.runId}
      ${input.status ? input.sql`AND status = ${input.status}` : input.sql``}
      ${input.severity ? input.sql`AND severity = ${input.severity}` : input.sql``}
      ${input.type ? input.sql`AND alert_type = ${input.type}` : input.sql``}
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 4
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        ELSE 1
      END DESC,
      score DESC,
      created_at DESC
    LIMIT ${Math.max(1, Math.min(input.limit ?? 200, 1000))}
  `;

  const concernIds = input.activeConcernIds;
  const touchedFiles = input.touchedFiles;
  const shouldFilter = (concernIds && concernIds.size > 0) || (touchedFiles && touchedFiles.size > 0);

  const filtered: AlertRow[] = shouldFilter
    ? rows.filter((row: AlertRow) => {
      if (row.concern_id && concernIds?.has(row.concern_id)) return true;
      if (row.left_concern_id && concernIds?.has(row.left_concern_id)) return true;
      if (row.right_concern_id && concernIds?.has(row.right_concern_id)) return true;
      if (row.file_path && touchedFiles?.has(row.file_path)) return true;
      return false;
    })
    : rows;

  return filtered
    .sort((a: AlertRow, b: AlertRow) => {
      const sevDiff = severityRank(b.severity) - severityRank(a.severity);
      if (sevDiff !== 0) return sevDiff;
      if (b.score !== a.score) return b.score - a.score;
      return b.created_at.getTime() - a.created_at.getTime();
    })
    .slice(0, Math.max(1, Math.min(input.limit ?? 20, 200)))
    .map(rowToAlert);
}

export async function loadCockpitArchitectureOverviewFromSql(input: {
  sql: any;
  workingDir: string;
  sessionFiles: SessionFile[];
  runId?: string;
  concernLimit?: number;
  boundaryLimit?: number;
  alertLimit?: number;
}): Promise<CockpitArchitectureOverview> {
  const runId = await findLatestRunId(input.sql, input.runId);
  const context = buildSessionArchitectureContext(input.sessionFiles, input.workingDir);
  const generatedAt = new Date().toISOString();

  if (!runId) {
    return {
      runId: null,
      generatedAt,
      touched: context.summary,
      concerns: [],
      boundaries: [],
      alerts: [],
    };
  }

  const touchedPaths = Array.from(context.touchedFiles.keys());
  const mappings = await loadConcernMappings(input.sql, runId, touchedPaths);
  const concerns = deriveActiveConcerns(mappings, context.touchedFiles, input.concernLimit ?? 8);
  const activeConcernIds = new Set(concerns.map((concern) => concern.concernId));
  const boundaries = await loadBoundariesForConcerns(
    input.sql,
    runId,
    Array.from(activeConcernIds),
    input.boundaryLimit ?? 12
  );
  const alerts = await loadAlertsForRun({
    sql: input.sql,
    runId,
    status: 'open',
    limit: input.alertLimit ?? 20,
    activeConcernIds,
    touchedFiles: new Set(touchedPaths),
  });

  return {
    runId,
    generatedAt,
    touched: context.summary,
    concerns,
    boundaries,
    alerts,
  };
}

export async function loadCockpitArchitectureAlertsFromSql(input: {
  sql: any;
  runId?: string;
  status?: ArchitectureAlertStatus;
  severity?: ArchitectureAlertSeverity;
  type?: string;
  limit?: number;
  sessionContext?: SessionArchitectureContext;
}): Promise<{ runId: string | null; alerts: CockpitArchitectureAlertSummary[] }> {
  const runId = await findLatestRunId(input.sql, input.runId);
  if (!runId) {
    return { runId: null, alerts: [] };
  }

  let activeConcernIds: Set<string> | undefined;
  if (input.sessionContext && input.sessionContext.touchedFiles.size > 0) {
    const touchedPaths = Array.from(input.sessionContext.touchedFiles.keys());
    const mappings = await loadConcernMappings(input.sql, runId, touchedPaths);
    activeConcernIds = new Set(mappings.map((row) => row.concern_id));
  }

  const alerts = await loadAlertsForRun({
    sql: input.sql,
    runId,
    status: input.status,
    severity: input.severity,
    type: input.type,
    limit: input.limit ?? 200,
    activeConcernIds,
    touchedFiles: input.sessionContext ? new Set(input.sessionContext.touchedFiles.keys()) : undefined,
  });

  return { runId, alerts };
}
