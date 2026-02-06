/**
 * Shared utility types, interfaces, constants, and helper functions
 * extracted from control_plane_routes.ts.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import nodePath from 'path';
import type { SessionPermissionState, PermissionSettings, PermissionRule } from 'types';
import type {
  EscalationResolutionInput,
  SessionEscalationRecord,
} from '../escalation_state.js';

// ── promisified exec helpers ────────────────────────────────────────

export const execAsync = promisify(exec);
export const execFileAsync = promisify(execFile);

// ── interfaces & types ──────────────────────────────────────────────

export type SessionPermissionStateView = SessionPermissionState & {
  allowOutsideRoot: boolean;
  webSearchEnabled: boolean;
  writesNoDeletes: boolean;
};

export interface ControlPlaneContext {
  graphd: import('graphd').GraphDManager | null;
  isGraphDReady: () => boolean;
  workingDir: string;
  getSessionPermissionState?: (
    sessionKey: string,
    options?: { workingDir?: string }
  ) => SessionPermissionStateView | null;
  updateSessionPermissionState?: (
    sessionKey: string,
    input: {
      dangerousMode?: boolean;
      allowOutsideRoot?: boolean;
      webSearchEnabled?: boolean;
      writesNoDeletes?: boolean;
      reloadPersistentConfig?: boolean;
    },
    options?: { workingDir?: string }
  ) => SessionPermissionStateView | null;
  dispatchSessionInput?: (
    sessionKey: string,
    message: string,
    options?: {
      context?: string;
      metadata?: Record<string, unknown>;
    }
  ) => {
    success: boolean;
    requestId?: string;
    queued?: boolean;
    error?: string;
  };
  stopSession?: (
    sessionKey: string,
    note?: string
  ) => {
    success: boolean;
    requestId?: string;
    error?: string;
  };
  forkSession?: (
    sourceSessionKey: string,
    targetSessionKey?: string
  ) => {
    success: boolean;
    targetSessionKey?: string;
    error?: string;
  };
  subscribeEvents?: (handler: (event: { type: string; sessionKey?: string }) => void) => () => void;
  resolveSessionEscalation?: (
    sessionKey: string,
    escalationId: string,
    resolution: EscalationResolutionInput
  ) => {
    success: boolean;
    escalationId: string;
    pendingCount?: number;
    sessionStatus?: string;
    resumed?: boolean;
    resumeRequestId?: string;
    alreadyResolved?: boolean;
    error?: string;
  };
  getDebugMemoryInfo?: () => {
    sessionCount: number;
    maxSessions: number;
    sessions: Array<{
      sessionKey: string;
      contextItemCount: number;
      contextEstimatedTokens: number;
      watcherContextItemCount: number;
      workItemLogCount: number;
      workItemsCreatedCount: number;
      lastAccessMs: number;
      isExecuting: boolean;
    }>;
  };
}

export interface PRInfo {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName?: string;
  baseRefName?: string;
  body?: string;
}

export interface GitRemote {
  owner: string;
  repo: string;
}

export interface GitCommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface SessionRow {
  sessionKey: string;
  clientType: string;
  workingDir: string | null;
  status: string;
  createdAt: number;
  lastAccessedAt: number;
  goal?: string | null;
  currentWorkItemId?: string | null;
  currentObjective?: string | null;
  lastUserMessagePreview?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MessageRow {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export type SessionPanelStatus = 'running' | 'blocked' | 'ready' | 'done' | 'stopped';
export type SessionKind = 'feature' | 'issue' | 'refactor' | 'system';

export interface SessionRollup {
  sessionKey: string;
  kind: SessionKind;
  title: string;
  status: SessionPanelStatus;
  activeWorkItemId?: string;
  elapsedSec: number;
  lastEventAt: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  currentActivity: {
    tool: string;
    file?: string;
    line?: number;
  };
  gates: {
    testsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsStatus: 'pass' | 'fail' | 'running' | 'unknown';
    invariantsPassed: number;
    invariantsTotal: number;
  };
  blocking: {
    unresolvedEscalationsCount: number;
  };
}

export interface EscalationRollup {
  escalationId: string;
  sessionKey: string;
  workItemId?: string;
  createdAt: string;
  ageSec: number;
  headline: string;
  requestedDecision: 'choose' | 'approve' | 'clarify' | 'permission' | 'stop' | 'unknown';
  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
}

export interface FocusPacket {
  packetId: string;
  sessionKey: string;
  workItemId?: string;
  type: 'escalation' | 'review' | 'session';
  createdAt: string;
  contentMarkdown: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  validationWarnings?: string[];
}

export interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
  signalPriority?: 'high' | 'medium' | 'low' | 'status';
  isStatusOnly?: boolean;
}

export interface TraceSummary {
  filesTouched: number;
  lastFile?: string;
  lastLine?: number;
  latestTimestampMs?: number;
}

export interface TestReportSummary {
  sessionKey: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  createdAtMs: number;
  invariantsPassed?: number;
  invariantsTotal?: number;
}

export interface CommitRollup {
  sha: string;
  message: string;
  author: string;
  time: string;
  diffstat: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
  baseSha?: string;
  headSha?: string;
}

export interface PRRollup {
  prId: string;
  number: number;
  title: string;
  status: 'open' | 'closed' | 'merged';
  ciStatus: 'pass' | 'fail' | 'running' | 'unknown';
  author: string;
  url: string;
  updatedAt: string;
  projectPath: string;
  sessionKey?: string;
  workItemId?: string;
}

export interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
  lineRanges?: Array<{ start: number; end: number; added: number; deleted: number }>;
}

export interface RepoLensMatch {
  kind: 'defs' | 'refs' | 'text';
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface TestReportRecord {
  id: string;
  session_key: string;
  work_item_id: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  categories: unknown[];
  cases: unknown[];
  cli_output: string | null;
  command: string | null;
  coverage: Record<string, unknown> | null;
  mutation_score: number | null;
  agent_note: string | null;
  duration_ms: number | null;
  created_at: Date | string | number;
}

export const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;

export interface SessionCommitEvent {
  sha: string;
  headSha: string;
  baseSha?: string;
  timestampMs: number;
  sessionKey: string;
  workItemId?: string;
}

export interface PatchEditInput {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface SessionFileModification {
  path: string;
  toolName: 'edit' | 'write';
  timestampMs: number;
  requestId?: string;
  workItemId?: string;
  oldContent?: string;
  newContent?: string;
  content?: string;
}

export interface SessionDiffLineRange {
  start: number;
  end: number;
  added: number;
  deleted: number;
}

export type BrowserActionName =
  | 'open'
  | 'back'
  | 'forward'
  | 'reload'
  | 'snapshot'
  | 'click'
  | 'fill'
  | 'type'
  | 'press'
  | 'wait'
  | 'scroll'
  | 'get_url'
  | 'get_title'
  | 'screenshot'
  | 'close';

export interface BrowserActionInput {
  action: BrowserActionName;
  target?: string;
  text?: string;
  url?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  waitMs?: number;
  label?: string;
}

export interface BrowserActionResult {
  success: boolean;
  action: BrowserActionName;
  args: string[];
  stdout?: string;
  data?: unknown;
  error?: string;
  artifactPath?: string;
}

export interface BrowserRunbookStep {
  line: number;
  input: BrowserActionInput;
}

export interface BrowserEvidenceItem {
  id: string;
  type: 'screenshot' | 'snapshot';
  path: string;
  createdAt: string;
  label?: string;
  url?: string;
  title?: string;
}

export interface CockpitDailyMetricsResult {
  date: string;
  metrics: {
    tokens: number;
    locTouched: number;
    commits: number;
    prs: number;
    tests: number;
    sessions: {
      running: number;
      ready: number;
      done: number;
    };
    escalationsOpen: number;
  } | null;
  error?: string;
}

export interface CockpitRollupSnapshotResult {
  runningSessions: SessionRollup[];
  readySessions: SessionRollup[];
  doneSessions: SessionRollup[];
  escalations: EscalationRollup[];
  commitRollups: CommitRollup[];
  prRollups: PRRollup[];
  metrics: CockpitDailyMetricsResult['metrics'];
  metricsDate: string;
  generatedAt: string;
  error?: string;
}

export type MarkdownWorkspaceScopeMode = 'global' | 'session' | 'project';

export interface MarkdownWorkspaceScope {
  mode: MarkdownWorkspaceScopeMode;
  workingDir: string;
  sessionKey?: string;
  projectPath?: string;
}

export interface CockpitFilesystemRootRecord {
  id: string;
  kind: 'notes' | 'project';
  label: string;
  path: string;
  pinned: boolean;
  source: 'daemon' | 'session-db' | 'discovered';
  sessionCount?: number;
  sessionKey?: string;
}

// ── module-level caches ─────────────────────────────────────────────

export const prCache = new Map<string, { data: PRInfo[]; fetchedAt: number }>();
export const PR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const gitRemoteCache = new Map<string, { data: GitRemote | null; fetchedAt: number }>();
export const GIT_CACHE_TTL_MS = 60 * 1000; // 1 minute

export let cockpitSnapshotCache:
  | { key: string; expiresAt: number; data: CockpitRollupSnapshotResult }
  | null = null;

export function setCockpitSnapshotCache(
  value: { key: string; expiresAt: number; data: CockpitRollupSnapshotResult } | null
): void {
  cockpitSnapshotCache = value;
}

export const ALL_SESSION_STATUSES = [
  'active',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
  'inactive',
  'expired',
] as const;

// ── markdown constants ──────────────────────────────────────────────

export const MARKDOWN_WORKSPACE_DIR = '.cockpit/markdown';
export const MARKDOWN_METADATA_DIR = '.meta';
export const MARKDOWN_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
export const MARKDOWN_SUGGESTED_FOLDERS = ['notes', 'packets', 'plans', 'scratch', 'specs', 'handoffs'];
export const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
export const MARKDOWN_METADATA_MAX_BYTES = 64 * 1024;
export const MARKDOWN_CHAT_CONTEXT_MAX_BYTES = 120 * 1024;
export const COCKPIT_PROJECT_DISCOVERY_MAX_RESULTS = 40;
export const COCKPIT_PROJECT_DISCOVERY_MAX_DEPTH = 3;
export const COCKPIT_SNAPSHOT_CACHE_TTL_MS = 1_500;
export const SESSION_PERMISSION_SETTINGS_RELATIVE_PATH = '.jesus/settings.local.json';
export const SESSION_PERMISSION_SETTINGS_MAX_BYTES = 256 * 1024;

// ── generic utility functions ───────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item))
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
    if (parts.length === 0) return undefined;
    return parts.join('\n').trim();
  }
  if (!isRecord(value)) return undefined;
  return (
    extractText(value.text)
    ?? extractText(value.content)
    ?? extractText(value.message)
    ?? extractText(value.chunk)
    ?? extractText(value.response)
    ?? extractText(value.output)
  );
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  return { pathname: url.pathname, query: url.searchParams };
}

export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function formatSession(row: SessionRow) {
  const createdAt = row.createdAt ? new Date(row.createdAt * 1000).toISOString() : null;
  const lastAccessedAt = row.lastAccessedAt ? new Date(row.lastAccessedAt * 1000).toISOString() : null;
  return {
    id: row.sessionKey,
    clientType: row.clientType,
    workingDir: row.workingDir,
    status: row.status,
    createdAt,
    lastAccessedAt,
    metadata: row.metadata,
  };
}

export function formatMessage(row: MessageRow) {
  const createdAt = row.createdAt ? new Date(row.createdAt * 1000).toISOString() : null;
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    requestId: row.requestId,
    createdAt,
    metadata: row.metadata,
  };
}

export function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    if (!Number.isNaN(ts)) return ts;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
  }
  return undefined;
}

export function toStringOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

export async function execFileText(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; maxBuffer?: number }
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    timeout: options?.timeout ?? 15_000,
    maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024,
    encoding: 'utf8',
  } as any);
  return toStringOutput((result as any).stdout);
}

export function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

export function shaMatches(left: string, right: string): boolean {
  const a = normalizeSha(left);
  const b = normalizeSha(right);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isLockfilePath(filePath: string): boolean {
  const name = filePath.trim().toLowerCase();
  return (
    name.endsWith('/package-lock.json') || name === 'package-lock.json'
    || name.endsWith('/yarn.lock') || name === 'yarn.lock'
    || name.endsWith('/pnpm-lock.yaml') || name === 'pnpm-lock.yaml'
    || name.endsWith('/bun.lock') || name === 'bun.lock'
    || name.endsWith('/bun.lockb') || name === 'bun.lockb'
    || name.endsWith('/cargo.lock') || name === 'cargo.lock'
  );
}

export function normalizeDiffPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const withoutPrefix = trimmed.startsWith('a/') || trimmed.startsWith('b/')
    ? trimmed.slice(2)
    : trimmed;
  return withoutPrefix.replace(/^"+|"+$/g, '');
}

export function clampInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Strip markdown headings, leading whitespace, and truncate */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+\S+\s*/gm, '')  // strip "## Goal", "# Title" etc.
    .replace(/^\s+/, '')                  // trim leading whitespace/newlines
    .replace(/\n+/g, ' ')                // collapse newlines into spaces
    .slice(0, 200)
    .trim();
}

