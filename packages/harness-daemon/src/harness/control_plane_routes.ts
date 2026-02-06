/**
 * Control Plane API Routes for harness-daemon
 *
 * Provides REST endpoints for the Control Plane dashboard:
 * - Project/Session listing (from GraphD)
 * - Goal hierarchy (placeholder)
 * - Git integration via gh CLI
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { GraphDManager } from 'graphd';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import nodePath from 'path';
import {
  parseSessionEscalations,
  type EscalationResolutionInput,
  type SessionEscalationRecord,
} from './escalation_state.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface ControlPlaneContext {
  graphd: GraphDManager | null;
  isGraphDReady: () => boolean;
  workingDir: string;
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
}

interface PRInfo {
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

interface GitRemote {
  owner: string;
  repo: string;
}

interface GitCommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

interface SessionRow {
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

interface MessageRow {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

type SessionPanelStatus = 'running' | 'blocked' | 'ready' | 'done' | 'stopped';
type SessionKind = 'feature' | 'issue' | 'refactor' | 'system';

interface SessionRollup {
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

interface EscalationRollup {
  escalationId: string;
  sessionKey: string;
  workItemId?: string;
  createdAt: string;
  ageSec: number;
  headline: string;
  requestedDecision: 'choose' | 'approve' | 'clarify' | 'permission' | 'stop' | 'unknown';
  refs: Array<{ type: string; label: string; target: string; preview?: string }>;
}

interface FocusPacket {
  packetId: string;
  sessionKey: string;
  workItemId?: string;
  type: 'escalation' | 'review' | 'session';
  createdAt: string;
  contentMarkdown: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  validationWarnings?: string[];
}

interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
  signalPriority?: 'high' | 'medium' | 'low' | 'status';
  isStatusOnly?: boolean;
}

interface TraceSummary {
  filesTouched: number;
  lastFile?: string;
  lastLine?: number;
  latestTimestampMs?: number;
}

interface TestReportSummary {
  sessionKey: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  createdAtMs: number;
  invariantsPassed?: number;
  invariantsTotal?: number;
}

interface CommitRollup {
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

interface PRRollup {
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

interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
  lineRanges?: Array<{ start: number; end: number; added: number; deleted: number }>;
}

interface RepoLensMatch {
  kind: 'defs' | 'refs' | 'text';
  path: string;
  line: number;
  column: number;
  preview: string;
}

interface TestReportRecord {
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

const PACKET_REF_REGEX = /@([a-zA-Z]+)\(([^)]+)\)/g;

interface SessionCommitEvent {
  sha: string;
  headSha: string;
  baseSha?: string;
  timestampMs: number;
  sessionKey: string;
  workItemId?: string;
}

interface PatchEditInput {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

interface SessionFileModification {
  path: string;
  toolName: 'edit' | 'write';
  timestampMs: number;
  requestId?: string;
  workItemId?: string;
  oldContent?: string;
  newContent?: string;
  content?: string;
}

interface SessionDiffLineRange {
  start: number;
  end: number;
  added: number;
  deleted: number;
}

type BrowserActionName =
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

interface BrowserActionInput {
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

interface BrowserActionResult {
  success: boolean;
  action: BrowserActionName;
  args: string[];
  stdout?: string;
  data?: unknown;
  error?: string;
  artifactPath?: string;
}

interface BrowserRunbookStep {
  line: number;
  input: BrowserActionInput;
}

interface BrowserEvidenceItem {
  id: string;
  type: 'screenshot' | 'snapshot';
  path: string;
  createdAt: string;
  label?: string;
  url?: string;
  title?: string;
}

// Cache for GitHub data
const prCache = new Map<string, { data: PRInfo[]; fetchedAt: number }>();
const PR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const gitRemoteCache = new Map<string, { data: GitRemote | null; fetchedAt: number }>();
const GIT_CACHE_TTL_MS = 60 * 1000; // 1 minute
const ALL_SESSION_STATUSES = [
  'active',
  'blocked',
  'review',
  'completed',
  'failed',
  'cancelled',
  'inactive',
  'expired',
] as const;
const MARKDOWN_WORKSPACE_DIR = '.cockpit/markdown';
const MARKDOWN_METADATA_DIR = '.meta';
const MARKDOWN_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
const MARKDOWN_SUGGESTED_FOLDERS = ['notes', 'packets', 'plans', 'scratch', 'handoffs'];
const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
const MARKDOWN_METADATA_MAX_BYTES = 64 * 1024;
const MARKDOWN_CHAT_CONTEXT_MAX_BYTES = 120 * 1024;
const COCKPIT_SNAPSHOT_CACHE_TTL_MS = 1_500;

let cockpitSnapshotCache:
  | { key: string; expiresAt: number; data: CockpitRollupSnapshotResult }
  | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function extractText(value: unknown): string | undefined {
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

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function hasMarkdownExtension(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  for (const ext of MARKDOWN_FILE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function normalizeWorkspaceRelativePath(rawPath: string, options?: { allowEmpty?: boolean }): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return options?.allowEmpty ? '' : null;
  const slashNormalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
  const pieces = slashNormalized.split('/').map((item) => item.trim()).filter(Boolean);
  if (pieces.length === 0) return options?.allowEmpty ? '' : null;
  if (pieces.some((piece) => piece === '.' || piece === '..')) return null;
  return pieces.join('/');
}

function sanitizeMarkdownName(rawName: string): string {
  const normalized = rawName
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? '';
  const safe = normalized
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'untitled.md';
}

function ensureMarkdownFileName(rawName: string): string {
  const safe = sanitizeMarkdownName(rawName);
  return hasMarkdownExtension(safe) ? safe : `${safe}.md`;
}

function ensureMarkdownExtensionOnPath(rawPath: string): string | null {
  const normalized = normalizeWorkspaceRelativePath(rawPath);
  if (normalized === null) return null;
  return hasMarkdownExtension(normalized) ? normalized : `${normalized}.md`;
}

function buildVersionFromMtimeMs(mtimeMs: number): number {
  if (!Number.isFinite(mtimeMs)) return 0;
  return Math.max(0, Math.floor(mtimeMs));
}

async function getCockpitMarkdownWorkspaceRoot(ctx: ControlPlaneContext): Promise<string> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const root = path.resolve(ctx.workingDir, MARKDOWN_WORKSPACE_DIR);
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function resolveCockpitMarkdownWorkspacePath(
  ctx: ControlPlaneContext,
  rawPath: string,
  options?: { allowEmpty?: boolean; requireMarkdownFile?: boolean }
): Promise<{ rootDir: string; relativePath: string; absolutePath: string } | { error: string }> {
  const path = await import('path');
  const rootDir = await getCockpitMarkdownWorkspaceRoot(ctx);
  const relativePath = normalizeWorkspaceRelativePath(rawPath, { allowEmpty: options?.allowEmpty });
  if (relativePath === null) {
    return { error: 'Invalid markdown path' };
  }
  if (options?.requireMarkdownFile && relativePath && !hasMarkdownExtension(relativePath)) {
    return { error: 'Markdown files must end with .md, .markdown, or .mdx' };
  }
  const absolutePath = relativePath
    ? path.resolve(rootDir, relativePath)
    : rootDir;
  const inWorkspace = absolutePath === rootDir || absolutePath.startsWith(`${rootDir}${path.sep}`);
  if (!inWorkspace) {
    return { error: 'Path must resolve inside the markdown workspace' };
  }
  return { rootDir, relativePath, absolutePath };
}

interface MarkdownWorkspaceFileRecord {
  path: string;
  version: number;
  updatedAt: string;
  size: number;
  hash: string;
  etag: string;
  lineCount: number;
  wordCount: number;
  metadata?: Record<string, unknown>;
}

function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (depth > 5) return undefined;
  if (typeof value === 'string') {
    return value.length > 4_000 ? value.slice(0, 4_000) : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, 128)) {
      const next = sanitizeMetadataValue(item, depth + 1);
      if (next !== undefined) out.push(next);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [rawKey, rawValue] of Object.entries(value)) {
      if (count >= 128) break;
      const key = rawKey.trim();
      if (!key) continue;
      const next = sanitizeMetadataValue(rawValue, depth + 1);
      if (next === undefined) continue;
      out[key] = next;
      count += 1;
    }
    return out;
  }
  return undefined;
}

function sanitizeMarkdownMetadata(value: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeMetadataValue(value, 0);
  if (!isRecord(sanitized)) return undefined;
  const serialized = JSON.stringify(sanitized);
  if (serialized.length > MARKDOWN_METADATA_MAX_BYTES) return undefined;
  return sanitized;
}

async function buildMarkdownContentHash(content: string): Promise<string> {
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function buildMarkdownWordCount(content: string): number {
  const matches = content.match(/[^\s]+/g);
  return matches ? matches.length : 0;
}

function buildMarkdownLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

function buildMarkdownEtag(version: number, hash: string): string {
  const shortHash = hash.slice(0, 16);
  return `W/"${Math.max(0, version)}-${shortHash}"`;
}

async function resolveMarkdownMetadataPath(rootDir: string, relativePath: string): Promise<string> {
  const path = await import('path');
  const metadataRoot = path.resolve(rootDir, MARKDOWN_METADATA_DIR);
  const metadataPath = path.resolve(metadataRoot, `${relativePath}.meta.json`);
  if (metadataPath === metadataRoot || metadataPath.startsWith(`${metadataRoot}${path.sep}`)) {
    return metadataPath;
  }
  throw new Error('Metadata path resolved outside markdown metadata workspace');
}

async function readMarkdownWorkspaceMetadata(
  rootDir: string,
  relativePath: string
): Promise<Record<string, unknown> | undefined> {
  const fs = await import('fs/promises');
  try {
    const metadataPath = await resolveMarkdownMetadataPath(rootDir, relativePath);
    const raw = await fs.readFile(metadataPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MARKDOWN_METADATA_MAX_BYTES) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeMarkdownMetadata(parsed);
  } catch {
    return undefined;
  }
}

async function writeMarkdownWorkspaceMetadata(
  rootDir: string,
  relativePath: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const metadataPath = await resolveMarkdownMetadataPath(rootDir, relativePath);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function buildMarkdownWorkspaceFileRecord(
  rootDir: string,
  relativePath: string,
  content: string,
  stat: { mtimeMs: number; mtime: Date; size: number },
  metadata?: Record<string, unknown>
): Promise<MarkdownWorkspaceFileRecord> {
  const version = buildVersionFromMtimeMs(stat.mtimeMs);
  const hash = await buildMarkdownContentHash(content);
  return {
    path: relativePath,
    version,
    updatedAt: stat.mtime.toISOString(),
    size: stat.size,
    hash,
    etag: buildMarkdownEtag(version, hash),
    lineCount: buildMarkdownLineCount(content),
    wordCount: buildMarkdownWordCount(content),
    ...(metadata ? { metadata } : {}),
  };
}

async function writeCockpitMarkdownWorkspaceFile(
  ctx: ControlPlaneContext,
  input: {
    path: string;
    content: string;
    expectedVersion?: number;
    metadata?: Record<string, unknown>;
    operation?: 'write' | 'import' | 'patch';
    source?: string;
    baseVersion?: number;
  }
): Promise<
  | { ok: true; file: MarkdownWorkspaceFileRecord; created: boolean; previousVersion: number }
  | { ok: false; status: number; error: string; currentVersion?: number; currentUpdatedAt?: string; currentHash?: string }
> {
  const pathModule = await import('path');
  const fs = await import('fs/promises');
  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, input.path, { requireMarkdownFile: true });
  if ('error' in resolved) {
    return { ok: false, status: 400, error: resolved.error };
  }

  if (Buffer.byteLength(input.content, 'utf8') > MARKDOWN_MAX_BYTES) {
    return { ok: false, status: 400, error: `Markdown payload exceeds ${MARKDOWN_MAX_BYTES} bytes` };
  }

  let existing:
    | {
        version: number;
        updatedAt: string;
        size: number;
        content: string;
      }
    | undefined;
  try {
    const [stat, content] = await Promise.all([
      fs.stat(resolved.absolutePath),
      fs.readFile(resolved.absolutePath, 'utf8'),
    ]);
    if (stat.isFile()) {
      existing = {
        version: buildVersionFromMtimeMs(stat.mtimeMs),
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        content,
      };
    }
  } catch {
    existing = undefined;
  }

  if (typeof input.expectedVersion === 'number' && Number.isFinite(input.expectedVersion)) {
    const expected = Math.floor(input.expectedVersion);
    const current = existing?.version ?? 0;
    if (current !== expected) {
      return {
        ok: false,
        status: 409,
        error: 'Version conflict while writing markdown file',
        currentVersion: current,
        ...(existing?.updatedAt ? { currentUpdatedAt: existing.updatedAt } : {}),
        ...(existing?.content ? { currentHash: await buildMarkdownContentHash(existing.content) } : {}),
      };
    }
  }

  await fs.mkdir(pathModule.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(resolved.absolutePath, input.content, 'utf8');
  const [stat, metadataBase] = await Promise.all([
    fs.stat(resolved.absolutePath),
    readMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath),
  ]);
  const incomingMetadata = sanitizeMarkdownMetadata(input.metadata);
  const nextFile = await buildMarkdownWorkspaceFileRecord(
    resolved.rootDir,
    resolved.relativePath,
    input.content,
    stat,
  );
  const mergedMetadata = sanitizeMarkdownMetadata({
    ...(metadataBase ?? {}),
    ...(incomingMetadata ?? {}),
    source: asString(input.source)
      ?? asString(incomingMetadata?.source)
      ?? asString(metadataBase?.source)
      ?? (input.operation === 'import' ? 'import' : 'control-plane'),
    createdAt: asString(metadataBase?.createdAt) ?? nextFile.updatedAt,
    updatedAt: nextFile.updatedAt,
    lineCount: nextFile.lineCount,
    wordCount: nextFile.wordCount,
    hash: nextFile.hash,
    size: nextFile.size,
    cockpit: sanitizeMetadataValue({
      ...(isRecord(metadataBase?.cockpit) ? metadataBase.cockpit : {}),
      path: nextFile.path,
      version: nextFile.version,
      etag: nextFile.etag,
      hash: nextFile.hash,
      lineCount: nextFile.lineCount,
      wordCount: nextFile.wordCount,
      ...(typeof input.baseVersion === 'number' ? { baseVersion: Math.floor(input.baseVersion) } : {}),
      ...(typeof existing?.version === 'number' ? { previousVersion: existing.version } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
      updatedAt: nextFile.updatedAt,
    }),
  });
  try {
    if (mergedMetadata) {
      await writeMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath, mergedMetadata);
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `Failed to persist markdown metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    created: !existing,
    previousVersion: existing?.version ?? 0,
    file: {
      ...nextFile,
      ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
    },
  };
}

interface MarkdownPatchEditInput {
  startLine: number;
  endLine: number;
  replacement: string;
}

function parseMarkdownPatchEdits(value: unknown): MarkdownPatchEditInput[] {
  if (!Array.isArray(value)) return [];
  const edits: MarkdownPatchEditInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const startLine = asNumber(entry.startLine ?? entry.start_line);
    const endLine = asNumber(entry.endLine ?? entry.end_line);
    const replacement = typeof entry.replacement === 'string'
      ? entry.replacement
      : typeof entry.text === 'string'
        ? entry.text
        : undefined;
    if (!startLine || !endLine || replacement === undefined) continue;
    edits.push({
      startLine: Math.floor(startLine),
      endLine: Math.floor(endLine),
      replacement,
    });
  }
  return edits;
}

function applyMarkdownStructuredEdits(
  content: string,
  edits: MarkdownPatchEditInput[]
): { ok: true; content: string; changedLines: number } | { ok: false; error: string; status: number } {
  const hadTrailingNewline = content.endsWith('\n');
  const baseText = hadTrailingNewline ? content.slice(0, -1) : content;
  const lines = baseText.length > 0 ? baseText.split('\n') : [];
  let changedLines = 0;
  const ordered = [...edits].sort((a, b) => b.startLine - a.startLine);
  for (const edit of ordered) {
    if (edit.startLine < 1) {
      return { ok: false, status: 400, error: 'Invalid startLine in markdown edits' };
    }
    if (edit.endLine < edit.startLine - 1) {
      return { ok: false, status: 400, error: 'Invalid endLine in markdown edits' };
    }
    if (edit.endLine > lines.length) {
      return {
        ok: false,
        status: 400,
        error: `Edit range out of bounds: ${edit.startLine}-${edit.endLine} (lines=${lines.length})`,
      };
    }
    if (edit.startLine > lines.length + 1) {
      return {
        ok: false,
        status: 400,
        error: `Edit start out of bounds: ${edit.startLine} (lines=${lines.length})`,
      };
    }
    const startIdx = Math.min(lines.length, edit.startLine - 1);
    const deleteCount = Math.max(0, edit.endLine - edit.startLine + 1);
    const replacementLines = edit.replacement === '' ? [] : edit.replacement.split('\n');
    lines.splice(startIdx, deleteCount, ...replacementLines);
    changedLines += Math.max(deleteCount, replacementLines.length);
  }
  return {
    ok: true,
    content: lines.join('\n') + (hadTrailingNewline ? '\n' : ''),
    changedLines,
  };
}

async function applyMarkdownUnifiedDiffPatch(
  relativePath: string,
  currentContent: string,
  patch: string
): Promise<{ ok: true; content: string; changedLines: number } | { ok: false; error: string; status: number }> {
  const stats = parsePatchStats(patch);
  if (stats.hasBinary) {
    return { ok: false, status: 400, error: 'Binary markdown patch is not supported' };
  }
  if (stats.files.length === 0) {
    return { ok: false, status: 400, error: 'No files detected in markdown patch payload' };
  }
  const normalizedTarget = normalizeDiffPath(relativePath);
  const mismatched = stats.files.filter((filePath) => normalizeDiffPath(filePath) !== normalizedTarget);
  if (mismatched.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Markdown patch must only target ${relativePath}; found ${mismatched.join(', ')}`,
    };
  }

  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-md-patch-'));
  try {
    const targetPath = path.resolve(tempDir, normalizedTarget);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, currentContent, 'utf8');
    const patchPath = path.join(tempDir, 'markdown.patch');
    await fs.writeFile(patchPath, patch, 'utf8');
    await execFileText('git', ['apply', '--check', '--whitespace=nowarn', patchPath], {
      cwd: tempDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await execFileText('git', ['apply', '--whitespace=nowarn', patchPath], {
      cwd: tempDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const nextContent = await fs.readFile(targetPath, 'utf8');
    return { ok: true, content: nextContent, changedLines: stats.changedLines };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildCockpitMarkdownWorkspaceTree(
  ctx: ControlPlaneContext
): Promise<{
  rootDir: string;
  tree: Array<Record<string, unknown>>;
  suggestedFolders: string[];
}> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const rootDir = await getCockpitMarkdownWorkspaceRoot(ctx);

  const counters = { files: 0 };
  const MAX_FILES = 1000;
  const MAX_DEPTH = 6;

  const scanDir = async (absoluteDir: string, relativeDir: string, depth: number): Promise<Array<Record<string, unknown>>> => {
    if (depth > MAX_DEPTH || counters.files >= MAX_FILES) return [];
    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }> = [];
    try {
      const dirEntries = await fs.readdir(absoluteDir, { withFileTypes: true });
      entries = dirEntries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    } catch {
      return [];
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const nodes: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink) continue;

      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absPath = path.join(absoluteDir, entry.name);

      if (entry.isDirectory) {
        const children = await scanDir(absPath, relPath, depth + 1);
        nodes.push({
          type: 'folder',
          name: entry.name,
          path: relPath,
          children,
        });
        continue;
      }

      if (!entry.isFile || !hasMarkdownExtension(entry.name)) continue;
      let statSize = 0;
      let updatedAt = new Date(0).toISOString();
      let version = 0;
      try {
        const stat = await fs.stat(absPath);
        statSize = stat.size;
        updatedAt = stat.mtime.toISOString();
        version = buildVersionFromMtimeMs(stat.mtimeMs);
      } catch {
        // Ignore flaky file metadata reads and still list the file.
      }

      counters.files += 1;
      nodes.push({
        type: 'file',
        name: entry.name,
        path: relPath,
        size: statSize,
        updatedAt,
        version,
      });
      if (counters.files >= MAX_FILES) break;
    }
    return nodes;
  };

  const tree = await scanDir(rootDir, '', 0);
  const folderSuggestions = new Set<string>(MARKDOWN_SUGGESTED_FOLDERS);
  for (const node of tree) {
    if (node.type !== 'folder') continue;
    if (typeof node.path === 'string' && node.path.trim()) {
      folderSuggestions.add(node.path);
    }
  }
  return {
    rootDir,
    tree,
    suggestedFolders: Array.from(folderSuggestions).slice(0, 12),
  };
}

function parseAgentEventTokenTotalsForDay(
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Execute gh CLI command
 */
