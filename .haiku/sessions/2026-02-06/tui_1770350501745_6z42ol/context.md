---
session: tui_1770350501745_6z42ol
created: 2026-02-06T04:01:41.745Z
maxTokens: 200000
fileContentCounter: 0
artifactCounter: 0
---

### message:user
@ts 1770350563264
## Goal

write test cases for the @packages/harness-daemon/src/harness/control_plane_routes.ts

## Context Files

- **Salience**: /Users/jevinnishioka/Desktop/jesus/.watcher/2026-02-06/tui_1770350501745_6z42ol/salience.md — session goal and principles
- **Decision log**: /Users/jevinnishioka/Desktop/jesus/.watcher/2026-02-06/tui_1770350501745_6z42ol/decisions.jsonl — prior decisions this session
- **Work log**: /Users/jevinnishioka/Desktop/jesus/.watcher/2026-02-06/tui_1770350501745_6z42ol/work-log.jsonl — session activity

## Your Task

1. **Read the salience file** for goal context and operating principles.
2. **Explore minimally** — use Glob/Grep/Read to understand what needs to change.
3. **Ask questions** — use PromptUser if the goal is ambiguous. The watcher answers.
4. **Produce a plan** — output your handoffSpec when ready.

## handoffSpec Format

Your handoffSpec MUST be a valid JSON object and include:
- `goal` (string)
- `context` (string)
- `workItems` (array), each item with:
  - `id` (string)
  - `objective` (string, include file paths)
  - `delta` (string; one commit)
  - `agent` (string)
  - `domain` (string, optional)
  - `dependencies` (string[], optional)
  - `targetPaths` (string[], optional)

## Principles

- **Atomic**: Each work item = one commit
- **Parallel**: Independent items run concurrently (minimize dependencies)
- **Specific**: Include file paths in objectives
- **Bounded**: Max 5-7 work items. If bigger, split the goal first.

When ready: set `goalStateReached: true`, `action: "handoff"`, and include `handoffSpec`.

### function_call
@callId call_146b3c1fdd544523b31065a6
@name Read
@ts 1770350568391
@workItemId 00ebbe00
{"path":"/Users/jevinnishioka/Desktop/jesus/.watcher/2026-02-06/tui_1770350501745_6z42ol/salience.md"}

### function_call
@callId call_763e6635649149429c6f6ad9
@name Read
@ts 1770350568391
@workItemId 00ebbe00
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_146b3c1fdd544523b31065a6
@ts 1770350568396
@durationMs 2
@workItemId 00ebbe00
# Watcher Salience — tui_1770350501745_6z42ol

**Goal**: write test cases for the @packages/harness-daemon/src/harness/control_plane_routes.ts
**Mode**: async
**Created**: 2026-02-06T04:02:42.880Z

## Operating Principles

1. Surface ambiguity aggressively — implicit boundaries and shared ownership are questions, not silent choices.
2. Establish invariants — record what decisions imply. Make boundaries and contracts explicit.
3. Separation of concerns is non-negotiable — detect and address concern-mixing.
4. Evidence-first oversight — never allow without concrete evidence. If evidence is missing, report it and intervene.
5. Accountability — the watcher is responsible for goal completion and system integrity. Create infra-fix work when the system fails you.
6. One work item = one git commit. Keep units of work atomic and reviewable.

## Session Notes

_No notes yet. The watcher will append observations here._


### function_call_output
@callId call_763e6635649149429c6f6ad9
@ts 1770350568396
@durationMs 2
@workItemId 00ebbe00
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
    message: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
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

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
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
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
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

