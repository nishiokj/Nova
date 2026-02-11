/**
 * Git/diff utility functions extracted from control_plane_routes.ts
 *
 * Handles: git remote info, PR fetching, commit SHA resolution,
 * diff parsing/analysis, trace summaries, patch application.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import nodePath from 'path';
import {
  type ControlPlaneContext,
  type PRInfo,
  type GitRemote,
  type GitCommitInfo,
  type SessionRow,
  type SessionCommitEvent,
  type PatchEditInput,
  type SessionFileModification,
  type SessionDiffLineRange,
  type DiffHotspot,
  type TraceSummary,
  type TestReportRecord,
  type TestReportSummary,
  sendJson,
  readJsonBody,
  readBody,
  isRecord,
  asString,
  asNumber,
  asBoolean,
  normalizeSha,
  shaMatches,
  escapeRegExp,
  isLockfilePath,
  normalizeDiffPath,
  execAsync,
  execFileAsync,
  execFileText,
  prCache,
  PR_CACHE_TTL_MS,
  gitRemoteCache,
  GIT_CACHE_TTL_MS,
  formatSession,
  parseTimestampMs,
  toStringOutput,
} from './utils.js';
import { getSession } from './sessions.js';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type DiffLineRange = { start: number; end: number; added: number; deleted: number };

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

const SESSION_DIFFSTAT_CACHE_TTL_MS = 30_000;
const sessionDiffstatRangeCache = new Map<string, {
  fetchedAt: number;
  summary: { added: number; deleted: number; filesTouched: number };
}>();

function getCachedSessionDiffstat(
  cacheKey: string,
  nowMs: number
): { added: number; deleted: number; filesTouched: number } | null {
  const cached = sessionDiffstatRangeCache.get(cacheKey);
  if (!cached) return null;
  if (nowMs - cached.fetchedAt > SESSION_DIFFSTAT_CACHE_TTL_MS) {
    sessionDiffstatRangeCache.delete(cacheKey);
    return null;
  }
  return cached.summary;
}

function setCachedSessionDiffstat(
  cacheKey: string,
  summary: { added: number; deleted: number; filesTouched: number },
  nowMs: number
): void {
  sessionDiffstatRangeCache.set(cacheKey, { fetchedAt: nowMs, summary });
  if (sessionDiffstatRangeCache.size <= 1024) return;

  for (const [key, value] of sessionDiffstatRangeCache.entries()) {
    if (nowMs - value.fetchedAt > SESSION_DIFFSTAT_CACHE_TTL_MS) {
      sessionDiffstatRangeCache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Git Remote & Info
// ---------------------------------------------------------------------------

export async function ghCommand(args: string, cwd?: string): Promise<string> {
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
export async function getPRs(owner: string, repo: string): Promise<PRInfo[]> {
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
export async function getGitRemote(projectPath: string): Promise<GitRemote | null> {
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
export async function getRecentCommits(projectPath: string, limit = 10): Promise<GitCommitInfo[]> {
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

// ---------------------------------------------------------------------------
// SHA & Commit Utilities
// ---------------------------------------------------------------------------

export function getSessionCommitEvents(session: SessionRow): SessionCommitEvent[] {
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

export function findSessionCommitBySha(events: SessionCommitEvent[], sha: string): SessionCommitEvent | undefined {
  for (const event of events) {
    if (shaMatches(event.sha, sha)) return event;
  }
  return undefined;
}

export function getLatestRevisionRange(
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

// ---------------------------------------------------------------------------
// Diff Parsing & Analysis
// ---------------------------------------------------------------------------

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

export function parseNumstatOutput(stdout: string, patch?: string | null): { summary: { added: number; deleted: number; filesTouched: number }; hotspots: DiffHotspot[] } {
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

function splitNormalizedLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function toSessionRelativePath(rawPath: string, workingDir: string | null): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const slashNormalized = trimmed.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const normalized = normalizeDiffPath(slashNormalized);
  if (!normalized) return null;

  if (!workingDir) {
    return normalized;
  }

  const base = nodePath.resolve(workingDir);
  const absoluteCandidate = nodePath.isAbsolute(normalized)
    ? nodePath.resolve(normalized)
    : nodePath.resolve(base, normalized);
  const inWorkingDir = absoluteCandidate === base || absoluteCandidate.startsWith(`${base}${nodePath.sep}`);
  if (!inWorkingDir) {
    return null;
  }
  const relative = nodePath.relative(base, absoluteCandidate).replace(/\\/g, '/');
  return normalizeDiffPath(relative);
}

export function collectSessionFileModifications(session: SessionRow, fileFilterRaw?: string): SessionFileModification[] {
  const events = Array.isArray(session.metadata?.agent_events) ? session.metadata.agent_events : [];
  const normalizedFilter = fileFilterRaw
    ? toSessionRelativePath(fileFilterRaw, session.workingDir)
    : undefined;
  const modifications: SessionFileModification[] = [];

  for (const entry of events) {
    if (!isRecord(entry)) continue;
    if (asString(entry.type) !== 'tool_call') continue;

    const data = isRecord(entry.data) ? entry.data : {};
    const phase = asString(data.phase)?.toLowerCase();
    const success = asBoolean(data.success);
    if (phase !== 'completed' || success !== true) continue;

    const rawToolName = asString(data.tool_name) ?? asString(data.toolName) ?? '';
    const normalizedToolName = rawToolName.toLowerCase().replace(/[_\s-]+/g, '');
    const toolKind = normalizedToolName === 'write' || normalizedToolName === 'filewrite'
      ? 'write'
      : normalizedToolName === 'edit' || normalizedToolName === 'fileedit' || normalizedToolName === 'batchedit'
        ? 'edit'
        : null;
    if (!toolKind) continue;

    const args = isRecord(data.arguments) ? data.arguments : {};
    const rawPath = asString(args.path)
      ?? asString(args.file_path)
      ?? asString(args.filePath)
      ?? asString(args.absolute_path);
    if (!rawPath) continue;
    const normalizedPath = toSessionRelativePath(rawPath, session.workingDir);
    if (!normalizedPath) continue;
    if (normalizedFilter && normalizedPath !== normalizedFilter) continue;

    const timestampMs =
      parseTimestampMs(entry.timestamp)
      ?? parseTimestampMs(data.timestamp)
      ?? Date.now();
    const requestId = asString(entry.request_id) ?? asString(data.request_id) ?? asString(data.requestId);
    const workItemId = asString(entry.work_item_id) ?? asString(data.work_item_id) ?? asString(data.workItemId);

    modifications.push({
      path: normalizedPath,
      toolName: toolKind,
      timestampMs,
      ...(requestId ? { requestId } : {}),
      ...(workItemId ? { workItemId } : {}),
      ...(typeof args.old_string === 'string'
        ? { oldContent: args.old_string }
        : typeof args.oldString === 'string'
          ? { oldContent: args.oldString }
          : {}),
      ...(typeof args.new_string === 'string'
        ? { newContent: args.new_string }
        : typeof args.newString === 'string'
          ? { newContent: args.newString }
          : {}),
      ...(typeof args.content === 'string' ? { content: args.content } : {}),
    });
  }

  modifications.sort((a, b) => a.timestampMs - b.timestampMs);
  return modifications;
}

function computeEditDeltaRange(oldContent: string, newContent: string): SessionDiffLineRange | null {
  const oldLines = splitNormalizedLines(oldContent);
  const newLines = splitNormalizedLines(newContent);

  let prefix = 0;
  const sharedPrefixMax = Math.min(oldLines.length, newLines.length);
  while (prefix < sharedPrefixMax && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const deleted = Math.max(0, oldSuffix - prefix + 1);
  const added = Math.max(0, newSuffix - prefix + 1);
  if (added === 0 && deleted === 0) return null;

  const start = prefix + 1;
  const end = added > 0 ? start + added - 1 : start;
  return { start, end, added, deleted };
}

function deriveModificationRange(modification: SessionFileModification): SessionDiffLineRange | null {
  if (modification.toolName === 'write') {
    if (typeof modification.content !== 'string') return null;
    const lineCount = splitNormalizedLines(modification.content).length;
    return {
      start: 1,
      end: Math.max(1, lineCount),
      added: lineCount,
      deleted: 0,
    };
  }

  if (modification.toolName === 'edit') {
    const oldContent = modification.oldContent ?? '';
    const newContent = modification.newContent ?? '';
    return computeEditDeltaRange(oldContent, newContent);
  }

  return null;
}

function buildSessionModificationPreview(modification: SessionFileModification): string | null {
  const label = modification.toolName === 'write' ? 'Write' : 'Edit';
  const headerParts = [
    `[${new Date(modification.timestampMs).toISOString()}] ${label}`,
    ...(modification.requestId ? [`request=${modification.requestId}`] : []),
  ];

  if (modification.toolName === 'write') {
    if (typeof modification.content !== 'string') return null;
    const lines = splitNormalizedLines(modification.content);
    const capped = lines.slice(0, 120).map((line) => `+ ${line}`);
    if (lines.length > capped.length) capped.push(`... (${lines.length - capped.length} more lines)`);
    return `${headerParts.join(' ')}\n${capped.join('\n')}`;
  }

  if (typeof modification.oldContent !== 'string' && typeof modification.newContent !== 'string') {
    return null;
  }

  const oldLines = splitNormalizedLines(modification.oldContent ?? '');
  const newLines = splitNormalizedLines(modification.newContent ?? '');
  const oldPreview = oldLines.slice(0, 80).map((line) => `- ${line}`);
  const newPreview = newLines.slice(0, 80).map((line) => `+ ${line}`);
  if (oldLines.length > oldPreview.length) oldPreview.push(`... (${oldLines.length - oldPreview.length} more old lines)`);
  if (newLines.length > newPreview.length) newPreview.push(`... (${newLines.length - newPreview.length} more new lines)`);
  return `${headerParts.join(' ')}\n${[...oldPreview, ...newPreview].join('\n')}`;
}

export function buildSessionDiffFromEvents(
  session: SessionRow,
  fileFilterRaw?: string
): {
  baseSha: string;
  headSha: string;
  source: 'session';
  summary: { added: number; deleted: number; filesTouched: number };
  hotspots: DiffHotspot[];
  patch: string | null;
  latestTimestampMs: number;
} | null {
  const modifications = collectSessionFileModifications(session);
  if (modifications.length === 0) return null;

  const normalizedFilter = fileFilterRaw
    ? toSessionRelativePath(fileFilterRaw, session.workingDir)
    : undefined;
  const perFile = new Map<string, {
    added: number;
    deleted: number;
    ranges: SessionDiffLineRange[];
    previews: string[];
  }>();
  let latestTimestampMs = 0;

  for (const modification of modifications) {
    latestTimestampMs = Math.max(latestTimestampMs, modification.timestampMs);
    const current = perFile.get(modification.path) ?? {
      added: 0,
      deleted: 0,
      ranges: [],
      previews: [],
    };
    const delta = deriveModificationRange(modification);
    if (delta) {
      current.added += delta.added;
      current.deleted += delta.deleted;
      current.ranges.push(delta);
    }
    if (normalizedFilter && modification.path === normalizedFilter) {
      const preview = buildSessionModificationPreview(modification);
      if (preview) current.previews.push(preview);
    }
    perFile.set(modification.path, current);
  }

  const hotspots: DiffHotspot[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const [filePath, stats] of perFile.entries()) {
    totalAdded += stats.added;
    totalDeleted += stats.deleted;
    const topRanges = stats.ranges
      .slice()
      .sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted))
      .slice(0, 3);
    hotspots.push({
      path: filePath,
      added: stats.added,
      deleted: stats.deleted,
      ...(topRanges.length > 0
        ? {
            lineRanges: topRanges.map((range) => ({
              start: range.start,
              end: range.end,
              added: range.added,
              deleted: range.deleted,
            })),
          }
        : {}),
    });
  }
  hotspots.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));

  let patch: string | null = null;
  if (normalizedFilter) {
    const previews = perFile.get(normalizedFilter)?.previews ?? [];
    if (previews.length > 0) {
      const rendered = previews.join('\n\n');
      patch = rendered.length > 500_000 ? `${rendered.slice(0, 500_000)}\n\n... (truncated)` : rendered;
    }
  }

  const firstTs = modifications[0]?.timestampMs ?? latestTimestampMs;
  const baseSha = `session:${session.sessionKey}:${Math.max(0, Math.floor(firstTs / 1000))}`;
  const headSha = `session:${session.sessionKey}:${Math.max(0, Math.floor(latestTimestampMs / 1000))}`;

  return {
    baseSha,
    headSha,
    source: 'session',
    summary: {
      added: totalAdded,
      deleted: totalDeleted,
      filesTouched: perFile.size,
    },
    hotspots: hotspots.slice(0, 100),
    patch,
    latestTimestampMs,
  };
}

// ---------------------------------------------------------------------------
// Trace & Test Utilities
// ---------------------------------------------------------------------------

export function buildSessionTraceSummaryFromEvents(session: SessionRow): TraceSummary {
  const modifications = collectSessionFileModifications(session);
  if (modifications.length === 0) {
    return { filesTouched: 0 };
  }

  const files = new Set<string>();
  let latestTimestampMs = 0;
  let lastFile: string | undefined;
  let lastLine: number | undefined;

  for (const modification of modifications) {
    files.add(modification.path);
    const delta = deriveModificationRange(modification);
    if (modification.timestampMs >= latestTimestampMs) {
      latestTimestampMs = modification.timestampMs;
      lastFile = modification.path;
      if (delta) {
        lastLine = delta.end;
      }
    }
  }

  return {
    filesTouched: files.size,
    ...(lastFile ? { lastFile } : {}),
    ...(typeof lastLine === 'number' ? { lastLine } : {}),
    ...(latestTimestampMs > 0 ? { latestTimestampMs } : {}),
  };
}

export function buildSessionEventTraceRecords(session: SessionRow, limit: number): Array<Record<string, unknown>> {
  const modifications = collectSessionFileModifications(session);
  if (modifications.length === 0) return [];

  const grouped = new Map<string, {
    timestampMs: number;
    requestId?: string;
    workItemId?: string;
    modifications: SessionFileModification[];
  }>();
  let anonymousCounter = 0;

  for (const modification of modifications) {
    const key = modification.requestId
      ? `request:${modification.requestId}`
      : `anonymous:${++anonymousCounter}:${modification.timestampMs}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        timestampMs: modification.timestampMs,
        ...(modification.requestId ? { requestId: modification.requestId } : {}),
        ...(modification.workItemId ? { workItemId: modification.workItemId } : {}),
        modifications: [modification],
      });
      continue;
    }
    existing.modifications.push(modification);
    existing.timestampMs = Math.max(existing.timestampMs, modification.timestampMs);
    if (!existing.workItemId && modification.workItemId) {
      existing.workItemId = modification.workItemId;
    }
  }

  const records: Array<Record<string, unknown>> = [];
  const groups = Array.from(grouped.values()).sort((a, b) => a.timestampMs - b.timestampMs);
  for (const [index, group] of groups.entries()) {
    const fileMap = new Map<string, SessionDiffLineRange[]>();
    for (const modification of group.modifications) {
      const delta = deriveModificationRange(modification) ?? { start: 1, end: 1, added: 0, deleted: 0 };
      const ranges = fileMap.get(modification.path) ?? [];
      ranges.push(delta);
      fileMap.set(modification.path, ranges);
    }
    if (fileMap.size === 0) continue;

    const files = Array.from(fileMap.entries()).map(([filePath, ranges]) => ({
      path: filePath,
      conversations: [
        {
          url: `session://${session.sessionKey}`,
          contributor: { type: 'ai' },
          ranges: ranges.slice(0, 16).map((range) => ({
            start_line: range.start,
            end_line: range.end,
          })),
        },
      ],
    }));

    const revision = `session:${session.sessionKey}:${Math.max(0, Math.floor(group.timestampMs / 1000))}:${index + 1}`;
    records.push({
      version: '0.1',
      id: `session-trace-${session.sessionKey}-${Math.max(0, Math.floor(group.timestampMs))}-${index + 1}`,
      timestamp: new Date(group.timestampMs).toISOString(),
      vcs: { type: 'git', revision },
      tool: { name: 'session-events', version: '1.0.0' },
      files,
      metadata: {
        source: 'session-events',
        sessionKey: session.sessionKey,
        ...(group.requestId ? { requestId: group.requestId } : {}),
        ...(group.workItemId ? { workItemId: group.workItemId } : {}),
      },
    });
  }

  return records
    .sort((a, b) => {
      const left = parseTimestampMs((a as Record<string, unknown>).timestamp) ?? 0;
      const right = parseTimestampMs((b as Record<string, unknown>).timestamp) ?? 0;
      return right - left;
    })
    .slice(0, Math.max(1, limit));
}

export function isSyntheticSessionRevision(revision: string | undefined): boolean {
  if (!revision) return false;
  return revision.startsWith('session:');
}

// ---------------------------------------------------------------------------
// Git log with numstat
// ---------------------------------------------------------------------------

export function parseGitLogWithNumstat(stdout: string, projectPath: string): CommitRollup[] {
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

// ---------------------------------------------------------------------------
// Session diffstats & test report mapping
// ---------------------------------------------------------------------------

export async function loadSessionDiffstats(
  sessions: SessionRow[]
): Promise<Map<string, { added: number; deleted: number; filesTouched: number }>> {
  const bySession = new Map<string, { added: number; deleted: number; filesTouched: number }>();
  const cachedByRange = new Map<string, { added: number; deleted: number; filesTouched: number }>();

  for (const session of sessions) {
    const sessionDiff = buildSessionDiffFromEvents(session);
    if (sessionDiff && sessionDiff.summary.filesTouched > 0) {
      bySession.set(session.sessionKey, sessionDiff.summary);
      continue;
    }

    // No session-local edit/commit lineage yet: report zeros instead of
    // falling back to git diff between commits, which would show global
    // workspace changes not tied to this session.
    bySession.set(session.sessionKey, { added: 0, deleted: 0, filesTouched: 0 });
  }

  return bySession;
}

export function mapTestReportRow(row: TestReportRecord): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// Patch stats, edits, path resolution, constraints
// ---------------------------------------------------------------------------

export function parsePatchStats(patch: string): {
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

export function parsePatchEdits(value: unknown): PatchEditInput[] {
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

export async function resolveSessionFilePath(workingDir: string, relativePath: string): Promise<{
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

export async function enforcePatchConstraints(
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

// ---------------------------------------------------------------------------
// Diff Resolution Handlers
// ---------------------------------------------------------------------------

export async function resolveDiffRange(
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
    const commitEvents = getSessionCommitEvents(session);
    const hasSessionCommitLineage = commitEvents.length > 0;
    const fromSession = getLatestRevisionRange(session, queryHead ?? undefined);
    if (hasSessionCommitLineage && fromSession.headSha && fromSession.baseSha) {
      return { ...fromSession, source: 'session' };
    }
    if (hasSessionCommitLineage && fromSession.headSha) {
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

export async function resolveRepoHeadRange(
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

export async function resolveWorkingTreeDiff(
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

// ---------------------------------------------------------------------------
// Patch Apply Functions
// ---------------------------------------------------------------------------

export async function ensureBaseSha(
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

export async function applyUnifiedDiffPatch(
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

export async function applyStructuredEdits(
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

// ---------------------------------------------------------------------------
// Patch Apply Handler
// ---------------------------------------------------------------------------

export async function handlePostCockpitPatchApply(
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