async function ghCommand(args: string, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`gh ${args}`, {
      timeout: 30000,
      cwd,
      env: { ...process.env, GH_PAGER: '' },
    });
    return stdout.trim();
  } catch (error) {
    console.error('[control-plane] gh command failed:', args, error);
    throw error;
  }
}

/**
 * Get PRs for a repository
 */
async function getPRs(owner: string, repo: string): Promise<PRInfo[]> {
  const cacheKey = `${owner}/${repo}`;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const result = await ghCommand(
      `pr list --repo ${owner}/${repo} --state all --limit 50 --json number,title,state,author,url,additions,deletions,changedFiles,createdAt,updatedAt,isDraft,headRefName,baseRefName,body`
    );
    const prs: PRInfo[] = JSON.parse(result).map((pr: Record<string, unknown>) => ({
      number: pr.number as number,
      title: pr.title as string,
      state: (pr.state as string).toLowerCase() as PRInfo['state'],
      author: (pr.author as Record<string, unknown>)?.login as string ?? 'unknown',
      url: pr.url as string,
      additions: (pr.additions as number) ?? 0,
      deletions: (pr.deletions as number) ?? 0,
      changedFiles: (pr.changedFiles as number) ?? 0,
      createdAt: pr.createdAt as string,
      updatedAt: pr.updatedAt as string,
      isDraft: (pr.isDraft as boolean) ?? false,
      headRefName: pr.headRefName as string,
      baseRefName: pr.baseRefName as string,
      body: pr.body as string,
    }));

    prCache.set(cacheKey, { data: prs, fetchedAt: Date.now() });
    return prs;
  } catch {
    return [];
  }
}

/**
 * Parse git remote URL to extract owner/repo
 */
function parseGitRemote(remoteUrl: string): GitRemote | null {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  return null;
}

/**
 * Get git remote info for a project
 */
async function getGitRemote(projectPath: string): Promise<GitRemote | null> {
  const cached = gitRemoteCache.get(projectPath);
  if (cached && Date.now() - cached.fetchedAt < GIT_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: projectPath,
      timeout: 5000,
    });
    const remote = parseGitRemote(stdout.trim());
    gitRemoteCache.set(projectPath, { data: remote, fetchedAt: Date.now() });
    return remote;
  } catch {
    gitRemoteCache.set(projectPath, { data: null, fetchedAt: Date.now() });
    return null;
  }
}

/**
 * Get recent commits for a project
 */
async function getRecentCommits(projectPath: string, limit = 10): Promise<GitCommitInfo[]> {
  try {
    const { stdout } = await execAsync(
      `git log -${limit} --pretty=format:'{"sha":"%h","message":"%s","author":"%an","date":"%ci"}'`,
      { cwd: projectPath, timeout: 10000 }
    );
    return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Parse URL and extract path/query
 */
function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  return { pathname: url.pathname, query: url.searchParams };
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Route matcher for path patterns like /control-plane/projects/:id/features
 */
function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
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

/**
 * Format session row for API response
 */
function formatSession(row: SessionRow) {
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

/**
 * Format message row for API response
 */
function formatMessage(row: MessageRow) {
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

function parseTimestampMs(value: unknown): number | undefined {
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

function toStringOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

async function execFileText(
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

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

function shaMatches(left: string, right: string): boolean {
  const a = normalizeSha(left);
  const b = normalizeSha(right);
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function getSessionCommitEvents(session: SessionRow): SessionCommitEvent[] {
  const events = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];
  const commits: SessionCommitEvent[] = [];
  for (const entry of events) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'git_commit') continue;
    const ts = parseTimestampMs(entry.timestamp);
    const data = isRecord(entry.data) ? entry.data : null;
    const sha = asString(data?.sha);
    if (!sha || !ts) continue;
    const headSha = asString(data?.head_sha) ?? asString(data?.headSha) ?? sha;
    const baseSha = asString(data?.base_sha) ?? asString(data?.baseSha);
    commits.push({
      sha: headSha,
      headSha,
      ...(baseSha ? { baseSha } : {}),
      timestampMs: ts,
      sessionKey: session.sessionKey,
      ...(asString(entry.work_item_id) ? { workItemId: asString(entry.work_item_id) } : {}),
    });
  }
  return commits.sort((a, b) => a.timestampMs - b.timestampMs);
}

function findSessionCommitBySha(events: SessionCommitEvent[], sha: string): SessionCommitEvent | undefined {
  for (const event of events) {
    if (shaMatches(event.sha, sha)) return event;
  }
  return undefined;
}

function getLatestRevisionRange(
  session: SessionRow,
  requestedHeadSha?: string
): { baseSha?: string; headSha?: string } {
  const commits = getSessionCommitEvents(session);
  if (commits.length === 0) {
    const metadata = session.metadata ?? {};
    const baseSha = asString(metadata.baseSha) ?? asString(metadata.base_sha);
    const headSha = requestedHeadSha
      ?? asString(metadata.headSha)
      ?? asString(metadata.head_sha)
      ?? asString(metadata.commitSha)
      ?? asString(metadata.commit_sha)
      ?? asString(metadata.revision);
    return { baseSha, headSha };
  }

  if (requestedHeadSha) {
    const index = commits.findIndex((entry) => shaMatches(entry.headSha, requestedHeadSha) || shaMatches(entry.sha, requestedHeadSha));
    if (index >= 0) {
      const matched = commits[index];
      return {
        ...(matched.baseSha
          ? { baseSha: matched.baseSha }
          : index > 0
            ? { baseSha: commits[index - 1].headSha }
            : {}),
        headSha: matched.headSha,
      };
    }
    return { headSha: requestedHeadSha };
  }

  const head = commits[commits.length - 1];
  return {
    ...(head.baseSha
      ? { baseSha: head.baseSha }
      : commits.length > 1
        ? { baseSha: commits[commits.length - 2].headSha }
        : {}),
    headSha: head.headSha,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type DiffLineRange = { start: number; end: number; added: number; deleted: number };

function parseLineRangesFromPatch(patch: string): Map<string, DiffLineRange[]> {
  const ranges = new Map<string, DiffLineRange[]>();
  const lines = patch.split('\n');
  let currentFile: string | null = null;
  let currentStart: number | null = null;
  let rangeAdded = 0;
  let rangeDeleted = 0;
  let lineNum = 0;

  for (const line of lines) {
    // Match file header: +++ b/path/to/file
    const fileMatch = line.match(/^\+\+\+\s+b\/(.+)/);
    if (fileMatch) {
      // Save previous range if exists
      if (currentFile && currentStart !== null) {
        const fileRanges = ranges.get(currentFile) || [];
        fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });
        ranges.set(currentFile, fileRanges);
      }
      currentFile = fileMatch[1].trim();
      currentStart = null;
      rangeAdded = 0;
      rangeDeleted = 0;
      continue;
    }

    // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch && currentFile) {
      // Save previous range if exists
      if (currentStart !== null) {
        const fileRanges = ranges.get(currentFile) || [];
        fileRanges.push({ start: currentStart, end: lineNum - 1, added: rangeAdded, deleted: rangeDeleted });
        ranges.set(currentFile, fileRanges);
      }
      currentStart = parseInt(hunkMatch[1], 10);
      lineNum = currentStart;
      rangeAdded = 0;
      rangeDeleted = 0;
      continue;
    }

    // Count additions and deletions
    if (currentStart !== null) {
      if (line.startsWith('+') && !line.startsWith('++')) {
        rangeAdded++;
        lineNum++;
      } else if (line.startsWith('-') && !line.startsWith('--')) {
        rangeDeleted++;
        // Don't increment lineNum for deletions
      } else if (line.startsWith(' ')) {
        lineNum++;
      }
    }
  }

  // Save final range
  if (currentFile && currentStart !== null) {
    const fileRanges = ranges.get(currentFile) || [];
    fileRanges.push({ start: currentStart, end: lineNum, added: rangeAdded, deleted: rangeDeleted });
    ranges.set(currentFile, fileRanges);
  }

  return ranges;
}

function parseNumstatOutput(stdout: string, patch?: string | null): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');

  // Parse line ranges from patch if provided
  const lineRanges = patch ? parseLineRangesFromPatch(patch) : new Map<string, DiffLineRange[]>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    const path = parts.slice(2).join('\t');
    if (!path) continue;
    if (Number.isFinite(added)) totalAdded += added;
    if (Number.isFinite(deleted)) totalDeleted += deleted;
    filesTouched += 1;

    const hotspot: DiffHotspot = {
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    };

    // Add line ranges if available
    const fileRanges = lineRanges.get(path);
    if (fileRanges && fileRanges.length > 0) {
      // Add up to 3 most significant line ranges (most changes)
      const topRanges = fileRanges
        .sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted))
        .slice(0, 3);
      if (topRanges.length > 0) {
        hotspot.lineRanges = topRanges;
      }
    }

    hotspots.push(hotspot);
  }
  hotspots.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
  return {
    summary: {
      added: totalAdded,
      deleted: totalDeleted,
      filesTouched,
    },
    hotspots,
  };
}

function parseGitLogWithNumstat(stdout: string, projectPath: string): CommitRollup[] {
  const commits: CommitRollup[] = [];
  const lines = stdout.split('\n');
  let current: CommitRollup | null = null;

  for (const raw of lines) {
    if (raw.startsWith('__COMMIT__')) {
      if (current) commits.push(current);
      const payload = raw.slice('__COMMIT__'.length);
      const [shaRaw, authorRaw, timeRaw, messageRaw] = payload.split('\u001f');
      const sha = (shaRaw ?? '').trim();
      const author = (authorRaw ?? '').trim();
      const time = (timeRaw ?? '').trim();
      const message = (messageRaw ?? '').trim();
      if (!sha || !time) {
        current = null;
        continue;
      }
      current = {
        sha,
        message,
        author: author || 'unknown',
        time,
        diffstat: { added: 0, deleted: 0, filesTouched: 0 },
        projectPath,
      };
      continue;
    }

    if (!current) continue;
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    if (Number.isFinite(added)) current.diffstat.added += added;
    if (Number.isFinite(deleted)) current.diffstat.deleted += deleted;
    current.diffstat.filesTouched += 1;
  }
  if (current) commits.push(current);

  return commits;
}

async function loadSessionDiffstats(
  sessions: SessionRow[]
): Promise<Map<string, { added: number; deleted: number; filesTouched: number }>> {
  const bySession = new Map<string, { added: number; deleted: number; filesTouched: number }>();
  const cachedByRange = new Map<string, { added: number; deleted: number; filesTouched: number }>();

  for (const session of sessions) {
    const workingDir = session.workingDir;
    if (!workingDir) continue;
    const range = getLatestRevisionRange(session);
    if (!range.baseSha || !range.headSha) continue;
    const cacheKey = `${workingDir}\u001f${range.baseSha}\u001f${range.headSha}`;
    const cached = cachedByRange.get(cacheKey);
    if (cached) {
      bySession.set(session.sessionKey, cached);
      continue;
    }
    try {
      const numstat = await execFileText(
        'git',
        ['diff', '--numstat', '--no-color', `${range.baseSha}..${range.headSha}`],
        { cwd: workingDir, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
      );
      const parsed = parseNumstatOutput(numstat).summary;
      cachedByRange.set(cacheKey, parsed);
      bySession.set(session.sessionKey, parsed);
    } catch {
      // Keep trace fallback when git diffstat is unavailable.
    }
  }

  return bySession;
}

function mapTestReportRow(row: TestReportRecord): Record<string, unknown> {
  const createdAtMs = row.created_at instanceof Date
    ? row.created_at.getTime()
    : parseTimestampMs(row.created_at) ?? Date.now();
  return {
    id: row.id,
    sessionKey: row.session_key,
    workItemId: row.work_item_id,
    verdict: row.verdict,
    categories: Array.isArray(row.categories) ? row.categories : [],
    cases: Array.isArray(row.cases) ? row.cases : [],
    cliOutput: row.cli_output ?? '',
    command: row.command ?? '',
    coverage: row.coverage ?? null,
    mutationScore: row.mutation_score ?? null,
    agentNote: row.agent_note ?? '',
    durationMs: row.duration_ms ?? 0,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

function isLockfilePath(filePath: string): boolean {
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

function normalizeDiffPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const withoutPrefix = trimmed.startsWith('a/') || trimmed.startsWith('b/')
    ? trimmed.slice(2)
    : trimmed;
  return withoutPrefix.replace(/^"+|"+$/g, '');
}

function parsePatchStats(patch: string): {
  files: string[];
  changedLines: number;
  hasBinary: boolean;
} {
  const files = new Set<string>();
  let changedLines = 0;
  let hasBinary = false;
  const lines = patch.split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      hasBinary = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const candidate = line.slice(4).trim();
      if (candidate !== '/dev/null') {
        files.add(normalizeDiffPath(candidate));
      }
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      changedLines += 1;
    }
  }
  return { files: Array.from(files), changedLines, hasBinary };
}

function parsePatchEdits(value: unknown): PatchEditInput[] {
  if (!Array.isArray(value)) return [];
  const edits: PatchEditInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const filePath = asString(entry.path);
    const startLine = asNumber(entry.startLine ?? entry.start_line);
    const endLine = asNumber(entry.endLine ?? entry.end_line);
    const replacement = typeof entry.replacement === 'string'
      ? entry.replacement
      : typeof entry.text === 'string'
        ? entry.text
        : undefined;
    if (!filePath || !startLine || !endLine || replacement === undefined) continue;
    edits.push({
      path: filePath,
      startLine: Math.floor(startLine),
      endLine: Math.floor(endLine),
      replacement,
    });
  }
  return edits;
}

async function resolveSessionFilePath(workingDir: string, relativePath: string): Promise<{
  resolvedPath?: string;
  relativePath?: string;
  error?: string;
}> {
  const path = await import('path');
  const baseDir = path.resolve(workingDir);
  const resolvedPath = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(baseDir, relativePath);
  const inWorkingDir = resolvedPath === baseDir || resolvedPath.startsWith(`${baseDir}${path.sep}`);
  if (!inWorkingDir) {
    return { error: 'Patch paths must resolve inside the session working directory' };
  }
  return {
    resolvedPath,
    relativePath: path.relative(baseDir, resolvedPath),
  };
}

async function enforcePatchConstraints(
  mode: 'patch' | 'edits',
  files: string[],
  changedLines: number
): Promise<{ ok: boolean; error?: string }> {
  if (files.length === 0) {
    return { ok: false, error: `No files detected in ${mode}` };
  }
  if (files.length > 3) {
    return { ok: false, error: `Patch exceeds file limit: ${files.length} > 3` };
  }
  if (changedLines > 30) {
    return { ok: false, error: `Patch exceeds changed-line limit: ${changedLines} > 30` };
  }
  for (const filePath of files) {
    if (isLockfilePath(filePath)) {
      return { ok: false, error: `Lockfile edits are blocked by default: ${filePath}` };
    }
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return { ok: false, error: `Unsafe path in patch: ${filePath}` };
    }
  }
  return { ok: true };
}

let agentBrowserAvailabilityCache: { available: boolean; checkedAtMs: number } | null = null;

function normalizeBrowserSessionName(sessionKey: string): string {
  const safe = sessionKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const normalized = safe || 'session';
  return `cockpit-${normalized}`.slice(0, 72);
}

function sanitizeArtifactToken(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'artifact';
}