export function readNumberCandidate(candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const parsed = asNumber(candidate);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readArrayLengthCandidate(candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.length;
  }
  return undefined;
}

// ── permission utility functions ────────────────────────────────────

export function sanitizePermissionRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  const rules: PermissionRule[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const toolRaw = asString(entry.tool);
    const pattern = asString(entry.pattern);
    if (!toolRaw || !pattern) continue;
    if (toolRaw !== 'Bash' && toolRaw !== 'Write' && toolRaw !== 'Edit') continue;
    rules.push({ tool: toolRaw, pattern });
  }
  return rules;
}

export function normalizeSessionPermissionState(value: unknown): SessionPermissionStateView {
  const record = isRecord(value) ? value : {};
  const persistent = isRecord(record.persistent) ? record.persistent : {};
  return {
    persistent: {
      allow: sanitizePermissionRules(persistent.allow),
      deny: sanitizePermissionRules(persistent.deny),
    },
    sessionGrants: sanitizePermissionRules(record.sessionGrants),
    sessionDenials: sanitizePermissionRules(record.sessionDenials),
    dangerousMode: asBoolean(record.dangerousMode) === true,
    allowOutsideRoot: asBoolean(record.allowOutsideRoot) === true,
    webSearchEnabled: asBoolean(record.webSearchEnabled) !== false,
    writesNoDeletes: asBoolean(record.writesNoDeletes) === true,
  };
}

