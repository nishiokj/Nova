---
session: tui_1770395448710_xi0hq7
created: 2026-02-06T16:30:48.711Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770396045097
 Let's think of ways to optimize our data layer in the @packages/harness-daemon/src/harness/control_plane_routes.ts @dashboard-control/ . Switching between tabs is currently very slow, I presume because of data loading and caching issues. Pane and tab swapping are first class, we should be optimizing for this

### function_call
@callId call_04575300fb1d4564ad0f221c
@name explorer
@ts 1770396065912
@workItemId b4d163ca
{"objective":"Analyze the data layer architecture in packages/harness-daemon/src/harness/control_plane_routes.ts and packages/dashboard-control/ to understand how data fetching and caching works, and identify why tab switching is slow. Focus on: 1) API endpoints and data fetching patterns, 2) Current caching mechanisms, 3) Tab/pane data loading lifecycle, 4) Re-fetching patterns when switching tabs","delta":"Understanding current data layer implementation to identify optimization opportunities for fast tab switching"}

### function_call_output
@callId call_04575300fb1d4564ad0f221c
@ts 1770396157396
@isError true
@durationMs 91483
@workItemId b4d163ca
Sub-agent 'explorer' failed (reason: invalid_action): Explorer read 11 files but extracted 0 artifacts. This is a hard failure. Every file read MUST produce artifacts. Files read: /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts, /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api.ts, /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx, /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/hooks/use-cockpit-store.ts, /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/hooks/use-polling.ts...
Tools called: 14 (13 succeeded, 1 failed)
Tool errors: Grep: Search failed: rg: unrecognized file type: tsx
Partial output:
Now I have a comprehensive understanding of the data layer. Let me examine the tab components to understand the tab switching flow:

### function_call
@callId call_b5a945e4ca1b4a1285569690
@name Read
@ts 1770396160899
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call
@callId call_e6c55d624bac4be6a709152a
@name Read
@ts 1770396160899
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api.ts"}

### function_call
@callId call_9b78681df1714a89a54a2da7
@name Read
@ts 1770396160899
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/hooks/use-cockpit-store.ts"}

### function_call
@callId call_0cffb4acac4f44d3af7cf60e
@name Read
@ts 1770396160899
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/hooks/use-polling.ts"}

### function_call
@callId call_083b8765a3f94e3b94a66ceb
@name Read
@ts 1770396160899
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx"}