function browserTimestampToken(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

function toActionError(action: BrowserActionName, message: string): { error: string } {
  return { error: `${action}: ${message}` };
}

function normalizeBrowserActionName(value: string | undefined): BrowserActionName | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, '_');
  if (normalized === 'open') return 'open';
  if (normalized === 'back') return 'back';
  if (normalized === 'forward') return 'forward';
  if (normalized === 'reload') return 'reload';
  if (normalized === 'snapshot') return 'snapshot';
  if (normalized === 'click') return 'click';
  if (normalized === 'fill') return 'fill';
  if (normalized === 'type') return 'type';
  if (normalized === 'press') return 'press';
  if (normalized === 'wait') return 'wait';
  if (normalized === 'scroll') return 'scroll';
  if (normalized === 'get_url' || normalized === 'geturl') return 'get_url';
  if (normalized === 'get_title' || normalized === 'gettitle') return 'get_title';
  if (normalized === 'screenshot') return 'screenshot';
  if (normalized === 'close') return 'close';
  return null;
}

function parseBrowserActionInput(value: Record<string, unknown>): { input?: BrowserActionInput; error?: string } {
  const action = normalizeBrowserActionName(asString(value.action));
  if (!action) {
    return { error: 'Invalid browser action. Allowed: open, back, forward, reload, snapshot, click, fill, type, press, wait, scroll, get_url, get_title, screenshot, close.' };
  }

  const target = asString(value.target);
  const text = asString(value.text) ?? asString(value.value);
  const url = asString(value.url);
  const interactive = asBoolean(value.interactive);
  const compact = asBoolean(value.compact);
  const depth = asNumber(value.depth);
  const selector = asString(value.selector);
  const directionRaw = asString(value.direction)?.toLowerCase();
  const direction = directionRaw === 'up' || directionRaw === 'down' || directionRaw === 'left' || directionRaw === 'right'
    ? directionRaw
    : undefined;
  const pixels = asNumber(value.pixels);
  const waitMs = asNumber(value.waitMs ?? value.wait_ms);
  const label = asString(value.label);

  if (action === 'open' && !url) return toActionError(action, 'Missing required field: url');
  if (action === 'click' && !target) return toActionError(action, 'Missing required field: target');
  if ((action === 'fill' || action === 'type') && (!target || text === undefined)) {
    return toActionError(action, 'Missing required fields: target and text');
  }
  if (action === 'press' && !text && !target) {
    return toActionError(action, 'Missing required field: text (or target)');
  }
  if (action === 'wait' && waitMs === undefined && !target) {
    return toActionError(action, 'Missing required field: waitMs or target');
  }
  if (action === 'snapshot' && depth !== undefined && (depth < 1 || depth > 25)) {
    return toActionError(action, 'depth must be between 1 and 25');
  }
  if (action === 'scroll' && directionRaw && !direction) {
    return toActionError(action, 'direction must be one of up|down|left|right');
  }

  return {
    input: {
      action,
      ...(target ? { target } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(url ? { url } : {}),
      ...(interactive !== undefined ? { interactive } : {}),
      ...(compact !== undefined ? { compact } : {}),
      ...(typeof depth === 'number' ? { depth: Math.floor(depth) } : {}),
      ...(selector ? { selector } : {}),
      ...(direction ? { direction } : {}),
      ...(typeof pixels === 'number' ? { pixels: Math.floor(pixels) } : {}),
      ...(typeof waitMs === 'number' ? { waitMs: Math.max(1, Math.floor(waitMs)) } : {}),
      ...(label ? { label } : {}),
    },
  };
}

function buildBrowserActionArgs(input: BrowserActionInput, artifactPath?: string): string[] {
  switch (input.action) {
    case 'open':
      return ['open', input.url ?? ''];
    case 'back':
      return ['back'];
    case 'forward':
      return ['forward'];
    case 'reload':
      return ['reload'];
    case 'snapshot': {
      const args = ['snapshot'];
      if (input.interactive) args.push('--interactive');
      if (input.compact) args.push('--compact');
      if (typeof input.depth === 'number') args.push('--depth', String(input.depth));
      if (input.selector) args.push('--selector', input.selector);
      return args;
    }
    case 'click':
      return ['click', input.target ?? ''];
    case 'fill':
      return ['fill', input.target ?? '', input.text ?? ''];
    case 'type':
      return ['type', input.target ?? '', input.text ?? ''];
    case 'press':
      return ['press', input.text ?? input.target ?? ''];
    case 'wait':
      return ['wait', String(input.waitMs ?? input.target ?? '1000')];
    case 'scroll': {
      const args = ['scroll', input.direction ?? 'down'];
      if (typeof input.pixels === 'number') args.push(String(input.pixels));
      return args;
    }
    case 'get_url':
      return ['get', 'url'];
    case 'get_title':
      return ['get', 'title'];
    case 'screenshot':
      return artifactPath ? ['screenshot', artifactPath] : ['screenshot'];
    case 'close':
      return ['close'];
  }
}

function summarizeBrowserData(data: unknown, maxChars = 1600): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') {
    return data.length > maxChars ? `${data.slice(0, maxChars)}...` : data;
  }
  try {
    const json = JSON.stringify(data);
    if (!json) return undefined;
    return json.length > maxChars ? `${json.slice(0, maxChars)}...` : json;
  } catch {
    return undefined;
  }
}

function parseBrowserCliJson(raw: string): { success: boolean; data?: unknown; error?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return null;
    const success = typeof parsed.success === 'boolean' ? parsed.success : true;
    const error = asString(parsed.error);
    return {
      success,
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(error ? { error } : {}),
    };
  } catch {
    return null;
  }
}

async function checkAgentBrowserAvailable(workingDir: string): Promise<boolean> {
  const nowMs = Date.now();
  if (agentBrowserAvailabilityCache && nowMs - agentBrowserAvailabilityCache.checkedAtMs < 60_000) {
    return agentBrowserAvailabilityCache.available;
  }
  try {
    await execFileText('agent-browser', ['session', 'list', '--json'], {
      cwd: workingDir,
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    agentBrowserAvailabilityCache = { available: true, checkedAtMs: nowMs };
    return true;
  } catch {
    agentBrowserAvailabilityCache = { available: false, checkedAtMs: nowMs };
    return false;
  }
}

async function allocateBrowserArtifactPath(
  workingDir: string,
  sessionKey: string,
  type: 'screenshots' | 'snapshots',
  ext: 'png' | 'json' = 'png',
  label?: string
): Promise<{ absolutePath: string; relativePath: string }> {
  const path = await import('path');
  const fs = await import('fs/promises');
  const baseDir = path.join(
    workingDir,
    '.cockpit',
    'browser',
    sanitizeArtifactToken(sessionKey),
    type
  );
  await fs.mkdir(baseDir, { recursive: true });
  const stamp = browserTimestampToken();
  const suffix = label ? `_${sanitizeArtifactToken(label)}` : '';
  const fileName = `${stamp}${suffix}.${ext}`;
  const absolutePath = path.join(baseDir, fileName);
  const relativePath = path.relative(workingDir, absolutePath);
  return { absolutePath, relativePath };
}

function tokenizedRunbookLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaped = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const ch = line[idx];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseBrowserRunbook(script: string): { steps: BrowserRunbookStep[]; error?: string } {
  const lines = script.split('\n');
  const steps: BrowserRunbookStep[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const tokens = tokenizedRunbookLine(trimmed);
    if (tokens.length === 0) continue;
    const lineNo = idx + 1;
    const command = tokens[0].toLowerCase();

    const withInput = (input: BrowserActionInput) => {
      steps.push({ line: lineNo, input });
    };

    if (command === 'open') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: open requires a URL` };
      withInput({ action: 'open', url: tokens.slice(1).join(' ') });
      continue;
    }
    if (command === 'click') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: click requires a target` };
      withInput({ action: 'click', target: tokens[1] });
      continue;
    }
    if (command === 'fill' || command === 'type') {
      if (!tokens[1] || tokens.length < 3) {
        return { steps: [], error: `Runbook line ${lineNo}: ${command} requires target + text` };
      }
      withInput({
        action: command,
        target: tokens[1],
        text: tokens.slice(2).join(' '),
      });
      continue;
    }
    if (command === 'press') {
      if (tokens.length < 2) return { steps: [], error: `Runbook line ${lineNo}: press requires a key` };
      withInput({ action: 'press', text: tokens.slice(1).join(' ') });
      continue;
    }
    if (command === 'wait') {
      if (!tokens[1]) return { steps: [], error: `Runbook line ${lineNo}: wait requires milliseconds or a selector` };
      const waitMs = Number(tokens[1]);
      if (Number.isFinite(waitMs)) {
        withInput({ action: 'wait', waitMs: Math.max(1, Math.floor(waitMs)) });
      } else {
        withInput({ action: 'wait', target: tokens.slice(1).join(' ') });
      }
      continue;
    }
    if (command === 'scroll') {
      const direction = (tokens[1] ?? 'down').toLowerCase();
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
        return { steps: [], error: `Runbook line ${lineNo}: invalid scroll direction "${direction}"` };
      }
      const pixels = tokens[2] ? Number(tokens[2]) : undefined;
      withInput({
        action: 'scroll',
        direction,
        ...(Number.isFinite(pixels) ? { pixels: Math.floor(Number(pixels)) } : {}),
      });
      continue;
    }
    if (command === 'snapshot') {
      let interactive = false;
      let compact = false;
      let depth: number | undefined;
      let selector: string | undefined;
      for (let t = 1; t < tokens.length; t += 1) {
        const token = tokens[t];
        if (token === '-i' || token === '--interactive') {
          interactive = true;
          continue;
        }
        if (token === '-c' || token === '--compact') {
          compact = true;
          continue;
        }
        if ((token === '-d' || token === '--depth') && tokens[t + 1]) {
          const parsed = Number(tokens[t + 1]);
          if (Number.isFinite(parsed)) depth = Math.floor(parsed);
          t += 1;
          continue;
        }
        if ((token === '-s' || token === '--selector') && tokens[t + 1]) {
          selector = tokens[t + 1];
          t += 1;
        }
      }
      withInput({
        action: 'snapshot',
        interactive,
        compact,
        ...(typeof depth === 'number' ? { depth } : {}),
        ...(selector ? { selector } : {}),
      });
      continue;
    }
    if (command === 'screenshot') {
      withInput({
        action: 'screenshot',
        ...(tokens[1] ? { label: tokens.slice(1).join(' ') } : {}),
      });
      continue;
    }
    if (command === 'get') {
      const what = (tokens[1] ?? '').toLowerCase();
      if (what === 'url') {
        withInput({ action: 'get_url' });
        continue;
      }
      if (what === 'title') {
        withInput({ action: 'get_title' });
        continue;
      }
      return { steps: [], error: `Runbook line ${lineNo}: get supports only "url" or "title"` };
    }
    if (command === 'back' || command === 'forward' || command === 'reload' || command === 'close') {
      withInput({ action: command });
      continue;
    }

    return { steps: [], error: `Runbook line ${lineNo}: unsupported command "${tokens[0]}"` };
  }

  if (steps.length === 0) {
    return { steps: [], error: 'Runbook is empty. Add at least one command.' };
  }
  if (steps.length > 40) {
    return { steps: [], error: `Runbook exceeds step limit: ${steps.length} > 40` };
  }
  return { steps };
}

function buildBrowserEvidenceId(sessionKey: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `bev_${sanitizeArtifactToken(sessionKey)}_${Date.now().toString(36)}_${suffix}`;
}

function parseBrowserEvidence(value: unknown): BrowserEvidenceItem[] {
  if (!Array.isArray(value)) return [];
  const evidence: BrowserEvidenceItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    const typeRaw = asString(entry.type);
    const type = typeRaw === 'snapshot' ? 'snapshot' : typeRaw === 'screenshot' ? 'screenshot' : null;
    const artifactPath = asString(entry.path);
    const createdAt = asString(entry.createdAt);
    if (!id || !type || !artifactPath || !createdAt) continue;
    evidence.push({
      id,
      type,
      path: artifactPath,
      createdAt,
      ...(asString(entry.label) ? { label: asString(entry.label) } : {}),
      ...(asString(entry.url) ? { url: asString(entry.url) } : {}),
      ...(asString(entry.title) ? { title: asString(entry.title) } : {}),
    });
  }
  return evidence.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function runBrowserAction(
  workingDir: string,
  browserSession: string,
  sessionKey: string,
  input: BrowserActionInput
): Promise<BrowserActionResult> {
  let artifactPath: string | undefined;
  let snapshotArtifactAbsPath: string | undefined;
  if (input.action === 'screenshot') {
    const artifact = await allocateBrowserArtifactPath(
      workingDir,
      sessionKey,
      'screenshots',
      'png',
      input.label
    );
    artifactPath = artifact.relativePath;
    const args = buildBrowserActionArgs(input, artifact.absolutePath);
    const result = await execFileAsync('agent-browser', [...args, '--json', '--session', browserSession], {
      cwd: workingDir,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    } as any).then((output) => ({
      stdout: toStringOutput((output as any).stdout),
      stderr: toStringOutput((output as any).stderr),
      error: null as Error | null,
    })).catch((error) => ({
      stdout: toStringOutput((error as any).stdout),
      stderr: toStringOutput((error as any).stderr),
      error: error as Error,
    }));
    const parsed = parseBrowserCliJson(result.stdout) ?? parseBrowserCliJson(result.stderr);
    if (parsed) {
      if (parsed.success) {
        return {
          success: true,
          action: input.action,
          args,
          stdout: result.stdout,
          ...(parsed.data !== undefined ? { data: parsed.data } : {}),
          ...(artifactPath ? { artifactPath } : {}),
        };
      }
      return {
        success: false,
        action: input.action,
        args,
        stdout: result.stdout,
        error: parsed.error ?? result.error?.message ?? 'Browser command failed',
      };
    }
    return {
      success: !result.error,
      action: input.action,
      args,
      stdout: result.stdout || result.stderr,
      ...(result.error ? { error: result.error.message || result.stderr || 'Browser command failed' } : {}),
      ...(artifactPath && !result.error ? { artifactPath } : {}),
    };
  }

  if (input.action === 'snapshot') {
    const artifact = await allocateBrowserArtifactPath(
      workingDir,
      sessionKey,
      'snapshots',
      'json'
    );
    snapshotArtifactAbsPath = artifact.absolutePath;
    artifactPath = artifact.relativePath;
  }

  const args = buildBrowserActionArgs(input);
  const rawResult = await execFileAsync('agent-browser', [...args, '--json', '--session', browserSession], {
    cwd: workingDir,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  } as any).then((output) => ({
    stdout: toStringOutput((output as any).stdout),
    stderr: toStringOutput((output as any).stderr),
    error: null as Error | null,
  })).catch((error) => ({
    stdout: toStringOutput((error as any).stdout),
    stderr: toStringOutput((error as any).stderr),
    error: error as Error,
  }));

  const parsed = parseBrowserCliJson(rawResult.stdout) ?? parseBrowserCliJson(rawResult.stderr);
  if (parsed && parsed.success && input.action === 'snapshot' && snapshotArtifactAbsPath) {
    const fs = await import('fs/promises');
    await fs.writeFile(snapshotArtifactAbsPath, JSON.stringify(parsed.data ?? {}, null, 2), 'utf8').catch(() => {});
  }
  if (parsed) {
    return {
      success: parsed.success,
      action: input.action,
      args,
      stdout: rawResult.stdout,
      ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.success && artifactPath ? { artifactPath } : {}),
    };
  }

  if (rawResult.error) {
    return {
      success: false,
      action: input.action,
      args,
      stdout: rawResult.stdout,
      error: rawResult.error.message || rawResult.stderr || 'Browser command failed',
    };
  }
  if (input.action === 'snapshot' && snapshotArtifactAbsPath) {
    const fs = await import('fs/promises');
    const fallback = rawResult.stdout || rawResult.stderr || '{}';
    await fs.writeFile(snapshotArtifactAbsPath, fallback, 'utf8').catch(() => {});
  }
  return {
    success: true,
    action: input.action,
    args,
    stdout: rawResult.stdout,
    ...(artifactPath ? { artifactPath } : {}),
  };
}

function parseBrowserStateFromMetadata(
  metadata: Record<string, unknown> | undefined
): {
  actions: Array<Record<string, unknown>>;
  evidence: BrowserEvidenceItem[];
  lastActionAt?: string;
  lastKnownUrl?: string;
  lastKnownTitle?: string;
} {
  const actions: Array<Record<string, unknown>> = [];
  const evidence = parseBrowserEvidence(metadata?.browser_evidence);
  const agentEvents = Array.isArray(metadata?.agent_events) ? metadata.agent_events : [];
  let lastActionAt: string | undefined;
  let lastActionAtMs = 0;
  let lastKnownUrl: string | undefined;
  let lastKnownTitle: string | undefined;
  for (const event of agentEvents) {
    if (!isRecord(event)) continue;
    const type = asString(event.type);
    if (type !== 'browser_action' && type !== 'browser_evidence_captured') continue;
    const at = asString(event.timestamp);
    const data = isRecord(event.data) ? event.data : {};
    if (type === 'browser_action') {
      const atMs = at ? Date.parse(at) : NaN;
      actions.push({
        at,
        action: asString(data.action),
        success: data.success === false ? false : true,
        error: asString(data.error),
        outputPreview: asString(data.outputPreview),
        artifactPath: asString(data.artifactPath),
        line: asNumber(data.line),
      });
      if (Number.isFinite(atMs) && atMs >= lastActionAtMs) {
        lastActionAtMs = atMs;
        if (at) lastActionAt = at;
        const eventUrl = asString(data.currentUrl);
        const eventTitle = asString(data.title);
        if (eventUrl) lastKnownUrl = eventUrl;
        if (eventTitle) lastKnownTitle = eventTitle;
      } else if (!lastActionAt && at) {
        lastActionAt = at;
      }
      continue;
    }
    const id = asString(data.id);
    const typeRaw = asString(data.type);
    const path = asString(data.path);
    const createdAt = asString(data.createdAt) ?? at;
    if (!id || !typeRaw || !path || !createdAt) continue;
    if (typeRaw !== 'snapshot' && typeRaw !== 'screenshot') continue;
    evidence.push({
      id,
      type: typeRaw,
      path,
      createdAt,
      ...(asString(data.label) ? { label: asString(data.label) } : {}),
      ...(asString(data.url) ? { url: asString(data.url) } : {}),
      ...(asString(data.title) ? { title: asString(data.title) } : {}),
    });
  }
  actions.sort((a, b) => Date.parse(String(b.at ?? '')) - Date.parse(String(a.at ?? '')));
  const evidenceByKey = new Map<string, BrowserEvidenceItem>();
  for (const item of evidence) {
    const key = `${item.id}\u001f${item.path}\u001f${item.createdAt}`;
    if (!evidenceByKey.has(key)) {
      evidenceByKey.set(key, item);
    }
  }
  const dedupedEvidence = Array.from(evidenceByKey.values())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    actions: actions.slice(0, 80),
    evidence: dedupedEvidence.slice(0, 80),
    ...(lastActionAt ? { lastActionAt } : {}),
    ...(lastKnownUrl ? { lastKnownUrl } : {}),
    ...(lastKnownTitle ? { lastKnownTitle } : {}),
  };
}