export function normalizePermissionSettings(value: unknown): PermissionSettings | null {
  if (!isRecord(value)) return null;
  const permissionsRecord = isRecord(value.permissions)
    ? value.permissions
    : value;
  const allow = asStringArray(permissionsRecord.allow)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const deny = asStringArray(permissionsRecord.deny)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return {
    permissions: { allow, deny },
  };
}

export function parsePermissionSettingsText(text: string): { ok: true; settings: PermissionSettings } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(text) as unknown;
    const normalized = normalizePermissionSettings(parsed);
    if (!normalized) {
      return { ok: false, error: 'Custom JSON must be an object with permissions.allow and permissions.deny arrays' };
    }
    return { ok: true, settings: normalized };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function readSessionPermissionSettingsFile(workingDir: string): Promise<{
  path: string;
  exists: boolean;
  content?: string;
  error?: string;
}> {
  const absolutePath = nodePath.join(nodePath.resolve(workingDir), SESSION_PERMISSION_SETTINGS_RELATIVE_PATH);
  const fs = await import('fs/promises');
  try {
    const content = await fs.readFile(absolutePath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > SESSION_PERMISSION_SETTINGS_MAX_BYTES) {
      return {
        path: absolutePath,
        exists: true,
        error: `Permission settings file exceeds ${SESSION_PERMISSION_SETTINGS_MAX_BYTES} bytes`,
      };
    }
    return {
      path: absolutePath,
      exists: true,
      content,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('enoent')) {
      return { path: absolutePath, exists: false };
    }
    return {
      path: absolutePath,
      exists: false,
      error: `Failed reading custom permission settings: ${message}`,
    };
  }
}