### function_call_output
@callId call_b5a945e4ca1b4a1285569690
@ts 1770396160906
@durationMs 5
@workItemId b4d163ca
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
  if (files.le
... [truncated 50040 chars]

### function_call_output
@callId call_e6c55d624bac4be6a709152a
@ts 1770396160906
@durationMs 5
@workItemId b4d163ca
/**
 * Control Plane API Client
 *
 * Connects to harness-daemon's control-plane routes for session/project data.
 */

const API_BASE = '/control-plane';

export interface Project {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  activeGoals: number;
  activeSessions?: number;
  gitRemote?: { owner: string; repo: string } | null;
}

export interface Feature {
  id: string;
  name: string;
  branch: string;
  baseBranch: string;
  projectId: string;
  sessionCount: number;
}

export interface Session {
  id: string;
  clientType: string;
  workingDir: string | null;
  status: string;
  createdAt: string;
  lastAccessedAt: string;
  metadata: Record<string, unknown> | null;
}

export interface Message {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
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

export interface GoalNode {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  deadline: string | null;
  children: GoalNode[];
}

export interface TokenUsage {
  provider: string;
  model: string;
  totalTokens: number;
  sessionCount: number;
}

export interface TraceRecord {
  id: string;
  version: string;
  timestamp: string;
  vcs: { type: string; revision: string };
  tool: { name: string; version: string };
  files: Array<{
    path: string;
    conversations: Array<{
      url: string;
      contributor: { type: string; model_id?: string };
      ranges: Array<{ start_line: number; end_line: number; content_hash?: string }>;
    }>;
  }>;
}

export interface GitInfo {
  currentBranch: string;
  remote?: { owner: string; repo: string };
  uncommittedChanges: number;
  recentCommits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
}

async function fetchAPI<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const parsed = await res.json() as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      detail = null;
    }
    throw new Error(detail ? `API error: ${res.status} ${detail}` : `API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function postAPI<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const parsed = await res.json() as Record<string, unknown>;
      if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch {
      detail = null;
    }
    throw new Error(detail ? `API error: ${res.status} ${detail}` : `API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ============ Projects ============

export async function getProjects(): Promise<Project[]> {
  const data = await fetchAPI<{ projects: Project[] }>('/projects');
  return data.projects ?? [];
}

export async function getFeatures(projectPath: string): Promise<{ features: Feature[]; currentBranch: string }> {
  const encoded = encodeURIComponent(projectPath);
  return fetchAPI(`/projects/${encoded}/features`);
}

export async function getProjectSessions(projectPath: string): Promise<Session[]> {
  const encoded = encodeURIComponent(projectPath);
  const data = await fetchAPI<{ sessions: Session[] }>(`/projects/${encoded}/sessions`);
  return data.sessions ?? [];
}

// ============ Sessions ============

export async function getSessions(limit = 50): Promise<Session[]> {
  const data = await fetchAPI<{ sessions: Session[] }>(`/sessions?limit=${limit}`);
  return data.sessions ?? [];
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const data = await fetchAPI<{ session: Session | null }>(`/sessions/${encodeURIComponent(sessionId)}`);
  return data.session;
}

export async function getSessionMessages(sessionId: string): Promise<Message[]> {
  const data = await fetchAPI<{ messages: Message[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
  return data.messages ?? [];
}

// ============ Git Integration ============

export async function getPRs(owner: string, repo: string, branch?: string): Promise<PRInfo[]> {
  const encoded = encodeURIComponent(branch || '');
  const data = await fetchAPI<{ prs: PRInfo[] }>(`/features/${encoded}/prs?owner=${owner}&repo=${repo}`);
  return data.prs ?? [];
}

// ============ Goals ============

export async function getGoalHierarchy(): Promise<GoalNode[]> {
  const data = await fetchAPI<{ goals: GoalNode[]; note?: string }>('/goals/hierarchy');
  return data.goals ?? [];
}

// ============ Token Usage ============

export async function getTokenUsage(): Promise<TokenUsage[]> {
  const data = await fetchAPI<{ usage: TokenUsage[] }>('/token-usage');
  return data.usage ?? [];
}

// ============ Traces ============

export async function getTraces(limit = 50): Promise<TraceRecord[]> {
  const data = await fetchAPI<{ traces: TraceRecord[] }>(`/traces?limit=${limit}`);
  return data.traces ?? [];
}

export async function getTraceByRevision(revision: string): Promise<TraceRecord | null> {
  try {
    const data = await fetchAPI<{ trace: TraceRecord }>(`/traces/revision/${revision}`);
    return data.trace;
  } catch {
    return null;
  }
}

// ============ Git Info ============

export async function getGitInfo(projectPath: string): Promise<GitInfo | null> {
  try {
    const encoded = encodeURIComponent(projectPath);
    return fetchAPI<GitInfo>(`/projects/${encoded}/git`);
  } catch {
    return null;
  }
}

// ============ Session Actions ============

export async function sendSessionMessage(sessionId: string, message: string): Promise<{ success: boolean }> {
  return postAPI(`/sessions/${encodeURIComponent(sessionId)}/message`, { message });
}

export async function stopSession(sessionId: string): Promise<{ success: boolean }> {
  return postAPI(`/sessions/${encodeURIComponent(sessionId)}/stop`, {});
}

// ============ Cockpit v0.1 ============ 

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

export interface DailyMetrics {
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

export interface FocusData {
  type: 'session' | 'escalation';
  id: string;
  sessionKey: string;
  header: Record<string, unknown>;
  packet: FocusPacket | null;
  pointers: Record<string, string>;
}

export interface NormalizedSessionEvent {
  at: string;
  type: 'message' | 'tool' | 'workflow' | 'packet' | 'test' | 'trace';
  payload: Record<string, unknown>;
  signalPriority?: 'high' | 'medium' | 'low' | 'status';
  isStatusOnly?: boolean;
}

export interface DiffHotspot {
  path: string;
  added: number;
  deleted: number;
  lineRanges?: Array<{ start: number; end: number; added: number; deleted: number }>;
}

export interface CockpitDiff {
  baseSha: string;
  headSha: string;
  source: 'query' | 'session' | 'git-parent' | 'unknown';
  summary: {
    added: number;
    deleted: number;
    filesTouched: number;
  };
  hotspots: DiffHotspot[];
  patch: string | null;
}

export interface CockpitTestReport {
  id: string;
  sessionKey: string;
  workItemId: string;
  verdict: 'pass' | 'fail' | 'error' | 'skip';
  categories: Array<Record<string, unknown>>;
  cases: Array<Record<string, unknown>>;
  cliOutput: string;
  command: string;
  coverage: Record<string, unknown> | null;
  mutationScore: number | null;
  agentNote: string;
  durationMs: number;
  createdAt: string;
}

export interface RepoLensMatch {
  kind: 'defs' | 'refs' | 'text';
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface PostCockpitPacketInput {
  sessionKey: string;
  packetId?: string;
  workItemId?: string;
  escalationId?: string;
  type?: 'escalation' | 'review' | 'session' | 'ready' | 'ready_review' | 'pr_review';
  markdown?: string;
  contentMarkdown?: string;
  markdownPath?: string;
  evidenceIndex?: Array<{ type: string; value: string }>;
  createdAt?: string | number;
  source?: string;
  requestId?: string;
}

export interface CockpitSessionControlInput {
  action: 'start' | 'stop' | 'fork';
  message?: string;
  note?: string;
  targetSessionKey?: string;
}

export interface CockpitSessionReviewDecisionInput {
  decision: 'accept' | 'request_changes';
  note?: string;
  requestId?: string;
}

export interface CockpitPatchEditInput {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface CockpitPatchApplyInput {
  sessionKey: string;
  baseSha?: string;
  patch?: string;
  edits?: CockpitPatchEditInput[];
  workItemId?: string;
  requestId?: string;
}

export interface CockpitBrowserActionInput {
  sessionKey: string;
  action: 'open' | 'back' | 'forward' | 'reload' | 'snapshot' | 'click' | 'fill' | 'type' | 'press' | 'wait' | 'scroll' | 'get_url' | 'get_title' | 'screenshot' | 'close';
  url?: string;
  target?: string;
  text?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  pixels?: number;
  waitMs?: number;
  label?: string;
  workItemId?: string;
  requestId?: string;
}

export interface CockpitBrowserEvidence {
  id: string;
  type: 'screenshot' | 'snapshot';
  path: string;
  createdAt: string;
  label?: string;
  url?: string;
  title?: string;
}

export interface CockpitBrowserState {
  sessionKey: string;
  browserSession: string;
  available: boolean;
  connected: boolean;
  currentUrl?: string;
  title?: string;
  lastActionAt?: string;
  actions: Array<Record<string, unknown>>;
  evidence: CockpitBrowserEvidence[];
  lastSnapshotPath?: string;
  lastSnapshotPreview?: string;
}

export interface CockpitMarkdownTreeNode {
  type: 'folder' | 'file';
  name: string;
  path: string;
  children?: CockpitMarkdownTreeNode[];
  size?: number;
  updatedAt?: string;
  version?: number;
}

export interface CockpitMarkdownFile {
  path: string;
  content: string;
  version: number;
  updatedAt: string;
  size: number;
  hash?: string;
  etag?: string;
  lineCount?: number;
  wordCount?: number;
  metadata?: Record<string, unknown>;
}

export interface CockpitMarkdownContextInput {
  path?: string;
  version?: number;
  updatedAt?: string;
  content?: string;
  isDirty?: boolean;
  selectionStart?: number;
  selectionEnd?: number;
  metadata?: Record<string, unknown>;
}

export async function getCockpitSessionRollups(
  status: SessionPanelStatus,
  limit = 100
): Promise<SessionRollup[]> {
  const data = await fetchAPI<{ rollups: SessionRollup[] }>(
    `/cockpit/rollups/sessions?status=${encodeURIComponent(status)}&limit=${limit}`
  );
  return data.rollups ?? [];
}

export async function getCockpitEscalationRollups(limit = 100): Promise<EscalationRollup[]> {
  const data = await fetchAPI<{ rollups: EscalationRollup[] }>(
    `/cockpit/rollups/escalations?status=open&limit=${limit}`
  );
  return data.rollups ?? [];
}

export async function getCockpitCommitRollups(limit = 50): Promise<CommitRollup[]> {
  const data = await fetchAPI<{ rollups: CommitRollup[] }>(`/cockpit/rollups/commits?limit=${limit}`);
  return data.rollups ?? [];
}

export async function getCockpitPRRollups(
  status: 'open' | 'closed' | 'merged' = 'open',
  limit = 50
): Promise<PRRollup[]> {
  const data = await fetchAPI<{ rollups: PRRollup[] }>(
    `/cockpit/rollups/prs?status=${encodeURIComponent(status)}&limit=${limit}`
  );
  return data.rollups ?? [];
}

export async function getCockpitDailyMetrics(date?: string): Promise<DailyMetrics | null> {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  const data = await fetchAPI<{ metrics: DailyMetrics | null }>(`/cockpit/metrics/daily${query}`);
  return data.metrics ?? null;
}

export async function getCockpitFocus(
  type: 'session' | 'escalation',
  id: string,
  packetId?: string
): Promise<FocusData | null> {
  const packetQuery = packetId ? `&packetId=${encodeURIComponent(packetId)}` : '';
  const data = await fetchAPI<{ focus: FocusData | null }>(
    `/cockpit/focus?type=${type}&id=${encodeURIComponent(id)}${packetQuery}`
  );
  return data.focus ?? null;
}

export async function getCockpitSessionEvents(
  sessionKey: string,
  options: { cursor?: number; limit?: number } = {}
): Promise<{ events: NormalizedSessionEvent[]; nextCursor: number | null }> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 200));
  if (typeof options.cursor === 'number') {
    params.set('cursor', String(options.cursor));
  }
  const data = await fetchAPI<{ events: NormalizedSessionEvent[]; nextCursor: number | null }>(
    `/cockpit/session/${encodeURIComponent(sessionKey)}/events?${params.toString()}`
  );
  return {
    events: data.events ?? [],
    nextCursor: data.nextCursor ?? null,
  };
}

export async function getCockpitSessionPackets(
  sessionKey: string,
  limit = 20
): Promise<FocusPacket[]> {
  const data = await fetchAPI<{ packets: FocusPacket[] }>(
    `/cockpit/session/${encodeURIComponent(sessionKey)}/packets?limit=${limit}`
  );
  return data.packets ?? [];
}

export async function getCockpitTraces(
  sessionKey: string,
  options: { workItemId?: string; limit?: number } = {}
): Promise<TraceRecord[]> {
  const params = new URLSearchParams();
  params.set('sessionKey', sessionKey);
  params.set('limit', String(options.limit ?? 200));
  if (options.workItemId) params.set('workItemId', options.workItemId);
  const data = await fetchAPI<{ traces: TraceRecord[] }>(`/cockpit/traces?${params.toString()}`);
  return data.traces ?? [];
}

export async function getCockpitDiff(options: {
  sessionKey?: string;
  base?: string;
  head?: string;
  file?: string;
}): Promise<CockpitDiff> {
  const params = new URLSearchParams();
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  if (options.base) params.set('base', options.base);
  if (options.head) params.set('head', options.head);
  if (options.file) params.set('file', options.file);
  return fetchAPI<CockpitDiff>(`/cockpit/diff?${params.toString()}`);
}

export async function getCockpitTestReports(
  options: { sessionKey?: string; workItemId?: string; limit?: number } = {}
): Promise<CockpitTestReport[]> {
  const params = new URLSearchParams();
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  if (options.workItemId) params.set('workItemId', options.workItemId);
  params.set('limit', String(options.limit ?? 20));
  const data = await fetchAPI<{ reports: CockpitTestReport[] }>(`/cockpit/tests?${params.toString()}`);
  return data.reports ?? [];
}

export async function getCockpitTestReport(testReportId: string): Promise<CockpitTestReport | null> {
  try {
    const data = await fetchAPI<{ report: CockpitTestReport | null }>(
      `/cockpit/tests/${encodeURIComponent(testReportId)}`
    );
    return data.report ?? null;
  } catch {
    return null;
  }
}

export async function searchCockpitRepoLens(options: {
  sessionKey?: string;
  q: string;
  kind?: 'all' | 'defs' | 'refs' | 'text';
  limit?: number;
}): Promise<{ defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] }> {
  const params = new URLSearchParams();
  params.set('q', options.q);
  params.set('kind', options.kind ?? 'all');
  params.set('limit', String(options.limit ?? 120));
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  const data = await fetchAPI<{
    results: { defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] };
  }>(`/cockpit/repo/lens?${params.toString()}`);
  return data.results ?? { defs: [], refs: [], text: [] };
}

export async function getCockpitPreview(options: {
  sessionKey?: string;
  url?: string;
}): Promise<{ url: string; source: 'query' | 'session' } | null> {
  const params = new URLSearchParams();
  if (options.sessionKey) params.set('sessionKey', options.sessionKey);
  if (options.url) params.set('url', options.url);
  try {
    return await fetchAPI<{ url: string; source: 'query' | 'session' }>(`/cockpit/preview?${params.toString()}`);
  } catch {
    return null;
  }
}

export async function getCockpitBrowserState(sessionKey: string): Promise<CockpitBrowserState | null> {
  const params = new URLSearchParams();
  params.set('sessionKey', sessionKey);
  try {
    const data = await fetchAPI<{ state: CockpitBrowserState }>(`/cockpit/browser/state?${params.toString()}`);
    return data.state ?? null;
  } catch {
    return null;
  }
}

export async function postCockpitBrowserAction(
  input: CockpitBrowserActionInput
): Promise<{
  success: boolean;
  action?: string;
  browserSession?: string;
  data?: unknown;
  output?: string;
  artifactPath?: string;
  currentUrl?: string;
  title?: string;
  evidence?: CockpitBrowserEvidence;
  error?: string;
}> {
  return postAPI('/cockpit/browser/action', input);
}

export async function postCockpitBrowserRunbook(input: {
  sessionKey: string;
  script: string;
  stopOnError?: boolean;
  workItemId?: string;
  requestId?: string;
}): Promise<{
  success: boolean;
  browserSession?: string;
  stopOnError?: boolean;
  steps?: Array<Record<string, unknown>>;
  evidence?: CockpitBrowserEvidence[];
  currentUrl?: string;
  title?: string;
}> {
  return postAPI('/cockpit/browser/runbook', input);
}

export async function getCockpitMarkdownTree(): Promise<{
  rootDir: string;
  tree: CockpitMarkdownTreeNode[];
  suggestedFolders: string[];
}> {
  const data = await fetchAPI<{
    rootDir: string;
    tree: CockpitMarkdownTreeNode[];
    suggestedFolders: string[];
  }>('/cockpit/markdown/tree');
  return {
    rootDir: data.rootDir ?? '.cockpit/markdown',
    tree: data.tree ?? [],
    suggestedFolders: data.suggestedFolders ?? [],
  };
}

export async function getCockpitMarkdownFile(filePath: string): Promise<CockpitMarkdownFile> {
  const data = await fetchAPI<{ file: CockpitMarkdownFile }>(
    `/cockpit/markdown/file?path=${encodeURIComponent(filePath)}`
  );
  return data.file;
}

export async function postCockpitMarkdownFile(input: {
  path: string;
  content: string;
  expectedVersion?: number;
  metadata?: Record<string, unknown>;
  source?: string;
}): Promise<{
  success: boolean;
  created?: boolean;
  previousVersion?: number;
  file?: CockpitMarkdownFile;
  currentVersion?: number;
  currentHash?: string;
  error?: string;
}> {
  return postAPI('/cockpit/markdown/file', input);
}

export async function postCockpitMarkdownFolder(input: {
  path: string;
}): Promise<{ success: boolean; folder?: { path: string } }> {
  return postAPI('/cockpit/markdown/folder', input);
}

export async function importCockpitMarkdownFile(input: {
  sessionKey?: string;
  markdownPath?: string;
  destinationPath?: string;
  folder?: string;
  filename?: string;
  content?: string;
  expectedVersion?: number;
  metadata?: Record<string, unknown>;
  source?: string;
}): Promise<{
  success: boolean;
  created?: boolean;
  previousVersion?: number;
  file?: CockpitMarkdownFile;
  sourcePath?: string;
  currentVersion?: number;
  currentHash?: string;
  error?: string;
}> {
  return postAPI('/cockpit/markdown/import', input);
}

export async function postCockpitMarkdownPatch(input: {
  path: string;
  expectedVersion: number;
  content?: string;
  patch?: string;
  edits?: Array<{ startLine: number; endLine: number; replacement: string }>;
  metadata?: Record<string, unknown>;
  source?: string;
}): Promise<{
  success: boolean;
  mode?: 'content' | 'patch' | 'edits';
  changedLines?: number;
  previousVersion?: number;
  file?: CockpitMarkdownFile;
  currentVersion?: number;
  currentHash?: string;
  error?: string;
}> {
  return postAPI('/cockpit/markdown/patch', input);
}

export async function resolveCockpitEscalation(
  escalationId: string,
  input: {
    optionId?: string;
    freeformResponse?: string;
    note?: string;
  } = {}
): Promise<{ success: boolean; escalation?: Record<string, unknown>; result?: Record<string, unknown> }> {
  return postAPI(`/cockpit/escalations/${encodeURIComponent(escalationId)}/resolve`, input);
}

export async function postCockpitPacket(
  input: PostCockpitPacketInput
): Promise<{ success: boolean; packet?: Record<string, unknown> }> {
  return postAPI('/cockpit/packets', input);
}

export async function postCockpitSessionMessage(
  sessionKey: string,
  message: string,
  options?: { markdownContext?: CockpitMarkdownContextInput }
): Promise<{ success: boolean; requestId?: string; queued?: boolean; markdownContextAttached?: boolean }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/message`, {
    message,
    ...(options?.markdownContext ? { markdownContext: options.markdownContext } : {}),
  });
}

export async function postCockpitSessionControl(
  sessionKey: string,
  input: CockpitSessionControlInput
): Promise<{ success: boolean; requestId?: string; targetSessionKey?: string }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/control`, input);
}