function parsePackets(value: unknown, defaultSessionKey?: string): FocusPacket[] {
  // Packets are harness-emitted markdown artifacts used by the frontend focus view.
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

function mapSessionStatus(status: string): SessionPanelStatus {
  if (status === 'blocked') return 'blocked';
  if (status === 'review') return 'ready';
  if (status === 'cancelled') return 'stopped';
  if (status === 'completed' || status === 'failed' || status === 'inactive' || status === 'expired') {
    return 'done';
  }
  return 'running';
}

function mapSessionKind(session: SessionRow): SessionKind {
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

function mapGateStatus(value: unknown): 'pass' | 'fail' | 'running' | 'unknown' {
  const normalized = asString(value)?.toLowerCase();
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'success') return 'pass';
  if (normalized === 'fail' || normalized === 'failed' || normalized === 'error') return 'fail';
  if (normalized === 'running' || normalized === 'in_progress') return 'running';
  return 'unknown';
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

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

function readNumberCandidate(candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const parsed = asNumber(candidate);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readArrayLengthCandidate(candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.length;
  }
  return undefined;
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

function getEscalations(session: SessionRow): SessionEscalationRecord[] {
  return parseSessionEscalations(session.metadata?.escalations);
}

function unresolvedEscalations(session: SessionRow): SessionEscalationRecord[] {
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

async function withAgentMemorySql<T>(
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

async function countTestReportsForWindow(start: Date, end: Date): Promise<number | null> {
  const result = await withAgentMemorySql(async (sql) => {
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count
      FROM test_reports
      WHERE created_at >= ${start}
        AND created_at < ${end}
    `;
    return rows[0]?.count ?? '0';
  });
  if (result === null) return null;
  const parsed = parseInt(String(result), 10);
  return Number.isFinite(parsed) ? parsed : 0;
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

/** Strip markdown headings, leading whitespace, and truncate */
function cleanTitle(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+\S+\s*/gm, '')  // strip "## Goal", "# Title" etc.
    .replace(/^\s+/, '')                  // trim leading whitespace/newlines
    .replace(/\n+/g, ' ')                // collapse newlines into spaces
    .slice(0, 200)
    .trim();
}

function getSessionTitle(session: SessionRow): string {
  const metadata = session.metadata ?? {};

  // 1. Dedicated goal column or metadata goal
  const goal = session.goal
    ?? asString(metadata.goal)
    ?? asString(metadata.current_objective)
    ?? asString(metadata.currentObjective);
  if (goal) return cleanTitle(goal);

  // 2. Stored user message preview
  const preview = session.lastUserMessagePreview
    ?? asString(metadata.last_user_prompt)
    ?? asString(metadata.messagePreview);
  if (preview) return cleanTitle(preview);

  // 3. Extract goal from agent_events (runtime_script_created or first send_text)
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
      ?? asString(metadata.current_work_item_id);
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

function normalizeAgentEventType(type: string): NormalizedSessionEvent['type'] {
  if (type === 'agent_message' || type === 'user_message' || type === 'send_text' || type === 'response') return 'message';
  if (type === 'tool_call') return 'tool';
  if (type === 'git_commit') return 'trace';
  if (type.startsWith('browser_')) return 'tool';
  if (type.includes('test')) return 'test';
  if (type.includes('packet')) return 'packet';
  return 'workflow';
}

/**
 * Compute signal priority for an event
 * High: substantial assistant messages, packet events, test failures
 * Medium: user messages, meaningful errors
 * Low: routine tool calls, internal diagnostics
 * Status: events that shouldn't appear in message stream (only for UI indicators)
 */
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
    
    // System messages are usually low priority unless they contain substantial info
    if (content.length > 100) return 'medium';
    return 'low';
  }

  if (event.type === 'tool') {
    const eventType = String(event.payload.eventType ?? '').toLowerCase();
    const data = event.payload.data as Record<string, unknown> | undefined;
    
    // Failed tools are high priority
    const success = data?.success;
    if (success === false) return 'high';
    const status = String(data?.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed' || status === 'fail') return 'high';
    
    // Memory injections are status only (go to Audit)
    if (eventType.includes('memory') || eventType.includes('inject')) return 'status';
    
    // Browser actions are status only (they appear in active tool indicator)
    if (eventType.startsWith('browser_')) return 'status';
    
    // Other tools are low priority
    return 'low';
  }

  if (event.type === 'workflow') {
    const eventType = String(event.payload.eventType ?? '').toLowerCase();
    if (eventType.includes('error') || eventType.includes('fail')) return 'high';
    if (eventType.includes('escalation')) return 'high';
    // Internal events that should not appear in UI
    if (eventType === 'llm_call' || eventType === 'hook_call' || eventType === 'iteration_started' || 
        eventType === 'memory_injected' || eventType.includes('memory') || eventType.includes('inject')) {
      return 'status';
    }
    return 'low';
  }

  return 'low';
}

/**
 * Determine if an event should appear in the main message stream
 * vs being used only for status indicators
 */
function isStatusOnlyEvent(event: NormalizedSessionEvent): boolean {
  return getSignalPriority(event) === 'status';
}

function buildSessionEvents(
  session: SessionRow,
  messages: MessageRow[],
  limit: number,
  cursor?: number
): { events: NormalizedSessionEvent[]; nextCursor: number | null } {
  const normalized: Array<{ ts: number; event: NormalizedSessionEvent }> = [];

  for (const message of messages) {
    const ts = message.createdAt * 1000;
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
    normalized.push({ ts, event });
  }

  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata?.agent_events : [];
  for (const entry of agentEvents) {
    if (!isRecord(entry)) continue;
    const type = asString(entry.type);
    const ts = parseTimestampMs(entry.timestamp);
    if (!type || !ts) continue;
    
    // Skip internal events that slow down server and UI
    if (type === 'llm_call' || type === 'hook_call' || type === 'iteration_started' || 
        type === 'memory_injected' || (type.includes('memory') && type.includes('inject'))) {
      continue;
    }
    
    const normalizedType = normalizeAgentEventType(type);
    const data = isRecord(entry.data) ? entry.data : {};
    const defaultRole = (type === 'user_message' || type === 'send_text') ? 'user' : 'assistant';
    const messageRole = asString(data.role) ?? asString(entry.role) ?? defaultRole;
    const messageContent = extractText(data.content)
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
        workItemId: asString(entry.work_item_id),
        ...(normalizedType === 'message' ? { role: messageRole, content: messageContent } : {}),
        data,
      },
    };
    event.signalPriority = getSignalPriority(event);
    event.isStatusOnly = isStatusOnlyEvent(event);
    normalized.push({ ts, event });
  }

  normalized.sort((a, b) => a.ts - b.ts);
  const filtered = cursor
    ? normalized.filter((entry) => entry.ts > cursor)
    : normalized;
  const sliced = filtered.slice(-limit);
  const nextCursor = sliced.length > 0 ? sliced[sliced.length - 1].ts : null;

  return {
    events: sliced.map((entry) => entry.event),
    nextCursor,
  };
}

/**
 * Handle control-plane API requests
 * Returns true if the request was handled, false otherwise
 */
export function handleControlPlaneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): boolean {
  const { pathname, query } = parseUrl(req);

  // Only handle /control-plane/* routes
  if (!pathname.startsWith('/control-plane/')) {
    return false;
  }

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Route handling
  let params: Record<string, string> | null;

  // GET /control-plane/projects
  if (pathname === '/control-plane/projects' && req.method === 'GET') {
    handleGetProjects(res, ctx);
    return true;
  }

  // GET /control-plane/projects/:id/features
  params = matchRoute('/control-plane/projects/:id/features', pathname);
  if (params && req.method === 'GET') {
    void handleGetFeatures(res, ctx, params.id);
    return true;
  }

  // GET /control-plane/projects/:id/sessions
  params = matchRoute('/control-plane/projects/:id/sessions', pathname);
  if (params && req.method === 'GET') {
    handleGetProjectSessions(res, ctx, params.id);
    return true;
  }

  // GET /control-plane/features/:id/prs
  params = matchRoute('/control-plane/features/:id/prs', pathname);
  if (params && req.method === 'GET') {
    const owner = query.get('owner');
    const repo = query.get('repo');
    void handleGetPRs(res, params.id, owner, repo);
    return true;
  }

  // GET /control-plane/sessions
  if (pathname === '/control-plane/sessions' && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '50', 10);
    handleGetSessions(res, ctx, limit);
    return true;
  }

  // GET /control-plane/sessions/:id
  params = matchRoute('/control-plane/sessions/:id', pathname);
  if (params && req.method === 'GET') {
    handleGetSession(res, ctx, params.id);
    return true;
  }

  // GET /control-plane/sessions/:id/messages
  params = matchRoute('/control-plane/sessions/:id/messages', pathname);
  if (params && req.method === 'GET') {
    handleGetSessionMessages(res, ctx, params.id);
    return true;
  }

  // POST /control-plane/sessions/:id/message
  params = matchRoute('/control-plane/sessions/:id/message', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionMessage(req, res, ctx, params.id);
    return true;
  }

  // POST /control-plane/sessions/:id/stop
  params = matchRoute('/control-plane/sessions/:id/stop', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionControl(req, res, ctx, params.id, 'stop');
    return true;
  }

  // GET /control-plane/goals/hierarchy
  if (pathname === '/control-plane/goals/hierarchy' && req.method === 'GET') {
    handleGetGoalHierarchy(res);
    return true;
  }

  // GET /control-plane/token-usage
  if (pathname === '/control-plane/token-usage' && req.method === 'GET') {
    handleGetTokenUsage(res, ctx);
    return true;
  }

  // GET /control-plane/projects/:id/git
  params = matchRoute('/control-plane/projects/:id/git', pathname);
  if (params && req.method === 'GET') {
    void handleGetGitInfo(res, params.id);
    return true;
  }

  // GET /control-plane/traces
  if (pathname === '/control-plane/traces' && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '50', 10);
    void handleGetTraces(res, ctx, limit);
    return true;
  }

  // GET /control-plane/traces/revision/:revision
  params = matchRoute('/control-plane/traces/revision/:revision', pathname);
  if (params && req.method === 'GET') {
    void handleGetTraceByRevision(res, ctx, params.revision);
    return true;
  }

  // GET /control-plane/live-sessions
  if (pathname === '/control-plane/live-sessions' && req.method === 'GET') {
    handleGetLiveSessions(res, ctx);
    return true;
  }

  // GET /control-plane/cockpit/rollups/sessions?status=running|ready|done
  if (pathname === '/control-plane/cockpit/rollups/sessions' && req.method === 'GET') {
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '100', 10);
    void handleGetCockpitSessionRollups(res, ctx, status, limit);
    return true;
  }

  // GET /control-plane/cockpit/rollups/snapshot?sessionLimit=120&escalationLimit=120&repoLimit=50&includeRepo=0|1
  if (pathname === '/control-plane/cockpit/rollups/snapshot' && req.method === 'GET') {
    const sessionLimit = parseInt(query.get('sessionLimit') ?? '120', 10);
    const escalationLimit = parseInt(query.get('escalationLimit') ?? '120', 10);
    const repoLimit = parseInt(query.get('repoLimit') ?? '50', 10);
    const includeRepo = query.get('includeRepo') !== '0';
    const date = query.get('date');
    void handleGetCockpitRollupSnapshot(res, ctx, {
      sessionLimit,
      escalationLimit,
      repoLimit,
      includeRepo,
      date,
    });
    return true;
  }

  // GET /control-plane/cockpit/rollups/escalations?status=open
  if (pathname === '/control-plane/cockpit/rollups/escalations' && req.method === 'GET') {
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '100', 10);
    handleGetCockpitEscalationRollups(res, ctx, status, limit);
    return true;
  }

  // GET /control-plane/cockpit/rollups/commits?limit=50
  if (pathname === '/control-plane/cockpit/rollups/commits' && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '50', 10);
    void handleGetCockpitCommitRollups(res, ctx, limit);
    return true;
  }

  // GET /control-plane/cockpit/rollups/prs?status=open&limit=50
  if (pathname === '/control-plane/cockpit/rollups/prs' && req.method === 'GET') {
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '50', 10);
    void handleGetCockpitPRRollups(res, ctx, status, limit);
    return true;
  }

  // GET /control-plane/cockpit/metrics/daily?date=YYYY-MM-DD
  if (pathname === '/control-plane/cockpit/metrics/daily' && req.method === 'GET') {
    const date = query.get('date');
    void handleGetCockpitDailyMetrics(res, ctx, date);
    return true;
  }

  // GET /control-plane/cockpit/focus?type=session|escalation&id=...
  if (pathname === '/control-plane/cockpit/focus' && req.method === 'GET') {
    const type = query.get('type');
    const id = query.get('id');
    const packetId = query.get('packetId');
    void handleGetCockpitFocus(res, ctx, type, id, packetId);
    return true;
  }

  // GET /control-plane/cockpit/traces?sessionKey=...&workItemId=...&limit=...
  if (pathname === '/control-plane/cockpit/traces' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    const workItemId = query.get('workItemId');
    const limit = parseInt(query.get('limit') ?? '200', 10);
    void handleGetCockpitTraces(res, ctx, sessionKey, workItemId, limit);
    return true;
  }

  // GET /control-plane/cockpit/diff?sessionKey=...&base=...&head=...&file=...
  if (pathname === '/control-plane/cockpit/diff' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    const base = query.get('base');
    const head = query.get('head');
    const file = query.get('file');
    void handleGetCockpitDiff(res, ctx, sessionKey, base, head, file);
    return true;
  }

  // GET /control-plane/cockpit/tests?sessionKey=...&workItemId=...&limit=...
  if (pathname === '/control-plane/cockpit/tests' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    const workItemId = query.get('workItemId');
    const limit = parseInt(query.get('limit') ?? '20', 10);
    void handleGetCockpitTestReports(res, sessionKey, workItemId, limit);
    return true;
  }

  // GET /control-plane/cockpit/tests/:testReportId
  params = matchRoute('/control-plane/cockpit/tests/:testReportId', pathname);
  if (params && req.method === 'GET') {
    void handleGetCockpitTestReportById(res, params.testReportId);
    return true;
  }

  // GET /control-plane/cockpit/repo/lens|grep?q=...&kind=all|defs|refs|text&sessionKey=...
  if ((pathname === '/control-plane/cockpit/repo/lens' || pathname === '/control-plane/cockpit/repo/grep') && req.method === 'GET') {
    const q = query.get('q');
    const kind = query.get('kind');
    const sessionKey = query.get('sessionKey');
    const limit = parseInt(query.get('limit') ?? '120', 10);
    void handleGetCockpitRepoLens(res, ctx, q, kind, sessionKey, limit);
    return true;
  }

  // GET /control-plane/cockpit/preview?url=... OR ?sessionKey=...
  if (pathname === '/control-plane/cockpit/preview' && req.method === 'GET') {
    const url = query.get('url');
    const sessionKey = query.get('sessionKey');
    handleGetCockpitPreview(res, ctx, url, sessionKey);
    return true;
  }

  // GET /control-plane/cockpit/browser/state?sessionKey=...
  if (pathname === '/control-plane/cockpit/browser/state' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    void handleGetCockpitBrowserState(res, ctx, sessionKey);
    return true;
  }

  // POST /control-plane/cockpit/browser/action
  if (pathname === '/control-plane/cockpit/browser/action' && req.method === 'POST') {
    void handlePostCockpitBrowserAction(req, res, ctx);
    return true;
  }

  // POST /control-plane/cockpit/browser/runbook
  if (pathname === '/control-plane/cockpit/browser/runbook' && req.method === 'POST') {
    void handlePostCockpitBrowserRunbook(req, res, ctx);
    return true;
  }

  // GET /control-plane/cockpit/markdown/tree
  if (pathname === '/control-plane/cockpit/markdown/tree' && req.method === 'GET') {
    void handleGetCockpitMarkdownTree(res, ctx);
    return true;
  }

  // GET /control-plane/cockpit/markdown/file?path=...
  if (pathname === '/control-plane/cockpit/markdown/file' && req.method === 'GET') {
    const filePath = query.get('path');
    void handleGetCockpitMarkdownFile(res, ctx, filePath);
    return true;
  }

  // POST /control-plane/cockpit/markdown/file
  if (pathname === '/control-plane/cockpit/markdown/file' && req.method === 'POST') {
    void handlePostCockpitMarkdownFile(req, res, ctx);
    return true;
  }

  // POST /control-plane/cockpit/markdown/folder
  if (pathname === '/control-plane/cockpit/markdown/folder' && req.method === 'POST') {
    void handlePostCockpitMarkdownFolder(req, res, ctx);
    return true;
  }

  // POST /control-plane/cockpit/markdown/import
  if (pathname === '/control-plane/cockpit/markdown/import' && req.method === 'POST') {
    void handlePostCockpitMarkdownImport(req, res, ctx);
    return true;
  }

  // POST /control-plane/cockpit/markdown/patch
  if (pathname === '/control-plane/cockpit/markdown/patch' && req.method === 'POST') {
    void handlePostCockpitMarkdownPatch(req, res, ctx);
    return true;
  }

  // GET /control-plane/cockpit/session/:sessionKey/events?cursor=...&limit=...
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/events', pathname);
  if (params && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '200', 10);
    const cursor = query.get('cursor');
    handleGetCockpitSessionEvents(res, ctx, params.sessionKey, limit, cursor);
    return true;
  }

  // GET /control-plane/cockpit/session/:sessionKey/packets?limit=...
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/packets', pathname);
  if (params && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '20', 10);
    handleGetCockpitSessionPackets(res, ctx, params.sessionKey, limit);
    return true;
  }

  // POST /control-plane/cockpit/packets
  if (pathname === '/control-plane/cockpit/packets' && req.method === 'POST') {
    void handlePostCockpitPacket(req, res, ctx);
    return true;
  }

  // POST /control-plane/cockpit/session/:sessionKey/message
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/message', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionMessage(req, res, ctx, params.sessionKey);
    return true;
  }

  // POST /control-plane/cockpit/session/:sessionKey/control
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/control', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionControl(req, res, ctx, params.sessionKey);
    return true;
  }

  // POST /control-plane/cockpit/session/:sessionKey/review
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/review', pathname);
  if (params && req.method === 'POST') {
    void handlePostSessionReviewDecision(req, res, ctx, params.sessionKey);
    return true;
  }

  // POST /control-plane/cockpit/escalations/:id/resolve
  params = matchRoute('/control-plane/cockpit/escalations/:id/resolve', pathname);
  if (params && req.method === 'POST') {
    void handleResolveCockpitEscalation(req, res, ctx, params.id);
    return true;
  }

  // POST /control-plane/cockpit/patch/apply
  if (pathname === '/control-plane/cockpit/patch/apply' && req.method === 'POST') {
    void handlePostCockpitPatchApply(req, res, ctx);
    return true;
  }

  // GET /control-plane/cockpit/templates
  if (pathname === '/control-plane/cockpit/templates' && req.method === 'GET') {
    void handleGetCockpitTemplates(res);
    return true;
  }

  // POST /control-plane/cockpit/session/create
  if (pathname === '/control-plane/cockpit/session/create' && req.method === 'POST') {
    void handlePostCockpitSessionCreate(req, res, ctx);
    return true;
  }

  // 404 for unmatched control-plane routes
  sendJson(res, { error: 'Not found' }, 404);
  return true;
}

function getAllSessions(
  ctx: ControlPlaneContext,
  limit = 1000
): { sessions: SessionRow[]; error?: string } {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    return { sessions: [], error: 'GraphD not available' };
  }
  const result = ctx.graphd.sessionsList({
    status: [...ALL_SESSION_STATUSES],
    limit,
    includePreview: true,
  }) as { sessions?: SessionRow[]; error?: string };
  return {
    sessions: result.sessions ?? [],
    ...(result.error ? { error: result.error } : {}),
  };
}

function getSession(ctx: ControlPlaneContext, sessionKey: string): SessionRow | null {
  if (!ctx.isGraphDReady() || !ctx.graphd) return null;
  const result = ctx.graphd.sessionGet(sessionKey) as { session?: SessionRow };
  return result.session ?? null;
}

function clampInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function groupSessionsByWorkingDir(sessions: SessionRow[]): Map<string, SessionRow[]> {
  const sessionsByWorkingDir = new Map<string, SessionRow[]>();
  for (const session of sessions) {
    if (!session.workingDir) continue;
    const list = sessionsByWorkingDir.get(session.workingDir) ?? [];
    list.push(session);
    sessionsByWorkingDir.set(session.workingDir, list);
  }
  for (const list of sessionsByWorkingDir.values()) {
    list.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  }
  return sessionsByWorkingDir;
}

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

interface CockpitDailyMetricsResult {
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

async function computeCockpitDailyMetrics(
  ctx: ControlPlaneContext,
  sessions: SessionRow[],
  dateParam: string | null
): Promise<CockpitDailyMetricsResult> {
  const day = dateParam ?? new Date().toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    return { date: day, metrics: null, error: `Invalid date: ${day}` };
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const startMs = start.getTime();
  const endMs = end.getTime();

  const traces = await loadTraceRecords(ctx.workingDir, 500);
  const traceInDay = traces.filter((trace) => {
    const ts = parseTimestampMs(trace.timestamp);
    return typeof ts === 'number' && ts >= startMs && ts < endMs;
  });

  const revisions = new Set<string>();
  const touchedFiles = new Set<string>();
  for (const trace of traceInDay) {
    const vcs = isRecord(trace.vcs) ? trace.vcs : null;
    const revision = asString(vcs?.revision);
    if (revision) revisions.add(revision);
    const files = Array.isArray(trace.files) ? trace.files : [];
    for (const file of files) {
      if (!isRecord(file)) continue;
      const p = asString(file.path);
      if (p) touchedFiles.add(p);
    }
  }

  let totalTokens = 0;
  const testReportCount = await countTestReportsForWindow(start, end);
  let tests = testReportCount ?? 0;
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
    if (testReportCount === null && updatedMs >= startMs && updatedMs < endMs) {
      tests += asNumber(metadata.tests_run ?? metadata.testsRun) ?? 0;
    }
  }

  const rollups = buildSessionRollups(
    sessions,
    new Map(),
    await loadLatestTestReports(sessions.map((session) => session.sessionKey))
  );
  const running = rollups.filter((item) => item.status === 'running').length;
  const ready = rollups.filter((item) => item.status === 'ready').length;
  const done = rollups.filter((item) => item.status === 'done' || item.status === 'stopped').length;

  return {
    date: day,
    metrics: {
      tokens: totalTokens,
      locTouched: touchedFiles.size,
      commits: revisions.size,
      prs: 0,
      tests,
      sessions: {
        running,
        ready,
        done,
      },
      escalationsOpen: buildEscalationRollups(sessions).length,
    },
  };
}

interface CockpitRollupSnapshotResult {
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

  const { sessions, error } = getAllSessions(ctx, 1000);
  if (error) {
    const metrics = await computeCockpitDailyMetrics(ctx, [], options.date);
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

  const traces = await loadTraceRecords(ctx.workingDir, Math.max(300, sessionLimit * 4));
  const traceMap = new Map<string, TraceSummary>();
  for (const session of sessions) {
    traceMap.set(session.sessionKey, buildTraceSummary(session.sessionKey, traces));
  }

  const [testReports, diffstatsBySession, metrics] = await Promise.all([
    loadLatestTestReports(sessions.map((session) => session.sessionKey)),
    loadSessionDiffstats(sessions),
    computeCockpitDailyMetrics(ctx, sessions, options.date),
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

async function handleGetCockpitSessionRollups(
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

  const traces = await loadTraceRecords(ctx.workingDir, Math.max(200, limit * 3));
  const traceMap = new Map<string, TraceSummary>();
  for (const session of sessions) {
    traceMap.set(session.sessionKey, buildTraceSummary(session.sessionKey, traces));
  }
  const testReports = await loadLatestTestReports(sessions.map((session) => session.sessionKey));
  const diffstatsBySession = await loadSessionDiffstats(sessions);

  const filtered = buildSessionRollups(sessions, traceMap, testReports, diffstatsBySession)
    .filter((rollup) => !status || rollup.status === status)
    .slice(0, limit);

  sendJson(res, { rollups: filtered, total: filtered.length });
}

async function handleGetCockpitRollupSnapshot(
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

    const snapshot = await buildCockpitRollupSnapshot(ctx, options);
    cockpitSnapshotCache = {
      key: cacheKey,
      expiresAt: now + COCKPIT_SNAPSHOT_CACHE_TTL_MS,
      data: snapshot,
    };
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

function handleGetCockpitEscalationRollups(
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

async function handleGetCockpitCommitRollups(
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

async function handleGetCockpitPRRollups(
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

async function handleGetCockpitDailyMetrics(
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
  const metrics = await computeCockpitDailyMetrics(ctx, sessions, dateParam);
  if (metrics.error) {
    sendJson(res, { date: metrics.date, metrics: metrics.metrics, error: metrics.error }, 400);
    return;
  }
  sendJson(res, metrics);
}

async function handleGetCockpitFocus(
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

    const traces = await loadTraceRecords(ctx.workingDir, 200);
    const traceMap = new Map<string, TraceSummary>([
      [session.sessionKey, buildTraceSummary(session.sessionKey, traces)],
    ]);
    const testReports = await loadLatestTestReports([session.sessionKey]);
    const diffstatsBySession = await loadSessionDiffstats([session]);
    const rollup = buildSessionRollups([session], traceMap, testReports, diffstatsBySession)[0];
    const sessionPackets = parsePackets(session.metadata?.packets, session.sessionKey);
    const unresolved = unresolvedEscalations(session).sort((a, b) => b.createdAt - a.createdAt);
    const selectedPacket = packetId
      ? sessionPackets.find((packet) => packet.packetId === packetId) ?? null
      : sessionPackets[0] ?? null;

    sendJson(res, {
      focus: {
        type: 'session',
        id: session.sessionKey,
        sessionKey: session.sessionKey,
        header: {
          title: rollup.title,
          status: rollup.status,
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

    sendJson(res, {
      focus: {
        type: 'escalation',
        id: escalation.id,
        sessionKey: escalation.sessionKey,
        header: {
          title: escalation.title,
          status: escalation.status,
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

async function handleGetCockpitTraces(
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
    workingDir = session.workingDir ?? workingDir;
  }

  const traces = await loadTraceRecords(workingDir, Math.max(limit * 2, 200));
  const filtered = sessionKey
    ? traces.filter((trace) => traceMatchesSession(trace, sessionKey))
    : traces;
  sendJson(res, { traces: filtered.slice(0, limit) });
}

async function resolveDiffRange(
  session: SessionRow | null,
  workingDir: string,
  baseRaw: string | null,
  headRaw: string | null
): Promise<{ baseSha?: string; headSha?: string; source: 'query' | 'session' | 'git-parent' | 'unknown' }> {
  const queryBase = asString(baseRaw);
  const queryHead = asString(headRaw);
  if (queryBase && queryHead) {
    return { baseSha: queryBase, headSha: queryHead, source: 'query' };
  }

  if (session) {
    const fromSession = getLatestRevisionRange(session, queryHead ?? undefined);
    if (fromSession.headSha && fromSession.baseSha) {
      return { ...fromSession, source: 'session' };
    }
    if (fromSession.headSha) {
      try {
        const parent = await execFileText(
          'git',
          ['rev-parse', `${fromSession.headSha}^`],
          { cwd: workingDir, timeout: 10_000 }
        );
        const parentSha = parent.trim();
        if (parentSha) {
          return {
            baseSha: parentSha,
            headSha: fromSession.headSha,
            source: 'git-parent',
          };
        }
      } catch {
        // Keep unresolved and return unknown below.
      }
    }
  }

  if (!queryBase && queryHead) {
    try {
      const parent = await execFileText('git', ['rev-parse', `${queryHead}^`], {
        cwd: workingDir,
        timeout: 10_000,
      });
      const parentSha = parent.trim();
      if (parentSha) {
        return { baseSha: parentSha, headSha: queryHead, source: 'git-parent' };
      }
    } catch {
      // Keep unresolved and return unknown below.
    }
  }

  return {
    ...(queryBase ? { baseSha: queryBase } : {}),
    ...(queryHead ? { headSha: queryHead } : {}),
    source: 'unknown',
  };
}

async function resolveRepoHeadRange(
  workingDir: string,
  headCandidate?: string
): Promise<{ baseSha: string; headSha: string; source: 'git-parent' | 'unknown' } | null> {
  let headSha = headCandidate;
  if (!headSha) {
    try {
      headSha = asString(await execFileText('git', ['rev-parse', 'HEAD'], {
        cwd: workingDir,
        timeout: 10_000,
      }));
    } catch {
      return null;
    }
  }
  if (!headSha) return null;

  try {
    const parent = await execFileText('git', ['rev-parse', `${headSha}^`], {
      cwd: workingDir,
      timeout: 10_000,
    });
    const parentSha = parent.trim();
    if (parentSha) {
      return { baseSha: parentSha, headSha, source: 'git-parent' };
    }
  } catch {
    // Root commit or no parent; fall back to a zero-diff range.
  }

  return { baseSha: headSha, headSha, source: 'unknown' };
}

async function resolveWorkingTreeDiff(
  workingDir: string,
  file?: string
): Promise<{
  baseSha: string;
  headSha: string;
  source: 'working-tree';
  summary: { added: number; deleted: number; filesTouched: number };
  hotspots: DiffHotspot[];
  patch: string | null;
} | null> {
  try {
    const headSha = (await execFileText('git', ['rev-parse', 'HEAD'], {
      cwd: workingDir,
      timeout: 10_000,
    })).trim();
    if (!headSha) return null;

    const numstat = await execFileText(
      'git',
      ['diff', '--numstat', '--no-color', 'HEAD'],
      { cwd: workingDir, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const { summary, hotspots } = parseNumstatOutput(numstat);

    let patch: string | null = null;
    if (file) {
      const diffOut = await execFileText(
        'git',
        ['diff', '--no-color', '--unified=3', 'HEAD', '--', file],
        { cwd: workingDir, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
      );
      patch = diffOut.length > 500_000 ? `${diffOut.slice(0, 500_000)}\n\n... (truncated)` : diffOut;
    }

    return {
      baseSha: headSha,
      headSha,
      source: 'working-tree',
      summary,
      hotspots: hotspots.slice(0, 100),
      patch,
    };
  } catch {
    return null;
  }
}

async function handleGetCockpitDiff(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string | null,
  baseRaw: string | null,
  headRaw: string | null,
  fileRaw: string | null
): Promise<void> {
  const file = asString(fileRaw);
  const hasExplicitRange = !!(asString(baseRaw) || asString(headRaw));
  const session = sessionKey ? getSession(ctx, sessionKey) : null;
  if (sessionKey && !session) {
    sendJson(res, { error: 'Session not found' }, 404);
    return;
  }
  const workingDir = session?.workingDir ?? ctx.workingDir;
  let range = await resolveDiffRange(session, workingDir, baseRaw, headRaw);

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
      warning: 'Missing diff range. Provide base/head or ensure session has commit history.',
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

async function handleGetCockpitTestReports(
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

async function handleGetCockpitTestReportById(
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

async function handleGetCockpitRepoLens(
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

function handleGetCockpitPreview(
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

function readBrowserString(data: unknown): string | undefined {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!isRecord(data)) return undefined;
  return asString(data.url) ?? asString(data.title) ?? asString(data.value) ?? asString(data.text);
}

async function probeBrowserPage(
  workingDir: string,
  browserSession: string,
  sessionKey: string
): Promise<{ currentUrl?: string; title?: string; connected: boolean }> {
  const [urlResult, titleResult] = await Promise.all([
    runBrowserAction(workingDir, browserSession, sessionKey, { action: 'get_url' }),
    runBrowserAction(workingDir, browserSession, sessionKey, { action: 'get_title' }),
  ]);
  const currentUrl = urlResult.success ? readBrowserString(urlResult.data) : undefined;
  const title = titleResult.success ? readBrowserString(titleResult.data) : undefined;
  return {
    ...(currentUrl ? { currentUrl } : {}),
    ...(title ? { title } : {}),
    connected: Boolean(currentUrl || title),
  };
}

async function handleGetCockpitBrowserState(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKeyRaw: string | null
): Promise<void> {
  const sessionKey = asString(sessionKeyRaw);
  if (!sessionKey) {
    sendJson(res, { success: false, error: 'Missing required query param: sessionKey' }, 400);
    return;
  }
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: 'Session not found' }, 404);
    return;
  }

  const workingDir = session.workingDir ?? ctx.workingDir;
  const browserSession = normalizeBrowserSessionName(sessionKey);
  const parsed = parseBrowserStateFromMetadata(session.metadata);
  const available = await checkAgentBrowserAvailable(workingDir);
  let connected = false;
  let currentUrl = parsed.lastKnownUrl;
  let title = parsed.lastKnownTitle;

  if (available) {
    let probe: { currentUrl?: string; title?: string; connected: boolean } = { connected: false };
    try {
      probe = await probeBrowserPage(workingDir, browserSession, sessionKey);
    } catch {
      probe = { connected: false };
    }
    connected = probe.connected;
    if (probe.currentUrl) currentUrl = probe.currentUrl;
    if (probe.title) title = probe.title;
  }

  let lastSnapshotPreview: string | undefined;
  const latestSnapshot = parsed.evidence.find((item) => item.type === 'snapshot');
  if (latestSnapshot) {
    const resolved = await resolveSessionFilePath(workingDir, latestSnapshot.path);
    if (resolved.resolvedPath) {
      const fs = await import('fs/promises');
      const preview = await fs.readFile(resolved.resolvedPath, 'utf8').catch(() => '');
      if (preview) {
        lastSnapshotPreview = preview.slice(0, 3000);
      }
    }
  }

  sendJson(res, {
    success: true,
    state: {
      sessionKey,
      browserSession,
      available,
      connected,
      ...(currentUrl ? { currentUrl } : {}),
      ...(title ? { title } : {}),
      ...(parsed.lastActionAt ? { lastActionAt: parsed.lastActionAt } : {}),
      actions: parsed.actions,
      evidence: parsed.evidence,
      ...(latestSnapshot ? { lastSnapshotPath: latestSnapshot.path } : {}),
      ...(lastSnapshotPreview ? { lastSnapshotPreview } : {}),
    },
  });
}

async function handlePostCockpitBrowserAction(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
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
  const workingDir = session.workingDir ?? ctx.workingDir;
  const available = await checkAgentBrowserAvailable(workingDir);
  if (!available) {
    sendJson(res, { success: false, error: 'agent-browser is not available or failed to start' }, 503);
    return;
  }

  const parsedInput = parseBrowserActionInput(body);
  if (!parsedInput.input || parsedInput.error) {
    sendJson(res, { success: false, error: parsedInput.error ?? 'Invalid browser action payload' }, 400);
    return;
  }
  const input = parsedInput.input;
  const browserSession = normalizeBrowserSessionName(sessionKey);
  const result = await runBrowserAction(workingDir, browserSession, sessionKey, input);
  const nowIso = new Date().toISOString();

  let currentUrl = input.action === 'get_url' ? readBrowserString(result.data) : undefined;
  let title = input.action === 'get_title' ? readBrowserString(result.data) : undefined;
  if (result.success && input.action !== 'close' && (!currentUrl || !title)) {
    let probe: { currentUrl?: string; title?: string; connected: boolean } = { connected: false };
    try {
      probe = await probeBrowserPage(workingDir, browserSession, sessionKey);
    } catch {
      probe = { connected: false };
    }
    if (!currentUrl && probe.currentUrl) currentUrl = probe.currentUrl;
    if (!title && probe.title) title = probe.title;
  }

  const outputPreview = summarizeBrowserData(result.data) ?? summarizeBrowserData(result.stdout);
  const actionEvent: Record<string, unknown> = {
    type: 'browser_action',
    timestamp: nowIso,
    ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
    ...(asString(body.workItemId) ? { work_item_id: asString(body.workItemId) } : {}),
    data: {
      action: input.action,
      success: result.success,
      browserSession,
      args: result.args,
      ...(outputPreview ? { outputPreview } : {}),
      ...(result.artifactPath ? { artifactPath: result.artifactPath } : {}),
      ...(currentUrl ? { currentUrl } : {}),
      ...(title ? { title } : {}),
      ...(result.error ? { error: result.error } : {}),
    },
  };

  let evidenceItem: BrowserEvidenceItem | undefined;
  if (result.success && result.artifactPath && (input.action === 'snapshot' || input.action === 'screenshot')) {
    evidenceItem = {
      id: buildBrowserEvidenceId(sessionKey),
      type: input.action === 'snapshot' ? 'snapshot' : 'screenshot',
      path: result.artifactPath,
      createdAt: nowIso,
      ...(input.label ? { label: input.label } : {}),
      ...(currentUrl ? { url: currentUrl } : {}),
      ...(title ? { title } : {}),
    };
  }

  if (ctx.graphd) {
    const agentEvents: Record<string, unknown>[] = [actionEvent];
    if (evidenceItem) {
      agentEvents.push({
        type: 'browser_evidence_captured',
        timestamp: nowIso,
        ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
        ...(asString(body.workItemId) ? { work_item_id: asString(body.workItemId) } : {}),
        data: evidenceItem,
      });
    }
    const metadataPatch: Record<string, unknown> = {
      agent_events: agentEvents,
      ...(result.success && currentUrl ? { previewUrl: currentUrl } : {}),
      ...(evidenceItem ? { browser_evidence: [evidenceItem] } : {}),
      ...(input.action === 'snapshot' && result.success && result.artifactPath
        ? { browser_last_snapshot_path: result.artifactPath }
        : {}),
    };
    ctx.graphd.sessionUpdateMetadata(sessionKey, metadataPatch);
  }

  if (!result.success) {
    sendJson(
      res,
      {
        success: false,
        action: input.action,
        browserSession,
        error: result.error ?? 'Browser action failed',
        ...(result.stdout ? { output: result.stdout } : {}),
      },
      400
    );
    return;
  }

  sendJson(res, {
    success: true,
    action: input.action,
    browserSession,
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.stdout ? { output: result.stdout } : {}),
    ...(result.artifactPath ? { artifactPath: result.artifactPath } : {}),
    ...(currentUrl ? { currentUrl } : {}),
    ...(title ? { title } : {}),
    ...(evidenceItem ? { evidence: evidenceItem } : {}),
  });
}

async function handlePostCockpitBrowserRunbook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
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
  const workingDir = session.workingDir ?? ctx.workingDir;
  const available = await checkAgentBrowserAvailable(workingDir);
  if (!available) {
    sendJson(res, { success: false, error: 'agent-browser is not available or failed to start' }, 503);
    return;
  }
  const script = typeof body.script === 'string' ? body.script : '';
  if (!script.trim()) {
    sendJson(res, { success: false, error: 'Missing required field: script' }, 400);
    return;
  }
  if (Buffer.byteLength(script, 'utf8') > 50_000) {
    sendJson(res, { success: false, error: 'Runbook script exceeds 50KB limit' }, 400);
    return;
  }
  const parsed = parseBrowserRunbook(script);
  if (parsed.error) {
    sendJson(res, { success: false, error: parsed.error }, 400);
    return;
  }
  const steps = parsed.steps;
  const stopOnError = asBoolean(body.stopOnError) !== false;
  const browserSession = normalizeBrowserSessionName(sessionKey);
  const results: Array<Record<string, unknown>> = [];
  const agentEvents: Record<string, unknown>[] = [];
  const evidenceItems: BrowserEvidenceItem[] = [];
  const nowIso = new Date().toISOString();

  for (const step of steps) {
    const stepResult = await runBrowserAction(workingDir, browserSession, sessionKey, step.input);
    const outputPreview = summarizeBrowserData(stepResult.data) ?? summarizeBrowserData(stepResult.stdout);
    let evidenceItem: BrowserEvidenceItem | undefined;
    if (stepResult.success && stepResult.artifactPath && (step.input.action === 'snapshot' || step.input.action === 'screenshot')) {
      evidenceItem = {
        id: buildBrowserEvidenceId(sessionKey),
        type: step.input.action === 'snapshot' ? 'snapshot' : 'screenshot',
        path: stepResult.artifactPath,
        createdAt: nowIso,
        ...(step.input.label ? { label: step.input.label } : {}),
      };
      evidenceItems.push(evidenceItem);
      agentEvents.push({
        type: 'browser_evidence_captured',
        timestamp: new Date().toISOString(),
        ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
        ...(asString(body.workItemId) ? { work_item_id: asString(body.workItemId) } : {}),
        data: evidenceItem,
      });
    }

    agentEvents.push({
      type: 'browser_action',
      timestamp: new Date().toISOString(),
      ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
      ...(asString(body.workItemId) ? { work_item_id: asString(body.workItemId) } : {}),
      data: {
        action: step.input.action,
        line: step.line,
        success: stepResult.success,
        browserSession,
        args: stepResult.args,
        ...(outputPreview ? { outputPreview } : {}),
        ...(stepResult.artifactPath ? { artifactPath: stepResult.artifactPath } : {}),
        ...(stepResult.error ? { error: stepResult.error } : {}),
      },
    });

    results.push({
      line: step.line,
      action: step.input.action,
      success: stepResult.success,
      ...(stepResult.error ? { error: stepResult.error } : {}),
      ...(stepResult.data !== undefined ? { data: stepResult.data } : {}),
      ...(stepResult.artifactPath ? { artifactPath: stepResult.artifactPath } : {}),
      ...(outputPreview ? { outputPreview } : {}),
    });
    if (!stepResult.success && stopOnError) {
      break;
    }
  }

  let currentUrl: string | undefined;
  let title: string | undefined;
  let probe: { currentUrl?: string; title?: string; connected: boolean } = { connected: false };
  try {
    probe = await probeBrowserPage(workingDir, browserSession, sessionKey);
  } catch {
    probe = { connected: false };
  }
  if (probe.currentUrl) currentUrl = probe.currentUrl;
  if (probe.title) title = probe.title;

  if (ctx.graphd) {
    const metadataPatch: Record<string, unknown> = {
      agent_events: agentEvents,
      ...(evidenceItems.length > 0 ? { browser_evidence: evidenceItems } : {}),
      ...(currentUrl ? { previewUrl: currentUrl } : {}),
    };
    ctx.graphd.sessionUpdateMetadata(sessionKey, metadataPatch);
  }

  const succeeded = results.every((item) => item.success !== false);
  sendJson(res, {
    success: succeeded,
    browserSession,
    stopOnError,
    steps: results,
    ...(currentUrl ? { currentUrl } : {}),
    ...(title ? { title } : {}),
    ...(evidenceItems.length > 0 ? { evidence: evidenceItems } : {}),
  });
}

async function handleGetCockpitMarkdownTree(
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  try {
    const data = await buildCockpitMarkdownWorkspaceTree(ctx);
    sendJson(res, {
      rootDir: MARKDOWN_WORKSPACE_DIR,
      tree: data.tree,
      suggestedFolders: data.suggestedFolders,
    });
  } catch (error) {
    sendJson(
      res,
      { error: `Failed to load markdown tree: ${error instanceof Error ? error.message : String(error)}` },
      500
    );
  }
}

async function handleGetCockpitMarkdownFile(
  res: ServerResponse,
  ctx: ControlPlaneContext,
  rawPath: string | null
): Promise<void> {
  const filePath = asString(rawPath);
  if (!filePath) {
    sendJson(res, { error: 'Missing required query parameter: path' }, 400);
    return;
  }

  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, filePath, { requireMarkdownFile: true });
  if ('error' in resolved) {
    sendJson(res, { error: resolved.error }, 400);
    return;
  }

  try {
    const fs = await import('fs/promises');
    const [content, stat, metadata] = await Promise.all([
      fs.readFile(resolved.absolutePath, 'utf8'),
      fs.stat(resolved.absolutePath),
      readMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath),
    ]);
    const record = await buildMarkdownWorkspaceFileRecord(
      resolved.rootDir,
      resolved.relativePath,
      content,
      stat,
      metadata,
    );
    res.setHeader('ETag', record.etag);
    sendJson(res, {
      file: { ...record, content },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('enoent')) {
      sendJson(res, { error: `Markdown file not found: ${resolved.relativePath}` }, 404);
      return;
    }
    sendJson(res, { error: `Failed to read markdown file: ${message}` }, 500);
  }
}

async function handlePostCockpitMarkdownFile(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const filePath = asString(body.path) ?? asString(body.filePath);
  if (!filePath) {
    sendJson(res, { success: false, error: 'Missing required field: path' }, 400);
    return;
  }
  const content = typeof body.content === 'string'
    ? body.content
    : typeof body.markdown === 'string'
      ? body.markdown
      : '';
  const expectedVersion = asNumber(body.expectedVersion);
  const metadata = sanitizeMarkdownMetadata(body.metadata);

  const result = await writeCockpitMarkdownWorkspaceFile(ctx, {
    path: filePath,
    content,
    ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
    ...(metadata ? { metadata } : {}),
    ...(asString(body.source) ? { source: asString(body.source) } : {}),
    operation: 'write',
  });
  if (!result.ok) {
    sendJson(
      res,
      {
        success: false,
        error: result.error,
        ...(typeof result.currentVersion === 'number' ? { currentVersion: result.currentVersion } : {}),
        ...(result.currentUpdatedAt ? { currentUpdatedAt: result.currentUpdatedAt } : {}),
        ...(result.currentHash ? { currentHash: result.currentHash } : {}),
      },
      result.status
    );
    return;
  }

  sendJson(
    res,
    {
      success: true,
      created: result.created,
      previousVersion: result.previousVersion,
      file: result.file,
    },
    result.created ? 201 : 200
  );
}

async function handlePostCockpitMarkdownFolder(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const rawPath = asString(body.path)
    ?? (
      asString(body.parentPath) && asString(body.name)
        ? `${asString(body.parentPath)}/${asString(body.name)}`
        : undefined
    );
  if (!rawPath) {
    sendJson(res, { success: false, error: 'Missing required field: path' }, 400);
    return;
  }
  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, rawPath, { allowEmpty: false });
  if ('error' in resolved) {
    sendJson(res, { success: false, error: resolved.error }, 400);
    return;
  }
  try {
    const fs = await import('fs/promises');
    await fs.mkdir(resolved.absolutePath, { recursive: true });
    sendJson(res, { success: true, folder: { path: resolved.relativePath } }, 201);
  } catch (error) {
    sendJson(
      res,
      { success: false, error: `Failed creating folder: ${error instanceof Error ? error.message : String(error)}` },
      500
    );
  }
}

async function handlePostCockpitMarkdownImport(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const sourceSessionKey = asString(body.sessionKey);
  const sourceContent = typeof body.content === 'string'
    ? body.content
    : typeof body.markdown === 'string'
      ? body.markdown
      : null;

  let markdownContent = sourceContent;
  let sourcePath: string | undefined;
  if (!markdownContent) {
    const markdownPath = asString(body.markdownPath) ?? asString(body.sourcePath) ?? asString(body.filePath);
    if (!sourceSessionKey || !markdownPath) {
      sendJson(
        res,
        { success: false, error: 'Provide content or provide sessionKey + markdownPath for markdown import' },
        400
      );
      return;
    }
    const session = getSession(ctx, sourceSessionKey);
    if (!session) {
      sendJson(res, { success: false, error: `Session not found: ${sourceSessionKey}` }, 404);
      return;
    }
    const resolved = await resolveSessionFilePath(session.workingDir ?? ctx.workingDir, markdownPath);
    if (!resolved.resolvedPath || resolved.error) {
      sendJson(res, { success: false, error: resolved.error ?? 'Invalid markdownPath for source session' }, 400);
      return;
    }
    try {
      const fs = await import('fs/promises');
      markdownContent = await fs.readFile(resolved.resolvedPath, 'utf8');
      sourcePath = resolved.relativePath;
    } catch (error) {
      sendJson(
        res,
        { success: false, error: `Failed reading source markdownPath: ${error instanceof Error ? error.message : String(error)}` },
        400
      );
      return;
    }
  }

  if (!markdownContent) {
    sendJson(res, { success: false, error: 'No markdown content provided' }, 400);
    return;
  }

  const path = await import('path');
  const destinationFolder = normalizeWorkspaceRelativePath(
    asString(body.folder) ?? asString(body.directory) ?? 'packets',
    { allowEmpty: true }
  );
  if (destinationFolder === null) {
    sendJson(res, { success: false, error: 'Invalid destination folder' }, 400);
    return;
  }

  const desiredPath = asString(body.destinationPath) ?? asString(body.path);
  const destinationPath = desiredPath
    ? ensureMarkdownExtensionOnPath(desiredPath)
    : `${destinationFolder ? `${destinationFolder}/` : ''}${ensureMarkdownFileName(
      asString(body.filename)
      ?? (sourcePath ? path.basename(sourcePath) : `import-${Date.now()}.md`)
    )}`;
  if (!destinationPath) {
    sendJson(res, { success: false, error: 'Invalid destination markdown path' }, 400);
    return;
  }

  const expectedVersion = asNumber(body.expectedVersion);
  const metadata = sanitizeMarkdownMetadata(body.metadata);
  const importMetadata = sanitizeMarkdownMetadata({
    ...(metadata ?? {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(sourceSessionKey ? { sourceSessionKey } : {}),
    importAt: new Date().toISOString(),
  });
  const writeResult = await writeCockpitMarkdownWorkspaceFile(ctx, {
    path: destinationPath,
    content: markdownContent,
    ...(typeof expectedVersion === 'number' ? { expectedVersion } : {}),
    ...(importMetadata ? { metadata: importMetadata } : {}),
    ...(asString(body.source) ? { source: asString(body.source) } : { source: 'import' }),
    operation: 'import',
  });

  if (!writeResult.ok) {
    sendJson(
      res,
      {
        success: false,
        error: writeResult.error,
        ...(typeof writeResult.currentVersion === 'number' ? { currentVersion: writeResult.currentVersion } : {}),
        ...(writeResult.currentHash ? { currentHash: writeResult.currentHash } : {}),
      },
      writeResult.status
    );
    return;
  }

  sendJson(
    res,
    {
      success: true,
      created: writeResult.created,
      previousVersion: writeResult.previousVersion,
      file: writeResult.file,
      ...(sourcePath ? { sourcePath } : {}),
    },
    writeResult.created ? 201 : 200
  );
}

async function handlePostCockpitMarkdownPatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
  const body = await readJsonBody(req);
  const filePath = asString(body.path) ?? asString(body.filePath);
  if (!filePath) {
    sendJson(res, { success: false, error: 'Missing required field: path' }, 400);
    return;
  }
  const expectedVersionRaw = asNumber(body.expectedVersion ?? body.baseVersion);
  if (expectedVersionRaw === undefined) {
    sendJson(res, { success: false, error: 'Missing required field: expectedVersion' }, 400);
    return;
  }
  const expectedVersion = Math.max(0, Math.floor(expectedVersionRaw));

  const fullContent = typeof body.content === 'string'
    ? body.content
    : typeof body.markdown === 'string'
      ? body.markdown
      : undefined;
  const patch = typeof body.patch === 'string' ? body.patch : undefined;
  const edits = parseMarkdownPatchEdits(body.edits);
  const modeCount = (typeof fullContent === 'string' ? 1 : 0) + (patch ? 1 : 0) + (edits.length > 0 ? 1 : 0);
  if (modeCount !== 1) {
    sendJson(res, {
      success: false,
      error: 'Provide exactly one markdown patch mode: content, patch, or edits',
    }, 400);
    return;
  }

  const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, filePath, { requireMarkdownFile: true });
  if ('error' in resolved) {
    sendJson(res, { success: false, error: resolved.error }, 400);
    return;
  }

  const fs = await import('fs/promises');
  let currentContent = '';
  let currentStat: { mtimeMs: number; mtime: Date; size: number } | null = null;
  try {
    const [content, stat] = await Promise.all([
      fs.readFile(resolved.absolutePath, 'utf8'),
      fs.stat(resolved.absolutePath),
    ]);
    currentContent = content;
    currentStat = stat;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('enoent')) {
      sendJson(res, { success: false, error: `Markdown file not found: ${resolved.relativePath}` }, 404);
      return;
    }
    sendJson(res, { success: false, error: `Failed reading markdown file: ${message}` }, 500);
    return;
  }

  const currentVersion = buildVersionFromMtimeMs(currentStat.mtimeMs);
  if (currentVersion !== expectedVersion) {
    const currentHash = await buildMarkdownContentHash(currentContent);
    sendJson(res, {
      success: false,
      error: 'Version conflict while applying markdown patch',
      currentVersion,
      currentUpdatedAt: currentStat.mtime.toISOString(),
      currentHash,
    }, 409);
    return;
  }

  let nextContent = currentContent;
  let changedLines = 0;
  let mode: 'content' | 'patch' | 'edits' = 'content';
  if (typeof fullContent === 'string') {
    nextContent = fullContent;
    mode = 'content';
    changedLines = Math.max(
      buildMarkdownLineCount(currentContent),
      buildMarkdownLineCount(nextContent),
    );
  } else if (patch) {
    const result = await applyMarkdownUnifiedDiffPatch(resolved.relativePath, currentContent, patch);
    if (!result.ok) {
      sendJson(res, { success: false, error: result.error }, result.status);
      return;
    }
    nextContent = result.content;
    changedLines = result.changedLines;
    mode = 'patch';
  } else {
    const result = applyMarkdownStructuredEdits(currentContent, edits);
    if (!result.ok) {
      sendJson(res, { success: false, error: result.error }, result.status);
      return;
    }
    nextContent = result.content;
    changedLines = result.changedLines;
    mode = 'edits';
  }

  if (Buffer.byteLength(nextContent, 'utf8') > MARKDOWN_MAX_BYTES) {
    sendJson(res, { success: false, error: `Markdown payload exceeds ${MARKDOWN_MAX_BYTES} bytes` }, 400);
    return;
  }

  const metadata = sanitizeMarkdownMetadata(body.metadata);
  const writeResult = await writeCockpitMarkdownWorkspaceFile(ctx, {
    path: resolved.relativePath,
    content: nextContent,
    expectedVersion,
    ...(metadata ? {
      metadata: sanitizeMarkdownMetadata({
        ...metadata,
        patchMode: mode,
        changedLines,
      }) ?? metadata,
    } : {}),
    ...(asString(body.source) ? { source: asString(body.source) } : { source: 'patch' }),
    operation: 'patch',
    baseVersion: expectedVersion,
  });
  if (!writeResult.ok) {
    sendJson(res, {
      success: false,
      error: writeResult.error,
      ...(typeof writeResult.currentVersion === 'number' ? { currentVersion: writeResult.currentVersion } : {}),
      ...(writeResult.currentUpdatedAt ? { currentUpdatedAt: writeResult.currentUpdatedAt } : {}),
      ...(writeResult.currentHash ? { currentHash: writeResult.currentHash } : {}),
    }, writeResult.status);
    return;
  }

  sendJson(res, {
    success: true,
    mode,
    changedLines,
    previousVersion: writeResult.previousVersion,
    file: writeResult.file,
  });
}

function handleGetCockpitSessionEvents(
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
  const messagesResult = ctx.graphd.messagesGet(sessionKey, Math.max(limit * 2, 200), 0) as {
    messages?: MessageRow[];
  };
  const cursor = cursorRaw ? Number(cursorRaw) : undefined;
  const { events, nextCursor } = buildSessionEvents(
    session,
    messagesResult.messages ?? [],
    limit,
    Number.isFinite(cursor) ? cursor : undefined
  );
  sendJson(res, { events, nextCursor });
}

function handleGetCockpitSessionPackets(
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
  // Do not synthesize packets server-side; return only harness-provided packet markdown.
  sendJson(res, { packets: packets.slice(0, limit) });
}

async function handlePostCockpitPacket(
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
  const source = asString(body.source) ?? 'watcher';

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

  const metadataUpdate = ctx.graphd.sessionUpdateMetadata(sessionKey, {
    packets: [packetRecord],
    agent_events: [packetEvent],
  }) as { success?: boolean; error?: string };
  if (!metadataUpdate.success) {
    sendJson(res, { success: false, error: metadataUpdate.error ?? 'Failed to persist packet' }, 500);
    return;
  }

  sendJson(res, { success: true, packet: packetRecord }, 201);
}

async function handleResolveCockpitEscalation(
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

  const result = ctx.resolveSessionEscalation(ownerSession.sessionKey, escalationId, resolution);
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

async function buildMarkdownMessageContext(
  ctx: ControlPlaneContext,
  value: unknown
): Promise<
  | {
      ok: true;
      contextText?: string;
      contextMetadata?: Record<string, unknown>;
    }
  | { ok: false; status: number; error: string }
> {
  if (!isRecord(value)) return { ok: true };

  const rawPath = asString(value.path) ?? asString(value.markdownPath) ?? asString(value.filePath);
  let content = typeof value.content === 'string'
    ? value.content
    : typeof value.markdown === 'string'
      ? value.markdown
      : undefined;
  if (!rawPath && content === undefined) return { ok: true };

  let resolvedPath: string | undefined;
  let resolvedVersion: number | undefined = asNumber(value.version);
  let resolvedUpdatedAt: string | undefined = asString(value.updatedAt);
  let resolvedMetadata: Record<string, unknown> | undefined;

  if (rawPath) {
    const resolved = await resolveCockpitMarkdownWorkspacePath(ctx, rawPath, { requireMarkdownFile: true });
    if ('error' in resolved) {
      return { ok: false, status: 400, error: resolved.error };
    }
    resolvedPath = resolved.relativePath;
    try {
      const fs = await import('fs/promises');
      const [stat, persistedContent, persistedMetadata] = await Promise.all([
        fs.stat(resolved.absolutePath),
        content === undefined ? fs.readFile(resolved.absolutePath, 'utf8') : Promise.resolve(undefined),
        readMarkdownWorkspaceMetadata(resolved.rootDir, resolved.relativePath),
      ]);
      if (content === undefined && typeof persistedContent === 'string') {
        content = persistedContent;
      }
      resolvedVersion = resolvedVersion ?? buildVersionFromMtimeMs(stat.mtimeMs);
      resolvedUpdatedAt = resolvedUpdatedAt ?? stat.mtime.toISOString();
      resolvedMetadata = persistedMetadata;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (typeof content === 'string') {
        resolvedVersion = resolvedVersion ?? 0;
        resolvedUpdatedAt = resolvedUpdatedAt ?? new Date().toISOString();
        resolvedMetadata = resolvedMetadata ?? undefined;
      } else if (message.toLowerCase().includes('enoent')) {
        return { ok: false, status: 404, error: `Markdown file not found: ${resolved.relativePath}` };
      } else {
        return { ok: false, status: 500, error: `Failed loading markdown context: ${message}` };
      }
    }
  }

  if (typeof content !== 'string') return { ok: true };

  const selectionStart = asNumber(value.selectionStart ?? value.cursorStart);
  const selectionEnd = asNumber(value.selectionEnd ?? value.cursorEnd);
  const isDirty = asBoolean(value.isDirty) === true;
  const clientMetadata = sanitizeMarkdownMetadata(value.metadata);
  const mergedMetadata = sanitizeMarkdownMetadata({
    ...(resolvedMetadata ?? {}),
    ...(clientMetadata ?? {}),
  });

  const originalBytes = Buffer.byteLength(content, 'utf8');
  const fullContentHash = await buildMarkdownContentHash(content);
  let truncated = false;
  if (originalBytes > MARKDOWN_CHAT_CONTEXT_MAX_BYTES) {
    content = Buffer
      .from(content, 'utf8')
      .subarray(0, MARKDOWN_CHAT_CONTEXT_MAX_BYTES)
      .toString('utf8');
    truncated = true;
  }
  const payloadHash = truncated ? await buildMarkdownContentHash(content) : fullContentHash;
  const contextMetadata = sanitizeMarkdownMetadata({
    source: 'markdown-editor',
    path: resolvedPath ?? rawPath ?? null,
    version: resolvedVersion ?? null,
    updatedAt: resolvedUpdatedAt ?? null,
    isDirty,
    selectionStart: typeof selectionStart === 'number' ? Math.max(0, Math.floor(selectionStart)) : null,
    selectionEnd: typeof selectionEnd === 'number' ? Math.max(0, Math.floor(selectionEnd)) : null,
    contentBytes: Buffer.byteLength(content, 'utf8'),
    originalBytes,
    truncated,
    hash: fullContentHash,
    payloadHash,
  }) ?? {
    source: 'markdown-editor',
    path: resolvedPath ?? rawPath ?? null,
    hash: fullContentHash,
    payloadHash,
    truncated,
  };

  let metadataJson = mergedMetadata ? JSON.stringify(mergedMetadata) : '{}';
  if (Buffer.byteLength(metadataJson, 'utf8') > 8_000) {
    metadataJson = `${metadataJson.slice(0, 8_000)}...`;
  }
  const contextText = [
    'Control-plane active markdown context:',
    `path: ${contextMetadata.path ?? 'unknown'}`,
    `version: ${contextMetadata.version ?? 'unknown'}`,
    `updatedAt: ${contextMetadata.updatedAt ?? 'unknown'}`,
    `dirty: ${contextMetadata.isDirty === true ? 'true' : 'false'}`,
    `selectionStart: ${contextMetadata.selectionStart ?? 'none'}`,
    `selectionEnd: ${contextMetadata.selectionEnd ?? 'none'}`,
    `hash: ${contextMetadata.hash ?? 'unknown'}`,
    `truncated: ${contextMetadata.truncated === true ? 'true' : 'false'}`,
    'metadata:',
    metadataJson,
    'markdown:',
    '```markdown',
    content,
    '```',
    'Treat this markdown snapshot as authoritative for the current user request.',
  ].join('\n');

  return {
    ok: true,
    contextText,
    contextMetadata,
  };
}

async function handlePostSessionMessage(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string
): Promise<void> {
  if (!ctx.dispatchSessionInput) {
    sendJson(res, { success: false, error: 'Session messaging not available in this daemon context' }, 501);
    return;
  }

  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: `Session not found: ${sessionKey}` }, 404);
    return;
  }

  const body = await readJsonBody(req);
  const message = asString(body.message);
  if (!message) {
    sendJson(res, { success: false, error: 'Missing required field: message' }, 400);
    return;
  }

  const trimmedMessage = message.trim();
  const commandMatch = trimmedMessage.match(/^\/?(fork|stop)\b(?:\s+(.+))?$/i);
  if (commandMatch) {
    const action = commandMatch[1].toLowerCase() as 'fork' | 'stop';
    const commandArg = asString(commandMatch[2])?.trim();

    if (action === 'fork') {
      if (!ctx.forkSession) {
        sendJson(res, { success: false, error: 'Session fork not available in this daemon context' }, 501);
        return;
      }
      const explicitTarget = commandArg
        ? (commandArg.startsWith('target=') ? commandArg.slice('target='.length).trim() : commandArg.split(/\s+/, 1)[0])
        : null;
      const targetSessionKey = explicitTarget || buildForkSessionKey(sessionKey);
      const result = ctx.forkSession(sessionKey, targetSessionKey);
      if (!result.success) {
        sendJson(res, { success: false, error: result.error ?? 'Failed to fork session' }, 400);
        return;
      }
      sendJson(res, {
        success: true,
        via: 'message',
        action: 'fork',
        sourceSessionKey: sessionKey,
        targetSessionKey: result.targetSessionKey ?? targetSessionKey,
      });
      return;
    }

    // action === 'stop'
    const note = commandArg || 'Stop current work now and pause for user confirmation.';
    if (ctx.stopSession) {
      const result = ctx.stopSession(sessionKey, note);
      if (!result.success) {
        sendJson(res, { success: false, error: result.error ?? 'Failed to stop session' }, 400);
        return;
      }
      sendJson(res, {
        success: true,
        via: 'message',
        action: 'stop',
        sessionKey,
        requestId: result.requestId ?? null,
      });
      return;
    }

    const fallbackResult = ctx.dispatchSessionInput(sessionKey, note);
    if (!fallbackResult.success) {
      sendJson(res, { success: false, error: fallbackResult.error ?? 'Failed to stop session' }, 400);
      return;
    }
    sendJson(res, {
      success: true,
      via: 'message',
      action: 'stop',
      sessionKey,
      requestId: fallbackResult.requestId ?? null,
      queued: fallbackResult.queued ?? false,
    });
    return;
  }

  const contextBuild = await buildMarkdownMessageContext(
    ctx,
    body.markdownContext ?? body.documentContext ?? body.activeDocument
  );
  if (!contextBuild.ok) {
    sendJson(res, { success: false, error: contextBuild.error }, contextBuild.status);
    return;
  }
  const messageDispatchOptions = contextBuild.contextText
    ? {
        context: contextBuild.contextText,
        metadata: contextBuild.contextMetadata,
      }
    : undefined;
  if (ctx.graphd && contextBuild.contextMetadata) {
    try {
      ctx.graphd.sessionUpdateMetadata(sessionKey, {
        cockpit_active_markdown: {
          ...contextBuild.contextMetadata,
          attachedAt: new Date().toISOString(),
        },
      });
    } catch {
      // Best-effort metadata update; never block chat dispatch.
    }
  }
  const result = ctx.dispatchSessionInput(sessionKey, message, messageDispatchOptions);
  if (!result.success) {
    sendJson(res, { success: false, error: result.error ?? 'Failed to dispatch message' }, 400);
    return;
  }
  sendJson(res, {
    success: true,
    sessionKey,
    requestId: result.requestId ?? null,
    queued: result.queued ?? false,
    markdownContextAttached: !!messageDispatchOptions?.context,
  });
}

function buildForkSessionKey(sourceSessionKey: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${sourceSessionKey}-fork-${Date.now().toString(36)}-${suffix}`;
}

async function handlePostSessionControl(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string,
  forcedAction?: 'start' | 'stop' | 'fork'
): Promise<void> {
  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: `Session not found: ${sessionKey}` }, 404);
    return;
  }

  const body = await readJsonBody(req);
  const actionRaw = forcedAction ?? asString(body.action);
  const action = actionRaw === 'start' || actionRaw === 'stop' || actionRaw === 'fork'
    ? actionRaw
    : null;
  if (!action) {
    sendJson(res, { success: false, error: 'Invalid action. Expected start|stop|fork' }, 400);
    return;
  }

  if (action === 'fork') {
    if (!ctx.forkSession) {
      sendJson(res, { success: false, error: 'Session fork not available in this daemon context' }, 501);
      return;
    }
    const targetSessionKey = asString(body.targetSessionKey) ?? buildForkSessionKey(sessionKey);
    const result = ctx.forkSession(sessionKey, targetSessionKey);
    if (!result.success) {
      sendJson(res, { success: false, error: result.error ?? 'Failed to fork session' }, 400);
      return;
    }
    sendJson(res, {
      success: true,
      action,
      sourceSessionKey: sessionKey,
      targetSessionKey: result.targetSessionKey ?? targetSessionKey,
    });
    return;
  }

  if (action === 'stop') {
    if (ctx.stopSession) {
      const result = ctx.stopSession(sessionKey, asString(body.note));
      if (!result.success) {
        sendJson(res, { success: false, error: result.error ?? 'Failed to stop session' }, 400);
        return;
      }
      sendJson(res, {
        success: true,
        action,
        sessionKey,
        requestId: result.requestId ?? null,
      });
      return;
    }

    if (!ctx.dispatchSessionInput) {
      sendJson(res, { success: false, error: 'Session control not available in this daemon context' }, 501);
      return;
    }
    const fallbackResult = ctx.dispatchSessionInput(
      sessionKey,
      asString(body.note) ?? 'Stop current work now and pause for user confirmation.'
    );
    if (!fallbackResult.success) {
      sendJson(res, { success: false, error: fallbackResult.error ?? 'Failed to stop session' }, 400);
      return;
    }
    sendJson(res, {
      success: true,
      action,
      sessionKey,
      requestId: fallbackResult.requestId ?? null,
    });
    return;
  }

  // action === 'start'
  if (!ctx.dispatchSessionInput) {
    sendJson(res, { success: false, error: 'Session control not available in this daemon context' }, 501);
    return;
  }
  const resumeMessage = asString(body.message) ?? 'Continue with the current objective.';
  const result = ctx.dispatchSessionInput(sessionKey, resumeMessage);
  if (!result.success) {
    sendJson(res, { success: false, error: result.error ?? 'Failed to start session' }, 400);
    return;
  }
  sendJson(res, {
    success: true,
    action,
    sessionKey,
    requestId: result.requestId ?? null,
    queued: result.queued ?? false,
  });
}

async function handlePostSessionReviewDecision(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext,
  sessionKey: string
): Promise<void> {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { success: false, error: 'GraphD not available' }, 503);
    return;
  }

  const session = getSession(ctx, sessionKey);
  if (!session) {
    sendJson(res, { success: false, error: `Session not found: ${sessionKey}` }, 404);
    return;
  }

  const body = await readJsonBody(req);
  const decisionRaw = asString(body.decision);
  const decision = decisionRaw === 'accept' || decisionRaw === 'request_changes'
    ? decisionRaw
    : null;
  if (!decision) {
    sendJson(res, { success: false, error: 'Invalid decision. Expected accept|request_changes' }, 400);
    return;
  }

  const fromStatus = session.status;
  const toStatus = decision === 'accept' ? 'completed' : 'active';
  const statusUpdate = ctx.graphd.sessionUpdateStatus(sessionKey, toStatus) as { success?: boolean; error?: string };
  if (!statusUpdate.success) {
    sendJson(res, { success: false, error: statusUpdate.error ?? 'Failed to update session status' }, 500);
    return;
  }

  const note = asString(body.note) ?? asString(body.message);
  const reviewEvent: Record<string, unknown> = {
    type: 'review_decision',
    timestamp: new Date().toISOString(),
    ...(asString(body.requestId) ? { request_id: asString(body.requestId) } : {}),
    data: {
      decision,
      fromStatus,
      toStatus,
      ...(note ? { note } : {}),
    },
  };
  ctx.graphd.sessionUpdateMetadata(sessionKey, {
    agent_events: [reviewEvent],
    review_decisions: [{
      at: new Date().toISOString(),
      decision,
      fromStatus,
      toStatus,
      ...(note ? { note } : {}),
    }],
  });

  sendJson(res, {
    success: true,
    sessionKey,
    decision,
    fromStatus,
    toStatus,
  });
}

async function ensureBaseSha(
  workingDir: string,
  baseSha: string | undefined
): Promise<{ ok: true; headSha?: string } | { ok: false; status: number; error: string }> {
  if (!baseSha) return { ok: true };
  try {
    const headSha = (await execFileText('git', ['rev-parse', 'HEAD'], {
      cwd: workingDir,
      timeout: 8_000,
    })).trim();
    if (headSha && !shaMatches(headSha, baseSha)) {
      return {
        ok: false,
        status: 409,
        error: `baseSha mismatch: expected ${baseSha}, current HEAD is ${headSha}`,
      };
    }
    return { ok: true, headSha };
  } catch {
    return { ok: true };
  }
}

async function applyUnifiedDiffPatch(
  workingDir: string,
  patch: string,
  baseSha?: string
): Promise<{
  success: boolean;
  files?: string[];
  changedLines?: number;
  error?: string;
  status?: number;
}> {
  const stats = parsePatchStats(patch);
  if (stats.hasBinary) {
    return { success: false, error: 'Binary patches are not supported', status: 400 };
  }
  const constrained = await enforcePatchConstraints('patch', stats.files, stats.changedLines);
  if (!constrained.ok) {
    return { success: false, error: constrained.error, status: 400 };
  }
  for (const filePath of stats.files) {
    const resolved = await resolveSessionFilePath(workingDir, filePath);
    if (!resolved.resolvedPath) {
      return { success: false, error: resolved.error ?? `Invalid patch path: ${filePath}`, status: 400 };
    }
  }
  const baseCheck = await ensureBaseSha(workingDir, baseSha);
  if (!baseCheck.ok) {
    return { success: false, error: baseCheck.error, status: baseCheck.status };
  }

  const { mkdtemp, writeFile, rm } = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-patch-'));
  const patchFile = path.join(tempDir, 'patch.diff');
  try {
    await writeFile(patchFile, patch, 'utf8');
    await execFileText('git', ['apply', '--check', '--whitespace=nowarn', patchFile], {
      cwd: workingDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await execFileText('git', ['apply', '--whitespace=nowarn', patchFile], {
      cwd: workingDir,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      success: true,
      files: stats.files,
      changedLines: stats.changedLines,
    };
  } catch (error) {
    return {
      success: false,
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function applyStructuredEdits(
  workingDir: string,
  edits: PatchEditInput[],
  baseSha?: string
): Promise<{
  success: boolean;
  files?: string[];
  changedLines?: number;
  error?: string;
  status?: number;
}> {
  const files = Array.from(new Set(edits.map((edit) => edit.path)));
  const constrained = await enforcePatchConstraints('edits', files, 0);
  if (!constrained.ok) {
    return { success: false, error: constrained.error, status: 400 };
  }
  const baseCheck = await ensureBaseSha(workingDir, baseSha);
  if (!baseCheck.ok) {
    return { success: false, error: baseCheck.error, status: baseCheck.status };
  }

  const { readFile, writeFile } = await import('fs/promises');
  const path = await import('path');
  const grouped = new Map<string, PatchEditInput[]>();
  for (const edit of edits) {
    const list = grouped.get(edit.path) ?? [];
    list.push(edit);
    grouped.set(edit.path, list);
  }

  const pendingWrites: Array<{ resolvedPath: string; content: string }> = [];
  let totalChangedLines = 0;
  for (const [relativePath, fileEdits] of grouped.entries()) {
    if (isLockfilePath(relativePath)) {
      return { success: false, error: `Lockfile edits are blocked by default: ${relativePath}`, status: 400 };
    }
    const resolved = await resolveSessionFilePath(workingDir, relativePath);
    if (!resolved.resolvedPath) {
      return { success: false, error: resolved.error ?? `Invalid edit path: ${relativePath}`, status: 400 };
    }

    let content: string;
    try {
      content = await readFile(resolved.resolvedPath, 'utf8');
    } catch (error) {
      return {
        success: false,
        status: 400,
        error: `Failed reading ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (content.includes('\u0000')) {
      return { success: false, status: 400, error: `Binary file edits are not supported: ${relativePath}` };
    }

    const hadTrailingNewline = content.endsWith('\n');
    const baseText = hadTrailingNewline ? content.slice(0, -1) : content;
    const lines = baseText.length > 0 ? baseText.split('\n') : [];

    // Apply from bottom to top to keep line numbers stable.
    const ordered = [...fileEdits].sort((a, b) => b.startLine - a.startLine);
    for (const edit of ordered) {
      if (edit.startLine < 1) {
        return { success: false, status: 400, error: `Invalid startLine for ${relativePath}` };
      }
      if (edit.endLine < edit.startLine - 1) {
        return { success: false, status: 400, error: `Invalid endLine for ${relativePath}` };
      }
      if (edit.endLine > lines.length) {
        return {
          success: false,
          status: 400,
          error: `Edit range out of bounds for ${relativePath}: ${edit.startLine}-${edit.endLine}`,
        };
      }
      if (edit.startLine > lines.length + 1) {
        return {
          success: false,
          status: 400,
          error: `Edit start out of bounds for ${relativePath}: ${edit.startLine}`,
        };
      }

      const startIdx = Math.min(lines.length, edit.startLine - 1);
      const deleteCount = Math.max(0, edit.endLine - edit.startLine + 1);
      const replacementLines = edit.replacement === '' ? [] : edit.replacement.split('\n');
      lines.splice(startIdx, deleteCount, ...replacementLines);
      totalChangedLines += Math.max(deleteCount, replacementLines.length);
      if (totalChangedLines > 30) {
        return {
          success: false,
          status: 400,
          error: `Patch exceeds changed-line limit: ${totalChangedLines} > 30`,
        };
      }
    }

    const nextContent = lines.join('\n') + (hadTrailingNewline ? '\n' : '');
    pendingWrites.push({
      resolvedPath: path.resolve(resolved.resolvedPath),
      content: nextContent,
    });
  }

  for (const write of pendingWrites) {
    await writeFile(write.resolvedPath, write.content, 'utf8');
  }

  return {
    success: true,
    files,
    changedLines: totalChangedLines,
  };
}

async function handlePostCockpitPatchApply(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): Promise<void> {
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

  const patch = asString(body.patch);
  const edits = parsePatchEdits(body.edits);
  if (!patch && edits.length === 0) {
    sendJson(res, { success: false, error: 'Missing patch payload: provide patch or edits' }, 400);
    return;
  }
  if (patch && edits.length > 0) {
    sendJson(res, { success: false, error: 'Provide either patch or edits, not both' }, 400);
    return;
  }

  const workingDir = session.workingDir ?? ctx.workingDir;
  const baseSha = asString(body.baseSha) ?? asString(body.base_sha);
  const mode: 'patch' | 'edits' = patch ? 'patch' : 'edits';

  const result = patch
    ? await applyUnifiedDiffPatch(workingDir, patch, baseSha)
    : await applyStructuredEdits(workingDir, edits, baseSha);

  if (!result.success) {
    sendJson(res, { success: false, error: result.error ?? 'Failed applying patch' }, result.status ?? 400);
    return;
  }

  if (ctx.graphd) {
    const event = {
      type: 'human_patch_applied',
      timestamp: new Date().toISOString(),
      request_id: asString(body.requestId),
      work_item_id: asString(body.workItemId),
      data: {
        mode,
        files: result.files ?? [],
        changedLines: result.changedLines ?? 0,
        ...(baseSha ? { baseSha } : {}),
      },
    };
    const metadataUpdate = ctx.graphd.sessionUpdateMetadata(sessionKey, {
      agent_events: [event],
    }) as { success?: boolean };
    if (!metadataUpdate.success) {
      sendJson(res, {
        success: true,
        mode,
        files: result.files ?? [],
        changedLines: result.changedLines ?? 0,
        warning: 'Patch applied but audit event persistence failed',
      });
      return;
    }
  }

  sendJson(res, {
    success: true,
    mode,
    files: result.files ?? [],
    changedLines: result.changedLines ?? 0,
  });
}

/**
 * GET /control-plane/projects
 * List projects (unique working directories from sessions)
 */
function handleGetProjects(res: ServerResponse, ctx: ControlPlaneContext): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { projects: [], error: 'GraphD not available' });
    return;
  }

  try {
    const result = ctx.graphd.sessionsList({ limit: 1000 }) as { sessions?: SessionRow[]; error?: string };
    if (result.error) {
      sendJson(res, { projects: [], error: result.error });
      return;
    }
    const sessions = result.sessions ?? [];

    // Group by working directory
    const projectMap = new Map<string, { count: number; lastAccessed: number }>();
    for (const session of sessions) {
      const wd = session.workingDir;
      if (!wd) continue;

      const existing = projectMap.get(wd);
      if (existing) {
        existing.count++;
        existing.lastAccessed = Math.max(existing.lastAccessed, session.lastAccessedAt);
      } else {
        projectMap.set(wd, { count: 1, lastAccessed: session.lastAccessedAt });
      }
    }

    // Convert to array and sort by session count
    const projects = Array.from(projectMap.entries())
      .map(([path, data]) => {
        const parts = path.split('/');
        const name = parts[parts.length - 1] || path;
        return {
          id: path,
          name,
          path,
          sessionCount: data.count,
          activeGoals: 0,
        };
      })
      .sort((a, b) => b.sessionCount - a.sessionCount);

    sendJson(res, { projects });
  } catch (error) {
    console.error('[control-plane] Error listing projects:', error);
    sendJson(res, { projects: [], error: String(error) });
  }
}