function parsePackets(value: unknown): FocusPacket[] {
  // Packets are harness-emitted markdown artifacts used by the frontend focus view.
  if (!Array.isArray(value)) return [];
  const packets: FocusPacket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const packetId = asString(entry.packetId) ?? asString(entry.id);
    const sessionKey = asString(entry.sessionKey);
    const typeRaw = asString(entry.type);
    const markdown = asString(entry.contentMarkdown) ?? asString(entry.markdown);
    const createdMs = parseTimestampMs(entry.createdAt ?? entry.created_at ?? entry.timestamp);
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
      workItemId: asString(entry.workItemId),
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
      ?? asNumber(metadata.invariantsTotal ?? m
... [truncated 50040 chars]

### function_call
@callId call_f143807e9c3f495e9de044b5
@name Read
@ts 1770350573860
@workItemId 00ebbe00
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":500,"endLine":-1}

### function_call_output
@callId call_f143807e9c3f495e9de044b5
@ts 1770350573861
@durationMs 0
@workItemId 00ebbe00
// Lines 500--1 of 3108 total
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

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
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
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
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

function parsePackets(value: unknown): FocusPacket[] {
  // Packets are harness-emitted markdown artifacts used by the frontend focus view.
  if (!Array.isArray(value)) return [];
  const packets: FocusPacket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const packetId = asString(entry.packetId) ?? asString(entry.id);
    const sessionKey = asString(entry.sessionKey);
    const typeRaw = asString(entry.type);
    const markdown = asString(entry.contentMarkdown) ?? asString(entry.markdown);
    const createdMs = parseTimestampMs(entry.createdAt ?? entry.created_at ?? entry.timestamp);
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
      workItemId: asString(entry.workItemId),
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
  if (type === 'tool_call') return 'tool';
  if (type === 'git_commit') return 'trace';
  if (type.includes('test')) return 'test';
  if (type.includes('packet')) return 'packet';
  return 'workflow';
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
    normalized.push({
      ts,
      event: {
        at: new Date(ts).toISOString(),
        type: 'message',
        payload: {
          id: message.id,
          role: message.role,
          content: message.content,
          requestId: message.requestId,
          metadata: message.metadata ?? {},
        },
      },
    });
  }

  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata?.agent_events : [];
  for (const entry of agentEvents) {
    if (!isRecord(entry)) continue;
    const type = asString(entry.type);
    const ts = parseTimestampMs(entry.timestamp);
    if (!type || !ts) continue;
    normalized.push({
      ts,
      event: {
        at: new Date(ts).toISOString(),
        type: normalizeAgentEventType(type),
        payload: {
          eventType: type,
          requestId: asString(entry.request_id),
          workItemId: asString(entry.work_item_id),
          data: isRecord(entry.data) ? entry.data : {},
        },
      },
    });
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

  // GET /control-plane/cockpit/repo/lens?q=...&kind=all|defs|refs|text&sessionKey=...
  if (pathname === '/control-plane/cockpit/repo/lens' && req.method === 'GET') {
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

  // GET /control-plane/cockpit/session/:sessionKey/events?cursor=...&limit=...
  params = matchRoute('/cont
... [truncated 36883 chars]

### function_call
@callId call_da079343ad694241abfcbe17
@name Glob
@ts 1770350578017
@workItemId 00ebbe00
{"pattern":"packages/harness-daemon/src/harness/*.test.ts"}

### function_call
@callId call_657198daf89d4c9194b1b7ae
@name Glob
@ts 1770350578017
@workItemId 00ebbe00
{"pattern":"packages/harness-daemon/src/harness/*.spec.ts"}

### function_call
@callId call_bb49d08200a54dc69f13541e
@name Glob
@ts 1770350578017
@workItemId 00ebbe00
{"pattern":"packages/harness-daemon/src/**/*.test.ts"}

### function_call_output
@callId call_da079343ad694241abfcbe17
@ts 1770350578233
@durationMs 215
@workItemId 00ebbe00
packages/harness-daemon/src/harness/bridge_gateway.test.ts
packages/harness-daemon/src/harness/cockpit_invariants.test.ts
packages/harness-daemon/src/harness/escalation_state.test.ts
packages/harness-daemon/src/harness/harness.watcher.test.ts
packages/harness-daemon/src/harness/session_store.test.ts

### function_call_output
@callId call_657198daf89d4c9194b1b7ae
@ts 1770350578233
@durationMs 211
@workItemId 00ebbe00
No files found matching pattern: packages/harness-daemon/src/harness/*.spec.ts (try ../pattern or ../../pattern for sibling directories)

### function_call_output
@callId call_bb49d08200a54dc69f13541e
@ts 1770350578234
@durationMs 211
@workItemId 00ebbe00
packages/harness-daemon/src/harness/bridge_gateway.test.ts
packages/harness-daemon/src/harness/cockpit_invariants.test.ts
packages/harness-daemon/src/harness/escalation_state.test.ts
packages/harness-daemon/src/harness/harness.watcher.test.ts
packages/harness-daemon/src/harness/session_store.test.ts

### function_call
@callId call_9246df49b8684a28ae19dffb
@name Read
@ts 1770350588252
@workItemId 00ebbe00
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/session_store.test.ts"}

### function_call_output
@callId call_9246df49b8684a28ae19dffb
@ts 1770350588264
@durationMs 4
@workItemId 00ebbe00
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import type { GraphDManager } from 'graphd';
import { ContextWindow } from 'context';
import type { ContextWindowSnapshot, MessageItem, FunctionCallOutputItem, FileContentItem } from 'types';
import { SessionStore, type HarnessLogger } from './session_store.js';

const logger: HarnessLogger = {
  info: () => {},
  debug: () => {},
  warning: () => {},
  error: () => {},
};

const DISK_TEST_DIR = path.join(import.meta.dir, '__session_test_tmp__');

describe('SessionStore paused_work_items', () => {
  it('upserts and resolves paused work items idempotently', () => {
    const store = new SessionStore({
      sessionKey: 'session_test',
      maxTokens: 1000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: process.cwd(),
    });

    store.upsertPausedWorkItem({
      workId: 'work_1',
      agentType: 'standard',
      objective: 'Implement feature',
      reason: 'Needs escalation',
      escalationId: 'esc_1',
      timestamp: 100,
    });

    store.upsertPausedWorkItem({
      workId: 'work_1',
      agentType: 'standard',
      reason: 'Still waiting on escalation',
      escalationId: 'esc_1',
      timestamp: 200,
    });

    const [paused] = store.listPausedWorkItems();
    expect(paused.workId).toBe('work_1');
    expect(paused.status).toBe('pending');
    expect(paused.createdAt).toBe(100);
    expect(paused.updatedAt).toBe(200);
    expect(paused.reason).toContain('Still waiting');

    const resolved = store.resolvePausedWorkItem('work_1', 'Resolved by user', 300);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedAt).toBe(300);

    const idempotent = store.resolvePausedWorkItem('work_1', 'Ignored', 400);
    expect(idempotent?.updatedAt).toBe(300);

    const cancelledAfterResolve = store.cancelPausedWorkItem('work_1', 'Should not cancel', 500);
    expect(cancelledAfterResolve?.status).toBe('resolved');
  });

  it('hydrates paused work items from GraphD metadata', () => {
    const fakeGraphd = {
      sessionGet: () => ({
        metadata: {
          paused_work_items: [
            {
              workId: 'work_2',
              agentType: 'explorer',
              objective: 'Investigate issue',
              reason: 'Escalated for decision',
              escalationId: 'esc_2',
              status: 'pending',
              createdAt: 10,
              updatedAt: 11,
            },
          ],
        },
      }),
      contextGet: () => ({}),
      sessionUpdateMetadata: () => ({ success: true }),
    } as unknown as GraphDManager;

    const store = new SessionStore({
      sessionKey: 'session_hydrate',
      maxTokens: 1000,
      graphd: fakeGraphd,
      isGraphDReady: () => true,
      logger,
      workingDir: process.cwd(),
    });

    store.getContext();

    const items = store.listPausedWorkItems();
    expect(items.length).toBe(1);
    expect(items[0].workId).toBe('work_2');
    expect(items[0].agentType).toBe('explorer');
    expect(items[0].escalationId).toBe('esc_2');
    expect(items[0].status).toBe('pending');
  });
});

// ============================================
// DISK-BACKED CONTEXT INTEGRATION
// ============================================

describe('SessionStore disk-backed context', () => {
  beforeEach(() => {
    if (existsSync(DISK_TEST_DIR)) {
      rmSync(DISK_TEST_DIR, { recursive: true });
    }
  });
  afterEach(() => {
    if (existsSync(DISK_TEST_DIR)) {
      rmSync(DISK_TEST_DIR, { recursive: true });
    }
  });

  it('getContext creates disk-backed ContextWindow that writes to disk', () => {
    const store = new SessionStore({
      sessionKey: 'disk-test-1',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx = store.getContext();

    // filePath should be set
    expect(ctx.filePath).not.toBeNull();
    expect(ctx.filePath).toContain('.haiku/sessions');
    expect(ctx.filePath).toContain('disk-test-1');
    expect(ctx.filePath!.endsWith('context.md')).toBe(true);

    // File should exist on disk
    expect(existsSync(ctx.filePath!)).toBe(true);
  });

  it('mutations write through to disk', () => {
    const store = new SessionStore({
      sessionKey: 'disk-wt',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx = store.getContext();
    ctx.addMessage('user', 'Hello from the harness');
    ctx.addFunctionCall('call-1', 'Read', { path: '/foo.ts' });
    ctx.addFunctionCallOutput('call-1', 'export const foo = 42;');

    const content = readFileSync(ctx.filePath!, 'utf-8');
    expect(content).toContain('### message:user');
    expect(content).toContain('Hello from the harness');
    expect(content).toContain('### function_call');
    expect(content).toContain('@name Read');
    expect(content).toContain('### function_call_output');
    expect(content).toContain('export const foo = 42;');
  });

  it('second getContext call returns cached (same) instance', () => {
    const store = new SessionStore({
      sessionKey: 'disk-cache',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store.getContext();
    ctx1.addMessage('user', 'First');

    const ctx2 = store.getContext();
    expect(ctx2).toBe(ctx1); // Same instance
    expect(ctx2.items).toHaveLength(1);
  });

  it('clearContext creates fresh disk-backed context at same path', () => {
    const store = new SessionStore({
      sessionKey: 'disk-clear',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store.getContext();
    ctx1.addMessage('user', 'Old message');
    const firstPath = ctx1.filePath;

    const ctx2 = store.clearContext();
    expect(ctx2.filePath).toBe(firstPath); // Same path
    expect(ctx2.items).toHaveLength(0); // Fresh context

    // Disk file should be empty (no items)
    const content = readFileSync(ctx2.filePath!, 'utf-8');
    expect(content).not.toContain('### message');
    expect(content).toContain('session: disk-clear');
  });

  it('new SessionStore on same workingDir loads persisted items from disk', () => {
    const sessionKey = 'disk-reload';

    // First store: create context and add items
    const store1 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store1.getContext();
    ctx1.addMessage('user', 'Persisted message');
    ctx1.addFileContent('/src/app.ts', 'const app = express();', 'typescript');
    ctx1.addFunctionCall('c1', 'Grep', { pattern: 'TODO' });
    ctx1.addFunctionCallOutput('c1', 'Found 3 TODOs');

    // Close first store (simulates process end)
    store1.close();

    // Second store: same workingDir, same sessionKey — should reload from disk
    const store2 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx2 = store2.getContext();

    // Items should be reloaded from disk
    expect(ctx2.items).toHaveLength(4);

    const msg = ctx2.items[0] as MessageItem;
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Persisted message');

    const fc = ctx2.items[1] as FileContentItem;
    expect(fc.type).toBe('file_content');
    expect(fc.path).toBe('/src/app.ts');
    expect(fc.content).toBe('const app = express();');
    expect(fc.language).toBe('typescript');

    // readFiles should be rebuilt from disk
    expect(ctx2.hasReadFile('/src/app.ts')).toBe(true);
  });

  it('content with --- survives the full SessionStore roundtrip', () => {
    const sessionKey = 'disk-dashes';

    const store1 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store1.getContext();
    ctx1.addFunctionCallOutput('c1', 'line1\n---\nline2\n---\nline3');
    ctx1.addMessage('assistant', '---');
    ctx1.addFileContent('/x.md', '---\ntitle: test\n---\ncontent');
    store1.close();

    const store2 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx2 = store2.getContext();
    expect(ctx2.items).toHaveLength(3);

    expect((ctx2.items[0] as FunctionCallOutputItem).output).toBe('line1\n---\nline2\n---\nline3');
    expect((ctx2.items[1] as MessageItem).content).toBe('---');
    expect((ctx2.items[2] as FileContentItem).content).toBe('---\ntitle: test\n---\ncontent');
  });

  it('hydrateFromSnapshot writes snapshot to disk', () => {
    const store = new SessionStore({
      sessionKey: 'disk-hydrate',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    // Create a snapshot from another context
    const sourceCtx = new ContextWindow('disk-hydrate', 100_000);
    sourceCtx.addMessage('user', 'Hydrated message');
    sourceCtx.addMessage('assistant', 'Hydrated response');
    const snapshot = sourceCtx.serialize() as ContextWindowSnapshot;

    store.hydrateFromSnapshot(snapshot);

    const ctx = store.getContext();
    expect(ctx.items).toHaveLength(2);
    expect(ctx.filePath).not.toBeNull();
    expect(existsSync(ctx.filePath!)).toBe(true);

    // Verify disk file has the items
    const content = readFileSync(ctx.filePath!, 'utf-8');
    expect(content).toContain('Hydrated message');
    expect(content).toContain('Hydrated response');
  });

  it('GraphD hydration path also produces disk-backed context', () => {
    const sourceCtx = new ContextWindow('disk-graphd', 100_000);
    sourceCtx.addMessage('user', 'From GraphD');
    const snapshot = sourceCtx.serialize();

    const fakeGraphd = {
      sessionGet: () => ({ metadata: {} }),
      contextGet: () => ({ snapshot: { context: snapshot } }),
      sessionUpdateMetadata: () => ({ success: true }),
    } as unknown as GraphDManager;

    const store = new SessionStore({
      sessionKey: 'disk-graphd',
      maxTokens: 100_000,
      graphd: fakeGraphd,
      isGraphDReady: () => true,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx = store.getContext();
    expect(ctx.filePath).not.toBeNull();
    expect(ctx.items).toHaveLength(1);
    expect((ctx.items[0] as MessageItem).content).toBe('From GraphD');

    // Disk file should exist with the hydrated content
    expect(existsSync(ctx.filePath!)).toBe(true);
    const content = readFileSync(ctx.filePath!, 'utf-8');
    expect(content).toContain('From GraphD');
  });
});


### function_call
@callId call_9d538fe94ab54bb0b6fff062
@name Read
@ts 1770350612228
@workItemId 00ebbe00
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/cockpit_invariants.test.ts","startLine":1,"endLine":100}

### function_call
@callId call_ebe7cab6f79241e3b6b5b0f4
@name Grep
@ts 1770350612228
@workItemId 00ebbe00
{"pattern":"describe\\(|it\\(|expect\\(","path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/cockpit_invariants.test.ts","maxResults":30}

### function_call_output
@callId call_9d538fe94ab54bb0b6fff062
@ts 1770350612596
@durationMs 5
@workItemId 00ebbe00
// Lines 1-100 of 566 total
/**
 * Cockpit Implementation Invariant Tests
 *
 * These tests verify invariants from COCKPIT_IMPLEMENTATION_SPEC.md against
 * the actual implementation. They are designed to expose bugs, not just confirm
 * happy paths.
 *
 * Invariants tested:
 * 1. Escalation lifecycle: pending → resolved is irreversible
 * 2. pendingCount must match UI "unresolved" definition (pending + acknowledged)
 * 3. Session status must reflect escalation blocking state accurately
 * 4. Escalation resolution guidance must be injectable (not dead code)
 * 5. Resolving the last escalation must unblock the session
 * 6. Concurrent resolution of the same escalation is idempotent
 * 7. Timestamp consistency between layers (ms vs seconds)
 * 8. Session panel status maps "blocked" GraphD status correctly
 */

import { describe, expect, it } from 'bun:test';
import {
  buildEscalationResolutionGuidance,
  parseSessionEscalations,
  resolveSessionEscalationState,
  type EscalationResolutionInput,
  type SessionEscalationRecord,
} from './escalation_state.js';

// ============================================
// HELPERS
// ============================================

function makeEscalation(overrides: Partial<SessionEscalationRecord> & { id: string; sessionKey: string }): Record<string, unknown> {
  return {
    escalationType: 'review',
    title: 'Test escalation',
    context: 'Test context',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    references: [{ type: 'workitem', label: 'WI', target: 'work_1' }],
    ...overrides,
  };
}

function makeResolution(overrides: Partial<EscalationResolutionInput> = {}): EscalationResolutionInput {
  return { resolvedBy: 'user', ...overrides };
}

// ============================================
// INVARIANT 1: Escalation terminal states are irreversible
// ============================================

describe('Invariant: escalation terminal states are irreversible', () => {
  it('resolved escalation cannot transition back to pending', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({
        id: 'esc_1',
        sessionKey: 's1',
        status: 'resolved',
        createdAt: 50,
        updatedAt: 100,
        resolvedAt: 100,
        resolution: { resolvedBy: 'user' },
      }),
    ]);

    // Attempt to re-resolve should be idempotent
    const result = resolveSessionEscalationState(escalations, 'esc_1', makeResolution(), 200);
    expect(result.found).toBe(true);
    expect(result.alreadyTerminal).toBe(true);
    expect(result.resolved?.status).toBe('resolved');
    // Must preserve original timestamps, NOT overwrite with new timestamp
    expect(result.resolved?.updatedAt).toBe(100);
    expect(result.resolved?.resolvedAt).toBe(100);
  });

  it('dismissed escalation cannot be resolved', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({
        id: 'esc_1',
        sessionKey: 's1',
        status: 'dismissed',
      }),
    ]);

    const result = resolveSessionEscalationState(escalations, 'esc_1', makeResolution(), 500);
    expect(result.found).toBe(true);
    expect(result.alreadyTerminal).toBe(true);
    expect(result.resolved?.status).toBe('dismissed');
  });
});

// ============================================
// INVARIANT 2: pendingCount must match "unresolved" definition
// Spec says: unresolved = pending OR acknowledged
// pendingCount now correctly counts both 'pending' and 'acknowledged'
// ============================================