export async function postCockpitSessionReviewDecision(
  sessionKey: string,
  input: CockpitSessionReviewDecisionInput
): Promise<{ success: boolean; sessionKey: string; decision: string; fromStatus: string; toStatus: string }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/review`, input);
}

export async function applyCockpitPatch(
  input: CockpitPatchApplyInput
): Promise<{
  success: boolean;
  mode?: 'patch' | 'edits';
  files?: string[];
  changedLines?: number;
  warning?: string;
}> {
  return postAPI('/cockpit/patch/apply', input);
}


### function_call_output
@callId call_9b78681df1714a89a54a2da7
@ts 1770396160907
@durationMs 4
@workItemId b4d163ca
import { createContext, useCallback, useContext, useReducer, useRef } from 'react';
import {
  applyCockpitPatch,
  getCockpitBrowserState,
  getCockpitCommitRollups,
  getCockpitDailyMetrics,
  getCockpitDiff,
  getCockpitEscalationRollups,
  getCockpitFocus,
  getCockpitPRRollups,
  getCockpitSessionEvents,
  getCockpitTestReport,
  getCockpitTestReports,
  getCockpitTraces,
  postCockpitBrowserAction,
  postCockpitBrowserRunbook,
  postCockpitSessionMessage,
  postCockpitSessionReviewDecision,
  resolveCockpitEscalation,
  searchCockpitRepoLens,
  getCockpitSessionRollups,
  type CockpitBrowserActionInput,
  type CockpitBrowserState,
  type CockpitDiff,
  type CockpitTestReport,
  type CommitRollup,
  type DailyMetrics,
  type EscalationRollup,
  type FocusData,
  type NormalizedSessionEvent,
  type PRRollup,
  type RepoLensMatch,
  type SessionRollup,
  type TraceRecord,
} from '@/lib/api';
import {
  describeLatestToolSignal,
  extractMessageContent,
  isFailureEvent,
  isMessageLikeEvent,
  messageRoleForEvent,
} from '@/lib/events';
import { parsePacketMarkdown } from '@/lib/packets';

// ─── Types ───────────────────────────────────────────────────

export type FocusTarget =
  | { type: 'session'; id: string }
  | { type: 'escalation'; id: string };

export type FocusTab = 'packet' | 'diff' | 'tests' | 'trace' | 'lens' | 'browser';
export type EventFilter = 'signal' | 'all' | 'messages' | 'tools' | 'failures' | 'audit';

const DEFAULT_BROWSER_RUNBOOK = [
  '# One command per line',
  '# open https://example.com',
  '# snapshot -i -c',
  '# click @e1',
  '# fill @e2 "search query"',
  '# press Enter',
  '# screenshot smoke-check',
].join('\n');

// ─── State ───────────────────────────────────────────────────

export interface CockpitState {
  runningSessions: SessionRollup[];
  readySessions: SessionRollup[];
  doneSessions: SessionRollup[];
  escalations: EscalationRollup[];
  commitRollups: CommitRollup[];
  prRollups: PRRollup[];
  metrics: DailyMetrics | null;

  focusTarget: FocusTarget | null;
  focusData: FocusData | null;
  focusTab: FocusTab;
  events: NormalizedSessionEvent[];
  diffData: CockpitDiff | null;
  selectedDiffFile: string | null;
  testReports: CockpitTestReport[];
  selectedTestReportId: string | null;
  selectedTestReport: CockpitTestReport | null;
  traces: TraceRecord[];
  browserState: CockpitBrowserState | null;
  lensResults: { defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] };
  lensQuery: string;

  eventFilter: EventFilter;
  eventDrawerOpen: boolean;
  loading: boolean;
  error: string | null;
  lastUpdate: Date;

  // Browser drafts
  browserUrlDraft: string;
  browserActionType: 'click' | 'fill' | 'type' | 'press' | 'wait' | 'scroll';
  browserTargetDraft: string;
  browserValueDraft: string;
  browserDirectionDraft: 'up' | 'down' | 'left' | 'right';
  browserSnapshotInteractive: boolean;
  browserSnapshotCompact: boolean;
  browserRunbook: string;
  browserRunningRunbook: boolean;
  browserLoading: boolean;
  browserActionStatus: string | null;

  // Patch
  patchDraft: string;
  patchApplyStatus: string | null;
  applyingPatch: boolean;

  // Message input
  messageDraft: string;
  sendingMessage: boolean;
  inputVisible: boolean;

  // Review / resolve
  resolvingEscalationId: string | null;
  reviewDecisionAction: 'accept' | 'request_changes' | null;

  // Lens
  lensLoading: boolean;

  // Pending commit range (for cross-linking commits → diff)
  pendingCommitRange: { sessionKey: string; base?: string; head?: string } | null;
}

const initialState: CockpitState = {
  runningSessions: [],
  readySessions: [],
  doneSessions: [],
  escalations: [],
  commitRollups: [],
  prRollups: [],
  metrics: null,

  focusTarget: null,
  focusData: null,
  focusTab: 'packet',
  events: [],
  diffData: null,
  selectedDiffFile: null,
  testReports: [],
  selectedTestReportId: null,
  selectedTestReport: null,
  traces: [],
  browserState: null,
  lensResults: { defs: [], refs: [], text: [] },
  lensQuery: '',

  eventFilter: 'all',
  eventDrawerOpen: false,
  loading: true,
  error: null,
  lastUpdate: new Date(),

  browserUrlDraft: '',
  browserActionType: 'click',
  browserTargetDraft: '',
  browserValueDraft: '',
  browserDirectionDraft: 'down',
  browserSnapshotInteractive: true,
  browserSnapshotCompact: true,
  browserRunbook: DEFAULT_BROWSER_RUNBOOK,
  browserRunningRunbook: false,
  browserLoading: false,
  browserActionStatus: null,

  patchDraft: '',
  patchApplyStatus: null,
  applyingPatch: false,

  messageDraft: '',
  sendingMessage: false,
  inputVisible: false,

  resolvingEscalationId: null,
  reviewDecisionAction: null,

  lensLoading: false,
  pendingCommitRange: null,
};

// ─── Actions ─────────────────────────────────────────────────

type Action =
  | { type: 'SET'; payload: Partial<CockpitState> }
  | { type: 'SET_ROLLUPS'; payload: Pick<CockpitState, 'runningSessions' | 'readySessions' | 'doneSessions' | 'escalations' | 'commitRollups' | 'prRollups' | 'metrics'> }
  | { type: 'SET_FOCUS_DATA'; payload: { focusData: FocusData | null; events: NormalizedSessionEvent[]; traces: TraceRecord[]; testReports: CockpitTestReport[]; diffData: CockpitDiff | null } }
  | { type: 'CLEAR_FOCUS' }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'REFRESH_DONE' };

function reducer(state: CockpitState, action: Action): CockpitState {
  switch (action.type) {
    case 'SET':
      return { ...state, ...action.payload };
    case 'SET_ROLLUPS': {
      const next = { ...state, ...action.payload, loading: false, lastUpdate: new Date() };
      // Validate that focusTarget still exists in the new data
      if (next.focusTarget) {
        if (next.focusTarget.type === 'escalation') {
          const exists = next.escalations.some((r) => r.escalationId === next.focusTarget!.id);
          if (!exists) next.focusTarget = null;
        } else {
          const allSessions = [...next.runningSessions, ...next.readySessions, ...next.doneSessions];
          const exists = allSessions.some((r) => r.sessionKey === next.focusTarget!.id);
          if (!exists) next.focusTarget = null;
        }
      }
      return next;
    }
    case 'SET_FOCUS_DATA': {
      const { focusData, events, traces, testReports, diffData } = action.payload;
      return {
        ...state,
        focusData,
        events,
        traces,
        testReports,
        diffData,
        selectedTestReportId: testReports[0]?.id ?? null,
        selectedTestReport: testReports[0] ?? null,
        selectedDiffFile: diffData?.hotspots?.[0]?.path ?? null,
        patchDraft: '',
        patchApplyStatus: null,
        lensResults: { defs: [], refs: [], text: [] },
        browserActionStatus: null,
      };
    }
    case 'CLEAR_FOCUS':
      return {
        ...state,
        focusData: null,
        events: [],
        diffData: null,
        selectedDiffFile: null,
        testReports: [],
        selectedTestReport: null,
        selectedTestReportId: null,
        traces: [],
        patchDraft: '',
        patchApplyStatus: null,
        lensResults: { defs: [], refs: [], text: [] },
        browserState: null,
        browserActionStatus: null,
      };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'REFRESH_DONE':
      return { ...state, loading: false, error: null, lastUpdate: new Date() };
    default:
      return state;
  }
}

// ─── Derived selectors ───────────────────────────────────────

export function selectToolSignal(state: CockpitState) {
  return describeLatestToolSignal(state.events);
}

export function selectRecentAssistantMessage(state: CockpitState): string | null {
  for (let idx = state.events.length - 1; idx >= 0; idx -= 1) {
    const event = state.events[idx];
    if (!isMessageLikeEvent(event)) continue;
    const role = messageRoleForEvent(event);
    if (role !== 'assistant') continue;
    const content = extractMessageContent(event.payload);
    if (content) return content;
  }
  return null;
}

export function selectFocusRollup(state: CockpitState): SessionRollup | null {
  const sessionKey = state.focusData?.sessionKey;
  if (!sessionKey) return null;
  return [...state.runningSessions, ...state.readySessions, ...state.doneSessions]
    .find((r) => r.sessionKey === sessionKey) ?? null;
}

export function selectParsedPacket(state: CockpitState) {
  return parsePacketMarkdown(state.focusData?.packet?.contentMarkdown ?? '');
}

export function selectFocusStatus(state: CockpitState): string | null {
  return typeof state.focusData?.header?.status === 'string' ? state.focusData.header.status : null;
}

export function selectFocusEscalationId(state: CockpitState): string | null {
  return state.focusData?.type === 'escalation' ? state.focusData.id : null;
}

export function selectFilteredEvents(state: CockpitState): NormalizedSessionEvent[] {
  const { events, eventFilter } = state;

  if (eventFilter === 'signal') {
    return events.filter((event) => {
      const priority = event.signalPriority;
      if (priority) return priority === 'high' || priority === 'medium';
      if (event.type === 'packet') return true;
      if (isMessageLikeEvent(event)) {
        const role = messageRoleForEvent(event);
        const content = extractMessageContent(event.payload);
        if (role === 'assistant' && content.length > 50) return true;
        if (role === 'user') return true;
      }
      return isFailureEvent(event);
    });
  }

  if (eventFilter === 'audit') {
    return events.filter((event) => {
      if (event.isStatusOnly) return true;
      if (event.type === 'tool') return true;
      return false;
    });
  }

  if (eventFilter === 'messages') return events.filter(isMessageLikeEvent);
  if (eventFilter === 'tools') return events.filter((e) => e.type === 'tool');
  if (eventFilter === 'failures') return events.filter(isFailureEvent);
  if (eventFilter === 'all') {
    return events.filter((event) => event.type !== 'tool' || isFailureEvent(event));
  }
  return events;
}

// ─── Hook ────────────────────────────────────────────────────

export function useCockpitStore() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const set = useCallback((payload: Partial<CockpitState>) => {
    dispatch({ type: 'SET', payload });
  }, []);

  const refreshRollups = useCallback(async () => {
    try {
      const [running, blocked, ready, done, escalationRows, commits, prs, dailyMetrics] = await Promise.all([
        getCockpitSessionRollups('running', 120),
        getCockpitSessionRollups('blocked', 120),
        getCockpitSessionRollups('ready', 120),
        getCockpitSessionRollups('done', 120),
        getCockpitEscalationRollups(120),
        getCockpitCommitRollups(50),
        getCockpitPRRollups('open', 50),
        getCockpitDailyMetrics(),
      ]);
      dispatch({
        type: 'SET_ROLLUPS',
        payload: {
          runningSessions: [...blocked, ...running],
          readySessions: ready,
          doneSessions: done,
          escalations: escalationRows,
          commitRollups: commits,
          prRollups: prs,
          metrics: dailyMetrics,
        },
      });
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const refreshFocus = useCallback(async (target: FocusTarget | null) => {
    if (!target) {
      dispatch({ type: 'CLEAR_FOCUS' });
      return;
    }
    const focusData = await getCockpitFocus(target.type, target.id);
    if (!focusData) {
      dispatch({ type: 'CLEAR_FOCUS' });
      return;
    }
    const [eventResponse, traceRows, reportRows, diffResponse] = await Promise.all([
      getCockpitSessionEvents(focusData.sessionKey, { limit: 200 }),
      getCockpitTraces(focusData.sessionKey, { limit: 120 }).catch(() => [] as TraceRecord[]),
      getCockpitTestReports({ sessionKey: focusData.sessionKey, limit: 20 }).catch(() => [] as CockpitTestReport[]),
      getCockpitDiff({ sessionKey: focusData.sessionKey }).catch(() => null),
    ]);
    dispatch({
      type: 'SET_FOCUS_DATA',
      payload: {
        focusData,
        events: eventResponse.events,
        traces: traceRows,
        testReports: reportRows,
        diffData: diffResponse,
      },
    });
    const focusPreviewUrl = typeof focusData?.header?.previewUrl === 'string'
      ? focusData.header.previewUrl
      : '';
    if (focusPreviewUrl && !stateRef.current.browserUrlDraft) {
      set({ browserUrlDraft: focusPreviewUrl });
    }
  }, [set]);

  const refreshAll = useCallback(async () => {
    await refreshRollups();
    const target = stateRef.current.focusTarget;
    if (target) await refreshFocus(target);
  }, [refreshRollups, refreshFocus]);

  const setFocusTarget = useCallback((target: FocusTarget | null) => {
    set({ focusTarget: target });
  }, [set]);

  const refreshBrowserState = useCallback(async (sessionKey: string | null | undefined) => {
    if (!sessionKey) {
      set({ browserState: null });
      return;
    }
    set({ browserLoading: true });
    try {
      const bState = await getCockpitBrowserState(sessionKey);
      set({ browserState: bState, browserLoading: false });
      if (bState?.currentUrl && !stateRef.current.browserUrlDraft) {
        set({ browserUrlDraft: bState.currentUrl });
      }
    } catch (err) {
      set({ browserActionStatus: err instanceof Error ? err.message : String(err), browserLoading: false });
    }
  }, [set]);

  const handleBrowserAction = useCallback(async (input: Omit<CockpitBrowserActionInput, 'sessionKey'>) => {
    const sessionKey = stateRef.current.focusData?.sessionKey;
    if (!sessionKey) return;
    set({ browserLoading: true, browserActionStatus: null });
    try {
      const response = await postCockpitBrowserAction({ sessionKey, ...input });
      if (!response.success) {
        set({ browserActionStatus: response.error ?? 'Browser action failed', browserLoading: false });
        return;
      }
      const actionLabel = response.action ?? input.action;
      const outputSummary = response.artifactPath
        ? `${actionLabel} ok · ${response.artifactPath}`
        : `${actionLabel} ok`;
      set({ browserActionStatus: outputSummary, browserLoading: false });
      if (response.currentUrl) {
        set({ browserUrlDraft: response.currentUrl });
      }
      await refreshBrowserState(sessionKey);
      await refreshAll();
    } catch (err) {
      set({ browserActionStatus: err instanceof Error ? err.message : String(err), browserLoading: false });
    }
  }, [set, refreshBrowserState, refreshAll]);

  const handleRunBrowserRunbook = useCallback(async () => {
    const sessionKey = stateRef.current.focusData?.sessionKey;
    const runbook = stateRef.current.browserRunbook;
    if (!sessionKey || !runbook.trim()) return;
    set({ browserRunningRunbook: true, browserActionStatus: null });
    try {
      const result = await postCockpitBrowserRunbook({ sessionKey, script: runbook, stopOnError: true });
      const steps = result.steps ?? [];
      const failed = steps.filter((s) => s.success === false).length;
      set({
        browserActionStatus: failed > 0
          ? `Runbook finished with ${failed} failed step(s)`
          : `Runbook completed (${steps.length} step${steps.length === 1 ? '' : 's'})`,
        browserRunningRunbook: false,
      });
      if (result.currentUrl) {
        set({ browserUrlDraft: result.currentUrl });
      }
      await refreshBrowserState(sessionKey);
      await refreshAll();
    } catch (err) {
      set({ browserActionStatus: err instanceof Error ? err.message : String(err), browserRunningRunbook: false });
    }
  }, [set, refreshBrowserState, refreshAll]);

  const handleApplyPatch = useCallback(async () => {
    const { focusData, patchDraft, diffData: dd } = stateRef.current;
    if (!focusData?.sessionKey || !patchDraft.trim()) return;
    set({ applyingPatch: true, patchApplyStatus: null });
    try {
      const response = await applyCockpitPatch({
        sessionKey: focusData.sessionKey,
        patch: patchDraft,
        ...(dd?.baseSha ? { baseSha: dd.baseSha } : {}),
      });
      if (response.success) {
        set({
          patchApplyStatus: `Applied ${response.mode ?? 'patch'}: ${response.files?.length ?? 0} files, ${response.changedLines ?? 0} lines`,
          patchDraft: '',
          applyingPatch: false,
        });
        await refreshAll();
      } else {
        set({ patchApplyStatus: 'Patch apply failed', applyingPatch: false });
      }
    } catch (err) {
      set({ patchApplyStatus: err instanceof Error ? err.message : String(err), applyingPatch: false });
    }
  }, [set, refreshAll]);

  const handleResolveEscalation = useCallback(async (escalationId: string) => {
    const freeformResponse = window.prompt('Resolution note (optional):');
    if (freeformResponse === null) return;
    set({ resolvingEscalationId: escalationId });
    try {
      await resolveCockpitEscalation(escalationId, {
        freeformResponse: freeformResponse.trim() || undefined,
      });
      set({ focusTarget: null, resolvingEscalationId: null });
      await refreshAll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), resolvingEscalationId: null });
    }
  }, [set, refreshAll]);

  const handleReviewDecision = useCallback(async (decision: 'accept' | 'request_changes') => {
    const sessionKey = stateRef.current.focusData?.sessionKey;
    if (!sessionKey) return;
    const note = window.prompt(
      decision === 'accept' ? 'Optional acceptance note:' : 'Optional request-changes note:'
    );
    if (note === null) return;
    set({ reviewDecisionAction: decision });
    try {
      await postCockpitSessionReviewDecision(sessionKey, {
        decision,
        note: note.trim() || undefined,
      });
      set({ reviewDecisionAction: null });
      await refreshAll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), reviewDecisionAction: null });
    }
  }, [set, refreshAll]);

  const handleSendMessage = useCallback(async () => {
    const { focusData, messageDraft: draft } = stateRef.current;
    if (!focusData?.sessionKey || !draft.trim()) return;
    set({ sendingMessage: true });
    try {
      await postCockpitSessionMessage(focusData.sessionKey, draft.trim());
      set({ messageDraft: '', sendingMessage: false });
      await refreshAll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), sendingMessage: false });
    }
  }, [set, refreshAll]);

  const handleRunLensSearch = useCallback(async () => {
    const { focusData, lensQuery: q } = stateRef.current;
    if (!focusData?.sessionKey || !q.trim()) return;
    set({ lensLoading: true });
    try {
      const results = await searchCockpitRepoLens({
        sessionKey: focusData.sessionKey,
        q: q.trim(),
        kind: 'all',
        limit: 120,
      });
      set({ lensResults: results, lensLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), lensLoading: false });
    }
  }, [set]);

  const handleSelectTestReport = useCallback(async (reportId: string) => {
    set({ selectedTestReportId: reportId });
    const existing = stateRef.current.testReports.find((r) => r.id === reportId);
    if (existing) {
      set({ selectedTestReport: existing });
      return;
    }
    const report = await getCockpitTestReport(reportId);
    if (report) set({ selectedTestReport: report });
  }, [set]);

  const handleSelectCommit = useCallback((row: CommitRollup) => {
    if (!row.sessionKey) return;
    set({
      focusTarget: { type: 'session', id: row.sessionKey },
      pendingCommitRange: {
        sessionKey: row.sessionKey,
        ...(row.baseSha ? { base: row.baseSha } : {}),
        ...(row.headSha ? { head: row.headSha } : {}),
      },
    });
  }, [set]);

  const handleSelectPR = useCallback((row: PRRollup) => {
    if (row.sessionKey) {
      set({ focusTarget: { type: 'session', id: row.sessionKey } });
    }
    window.open(row.url, '_blank', 'noopener,noreferrer');
  }, [set]);

  // Resolve packet references
  const resolvePacketRef = useCallback((refTypeRaw: string, targetRaw: string): boolean => {
    const s = stateRef.current;
    const refType = refTypeRaw.trim().toLowerCase();
    const target = targetRaw.trim();
    if (!refType || !target) return false;

    const shaShort = (a: string | undefined, b: string) => {
      if (!a) return false;
      const l = a.toLowerCase(), r = b.toLowerCase();
      return l === r || l.startsWith(r) || r.startsWith(l);
    };

    if (refType === 'commit') {
      if (shaShort(s.diffData?.headSha, target) || shaShort(s.diffData?.baseSha, target)) return true;
      return s.commitRollups.some((r) => shaShort(r.sha, target))
        || s.traces.some((t) => shaShort(t.vcs?.revision, target));
    }
    if (refType === 'file') {
      const path = target.split('#')[0];
      const hotspotPaths = new Set((s.diffData?.hotspots ?? []).map((h) => h.path));
      const tracePaths = new Set(s.traces.flatMap((t) => (t.files ?? []).map((f) => f.path)).filter(Boolean));
      return hotspotPaths.has(path) || tracePaths.has(path);
    }
    if (refType === 'testreport') return s.testReports.some((r) => r.id === target);
    if (refType === 'trace') return s.traces.some((t) => t.id === target || shaShort(t.vcs?.revision, target));
    if (refType === 'workitem') {
      if (typeof s.focusData?.header?.activeWorkItemId === 'string' && s.focusData.header.activeWorkItemId === target) return true;
      return s.events.some((e) => String(e.payload.workItemId ?? '') === target);
    }
    if (refType === 'session') {
      const allKeys = new Set([...s.runningSessions, ...s.readySessions, ...s.doneSessions].map((r) => r.sessionKey));
      return s.focusData?.sessionKey === target || allKeys.has(target);
    }
    if (refType === 'pr') {
      const num = Number(target.replace(/^#/, '').trim());
      return s.prRollups.some((r) => r.prId === target || r.url.includes(target) || (Number.isFinite(num) && r.number === num));
    }
    return false;
  }, []);

  const handlePacketRefClick = useCallback(async (refType: string, target: string) => {
    const s = stateRef.current;
    const type = refType.toLowerCase();

    if (type === 'commit') {
      set({ focusTab: 'diff' });
      if (s.focusData?.sessionKey) {
        const response = await getCockpitDiff({ sessionKey: s.focusData.sessionKey, head: target }).catch(() => null);
        if (response) set({ diffData: response, selectedDiffFile: response.hotspots[0]?.path ?? null });
      }
      return;
    }
    if (type === 'file') {
      const path = target.split('#')[0];
      set({ focusTab: 'diff', selectedDiffFile: path });
      if (s.focusData?.sessionKey) {
        const response = await getCockpitDiff({ sessionKey: s.focusData.sessionKey, file: path }).catch(() => null);
        if (response) set({ diffData: response });
      }
      return;
    }
    if (type === 'testreport') {
      set({ focusTab: 'tests' });
      await handleSelectTestReport(target);
      return;
    }
    if (type === 'trace') {
      set({ focusTab: 'trace' });
    }
  }, [set, handleSelectTestReport]);

  const handlePacketLinkClick = useCallback(async (target: string) => {
    if (!target) return;
    let parsed: URL;
    try {
      parsed = new URL(target, window.location.origin);
    } catch {
      return;
    }
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.includes('/diff')) {
      set({ focusTab: 'diff' });
      const s = stateRef.current;
      if (s.focusData?.sessionKey) {
        const response = await getCockpitDiff({
          sessionKey: s.focusData.sessionKey,
          ...(parsed.searchParams.get('base') ? { base: String(parsed.searchParams.get('base')) } : {}),
          ...(parsed.searchParams.get('head') ? { head: String(parsed.searchParams.get('head')) } : {}),
        }).catch(() => null);
        if (response) set({ diffData: response, selectedDiffFile: response.hotspots[0]?.path ?? null });
      }
      return;
    }
    if (pathname.includes('/tests')) {
      set({ focusTab: 'tests' });
      const reportId = parsed.searchParams.get('id');
      if (reportId) await handleSelectTestReport(reportId);
      return;
    }
    if (pathname.includes('/trace')) {
      set({ focusTab: 'trace' });
      return;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    }
  }, [set, handleSelectTestReport]);

  return {
    state,
    dispatch,
    set,
    refreshRollups,
    refreshFocus,
    refreshAll,
    refreshBrowserState,
    setFocusTarget,
    handleBrowserAction,
    handleRunBrowserRunbook,
    handleApplyPatch,
    handleResolveEscalation,
    handleReviewDecision,
    handleSendMessage,
    handleRunLensSearch,
    handleSelectTestReport,
    handleSelectCommit,
    handleSelectPR,
    resolvePacketRef,
    handlePacketRefClick,
    handlePacketLinkClick,
  };
}

export type CockpitStore = ReturnType<typeof useCockpitStore>;

export const CockpitContext = createContext<CockpitStore | null>(null);

export function useCockpit(): CockpitStore {
  const ctx = useContext(CockpitContext);
  if (!ctx) throw new Error('useCockpit must be used within CockpitContext.Provider');
  return ctx;
}


### function_call_output
@callId call_0cffb4acac4f44d3af7cf60e
@ts 1770396160916
@durationMs 2
@workItemId b4d163ca
import { useEffect, useRef } from 'react';

export function usePolling(callback: () => void | Promise<void>, intervalMs: number) {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useEffect(() => {
    void savedCallback.current();
    const timer = setInterval(() => {
      void savedCallback.current();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}


### function_call_output
@callId call_083b8765a3f94e3b94a66ceb
@ts 1770396160920
@durationMs 2
@workItemId b4d163ca
import { useEffect } from 'react';
import { useCockpitStore, CockpitContext } from '@/hooks/use-cockpit-store';
import { useMarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { usePolling } from '@/hooks/use-polling';
import { useKeyboard } from '@/hooks/use-keyboard';
import { getCockpitDiff } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { StatusBar } from '@/components/layout/StatusBar';
import { FileExplorer } from '@/components/left/FileExplorer';
import { CenterPanel } from '@/components/center/CenterPanel';
import { RightPanel } from '@/components/right/RightPanel';

const POLL_INTERVAL_MS = 5000;

export default function App() {
  const store = useCockpitStore();
  const workspace = useMarkdownWorkspace();

  // Poll for rollup updates
  usePolling(() => store.refreshAll(), POLL_INTERVAL_MS);

  // Refresh focus when focusTarget changes
  useEffect(() => {
    void store.refreshFocus(store.state.focusTarget);
  }, [store.state.focusTarget, store.state.lastUpdate]);

  // Refresh browser state when browser tab is active
  useEffect(() => {
    if (store.state.focusTab !== 'browser') return;
    void store.refreshBrowserState(store.state.focusData?.sessionKey);
  }, [store.state.focusData?.sessionKey, store.state.focusTab, store.state.lastUpdate]);

  // Refresh markdown tree on poll (when not dirty)
  useEffect(() => {
    if (workspace.state.dirty) return;
    void workspace.refreshTree();
  }, [store.state.lastUpdate, workspace.state.dirty]);

  // Handle pending commit range → diff
  useEffect(() => {
    const { pendingCommitRange, focusData } = store.state;
    if (!pendingCommitRange || !focusData?.sessionKey) return;
    if (pendingCommitRange.sessionKey !== focusData.sessionKey) return;
    void getCockpitDiff({
      sessionKey: focusData.sessionKey,
      ...(pendingCommitRange.base ? { base: pendingCommitRange.base } : {}),
      ...(pendingCommitRange.head ? { head: pendingCommitRange.head } : {}),
    }).then((response) => {
      store.set({
        diffData: response,
        selectedDiffFile: response.hotspots[0]?.path ?? null,
        focusTab: 'diff',
        pendingCommitRange: null,
      });
    }).catch(() => {
      store.set({ pendingCommitRange: null });
    });
  }, [store.state.focusData?.sessionKey, store.state.pendingCommitRange]);

  // Keyboard shortcuts
  useKeyboard(store, workspace);

  return (
    <CockpitContext.Provider value={store}>
      <div className="h-screen flex flex-col overflow-hidden">
        <Header />

        <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)_20rem] gap-0 overflow-hidden">
          {/* Left — File Explorer */}
          <section className="min-h-0 border-r border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden">
            <FileExplorer workspace={workspace} />
          </section>

          {/* Center — Document editor OR Session detail */}
          <section className="min-h-0 bg-[var(--bg-surface)] overflow-hidden flex flex-col">
            <CenterPanel workspace={workspace} />
          </section>

          {/* Right — Session list + commits + PRs */}
          <section className="min-h-0 border-l border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden">
            <RightPanel />
          </section>
        </main>

        <StatusBar />
      </div>
    </CockpitContext.Provider>
  );
}


### function_call
@callId call_e387c41d7e80472dbe0c689f
@name Read
@ts 1770396168286
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/center/CenterPanel.tsx"}

### function_call
@callId call_e08f642e43ef49f79745f6af
@name Read
@ts 1770396168286
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/center/tabs/DiffTab.tsx"}

### function_call
@callId call_5d32f57b0ab046609d203f78
@name Read
@ts 1770396168286
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/center/tabs/TestsTab.tsx"}

### function_call_output
@callId call_e387c41d7e80472dbe0c689f
@ts 1770396168290
@durationMs 3
@workItemId b4d163ca
import { useCockpit } from '@/hooks/use-cockpit-store';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { DocumentEditor } from './DocumentEditor';
import { SessionDetail } from './SessionDetail';

export function CenterPanel({ workspace }: { workspace: MarkdownWorkspace }) {
  const { state } = useCockpit();

  // Center mode is derived:
  // - focusTarget set → session/escalation detail
  // - no focusTarget + selectedPath → document editor
  // - otherwise → empty / document editor
  if (state.focusTarget) {
    return <SessionDetail />;
  }

  return <DocumentEditor workspace={workspace} />;
}


### function_call_output
@callId call_e08f642e43ef49f79745f6af
@ts 1770396168290
@durationMs 1
@workItemId b4d163ca
import { useCockpit } from '@/hooks/use-cockpit-store';
import { getCockpitDiff } from '@/lib/api';

export function DiffTab() {
  const { state, set, handleApplyPatch } = useCockpit();
  const { diffData, selectedDiffFile, patchDraft, patchApplyStatus, applyingPatch, focusData } = state;

  if (!diffData) {
    return <div className="text-xs text-[var(--text-muted)] p-2">No diff range available for this session.</div>;
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="text-[var(--text-muted)]">
        <span className="text-[var(--text-primary)]">{diffData.baseSha.slice(0, 8)}</span>
        {' -> '}
        <span className="text-[var(--text-primary)]">{diffData.headSha.slice(0, 8)}</span>
        {' · '}
        {diffData.summary.filesTouched} files · +{diffData.summary.added} / -{diffData.summary.deleted}
      </div>

      <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
        <div className="px-2 py-1 border-b border-[var(--border-subtle)] text-[var(--text-muted)]">Hotspots</div>
        {diffData.hotspots.length === 0 ? (
          <div className="px-2 py-2 text-[var(--text-muted)]">No changed files in range.</div>
        ) : (
          diffData.hotspots.slice(0, 20).map((hotspot) => (
            <button
              key={hotspot.path}
              onClick={() => {
                set({ selectedDiffFile: hotspot.path });
                if (focusData?.sessionKey) {
                  void getCockpitDiff({
                    sessionKey: focusData.sessionKey,
                    base: diffData.baseSha,
                    head: diffData.headSha,
                    file: hotspot.path,
                  }).then((r) => set({ diffData: r })).catch(() => {});
                }
              }}
              className={`w-full px-2 py-1 text-left border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] ${
                selectedDiffFile === hotspot.path ? 'bg-[var(--accent-cyan)]/10' : ''
              }`}
            >
              <div className="font-mono text-[11px] text-[var(--text-secondary)] truncate">{hotspot.path}</div>
              <div className="text-[10px] text-[var(--text-muted)]">+{hotspot.added} / -{hotspot.deleted}</div>
            </button>
          ))
        )}
      </div>

      {diffData.patch && (
        <pre className="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] overflow-x-auto whitespace-pre-wrap">
          {diffData.patch}
        </pre>
      )}

      <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
        <div className="text-[var(--text-muted)]">Patch Pad (max 3 files / 30 lines)</div>
        <textarea
          value={patchDraft}
          onChange={(e) => set({ patchDraft: e.target.value })}
          placeholder="Paste unified diff here..."
          className="w-full min-h-28 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] font-mono text-[var(--text-secondary)]"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleApplyPatch()}
            disabled={applyingPatch || !patchDraft.trim()}
            className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
          >
            {applyingPatch ? 'Applying...' : 'Apply Patch'}
          </button>
          {patchApplyStatus && <span className="text-[10px] text-[var(--text-muted)]">{patchApplyStatus}</span>}
        </div>
      </div>
    </div>
  );
}


### function_call_output
@callId call_5d32f57b0ab046609d203f78
@ts 1770396168290
@durationMs 0
@workItemId b4d163ca
import { useCockpit } from '@/hooks/use-cockpit-store';
import { formatRelativeFromIso } from '@/lib/format';

export function TestsTab() {
  const { state, handleSelectTestReport } = useCockpit();
  const { testReports, selectedTestReportId, selectedTestReport } = state;

  if (testReports.length === 0) {
    return <div className="text-xs text-[var(--text-muted)] p-2">No test reports available.</div>;
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-1 xl:grid-cols-[16rem_minmax(0,1fr)] gap-3">
        <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
          {testReports.map((report) => (
            <button
              key={report.id}
              onClick={() => void handleSelectTestReport(report.id)}
              className={`w-full px-2 py-1 text-left border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] ${
                selectedTestReportId === report.id ? 'bg-[var(--success)]/10' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-[var(--text-secondary)]">{report.id.slice(0, 8)}</span>
                <span className="uppercase text-[10px] text-[var(--text-muted)]">{report.verdict}</span>
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">{formatRelativeFromIso(report.createdAt)}</div>
            </button>
          ))}
        </div>
        <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
          {selectedTestReport ? (
            <>
              <div className="text-[var(--text-primary)] font-medium">
                {selectedTestReport.command || 'Test Report'}
              </div>
              <div className="text-[var(--text-muted)]">
                Verdict {selectedTestReport.verdict} · Duration {selectedTestReport.durationMs}ms
              </div>
              <div className="space-y-1">
                {selectedTestReport.categories.map((cat, idx) => (
                  <div key={idx} className="text-[var(--text-secondary)]">
                    {String(cat.category ?? cat.name ?? 'category')}: {String(cat.verdict ?? 'unknown')}
                  </div>
                ))}
              </div>
              {selectedTestReport.agentNote && (
                <p className="text-[var(--text-secondary)] whitespace-pre-wrap">{selectedTestReport.agentNote}</p>
              )}
            </>
          ) : (
            <div className="text-[var(--text-muted)]">Select a report</div>
          )}
        </div>
      </div>
    </div>
  );
}