/**
 * GET /control-plane/projects/:id/features
 * List features (branches) for a project
 */
async function handleGetFeatures(res: ServerResponse, _ctx: ControlPlaneContext, projectPath: string): Promise<void> {
  try {
    // Get branches via git
    let branches: string[] = [];
    let currentBranch = 'main';

    try {
      const { stdout: branchOutput } = await execAsync('git branch -a --format="%(refname:short)"', {
        cwd: projectPath,
        timeout: 10000,
      });
      branches = branchOutput.trim().split('\n').filter(Boolean);

      const { stdout: currentOutput } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectPath,
        timeout: 5000,
      });
      currentBranch = currentOutput.trim();
    } catch {
      // Not a git repo or git not available
    }

    const features = branches.slice(0, 50).map((branch) => ({
      id: branch,
      name: branch,
      branch,
      baseBranch: 'main',
      projectId: projectPath,
      sessionCount: 0,
    }));

    sendJson(res, { features, currentBranch });
  } catch (error) {
    console.error('[control-plane] Error listing features:', error);
    sendJson(res, { features: [], error: String(error) });
  }
}

/**
 * GET /control-plane/projects/:id/sessions
 * List sessions for a specific project
 */
function handleGetProjectSessions(res: ServerResponse, ctx: ControlPlaneContext, projectPath: string): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { sessions: [], error: 'GraphD not available' });
    return;
  }

  try {
    const result = ctx.graphd.sessionsList({ workingDir: projectPath, limit: 100 }) as { sessions?: SessionRow[]; error?: string };
    const sessions = (result.sessions ?? []).map(formatSession);
    sendJson(res, { sessions });
  } catch (error) {
    console.error('[control-plane] Error listing project sessions:', error);
    sendJson(res, { sessions: [], error: String(error) });
  }
}