describe('Invariant: pendingCount must reflect all unresolved escalations', () => {
  it('pendingCount includes acknowledged escalations', () => {

### function_call_output
@callId call_ebe7cab6f79241e3b6b5b0f4
@ts 1770350612596
@durationMs 366
@workItemId 00ebbe00
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:53:1:describe('Invariant: escalation terminal states are irreversible', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:54:3:  it('resolved escalation cannot transition back to pending', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:69:5:    expect(result.found).toBe(true);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:70:5:    expect(result.alreadyTerminal).toBe(true);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:71:5:    expect(result.resolved?.status).toBe('resolved');
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:73:5:    expect(result.resolved?.updatedAt).toBe(100);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:74:5:    expect(result.resolved?.resolvedAt).toBe(100);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:77:3:  it('dismissed escalation cannot be resolved', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:87:5:    expect(result.found).toBe(true);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:88:5:    expect(result.alreadyTerminal).toBe(true);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:89:5:    expect(result.resolved?.status).toBe('dismissed');
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:99:1:describe('Invariant: pendingCount must reflect all unresolved escalations', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:100:3:  it('pendingCount includes acknowledged escalations', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:113:5:    expect(unresolvedCount).toBe(1);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:114:5:    expect(result.pendingCount).toBe(unresolvedCount);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:117:3:  it('acknowledged-only escalations report correct pendingCount', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:125:5:    expect(result.found).toBe(false);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:127:5:    expect(result.pendingCount).toBe(2);
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:137:1:describe('Invariant: session status reflects blocking accurately', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:138:3:  it('blocked sessions have distinct status in cockpit', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:145:5:    expect(allStatuses).toContain('blocked');
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:154:1:describe('Invariant: escalation resolution produces injectable guidance', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:155:3:  it('guidance includes all resolution details for agent consumption', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:171:5:    expect(guidance).toContain('[Escalation Resolved]');
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:172:5:    expect(guidance).toContain('JWT vs Opaque Tokens');
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:173:5:    expect(guidance).toContain('opaque_tokens');
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:174:5:    expect(guidance).toContain('Redis-backed');
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:175:5:    expect(guidance).toContain('Continue execution');
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:178:3:  it('guidance without option or notes still produces actionable text', () => {
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:191:5:    expect(guidance).toContain('No additional notes');
...[truncated at 30 results]

### function_call
@callId call_c012bc76893c4f829674e623
@name Read
@ts 1770350619953
@workItemId 00ebbe00
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/package.json"}

### function_call
@callId call_e98fd1870c7640d5b5b55cc7
@name Grep
@ts 1770350619953
@workItemId 00ebbe00
{"pattern":"^import.*from.*control_plane_routes|^export.*from.*control_plane_routes","path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness"}

### function_call_output
@callId call_c012bc76893c4f829674e623
@ts 1770350619973
@durationMs 10
@workItemId 00ebbe00
{
  "name": "harness-daemon",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "rex-daemon": "./bin/rex.js"
  },
  "scripts": {
    "start": "bun run src/index.ts",
    "profile": "bun --inspect run src/index.ts",
    "profile:cpu": "BUN_JSC_dumpSamplingProfilerData=1 bun run src/index.ts",
    "clean": "rm -rf dist",
    "lint": "tsc --noEmit",
    "build": "tsc",
    "test": "bun test"
  },
  "dependencies": {
    "agent": "workspace:*",
    "comms-bus": "workspace:*",
    "context": "workspace:*",
    "entity-graph": "workspace:*",
    "graphd": "workspace:*",
    "llm": "workspace:*",
    "memory-injector": "workspace:*",
    "minimatch": "^10.1.1",
    "orchestrator": "workspace:*",
    "shared": "workspace:*",
    "tools": "workspace:*",
    "types": "workspace:*",
    "decision-watcher": "workspace:*",
    "work": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "^1.0.0",
    "@types/node": "^20.10.0",
    "typescript": "^5.3.3"
  }
}


### function_call_output
@callId call_e98fd1870c7640d5b5b55cc7
@ts 1770350619973
@durationMs 19
@workItemId 00ebbe00
packages/harness-daemon/src/harness/daemon.ts:18:1:import { handleControlPlaneRequest, type ControlPlaneContext } from './control_plane_routes.js';

### function_call
@callId call_b4486fb263c34b32af4d3c41
@name Grep
@ts 1770350627867
@workItemId 00ebbe00
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","pattern":"^export (function|async function|const) |^function |^async function "}

### function_call_output
@callId call_b4486fb263c34b32af4d3c41
@ts 1770350628222
@durationMs 354
@workItemId 00ebbe00
packages/harness-daemon/src/harness/control_plane_routes.ts:290:1:function isRecord(value: unknown): value is Record<string, unknown> {
packages/harness-daemon/src/harness/control_plane_routes.ts:294:1:function asString(value: unknown): string | undefined {
packages/harness-daemon/src/harness/control_plane_routes.ts:298:1:function asNumber(value: unknown): number | undefined {
packages/harness-daemon/src/harness/control_plane_routes.ts:302:1:function asStringArray(value: unknown): string[] {
packages/harness-daemon/src/harness/control_plane_routes.ts:307:1:function parseAgentEventTokenTotalsForDay(
packages/harness-daemon/src/harness/control_plane_routes.ts:327:1:function readBody(req: IncomingMessage): Promise<string> {
packages/harness-daemon/src/harness/control_plane_routes.ts:336:1:async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
packages/harness-daemon/src/harness/control_plane_routes.ts:350:1:async function ghCommand(args: string, cwd?: string): Promise<string> {
packages/harness-daemon/src/harness/control_plane_routes.ts:367:1:async function getPRs(owner: string, repo: string): Promise<PRInfo[]> {
packages/harness-daemon/src/harness/control_plane_routes.ts:405:1:function parseGitRemote(remoteUrl: string): GitRemote | null {
packages/harness-daemon/src/harness/control_plane_routes.ts:422:1:async function getGitRemote(projectPath: string): Promise<GitRemote | null> {
packages/harness-daemon/src/harness/control_plane_routes.ts:445:1:async function getRecentCommits(projectPath: string, limit = 10): Promise<GitCommitInfo[]> {
packages/harness-daemon/src/harness/control_plane_routes.ts:460:1:function parseUrl(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
packages/harness-daemon/src/harness/control_plane_routes.ts:468:1:function sendJson(res: ServerResponse, data: unknown, status = 200): void {
packages/harness-daemon/src/harness/control_plane_routes.ts:476:1:function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
packages/harness-daemon/src/harness/control_plane_routes.ts:496:1:function formatSession(row: SessionRow) {
packages/harness-daemon/src/harness/control_plane_routes.ts:513:1:function formatMessage(row: MessageRow) {
packages/harness-daemon/src/harness/control_plane_routes.ts:525:1:function parseTimestampMs(value: unknown): number | undefined {
packages/harness-daemon/src/harness/control_plane_routes.ts:540:1:function toStringOutput(value: unknown): string {
packages/harness-daemon/src/harness/control_plane_routes.ts:546:1:async function execFileText(
...[truncated at 20 results]

### function_call
@callId call_cdc5daa129e847c4a0df0e07
@name Grep
@ts 1770350634584
@workItemId 00ebbe00
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","pattern":"^async function handle|^function handle"}

### function_call_output
@callId call_cdc5daa129e847c4a0df0e07
@ts 1770350634590
@durationMs 5
@workItemId 00ebbe00
packages/harness-daemon/src/harness/control_plane_routes.ts:2064:1:async function handleGetCockpitSessionRollups(
packages/harness-daemon/src/harness/control_plane_routes.ts:2091:1:function handleGetCockpitEscalationRollups(
packages/harness-daemon/src/harness/control_plane_routes.ts:2109:1:async function handleGetCockpitCommitRollups(
packages/harness-daemon/src/harness/control_plane_routes.ts:2174:1:async function handleGetCockpitPRRollups(
packages/harness-daemon/src/harness/control_plane_routes.ts:2229:1:async function handleGetCockpitDailyMetrics(
packages/harness-daemon/src/harness/control_plane_routes.ts:2317:1:async function handleGetCockpitFocus(
packages/harness-daemon/src/harness/control_plane_routes.ts:2444:1:async function handleGetCockpitTraces(
packages/harness-daemon/src/harness/control_plane_routes.ts:2528:1:async function handleGetCockpitDiff(
packages/harness-daemon/src/harness/control_plane_routes.ts:2587:1:async function handleGetCockpitTestReports(
packages/harness-daemon/src/harness/control_plane_routes.ts:2625:1:async function handleGetCockpitTestReportById(
packages/harness-daemon/src/harness/control_plane_routes.ts:2732:1:async function handleGetCockpitRepoLens(
packages/harness-daemon/src/harness/control_plane_routes.ts:2800:1:function handleGetCockpitPreview(
packages/harness-daemon/src/harness/control_plane_routes.ts:2831:1:function handleGetCockpitSessionEvents(
packages/harness-daemon/src/harness/control_plane_routes.ts:2860:1:function handleGetCockpitSessionPackets(
packages/harness-daemon/src/harness/control_plane_routes.ts:2877:1:async function handlePostCockpitPacket(
packages/harness-daemon/src/harness/control_plane_routes.ts:2969:1:async function handleResolveCockpitEscalation(
packages/harness-daemon/src/harness/control_plane_routes.ts:3027:1:async function handlePostSessionMessage(
packages/harness-daemon/src/harness/control_plane_routes.ts:3069:1:async function handlePostSessionControl(
packages/harness-daemon/src/harness/control_plane_routes.ts:3169:1:async function handlePostSessionReviewDecision(
packages/harness-daemon/src/harness/control_plane_routes.ts:3437:1:async function handlePostCockpitPatchApply(
...[truncated at 20 results]

### function_call
@callId call_e9016cf04bea42bd9da73b7b
@name PromptUser
@ts 1770350713439
@workItemId 00ebbe00
{"question":"What is the expected scope for the test coverage of control_plane_routes.ts?","options":[{"label":"Pure functions only (no I/O)","description":"Test utility functions like parseGitRemote, asString, isRecord, mapSessionStatus, etc. Fast, no mocking required."},{"label":"Pure functions + route handlers (with mocks)","description":"Include route handlers with mocked ControlPlaneContext, GraphDManager, exec calls. More comprehensive but complex."},{"label":"Integration tests (end-to-end)","description":"Test actual HTTP requests against the routes with real dependencies. Slowest but most realistic."},{"label":"Critical path only","description":"Focus on the most important/complex functions: session rollups, escalations, diff parsing, patch constraints."}]}

### function_call_output
@callId call_e9016cf04bea42bd9da73b7b
@ts 1770350713439
@workItemId 00ebbe00
Waiting for user input...

### message:assistant
@ts 1770350713448
I'll help you write test cases for the control_plane_routes.ts file. Let me start by reading the salience file and exploring the codebase.

### message:user
@ts 1770350744973
Choose option 2: Pure functions + route handlers (with mocks). Write comprehensive tests for the utility functions (parseGitRemote, asString, isRecord, mapSessionStatus, etc.) and the route handlers with mocked ControlPlaneContext, GraphDManager, and exec calls. This gives good coverage without the complexity of full integration tests. Structure tests as atomic units that can be committed individually.

### function_call
@callId call_5cbaddaabff546c7a8aa35fb
@name Read
@ts 1770350847172
@workItemId f7a00953
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":290,"endLine":310}

### function_call_output
@callId call_5cbaddaabff546c7a8aa35fb
@ts 1770350847187
@durationMs 8
@workItemId f7a00953
// Lines 290-310 of 3108 total
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseAgentEventTokenTotalsForDay(
  metadata: Record<string, unknown> | undefined,
  startMs: number,
  endMs: number

### function_call
@callId call_c8bb14a12897440aaa8ae133
@name Read
@ts 1770350864922
@workItemId f7a00953
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":400,"endLine":520}

### function_call_output
@callId call_c8bb14a12897440aaa8ae133
@ts 1770350864939
@durationMs 9
@workItemId f7a00953
// Lines 400-520 of 3108 total
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

### function_call
@callId call_0a2b5ea8d7974c5a849062bb
@name Read
@ts 1770350867398
@workItemId f7a00953
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","endLine":900,"startLine":560}

### function_call_output
@callId call_0a2b5ea8d7974c5a849062bb
@ts 1770350867794
@durationMs 393
@workItemId f7a00953
// Lines 560-900 of 3108 total
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

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
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
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
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

### function_call
@callId call_c198b041c60542099511afb4
@name Read
@ts 1770350872494
@workItemId f7a00953
{"endLine":1400,"startLine":1000,"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_c198b041c60542099511afb4
@ts 1770350872921
@durationMs 424
@workItemId f7a00953
// Lines 1000-1400 of 3108 total
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

### function_call
@callId call_45bbd7ebb74e43f2962f2e3c
@name Read
@ts 1770350880846
@workItemId f7a00953
{"endLine":1900,"startLine":1800,"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_45bbd7ebb74e43f2962f2e3c
@ts 1770350880860
@durationMs 11
@workItemId f7a00953
// Lines 1800-1900 of 3108 total
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


### function_call
@callId call_4035cc8540c1494d9a9e7e2a
@name Grep
@ts 1770350905825
@workItemId f7a00953
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","pattern":"^import","maxResults":20}

### function_call_output
@callId call_4035cc8540c1494d9a9e7e2a
@ts 1770350905846
@durationMs 12
@workItemId f7a00953
packages/harness-daemon/src/harness/control_plane_routes.ts:10:1:import type { IncomingMessage, ServerResponse } from 'http';
packages/harness-daemon/src/harness/control_plane_routes.ts:11:1:import type { GraphDManager } from 'graphd';
packages/harness-daemon/src/harness/control_plane_routes.ts:12:1:import { exec, execFile } from 'child_process';
packages/harness-daemon/src/harness/control_plane_routes.ts:13:1:import { promisify } from 'util';
packages/harness-daemon/src/harness/control_plane_routes.ts:14:1:import {

### function_call
@callId call_f4bbd5953dfe459db1aac84e
@name PromptUser
@ts 1770350913877
@workItemId f7a00953
{"question":"Should tests run against actual filesystem/git or use full mocks for git operations?\n\nThis affects how we test functions like `getGitRemote`, `getRecentCommits`, `loadTraceRecords` which interact with git and filesystem.\n\n**Option A**: Full mocks for all git/filesystem operations (faster, no external deps, but less realistic)\n**Option B**: Use temporary test directories with real git operations (slower, more realistic, requires git in test env)","options":[{"label":"Full mocks (faster, isolated)","description":"Mock execAsync, import('fs/promises'), etc. No real git calls. Tests run quickly with zero external dependencies."},{"label":"Real git on temp dirs (more realistic)","description":"Create temporary git repos for testing parse functions. Slower but tests real behavior. Requires git binary in test environment."}]}

### function_call_output
@callId call_f4bbd5953dfe459db1aac84e
@ts 1770350913877
@workItemId f7a00953
Waiting for user input...

### message:assistant
@ts 1770350992357
Now I have enough context. Let me create a comprehensive test plan for control_plane_routes.ts. Based on my analysis, I'll organize tests into atomic, commitable work items.

### message:system
@ts 1770351020465
For parsing functions like parseGitRemote that analyze string formats, write unit tests with mocked inputs. For git operations like getGitRemote, getRecentCommits, and loadTraceRecords, mock the underlying exec calls to return controlled test data. This keeps tests atomic, fast, and reliable across environments.

### message:user
@ts 1770351020466
Choose Option A: Full mocks (faster, isolated). Mock execAsync, import('fs/promises'), etc. for all git and filesystem operations. This aligns with the established approach of using mocks for route handlers, ensures tests run quickly with zero external dependencies, and maintains test isolation without requiring git in the test environment.

### function_call
@callId call_8ec47e16bab9477db2db350a
@name Grep
@ts 1770350847926
@workItemId c801329c
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness","pattern":"import.*@types/bun|from 'bun:test'"}

### function_call_output
@callId call_8ec47e16bab9477db2db350a
@ts 1770350848483
@durationMs 547
@workItemId c801329c
packages/harness-daemon/src/harness/harness.watcher.test.ts:5:39:import { describe, it, expect, mock } from 'bun:test';
packages/harness-daemon/src/harness/escalation_state.test.ts:1:33:import { describe, expect, it } from 'bun:test';
packages/harness-daemon/src/harness/session_store.test.ts:1:56:import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
packages/harness-daemon/src/harness/cockpit_invariants.test.ts:19:33:import { describe, expect, it } from 'bun:test';
packages/harness-daemon/src/harness/bridge_gateway.test.ts:5:33:import { describe, it, expect } from 'bun:test';

### function_call
@callId call_041247798e9942619b71beb3
@name Read
@ts 1770350853626
@workItemId c801329c
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/harness.watcher.test.ts","startLine":1,"endLine":80}

### function_call_output
@callId call_041247798e9942619b71beb3
@ts 1770350853630
@durationMs 2
@workItemId c801329c
// Lines 1-80 of 166 total
/**
 * AgentHarness watcher memory injector wiring tests
 */

import { describe, it, expect, mock } from 'bun:test';

let capturedRuntime: { memoryInjector?: unknown } | null = null;

mock.module('agent', () => ({
  Agent: class MockAgent {
    constructor(_config: unknown, runtime: { memoryInjector?: unknown }) {
      capturedRuntime = runtime;
    }

    async run() {
      return {
        success: true,
        response: '',
        structuredOutput: {
          action: 'done',
          goalStateReached: true,
          watcherAction: 'allow',
          reason: 'ok',
        },
        terminationReason: 'goal_state_reached',
      };
    }
  },
  AgentRegistry: class MockAgentRegistry {
    private configs: Array<{ type: string }>;

    constructor(configs: Array<{ type: string }>) {
      this.configs = configs;
    }

    has(name: string): boolean {
      return this.configs.some((config) => config.type === name);
    }

    getConfig(name: string) {
      return this.configs.find((config) => config.type === name);
    }

    listToolDefinitions() {
      return [];
    }
  },
  buildAgentConfig: (type: string, tools: string[] = [], budget: unknown, llmParams: unknown, outputSchema?: unknown) => ({
    type,
    tools,
    budget,
    llmParams,
    outputSchema,
    systemPrompt: '',
  }),
  getAgentPrompt: () => '',
  getPlanningPromptAddendum: () => '',
}));

mock.module('llm', () => ({
  createAdapter: () => ({ updateApiKey: () => {} }),
  hasCodexCredentials: () => false,
}));

import { AgentHarness } from './harness.js';
import type { FullHarnessConfig } from './config.js';

function createTestConfig(): FullHarnessConfig {
  const cwd = process.cwd();
  return {
    agents: {
      watcher: {
        llm: {
          provider: 'openai',
          displayProvider: 'openai',
          model: 'test-model',
          maxTokens: 1,
          temperature: 0,
          reasoning: { effort: 'none' },
        },

### message:assistant
@ts 1770351158547
I'll now produce a comprehensive plan for testing control_plane_routes.ts with pure functions and route handlers (with mocks).

### function_call
@callId call_843f7851d14e408f80e155a7
@name Read
@ts 1770350862957
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":1840,"endLine":1950}

### function_call_output
@callId call_843f7851d14e408f80e155a7
@ts 1770350863537
@durationMs 578
@workItemId dffad4c5
// Lines 1840-1950 of 3108 total
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

### function_call
@callId call_062c1950001d4b8199248589
@name Read
@ts 1770350874402
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":405,"endLine":470}

### function_call_output
@callId call_062c1950001d4b8199248589
@ts 1770350874410
@durationMs 3
@workItemId dffad4c5
// Lines 405-470 of 3108 total
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

### function_call
@callId call_e4c8a2620b914bbe94ad84b4
@name Read
@ts 1770350877513
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":327,"endLine":350}

### function_call_output
@callId call_e4c8a2620b914bbe94ad84b4
@ts 1770350877949
@durationMs 434
@workItemId dffad4c5
// Lines 327-350 of 3108 total
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

### function_call
@callId call_a14421d230644833b9a7280e
@name Read
@ts 1770350909186
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":1750,"endLine":1850}

### function_call_output
@callId call_a14421d230644833b9a7280e
@ts 1770350909199
@durationMs 10
@workItemId dffad4c5
// Lines 1750-1850 of 3108 total
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


### function_call
@callId call_fe86926aa2f347bb8806d4c2
@name Read
@ts 1770350912278
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":1880,"endLine":2000}

### function_call_output
@callId call_fe86926aa2f347bb8806d4c2
@ts 1770350912828
@durationMs 548
@workItemId dffad4c5
// Lines 1880-2000 of 3108 total
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '100', 10);
    void handleGetCockpitSessionRollups(res, ctx, status, limit);
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

  // GET /control-plane/cockpit/repo/lens?q=...&kind=all|defs|refs|text&sessionKey=...
  if (pathname === '/control-plane/cockpit/repo/lens' && req.method === 'GET') {
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


### function_call
@callId call_b1a630a7c1b14604b9a38e35
@name Read
@ts 1770350915269
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":1710,"endLine":1750}

### function_call_output
@callId call_b1a630a7c1b14604b9a38e35
@ts 1770350915301
@durationMs 9
@workItemId dffad4c5
// Lines 1710-1750 of 3108 total

  const agentEvents = Array.isArray(session.metadata?.agent_events) ? session.metadata?.agent_events : [];
  for (const entry of agentEvents) {
    if (!isRecord(entry)) continue;
    const type = asString(entry.type);
    const ts = parseTimestampMs(entry.timestamp);
    if (!type || !ts) continue;
    normalized.push({
      ts,
      event: {
        at: new Date(ts).toISOString(),
        type: normalizeAgentEventType(type),
        payload: {
          eventType: type,
          requestId: asString(entry.request_id),
          workItemId: asString(entry.work_item_id),
          data: isRecord(entry.data) ? entry.data : {},
        },
      },
    });
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

### function_call
@callId call_e790f5148eb24a64a9a8b01e
@name Grep
@ts 1770350917594
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","pattern":"^async function handle|^function handle","maxResults":50}

### function_call_output
@callId call_e790f5148eb24a64a9a8b01e
@ts 1770350917791
@durationMs 183
@workItemId dffad4c5
packages/harness-daemon/src/harness/control_plane_routes.ts:2064:1:async function handleGetCockpitSessionRollups(
packages/harness-daemon/src/harness/control_plane_routes.ts:2091:1:function handleGetCockpitEscalationRollups(
packages/harness-daemon/src/harness/control_plane_routes.ts:2109:1:async function handleGetCockpitCommitRollups(
packages/harness-daemon/src/harness/control_plane_routes.ts:2174:1:async function handleGetCockpitPRRollups(
packages/harness-daemon/src/harness/control_plane_routes.ts:2229:1:async function handleGetCockpitDailyMetrics(
packages/harness-daemon/src/harness/control_plane_routes.ts:2317:1:async function handleGetCockpitFocus(
packages/harness-daemon/src/harness/control_plane_routes.ts:2444:1:async function handleGetCockpitTraces(
packages/harness-daemon/src/harness/control_plane_routes.ts:2528:1:async function handleGetCockpitDiff(
packages/harness-daemon/src/harness/control_plane_routes.ts:2587:1:async function handleGetCockpitTestReports(
packages/harness-daemon/src/harness/control_plane_routes.ts:2625:1:async function handleGetCockpitTestReportById(
packages/harness-daemon/src/harness/control_plane_routes.ts:2732:1:async function handleGetCockpitRepoLens(
packages/harness-daemon/src/harness/control_plane_routes.ts:2800:1:function handleGetCockpitPreview(
packages/harness-daemon/src/harness/control_plane_routes.ts:2831:1:function handleGetCockpitSessionEvents(
packages/harness-daemon/src/harness/control_plane_routes.ts:2860:1:function handleGetCockpitSessionPackets(
packages/harness-daemon/src/harness/control_plane_routes.ts:2877:1:async function handlePostCockpitPacket(
packages/harness-daemon/src/harness/control_plane_routes.ts:2969:1:async function handleResolveCockpitEscalation(
packages/harness-daemon/src/harness/control_plane_routes.ts:3027:1:async function handlePostSessionMessage(
packages/harness-daemon/src/harness/control_plane_routes.ts:3069:1:async function handlePostSessionControl(
packages/harness-daemon/src/harness/control_plane_routes.ts:3169:1:async function handlePostSessionReviewDecision(
packages/harness-daemon/src/harness/control_plane_routes.ts:3437:1:async function handlePostCockpitPatchApply(
packages/harness-daemon/src/harness/control_plane_routes.ts:3518:1:function handleGetProjects(res: ServerResponse, ctx: ControlPlaneContext): void {
packages/harness-daemon/src/harness/control_plane_routes.ts:3573:1:async function handleGetFeatures(res: ServerResponse, _ctx: ControlPlaneContext, projectPath: string): Promise<void> {
packages/harness-daemon/src/harness/control_plane_routes.ts:3615:1:function handleGetProjectSessions(res: ServerResponse, ctx: ControlPlaneContext, projectPath: string): void {
packages/harness-daemon/src/harness/control_plane_routes.ts:3635:1:async function handleGetPRs(res: ServerResponse, branch: string, owner: string | null, repo: string | null): Promise<void> {
packages/harness-daemon/src/harness/control_plane_routes.ts:3660:1:function handleGetSessions(res: ServerResponse, ctx: ControlPlaneContext, limit: number): void {
packages/harness-daemon/src/harness/control_plane_routes.ts:3684:1:function handleGetSession(res: ServerResponse, ctx: ControlPlaneContext, sessionKey: string): void {
packages/harness-daemon/src/harness/control_plane_routes.ts:3708:1:function handleGetSessionMessages(res: ServerResponse, ctx: ControlPlaneContext, sessionKey: string): void {
packages/harness-daemon/src/harness/control_plane_routes.ts:3728:1:function handleGetGoalHierarchy(res: ServerResponse): void {
packages/harness-daemon/src/harness/control_plane_routes.ts:3737:1:function handleGetTokenUsage(res: ServerResponse, ctx: ControlPlaneContext): void {
packages/harness-daemon/src/harness/control_plane_routes.ts:3779:1:async function handleGetGitInfo(res: ServerResponse, projectPath: string): Promise<void> {
packages/harness-daemon/src/harness/control_plane_routes.ts:3808:1:async function handleGetTraces(res: ServerResponse, ctx: ControlPlaneContext, limit: number): Promise<void> {
packages/harness-daemon/src/harness/control_plane_routes.ts:3851:1:async function handleGetTraceByRevision(res: ServerResponse, ctx: ControlPlaneContext, revision: string): Promise<void> {
packages/harness-daemon/src/harness/control_plane_routes.ts:3868:1:function handleGetLiveSessions(res: ServerResponse, ctx: ControlPlaneContext): void {

### function_call
@callId call_b331b8efe3fc42659319887d
@name Read
@ts 1770350922466
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":290,"endLine":310}

### function_call_output
@callId call_b331b8efe3fc42659319887d
@ts 1770350922872
@durationMs 399
@workItemId dffad4c5
// Lines 290-310 of 3108 total
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function parseAgentEventTokenTotalsForDay(
  metadata: Record<string, unknown> | undefined,
  startMs: number,
  endMs: number

### function_call
@callId call_f3efe1810dfa44dd90342c6c
@name Read
@ts 1770350932466
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":476,"endLine":496}

### function_call_output
@callId call_f3efe1810dfa44dd90342c6c
@ts 1770350932880
@durationMs 393
@workItemId dffad4c5
// Lines 476-496 of 3108 total
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

### function_call
@callId call_83a08188e1c64ede9f742299
@name Read
@ts 1770350934998
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":145,"endLine":175}

### function_call_output
@callId call_83a08188e1c64ede9f742299
@ts 1770350935009
@durationMs 4
@workItemId dffad4c5
// Lines 145-175 of 3108 total
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

### function_call
@callId call_bef29a8df8894fdba0cc9177
@name Read
@ts 1770350937500
@workItemId dffad4c5
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts","startLine":120,"endLine":145}

### function_call_output
@callId call_bef29a8df8894fdba0cc9177
@ts 1770350937891
@durationMs 387
@workItemId dffad4c5
// Lines 120-145 of 3108 total
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

### message:assistant
@ts 1770351203775
Now I have a comprehensive understanding of the control_plane_routes.ts file. Let me create a detailed plan for the test suite.

### message:system
@ts 1770351456910
The test suite plan is good overall, but work item 7 needs to be decomposed. It attempts to test ~20 cockpit route handlers in a single commit, which violates the principle that one work item = one git commit. Split work item 7 into 2-3 smaller work items that are independently committable and reviewable.

Suggested split:
- **Work item 7a**: Rollups and metrics (handleGetCockpitSessionRollups, handleGetCockpitEscalationRollups, handleGetCockpitCommitRollups, handleGetCockpitPRRollups, handleGetCockpitDailyMetrics)
- **Work item 7b**: Fetching and queries (handleGetCockpitFocus, handleGetCockpitTraces, handleGetCockpitDiff, handleGetCockpitTestReports, handleGetCockpitTestReportById, handleGetCockpitRepoLens, handleGetCockpitPreview, handleGetCockpitSessionEvents, handleGetCockpitSessionPackets)
- **Work item 7c**: Post operations and actions (handlePostCockpitPacket, handleResolveCockpitEscalation, handlePostSessionMessage, handlePostSessionControl, handlePostSessionReviewDecision, handlePostCockpitPatchApply)

Each work item should have:
- Clear, focused objective
- Dependencies on previous work items (particularly 4, 5, 6 for mocks and utilities)
- Target path: packages/harness-daemon/src/harness/control_plane_routes.test.ts

Update the plan to reflect this split, keeping work items 1-6 as-is.

### message:user
@ts 1770351456911
The test suite plan is good overall, but work item 7 needs to be decomposed. It attempts to test ~20 cockpit route handlers in a single commit, which violates the principle that one work item = one git commit. Split work item 7 into 2-3 smaller work items that are independently committable and reviewable.

Suggested split:
- **Work item 7a**: Rollups and metrics (handleGetCockpitSessionRollups, handleGetCockpitEscalationRollups, handleGetCockpitCommitRollups, handleGetCockpitPRRollups, handleGetCockpitDailyMetrics)
- **Work item 7b**: Fetching and queries (handleGetCockpitFocus, handleGetCockpitTraces, handleGetCockpitDiff, handleGetCockpitTestReports, handleGetCockpitTestReportById, handleGetCockpitRepoLens, handleGetCockpitPreview, handleGetCockpitSessionEvents, handleGetCockpitSessionPackets)
- **Work item 7c**: Post operations and actions (handlePostCockpitPacket, handleResolveCockpitEscalation, handlePostSessionMessage, handlePostSessionControl, handlePostSessionReviewDecision, handlePostCockpitPatchApply)

Each work item should have:
- Clear, focused objective
- Dependencies on previous work items (particularly 4, 5, 6 for mocks and utilities)
- Target path: packages/harness-daemon/src/harness/control_plane_routes.test.ts

Update the plan to reflect this split, keeping work items 1-6 as-is.

### message:system
@ts 1770351501291
You are tasked with a very specific, focused work item. Your objective is to create tests for ONLY THREE utility functions from control_plane_routes.ts:

1. **isRecord** - Type predicate function (line ~127)
2. **asString** - String conversion utility (line ~132)
3. **asStringArray** - String array conversion utility (line ~139)

**Your specific deliverable:**
Create the file `packages/harness-daemon/src/harness/control_plane_routes.test.ts` with comprehensive tests for these three functions ONLY.

**Test requirements from objective:**
- Test `isRecord` with: null, undefined, objects, arrays, primitives
- Test `asString` with: valid strings, empty strings, whitespace-only, non-strings
- Test `asStringArray` with: string arrays, mixed arrays, non-array inputs, empty arrays

**Follow the pattern from session_store.test.ts:**
- Use `describe` blocks for grouping
- Use `it` for individual test cases
- Use `expect` from `bun:test` for assertions
- Import from the source file: `import { isRecord, asString, asStringArray } from './control_plane_routes.js';`

**Important:**
- DO NOT test route handlers, git operations, or any other functions
- DO NOT plan or mention broader test suites
- Focus ONLY on the three utility functions listed above
- Import from './control_plane_routes.js' (the .js extension is correct for ES modules)

Start by writing the test file. Do not ask questions about scope - your scope is explicitly defined above.

### function_call
@callId call_84ce15aa69814964a490a5dc
@name Read
@ts 1770351333689
@workItemId f4c36858
{"path":"/Users/jevinnishioka/Desktop/jesus/plan-context.md"}

### function_call
@callId call_7e8160e203424c118cadfe0a
@name Read
@ts 1770351333689
@workItemId f4c36858
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call
@callId call_c64ccb9e7cd8497c9735f3ec
@name Read
@ts 1770351333689
@workItemId f4c36858
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.test.ts"}

### function_call_output
@callId call_84ce15aa69814964a490a5dc
@ts 1770351333712
@isError true
@durationMs 17
@workItemId f4c36858
File not found: /Users/jevinnishioka/Desktop/jesus/plan-context.md

### function_call_output
@callId call_7e8160e203424c118cadfe0a
@ts 1770351333712
@durationMs 8
@workItemId f4c36858
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
    message: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
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

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
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
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
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

function parsePackets(value: unknown): FocusPacket[] {
  // Packets are harness-emitted markdown artifacts used by the frontend focus view.
  if (!Array.isArray(value)) return [];
  const packets: FocusPacket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const packetId = asString(entry.packetId) ?? asString(entry.id);
    const sessionKey = asString(entry.sessionKey);
    const typeRaw = asString(entry.type);
    const markdown = asString(entry.contentMarkdown) ?? asString(entry.markdown);
    const createdMs = parseTimestampMs(entry.createdAt ?? entry.created_at ?? entry.timestamp);
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
      workItemId: asString(entry.workItemId),
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
      ?? asNumber(metadata.invariantsTotal ?? m
... [truncated 50040 chars]

### function_call_output
@callId call_c64ccb9e7cd8497c9735f3ec
@ts 1770351333717
@isError true
@durationMs 5
@workItemId f4c36858
File not found: /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.test.ts

### message:assistant
@ts 1770351501294
I'll add comprehensive numeric conversion tests for the `asNumber` function to `control_plane_routes.test.ts`. Let me start by examining the existing files.

[Execution interrupted: Circuit breaker is open for: openai-compat:glm-4.7]

### function_call
@callId call_e5a569782d3f4b4e843efd40
@name Read
@ts 1770351333662
@workItemId 19a7e07e
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call
@callId call_eafecc3689404c269dcc94c6
@name Read
@ts 1770351333662
@workItemId 19a7e07e
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/cockpit_invariants.test.ts"}

### function_call
@callId call_4a452cfe64404621aab7f0b5
@name Read
@ts 1770351333662
@workItemId 19a7e07e
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/session_store.test.ts"}

### function_call_output
@callId call_e5a569782d3f4b4e843efd40
@ts 1770351333736
@durationMs 6
@workItemId 19a7e07e
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
    message: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
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

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
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
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
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

function parsePackets(value: unknown): FocusPacket[] {
  // Packets are harness-emitted markdown artifacts used by the frontend focus view.
  if (!Array.isArray(value)) return [];
  const packets: FocusPacket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const packetId = asString(entry.packetId) ?? asString(entry.id);
    const sessionKey = asString(entry.sessionKey);
    const typeRaw = asString(entry.type);
    const markdown = asString(entry.contentMarkdown) ?? asString(entry.markdown);
    const createdMs = parseTimestampMs(entry.createdAt ?? entry.created_at ?? entry.timestamp);
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
      workItemId: asString(entry.workItemId),
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
      ?? asNumber(metadata.invariantsTotal ?? m
... [truncated 50040 chars]

### function_call_output
@callId call_eafecc3689404c269dcc94c6
@ts 1770351333736
@durationMs 59
@workItemId 19a7e07e
/**
 * Cockpit Implementation Invariant Tests
 *
 * These tests verify invariants from COCKPIT_IMPLEMENTATION_SPEC.md against
 * the actual implementation. They are designed to expose bugs, not just confirm
 * happy paths.
 *
 * Invariants tested:
 * 1. Escalation lifecycle: pending → resolved is irreversible
 * 2. pendingCount must match UI "unresolved" definition (pending + acknowledged)
 * 3. Session status must reflect escalation blocking state accurately
 * 4. Escalation resolution guidance must be injectable (not dead code)
 * 5. Resolving the last escalation must unblock the session
 * 6. Concurrent resolution of the same escalation is idempotent
 * 7. Timestamp consistency between layers (ms vs seconds)
 * 8. Session panel status maps "blocked" GraphD status correctly
 */

import { describe, expect, it } from 'bun:test';
import {
  buildEscalationResolutionGuidance,
  parseSessionEscalations,
  resolveSessionEscalationState,
  type EscalationResolutionInput,
  type SessionEscalationRecord,
} from './escalation_state.js';

// ============================================
// HELPERS
// ============================================

function makeEscalation(overrides: Partial<SessionEscalationRecord> & { id: string; sessionKey: string }): Record<string, unknown> {
  return {
    escalationType: 'review',
    title: 'Test escalation',
    context: 'Test context',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    references: [{ type: 'workitem', label: 'WI', target: 'work_1' }],
    ...overrides,
  };
}

function makeResolution(overrides: Partial<EscalationResolutionInput> = {}): EscalationResolutionInput {
  return { resolvedBy: 'user', ...overrides };
}

// ============================================
// INVARIANT 1: Escalation terminal states are irreversible
// ============================================

describe('Invariant: escalation terminal states are irreversible', () => {
  it('resolved escalation cannot transition back to pending', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({
        id: 'esc_1',
        sessionKey: 's1',
        status: 'resolved',
        createdAt: 50,
        updatedAt: 100,
        resolvedAt: 100,
        resolution: { resolvedBy: 'user' },
      }),
    ]);

    // Attempt to re-resolve should be idempotent
    const result = resolveSessionEscalationState(escalations, 'esc_1', makeResolution(), 200);
    expect(result.found).toBe(true);
    expect(result.alreadyTerminal).toBe(true);
    expect(result.resolved?.status).toBe('resolved');
    // Must preserve original timestamps, NOT overwrite with new timestamp
    expect(result.resolved?.updatedAt).toBe(100);
    expect(result.resolved?.resolvedAt).toBe(100);
  });

  it('dismissed escalation cannot be resolved', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({
        id: 'esc_1',
        sessionKey: 's1',
        status: 'dismissed',
      }),
    ]);

    const result = resolveSessionEscalationState(escalations, 'esc_1', makeResolution(), 500);
    expect(result.found).toBe(true);
    expect(result.alreadyTerminal).toBe(true);
    expect(result.resolved?.status).toBe('dismissed');
  });
});

// ============================================
// INVARIANT 2: pendingCount must match "unresolved" definition
// Spec says: unresolved = pending OR acknowledged
// pendingCount now correctly counts both 'pending' and 'acknowledged'
// ============================================

describe('Invariant: pendingCount must reflect all unresolved escalations', () => {
  it('pendingCount includes acknowledged escalations', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'acknowledged' }),
      makeEscalation({ id: 'esc_2', sessionKey: 's1', status: 'pending' }),
    ]);

    // Resolve esc_2 (the only 'pending' one)
    const result = resolveSessionEscalationState(escalations, 'esc_2', makeResolution(), 999);

    // pendingCount must include acknowledged escalations — esc_1 is still unresolved
    const unresolvedCount = result.escalations.filter(
      (e) => e.status === 'pending' || e.status === 'acknowledged'
    ).length;
    expect(unresolvedCount).toBe(1);
    expect(result.pendingCount).toBe(unresolvedCount);
  });

  it('acknowledged-only escalations report correct pendingCount', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'acknowledged' }),
      makeEscalation({ id: 'esc_2', sessionKey: 's1', status: 'acknowledged' }),
    ]);

    // Neither needs resolving, just check the state
    const result = resolveSessionEscalationState(escalations, 'nonexistent', makeResolution());
    expect(result.found).toBe(false);
    // pendingCount must be 2 since both acknowledged escalations are unresolved
    expect(result.pendingCount).toBe(2);
  });
});

// ============================================
// INVARIANT 3: Session status must accurately reflect blocking state
// Spec §10: "A session is READY when... there are no unresolved escalations"
// 'blocked' GraphD status now maps to 'blocked' in the UI panel
// ============================================

describe('Invariant: session status reflects blocking accurately', () => {
  it('blocked sessions have distinct status in cockpit', () => {
    // SessionPanelStatus now includes 'blocked' so blocked sessions are
    // distinguishable from actively running sessions in the cockpit panel.
    // mapSessionStatus('blocked') returns 'blocked', and
    // deriveSessionPanelStatus returns 'blocked' when unresolvedEscalationsCount > 0.
    type SessionPanelStatus = 'running' | 'blocked' | 'ready' | 'done' | 'stopped';
    const allStatuses: SessionPanelStatus[] = ['running', 'blocked', 'ready', 'done', 'stopped'];
    expect(allStatuses).toContain('blocked');
  });
});

// ============================================
// INVARIANT 4: Resolution guidance is constructable and non-empty
// Bug: buildEscalationResolutionGuidance exists but is never called
// ============================================

describe('Invariant: escalation resolution produces injectable guidance', () => {
  it('guidance includes all resolution details for agent consumption', () => {
    const escalation = parseSessionEscalations([
      makeEscalation({
        id: 'esc_99',
        sessionKey: 's1',
        escalationType: 'architectural',
        title: 'JWT vs Opaque Tokens',
      }),
    ])[0];

    const guidance = buildEscalationResolutionGuidance(escalation, {
      resolvedBy: 'user',
      optionId: 'opaque_tokens',
      freeformResponse: 'Use Redis-backed opaque tokens for revocation support',
    });

    expect(guidance).toContain('[Escalation Resolved]');
    expect(guidance).toContain('JWT vs Opaque Tokens');
    expect(guidance).toContain('opaque_tokens');
    expect(guidance).toContain('Redis-backed');
    expect(guidance).toContain('Continue execution');
  });

  it('guidance without option or notes still produces actionable text', () => {
    const escalation = parseSessionEscalations([
      makeEscalation({
        id: 'esc_100',
        sessionKey: 's1',
        title: 'Proceed?',
      }),
    ])[0];

    const guidance = buildEscalationResolutionGuidance(escalation, {
      resolvedBy: 'system',
    });

    expect(guidance).toContain('No additional notes');
    expect(guidance).toContain('Resolved by: system');
    expect(guidance.length).toBeGreaterThan(50);
  });
});

// ============================================
// INVARIANT 5: Resolving last escalation must report pendingCount=0
// ============================================

describe('Invariant: resolving all escalations clears blocking state', () => {
  it('single escalation resolved gives pendingCount=0', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'pending' }),
    ]);

    const result = resolveSessionEscalationState(escalations, 'esc_1', makeResolution(), 999);
    expect(result.pendingCount).toBe(0);
    expect(result.escalations[0].status).toBe('resolved');
  });

  it('resolving one of many leaves correct pending count', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'pending' }),
      makeEscalation({ id: 'esc_2', sessionKey: 's1', status: 'pending' }),
      makeEscalation({ id: 'esc_3', sessionKey: 's1', status: 'pending' }),
    ]);

    const result = resolveSessionEscalationState(escalations, 'esc_2', makeResolution(), 999);
    expect(result.pendingCount).toBe(2);
    expect(result.escalations.find((e) => e.id === 'esc_2')?.status).toBe('resolved');
    expect(result.escalations.filter((e) => e.status === 'pending').length).toBe(2);
  });
});

// ============================================
// INVARIANT 6: Non-existent escalation resolution is safe
// ============================================

describe('Invariant: resolving non-existent escalation fails gracefully', () => {
  it('returns found=false for unknown escalation ID', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'pending' }),
    ]);

    const result = resolveSessionEscalationState(escalations, 'esc_NONEXISTENT', makeResolution());
    expect(result.found).toBe(false);
    expect(result.alreadyTerminal).toBe(false);
    expect(result.resolved).toBeUndefined();
    expect(result.pendingCount).toBe(1);
    // Original escalation unchanged
    expect(result.escalations[0].status).toBe('pending');
  });

  it('returns found=false for empty escalation list', () => {
    const result = resolveSessionEscalationState([], 'esc_1', makeResolution());
    expect(result.found).toBe(false);
    expect(result.pendingCount).toBe(0);
    expect(result.escalations).toHaveLength(0);
  });
});

// ============================================
// INVARIANT 7: parseSessionEscalations is defensive
// ============================================

describe('Invariant: parseSessionEscalations handles edge cases', () => {
  it('drops entries missing required fields', () => {
    const parsed = parseSessionEscalations([
      { id: 'esc_1' }, // missing escalationType, sessionKey, title, context
      { id: '', escalationType: 'review', sessionKey: 's1', title: 'T', context: 'C' }, // empty id
      { id: 'esc_2', escalationType: 'review', sessionKey: 's1', title: 'T', context: 'C', references: [] }, // valid
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('esc_2');
  });

  it('defaults unknown status to pending', () => {
    const parsed = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'garbage_status' as never }),
    ]);
    expect(parsed[0].status).toBe('pending');
  });

  it('coerces invalid timestamps to Date.now()', () => {
    const before = Date.now();
    const parsed = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', createdAt: -1 }),
    ]);
    const after = Date.now();
    // Should default to Date.now() since -1 is invalid
    expect(parsed[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(parsed[0].createdAt).toBeLessThanOrEqual(after);
  });

  it('handles null, undefined, non-array inputs', () => {
    expect(parseSessionEscalations(null)).toEqual([]);
    expect(parseSessionEscalations(undefined)).toEqual([]);
    expect(parseSessionEscalations('not an array')).toEqual([]);
    expect(parseSessionEscalations(42)).toEqual([]);
    expect(parseSessionEscalations({})).toEqual([]);
  });

  it('filters invalid references and preserves valid ones', () => {
    const parsed = parseSessionEscalations([
      makeEscalation({
        id: 'esc_1',
        sessionKey: 's1',
        references: [
          { type: 'file', label: 'Code', target: 'src/auth.ts#L50' },
          { type: '', label: 'Bad', target: 'nope' },  // empty type
          { missing: 'all fields' },
          null,
          42,
        ] as never,
      }),
    ]);
    expect(parsed[0].references).toHaveLength(1);
    expect(parsed[0].references[0].target).toBe('src/auth.ts#L50');
  });

  it('filters invalid options and preserves valid ones', () => {
    const parsed = parseSessionEscalations([
      makeEscalation({
        id: 'esc_1',
        sessionKey: 's1',
        options: [
          { id: 'opt_1', label: 'Use JWT', description: 'Stateless auth', implications: ['fast'], recommended: true },
          { id: 'opt_2', label: 'Use opaque', description: 'Revocable', implications: ['slower'], recommended: false },
          { id: '', label: 'Bad', description: 'x', implications: [], recommended: true }, // empty id
          { missing: 'fields' },
        ] as never,
      }),
    ]);
    expect(parsed[0].options).toHaveLength(2);
    expect(parsed[0].options![0].id).toBe('opt_1');
    expect(parsed[0].options![1].id).toBe('opt_2');
  });
});

// ============================================
// INVARIANT 8: Resolution input validation
// ============================================

describe('Invariant: resolution input is validated', () => {
  it('rejects resolution with invalid resolvedBy', () => {
    // coerceResolution in escalation_state returns undefined for invalid resolvedBy
    const escalations = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'resolved', resolution: { resolvedBy: 'hacker' } }),
    ]);
    // The escalation should be parsed but resolution should be dropped
    expect(parsed(escalations[0].resolution)).toBe(false);
  });

  it('trims whitespace-only resolution fields', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({
        id: 'esc_1',
        sessionKey: 's1',
        status: 'resolved',
        resolution: { resolvedBy: 'user', optionId: '   ', freeformResponse: '  \n\t  ' },
      }),
    ]);
    // Whitespace-only strings should be treated as absent
    expect(escalations[0].resolution?.optionId).toBeUndefined();
    expect(escalations[0].resolution?.freeformResponse).toBeUndefined();
  });
});

function parsed(value: unknown): boolean {
  return value !== undefined && value !== null;
}

// ============================================
// INVARIANT 9: Escalation age calculation consistency
// Bug potential: createdAt stored as Date.now() (ms) but session.createdAt
// in GraphD is seconds. If buildEscalationRollups uses ms correctly, ok.
// ============================================

describe('Invariant: escalation timestamps are epoch milliseconds', () => {
  it('createdAt defaults to Date.now() (milliseconds, not seconds)', () => {
    const before = Date.now();
    const parsed = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1' }),
    ]);
    const after = Date.now();

    // createdAt should be in milliseconds (13 digits), not seconds (10 digits)
    expect(parsed[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(parsed[0].createdAt).toBeLessThanOrEqual(after);
    expect(parsed[0].createdAt.toString().length).toBeGreaterThanOrEqual(13);
  });

  it('explicit createdAt in seconds would produce wrong age', () => {
    // If someone stores createdAt as Unix seconds (like GraphD session.createdAt)
    // instead of milliseconds, the age calculation in buildEscalationRollups
    // would be wildly wrong: (Date.now() - 1707177600) / 1000 = nonsense
    const secondsTimestamp = Math.floor(Date.now() / 1000); // e.g., 1707177600
    const parsed = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', createdAt: secondsTimestamp }),
    ]);

    // This succeeds because secondsTimestamp > 0, but the age would be wrong
    expect(parsed[0].createdAt).toBe(secondsTimestamp);

    // Calculate what the age would be in buildEscalationRollups
    const nowMs = Date.now();
    const ageSec = Math.floor((nowMs - parsed[0].createdAt) / 1000);
    // If createdAt is in seconds (~1.7B), ageSec would be ~1.7M seconds = ~20 days
    // This is WRONG - it should be near 0
    expect(ageSec).toBeGreaterThan(1_000_000); // confirms the bug scenario
  });
});

// ============================================
// INVARIANT 10: Spec §10 "Ready" determination correctness
// Spec says: ready when (1) workflow terminal, (2) gates pass, (3) no unresolved escalations
// deriveSessionPanelStatus now returns 'blocked' for unresolved escalations
// ============================================

describe('Invariant: ready determination follows spec §10', () => {
  it('session with all escalations resolved and gates passing = ready (not running)', () => {
    // After resolving all escalations, a session should transition from
    // 'blocked' to 'ready' (if gates pass) or back to 'running' (if still working).
    // deriveSessionPanelStatus now correctly returns 'blocked' when
    // unresolvedEscalationsCount > 0.

    const escalations = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'pending' }),
    ]);

    // Before resolve: 1 pending
    expect(escalations.filter((e) => e.status === 'pending' || e.status === 'acknowledged').length).toBe(1);

    // After resolve: 0 pending
    const result = resolveSessionEscalationState(escalations, 'esc_1', makeResolution(), 999);
    expect(result.pendingCount).toBe(0);

    // The session should now be eligible for 'ready' if workflow + gates are satisfied
    // The actual status transition happens in harness.ts resolveSessionEscalation()
    // which transitions blocked → active when pendingCount reaches 0
  });
});

// ============================================
// INVARIANT 11: Concurrent double-resolve safety
// ============================================

describe('Invariant: double-resolve is safe and idempotent', () => {
  it('two concurrent resolves on same escalation - second sees alreadyTerminal', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'pending' }),
    ]);

    // First resolve
    const result1 = resolveSessionEscalationState(
      escalations, 'esc_1',
      makeResolution({ optionId: 'first', freeformResponse: 'First responder' }),
      100
    );
    expect(result1.found).toBe(true);
    expect(result1.alreadyTerminal).toBe(false);
    expect(result1.resolved?.resolution?.optionId).toBe('first');

    // Second resolve on the ALREADY-RESOLVED escalation
    const result2 = resolveSessionEscalationState(
      result1.escalations, 'esc_1',
      makeResolution({ optionId: 'second', freeformResponse: 'Late responder' }),
      200
    );
    expect(result2.found).toBe(true);
    expect(result2.alreadyTerminal).toBe(true);
    // Original resolution preserved
    expect(result2.resolved?.resolution?.optionId).toBe('first');
    expect(result2.resolved?.resolvedAt).toBe(100);
  });
});

// ============================================
// INVARIANT 12: Large escalation list performance
// ============================================

describe('Invariant: escalation operations scale linearly', () => {
  it('handles 1000 escalations without error', () => {
    const rawEscalations = Array.from({ length: 1000 }, (_, i) =>
      makeEscalation({
        id: `esc_${i}`,
        sessionKey: 's1',
        status: i % 3 === 0 ? 'resolved' : 'pending',
      })
    );

    const escalations = parseSessionEscalations(rawEscalations);
    expect(escalations).toHaveLength(1000);

    // Resolve the last pending one
    const lastPendingId = `esc_${999 - (999 % 3 === 0 ? 1 : 0)}`;
    const result = resolveSessionEscalationState(escalations, lastPendingId, makeResolution());
    expect(result.found).toBe(true);
    expect(result.escalations).toHaveLength(1000);

    // Count should be accurate
    const expectedPending = escalations.filter(
      (e) => e.status === 'pending' && e.id !== lastPendingId
    ).length;
    expect(result.pendingCount).toBe(expectedPending);
  });
});

// ============================================
// INVARIANT 13: Escalation option validation strictness
// ============================================

describe('Invariant: escalation options require all fields', () => {
  it('drops options missing implications array', () => {
    const parsed = parseSessionEscalations([
      makeEscalation({
        id: 'esc_1',
        sessionKey: 's1',
        options: [
          { id: 'opt_1', label: 'A', description: 'D', recommended: true },
          // ^ missing implications - should be dropped
        ] as never,
      }),
    ]);
    // Options require implications to be an Array
    expect(parsed[0].options).toBeUndefined();
  });

  it('drops options with non-boolean recommended', () => {
    const parsed = parseSessionEscalations([
      makeEscalation({
        id: 'esc_1',
        sessionKey: 's1',
        options: [
          { id: 'opt_1', label: 'A', description: 'D', implications: [], recommended: 'yes' },
        ] as never,
      }),
    ]);
    expect(parsed[0].options).toBeUndefined();
  });
});

// ============================================
// INVARIANT 14: Resolution preserves escalation identity
// ============================================

describe('Invariant: resolution does not mutate other escalations', () => {
  it('resolving esc_2 leaves esc_1 and esc_3 completely untouched', () => {
    const escalations = parseSessionEscalations([
      makeEscalation({ id: 'esc_1', sessionKey: 's1', status: 'pending', createdAt: 100, updatedAt: 100 }),
      makeEscalation({ id: 'esc_2', sessionKey: 's1', status: 'pending', createdAt: 200, updatedAt: 200 }),
      makeEscalation({ id: 'esc_3', sessionKey: 's1', status: 'acknowledged', createdAt: 300, updatedAt: 300 }),
    ]);

    const result = resolveSessionEscalationState(escalations, 'esc_2', makeResolution(), 999);

    // esc_1 unchanged
    const esc1 = result.escalations.find((e) => e.id === 'esc_1')!;
    expect(esc1.status).toBe('pending');
    expect(esc1.updatedAt).toBe(100);
    expect(esc1.resolution).toBeUndefined();

    // esc_2 resolved
    const esc2 = result.escalations.find((e) => e.id === 'esc_2')!;
    expect(esc2.status).toBe('resolved');
    expect(esc2.updatedAt).toBe(999);

    // esc_3 unchanged
    const esc3 = result.escalations.find((e) => e.id === 'esc_3')!;
    expect(esc3.status).toBe('acknowledged');
    expect(esc3.updatedAt).toBe(300);
    expect(esc3.resolution).toBeUndefined();
  });
});


### function_call_output
@callId call_4a452cfe64404621aab7f0b5
@ts 1770351333745
@durationMs 55
@workItemId 19a7e07e
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import type { GraphDManager } from 'graphd';
import { ContextWindow } from 'context';
import type { ContextWindowSnapshot, MessageItem, FunctionCallOutputItem, FileContentItem } from 'types';
import { SessionStore, type HarnessLogger } from './session_store.js';

const logger: HarnessLogger = {
  info: () => {},
  debug: () => {},
  warning: () => {},
  error: () => {},
};

const DISK_TEST_DIR = path.join(import.meta.dir, '__session_test_tmp__');

describe('SessionStore paused_work_items', () => {
  it('upserts and resolves paused work items idempotently', () => {
    const store = new SessionStore({
      sessionKey: 'session_test',
      maxTokens: 1000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: process.cwd(),
    });

    store.upsertPausedWorkItem({
      workId: 'work_1',
      agentType: 'standard',
      objective: 'Implement feature',
      reason: 'Needs escalation',
      escalationId: 'esc_1',
      timestamp: 100,
    });

    store.upsertPausedWorkItem({
      workId: 'work_1',
      agentType: 'standard',
      reason: 'Still waiting on escalation',
      escalationId: 'esc_1',
      timestamp: 200,
    });

    const [paused] = store.listPausedWorkItems();
    expect(paused.workId).toBe('work_1');
    expect(paused.status).toBe('pending');
    expect(paused.createdAt).toBe(100);
    expect(paused.updatedAt).toBe(200);
    expect(paused.reason).toContain('Still waiting');

    const resolved = store.resolvePausedWorkItem('work_1', 'Resolved by user', 300);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedAt).toBe(300);

    const idempotent = store.resolvePausedWorkItem('work_1', 'Ignored', 400);
    expect(idempotent?.updatedAt).toBe(300);

    const cancelledAfterResolve = store.cancelPausedWorkItem('work_1', 'Should not cancel', 500);
    expect(cancelledAfterResolve?.status).toBe('resolved');
  });

  it('hydrates paused work items from GraphD metadata', () => {
    const fakeGraphd = {
      sessionGet: () => ({
        metadata: {
          paused_work_items: [
            {
              workId: 'work_2',
              agentType: 'explorer',
              objective: 'Investigate issue',
              reason: 'Escalated for decision',
              escalationId: 'esc_2',
              status: 'pending',
              createdAt: 10,
              updatedAt: 11,
            },
          ],
        },
      }),
      contextGet: () => ({}),
      sessionUpdateMetadata: () => ({ success: true }),
    } as unknown as GraphDManager;

    const store = new SessionStore({
      sessionKey: 'session_hydrate',
      maxTokens: 1000,
      graphd: fakeGraphd,
      isGraphDReady: () => true,
      logger,
      workingDir: process.cwd(),
    });

    store.getContext();

    const items = store.listPausedWorkItems();
    expect(items.length).toBe(1);
    expect(items[0].workId).toBe('work_2');
    expect(items[0].agentType).toBe('explorer');
    expect(items[0].escalationId).toBe('esc_2');
    expect(items[0].status).toBe('pending');
  });
});

// ============================================
// DISK-BACKED CONTEXT INTEGRATION
// ============================================

describe('SessionStore disk-backed context', () => {
  beforeEach(() => {
    if (existsSync(DISK_TEST_DIR)) {
      rmSync(DISK_TEST_DIR, { recursive: true });
    }
  });
  afterEach(() => {
    if (existsSync(DISK_TEST_DIR)) {
      rmSync(DISK_TEST_DIR, { recursive: true });
    }
  });

  it('getContext creates disk-backed ContextWindow that writes to disk', () => {
    const store = new SessionStore({
      sessionKey: 'disk-test-1',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx = store.getContext();

    // filePath should be set
    expect(ctx.filePath).not.toBeNull();
    expect(ctx.filePath).toContain('.haiku/sessions');
    expect(ctx.filePath).toContain('disk-test-1');
    expect(ctx.filePath!.endsWith('context.md')).toBe(true);

    // File should exist on disk
    expect(existsSync(ctx.filePath!)).toBe(true);
  });

  it('mutations write through to disk', () => {
    const store = new SessionStore({
      sessionKey: 'disk-wt',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx = store.getContext();
    ctx.addMessage('user', 'Hello from the harness');
    ctx.addFunctionCall('call-1', 'Read', { path: '/foo.ts' });
    ctx.addFunctionCallOutput('call-1', 'export const foo = 42;');

    const content = readFileSync(ctx.filePath!, 'utf-8');
    expect(content).toContain('### message:user');
    expect(content).toContain('Hello from the harness');
    expect(content).toContain('### function_call');
    expect(content).toContain('@name Read');
    expect(content).toContain('### function_call_output');
    expect(content).toContain('export const foo = 42;');
  });

  it('second getContext call returns cached (same) instance', () => {
    const store = new SessionStore({
      sessionKey: 'disk-cache',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store.getContext();
    ctx1.addMessage('user', 'First');

    const ctx2 = store.getContext();
    expect(ctx2).toBe(ctx1); // Same instance
    expect(ctx2.items).toHaveLength(1);
  });

  it('clearContext creates fresh disk-backed context at same path', () => {
    const store = new SessionStore({
      sessionKey: 'disk-clear',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store.getContext();
    ctx1.addMessage('user', 'Old message');
    const firstPath = ctx1.filePath;

    const ctx2 = store.clearContext();
    expect(ctx2.filePath).toBe(firstPath); // Same path
    expect(ctx2.items).toHaveLength(0); // Fresh context

    // Disk file should be empty (no items)
    const content = readFileSync(ctx2.filePath!, 'utf-8');
    expect(content).not.toContain('### message');
    expect(content).toContain('session: disk-clear');
  });

  it('new SessionStore on same workingDir loads persisted items from disk', () => {
    const sessionKey = 'disk-reload';

    // First store: create context and add items
    const store1 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store1.getContext();
    ctx1.addMessage('user', 'Persisted message');
    ctx1.addFileContent('/src/app.ts', 'const app = express();', 'typescript');
    ctx1.addFunctionCall('c1', 'Grep', { pattern: 'TODO' });
    ctx1.addFunctionCallOutput('c1', 'Found 3 TODOs');

    // Close first store (simulates process end)
    store1.close();

    // Second store: same workingDir, same sessionKey — should reload from disk
    const store2 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx2 = store2.getContext();

    // Items should be reloaded from disk
    expect(ctx2.items).toHaveLength(4);

    const msg = ctx2.items[0] as MessageItem;
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Persisted message');

    const fc = ctx2.items[1] as FileContentItem;
    expect(fc.type).toBe('file_content');
    expect(fc.path).toBe('/src/app.ts');
    expect(fc.content).toBe('const app = express();');
    expect(fc.language).toBe('typescript');

    // readFiles should be rebuilt from disk
    expect(ctx2.hasReadFile('/src/app.ts')).toBe(true);
  });

  it('content with --- survives the full SessionStore roundtrip', () => {
    const sessionKey = 'disk-dashes';

    const store1 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx1 = store1.getContext();
    ctx1.addFunctionCallOutput('c1', 'line1\n---\nline2\n---\nline3');
    ctx1.addMessage('assistant', '---');
    ctx1.addFileContent('/x.md', '---\ntitle: test\n---\ncontent');
    store1.close();

    const store2 = new SessionStore({
      sessionKey,
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx2 = store2.getContext();
    expect(ctx2.items).toHaveLength(3);

    expect((ctx2.items[0] as FunctionCallOutputItem).output).toBe('line1\n---\nline2\n---\nline3');
    expect((ctx2.items[1] as MessageItem).content).toBe('---');
    expect((ctx2.items[2] as FileContentItem).content).toBe('---\ntitle: test\n---\ncontent');
  });

  it('hydrateFromSnapshot writes snapshot to disk', () => {
    const store = new SessionStore({
      sessionKey: 'disk-hydrate',
      maxTokens: 100_000,
      graphd: null,
      isGraphDReady: () => false,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    // Create a snapshot from another context
    const sourceCtx = new ContextWindow('disk-hydrate', 100_000);
    sourceCtx.addMessage('user', 'Hydrated message');
    sourceCtx.addMessage('assistant', 'Hydrated response');
    const snapshot = sourceCtx.serialize() as ContextWindowSnapshot;

    store.hydrateFromSnapshot(snapshot);

    const ctx = store.getContext();
    expect(ctx.items).toHaveLength(2);
    expect(ctx.filePath).not.toBeNull();
    expect(existsSync(ctx.filePath!)).toBe(true);

    // Verify disk file has the items
    const content = readFileSync(ctx.filePath!, 'utf-8');
    expect(content).toContain('Hydrated message');
    expect(content).toContain('Hydrated response');
  });

  it('GraphD hydration path also produces disk-backed context', () => {
    const sourceCtx = new ContextWindow('disk-graphd', 100_000);
    sourceCtx.addMessage('user', 'From GraphD');
    const snapshot = sourceCtx.serialize();

    const fakeGraphd = {
      sessionGet: () => ({ metadata: {} }),
      contextGet: () => ({ snapshot: { context: snapshot } }),
      sessionUpdateMetadata: () => ({ success: true }),
    } as unknown as GraphDManager;

    const store = new SessionStore({
      sessionKey: 'disk-graphd',
      maxTokens: 100_000,
      graphd: fakeGraphd,
      isGraphDReady: () => true,
      logger,
      workingDir: DISK_TEST_DIR,
    });

    const ctx = store.getContext();
    expect(ctx.filePath).not.toBeNull();
    expect(ctx.items).toHaveLength(1);
    expect((ctx.items[0] as MessageItem).content).toBe('From GraphD');

    // Disk file should exist with the hydrated content
    expect(existsSync(ctx.filePath!)).toBe(true);
    const content = readFileSync(ctx.filePath!, 'utf-8');
    expect(content).toContain('From GraphD');
  });
});


### message:assistant
@ts 1770351501304
I'll create the test file skeleton for `control_plane_routes.ts`. Let me first examine the existing test patterns and the source file to understand the structure.

[Execution interrupted: Circuit breaker is open for: openai-compat:glm-4.7]

### function_call
@callId call_1a200ad52ac54cc489435496
@name Read
@ts 1770351333233
@workItemId aa7f6782
{"path":"/Users/jevinnishioka/Desktop/jesus/plan-context.md"}

### function_call
@callId call_05835d8da0ff40638afd5e48
@name Read
@ts 1770351333233
@workItemId aa7f6782
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.test.ts"}

### function_call
@callId call_eafa5db34b5246f7afdc76a0
@name Read
@ts 1770351333233
@workItemId aa7f6782
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_1a200ad52ac54cc489435496
@ts 1770351333271
@isError true
@durationMs 29
@workItemId aa7f6782
File not found: /Users/jevinnishioka/Desktop/jesus/plan-context.md

### function_call_output
@callId call_05835d8da0ff40638afd5e48
@ts 1770351333271
@isError true
@durationMs 24
@workItemId aa7f6782
File not found: /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.test.ts

### function_call_output
@callId call_eafa5db34b5246f7afdc76a0
@ts 1770351333280
@durationMs 9
@workItemId aa7f6782
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
    message: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
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

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
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
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
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

function parsePackets(value: unknown): FocusPacket[] {
  // Packets are harness-emitted markdown artifacts used by the frontend focus view.
  if (!Array.isArray(value)) return [];
  const packets: FocusPacket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const packetId = asString(entry.packetId) ?? asString(entry.id);
    const sessionKey = asString(entry.sessionKey);
    const typeRaw = asString(entry.type);
    const markdown = asString(entry.contentMarkdown) ?? asString(entry.markdown);
    const createdMs = parseTimestampMs(entry.createdAt ?? entry.created_at ?? entry.timestamp);
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
      workItemId: asString(entry.workItemId),
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
      ?? asNumber(metadata.invariantsTotal ?? m
... [truncated 50040 chars]

### message:assistant
@ts 1770351501307
I'll help you add tests for the `parseGitLogWithNumstat` function. Let me start by reading the context and existing test file.

[Execution interrupted: Circuit breaker is open for: openai-compat:glm-4.7]

### function_call
@callId call_ba34068db584478da6294650
@name Read
@ts 1770351333117
@workItemId 9c63f1cf
{"path":"/Users/jevinnishioka/Desktop/jesus/plan-context.md"}

### function_call
@callId call_e0602c98b3694feab2917d8c
@name Read
@ts 1770351333117
@workItemId 9c63f1cf
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_ba34068db584478da6294650
@ts 1770351333136
@isError true
@durationMs 14
@workItemId 9c63f1cf
File not found: /Users/jevinnishioka/Desktop/jesus/plan-context.md

### function_call_output
@callId call_e0602c98b3694feab2917d8c
@ts 1770351333136
@durationMs 5
@workItemId 9c63f1cf
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
    message: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
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

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
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
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
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

function parsePackets(value: unknown): FocusPacket[] {
  // Packets are harness-emitted markdown artifacts used by the frontend focus view.
  if (!Array.isArray(value)) return [];
  const packets: FocusPacket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const packetId = asString(entry.packetId) ?? asString(entry.id);
    const sessionKey = asString(entry.sessionKey);
    const typeRaw = asString(entry.type);
    const markdown = asString(entry.contentMarkdown) ?? asString(entry.markdown);
    const createdMs = parseTimestampMs(entry.createdAt ?? entry.created_at ?? entry.timestamp);
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
      workItemId: asString(entry.workItemId),
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
      ?? asNumber(metadata.invariantsTotal ?? m
... [truncated 50040 chars]

### message:assistant
@ts 1770351501309
I'll help you add tests for the `parsePatchEdits` function. Let me start by understanding the context and then examining the existing code.

[Execution interrupted: Circuit breaker is open for: openai-compat:glm-4.7]

### function_call
@callId call_11cda3f07d1c40fdb0325c68
@name Read
@ts 1770351332929
@workItemId 485a02ab
{"path":"/Users/jevinnishioka/Desktop/jesus/plan-context.md"}

### function_call
@callId call_c0e92cf47df748a5ab0b1bde
@name Read
@ts 1770351332929
@workItemId 485a02ab
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.test.ts"}

### function_call
@callId call_b0779df2ea5f4fbabeb8a451
@name Read
@ts 1770351332929
@workItemId 485a02ab
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.ts"}

### function_call_output
@callId call_11cda3f07d1c40fdb0325c68
@ts 1770351332971
@isError true
@durationMs 20
@workItemId 485a02ab
File not found: /Users/jevinnishioka/Desktop/jesus/plan-context.md

### function_call_output
@callId call_c0e92cf47df748a5ab0b1bde
@ts 1770351332971
@isError true
@durationMs 15
@workItemId 485a02ab
File not found: /Users/jevinnishioka/Desktop/jesus/packages/harness-daemon/src/harness/control_plane_routes.test.ts

### function_call_output
@callId call_b0779df2ea5f4fbabeb8a451
@ts 1770351332977
@durationMs 12
@workItemId 485a02ab
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
    message: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
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

function parseNumstatOutput(stdout: string): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let filesTouched = 0;
  const lines = stdout.split('\n');
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
    hotspots.push({
      path,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    });
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

function parsePackets(value: unknown): FocusPacket[] {
  // Packets are harness-emitted markdown artifacts used by the frontend focus view.
  if (!Array.isArray(value)) return [];
  const packets: FocusPacket[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const packetId = asString(entry.packetId) ?? asString(entry.id);
    const sessionKey = asString(entry.sessionKey);
    const typeRaw = asString(entry.type);
    const markdown = asString(entry.contentMarkdown) ?? asString(entry.markdown);
    const createdMs = parseTimestampMs(entry.createdAt ?? entry.created_at ?? entry.timestamp);
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
      workItemId: asString(entry.workItemId),
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
      ?? asNumber(metadata.invariantsTotal ?? m
... [truncated 50040 chars]

### message:assistant
@ts 1770351501313
Work completed before interruption:
tool: /**
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
  type Session...

[Execution interrupted: Circuit breaker is open for: openai-compat:glm-4.7]

### function_call
@callId call_9d22ea9126b24647bd999b21
@name Read
@ts 1770351333047
@workItemId 5ee4fe82
{"path":"/Users/jevinnishioka/Desktop/jesus/plan-context.md"}

### function_call
@callId call_7a171f28e69d4050a0276a55
@name Read
@ts 1770351333047
@workItemId 5ee4fe82
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/server/src/routes/control_plane_routes.ts"}

### function_call
@callId call_137f29f5f4a54bf1922f0b54
@name Read
@ts 1770351333047
@workItemId 5ee4fe82
{"path":"/Users/jevinnishioka/Desktop/jesus/packages/server/src/routes/control_plane_routes.test.ts"}

### function_call_output
@callId call_9d22ea9126b24647bd999b21
@ts 1770351333072
@isError true
@durationMs 19
@workItemId 5ee4fe82
File not found: /Users/jevinnishioka/Desktop/jesus/plan-context.md

### function_call_output
@callId call_7a171f28e69d4050a0276a55
@ts 1770351333072
@isError true
@durationMs 14
@workItemId 5ee4fe82
File not found: /Users/jevinnishioka/Desktop/jesus/packages/server/src/routes/control_plane_routes.ts

### function_call_output
@callId call_137f29f5f4a54bf1922f0b54
@ts 1770351333077
@isError true
@durationMs 6
@workItemId 5ee4fe82
File not found: /Users/jevinnishioka/Desktop/jesus/packages/server/src/routes/control_plane_routes.test.ts

### message:assistant
@ts 1770351501316
I'll start by reading the plan context and understanding the existing code structure.

[Execution interrupted: Circuit breaker is open for: openai-compat:glm-4.7]

### function_call
@callId call_1a92890a1ada4e6a8c5c0d0f
@name Read
@ts 1770351333182
@workItemId 24e08389
{"path":"/Users/jevinnishioka/Desktop/jesus/plan-context.md"}

### function_call
@callId call_40219fe9b43944c79e0852bb
@name Glob
@ts 1770351333182
@workItemId 24e08389
{"pattern":"**/control_plane_routes.ts"}

### function_call
@callId call_b66e272f06c24e26bb73326f
@name Glob
@ts 1770351333182
@workItemId 24e08389
{"pattern":"**/control_plane_routes.test.ts"}

### function_call_output
@callId call_1a92890a1ada4e6a8c5c0d0f
@ts 1770351333209
@isError true
@durationMs 21
@workItemId 24e08389
File not found: /Users/jevinnishioka/Desktop/jesus/plan-context.md

### function_call_output
@callId call_40219fe9b43944c79e0852bb
@ts 1770351333209
@durationMs 16
@workItemId 24e08389
packages/harness-daemon/src/harness/control_plane_routes.ts

### function_call_output
@callId call_b66e272f06c24e26bb73326f
@ts 1770351333214
@durationMs 7
@workItemId 24e08389
No files found matching pattern: **/control_plane_routes.test.ts (try ../pattern or ../../pattern for sibling directories)

### message:assistant
@ts 1770351501318
I'll help you write comprehensive tests for the Git-related utility functions. Let me start by reading the plan context and the relevant source files.

[Execution interrupted: Circuit breaker is open for: openai-compat:glm-4.7]