### function_call
@callId call_7113ec402b884e0ebeabe34f
@name Read
@ts 1770396219693
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/components/center/SessionDetail.tsx"}

### function_call_output
@callId call_7113ec402b884e0ebeabe34f
@ts 1770396219695
@durationMs 1
@workItemId b4d163ca
import { useMemo } from 'react';
import { useCockpit, selectToolSignal, selectRecentAssistantMessage, selectFocusRollup, selectFocusStatus, selectFocusEscalationId, type FocusTab } from '@/hooks/use-cockpit-store';
import { DiffstatLine } from '@/components/shared/DiffstatLine';
import { PacketTab } from './tabs/PacketTab';
import { DiffTab } from './tabs/DiffTab';
import { TestsTab } from './tabs/TestsTab';
import { TraceTab } from './tabs/TraceTab';
import { LensTab } from './tabs/LensTab';
import { BrowserTab } from './tabs/BrowserTab';
import { EventDrawer } from './EventDrawer';
import { MessageInput } from './MessageInput';

const TABS: { key: FocusTab; label: string; shortcut: string }[] = [
  { key: 'packet', label: 'Packet', shortcut: 'X' },
  { key: 'diff', label: 'Diff', shortcut: 'D' },
  { key: 'tests', label: 'Tests', shortcut: 'T' },
  { key: 'trace', label: 'Trace', shortcut: 'L' },
  { key: 'lens', label: 'Lens', shortcut: 'Q' },
  { key: 'browser', label: 'Browser', shortcut: 'B' },
];