/**
 * GET /control-plane/features/:id/prs
 * List PRs for a feature (via GitHub CLI)
 */
async function handleGetPRs(res: ServerResponse, branch: string, owner: string | null, repo: string | null): Promise<void> {
  if (!owner || !repo) {
    sendJson(res, { prs: [], error: 'Missing owner or repo query params' });
    return;
  }

  try {
    const allPrs = await getPRs(owner, repo);

    // Filter PRs by head branch if specified
    const prs = branch
      ? allPrs.filter(pr => pr.title.toLowerCase().includes(branch.toLowerCase()))
      : allPrs;

    sendJson(res, { prs });
  } catch (error) {
    console.error('[control-plane] Error listing PRs:', error);
    sendJson(res, { prs: [], error: String(error) });
  }
}

/**
 * GET /control-plane/sessions
 * List all recent sessions
 */
function handleGetSessions(res: ServerResponse, ctx: ControlPlaneContext, limit: number): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { sessions: [], error: 'GraphD not available' });
    return;
  }

  try {
    const result = ctx.graphd.sessionsList({ limit }) as { sessions?: SessionRow[]; error?: string };
    if (result.error) {
      sendJson(res, { sessions: [], error: result.error });
      return;
    }
    const sessions = (result.sessions ?? []).map(formatSession);
    sendJson(res, { sessions });
  } catch (error) {
    console.error('[control-plane] Error listing sessions:', error);
    sendJson(res, { sessions: [], error: String(error) });
  }
}

