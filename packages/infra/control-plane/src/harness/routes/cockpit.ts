/**
 * Cockpit dashboard route handlers extracted from control_plane_routes.ts.
 *
 * Includes: rollups, focus panel, traces, diff, tests, repo lens,
 * preview, filesystem, architecture, session events/packets/permissions,
 * escalation resolution, templates, and session creation.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import nodePath from 'path';
import { getAllModels } from 'types';
import {
  type ControlPlaneContext,
  type SessionRow,
  type MessageRow,
  type SessionPanelStatus,
  type SessionKind,
  type SessionRollup,
  type EscalationRollup,
  type FocusPacket,
  type NormalizedSessionEvent,
  type TraceSummary,
  type TestReportSummary,
  type CommitRollup,
  type PRRollup,
  type RepoLensMatch,
  type TestReportRecord,
  type CockpitDailyMetricsResult,
  type CockpitRollupSnapshotResult,
  type SessionPermissionStateView,
  sendJson,
  readJsonBody,
  isRecord,
  asString,
  asNumber,
  asBoolean,
  parseTimestampMs,
  extractText,
  execFileText,
  escapeRegExp,
  clampInteger,
  cleanTitle,
  readNumberCandidate,
  readArrayLengthCandidate,
  mapSessionStatus,
  mapSessionKind,
  mapGateStatus,
  withAgentMemorySql,
  normalizeSessionPermissionState,
  parsePermissionSettingsText,
  readSessionPermissionSettingsFile,
  writeSessionPermissionSettingsFile,
  PACKET_REF_REGEX,
  COCKPIT_SNAPSHOT_CACHE_TTL_MS,
  cockpitSnapshotCache,
  setCockpitSnapshotCache,
  SESSION_PERMISSION_SETTINGS_MAX_BYTES,
  parseAgentEventTokenTotalsForDay,
  parseSessionTokenMetrics,
} from './utils.js';
import { getAllSessions, getSession, groupSessionsByWorkingDir } from './sessions.js';
import {
  getSessionCommitEvents,
  findSessionCommitBySha,
  getLatestRevisionRange,
  buildSessionDiffFromEvents,
  buildSessionTraceSummaryFromEvents,
  buildSessionEventTraceRecords,
  isSyntheticSessionRevision,
  parseGitLogWithNumstat,
  loadSessionDiffstats,
  mapTestReportRow,
  getPRs,
  getGitRemote,
  resolveDiffRange,
  resolveRepoHeadRange,
  resolveWorkingTreeDiff,
  parseNumstatOutput,
} from './git.js';
import { buildCockpitFilesystemRoots, normalizeProjectPathInput } from './markdown.js';
import {
  parseSessionEscalations,
  type EscalationResolutionInput,
} from '../escalation_state.js';
import { extractSessionFiles, buildSubgraph, type SubgraphResponse } from '../entity_subgraph.js';
import {
  buildSessionArchitectureContext,
  loadCockpitArchitectureOverviewFromSql,
  loadCockpitArchitectureAlertsFromSql,
  type ArchitectureAlertSeverity,
  type ArchitectureAlertStatus,
} from './cockpit_architecture.js';

const cockpitSnapshotInFlight = new Map<string, Promise<CockpitRollupSnapshotResult>>();

// ── internal packet helpers ─────────────────────────────────────────

function parsePackets(value: unknown, defaultSessionKey?: string): FocusPacket[] {
  const rawPackets = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value]
      : [];
  if (rawPackets.length === 0) return [];
  const packets: FocusPacket[] = [];
  for (const [index, entry] of rawPackets.entries()) {
    if (!isRecord(entry)) continue;
    const createdMs = parseTimestampMs(entry.createdAt ?? entry.created_at ?? entry.timestamp ?? entry.at) ?? 0;
    const packetId = asString(entry.packetId)
      ?? asString(entry.packet_id)
      ?? asString(entry.id)
      ?? `packet-${createdMs}-${index + 1}`;
    const sessionKey = asString(entry.sessionKey) ?? asString(entry.session_key) ?? defaultSessionKey;
    const typeRaw = asString(entry.type) ?? asString(entry.packetType) ?? asString(entry.packet_type) ?? 'session';
    const markdown =
      asString(entry.contentMarkdown)
      ?? asString(entry.content_markdown)
      ?? asString(entry.markdown);
    if (!packetId || !sessionKey || !typeRaw || !markdown || !createdMs) continue;

    const type: FocusPacket['type'] = typeRaw === 'escalation'
      ? 'escalation'
      : typeRaw === 'review' || typeRaw === 'pr_review'
        ? 'review'
        : 'session';

    const evidenceIndex = Array.isArray(entry.evidenceIndex)
      ? entry.evidenceIndex
          .filter((item): item is { type: string; value: string } =>
            isRecord(item) && typeof item.type === 'string' && typeof item.value === 'string')
      : undefined;
    const validationWarnings = Array.isArray(entry.validationWarnings)
      ? entry.validationWarnings.filter((item): item is string => typeof item === 'string')
      : undefined;

    packets.push({
      packetId,
      sessionKey,
      workItemId: asString(entry.workItemId) ?? asString(entry.work_item_id),
      type,
      createdAt: new Date(createdMs).toISOString(),
      contentMarkdown: markdown,
      ...(evidenceIndex ? { evidenceIndex } : {}),
      ...(validationWarnings && validationWarnings.length > 0 ? { validationWarnings } : {}),
    });
  }
  return packets.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function parsePacketType(value: unknown): { type: FocusPacket['type']; error?: string } {
  const raw = asString(value);
  if (!raw) {
    return { type: 'session' };
  }
  const type = raw.toLowerCase();
  if (type === 'escalation' || type === 'review' || type === 'session') {
    return { type };
  }
  if (type === 'ready' || type === 'ready_review' || type === 'pr_review') {
    return { type: 'review' };
  }
  return { type: 'session', error: `Unsupported packet type "${raw}". Allowed: escalation, review, session.` };
}

function parseEvidenceIndex(value: unknown): Array<{ type: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value
    .filter((item): item is { type: string; value: string } =>
      isRecord(item) && typeof item.type === 'string' && typeof item.value === 'string'
    );
  return parsed.length > 0 ? parsed : undefined;
}

function inferEvidenceIndexFromMarkdown(markdown: string): Array<{ type: string; value: string }> {
  const inferred: Array<{ type: string; value: string }> = [];
  const seen = new Set<string>();
  const regex = new RegExp(PACKET_REF_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const type = match[1]?.trim();
    const value = match[2]?.trim();
    if (!type || !value) continue;
    const key = `${type.toLowerCase()}::${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inferred.push({ type, value });
  }
  return inferred;
}

function collectPacketValidationWarnings(
  packetType: FocusPacket['type'],
  evidenceIndex: Array<{ type: string; value: string }>
): string[] {
  const warnings: string[] = [];
  if ((packetType === 'escalation' || packetType === 'review') && evidenceIndex.length === 0) {
    warnings.push('No evidence references found; escalation/review packets should include @ref() pointers.');
  }
  return warnings;
}

function buildPacketId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `pkt_${Date.now().toString(36)}_${suffix}`;
}

function parseArchitectureAlertStatus(value: string | null): ArchitectureAlertStatus | undefined {
  if (!value) return undefined;
  if (value === 'open' || value === 'acknowledged' || value === 'resolved') {
    return value;
  }
  return undefined;
}

function parseArchitectureAlertSeverity(value: string | null): ArchitectureAlertSeverity | undefined {
  if (!value) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'critical') {
    return value;
  }
  return undefined;
}

async function loadPacketMarkdown(
  workingDir: string,
  body: Record<string, unknown>
): Promise<{ markdown?: string; sourcePath?: string; error?: string }> {
  const inlineMarkdown = asString(body.markdown) ?? asString(body.contentMarkdown);
  if (inlineMarkdown) {
    return { markdown: inlineMarkdown };
  }

  const rawPath = asString(body.markdownPath) ?? asString(body.path) ?? asString(body.filePath);
  if (!rawPath) {
    return { error: 'Missing packet content: provide markdown or markdownPath' };
  }

  const { readFile } = await import('fs/promises');
  const path = await import('path');

  const baseDir = path.resolve(workingDir);
  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(baseDir, rawPath);
  const inWorkingDir = resolvedPath === baseDir || resolvedPath.startsWith(`${baseDir}${path.sep}`);
  if (!inWorkingDir) {
    return { error: 'markdownPath must resolve inside the session working directory' };
  }

  try {
    const markdown = await readFile(resolvedPath, 'utf8');
    if (!markdown.trim()) {
      return { error: 'Packet markdown file is empty' };
    }
    if (Buffer.byteLength(markdown, 'utf8') > 1_000_000) {
      return { error: 'Packet markdown exceeds 1MB limit' };
    }
    return {
      markdown,
      sourcePath: path.relative(baseDir, resolvedPath),
    };
  } catch (error) {
    return { error: `Failed reading markdownPath: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── internal session/gate helpers ───────────────────────────────────

function hasReviewReadySignal(metadata: Record<string, unknown>): boolean {
  const direct = [
    metadata.readyForReview,
    metadata.ready_for_review,
    metadata.reviewReady,
    metadata.review_ready,
    metadata.awaitingReview,
    metadata.awaiting_review,
    metadata.workflowReady,
    metadata.workflow_ready,
  ];
  for (const candidate of direct) {
    if (asBoolean(candidate) === true) return true;
  }
  const workflowState = asString(metadata.workflow_state) ?? asString(metadata.workflowState);
  if (!workflowState) return false;
  const normalized = workflowState.toLowerCase();
  return normalized === 'review' || normalized === 'ready' || normalized === 'awaiting_review';
}

function hasWorkflowCompletionSignal(metadata: Record<string, unknown>): boolean {
  const direct = [
    metadata.workflow_complete,
    metadata.workflowComplete,
    metadata.workflow_completed,
    metadata.workflowCompleted,
    metadata.all_required_nodes_complete,
    metadata.allRequiredNodesComplete,
    metadata.review_node_reached,
    metadata.reviewNodeReached,
  ];
  for (const candidate of direct) {
    if (asBoolean(candidate) === true) return true;
  }

  const workflow = isRecord(metadata.workflow) ? metadata.workflow : undefined;
  const requiredNodes = readNumberCandidate([
    metadata.workflow_required_nodes,
    metadata.workflowRequiredNodes,
    metadata.required_nodes,
    metadata.requiredNodes,
    metadata.workflow_total_nodes,
    metadata.workflowTotalNodes,
    workflow?.required_nodes,
    workflow?.requiredNodes,
    workflow?.total_nodes,
    workflow?.totalNodes,
  ]) ?? readArrayLengthCandidate([
    metadata.workflow_required_node_ids,
    metadata.workflowRequiredNodeIds,
    metadata.required_node_ids,
    metadata.requiredNodeIds,
    workflow?.required_node_ids,
    workflow?.requiredNodeIds,
  ]);
  const completedNodes = readNumberCandidate([
    metadata.workflow_completed_nodes,
    metadata.workflowCompletedNodes,
    metadata.completed_nodes,
    metadata.completedNodes,
    workflow?.completed_nodes,
    workflow?.completedNodes,
  ]) ?? readArrayLengthCandidate([
    metadata.workflow_completed_node_ids,
    metadata.workflowCompletedNodeIds,
    metadata.completed_node_ids,
    metadata.completedNodeIds,
    workflow?.completed_node_ids,
    workflow?.completedNodeIds,
  ]);
  if (
    typeof requiredNodes === 'number'
    && requiredNodes > 0
    && typeof completedNodes === 'number'
    && completedNodes >= requiredNodes
  ) {
    return true;
  }

  const workflowState = asString(metadata.workflow_state)
    ?? asString(metadata.workflowState)
    ?? asString(workflow?.state);
  if (!workflowState) return false;
  const normalized = workflowState.toLowerCase();
  return (
    normalized === 'review'
    || normalized === 'ready'
    || normalized === 'awaiting_review'
    || normalized === 'complete'
    || normalized === 'completed'
    || normalized === 'terminal'
  );
}

function gateIsRequired(
  metadata: Record<string, unknown>,
  gate: 'tests' | 'invariants'
): boolean | undefined {
  const workflow = isRecord(metadata.workflow) ? metadata.workflow : undefined;
  const gatesRecord = isRecord(metadata.gates) ? metadata.gates : undefined;
  const gateRecord = isRecord(gatesRecord?.[gate]) ? gatesRecord?.[gate] as Record<string, unknown> : undefined;
  const requiredGates = Array.isArray(metadata.required_gates) ? metadata.required_gates : [];
  const gateListed = requiredGates.some((value) => asString(value)?.toLowerCase() === gate);

  const candidates = gate === 'tests'
    ? [
      metadata.tests_required,
      metadata.testsRequired,
      metadata.require_tests,
      metadata.requireTests,
      workflow?.tests_required,
      workflow?.testsRequired,
      gateRecord?.required,
      gateListed ? true : undefined,
    ]
    : [
      metadata.invariants_required,
      metadata.invariantsRequired,
      metadata.require_invariants,
      metadata.requireInvariants,
      workflow?.invariants_required,
      workflow?.invariantsRequired,
      gateRecord?.required,
      gateListed ? true : undefined,
    ];

  for (const candidate of candidates) {
    const parsed = asBoolean(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function gateStatusSatisfied(
  status: 'pass' | 'fail' | 'running' | 'unknown',
  required: boolean | undefined
): boolean {
  if (status === 'fail') return false;
  if (required === true) return status === 'pass';
  return true;
}

function deriveSessionPanelStatus(
  sessionStatus: string,
  metadata: Record<string, unknown>,
  unresolvedEscalationsCount: number,
  testsStatus: 'pass' | 'fail' | 'running' | 'unknown',
  invariantsStatus: 'pass' | 'fail' | 'running' | 'unknown'
): SessionPanelStatus {
  const base = mapSessionStatus(sessionStatus);
  if (base === 'done' || base === 'stopped') return base;

  const workflowReady = base === 'ready'
    || hasReviewReadySignal(metadata)
    || hasWorkflowCompletionSignal(metadata);
  const testsRequired = gateIsRequired(metadata, 'tests');
  const invariantsRequired = gateIsRequired(metadata, 'invariants');

  if (unresolvedEscalationsCount > 0) return 'blocked';
  if (!workflowReady) return 'running';
  if (!gateStatusSatisfied(testsStatus, testsRequired)) return 'running';
  if (!gateStatusSatisfied(invariantsStatus, invariantsRequired)) return 'running';

  return 'ready';
}

function classifyRequestedDecision(escalationType: string): EscalationRollup['requestedDecision'] {
  switch (escalationType) {
    case 'architectural':
      return 'choose';
    case 'permission':
      return 'permission';
    case 'review':
      return 'approve';
    case 'failure':
      return 'stop';
    case 'uncertainty':
    case 'resource':
    case 'conflict':
      return 'clarify';
    default:
      return 'unknown';
  }
}

// ── internal data loading ───────────────────────────────────────────

function getEscalations(session: SessionRow) {
  return parseSessionEscalations(session.metadata?.escalations);
}

function unresolvedEscalations(session: SessionRow) {
  return getEscalations(session).filter((escalation) =>
    escalation.status === 'pending' || escalation.status === 'acknowledged');
}

async function loadTraceRecords(
  workingDir: string,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  const { readdir, readFile, stat } = await import('fs/promises');
  const path = await import('path');
  const traceDir = path.join(workingDir, '.agent-trace');

  let files: string[] = [];
  try {
    files = await readdir(traceDir);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((file) => file.endsWith('.json'));
  const records: Array<{ trace: Record<string, unknown>; mtime: number }> = [];

  for (const file of jsonFiles.slice(0, Math.max(limit * 2, 100))) {
    try {
      const filePath = path.join(traceDir, file);
      const [content, stats] = await Promise.all([
        readFile(filePath, 'utf-8'),
        stat(filePath),
      ]);
      const trace = JSON.parse(content) as unknown;
      if (!isRecord(trace)) continue;
      records.push({ trace, mtime: stats.mtimeMs });
    } catch {
      // Skip invalid or partially-written trace files.
    }
  }

  return records
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((entry) => entry.trace);
}

function extractInvariantCounts(categories: unknown): {
  passed?: number;
  total?: number;
} {
  if (!Array.isArray(categories)) {
    return {};
  }

  let passed = 0;
  let total = 0;
  let sawInvariant = false;

  for (const category of categories) {
    if (!isRecord(category)) continue;
    const name = (asString(category.name) ?? asString(category.category) ?? asString(category.type) ?? '').toLowerCase();
    if (!name.includes('invariant')) continue;
    sawInvariant = true;
    const catPassed =
      asNumber(category.passed)
      ?? asNumber(category.pass_count)
      ?? asNumber(category.passed_count)
      ?? asNumber(category.passCount)
      ?? 0;
    const catFailed =
      asNumber(category.failed)
      ?? asNumber(category.fail_count)
      ?? asNumber(category.failed_count)
      ?? asNumber(category.failCount)
      ?? 0;
    const catTotal =
      asNumber(category.total)
      ?? asNumber(category.total_count)
      ?? asNumber(category.totalCount)
      ?? (catPassed + catFailed);

    passed += catPassed;
    total += catTotal;
  }

  if (!sawInvariant || total <= 0) {
    return {};
  }

  return { passed, total };
}

async function loadLatestTestReports(
  sessionKeys: string[]
): Promise<Map<string, TestReportSummary>> {
  const summaries = new Map<string, TestReportSummary>();
  if (sessionKeys.length === 0) return summaries;

  const rows = await withAgentMemorySql(async (sql) => {
    return sql`
      SELECT DISTINCT ON (session_key)
        session_key,
        verdict,
        created_at,
        categories
      FROM test_reports
      WHERE session_key = ANY(${sql.array(sessionKeys)})
      ORDER BY session_key, created_at DESC
    `;
  });

  if (!rows || !Array.isArray(rows)) {
    return summaries;
  }

  for (const row of rows as Array<Record<string, unknown>>) {
    const sessionKey = asString(row.session_key);
    const verdictRaw = asString(row.verdict);
    const createdAt = row.created_at;
    if (!sessionKey || !verdictRaw) continue;
    if (verdictRaw !== 'pass' && verdictRaw !== 'fail' && verdictRaw !== 'error' && verdictRaw !== 'skip') {
      continue;
    }
    const createdAtMs = createdAt instanceof Date
      ? createdAt.getTime()
      : parseTimestampMs(createdAt) ?? Date.now();
    const invariant = extractInvariantCounts(row.categories);
    summaries.set(sessionKey, {
      sessionKey,
      verdict: verdictRaw,
      createdAtMs,
      ...(typeof invariant.passed === 'number' ? { invariantsPassed: invariant.passed } : {}),
      ...(typeof invariant.total === 'number' ? { invariantsTotal: invariant.total } : {}),
    });
  }

  return summaries;
}

function buildTraceSummary(sessionKey: string, traces: Array<Record<string, unknown>>): TraceSummary {
  const sessionUrl = `session://${sessionKey}`;
  const files = new Set<string>();
  let latestTimestamp = 0;
  let latestFile: string | undefined;
  let latestLine: number | undefined;

  for (const trace of traces) {
    const traceTimestamp = parseTimestampMs(trace.timestamp) ?? 0;
    const traceFiles = Array.isArray(trace.files) ? trace.files : [];
    for (const fileEntry of traceFiles) {
      if (!isRecord(fileEntry)) continue;
      const filePath = asString(fileEntry.path);
      if (!filePath) continue;
      const conversations = Array.isArray(fileEntry.conversations) ? fileEntry.conversations : [];
      for (const conversation of conversations) {
        if (!isRecord(conversation)) continue;
        const url = asString(conversation.url);
        if (!url || (url !== sessionUrl && !url.endsWith(sessionKey))) continue;
        files.add(filePath);
        const ranges = Array.isArray(conversation.ranges) ? conversation.ranges : [];
        const line = ranges.length > 0 && isRecord(ranges[ranges.length - 1])
          ? asNumber((ranges[ranges.length - 1] as Record<string, unknown>).end_line)
          : undefined;
        if (traceTimestamp >= latestTimestamp) {
          latestTimestamp = traceTimestamp;
          latestFile = filePath;
          latestLine = line;
        }
      }
    }
  }

  return {
    filesTouched: files.size,
    ...(latestFile ? { lastFile: latestFile } : {}),
    ...(latestLine ? { lastLine: latestLine } : {}),
    ...(latestTimestamp > 0 ? { latestTimestampMs: latestTimestamp } : {}),
  };
}

function getLatestTool(metadata: Record<string, unknown> | undefined): string {
  const agentEvents = Array.isArray(metadata?.agent_events) ? metadata.agent_events : [];
  for (let i = agentEvents.length - 1; i >= 0; i--) {
    const event = agentEvents[i];
    if (!isRecord(event)) continue;
    const type = asString(event.type);
    if (type !== 'tool_call') continue;
    const data = isRecord(event.data) ? event.data : undefined;
    const tool = asString(data?.tool_name) ?? asString(data?.toolName);
    if (tool) return tool;
  }
  return 'idle';
}

function getSessionTitle(session: SessionRow): string {
  const metadata = session.metadata ?? {};

  const goal = session.goal
    ?? asString(metadata.goal)
    ?? asString(metadata.current_objective)
    ?? asString(metadata.currentObjective);
  if (goal) return cleanTitle(goal);

  const preview = session.lastUserMessagePreview
    ?? asString(metadata.last_user_prompt)
    ?? asString(metadata.messagePreview);
  if (preview) return cleanTitle(preview);

  const agentEvents = Array.isArray(metadata.agent_events) ? metadata.agent_events : [];
  for (const event of agentEvents) {
    if (!isRecord(event)) continue;
    const type = asString(event.type);
    const data = isRecord(event.data) ? event.data : undefined;
    if (type === 'runtime_script_created') {
      const g = asString(data?.goal);
      if (g) return cleanTitle(g);
    }
    if (type === 'user_message' || type === 'send_text') {
      const text = asString(data?.text) ?? asString(data?.content) ?? asString(data?.message);
      if (text) return cleanTitle(text);
    }
  }

  if (session.workingDir) return session.workingDir.split('/').pop() || session.workingDir;
  return session.sessionKey;
}

function isAsyncSession(session: SessionRow): boolean {
  const metadata = session.metadata ?? {};
  const asyncFlag = asBoolean(
    metadata.isAsync
    ?? metadata.is_async
    ?? metadata.asyncMode
    ?? metadata.async_mode
    ?? metadata.asyncModeEnabled
    ?? metadata.async_mode_enabled
  );
  if (typeof asyncFlag === 'boolean') return asyncFlag;

  if ((session.clientType ?? '').toLowerCase() === 'async') return true;

  const escalations = parseSessionEscalations(metadata.escalations);
  if (escalations.length > 0) return true;

  const packets = parsePackets(metadata.packets, session.sessionKey);
  if (packets.some((packet) => packet.type === 'escalation')) return true;

  const agentEvents = Array.isArray(metadata.agent_events) ? metadata.agent_events : [];
  for (const entry of agentEvents) {
    if (!isRecord(entry)) continue;
    const type = (asString(entry.type) ?? '').toLowerCase();
    if (!type) continue;
    if (
      type.startsWith('watcher_')
      || type === 'packet_emitted'
      || type === 'workitem_created'
      || type === 'escalation_raised'
      || type === 'escalation_resolved'
    ) {
      return true;
    }
  }
  return false;
}

// ── rollup builders ─────────────────────────────────────────────────

function buildSessionRollups(
  sessions: SessionRow[],
  traceMap: Map<string, TraceSummary>,
  testReports: Map<string, TestReportSummary> = new Map(),
  diffstatsBySession: Map<string, { added: number; deleted: number; filesTouched: number }> = new Map()
): SessionRollup[] {
  const nowMs = Date.now();
  return sessions.map((session) => {
    const metadata = session.metadata ?? {};
    const trace = traceMap.get(session.sessionKey) ?? { filesTouched: 0 };
    const escalations = unresolvedEscalations(session);
    const report = testReports.get(session.sessionKey);
    const diffstat = diffstatsBySession.get(session.sessionKey);
    const testsStatus = mapGateStatus(
      report?.verdict
      ?? metadata.testsStatus
      ?? metadata.tests_status
      ?? metadata.test_status
      ?? metadata.latest_test_status
    );
    const invariantsPassed = report?.invariantsPassed
      ?? asNumber(metadata.invariantsPassed ?? metadata.invariants_passed)
      ?? 0;
    const invariantsTotal = report?.invariantsTotal
      ?? asNumber(metadata.invariantsTotal ?? metadata.invariants_total)
      ?? 0;
    const invariantsStatus = invariantsTotal > 0
      ? (invariantsPassed >= invariantsTotal ? 'pass' : 'fail')
      : mapGateStatus(
        metadata.invariantsStatus
        ?? metadata.invariants_status
        ?? metadata.latest_invariants_status
      );
    const activeWorkItemId = session.currentWorkItemId
      ?? asString(metadata.currentWorkItemId)
      ?? asString(metadata.current_work_item_id)
      ?? asString(metadata.currentWorkId)
      ?? asString(metadata.current_work_id);
    const currentObjective = session.currentObjective
      ?? asString(metadata.currentObjective)
      ?? asString(metadata.current_objective);
    const lastMs = Math.max(
      session.lastAccessedAt * 1000,
      trace.latestTimestampMs ?? 0
    );
    const status = deriveSessionPanelStatus(
      session.status,
      metadata,
      escalations.length,
      testsStatus,
      invariantsStatus
    );

    return {
      sessionKey: session.sessionKey,
      kind: mapSessionKind(session),
      title: getSessionTitle(session),
      status,
      isAsync: isAsyncSession(session),
      ...(activeWorkItemId ? { activeWorkItemId } : {}),
      elapsedSec: Math.max(0, Math.floor((nowMs - session.createdAt * 1000) / 1000)),
      lastEventAt: new Date(lastMs || session.createdAt * 1000).toISOString(),
      diffstat: {
        added: diffstat?.added ?? 0,
        deleted: diffstat?.deleted ?? 0,
        filesTouched: diffstat?.filesTouched ?? trace.filesTouched,
      },
      currentActivity: {
        tool: currentObjective || getLatestTool(metadata),
        ...(trace.lastFile ? { file: trace.lastFile } : {}),
        ...(typeof trace.lastLine === 'number' ? { line: trace.lastLine } : {}),
      },
      gates: {
        testsStatus,
        invariantsStatus,
        invariantsPassed,
        invariantsTotal,
      },
      blocking: {
        unresolvedEscalationsCount: escalations.length,
      },
      tokenMetrics: parseSessionTokenMetrics(metadata),
    };
  });
}

function buildEscalationRollups(sessions: SessionRow[]): EscalationRollup[] {
  const nowMs = Date.now();
  const rollups: EscalationRollup[] = [];
  for (const session of sessions) {
    for (const escalation of getEscalations(session)) {
      if (escalation.status !== 'pending' && escalation.status !== 'acknowledged') {
        continue;
      }
      const createdAtMs = escalation.createdAt;
      const headline = escalation.title.split('\n')[0] || escalation.title;
      rollups.push({
        escalationId: escalation.id,
        sessionKey: escalation.sessionKey,
        ...(escalation.workItemId ? { workItemId: escalation.workItemId } : {}),
        createdAt: new Date(createdAtMs).toISOString(),
        ageSec: Math.max(0, Math.floor((nowMs - createdAtMs) / 1000)),
        headline,
        requestedDecision: classifyRequestedDecision(escalation.escalationType),
        refs: escalation.references,
      });
    }
  }

  return rollups.sort((a, b) => b.ageSec - a.ageSec);
}

// ── session event builders ──────────────────────────────────────────

function normalizeAgentEventType(type: string): NormalizedSessionEvent['type'] {
  if (type === 'agent_message' || type === 'user_message' || type === 'send_text' || type === 'response' || type === 'harness_response') return 'message';
  if (type === 'tool_call') return 'tool';
  if (type === 'git_commit') return 'trace';
  if (type.startsWith('browser_')) return 'tool';
  if (type.includes('test')) return 'test';
  if (type.includes('packet')) return 'packet';
  return 'workflow';
}

function getSignalPriority(event: NormalizedSessionEvent): 'high' | 'medium' | 'low' | 'status' {
  if (event.type === 'packet') return 'high';

  if (event.type === 'test') {
    const data = event.payload.data as Record<string, unknown> | undefined;
    const verdict = String(data?.verdict ?? event.payload.verdict ?? '').toLowerCase();
    if (verdict === 'fail' || verdict === 'error') return 'high';
    return 'medium';
  }

  if (event.type === 'message') {
    const role = String(event.payload.role ?? '');
    const content = typeof event.payload.content === 'string' ? event.payload.content : '';

    if (role === 'assistant') {
      if (content.length > 120) return 'high';
      if (content.length > 0) return 'medium';
      return 'low';
    }

    if (role === 'user') return 'medium';

    if (content.length > 100) return 'medium';
    return 'low';
  }

  if (event.type === 'tool') {
    const eventType = String(event.payload.eventType ?? '').toLowerCase();
    const data = event.payload.data as Record<string, unknown> | undefined;

    const success = data?.success;
    if (success === false) return 'high';
    const status = String(data?.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed' || status === 'fail') return 'high';

    if (eventType.includes('memory') || eventType.includes('inject')) return 'status';
    if (eventType.startsWith('browser_')) return 'status';

    return 'low';
  }

  if (event.type === 'workflow') {
    const eventType = String(event.payload.eventType ?? '').toLowerCase();
    if (eventType.includes('error') || eventType.includes('fail')) return 'high';
    if (eventType.includes('escalation')) return 'high';
    if (eventType === 'llm_call' || eventType === 'hook_call' || eventType === 'iteration_started' ||
        eventType === 'memory_injected' || eventType.includes('memory') || eventType.includes('inject')) {
      return 'status';
    }
    return 'low';
  }

  return 'low';
}

function isStatusOnlyEvent(event: NormalizedSessionEvent): boolean {
  return getSignalPriority(event) === 'status';
}

function collectWorkItemObjectives(agentEvents: unknown[]): Map<string, string> {
  const map = new Map<string, string>();

  const readWorkItemId = (entry: Record<string, unknown>, data: Record<string, unknown>): string | null =>
    asString(entry.work_item_id)
    ?? asString(entry.workItemId)
    ?? asString(entry.workId)
    ?? asString(entry.work_id)
    ?? asString(data.work_item_id)
    ?? asString(data.workItemId)
    ?? asString(data.workId)
    ?? asString(data.work_id)
    ?? null;

  const readObjective = (entry: Record<string, unknown>, data: Record<string, unknown>): string | null =>
    asString(data.objective)
    ?? asString(data.current_objective)
    ?? asString(data.goal)
    ?? asString(entry.objective)
    ?? asString(entry.current_objective)
    ?? asString(entry.goal)
    ?? null;

  for (const raw of agentEvents) {
    if (!isRecord(raw)) continue;
    const data = isRecord(raw.data) ? raw.data : {};

    const directWorkId = readWorkItemId(raw, data);
    const directObjective = readObjective(raw, data);
    if (directWorkId && directObjective && !map.has(directWorkId)) {
      map.set(directWorkId, directObjective);
    }

    const type = asString(raw.type);
    if (type !== 'runtime_script_created') continue;

    const workItemsRaw = Array.isArray(data.work_items)
      ? data.work_items
      : Array.isArray(data.workItems)
        ? data.workItems
        : [];
    for (const item of workItemsRaw) {
      if (!isRecord(item)) continue;
      const itemWorkId = asString(item.work_id) ?? asString(item.workId) ?? asString(item.id);
      const itemObjective = asString(item.objective) ?? asString(item.goal);
      if (!itemWorkId || !itemObjective) continue;
      if (!map.has(itemWorkId)) map.set(itemWorkId, itemObjective);
    }
  }

  return map;
}

function normalizedEventWorkItemId(event: NormalizedSessionEvent): string | null {
  const payload = event.payload;
  const data = isRecord(payload.data) ? payload.data : {};
  return asString(payload.workItemId)
    ?? asString(payload.work_item_id)
    ?? asString(payload.workId)
    ?? asString(payload.work_id)
    ?? asString(data.workItemId)
    ?? asString(data.work_item_id)
    ?? asString(data.workId)
    ?? asString(data.work_id)
    ?? null;
}

interface SessionEventEnvelope {
  ts: number;
  sequence: number;
  cursorValue: number;
  event: NormalizedSessionEvent;
}

function eventPayloadContent(payload: Record<string, unknown>): string {
  return typeof payload.content === 'string' ? payload.content : '';
}

function hasNonEmptyPayloadContent(payload: Record<string, unknown>): boolean {
  return eventPayloadContent(payload).trim().length > 0;
}

function isFromMessagesTable(payload: Record<string, unknown>): boolean {
  return typeof payload.id === 'number' && !payload.eventType;
}

function extractAgentMessageContent(entry: Record<string, unknown>, data: Record<string, unknown>): string {
  const directCandidates = [
    data.content,
    data.message,
    data.chunk,
    data.text,
    data.response,
    entry.content,
    entry.message,
  ];
  for (const value of directCandidates) {
    if (typeof value === 'string') {
      if (value.length > 0) return value;
      continue;
    }
  }

  return (
    extractText(data.content)
    ?? extractText(data.message)
    ?? extractText(data.chunk)
    ?? extractText(data.text)
    ?? extractText(data.response)
    ?? extractText(entry.content)
    ?? extractText(entry.message)
    ?? ''
  );
}

function updateMessageEnvelopeContent(
  target: SessionEventEnvelope,
  source: SessionEventEnvelope,
  content: string
): void {
  target.event = {
    ...target.event,
    at: source.event.at,
    payload: {
      ...target.event.payload,
      content,
    },
  };
  target.event.signalPriority = getSignalPriority(target.event);
  target.event.isStatusOnly = isStatusOnlyEvent(target.event);
  target.ts = source.ts;
  target.sequence = source.sequence;
  target.cursorValue = source.cursorValue;
}

function compactAssistantStreamMessages(messageEntries: SessionEventEnvelope[]): SessionEventEnvelope[] {
  if (messageEntries.length <= 1) return messageEntries;

  const canonicalByRequestRole = new Set<string>();
  for (const entry of messageEntries) {
    const payload = entry.event.payload;
    const role = asString(payload.role);
    const requestId = asString(payload.requestId);
    const eventType = asString(payload.eventType);
    if (role !== 'assistant' || !requestId) continue;
    const isCanonical = hasNonEmptyPayloadContent(payload)
      && (isFromMessagesTable(payload) || (eventType !== undefined && eventType !== 'agent_message'));
    if (!isCanonical) continue;
    canonicalByRequestRole.add(`${requestId}:${role}`);
  }

  const compacted: SessionEventEnvelope[] = [];
  const chunkIndexByRequestRole = new Map<string, number>();

  const shiftIndexes = (removedIdx: number): void => {
    for (const [key, idx] of Array.from(chunkIndexByRequestRole.entries())) {
      if (idx === removedIdx) {
        chunkIndexByRequestRole.delete(key);
      } else if (idx > removedIdx) {
        chunkIndexByRequestRole.set(key, idx - 1);
      }
    }
  };

  for (const entry of messageEntries) {
    const payload = entry.event.payload;
    const role = asString(payload.role);
    const requestId = asString(payload.requestId);
    const eventType = asString(payload.eventType);
    const isChunk = role === 'assistant' && eventType === 'agent_message';

    if (!isChunk) {
      if (role === 'assistant' && requestId) {
        const isCanonical = hasNonEmptyPayloadContent(payload)
          && (isFromMessagesTable(payload) || (eventType !== undefined && eventType !== 'agent_message'));
        if (isCanonical) {
          const key = `${requestId}:${role}`;
          const chunkIdx = chunkIndexByRequestRole.get(key);
          if (chunkIdx !== undefined) {
            compacted.splice(chunkIdx, 1);
            shiftIndexes(chunkIdx);
          }
        }
      }
      compacted.push(entry);
      continue;
    }

    const chunk = eventPayloadContent(payload);
    if (chunk.length === 0) continue;

    if (requestId) {
      const key = `${requestId}:${role}`;
      if (canonicalByRequestRole.has(key)) continue;
      const existingIdx = chunkIndexByRequestRole.get(key);
      if (existingIdx === undefined) {
        compacted.push(entry);
        chunkIndexByRequestRole.set(key, compacted.length - 1);
        continue;
      }
      const existing = compacted[existingIdx];
      const merged = `${eventPayloadContent(existing.event.payload)}${chunk}`;
      updateMessageEnvelopeContent(existing, entry, merged);
      continue;
    }

    const prev = compacted[compacted.length - 1];
    if (prev) {
      const prevPayload = prev.event.payload;
      const prevRole = asString(prevPayload.role);
      const prevEventType = asString(prevPayload.eventType);
      const prevRequestId = asString(prevPayload.requestId);
      if (prevRole === 'assistant' && prevEventType === 'agent_message' && !prevRequestId) {
        const merged = `${eventPayloadContent(prevPayload)}${chunk}`;
        updateMessageEnvelopeContent(prev, entry, merged);
        continue;
      }
    }

    compacted.push(entry);
  }

  return compacted;
}

function buildSessionEvents(
  session: SessionRow,
  messages: MessageRow[],
  limit: number,
  cursor?: number
): { events: NormalizedSessionEvent[]; nextCursor: number | null } {
  const boundedLimit = clampInteger(limit, 200, 1, 500);
  const normalized: SessionEventEnvelope[] = [];
  let sequence = 0;

  for (const message of messages) {
    const ts = parseTimestampMs(message.createdAt);
    if (!ts) continue;
    const event: NormalizedSessionEvent = {
      at: new Date(ts).toISOString(),
      type: 'message',
      payload: {
        id: message.id,
        role: message.role,
        content: message.content,
        requestId: message.requestId,
        metadata: message.metadata ?? {},
      },
    };
    event.signalPriority = getSignalPriority(event);
    event.isStatusOnly = isStatusOnlyEvent(event);
    normalized.push({
      ts,
      sequence,
      cursorValue: ts,
      event,
    });
    sequence += 1;
  }

  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata?.agent_events : [];
  const objectiveByWorkItem = collectWorkItemObjectives(agentEvents);
  for (const entry of agentEvents) {
    if (!isRecord(entry)) continue;
    const type = asString(entry.type);
    const ts = parseTimestampMs(entry.timestamp);
    if (!type || !ts) continue;

    if (type === 'llm_call' || type === 'hook_call' || type === 'iteration_started' ||
        type === 'memory_injected' || (type.includes('memory') && type.includes('inject'))) {
      continue;
    }

    const normalizedType = normalizeAgentEventType(type);
    const data = isRecord(entry.data) ? { ...entry.data } : {};
    const eventWorkItemId = asString(entry.work_item_id)
      ?? asString(entry.workItemId)
      ?? asString(entry.workId)
      ?? asString(entry.work_id)
      ?? asString(data.work_item_id)
      ?? asString(data.workItemId)
      ?? asString(data.workId)
      ?? asString(data.work_id);
    const existingObjective = asString(data.objective)
      ?? asString(data.current_objective)
      ?? asString(data.goal);
    if (!existingObjective && eventWorkItemId) {
      const backfilledObjective = objectiveByWorkItem.get(eventWorkItemId);
      if (backfilledObjective) data.objective = backfilledObjective;
    }
    const defaultRole = (type === 'user_message' || type === 'send_text') ? 'user' : 'assistant';
    const messageRole = asString(data.role) ?? asString(entry.role) ?? defaultRole;
    const messageContent = type === 'agent_message'
      ? extractAgentMessageContent(entry, data)
      : extractText(data.content)
        ?? extractText(data.message)
        ?? extractText(data.chunk)
        ?? extractText(data.text)
        ?? extractText(data.response)
        ?? extractText(entry.content)
        ?? extractText(entry.message)
        ?? '';
    const event: NormalizedSessionEvent = {
      at: new Date(ts).toISOString(),
      type: normalizedType,
      payload: {
        eventType: type,
        requestId: asString(entry.request_id),
        ...(eventWorkItemId ? { workItemId: eventWorkItemId } : {}),
        ...(normalizedType === 'message' ? { role: messageRole, content: messageContent } : {}),
        data,
      },
    };
    event.signalPriority = getSignalPriority(event);
    event.isStatusOnly = isStatusOnlyEvent(event);
    normalized.push({
      ts,
      sequence,
      cursorValue: ts,
      event,
    });
    sequence += 1;
  }

  normalized.sort((a, b) => (a.ts - b.ts) || (a.sequence - b.sequence));

  let prevTs = Number.NaN;
  let sameTsOrdinal = 0;
  for (const entry of normalized) {
    if (entry.ts === prevTs) {
      sameTsOrdinal += 1;
    } else {
      prevTs = entry.ts;
      sameTsOrdinal = 0;
    }
    // Cursor is timestamp + 1ms sub-slot, so events sharing the same millisecond
    // are still incrementally pageable without being dropped.
    entry.cursorValue = entry.ts + (Math.min(sameTsOrdinal, 999) / 1000);
  }

  const filtered = typeof cursor === 'number' && Number.isFinite(cursor)
    ? normalized.filter((entry) => entry.cursorValue > cursor)
    : normalized;

  // Partition into messages and non-messages
  const messageEntries = filtered.filter(e => e.event.type === 'message');
  const otherEntries = filtered.filter(e => e.event.type !== 'message');

  // Deduplicate: messages-table entries (numeric id, no eventType) win over
  // agent_events duplicates for the same requestId+role only when the table row
  // actually carries content. Empty canonical rows should not hide stream content.
  const tableRequestRoles = new Set<string>();
  for (const entry of messageEntries) {
    const payload = entry.event.payload;
    const isFromTable = isFromMessagesTable(payload);
    if (!isFromTable) continue;
    const requestId = asString(payload.requestId);
    const role = asString(payload.role);
    if (!requestId || !role || !hasNonEmptyPayloadContent(payload)) continue;
    tableRequestRoles.add(`${requestId}:${role}`);
  }

  const dedupedMessages: typeof messageEntries = [];
  for (const entry of messageEntries) {
    const payload = entry.event.payload;
    const isFromTable = isFromMessagesTable(payload);
    if (isFromTable) {
      dedupedMessages.push(entry);
      continue;
    }
    const requestId = asString(payload.requestId);
    const role = asString(payload.role);
    if (requestId && role && tableRequestRoles.has(`${requestId}:${role}`)) {
      continue;
    }
    dedupedMessages.push(entry);
  }

  // Keep ordering stable after dedupe.
  dedupedMessages.sort((a, b) => (a.ts - b.ts) || (a.sequence - b.sequence));
  const compactedMessages = compactAssistantStreamMessages(dedupedMessages);

  if (compactedMessages.length === 0 && otherEntries.length === 0) {
    return {
      events: [],
      nextCursor: null,
    };
  }

  // Reserve up to half the budget for non-message events when both types exist.
  const reservedMessageSlots = compactedMessages.length > 0 && otherEntries.length > 0
    ? Math.floor(boundedLimit * 0.5)
    : boundedLimit;
  const eventBudget = Math.max(
    0,
    boundedLimit - Math.min(compactedMessages.length, reservedMessageSlots)
  );
  let selectedOther: typeof otherEntries = [];

  if (eventBudget > 0) {
    // Keep at least one recent non-message event per work item so Live view
    // does not collapse to whichever work item produced the noisiest stream.
    const latestByWorkItem = new Map<string, (typeof otherEntries)[number]>();
    for (let idx = otherEntries.length - 1; idx >= 0; idx -= 1) {
      const entry = otherEntries[idx];
      const workItemId = normalizedEventWorkItemId(entry.event);
      if (!workItemId || latestByWorkItem.has(workItemId)) continue;
      latestByWorkItem.set(workItemId, entry);
    }

    const anchors = Array.from(latestByWorkItem.values())
      .sort((a, b) => a.ts - b.ts)
      .slice(-eventBudget);
    const anchorSet = new Set(anchors);
    const remainingBudget = Math.max(0, eventBudget - anchors.length);
    const tail = remainingBudget > 0
      ? otherEntries.filter((entry) => !anchorSet.has(entry)).slice(-remainingBudget)
      : [];

    selectedOther = [...anchors, ...tail].sort((a, b) => a.ts - b.ts);
  }

  // Backfill with messages if non-message events did not consume their budget.
  const messageCapacity = Math.max(0, boundedLimit - selectedOther.length);
  const selectedMessages = compactedMessages.slice(-messageCapacity);

  const combined = [...selectedMessages, ...selectedOther]
    .sort((a, b) => (a.ts - b.ts) || (a.sequence - b.sequence))
    .slice(-boundedLimit);
  const nextCursor = combined.length > 0 ? combined[combined.length - 1].cursorValue : null;

  return {
    events: combined.map((entry) => entry.event),
    nextCursor,
  };
}

// ── collect/compute ─────────────────────────────────────────────────

async function collectCommitRollups(sessions: SessionRow[], limit: number): Promise<CommitRollup[]> {
  const sessionsByWorkingDir = groupSessionsByWorkingDir(sessions);
  const rollups: CommitRollup[] = [];
  const perRepoLimit = Math.max(10, Math.min(limit, 100));

  for (const [projectPath, repoSessions] of sessionsByWorkingDir.entries()) {
    try {
      const stdout = await execFileText(
        'git',
        [
          'log',
          '-n',
          String(perRepoLimit),
          '--date=iso-strict',
          '--pretty=format:__COMMIT__%H%x1f%an%x1f%aI%x1f%s',
          '--numstat',
        ],
        { cwd: projectPath, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
      );
      const commits = parseGitLogWithNumstat(stdout, projectPath);
      const sessionCommitEvents = repoSessions.flatMap((session) => getSessionCommitEvents(session));

      for (const commit of commits) {
        const matched = findSessionCommitBySha(sessionCommitEvents, commit.sha);
        const matchedSession = matched
          ? repoSessions.find((session) => session.sessionKey === matched.sessionKey) ?? null
          : null;
        const range = matchedSession ? getLatestRevisionRange(matchedSession, commit.sha) : {};
        rollups.push({
          ...commit,
          ...(matched ? { sessionKey: matched.sessionKey } : {}),
          ...(matched?.workItemId ? { workItemId: matched.workItemId } : {}),
          ...(range.baseSha ? { baseSha: range.baseSha } : {}),
          ...(range.headSha ? { headSha: range.headSha } : {}),
        });
      }
    } catch {
      // Skip repos that are unavailable or not git.
    }
  }

  rollups.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return rollups.slice(0, limit);
}

async function collectPRRollups(
  sessions: SessionRow[],
  status: string | null,
  limit: number
): Promise<PRRollup[]> {
  const sessionsByWorkingDir = groupSessionsByWorkingDir(sessions);
  const rollups: PRRollup[] = [];

  for (const [projectPath, repoSessions] of sessionsByWorkingDir.entries()) {
    try {
      const remote = await getGitRemote(projectPath);
      if (!remote) continue;
      const prs = await getPRs(remote.owner, remote.repo);
      const filtered = prs.filter((pr) => !status || pr.state === status);
      for (const pr of filtered) {
        const ownerSession = repoSessions[0];
        rollups.push({
          prId: `${remote.owner}/${remote.repo}#${pr.number}`,
          number: pr.number,
          title: pr.title,
          status: pr.state,
          ciStatus: 'unknown',
          author: pr.author,
          url: pr.url,
          updatedAt: pr.updatedAt,
          projectPath,
          ...(ownerSession ? { sessionKey: ownerSession.sessionKey } : {}),
          ...(ownerSession?.currentWorkItemId ? { workItemId: ownerSession.currentWorkItemId } : {}),
        });
      }
    } catch {
      // Skip repos that cannot enumerate PRs.
    }
  }

  rollups.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return rollups.slice(0, limit);
}

function computeCockpitDailyMetrics(
  sessions: SessionRow[],
  dateParam: string | null,
  precomputed: {
    testReports: Map<string, TestReportSummary>;
    diffstatsBySession: Map<string, { added: number; deleted: number; filesTouched: number }>;
    statusCounts: { running: number; ready: number; done: number };
    escalationsOpen: number;
  }
): CockpitDailyMetricsResult {
  const day = dateParam ?? new Date().toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    return { date: day, metrics: null, error: `Invalid date: ${day}` };
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const startMs = start.getTime();
  const endMs = end.getTime();

  // Derive commits from session commit events (replaces loadTraceRecords)
  const revisions = new Set<string>();
  for (const session of sessions) {
    const createdMs = session.createdAt * 1000;
    const updatedMs = session.lastAccessedAt * 1000;
    if (createdMs >= endMs || updatedMs < startMs) continue;
    for (const commit of getSessionCommitEvents(session)) {
      if (commit.timestampMs >= startMs && commit.timestampMs < endMs) {
        revisions.add(commit.sha);
      }
    }
  }

  // Derive locTouched from precomputed diffstats for sessions active today
  let locTouched = 0;
  for (const session of sessions) {
    const createdMs = session.createdAt * 1000;
    const updatedMs = session.lastAccessedAt * 1000;
    if (createdMs >= endMs || updatedMs < startMs) continue;
    const ds = precomputed.diffstatsBySession.get(session.sessionKey);
    if (ds) locTouched += ds.filesTouched;
  }

  // Count test reports from precomputed data (replaces countTestReportsForWindow)
  let tests = 0;
  for (const report of precomputed.testReports.values()) {
    if (report.createdAtMs >= startMs && report.createdAtMs < endMs) {
      tests++;
    }
  }

  // Token totals from session metadata
  let totalTokens = 0;
  for (const session of sessions) {
    const createdMs = session.createdAt * 1000;
    const updatedMs = session.lastAccessedAt * 1000;
    if (createdMs >= endMs || updatedMs < startMs) continue;
    const metadata = session.metadata ?? {};
    const eventTokens = parseAgentEventTokenTotalsForDay(metadata, startMs, endMs);
    if (eventTokens > 0) {
      totalTokens += eventTokens;
    } else if (updatedMs >= startMs && updatedMs < endMs) {
      totalTokens += asNumber(metadata.total_tokens ?? metadata.totalTokens) ?? 0;
    }
  }

  return {
    date: day,
    metrics: {
      tokens: totalTokens,
      locTouched,
      commits: revisions.size,
      prs: 0,
      tests,
      sessions: precomputed.statusCounts,
      escalationsOpen: precomputed.escalationsOpen,
    },
  };
}

async function buildCockpitRollupSnapshot(
  ctx: ControlPlaneContext,
  options: {
    sessionLimit: number;
    escalationLimit: number;
    repoLimit: number;
    includeRepo: boolean;
    date: string | null;
  }
): Promise<CockpitRollupSnapshotResult> {
  const sessionLimit = clampInteger(options.sessionLimit, 120, 10, 500);
  const escalationLimit = clampInteger(options.escalationLimit, 120, 10, 500);
  const repoLimit = clampInteger(options.repoLimit, 50, 5, 200);
  const emptyPrecomputed = {
    testReports: new Map<string, TestReportSummary>(),
    diffstatsBySession: new Map<string, { added: number; deleted: number; filesTouched: number }>(),
    statusCounts: { running: 0, ready: 0, done: 0 },
    escalationsOpen: 0,
  };

  const { sessions, error } = getAllSessions(ctx, 1000);
  if (error) {
    const metrics = computeCockpitDailyMetrics([], options.date, emptyPrecomputed);
    return {
      runningSessions: [],
      readySessions: [],
      doneSessions: [],
      escalations: [],
      commitRollups: [],
      prRollups: [],
      metrics: metrics.metrics,
      metricsDate: metrics.date,
      generatedAt: new Date().toISOString(),
      error,
    };
  }

  const traceMap = new Map<string, TraceSummary>();
  for (const session of sessions) {
    traceMap.set(session.sessionKey, buildSessionTraceSummaryFromEvents(session));
  }

  // Fast path: load test reports + diffstats in parallel, then derive everything in-memory
  const [testReports, diffstatsBySession] = await Promise.all([
    loadLatestTestReports(sessions.map((session) => session.sessionKey)),
    loadSessionDiffstats(sessions),
  ]);

  const allRollups = buildSessionRollups(sessions, traceMap, testReports, diffstatsBySession);
  const runningSessions = allRollups
    .filter((rollup) => rollup.status === 'running' || rollup.status === 'blocked')
    .slice(0, sessionLimit);
  const readySessions = allRollups
    .filter((rollup) => rollup.status === 'ready')
    .slice(0, sessionLimit);
  const doneSessions = allRollups
    .filter((rollup) => rollup.status === 'done' || rollup.status === 'stopped')
    .slice(0, sessionLimit);
  const escalations = buildEscalationRollups(sessions).slice(0, escalationLimit);

  // Metrics are now a synchronous derivation from data we already have
  const metrics = computeCockpitDailyMetrics(sessions, options.date, {
    testReports,
    diffstatsBySession,
    statusCounts: {
      running: runningSessions.length,
      ready: readySessions.length,
      done: doneSessions.length,
    },
    escalationsOpen: escalations.length,
  });

  const [commitRollups, prRollups] = options.includeRepo
    ? await Promise.all([
      collectCommitRollups(sessions, repoLimit),
      collectPRRollups(sessions, 'open', repoLimit),
    ])
    : [[], []];

  return {
    runningSessions,
    readySessions,
    doneSessions,
    escalations,
    commitRollups,
    prRollups,
    metrics: metrics.metrics,
    metricsDate: metrics.date,
    generatedAt: new Date().toISOString(),
    ...(metrics.error ? { error: metrics.error } : {}),
  };
}

// ── repo lens helpers ───────────────────────────────────────────────

function parseRgJsonMatches(stdout: string, kind: RepoLensMatch['kind'], limit: number): RepoLensMatch[] {
  const matches: RepoLensMatch[] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== 'match' || !isRecord(parsed.data)) continue;
    const data = parsed.data;
    const path = isRecord(data.path) ? asString(data.path.text) : undefined;
    const lineNumber = asNumber(data.line_number);
    const linesValue = isRecord(data.lines) ? asString(data.lines.text) : undefined;
    const submatches = Array.isArray(data.submatches) ? data.submatches : [];
    const firstSubmatch = submatches.length > 0 && isRecord(submatches[0]) ? submatches[0] : null;
    const column = firstSubmatch ? (asNumber(firstSubmatch.start) ?? 0) + 1 : 1;
    if (!path || !lineNumber || !linesValue) continue;
    matches.push({
      kind,
      path,
      line: lineNumber,
      column,
      preview: linesValue.trimEnd(),
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

async function runRepoLensQuery(
  workingDir: string,
  pattern: string,
  kind: RepoLensMatch['kind'],
  limit: number,
  fixedStrings = true
): Promise<RepoLensMatch[]> {
  const args = [
    '--json',
    '--line-number',
    '--color',
    'never',
    '--max-filesize',
    '1M',
    '--max-count',
    String(Math.max(1, Math.ceil(limit / 3))),
  ];
  if (fixedStrings) args.push('--fixed-strings');
  args.push(pattern, '.');

  try {
    const stdout = await execFileText('rg', args, {
      cwd: workingDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseRgJsonMatches(stdout, kind, limit);
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === 'number'
      ? (error as { code: number }).code
      : undefined;
    if (code === 1) {
      return [];
    }
    throw error;
  }
}

function traceMatchesSession(trace: Record<string, unknown>, sessionKey: string): boolean {
  const sessionUrl = `session://${sessionKey}`;
  const files = Array.isArray(trace.files) ? trace.files : [];
  for (const fileEntry of files) {
    if (!isRecord(fileEntry)) continue;
    const conversations = Array.isArray(fileEntry.conversations) ? fileEntry.conversations : [];
    for (const conversation of conversations) {
      if (!isRecord(conversation)) continue;
      const url = asString(conversation.url);
      if (!url) continue;
      if (url === sessionUrl || url.endsWith(sessionKey)) return true;
    }
  }
  return false;
}

// ── exported handler functions ──────────────────────────────────────

export function handleGetDebugMemory(res: ServerResponse, ctx: ControlPlaneContext): void {
  if (!ctx.getDebugMemoryInfo) {
    sendJson(res, { error: 'Debug memory info not available' }, 503);
    return;
  }
  const info = ctx.getDebugMemoryInfo();
  if (info && typeof (info as Promise<unknown>).then === 'function') {
    void (info as Promise<unknown>)
      .then((resolved) => sendJson(res, resolved))
      .catch((error) => sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500));
    return;
  }
  sendJson(res, info);
}

export async function handleGetCockpitSessionRollups(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  status: string | null,
  limit: number
): Promise<void> {
  const { sessions, error } = getAllSessions(ctx, Math.max(100, limit));
  if (error) {
    sendJson(res, { rollups: [], error });
    return;
  }

  const traceMap = new Map<string, TraceSummary>();
  for (const session of sessions) {
    traceMap.set(session.sessionKey, buildSessionTraceSummaryFromEvents(session));
  }
  const testReports = await loadLatestTestReports(sessions.map((session) => session.sessionKey));
  const diffstatsBySession = await loadSessionDiffstats(sessions);

  const filtered = buildSessionRollups(sessions, traceMap, testReports, diffstatsBySession)
    .filter((rollup) => !status || rollup.status === status)
    .slice(0, limit);

  sendJson(res, { rollups: filtered, total: filtered.length });
}

export async function handleGetCockpitRollupSnapshot(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  options: {
    sessionLimit: number;
    escalationLimit: number;
    repoLimit: number;
    includeRepo: boolean;
    date: string | null;
  }
): Promise<void> {
  try {
    const cacheKey = [
      ctx.workingDir,
      options.sessionLimit,
      options.escalationLimit,
      options.repoLimit,
      options.includeRepo ? 'repo:1' : 'repo:0',
      options.date ?? '',
    ].join('|');
    const now = Date.now();
    if (cockpitSnapshotCache && cockpitSnapshotCache.key === cacheKey && cockpitSnapshotCache.expiresAt > now) {
      sendJson(res, cockpitSnapshotCache.data);
      return;
    }

    let inFlight = cockpitSnapshotInFlight.get(cacheKey);
    if (!inFlight) {
      const buildPromise = buildCockpitRollupSnapshot(ctx, options);
      cockpitSnapshotInFlight.set(cacheKey, buildPromise);
      void buildPromise.finally(() => {
        if (cockpitSnapshotInFlight.get(cacheKey) === buildPromise) {
          cockpitSnapshotInFlight.delete(cacheKey);
        }
      });
      inFlight = buildPromise;
    }
    const snapshot = await inFlight;
    setCockpitSnapshotCache({
      key: cacheKey,
      expiresAt: Date.now() + COCKPIT_SNAPSHOT_CACHE_TTL_MS,
      data: snapshot,
    });
    sendJson(res, snapshot);
  } catch (error) {
    sendJson(res, {
      runningSessions: [],
      readySessions: [],
      doneSessions: [],
      escalations: [],
      commitRollups: [],
      prRollups: [],
      metrics: null,
      metricsDate: new Date().toISOString().slice(0, 10),
      generatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}

export function handleGetCockpitEscalationRollups(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  status: string | null,
  limit: number
): void {
  const { sessions, error } = getAllSessions(ctx, 1000);
  if (error) {
    sendJson(res, { rollups: [], error });
    return;
  }

  const rollups = buildEscalationRollups(sessions)
    .filter((rollup) => !status || status === 'open')
    .slice(0, limit);
  sendJson(res, { rollups, total: rollups.length });
}

export async function handleGetCockpitCommitRollups(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  limit: number
): Promise<void> {
  const { sessions, error } = getAllSessions(ctx, 1000);
  if (error) {
    sendJson(res, { rollups: [], error });
    return;
  }
  const rollups = await collectCommitRollups(sessions, clampInteger(limit, 50, 1, 200));
  sendJson(res, { rollups, total: rollups.length });
}

export async function handleGetCockpitPRRollups(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  status: string | null,
  limit: number
): Promise<void> {
  const { sessions, error } = getAllSessions(ctx, 1000);
  if (error) {
    sendJson(res, { rollups: [], error });
    return;
  }
  const rollups = await collectPRRollups(sessions, status, clampInteger(limit, 50, 1, 200));
  sendJson(res, { rollups, total: rollups.length });
}

export async function handleGetCockpitDailyMetrics(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  dateParam: string | null
): Promise<void> {
  const { sessions, error } = getAllSessions(ctx, 1000);
  if (error) {
    const day = dateParam ?? new Date().toISOString().slice(0, 10);
    sendJson(res, { date: day, metrics: null, error });
    return;
  }

  const [testReports, diffstatsBySession] = await Promise.all([
    loadLatestTestReports(sessions.map((s) => s.sessionKey)),
    loadSessionDiffstats(sessions),
  ]);
  const traceMap = new Map<string, TraceSummary>();
  for (const session of sessions) {
    traceMap.set(session.sessionKey, buildSessionTraceSummaryFromEvents(session));
  }
  const allRollups = buildSessionRollups(sessions, traceMap, testReports, diffstatsBySession);
  const escalations = buildEscalationRollups(sessions);

  const metrics = computeCockpitDailyMetrics(sessions, dateParam, {
    testReports,
    diffstatsBySession,
    statusCounts: {
      running: allRollups.filter((r) => r.status === 'running' || r.status === 'blocked').length,
      ready: allRollups.filter((r) => r.status === 'ready').length,
      done: allRollups.filter((r) => r.status === 'done' || r.status === 'stopped').length,
    },
    escalationsOpen: escalations.length,
  });
  if (metrics.error) {
    sendJson(res, { date: metrics.date, metrics: metrics.metrics, error: metrics.error }, 400);
    return;
  }
  sendJson(res, metrics);
}

export async function handleGetCockpitFocus(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  focusType: string | null,
  id: string | null,
  packetId: string | null
): Promise<void> {
  if (!focusType || !id) {
    sendJson(res, { error: 'Missing required query params: type, id' }, 400);
    return;
  }

  if (focusType === 'session') {
    const session = getSession(ctx, id);
    if (!session) {
      sendJson(res, { error: 'Session not found' }, 404);
      return;
    }

    const traceMap = new Map<string, TraceSummary>([
      [session.sessionKey, buildSessionTraceSummaryFromEvents(session)],
    ]);
    const testReports = await loadLatestTestReports([session.sessionKey]);
    const diffstatsBySession = await loadSessionDiffstats([session]);
    const rollup = buildSessionRollups([session], traceMap, testReports, diffstatsBySession)[0];
    const sessionPackets = parsePackets(session.metadata?.packets, session.sessionKey);
    const unresolved = unresolvedEscalations(session).sort((a, b) => b.createdAt - a.createdAt);
    const selectedPacket = packetId
      ? sessionPackets.find((packet) => packet.packetId === packetId) ?? null
      : sessionPackets[0] ?? null;
    const sessionIsAsync = isAsyncSession(session);

    sendJson(res, {
      focus: {
        type: 'session',
        id: session.sessionKey,
        sessionKey: session.sessionKey,
        isAsync: sessionIsAsync,
        header: {
          title: rollup.title,
          status: rollup.status,
          isAsync: sessionIsAsync,
          decisionRequest: unresolved[0]?.title ?? null,
          gateState: rollup.gates,
          blocking: rollup.blocking.unresolvedEscalationsCount,
        },
        packet: selectedPacket,
        pointers: {
          events: `/control-plane/cockpit/session/${encodeURIComponent(session.sessionKey)}/events`,
          packets: `/control-plane/cockpit/session/${encodeURIComponent(session.sessionKey)}/packets`,
          messages: `/control-plane/sessions/${encodeURIComponent(session.sessionKey)}/messages`,
          traces: `/control-plane/cockpit/traces?sessionKey=${encodeURIComponent(session.sessionKey)}`,
          tests: `/control-plane/cockpit/tests?sessionKey=${encodeURIComponent(session.sessionKey)}`,
          diff: `/control-plane/cockpit/diff?sessionKey=${encodeURIComponent(session.sessionKey)}`,
          repoLens: `/control-plane/cockpit/repo/lens?sessionKey=${encodeURIComponent(session.sessionKey)}&q=`,
          repoGrep: `/control-plane/cockpit/repo/grep?sessionKey=${encodeURIComponent(session.sessionKey)}&q=`,
        },
      },
    });
    return;
  }

  if (focusType === 'escalation') {
    const { sessions, error } = getAllSessions(ctx, 1000);
    if (error) {
      sendJson(res, { error }, 500);
      return;
    }

    const ownerSession = sessions.find((session) => getEscalations(session).some((item) => item.id === id));
    if (!ownerSession) {
      sendJson(res, { error: 'Escalation not found' }, 404);
      return;
    }
    const fullOwnerSession = getSession(ctx, ownerSession.sessionKey) ?? ownerSession;
    const escalation = getEscalations(fullOwnerSession).find((item) => item.id === id);
    if (!escalation) {
      sendJson(res, { error: 'Escalation not found' }, 404);
      return;
    }

    const sessionPackets = parsePackets(fullOwnerSession.metadata?.packets, fullOwnerSession.sessionKey);
    const selectedPacket = packetId
      ? sessionPackets.find((packet) => packet.packetId === packetId) ?? null
      : sessionPackets[0] ?? null;
    const ownerSessionIsAsync = isAsyncSession(fullOwnerSession);

    sendJson(res, {
      focus: {
        type: 'escalation',
        id: escalation.id,
        sessionKey: escalation.sessionKey,
        isAsync: ownerSessionIsAsync,
        header: {
          title: escalation.title,
          status: escalation.status,
          isAsync: ownerSessionIsAsync,
          requestedDecision: classifyRequestedDecision(escalation.escalationType),
          ageSec: Math.max(0, Math.floor((Date.now() - escalation.createdAt) / 1000)),
        },
        packet: selectedPacket,
        pointers: {
          events: `/control-plane/cockpit/session/${encodeURIComponent(escalation.sessionKey)}/events`,
          packets: `/control-plane/cockpit/session/${encodeURIComponent(escalation.sessionKey)}/packets`,
          messages: `/control-plane/sessions/${encodeURIComponent(escalation.sessionKey)}/messages`,
          traces: `/control-plane/cockpit/traces?sessionKey=${encodeURIComponent(escalation.sessionKey)}`,
          tests: `/control-plane/cockpit/tests?sessionKey=${encodeURIComponent(escalation.sessionKey)}`,
          diff: `/control-plane/cockpit/diff?sessionKey=${encodeURIComponent(escalation.sessionKey)}`,
          repoLens: `/control-plane/cockpit/repo/lens?sessionKey=${encodeURIComponent(escalation.sessionKey)}&q=`,
          repoGrep: `/control-plane/cockpit/repo/grep?sessionKey=${encodeURIComponent(escalation.sessionKey)}&q=`,
        },
      },
    });
    return;
  }

  sendJson(res, { error: `Unsupported focus type: ${focusType}` }, 400);
}

export async function handleGetCockpitTraces(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string | null,
  _workItemId: string | null,
  limit: number
): Promise<void> {
  let workingDir = ctx.workingDir;
  if (sessionKey) {
    const session = getSession(ctx, sessionKey);
    if (!session) {
      sendJson(res, { traces: [], error: 'Session not found' }, 404);
      return;
    }
    const sessionTraces = buildSessionEventTraceRecords(session, Math.max(1, limit));
    if (sessionTraces.length > 0) {
      sendJson(res, { traces: sessionTraces.slice(0, Math.max(1, limit)) });
      return;
    }
    workingDir = session.workingDir ?? workingDir;
  }

  const traces = await loadTraceRecords(workingDir, Math.max(limit * 2, 200));
  const filtered = sessionKey
    ? traces.filter((trace) => traceMatchesSession(trace, sessionKey))
    : traces;
  sendJson(res, { traces: filtered.slice(0, limit) });
}

export async function handleGetCockpitDiff(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string | null,
  baseRaw: string | null,
  headRaw: string | null,
  fileRaw: string | null
): Promise<void> {
  const file = asString(fileRaw);
  const queryBase = asString(baseRaw);
  const queryHead = asString(headRaw);
  const hasExplicitRange = !!(
    (queryBase && !isSyntheticSessionRevision(queryBase))
    || (queryHead && !isSyntheticSessionRevision(queryHead))
  );
  const session = sessionKey ? getSession(ctx, sessionKey) : null;
  if (sessionKey && !session) {
    sendJson(res, { error: 'Session not found' }, 404);
    return;
  }
  const workingDir = session?.workingDir ?? ctx.workingDir;

  // When a session is provided without an explicit SHA range, the diff is
  // exclusively what *this session* changed — session events or session commits.
  // Never fall back to the working tree or HEAD^..HEAD; those are repo-global
  // and would attribute unrelated changes to the session.
  if (session && !hasExplicitRange) {
    const sessionDiff = buildSessionDiffFromEvents(session, file ?? undefined);
    if (sessionDiff && sessionDiff.summary.filesTouched > 0) {
      if (!file || sessionDiff.patch) {
        sendJson(res, {
          baseSha: sessionDiff.baseSha,
          headSha: sessionDiff.headSha,
          source: sessionDiff.source,
          summary: sessionDiff.summary,
          hotspots: sessionDiff.hotspots,
          patch: sessionDiff.patch,
        });
        return;
      }
    }

    // Session has commit lineage — use that as the diff range.
    const range = await resolveDiffRange(session, workingDir, baseRaw, headRaw);
    if (range.baseSha && range.headSha) {
      try {
        const numstat = await execFileText(
          'git',
          ['diff', '--numstat', '--no-color', `${range.baseSha}..${range.headSha}`],
          { cwd: workingDir, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
        );
        const { summary, hotspots } = parseNumstatOutput(numstat);
        let patch: string | null = null;
        if (file) {
          const diffOut = await execFileText(
            'git',
            ['diff', '--no-color', '--unified=3', `${range.baseSha}..${range.headSha}`, '--', file],
            { cwd: workingDir, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
          );
          patch = diffOut.length > 500_000 ? `${diffOut.slice(0, 500_000)}\n\n... (truncated)` : diffOut;
        }
        sendJson(res, {
          baseSha: range.baseSha,
          headSha: range.headSha,
          source: range.source,
          summary,
          hotspots: hotspots.slice(0, 100),
          patch,
        });
      } catch (error) {
        sendJson(res, { error: `Failed to compute diff: ${error instanceof Error ? error.message : String(error)}` }, 500);
      }
      return;
    }

    // Session exists but has no events and no commit lineage — zero diff.
    sendJson(res, {
      baseSha: '',
      headSha: '',
      source: 'session',
      summary: { added: 0, deleted: 0, filesTouched: 0 },
      hotspots: [],
      patch: null,
    });
    return;
  }

  // No session context — resolve from explicit query params or repo state.
  let range = await resolveDiffRange(null, workingDir, baseRaw, headRaw);

  if ((!range.baseSha || !range.headSha) && !hasExplicitRange) {
    const workingTree = await resolveWorkingTreeDiff(workingDir, file ?? undefined);
    if (workingTree) {
      sendJson(res, workingTree);
      return;
    }
  }

  if (!range.baseSha || !range.headSha) {
    const fallbackRange = await resolveRepoHeadRange(workingDir, range.headSha);
    if (fallbackRange) {
      range = {
        baseSha: fallbackRange.baseSha,
        headSha: fallbackRange.headSha,
        source: range.source === 'unknown' ? fallbackRange.source : range.source,
      };
    }
  }
  if (!range.baseSha || !range.headSha) {
    sendJson(res, {
      baseSha: '',
      headSha: '',
      source: 'unknown',
      summary: { added: 0, deleted: 0, filesTouched: 0 },
      hotspots: [],
      patch: null,
    });
    return;
  }

  try {
    const numstat = await execFileText(
      'git',
      ['diff', '--numstat', '--no-color', `${range.baseSha}..${range.headSha}`],
      { cwd: workingDir, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const { summary, hotspots } = parseNumstatOutput(numstat);
    let patch: string | null = null;
    if (file) {
      const diffOut = await execFileText(
        'git',
        ['diff', '--no-color', '--unified=3', `${range.baseSha}..${range.headSha}`, '--', file],
        { cwd: workingDir, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
      );
      patch = diffOut.length > 500_000 ? `${diffOut.slice(0, 500_000)}\n\n... (truncated)` : diffOut;
    }

    sendJson(res, {
      baseSha: range.baseSha,
      headSha: range.headSha,
      source: range.source,
      summary,
      hotspots: hotspots.slice(0, 100),
      patch,
    });
  } catch (error) {
    sendJson(
      res,
      { error: `Failed to compute diff: ${error instanceof Error ? error.message : String(error)}` },
      500
    );
  }
}

export async function handleGetCockpitTestReports(
  res: ServerResponse,
  sessionKey: string | null,
  workItemId: string | null,
  limit: number
): Promise<void> {
  const rows = await withAgentMemorySql(async (sql) => {
    return sql<TestReportRecord[]>`
      SELECT
        id,
        session_key,
        work_item_id,
        verdict,
        categories,
        cases,
        cli_output,
        command,
        coverage,
        mutation_score,
        agent_note,
        duration_ms,
        created_at
      FROM test_reports
      WHERE TRUE
        ${sessionKey ? sql`AND session_key = ${sessionKey}` : sql``}
        ${workItemId ? sql`AND work_item_id = ${workItemId}` : sql``}
      ORDER BY created_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 100))}
    `;
  });

  if (rows === null) {
    sendJson(res, { reports: [], error: 'Agent memory database not available' }, 503);
    return;
  }
  sendJson(res, { reports: rows.map(mapTestReportRow) });
}

export async function handleGetCockpitTestReportById(
  res: ServerResponse,
  testReportId: string
): Promise<void> {
  const rows = await withAgentMemorySql(async (sql) => {
    return sql<TestReportRecord[]>`
      SELECT
        id,
        session_key,
        work_item_id,
        verdict,
        categories,
        cases,
        cli_output,
        command,
        coverage,
        mutation_score,
        agent_note,
        duration_ms,
        created_at
      FROM test_reports
      WHERE id = ${testReportId}
      LIMIT 1
    `;
  });
  if (rows === null) {
    sendJson(res, { report: null, error: 'Agent memory database not available' }, 503);
    return;
  }
  if (rows.length === 0) {
    sendJson(res, { report: null, error: 'Test report not found' }, 404);
    return;
  }
  sendJson(res, { report: mapTestReportRow(rows[0]) });
}

export async function handleGetCockpitRepoLens(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  queryRaw: string | null,
  kindRaw: string | null,
  sessionKey: string | null,
  limit: number
): Promise<void> {
  const q = asString(queryRaw);
  if (!q) {
    sendJson(res, { error: 'Missing required query param: q' }, 400);
    return;
  }
  const normalizedKind = (kindRaw ?? 'all').toLowerCase();
  const kind = normalizedKind === 'defs' || normalizedKind === 'refs' || normalizedKind === 'text'
    ? normalizedKind
    : 'all';
  const session = sessionKey ? getSession(ctx, sessionKey) : null;
  if (sessionKey && !session) {
    sendJson(res, { error: 'Session not found' }, 404);
    return;
  }
  const workingDir = session?.workingDir ?? ctx.workingDir;
  const max = Math.max(1, Math.min(limit, 300));

  const definitionPattern = `\\b(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|def)\\s+${escapeRegExp(q)}`;
  try {
    const defsPromise = kind === 'refs' ? Promise.resolve<RepoLensMatch[]>([]) : runRepoLensQuery(
      workingDir,
      definitionPattern,
      'defs',
      max,
      false
    );
    const textPromise = kind === 'defs' ? Promise.resolve<RepoLensMatch[]>([]) : runRepoLensQuery(
      workingDir,
      q,
      'text',
      max,
      true
    );
    const [defs, text] = await Promise.all([defsPromise, textPromise]);
    const defsKey = new Set(defs.map((item) => `${item.path}:${item.line}`));
    const refs = text.filter((item) => !defsKey.has(`${item.path}:${item.line}`)).map((item) => ({
      ...item,
      kind: 'refs' as const,
    }));
    const textMatches = kind === 'text' || kind === 'all' ? text : [];
    const refsMatches = kind === 'refs' || kind === 'all' ? refs : [];
    const defsMatches = kind === 'defs' || kind === 'all' ? defs : [];
    sendJson(res, {
      query: q,
      kind,
      results: {
        defs: defsMatches.slice(0, max),
        refs: refsMatches.slice(0, max),
        text: textMatches.slice(0, max),
      },
    });
  } catch (error) {
    sendJson(
      res,
      { error: `Repo grep query failed: ${error instanceof Error ? error.message : String(error)}` },
      500
    );
  }
}

export function handleGetCockpitPreview(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  url: string | null,
  sessionKey: string | null
): void {
  const explicitUrl = asString(url);
  if (explicitUrl) {
    sendJson(res, { url: explicitUrl, source: 'query' });
    return;
  }

  if (!sessionKey) {
    sendJson(res, { error: 'Missing preview url. Provide url or sessionKey.' }, 400);
    return;
  }

  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { error: 'Session not found' }, 404);
    return;
  }
  const metadata = session.metadata ?? {};
  const previewUrl = asString(metadata.previewUrl) ?? asString(metadata.preview_url) ?? asString(metadata.url);
  if (!previewUrl) {
    sendJson(res, { error: 'No preview URL found for session' }, 404);
    return;
  }
  sendJson(res, { url: previewUrl, source: 'session' });
}

export async function handleGetCockpitFilesystem(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  projectPathRaw: string | null
): Promise<void> {
  const projectPath = normalizeProjectPathInput(asString(projectPathRaw));
  try {
    const data = await buildCockpitFilesystemRoots(ctx, {
      ...(projectPath ? { projectPath } : {}),
    });
    sendJson(res, data);
  } catch (error) {
    sendJson(
      res,
      { error: `Failed to load cockpit filesystem roots: ${error instanceof Error ? error.message : String(error)}` },
      500
    );
  }
}

export function handleGetCockpitSessionEvents(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string,
  limit: number,
  cursorRaw: string | null
): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { events: [], nextCursor: null, error: 'GraphD not available' });
    return;
  }
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { events: [], nextCursor: null, error: 'Session not found' }, 404);
    return;
  }
  const boundedLimit = clampInteger(limit, 200, 1, 500);
  const messagesResult = ctx.graphd.messagesGet(sessionKey, Math.max(boundedLimit * 2, 200), 0) as {
    messages?: MessageRow[];
  };
  const cursor = cursorRaw ? Number(cursorRaw) : undefined;
  const { events, nextCursor } = buildSessionEvents(
    session,
    messagesResult.messages ?? [],
    boundedLimit,
    Number.isFinite(cursor) ? cursor : undefined
  );
  sendJson(res, { events, nextCursor });
}

export function handleGetCockpitSessionPackets(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string,
  limit: number
): void {
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { packets: [], error: 'Session not found' }, 404);
    return;
  }

  const packets = parsePackets(session.metadata?.packets, session.sessionKey);
  const boundedLimit = clampInteger(limit, 20, 1, 200);
  sendJson(res, { packets: packets.slice(0, boundedLimit) });
}

export async function handleGetCockpitSessionPermissions(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string
): Promise<void> {
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { error: `Session not found: ${sessionKey}` }, 404);
    return;
  }

  const workingDir = session.workingDir ?? ctx.workingDir;
  const state = await ctx.getSessionPermissionState?.(sessionKey, { workingDir })
    ?? normalizeSessionPermissionState({
      ...(isRecord(session.metadata?.permission_state) ? session.metadata?.permission_state : {}),
      ...(isRecord(session.metadata?.permission_flags) ? session.metadata?.permission_flags : {}),
    });
  const settingsFile = await readSessionPermissionSettingsFile(workingDir);

  sendJson(res, {
    sessionKey,
    workingDir,
    rootLabel: nodePath.basename(workingDir),
    state,
    customConfigPath: settingsFile.path,
    customConfigExists: settingsFile.exists,
    customConfigJson: settingsFile.content ?? null,
    ...(settingsFile.error ? { warning: settingsFile.error } : {}),
  });
}

export async function handlePostCockpitSessionPermissions(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string
): Promise<void> {
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: `Session not found: ${sessionKey}` }, 404);
    return;
  }

  const body = await readJsonBody(req);
  const workingDir = session.workingDir ?? ctx.workingDir;
  const profile = asString(body.profile)?.toLowerCase();
  const update: {
    dangerousMode?: boolean;
    allowOutsideRoot?: boolean;
    webSearchEnabled?: boolean;
    writesNoDeletes?: boolean;
    restrictWriteToPaths?: string[] | null;
    reloadPersistentConfig?: boolean;
  } = {};

  if (profile) {
    switch (profile) {
      case 'default':
        update.allowOutsideRoot = false;
        update.webSearchEnabled = true;
        update.writesNoDeletes = false;
        update.restrictWriteToPaths = null;
        break;
      case 'writes_only':
      case 'writes-only':
        update.allowOutsideRoot = false;
        update.webSearchEnabled = true;
        update.writesNoDeletes = true;
        update.restrictWriteToPaths = null;
        break;
      case 'websearch_enabled':
      case 'websearch-enabled':
        update.webSearchEnabled = true;
        update.restrictWriteToPaths = null;
        break;
      case 'outside_root':
      case 'outside-root':
        update.allowOutsideRoot = true;
        update.restrictWriteToPaths = null;
        break;
      case 'custom':
        break;
      default:
        sendJson(res, { success: false, error: `Invalid profile: ${profile}` }, 400);
        return;
    }
  }

  const dangerousMode = asBoolean(body.dangerousMode ?? body.dangerous_mode);
  const allowOutsideRoot = asBoolean(body.allowOutsideRoot ?? body.allow_outside_root);
  const webSearchEnabled = asBoolean(body.webSearchEnabled ?? body.web_search_enabled);
  const writesNoDeletes = asBoolean(body.writesNoDeletes ?? body.writes_no_deletes);
  const restrictWriteToPaths = Array.isArray(body.restrictWriteToPaths)
    ? body.restrictWriteToPaths
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : body.restrictWriteToPaths === null
      ? null
      : undefined;
  if (typeof dangerousMode === 'boolean') update.dangerousMode = dangerousMode;
  if (typeof allowOutsideRoot === 'boolean') update.allowOutsideRoot = allowOutsideRoot;
  if (typeof webSearchEnabled === 'boolean') update.webSearchEnabled = webSearchEnabled;
  if (typeof writesNoDeletes === 'boolean') update.writesNoDeletes = writesNoDeletes;
  if (Array.isArray(restrictWriteToPaths) || restrictWriteToPaths === null) update.restrictWriteToPaths = restrictWriteToPaths;

  const customJson = typeof body.customJson === 'string'
    ? body.customJson
    : typeof body.custom_json === 'string'
      ? body.custom_json
      : undefined;

  if (typeof customJson === 'string') {
    if (Buffer.byteLength(customJson, 'utf8') > SESSION_PERMISSION_SETTINGS_MAX_BYTES) {
      sendJson(res, {
        success: false,
        error: `customJson exceeds ${SESSION_PERMISSION_SETTINGS_MAX_BYTES} bytes`,
      }, 400);
      return;
    }
    const parsedSettings = parsePermissionSettingsText(customJson);
    if (!parsedSettings.ok) {
      sendJson(res, { success: false, error: parsedSettings.error }, 400);
      return;
    }
    const writeResult = await writeSessionPermissionSettingsFile(workingDir, parsedSettings.settings);
    if (!writeResult.ok) {
      sendJson(res, { success: false, error: writeResult.error }, 500);
      return;
    }
    update.reloadPersistentConfig = true;
  }

  const hasUpdate = Object.keys(update).length > 0;
  if (!hasUpdate) {
    sendJson(res, { success: false, error: 'No permission updates provided' }, 400);
    return;
  }

  let state = await ctx.updateSessionPermissionState?.(sessionKey, update, { workingDir }) ?? null;
  if (!state) {
    state = normalizeSessionPermissionState({
      ...(isRecord(session.metadata?.permission_state) ? session.metadata?.permission_state : {}),
      ...(isRecord(session.metadata?.permission_flags) ? session.metadata?.permission_flags : {}),
    });
    if (typeof update.dangerousMode === 'boolean') state.dangerousMode = update.dangerousMode;
    if (typeof update.allowOutsideRoot === 'boolean') state.allowOutsideRoot = update.allowOutsideRoot;
    if (typeof update.webSearchEnabled === 'boolean') state.webSearchEnabled = update.webSearchEnabled;
    if (typeof update.writesNoDeletes === 'boolean') state.writesNoDeletes = update.writesNoDeletes;
    if (Array.isArray(update.restrictWriteToPaths)) state.restrictWriteToPaths = update.restrictWriteToPaths;
    if (update.restrictWriteToPaths === null) delete state.restrictWriteToPaths;
    if (ctx.graphd) {
      const {
        allowOutsideRoot: allowOutsideRootVal,
        webSearchEnabled: webSearchEnabledVal,
        writesNoDeletes: writesNoDeletesVal,
        restrictWriteToPaths: restrictWriteToPathsVal,
        ...permissionState
      } = state;
      ctx.graphd.sessionUpdateMetadata(sessionKey, {
        permission_state: permissionState,
        permission_flags: {
          allowOutsideRoot: allowOutsideRootVal,
          webSearchEnabled: webSearchEnabledVal,
          writesNoDeletes: writesNoDeletesVal,
          ...(Array.isArray(restrictWriteToPathsVal) ? { restrictWriteToPaths: restrictWriteToPathsVal } : {}),
        },
      });
    }
  }

  const settingsFile = await readSessionPermissionSettingsFile(workingDir);
  sendJson(res, {
    success: true,
    sessionKey,
    workingDir,
    rootLabel: nodePath.basename(workingDir),
    state,
    customConfigPath: settingsFile.path,
    customConfigExists: settingsFile.exists,
    customConfigJson: settingsFile.content ?? null,
    ...(settingsFile.error ? { warning: settingsFile.error } : {}),
  });
}

export async function handlePostCockpitPermissionResponse(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  if (!ctx.respondToPermissionRequest) {
    sendJson(res, { success: false, error: 'Permission responses are not available in this daemon context' }, 501);
    return;
  }

  const body = await readJsonBody(req);
  const sessionKey = asString(body.sessionKey ?? body.session_key);
  const requestId = asString(body.requestId ?? body.request_id);
  const decisionRaw = asString(body.decision)?.toLowerCase();
  const decision = decisionRaw === 'allow' || decisionRaw === 'always_allow' || decisionRaw === 'deny'
    ? decisionRaw
    : null;
  const pattern = asString(body.pattern);

  if (!sessionKey) {
    sendJson(res, { success: false, error: 'Missing required field: sessionKey' }, 400);
    return;
  }
  if (!requestId) {
    sendJson(res, { success: false, error: 'Missing required field: requestId' }, 400);
    return;
  }
  if (!decision) {
    sendJson(res, { success: false, error: 'Invalid decision. Expected allow|always_allow|deny' }, 400);
    return;
  }

  const response = await ctx.respondToPermissionRequest(sessionKey, {
    requestId,
    decision,
    ...(typeof pattern === 'string' && pattern.trim().length > 0 ? { pattern: pattern.trim() } : {}),
  });
  if (!response.success) {
    sendJson(res, { success: false, error: response.error ?? 'Failed sending permission response' }, 500);
    return;
  }

  sendJson(res, {
    success: true,
    sessionKey,
    requestId,
    decision,
  });
}

export async function handlePostCockpitPacket(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { success: false, error: 'GraphD not available' }, 503);
    return;
  }

  const body = await readJsonBody(req);
  const sessionKey = asString(body.sessionKey);
  if (!sessionKey) {
    sendJson(res, { success: false, error: 'Missing required field: sessionKey' }, 400);
    return;
  }

  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: `Session not found: ${sessionKey}` }, 404);
    return;
  }

  const { markdown, sourcePath, error } = await loadPacketMarkdown(
    session.workingDir ?? ctx.workingDir,
    body
  );
  if (!markdown || error) {
    sendJson(res, { success: false, error: error ?? 'Missing packet markdown content' }, 400);
    return;
  }
  if (Buffer.byteLength(markdown, 'utf8') > 1_000_000) {
    sendJson(res, { success: false, error: 'Packet markdown exceeds 1MB limit' }, 400);
    return;
  }

  const packetId = asString(body.packetId) ?? buildPacketId();
  const packetTypeResult = parsePacketType(body.type);
  if (packetTypeResult.error) {
    sendJson(res, { success: false, error: packetTypeResult.error }, 400);
    return;
  }
  const packetType = packetTypeResult.type;
  const workItemId = asString(body.workItemId);
  const escalationId = asString(body.escalationId);
  const createdAtIso = new Date(parseTimestampMs(body.createdAt) ?? Date.now()).toISOString();
  const explicitEvidenceIndex = parseEvidenceIndex(body.evidenceIndex);
  const evidenceIndex = explicitEvidenceIndex ?? inferEvidenceIndexFromMarkdown(markdown);
  const validationWarnings = collectPacketValidationWarnings(packetType, evidenceIndex);
  const source = asString(body.source) ?? 'observer';

  const packetRecord: Record<string, unknown> = {
    packetId,
    sessionKey,
    type: packetType,
    createdAt: createdAtIso,
    contentMarkdown: markdown,
    source,
    ...(workItemId ? { workItemId } : {}),
    ...(escalationId ? { escalationId } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(evidenceIndex.length > 0 ? { evidenceIndex } : {}),
    ...(validationWarnings.length > 0 ? { validationWarnings } : {}),
  };

  const packetEvent: Record<string, unknown> = {
    type: 'packet_emitted',
    timestamp: createdAtIso,
    ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
    ...(workItemId ? { work_item_id: workItemId } : {}),
    data: {
      packetId,
      packetType,
      source,
      ...(escalationId ? { escalationId } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(validationWarnings.length > 0 ? { validationWarnings } : {}),
    },
  };

  const metadataUpdate = ctx.graphd!.sessionUpdateMetadata(sessionKey, {
    packets: [packetRecord],
    agent_events: [packetEvent],
  }) as { success?: boolean; error?: string };
  if (!metadataUpdate.success) {
    sendJson(res, { success: false, error: metadataUpdate.error ?? 'Failed to persist packet' }, 500);
    return;
  }

  sendJson(res, { success: true, packet: packetRecord }, 201);
}

export async function handleResolveCockpitEscalation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext,
  escalationId: string
): Promise<void> {
  if (!ctx.resolveSessionEscalation) {
    sendJson(res, { success: false, error: 'Escalation resolution not available in this daemon context' }, 501);
    return;
  }

  const body = await readJsonBody(req);
  const { sessions, error } = getAllSessions(ctx, 1000);
  if (error) {
    sendJson(res, { success: false, error }, 500);
    return;
  }

  const ownerSession = sessions.find((session) =>
    getEscalations(session).some((item) => item.id === escalationId));
  if (!ownerSession) {
    sendJson(res, { success: false, error: `Escalation not found: ${escalationId}` }, 404);
    return;
  }

  const resolvedBy = body.resolvedBy === 'system' || body.resolvedBy === 'timeout'
    ? body.resolvedBy
    : 'user';
  const resolution: EscalationResolutionInput = {
    ...(asString(body.optionId) ? { optionId: asString(body.optionId) } : {}),
    ...(asString(body.freeformResponse) || asString(body.note)
      ? { freeformResponse: asString(body.freeformResponse) ?? asString(body.note) }
      : {}),
    resolvedBy,
  };

  const result = await ctx.resolveSessionEscalation(ownerSession.sessionKey, escalationId, resolution);
  if (!result.success) {
    sendJson(res, { success: false, error: result.error ?? 'Failed to resolve escalation' }, 400);
    return;
  }

  const updatedSession = getSession(ctx, ownerSession.sessionKey);
  const updatedEscalation = updatedSession
    ? getEscalations(updatedSession).find((item) => item.id === escalationId)
    : null;

  sendJson(res, {
    success: true,
    escalation: updatedEscalation ?? {
      id: escalationId,
      sessionKey: ownerSession.sessionKey,
      status: 'resolved',
    },
    result,
  });
}

export async function handleGetCockpitTemplates(res: ServerResponse): Promise<void> {
  const rows = await withAgentMemorySql(async (sql) => {
    return sql`
      SELECT id, name, description, specs, created_at, updated_at
      FROM workitem_templates
      ORDER BY name ASC
    `;
  });

  if (!rows) {
    sendJson(res, { templates: [] });
    return;
  }

  const templates = (rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    specs: typeof row.specs === 'string' ? JSON.parse(row.specs as string) : (row.specs ?? []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  sendJson(res, { templates });
}

export async function handlePostCockpitSessionCreate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { success: false, error: 'GraphD not available' }, 503);
    return;
  }

  const body = await readJsonBody(req);
  const goal = asString(body.goal);
  const markdownPath = asString(body.markdownPath);
  const projectPathInput = normalizeProjectPathInput(asString(body.projectPath) ?? asString(body.project_path));
  const createProjectPath = asBoolean(body.createProjectPath ?? body.create_project_path) === true;
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const metadataSource = (asString(metadata.source) ?? '').toLowerCase();
  const documentScopedSession = metadataSource === 'cockpit-document';
  const path = await import('path');
  const fs = await import('fs/promises');
  let workingDir = path.resolve(ctx.workingDir);

  if (projectPathInput) {
    const resolvedProjectPath = path.isAbsolute(projectPathInput)
      ? path.resolve(projectPathInput)
      : path.resolve(ctx.workingDir, projectPathInput);
    try {
      const stat = await fs.stat(resolvedProjectPath);
      if (!stat.isDirectory()) {
        sendJson(res, {
          success: false,
          error: `projectPath is not a directory: ${resolvedProjectPath}`,
        }, 400);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('enoent') && createProjectPath) {
        try {
          await fs.mkdir(resolvedProjectPath, { recursive: true });
        } catch (mkdirError) {
          sendJson(res, {
            success: false,
            error: `Failed creating projectPath: ${mkdirError instanceof Error ? mkdirError.message : String(mkdirError)}`,
          }, 400);
          return;
        }
      } else if (message.toLowerCase().includes('enoent')) {
        sendJson(res, {
          success: false,
          error: `projectPath not found: ${resolvedProjectPath}`,
        }, 404);
        return;
      } else {
        sendJson(res, {
          success: false,
          error: `Unable to access projectPath: ${message}`,
        }, 400);
        return;
      }
    }
    workingDir = resolvedProjectPath;
  }

  const sessionKey = `cockpit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const result = ctx.graphd.sessionCreate(
    sessionKey,
    'cockpit',
    workingDir,
    undefined,
    {
      ...metadata,
      ...(markdownPath ? { markdownPath } : {}),
      ...(projectPathInput ? { projectPath: workingDir } : {}),
      cwd: workingDir,
    }
  ) as { success?: boolean; error?: string };

  if (!result.success) {
    sendJson(res, { success: false, error: result.error ?? 'Failed to create session' }, 500);
    return;
  }

  if (goal) {
    try {
      (ctx.graphd as any).sessionSetGoalIfEmpty(sessionKey, goal);
    } catch {
      // Goal setting is best-effort
    }
  }

  // Default: cockpit sessions are dangerous unless they originate from document chat.
  try {
    const resolvedMarkdownPath = markdownPath
      ? (
        path.isAbsolute(markdownPath)
          ? path.resolve(markdownPath)
          : path.resolve(workingDir, markdownPath)
      )
      : null;
    const documentWriteTargets = documentScopedSession && resolvedMarkdownPath
      ? [resolvedMarkdownPath]
      : undefined;
    const documentWriteOutsideRoot = !!(
      documentScopedSession
      && resolvedMarkdownPath
      && resolvedMarkdownPath !== workingDir
      && !resolvedMarkdownPath.startsWith(`${workingDir}${path.sep}`)
    );
    if (ctx.updateSessionPermissionState) {
      await ctx.updateSessionPermissionState(
        sessionKey,
        {
          dangerousMode: !documentScopedSession,
          ...(documentScopedSession ? { allowOutsideRoot: documentWriteOutsideRoot } : {}),
          ...(documentWriteTargets ? { restrictWriteToPaths: documentWriteTargets } : {}),
        },
        { workingDir }
      );
    } else if (ctx.graphd) {
      ctx.graphd.sessionUpdateMetadata(sessionKey, {
        permission_state: { dangerousMode: !documentScopedSession },
        permission_flags: {
          ...(documentScopedSession ? { allowOutsideRoot: documentWriteOutsideRoot } : {}),
          ...(documentWriteTargets ? { restrictWriteToPaths: documentWriteTargets } : {}),
        },
      });
    }
  } catch {
    // Permission setup is best-effort
  }

  sendJson(res, {
    success: true,
    sessionKey,
    workingDir,
  });
}

// ── async session management ────────────────────────────────────────

export async function handlePostCockpitSessionAsyncStart(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string
): Promise<void> {
  if (!ctx.startSessionAsync) {
    sendJson(res, { success: false, error: 'Async start not available in this daemon context' }, 501);
    return;
  }

  const body = await readJsonBody(req);
  const goal = asString(body.goal);
  if (!goal) {
    sendJson(res, { success: false, error: 'Missing goal' }, 400);
    return;
  }

  const result = await ctx.startSessionAsync(sessionKey, goal);
  if (!result.success) {
    sendJson(res, { success: false, error: result.error ?? 'Failed to start async session' }, 400);
    return;
  }

  sendJson(res, result);
}

export async function handlePostCockpitSessionAsyncCancel(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string
): Promise<void> {
  if (!ctx.cancelSessionAsync) {
    sendJson(res, { success: false, error: 'Async cancel not available in this daemon context' }, 501);
    return;
  }

  const result = await ctx.cancelSessionAsync(sessionKey);
  if (!result.success) {
    sendJson(res, { success: false, error: result.error ?? 'Failed to cancel async session' }, 400);
    return;
  }

  sendJson(res, { success: true });
}

export async function handleGetCockpitSessionAsyncStatus(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string
): Promise<void> {
  if (!ctx.getSessionAsyncStatus) {
    sendJson(res, { success: false, error: 'Async status not available in this daemon context' }, 501);
    return;
  }

  const result = await ctx.getSessionAsyncStatus(sessionKey);
  sendJson(res, result);
}

// ── architecture ────────────────────────────────────────────────────

export async function handleGetCockpitArchitectureOverview(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string | null,
  runId: string | null,
  concernLimitRaw: number,
  boundaryLimitRaw: number,
  alertLimitRaw: number
): Promise<void> {
  if (!sessionKey) {
    sendJson(res, { error: 'sessionKey is required' }, 400);
    return;
  }

  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(
      res,
      {
        runId: null,
        generatedAt: new Date().toISOString(),
        touched: { totalFiles: 0, readFiles: 0, editedFiles: 0 },
        concerns: [],
        boundaries: [],
        alerts: [],
      }
    );
    return;
  }

  const concernLimit = clampInteger(concernLimitRaw, 8, 1, 40);
  const boundaryLimit = clampInteger(boundaryLimitRaw, 12, 1, 80);
  const alertLimit = clampInteger(alertLimitRaw, 20, 1, 200);
  const workingDir = session.workingDir ?? ctx.workingDir;
  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];
  const sessionFiles = extractSessionFiles(agentEvents, { workingDir });

  const overview = await withAgentMemorySql(async (sql) => {
    return loadCockpitArchitectureOverviewFromSql({
      sql,
      workingDir,
      sessionFiles,
      ...(runId ? { runId } : {}),
      concernLimit,
      boundaryLimit,
      alertLimit,
    });
  });

  if (overview === null) {
    sendJson(
      res,
      {
        runId: null,
        generatedAt: new Date().toISOString(),
        touched: { totalFiles: 0, readFiles: 0, editedFiles: 0 },
        concerns: [],
        boundaries: [],
        alerts: [],
        error: 'Agent memory database not available',
      },
      503
    );
    return;
  }

  sendJson(res, overview);
}

export async function handleGetCockpitArchitectureAlerts(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  input: {
    sessionKey?: string | null;
    runId?: string | null;
    status?: string | null;
    severity?: string | null;
    type?: string | null;
    limit?: number;
  }
): Promise<void> {
  let sessionContext: ReturnType<typeof buildSessionArchitectureContext> | undefined;
  if (input.sessionKey) {
    const session = getSession(ctx, input.sessionKey);
    if (!session) {
      sendJson(res, { runId: null, alerts: [], error: 'Session not found' }, 404);
      return;
    }
    const workingDir = session.workingDir ?? ctx.workingDir;
    const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];
    const sessionFiles = extractSessionFiles(agentEvents, { workingDir });
    sessionContext = buildSessionArchitectureContext(sessionFiles, workingDir);
  }

  const status = parseArchitectureAlertStatus(input.status ?? null);
  if (input.status && !status) {
    sendJson(res, { error: 'Invalid status. Allowed: open, acknowledged, resolved' }, 400);
    return;
  }

  const severity = parseArchitectureAlertSeverity(input.severity ?? null);
  if (input.severity && !severity) {
    sendJson(res, { error: 'Invalid severity. Allowed: low, medium, high, critical' }, 400);
    return;
  }

  const limit = clampInteger(input.limit ?? 200, 200, 1, 500);
  const result = await withAgentMemorySql(async (sql) => {
    return loadCockpitArchitectureAlertsFromSql({
      sql,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
      ...(input.type ? { type: input.type } : {}),
      limit,
      ...(sessionContext ? { sessionContext } : {}),
    });
  });

  if (result === null) {
    sendJson(res, { runId: null, alerts: [], error: 'Agent memory database not available' }, 503);
    return;
  }

  sendJson(res, result);
}

// ── entity graph ────────────────────────────────────────────────────

export async function handleGetCockpitEntityGraph(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string | null,
  workItemId: string | null
): Promise<void> {
  if (!sessionKey) {
    sendJson(res, { error: 'sessionKey is required' }, 400);
    return;
  }

  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { nodes: [], edges: [], stats: { readFiles: 0, editedFiles: 0, totalNodes: 0, totalEdges: 0 } });
    return;
  }

  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];
  const sessionFiles = extractSessionFiles(agentEvents, {
    workingDir: session.workingDir ?? ctx.workingDir,
    ...(workItemId ? { workItemId } : {}),
  });

  if (sessionFiles.length === 0) {
    sendJson(res, { nodes: [], edges: [], stats: { readFiles: 0, editedFiles: 0, totalNodes: 0, totalEdges: 0 } });
    return;
  }

  const result = await withAgentMemorySql<SubgraphResponse>(async (sql) => {
    return buildSubgraph(sql, sessionFiles);
  });

  sendJson(res, result ?? { nodes: [], edges: [], stats: { readFiles: 0, editedFiles: 0, totalNodes: 0, totalEdges: 0 } });
}

// ── session model selection ─────────────────────────────────────────

export async function handleGetCockpitSessionModel(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string
): Promise<void> {
  if (!ctx.getSessionModelSelections) {
    sendJson(res, { error: 'Model selection not available' }, 503);
    return;
  }
  const result = await ctx.getSessionModelSelections(sessionKey);
  const models = getAllModels().map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    reasoning: m.reasoning,
  }));
  sendJson(res, { selections: result.selections, models });
}

export async function handlePostCockpitSessionModel(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string
): Promise<void> {
  if (!ctx.setSessionModelSelection) {
    sendJson(res, { error: 'Model selection not available' }, 503);
    return;
  }
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, { error: 'Invalid JSON body' }, 400);
    return;
  }
  const provider = asString(body.provider);
  const model = asString(body.model);
  const agentType = asString(body.agentType) ?? 'standard';
  const reasoning = asString(body.reasoning);
  if (!provider || !model) {
    sendJson(res, { error: 'provider and model are required' }, 400);
    return;
  }
  const selection = reasoning ? { provider, model, reasoning } : { provider, model };
  const result = await ctx.setSessionModelSelection(sessionKey, agentType, selection);
  sendJson(res, result);
}