export async function writeSessionPermissionSettingsFile(workingDir: string, settings: PermissionSettings): Promise<{
  ok: true;
  path: string;
} | {
  ok: false;
  error: string;
}> {
  const absolutePath = nodePath.join(nodePath.resolve(workingDir), SESSION_PERMISSION_SETTINGS_RELATIVE_PATH);
  const fs = await import('fs/promises');
  try {
    await fs.mkdir(nodePath.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return { ok: true, path: absolutePath };
  } catch (error) {
    return {
      ok: false,
      error: `Failed writing custom permission settings: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── session status/kind mappers ─────────────────────────────────────

export function mapSessionStatus(status: string): SessionPanelStatus {
  if (status === 'blocked') return 'blocked';
  if (status === 'review') return 'ready';
  if (status === 'cancelled') return 'stopped';
  if (status === 'completed' || status === 'failed' || status === 'inactive' || status === 'expired') {
    return 'done';
  }
  return 'running';
}

export function mapSessionKind(session: SessionRow): SessionKind {
  const metadata = session.metadata ?? {};
  const rawKind = asString(metadata.kind)
    ?? asString(metadata.session_kind)
    ?? asString(metadata.workflow_kind)
    ?? asString(metadata.work_kind);
  if (rawKind === 'feature' || rawKind === 'issue' || rawKind === 'refactor' || rawKind === 'system') {
    return rawKind;
  }

  const goal = (session.goal ?? asString(metadata.goal) ?? '').toLowerCase();
  if (goal.includes('fix') || goal.includes('bug') || goal.includes('issue')) return 'issue';
  if (goal.includes('refactor')) return 'refactor';
  if (goal.includes('feature') || goal.includes('implement')) return 'feature';
  return 'system';
}

export function mapGateStatus(value: unknown): 'pass' | 'fail' | 'running' | 'unknown' {
  const normalized = asString(value)?.toLowerCase();
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'success') return 'pass';
  if (normalized === 'fail' || normalized === 'failed' || normalized === 'error') return 'fail';
  if (normalized === 'running' || normalized === 'in_progress') return 'running';
  return 'unknown';
}

// ── token parsing ───────────────────────────────────────────────────

export function parseAgentEventTokenTotalsForDay(
  metadata: Record<string, unknown> | undefined,
  startMs: number,
  endMs: number
): number {
  const events = Array.isArray(metadata?.agent_events) ? metadata.agent_events : [];
  let total = 0;
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'llm_call') continue;
    const ts = parseTimestampMs(entry.timestamp);
    if (!ts || ts < startMs || ts >= endMs) continue;
    const data = isRecord(entry.data) ? entry.data : {};
    const prompt = asNumber(data.prompt_tokens ?? data.promptTokens) ?? 0;
    const completion = asNumber(data.completion_tokens ?? data.completionTokens) ?? 0;
    total += prompt + completion;
  }
  return total;
}

// ── database helper ─────────────────────────────────────────────────

export async function withAgentMemorySql<T>(
  fn: (sql: any) => Promise<T>
): Promise<T | null> {
  const dbUrl = process.env.DATABASE_URL ?? process.env.ENTITY_GRAPH_DATABASE_URL;
  if (!dbUrl) return null;
  try {
    const postgresModule = await import('postgres');
    const postgres = postgresModule.default as any;
    const sql = postgres(dbUrl, { max: 1, idle_timeout: 5, connect_timeout: 5 });
    try {
      return await fn(sql);
    } finally {
      await sql.end({ timeout: 1 });
    }
  } catch {
    return null;
  }
}