/**
 * GET /control-plane/sessions/:id
 * Get a specific session
 */
function handleGetSession(res: ServerResponse, ctx: ControlPlaneContext, sessionKey: string): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { session: null, error: 'GraphD not available' });
    return;
  }

  try {
    const result = ctx.graphd.sessionGet(sessionKey) as { session?: SessionRow; error?: string };
    if (!result.session) {
      sendJson(res, { session: null, error: result.error || 'Session not found' }, 404);
      return;
    }

    sendJson(res, { session: formatSession(result.session) });
  } catch (error) {
    console.error('[control-plane] Error getting session:', error);
    sendJson(res, { session: null, error: String(error) });
  }
}

/**
 * GET /control-plane/sessions/:id/messages
 * Get messages for a session
 */
function handleGetSessionMessages(res: ServerResponse, ctx: ControlPlaneContext, sessionKey: string): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { messages: [], error: 'GraphD not available' });
    return;
  }

  try {
    const result = ctx.graphd.messagesGet(sessionKey, 200, 0) as { messages?: MessageRow[]; error?: string };
    const messages = (result.messages ?? []).map(formatMessage);
    sendJson(res, { messages });
  } catch (error) {
    console.error('[control-plane] Error getting session messages:', error);
    sendJson(res, { messages: [], error: String(error) });
  }
}