function TabContent({ tab }: { tab: FocusTab }) {
  switch (tab) {
    case 'packet': return <PacketTab />;
    case 'diff': return <DiffTab />;
    case 'tests': return <TestsTab />;
    case 'trace': return <TraceTab />;
    case 'lens': return <LensTab />;
    case 'browser': return <BrowserTab />;
  }
}

export function SessionDetail() {
  const { state, set, handleReviewDecision, handleResolveEscalation } = useCockpit();
  const { focusData, focusTab, reviewDecisionAction, resolvingEscalationId, diffData } = state;

  const toolSignal = useMemo(() => selectToolSignal(state), [state.events]);
  const recentMessage = useMemo(() => selectRecentAssistantMessage(state), [state.events]);
  const focusRollup = useMemo(() => selectFocusRollup(state), [state.focusData?.sessionKey, state.runningSessions, state.readySessions, state.doneSessions]);
  const focusStatus = selectFocusStatus(state);
  const escalationId = selectFocusEscalationId(state);

  const diffSummary = diffData?.summary ?? focusRollup?.diffstat ?? null;

  if (!focusData) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">
        Select a session or escalation
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Session header */}
      <div className="px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--text-primary)] font-medium truncate">
            {typeof focusData.header?.title === 'string' ? focusData.header.title : 'Session'}
          </span>
          {focusData.type === 'escalation' && (
            <span className="text-[11px] uppercase text-[var(--warning)]">Escalation</span>
          )}
        </div>

        <div className="text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-2">
          <span className="font-mono">{focusData.sessionKey}</span>
          {toolSignal ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--accent-cyan)]/15 text-[var(--accent-cyan)] text-[10px]">
              <span aria-hidden>{toolSignal.icon}</span>
              <span>{toolSignal.label}</span>
              <span className="text-[var(--text-muted)]">{toolSignal.detail}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] text-[10px]">Idle</span>
          )}
        </div>

        {diffSummary && (
          <div className="mt-0.5">
            <DiffstatLine added={diffSummary.added} deleted={diffSummary.deleted} files={diffSummary.filesTouched} />
          </div>
        )}

        {recentMessage && (
          <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 truncate">
            Latest: {recentMessage}
          </div>
        )}

        {/* Review actions */}
        {focusStatus === 'ready' && (
          <div className="mt-1 flex items-center gap-1">
            <button
              onClick={() => void handleReviewDecision('accept')}
              disabled={reviewDecisionAction !== null}
              className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
            >{reviewDecisionAction === 'accept' ? 'Accepting...' : 'Accept'}</button>
            <button
              onClick={() => void handleReviewDecision('request_changes')}
              disabled={reviewDecisionAction !== null}
              className="px-2 py-0.5 text-[11px] rounded bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 disabled:opacity-60"
            >{reviewDecisionAction === 'request_changes' ? 'Sending...' : 'Request Changes'}</button>
          </div>
        )}

        {escalationId && (
          <div className="mt-1">
            <button
              onClick={() => void handleResolveEscalation(escalationId)}
              disabled={resolvingEscalationId === escalationId}
              className="px-2 py-0.5 text-xs rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
            >{resolvingEscalationId === escalationId ? 'Resolving...' : 'Resolve Escalation'}</button>
          </div>
        )}

        {/* Tab bar */}
        <div className="mt-2 flex items-center gap-1 text-[11px]">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => set({ focusTab: tab.key })}
              className={`px-1.5 py-0.5 rounded ${
                focusTab === tab.key
                  ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {tab.label} ({tab.shortcut})
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <TabContent tab={focusTab} />
      </div>

      {/* Event drawer */}
      <EventDrawer />

      {/* Message input */}
      <MessageInput />
    </div>
  );
}


### function_call
@callId call_ca34a4f8fa9b46c89d4bcc16
@name Write
@ts 1770396457172
@workItemId b4d163ca
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api-cache.ts","content":"/**\n * API Cache Layer\n *\n * Provides:\n * 1. Request deduplication - simultaneous requests for same resource share the same promise\n * 2. In-memory caching with TTL - cache API responses\n * 3. Prefetch support - background warmup of cached data\n * 4. Cache invalidation - selective or bulk invalidation\n */\n\n// ============================================================================\n// Types\n// ============================================================================\n\ntype CacheEntry<T> = {\n  data: T;\n  fetchedAt: number;\n  expiresAt: number;\n};\n\ntype PendingRequest<T> = {\n  promise: Promise<T>;\n  fetchedAt: number;\n};\n\ntype CacheConfig = {\n  defaultTtlMs: number;\n  maxEntries: number;\n};\n\ntype CacheKey = string;\n\n// ============================================================================\n// Defaults\n// ============================================================================\n\nconst DEFAULT_CONFIG: CacheConfig = {\n  defaultTtlMs: 30_000, // 30 seconds\n  maxEntries: 1000,\n};\n\n// ============================================================================\n// Cache Class\n// ============================================================================\n\nclass APICache {\n  private cache = new Map<CacheKey, CacheEntry<unknown>>();\n  private pending = new Map<CacheKey, PendingRequest<unknown>>();\n  private config: CacheConfig;\n\n  constructor(config: Partial<CacheConfig> = {}) {\n    this.config = { ...DEFAULT_CONFIG, ...config };\n  }\n\n  /**\n   * Get data from cache if fresh, otherwise fetch via fetchFn\n   * Also handles request deduplication\n   */\n  async get<T>(\n    key: CacheKey,\n    fetchFn: () => Promise<T>,\n    options?: {\n      ttlMs?: number;\n      forceRefresh?: boolean;\n      skipCache?: boolean;\n    }\n  ): Promise<T> {\n    const { ttlMs = this.config.defaultTtlMs, forceRefresh, skipCache } = options ?? {};\n\n    // Skip cache if requested\n    if (skipCache) {\n      return fetchFn();\n    }\n\n    // Return cached data if fresh\n    if (!forceRefresh) {\n      const cached = this.cache.get(key);\n      if (cached && cached.expiresAt > Date.now()) {\n        return cached.data as T;\n      }\n    }\n\n    // Check for in-flight request (deduplication)\n    const pending = this.pending.get(key);\n    if (pending && pending.fetchedAt > Date.now() - 10_000) {\n      return pending.promise as Promise<T>;\n    }\n\n    // Create new request\n    const promise = fetchFn()\n      .then((data) => {\n        // Cache the result\n        this.set(key, data, ttlMs);\n        // Remove from pending\n        this.pending.delete(key);\n        return data;\n      })\n      .catch((err) => {\n        // Remove from pending on error\n        this.pending.delete(key);\n        throw err;\n      });\n\n    this.pending.set(key, { promise, fetchedAt: Date.now() });\n    return promise;\n  }\n\n  /**\n   * Set data in cache with TTL\n   */\n  set<T>(key: CacheKey, data: T, ttlMs = this.config.defaultTtlMs): void {\n    const now = Date.now();\n    const entry: CacheEntry<T> = {\n      data,\n      fetchedAt: now,\n      expiresAt: now + ttlMs,\n    };\n    this.cache.set(key, entry);\n\n    // Prune if over limit\n    this.prune();\n  }\n\n  /**\n   * Invalidate specific cache key\n   */\n  invalidate(key: CacheKey): void {\n    this.cache.delete(key);\n  }\n\n  /**\n   * Invalidate all cache entries matching a pattern\n   */\n  invalidatePattern(pattern: RegExp): void {\n    const keys = Array.from(this.cache.keys());\n    for (const key of keys) {\n      if (pattern.test(key)) {\n        this.cache.delete(key);\n      }\n    }\n  }\n\n  /**\n   * Invalidate all cache entries\n   */\n  invalidateAll(): void {\n    this.cache.clear();\n  }\n\n  /**\n   * Prefetch data in background\n   */\n  async prefetch<T>(\n    key: CacheKey,\n    fetchFn: () => Promise<T>,\n    ttlMs?: number\n  ): Promise<void> {\n    // Only prefetch if not already cached or expired\n    const cached = this.cache.get(key);\n    if (cached && cached.expiresAt > Date.now()) {\n      return;\n    }\n    // Background fetch, ignore errors\n    void this.get(key, fetchFn, { ttlMs }).catch(() => {});\n  }\n\n  /**\n   * Get cached data without fetching (null if not cached or expired)\n   */\n  getCached<T>(key: CacheKey): T | null {\n    const cached = this.cache.get(key);\n    if (!cached || cached.expiresAt <= Date.now()) {\n      return null;\n    }\n    return cached.data as T;\n  }\n\n  /**\n   * Check if data is cached and fresh\n   */\n  isFresh(key: CacheKey): boolean {\n    const cached = this.cache.get(key);\n    return !!cached && cached.expiresAt > Date.now();\n  }\n\n  /**\n   * Get cache stats\n   */\n  getStats() {\n    return {\n      size: this.cache.size,\n      pending: this.pending.size,\n      entries: Array.from(this.cache.entries()).map(([key, entry]) => ({\n        key,\n        age: Date.now() - entry.fetchedAt,\n        ttl: entry.expiresAt - Date.now(),\n      })),\n    };\n  }\n\n  /**\n   * Prune expired entries and enforce max size\n   */\n  private prune(): void {\n    const now = Date.now();\n\n    // Remove expired entries\n    for (const [key, entry] of this.cache.entries()) {\n      if (entry.expiresAt <= now) {\n        this.cache.delete(key);\n      }\n    }\n\n    // Enforce max size (LRU - remove oldest)\n    if (this.cache.size > this.config.maxEntries) {\n      const entries = Array.from(this.cache.entries())\n        .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);\n\n      const toRemove = entries.slice(0, entries.length - this.config.maxEntries);\n      for (const [key] of toRemove) {\n        this.cache.delete(key);\n      }\n    }\n  }\n}\n\n// ============================================================================\n// Singleton instance\n// ============================================================================\n\nexport const apiCache = new APICache();\n\n// ============================================================================\n// Cache key builders\n// ============================================================================\n\nexport const cacheKeys = {\n  // Rollups\n  sessionRollups: (status: string) => `rollups:session:${status}`,\n  escalationRollups: () => `rollups:escalations`,\n  commitRollups: () => `rollups:commits`,\n  prRollups: (status: string) => `rollups:prs:${status}`,\n  dailyMetrics: (date?: string) => `metrics:daily:${date ?? 'today'}`,\n\n  // Focus\n  focus: (type: 'session' | 'escalation', id: string, packetId?: string) =>\n    `focus:${type}:${id}${packetId ? `:${packetId}` : ''}`,\n\n  // Session data\n  sessionEvents: (sessionKey: string, cursor?: number, limit = 200) =>\n    `session:${sessionKey}:events:${cursor ?? 'start'}:${limit}`,\n  sessionPackets: (sessionKey: string, limit = 20) =>\n    `session:${sessionKey}:packets:${limit}`,\n  sessionTraces: (sessionKey: string, workItemId?: string, limit = 120) =>\n    `session:${sessionKey}:traces:${workItemId ?? 'all'}:${limit}`,\n  sessionTests: (sessionKey: string, workItemId?: string, limit = 20) =>\n    `session:${sessionKey}:tests:${workItemId ?? 'all'}:${limit}`,\n  sessionDiff: (sessionKey: string, base?: string, head?: string, file?: string) =>\n    `session:${sessionKey}:diff:${base ?? 'default'}:${head ?? 'default'}:${file ?? 'all'}`,\n  sessionBrowserState: (sessionKey: string) =>\n    `session:${sessionKey}:browser:state`,\n\n  // Test reports\n  testReport: (reportId: string) => `test:${reportId}`,\n\n  // Repo lens\n  repoLens: (sessionKey: string | undefined, q: string, kind: string, limit = 120) =>\n    `lens:${sessionKey ?? 'global'}:${kind}:${q}:${limit}`,\n\n  // Markdown\n  markdownTree: () => `markdown:tree`,\n  markdownFile: (path: string) => `markdown:file:${path}`,\n};\n\n// ============================================================================\n// Prefetch helpers\n// ============================================================================\n\nexport function prefetchSessionData(sessionKey: string): void {\n  // Prefetch commonly accessed data in background\n  void apiCache.prefetch(cacheKeys.sessionEvents(sessionKey), () =>\n    import('./api').then(m => m.getCockpitSessionEvents(sessionKey, { limit: 200 })),\n    30_000\n  );\n  void apiCache.prefetch(cacheKeys.sessionTraces(sessionKey), () =>\n    import('./api').then(m => m.getCockpitTraces(sessionKey, { limit: 120 })),\n    30_000\n  );\n  void apiCache.prefetch(cacheKeys.sessionTests(sessionKey), () =>\n    import('./api').then(m => m.getCockpitTestReports({ sessionKey, limit: 20 })),\n    30_000\n  );\n  void apiCache.prefetch(cacheKeys.sessionDiff(sessionKey), () =>\n    import('./api').then(m => m.getCockpitDiff({ sessionKey })),\n    30_000\n  );\n}\n\nexport function invalidateSessionData(sessionKey: string): void {\n  apiCache.invalidatePattern(new RegExp(`^session:${sessionKey}:`));\n  // Also invalidate any focus entries for this session\n  apiCache.invalidatePattern(new RegExp(`^focus:session:${sessionKey}(:|$)`));\n}\n\nexport function invalidateRollups(): void {\n  apiCache.invalidatePattern(/^rollups:/);\n  apiCache.invalidatePattern(/^metrics:/);\n}\n"}

### function_call_output
@callId call_ca34a4f8fa9b46c89d4bcc16
@ts 1770396517192
@isError true
@durationMs 0
@workItemId b4d163ca
Permission request timed out

### function_call
@callId call_146f1ddd2b904687b8cba031
@name Bash
@ts 1770396547203
@workItemId b4d163ca
{"command":"ls -la /Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/"}

### function_call_output
@callId call_146f1ddd2b904687b8cba031
@ts 1770396607394
@isError true
@durationMs 0
@workItemId b4d163ca
Permission request timed out

### message:user
@ts 1770396793323
Implement phase 1 and 2

### function_call
@callId call_b1b898f6a5b249aa9bf444da
@name Write
@ts 1770396850415
@workItemId 58d01cd4
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api-cache.ts","content":"/**\n * API Cache Layer\n *\n * Provides:\n * 1. Request deduplication - simultaneous requests for same resource share the same promise\n * 2. In-memory caching with TTL - cache API responses\n * 3. Prefetch support - background warmup of cached data\n * 4. Cache invalidation - selective or bulk invalidation\n */\n\ntype CacheEntry<T> = {\n  data: T;\n  fetchedAt: number;\n  expiresAt: number;\n};\n\ntype PendingRequest<T> = {\n  promise: Promise<T>;\n  fetchedAt: number;\n};\n\ntype CacheConfig = {\n  defaultTtlMs: number;\n  maxEntries: number;\n};\n\ntype CacheKey = string;\n\nconst DEFAULT_CONFIG: CacheConfig = {\n  defaultTtlMs: 30_000,\n  maxEntries: 1000,\n};\n\nclass APICache {\n  private cache = new Map<CacheKey, CacheEntry<unknown>>();\n  private pending = new Map<CacheKey, PendingRequest<unknown>>();\n  private config: CacheConfig;\n\n  constructor(config: Partial<CacheConfig> = {}) {\n    this.config = { ...DEFAULT_CONFIG, ...config };\n  }\n\n  async get<T>(\n    key: CacheKey,\n    fetchFn: () => Promise<T>,\n    options?: {\n      ttlMs?: number;\n      forceRefresh?: boolean;\n      skipCache?: boolean;\n    }\n  ): Promise<T> {\n    const { ttlMs = this.config.defaultTtlMs, forceRefresh, skipCache } = options ?? {};\n\n    if (skipCache) {\n      return fetchFn();\n    }\n\n    if (!forceRefresh) {\n      const cached = this.cache.get(key);\n      if (cached && cached.expiresAt > Date.now()) {\n        return cached.data as T;\n      }\n    }\n\n    const pending = this.pending.get(key);\n    if (pending && pending.fetchedAt > Date.now() - 10_000) {\n      return pending.promise as Promise<T>;\n    }\n\n    const promise = fetchFn()\n      .then((data) => {\n        this.set(key, data, ttlMs);\n        this.pending.delete(key);\n        return data;\n      })\n      .catch((err) => {\n        this.pending.delete(key);\n        throw err;\n      });\n\n    this.pending.set(key, { promise, fetchedAt: Date.now() });\n    return promise;\n  }\n\n  set<T>(key: CacheKey, data: T, ttlMs = this.config.defaultTtlMs): void {\n    const now = Date.now();\n    const entry: CacheEntry<T> = {\n      data,\n      fetchedAt: now,\n      expiresAt: now + ttlMs,\n    };\n    this.cache.set(key, entry);\n    this.prune();\n  }\n\n  invalidate(key: CacheKey): void {\n    this.cache.delete(key);\n  }\n\n  invalidatePattern(pattern: RegExp): void {\n    const keys = Array.from(this.cache.keys());\n    for (const key of keys) {\n      if (pattern.test(key)) {\n        this.cache.delete(key);\n      }\n    }\n  }\n\n  invalidateAll(): void {\n    this.cache.clear();\n  }\n\n  async prefetch<T>(\n    key: CacheKey,\n    fetchFn: () => Promise<T>,\n    ttlMs?: number\n  ): Promise<void> {\n    const cached = this.cache.get(key);\n    if (cached && cached.expiresAt > Date.now()) {\n      return;\n    }\n    void this.get(key, fetchFn, { ttlMs }).catch(() => {});\n  }\n\n  getCached<T>(key: CacheKey): T | null {\n    const cached = this.cache.get(key);\n    if (!cached || cached.expiresAt <= Date.now()) {\n      return null;\n    }\n    return cached.data as T;\n  }\n\n  isFresh(key: CacheKey): boolean {\n    const cached = this.cache.get(key);\n    return !!cached && cached.expiresAt > Date.now();\n  }\n\n  getStats() {\n    return {\n      size: this.cache.size,\n      pending: this.pending.size,\n      entries: Array.from(this.cache.entries()).map(([key, entry]) => ({\n        key,\n        age: Date.now() - entry.fetchedAt,\n        ttl: entry.expiresAt - Date.now(),\n      })),\n    };\n  }\n\n  private prune(): void {\n    const now = Date.now();\n\n    for (const [key, entry] of this.cache.entries()) {\n      if (entry.expiresAt <= now) {\n        this.cache.delete(key);\n      }\n    }\n\n    if (this.cache.size > this.config.maxEntries) {\n      const entries = Array.from(this.cache.entries())\n        .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);\n\n      const toRemove = entries.slice(0, entries.length - this.config.maxEntries);\n      for (const [key] of toRemove) {\n        this.cache.delete(key);\n      }\n    }\n  }\n}\n\nexport const apiCache = new APICache();\n\nexport const cacheKeys = {\n  sessionRollups: (status: string) => `rollups:session:${status}`,\n  escalationRollups: () => `rollups:escalations`,\n  commitRollups: () => `rollups:commits`,\n  prRollups: (status: string) => `rollups:prs:${status}`,\n  dailyMetrics: (date?: string) => `metrics:daily:${date ?? 'today'}`,\n\n  focus: (type: 'session' | 'escalation', id: string, packetId?: string) =>\n    `focus:${type}:${id}${packetId ? `:${packetId}` : ''}`,\n\n  sessionEvents: (sessionKey: string, cursor?: number, limit = 200) =>\n    `session:${sessionKey}:events:${cursor ?? 'start'}:${limit}`,\n  sessionPackets: (sessionKey: string, limit = 20) =>\n    `session:${sessionKey}:packets:${limit}`,\n  sessionTraces: (sessionKey: string, workItemId?: string, limit = 120) =>\n    `session:${sessionKey}:traces:${workItemId ?? 'all'}:${limit}`,\n  sessionTests: (sessionKey: string, workItemId?: string, limit = 20) =>\n    `session:${sessionKey}:tests:${workItemId ?? 'all'}:${limit}`,\n  sessionDiff: (sessionKey: string, base?: string, head?: string, file?: string) =>\n    `session:${sessionKey}:diff:${base ?? 'default'}:${head ?? 'default'}:${file ?? 'all'}`,\n  sessionBrowserState: (sessionKey: string) =>\n    `session:${sessionKey}:browser:state`,\n\n  testReport: (reportId: string) => `test:${reportId}`,\n\n  repoLens: (sessionKey: string | undefined, q: string, kind: string, limit = 120) =>\n    `lens:${sessionKey ?? 'global'}:${kind}:${q}:${limit}`,\n\n  markdownTree: () => `markdown:tree`,\n  markdownFile: (path: string) => `markdown:file:${path}`,\n};\n\nexport function prefetchSessionData(sessionKey: string): void {\n  void apiCache.prefetch(cacheKeys.sessionEvents(sessionKey), () =>\n    import('./api').then(m => m.getCockpitSessionEvents(sessionKey, { limit: 200 })),\n    30_000\n  );\n  void apiCache.prefetch(cacheKeys.sessionTraces(sessionKey), () =>\n    import('./api').then(m => m.getCockpitTraces(sessionKey, { limit: 120 })),\n    30_000\n  );\n  void apiCache.prefetch(cacheKeys.sessionTests(sessionKey), () =>\n    import('./api').then(m => m.getCockpitTestReports({ sessionKey, limit: 20 })),\n    30_000\n  );\n  void apiCache.prefetch(cacheKeys.sessionDiff(sessionKey), () =>\n    import('./api').then(m => m.getCockpitDiff({ sessionKey })),\n    30_000\n  );\n}\n\nexport function invalidateSessionData(sessionKey: string): void {\n  apiCache.invalidatePattern(new RegExp(`^session:${sessionKey}:`));\n  apiCache.invalidatePattern(new RegExp(`^focus:session:${sessionKey}(:|$)`));\n}\n\nexport function invalidateRollups(): void {\n  apiCache.invalidatePattern(/^rollups:/);\n  apiCache.invalidatePattern(/^metrics:/);\n}\n"}

### function_call_output
@callId call_b1b898f6a5b249aa9bf444da
@ts 1770396910417
@isError true
@durationMs 0
@workItemId 58d01cd4
Permission request timed out

### function_call
@callId call_f22f466877974b7d91647c4e
@name coding
@ts 1770396924872
@workItemId 58d01cd4
{"objective":"Implement phase 1 and 2 of data layer optimization:\n\n**Phase 1: Request Deduplication and Caching**\n1. Create `/packages/dashboard-control/src/lib/api-cache.ts` with:\n   - APICache class supporting in-memory caching with TTL, request deduplication, and cache invalidation\n   - Cache key builders for rollups, focus, session data (events, traces, tests, diff, browser), test reports, repo lens, and markdown\n   - Prefetch helpers: `prefetchSessionData(sessionKey)`, `invalidateSessionData(sessionKey)`, `invalidateRollups()`\n   - Singleton `apiCache` instance with default 30s TTL and max 1000 entries\n\n2. Modify `/packages/dashboard-control/src/hooks/use-cockpit-store.ts`:\n   - Import the cache system\n   - Wrap all API calls with `apiCache.get()` using appropriate cache keys\n   - Update `refreshRollups()` to use cached rollups with 15s TTL\n   - Update `refreshFocus()` to use cached focus/events/traces/tests/diff with 30s TTL\n   - Update `refreshBrowserState()` to use cached browser state with 5s TTL\n   - Update `handleRunLensSearch()` to use cached lens results with 60s TTL\n   - Update `handleSelectTestReport()` to use cached test reports\n   - Cache diff data when selecting hotspots\n   - Add `invalidateSessionData(sessionKey)` when sending messages to session\n\n**Phase 2: Tab Data Prefetching**\n3. Create `/packages/dashboard-control/src/hooks/use-tab-prefetch.ts` with:\n   - Hook that monitors `focusTab` changes\n   - Prefetches data for tabs before they're displayed:\n     - 'diff' tab: prefetch diff data\n     - 'tests' tab: prefetch test reports\n     - 'trace' tab: prefetch traces\n     - 'browser' tab: prefetch browser state\n   - Debounces prefetch requests to avoid excessive calls\n\n4. Modify `/packages/dashboard-control/src/App.tsx`:\n   - Import and use `useTabPrefetch` hook\n   - Pass necessary props to the hook (store, focusData)\n\nThe goal is to make tab switching instantaneous by having data pre-cached and deduplicating simultaneous API requests.","delta":"Implementing data layer caching and tab prefetching to optimize fast tab switching","targetPaths":["/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/lib/api-cache.ts","/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/hooks/use-cockpit-store.ts","/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/hooks/use-tab-prefetch.ts","/Users/jevinnishioka/Desktop/jesus/packages/dashboard-control/src/App.tsx"]}

### function_call_output
@callId call_f22f466877974b7d91647c4e
@ts 1770397935350
@isError true
@durationMs 1010467
@workItemId 58d01cd4
Sub-agent 'coding' failed (reason: no_action): Response is planning text, not actual work: "Let me check what's happening with the file system:..."
Tools called: 18 (5 succeeded, 13 failed)
Tool errors: Write: Permission request timed out; Bash: Permission request timed out; Bash: Permission request timed out...
Partial output:
Let me check what's happening with the file system:

### message:assistant
@ts 1770397935355
Exploration incomplete. Tools called: Write, coding. 0 successful results obtained but not synthesized.