/**
 * GET /control-plane/goals/hierarchy
 * Get goal hierarchy (placeholder - would need agent-memory integration)
 */
function handleGetGoalHierarchy(res: ServerResponse): void {
  // TODO: Wire up to agent-memory's goals repository
  sendJson(res, { goals: [], note: 'Goals are stored in agent-memory (PostgreSQL), not yet integrated' });
}

/**
 * GET /control-plane/token-usage
 * Get token usage from session metadata
 */
function handleGetTokenUsage(res: ServerResponse, ctx: ControlPlaneContext): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { usage: [], error: 'GraphD not available' });
    return;
  }

  try {
    const result = ctx.graphd.sessionsList({ limit: 1000 }) as { sessions?: SessionRow[]; error?: string };
    const sessions = result.sessions ?? [];

    const usageMap = new Map<string, { provider: string; model: string; totalTokens: number; sessionCount: number }>();

    for (const session of sessions) {
      const meta = session.metadata;
      if (!meta) continue;

      const provider = (meta.provider as string) || 'unknown';
      const model = (meta.model as string) || 'unknown';
      const tokens = (meta.total_tokens as number) || 0;
      const key = `${provider}:${model}`;

      const existing = usageMap.get(key);
      if (existing) {
        existing.totalTokens += tokens;
        existing.sessionCount += 1;
      } else {
        usageMap.set(key, { provider, model, totalTokens: tokens, sessionCount: 1 });
      }
    }

    const usage = Array.from(usageMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);
    sendJson(res, { usage });
  } catch (error) {
    console.error('[control-plane] Error getting token usage:', error);
    sendJson(res, { usage: [], error: String(error) });
  }
}

/**
 * GET /control-plane/projects/:id/git
 * Get git info for a project
 */
async function handleGetGitInfo(res: ServerResponse, projectPath: string): Promise<void> {
  try {
    const [remote, commits, currentBranch, uncommittedOutput] = await Promise.all([
      getGitRemote(projectPath),
      getRecentCommits(projectPath, 20),
      execAsync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath, timeout: 5000 })
        .then(r => r.stdout.trim())
        .catch(() => 'unknown'),
      execAsync('git status --porcelain', { cwd: projectPath, timeout: 5000 })
        .then(r => r.stdout.trim().split('\n').filter(Boolean).length)
        .catch(() => 0),
    ]);

    sendJson(res, {
      currentBranch,
      remote,
      uncommittedChanges: uncommittedOutput,
      recentCommits: commits,
    });
  } catch (error) {
    console.error('[control-plane] Error getting git info:', error);
    sendJson(res, { error: String(error) }, 500);
  }
}

/**
 * GET /control-plane/traces
 * Get recent traces from .agent-trace directory
 */
async function handleGetTraces(res: ServerResponse, ctx: ControlPlaneContext, limit: number): Promise<void> {
  try {
    const { readdir, readFile, stat } = await import('fs/promises');
    const path = await import('path');
    const traceDir = path.join(ctx.workingDir, '.agent-trace');

    let files: string[] = [];
    try {
      files = await readdir(traceDir);
    } catch {
      sendJson(res, { traces: [] });
      return;
    }

    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const traces: Array<{ trace: unknown; mtime: number }> = [];

    for (const file of jsonFiles.slice(0, limit * 2)) {
      try {
        const filePath = path.join(traceDir, file);
        const [content, stats] = await Promise.all([
          readFile(filePath, 'utf-8'),
          stat(filePath),
        ]);
        traces.push({ trace: JSON.parse(content), mtime: stats.mtimeMs });
      } catch {
        // Skip invalid files
      }
    }

    // Sort by mtime desc and limit
    traces.sort((a, b) => b.mtime - a.mtime);
    sendJson(res, { traces: traces.slice(0, limit).map(t => t.trace) });
  } catch (error) {
    console.error('[control-plane] Error getting traces:', error);
    sendJson(res, { traces: [], error: String(error) });
  }
}

/**
 * GET /control-plane/traces/revision/:revision
 * Get trace by git revision
 */
async function handleGetTraceByRevision(res: ServerResponse, ctx: ControlPlaneContext, revision: string): Promise<void> {
  try {
    const { readFile } = await import('fs/promises');
    const path = await import('path');
    const traceFile = path.join(ctx.workingDir, '.agent-trace', `${revision}.json`);

    const content = await readFile(traceFile, 'utf-8');
    sendJson(res, { trace: JSON.parse(content) });
  } catch {
    sendJson(res, { trace: null, error: 'Trace not found' }, 404);
  }
}

/**
 * GET /control-plane/live-sessions
 * Get only currently active sessions
 */
function handleGetLiveSessions(res: ServerResponse, ctx: ControlPlaneContext): void {
  if (!ctx.isGraphDReady() || !ctx.graphd) {
    sendJson(res, { sessions: [], error: 'GraphD not available' });
    return;
  }

  try {
    const result = ctx.graphd.sessionsList({ limit: 100 }) as { sessions?: SessionRow[]; error?: string };
    const allSessions = result.sessions ?? [];

    // Filter to only active sessions (accessed in last 5 minutes)
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
    const liveSessions = allSessions
      .filter(s => s.status === 'active' || s.lastAccessedAt > fiveMinutesAgo)
      .map(formatSession);

    sendJson(res, { sessions: liveSessions, total: liveSessions.length });
  } catch (error) {
    console.error('[control-plane] Error getting live sessions:', error);
    sendJson(res, { sessions: [], error: String(error) });
  }
}

/**
 * GET /control-plane/cockpit/templates
 * List available workitem templates from the database.
 */
async function handleGetCockpitTemplates(res: ServerResponse): Promise<void> {
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

/**
 * POST /control-plane/cockpit/session/create
 * Lazily create a new cockpit session in GraphD.
 */
async function handlePostCockpitSessionCreate(
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
  const metadata = isRecord(body.metadata) ? body.metadata : {};

  const sessionKey = `cockpit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const result = ctx.graphd.sessionCreate(
    sessionKey,
    'cockpit',
    ctx.workingDir,
    undefined,
    { ...metadata, ...(markdownPath ? { markdownPath } : {}) }
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

  sendJson(res, { success: true, sessionKey });
}
