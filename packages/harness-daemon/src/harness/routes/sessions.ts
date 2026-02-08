/**
 * Session & Project route handlers extracted from control_plane_routes.ts
 *
 * Covers:
 * - Session query utilities (getAllSessions, getSession, groupSessionsByWorkingDir)
 * - Project/Feature handlers
 * - Session CRUD handlers
 * - Session control handlers (message, control, review)
 * - SSE event stream
 */

import type { IncomingMessage, ServerResponse } from 'http';
import nodePath from 'path';
import {
  type ControlPlaneContext,
  sendJson,
  readBody,
  readJsonBody,
  matchRoute,
  isRecord,
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  extractText,
  execAsync,
  type SessionRow,
  type MessageRow,
  formatSession,
  formatMessage,
  parseTimestampMs,
  parseAgentEventTokenTotalsForDay,
  ALL_SESSION_STATUSES,
  parseUrl,
  withAgentMemorySql,
} from './utils.js';
import {
  ghCommand,
  getPRs,
  getGitRemote,
  getRecentCommits,
  buildSessionEventTraceRecords,
  loadSessionDiffstats,
  getSessionCommitEvents,
  parseGitLogWithNumstat,
} from './git.js';
import {
  buildMarkdownMessageContext,
} from './markdown.js';
import { deleteSession } from '../session_queries.js';

// ---------------------------------------------------------------------------
// Session query utilities
// ---------------------------------------------------------------------------

function normalizeSessionTimestampToSeconds(value: unknown, fallbackSeconds: number): number {
  const parsedMs = parseTimestampMs(value);
  if (typeof parsedMs === 'number' && Number.isFinite(parsedMs) && parsedMs > 0) {
    return Math.floor(parsedMs / 1000);
  }
  return fallbackSeconds;
}

function normalizeSessionRow(row: SessionRow): SessionRow {
  const record = row as unknown as Record<string, unknown>;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const createdAtSeconds = normalizeSessionTimestampToSeconds(record.createdAt, nowSeconds);
  const lastAccessedAtSeconds = normalizeSessionTimestampToSeconds(record.lastAccessedAt, createdAtSeconds);
  return {
    ...row,
    createdAt: createdAtSeconds,
    lastAccessedAt: lastAccessedAtSeconds,
  };
}

export function getAllSessions(
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
  const normalized = Array.isArray(result.sessions)
    ? result.sessions.map(normalizeSessionRow)
    : [];
  return {
    sessions: normalized,
    ...(result.error ? { error: result.error } : {}),
  };
}

export function getSession(ctx: ControlPlaneContext, sessionKey: string): SessionRow | null {
  if (!ctx.isGraphDReady() || !ctx.graphd) return null;
  const result = ctx.graphd.sessionGet(sessionKey) as { session?: SessionRow };
  return result.session ? normalizeSessionRow(result.session) : null;
}

export function groupSessionsByWorkingDir(sessions: SessionRow[]): Map<string, SessionRow[]> {
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

// ---------------------------------------------------------------------------
// SSE Event Stream
// ---------------------------------------------------------------------------

export function handleSSEEventStream(req: IncomingMessage, res: ServerResponse, ctx: ControlPlaneContext): void {
  if (!ctx.subscribeEvents) {
    sendJson(res, { error: 'Event bus not available' }, 503);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write('data: {"type":"connected"}\n\n');

  const keepalive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { /* closed */ }
  }, 15_000);

  const unsubscribe = ctx.subscribeEvents((event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* closed */ }
  });

  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
  });
}

// ---------------------------------------------------------------------------
// Project / Feature Handlers
// ---------------------------------------------------------------------------

export function handleGetProjects(res: ServerResponse, ctx: ControlPlaneContext): void {
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
export async function handleGetFeatures(res: ServerResponse, _ctx: ControlPlaneContext, projectPath: string): Promise<void> {
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
export function handleGetProjectSessions(res: ServerResponse, ctx: ControlPlaneContext, projectPath: string): void {
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
export async function handleGetPRs(res: ServerResponse, branch: string, owner: string | null, repo: string | null): Promise<void> {
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

// ---------------------------------------------------------------------------
// Session Handlers
// ---------------------------------------------------------------------------

/**
 * GET /control-plane/sessions
 * List all recent sessions
 */
export function handleGetSessions(res: ServerResponse, ctx: ControlPlaneContext, limit: number): void {
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
export function handleGetSession(res: ServerResponse, ctx: ControlPlaneContext, sessionKey: string): void {
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
 * DELETE /control-plane/sessions/:id
 */
export function handleDeleteSession(res: ServerResponse, ctx: ControlPlaneContext, sessionKey: string): void {
  try {
    const result = deleteSession(ctx.isGraphDReady() ? (ctx.graphd ?? null) : null, sessionKey);
    if (!result.success && result.error) {
      sendJson(res, { deleted: false, sessionKey, error: result.error }, 503);
      return;
    }
    sendJson(res, { deleted: result.deleted, sessionKey });
  } catch (error) {
    console.error('[control-plane] Error deleting session:', error);
    sendJson(res, { deleted: false, sessionKey, error: String(error) });
  }
}

/**
 * GET /control-plane/sessions/:id/messages
 * Get messages for a session
 */
export function handleGetSessionMessages(res: ServerResponse, ctx: ControlPlaneContext, sessionKey: string): void {
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
export function handleGetGoalHierarchy(res: ServerResponse): void {
  // TODO: Wire up to agent-memory's goals repository
  sendJson(res, { goals: [], note: 'Goals are stored in agent-memory (PostgreSQL), not yet integrated' });
}

/**
 * GET /control-plane/token-usage
 * Get token usage from session metadata
 */
export function handleGetTokenUsage(res: ServerResponse, ctx: ControlPlaneContext): void {
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
export async function handleGetGitInfo(res: ServerResponse, projectPath: string): Promise<void> {
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
export async function handleGetTraces(res: ServerResponse, ctx: ControlPlaneContext, limit: number): Promise<void> {
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
export async function handleGetTraceByRevision(res: ServerResponse, ctx: ControlPlaneContext, revision: string): Promise<void> {
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
export function handleGetLiveSessions(res: ServerResponse, ctx: ControlPlaneContext): void {
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

// ---------------------------------------------------------------------------
// Session Control Handlers
// ---------------------------------------------------------------------------

export async function handlePostSessionMessage(
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
      const result = await ctx.forkSession(sessionKey, targetSessionKey);
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
      const result = await ctx.stopSession(sessionKey, note);
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

    const fallbackResult = await ctx.dispatchSessionInput(sessionKey, note);
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

  const markdownContextValue = body.markdownContext ?? body.documentContext ?? body.activeDocument;
  const [contextBuild, workflowTemplateDispatch] = await Promise.all([
    buildMarkdownMessageContext(ctx, markdownContextValue),
    maybeBuildWorkflowTemplateDispatch(
      ctx,
      session,
      message,
      markdownContextValue
    ),
  ]);
  if (!contextBuild.ok) {
    sendJson(res, { success: false, error: contextBuild.error }, contextBuild.status);
    return;
  }
  if (!workflowTemplateDispatch.ok) {
    sendJson(res, { success: false, error: workflowTemplateDispatch.error }, workflowTemplateDispatch.status);
    return;
  }
  const dispatchMetadata = workflowTemplateDispatch.applied
    ? {
        ...(contextBuild.contextMetadata ?? {}),
        ...workflowTemplateDispatch.dispatchMetadata,
      }
    : contextBuild.contextMetadata;

  const contextMetadataRecord = isRecord(contextBuild.contextMetadata)
    ? contextBuild.contextMetadata
    : {};
  const writeTargetPath = asString(contextMetadataRecord.writeTargetPath)
    ?? asString(contextMetadataRecord.absolutePath);
  if (writeTargetPath) {
    const sessionWorkingDir = session.workingDir ?? '';
    const resolvedTargetPath = nodePath.resolve(writeTargetPath);
    const resolvedSessionRoot = sessionWorkingDir ? nodePath.resolve(sessionWorkingDir) : '';
    const allowOutsideRoot = !!(
      resolvedSessionRoot
      && resolvedTargetPath !== resolvedSessionRoot
      && !resolvedTargetPath.startsWith(`${resolvedSessionRoot}${nodePath.sep}`)
    );
    try {
      await ctx.updateSessionPermissionState?.(
        sessionKey,
        {
          dangerousMode: false,
          allowOutsideRoot,
          restrictWriteToPaths: [writeTargetPath],
        },
        { workingDir: session.workingDir ?? undefined }
      );
    } catch {
      // Permission updates are best-effort; never block chat dispatch.
    }
  }

  const messageDispatchOptions = contextBuild.contextText
    ? {
        context: contextBuild.contextText,
        ...(dispatchMetadata ? { metadata: dispatchMetadata } : {}),
      }
    : (
      dispatchMetadata
        ? { metadata: dispatchMetadata }
        : undefined
    );
  if (ctx.graphd && contextBuild.contextMetadata) {
    try {
      ctx.graphd.sessionUpdateMetadata(sessionKey, {
        cockpit_active_markdown: {
          ...contextBuild.contextMetadata,
          attachedAt: new Date().toISOString(),
        },
        cockpit_chat_scope: {
          mode: 'document',
          source: 'markdown-editor',
          path: asString(contextMetadataRecord.path) ?? null,
          scopeMode: asString(contextMetadataRecord.scopeMode) ?? null,
          ...(writeTargetPath ? { writeTargetPath } : {}),
          updatedAt: new Date().toISOString(),
        },
      });
    } catch {
      // Best-effort metadata update; never block chat dispatch.
    }
  }
  const result = await ctx.dispatchSessionInput(sessionKey, message, messageDispatchOptions);
  if (!result.success) {
    sendJson(res, { success: false, error: result.error ?? 'Failed to dispatch message' }, 400);
    return;
  }
  if (ctx.graphd && workflowTemplateDispatch.applied) {
    try {
      ctx.graphd.sessionUpdateMetadata(sessionKey, workflowTemplateDispatch.metadataPatch);
    } catch {
      // Best-effort metadata update; dispatch should succeed even if metadata fails.
    }
  }
  const markdownContextAttached = !!(
    messageDispatchOptions
    && 'context' in messageDispatchOptions
    && typeof messageDispatchOptions.context === 'string'
    && messageDispatchOptions.context.length > 0
  );
  sendJson(res, {
    success: true,
    sessionKey,
    requestId: result.requestId ?? null,
    queued: result.queued ?? false,
    markdownContextAttached,
    workflowTemplateApplied: workflowTemplateDispatch.applied,
    ...(workflowTemplateDispatch.applied && workflowTemplateDispatch.templateId
      ? {
          workflowTemplate: {
            id: workflowTemplateDispatch.templateId,
            name: workflowTemplateDispatch.templateName,
          },
        }
      : {}),
  });
}

export function buildForkSessionKey(sourceSessionKey: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${sourceSessionKey}-fork-${Date.now().toString(36)}-${suffix}`;
}

export async function handlePostSessionControl(
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
    const result = await ctx.forkSession(sessionKey, targetSessionKey);
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
      const result = await ctx.stopSession(sessionKey, asString(body.note));
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
    const fallbackResult = await ctx.dispatchSessionInput(
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
  const result = await ctx.dispatchSessionInput(sessionKey, resumeMessage);
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

export async function handlePostSessionReviewDecision(
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

// ---------------------------------------------------------------------------
// Workflow Template Functions
// ---------------------------------------------------------------------------

interface WorkflowTemplateHint {
  templateId?: string;
  templateName?: string;
  documentType?: string;
  markdownPath?: string;
  inlineSpecs?: WorkflowTemplateSpecRuntime[];
  inlineGoal?: string;
}

interface WorkflowTemplateSpecRuntime {
  id: string;
  objective: string;
  agent: string;
  dependencies: string[];
  domain?: string;
  targetPaths?: string[];
}

interface WorkflowTemplateRuntimeRecord {
  id: string;
  name: string;
  description: string;
  specs: WorkflowTemplateSpecRuntime[];
}

type WorkflowTemplateDispatchResult =
  | { ok: true; applied: false }
  | {
      ok: true;
      applied: true;
      dispatchMetadata: Record<string, unknown>;
      metadataPatch: Record<string, unknown>;
      templateId?: string;
      templateName?: string;
      source: 'db-template' | 'inline';
    }
  | { ok: false; status: number; error: string };

function parseSimpleFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex < 1) continue;
    const key = line.slice(0, colonIndex).trim();
    let raw = line.slice(colonIndex + 1).trim();
    if (!key || raw.length === 0) continue;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1);
      frontmatter[key] = inner
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      continue;
    }
    if (raw === 'true') {
      frontmatter[key] = true;
      continue;
    }
    if (raw === 'false') {
      frontmatter[key] = false;
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      frontmatter[key] = Number(raw);
      continue;
    }
    if (
      raw.length >= 2
      && (
        (raw.startsWith('"') && raw.endsWith('"'))
        || (raw.startsWith('\'') && raw.endsWith('\''))
      )
    ) {
      raw = raw.slice(1, -1);
    }
    frontmatter[key] = raw;
  }
  return frontmatter;
}

function normalizeTemplateToken(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Inline Workflow Spec Parsing
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function deduplicateId(id: string, seen: Set<string>): string {
  if (!seen.has(id)) { seen.add(id); return id; }
  let n = 2;
  while (seen.has(`${id}-${n}`)) n++;
  const deduped = `${id}-${n}`;
  seen.add(deduped);
  return deduped;
}

function parseSpecMetadataBullets(
  lines: string[]
): { agent?: string; dependencies: string[]; targetPaths: string[]; domain?: string } {
  let agent: string | undefined;
  let domain: string | undefined;
  const dependencies: string[] = [];
  const targetPaths: string[] = [];

  for (const line of lines) {
    const m = line.match(/^\s*-\s+(.+)$/);
    if (!m) continue;
    const kv = m[1].match(/^([^:]+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const val = kv[2].trim();
    if (key === 'agent') {
      agent = val;
    } else if (key === 'domain') {
      domain = val;
    } else if (key === 'files' || key === 'paths' || key === 'targetpaths' || key === 'target_paths') {
      targetPaths.push(...val.split(',').map(s => s.trim()).filter(Boolean));
    } else if (key === 'depends on' || key === 'dependencies') {
      dependencies.push(...val.split(',').map(s => s.trim()).filter(Boolean));
    }
  }

  return {
    ...(agent ? { agent } : {}),
    dependencies,
    targetPaths,
    ...(domain ? { domain } : {}),
  };
}

function parseHeadingSpecs(body: string): WorkflowTemplateSpecRuntime[] {
  const sections = body.split(/^### /m);
  const specs: WorkflowTemplateSpecRuntime[] = [];
  const seen = new Set<string>();

  for (const section of sections) {
    if (!section.trim()) continue;
    const lines = section.split('\n');
    const heading = lines[0].trim();
    if (!heading) continue;

    const id = deduplicateId(slugify(heading), seen);
    const contentLines = lines.slice(1);
    const objectiveLines: string[] = [];
    const metaLines: string[] = [];

    for (const line of contentLines) {
      if (/^\s*-\s+\S+:/.test(line)) {
        metaLines.push(line);
      } else if (line.trim().length > 0 && metaLines.length === 0) {
        objectiveLines.push(line.trim());
      }
    }

    const objective = objectiveLines.join(' ').trim();
    if (!objective) continue;

    const meta = parseSpecMetadataBullets(metaLines);
    const spec = normalizeWorkflowTemplateSpec({
      id,
      objective,
      ...meta,
    }, specs.length);
    if (spec) specs.push(spec);
  }

  return specs;
}

function parseNumberedListSpecs(body: string): WorkflowTemplateSpecRuntime[] {
  const specs: WorkflowTemplateSpecRuntime[] = [];
  const lines = body.split('\n');
  let currentNumber: number | null = null;
  let currentObjective = '';
  let currentMeta: string[] = [];

  const flush = () => {
    if (currentNumber === null || !currentObjective.trim()) return;
    const meta = parseSpecMetadataBullets(currentMeta);
    // Normalize numeric dependency references to step-N IDs
    const deps = meta.dependencies.map(d => /^\d+$/.test(d) ? `step-${d}` : d);
    const spec = normalizeWorkflowTemplateSpec({
      id: `step-${currentNumber}`,
      objective: currentObjective.trim(),
      agent: meta.agent,
      dependencies: deps,
      targetPaths: meta.targetPaths,
      domain: meta.domain,
    }, specs.length);
    if (spec) specs.push(spec);
  };

  for (const line of lines) {
    const numbered = line.match(/^(\d+)\.\s+(.+)$/);
    if (numbered) {
      flush();
      currentNumber = parseInt(numbered[1], 10);
      currentObjective = numbered[2];
      currentMeta = [];
    } else if (currentNumber !== null && /^\s+-\s+/.test(line)) {
      currentMeta.push(line);
    }
  }
  flush();

  return specs;
}

function parseInlineWorkflowSpecs(
  content: string
): { specs: WorkflowTemplateSpecRuntime[]; goal: string } | null {
  const frontmatter = parseSimpleFrontmatter(content);
  const docType = asString(frontmatter.type)?.toLowerCase();
  if (docType !== 'workflow' && docType !== 'executable') return null;

  // Strip frontmatter to get body
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

  // Extract goal from first H1 or frontmatter
  const goalFromFrontmatter = asString(frontmatter.goal);
  const h1Match = body.match(/^#\s+(.+)$/m);
  const goal = goalFromFrontmatter || (h1Match ? h1Match[1].trim() : '');

  // Strategy 1: frontmatter specs as JSON string
  const rawSpecs = frontmatter.specs;
  if (typeof rawSpecs === 'string') {
    try {
      const parsed = JSON.parse(rawSpecs);
      if (Array.isArray(parsed)) {
        const specs: WorkflowTemplateSpecRuntime[] = [];
        for (let i = 0; i < parsed.length; i++) {
          const spec = normalizeWorkflowTemplateSpec(parsed[i], i);
          if (spec) specs.push(spec);
        }
        if (specs.length > 0) return { specs, goal };
      }
    } catch { /* fall through */ }
  }
  // Also handle frontmatter specs already parsed as array (won't happen with simple parser, but defensive)
  if (Array.isArray(rawSpecs)) {
    const specs: WorkflowTemplateSpecRuntime[] = [];
    for (let i = 0; i < rawSpecs.length; i++) {
      const spec = normalizeWorkflowTemplateSpec(rawSpecs[i], i);
      if (spec) specs.push(spec);
    }
    if (specs.length > 0) return { specs, goal };
  }

  // Strategy 2: heading-based specs
  const headingSpecs = parseHeadingSpecs(body);
  if (headingSpecs.length > 0) return { specs: headingSpecs, goal };

  // Strategy 3: numbered list specs
  const numberedSpecs = parseNumberedListSpecs(body);
  if (numberedSpecs.length > 0) return { specs: numberedSpecs, goal };

  return null;
}

function extractWorkflowTemplateHint(rawContext: unknown): WorkflowTemplateHint | null {
  if (!isRecord(rawContext)) return null;
  const metadata = isRecord(rawContext.metadata) ? rawContext.metadata : {};
  const content = typeof rawContext.content === 'string'
    ? rawContext.content
    : typeof rawContext.markdown === 'string'
      ? rawContext.markdown
      : '';
  const frontmatter = content ? parseSimpleFrontmatter(content) : {};

  const templateId = normalizeTemplateToken(asString(metadata.templateId)
    ?? asString(metadata.template_id)
    ?? asString(metadata.workflowTemplateId)
    ?? asString(metadata.workflow_template_id)
    ?? asString(frontmatter.templateId)
    ?? asString(frontmatter.template_id));
  const templateName = normalizeTemplateToken(asString(metadata.templateName)
    ?? asString(metadata.template_name)
    ?? asString(metadata.workflowTemplateName)
    ?? asString(metadata.workflow_template_name)
    ?? asString(metadata.template)
    ?? asString(frontmatter.template)
    ?? asString(frontmatter.templateName)
    ?? asString(frontmatter.template_name));
  const documentType = normalizeTemplateToken(
    asString(metadata.documentType)
    ?? asString(metadata.document_type)
    ?? asString(metadata.type)
    ?? asString(rawContext.documentType)
    ?? asString(rawContext.document_type)
    ?? asString(frontmatter.type)
  )?.toLowerCase();
  const markdownPath = normalizeTemplateToken(asString(rawContext.path)
    ?? asString(rawContext.markdownPath)
    ?? asString(rawContext.filePath));
  const hasTemplateHint = !!templateId || !!templateName;
  const workflowLike = documentType === 'workflow' || documentType === 'executable';

  // DB-lookup path: templateId/templateName present
  if (hasTemplateHint) {
    return {
      ...(templateId ? { templateId } : {}),
      ...(templateName ? { templateName } : {}),
      ...(documentType ? { documentType } : {}),
      ...(markdownPath ? { markdownPath } : {}),
    };
  }

  // Inline path: workflow-typed document without a template reference
  if (workflowLike) {
    const inline = parseInlineWorkflowSpecs(content);
    return {
      ...(documentType ? { documentType } : {}),
      ...(markdownPath ? { markdownPath } : {}),
      ...(inline ? { inlineSpecs: inline.specs, inlineGoal: inline.goal } : {}),
    };
  }

  return null;
}

function normalizeWorkflowTemplateSpec(value: unknown, index: number): WorkflowTemplateSpecRuntime | null {
  if (!isRecord(value)) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const id = normalizeTemplateToken(asString(value.id)) ?? `step-${index + 1}`;
  const objective = normalizeTemplateToken(asString(value.objective));
  if (!objective) return null;
  const agent = normalizeTemplateToken(asString(value.agent)) ?? 'standard';
  const dependencies = asStringArray(value.dependencies).map((dep) => dep.trim()).filter((dep) => dep.length > 0);
  const domain = normalizeTemplateToken(asString(value.domain) ?? asString(metadata.domain));
  const targetPaths = asStringArray(value.targetPaths ?? value.target_paths ?? metadata.targetPaths ?? metadata.target_paths)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return {
    id,
    objective,
    agent,
    dependencies,
    ...(domain ? { domain } : {}),
    ...(targetPaths.length > 0 ? { targetPaths } : {}),
  };
}

async function loadWorkflowTemplateFromDb(
  hint: WorkflowTemplateHint
): Promise<{ found: true; template: WorkflowTemplateRuntimeRecord } | { found: false; reason: 'unavailable' | 'not_found' }> {
  const result = await withAgentMemorySql(async (sql) => {
    if (hint.templateId) {
      const rows = await sql`
        SELECT id, name, description, specs
        FROM workitem_templates
        WHERE id = ${hint.templateId}
        LIMIT 1
      `;
      if (Array.isArray(rows) && rows.length > 0) {
        return { status: 'found' as const, row: rows[0] as Record<string, unknown> };
      }
    }
    if (hint.templateName) {
      const rows = await sql`
        SELECT id, name, description, specs
        FROM workitem_templates
        WHERE LOWER(name) = LOWER(${hint.templateName})
        LIMIT 1
      `;
      if (Array.isArray(rows) && rows.length > 0) {
        return { status: 'found' as const, row: rows[0] as Record<string, unknown> };
      }
    }
    return { status: 'not_found' as const };
  });

  if (!result) return { found: false, reason: 'unavailable' };
  if (result.status !== 'found') return { found: false, reason: 'not_found' };

  const row = result.row;
  const rawSpecs = typeof row.specs === 'string'
    ? (() => {
      try {
        return JSON.parse(row.specs as string);
      } catch {
        return null;
      }
    })()
    : row.specs;
  if (!Array.isArray(rawSpecs)) return { found: false, reason: 'not_found' };

  const specs: WorkflowTemplateSpecRuntime[] = [];
  for (let i = 0; i < rawSpecs.length; i++) {
    const spec = normalizeWorkflowTemplateSpec(rawSpecs[i], i);
    if (spec) specs.push(spec);
  }
  if (specs.length === 0) return { found: false, reason: 'not_found' };

  return {
    found: true,
    template: {
      id: asString(row.id) ?? hint.templateId ?? 'unknown-template',
      name: asString(row.name) ?? hint.templateName ?? 'workflow-template',
      description: asString(row.description) ?? '',
      specs,
    },
  };
}

function hasWorkflowTemplateAlreadyBeenApplied(session: SessionRow): boolean {
  const metadata = session.metadata ?? {};
  if (asBoolean(metadata.workflow_template_applied ?? metadata.workflowTemplateApplied) === true) {
    return true;
  }
  const runtime = isRecord(metadata.workflow_template_runtime)
    ? metadata.workflow_template_runtime
    : isRecord(metadata.workflowTemplateRuntime)
      ? metadata.workflowTemplateRuntime
      : null;
  if (!runtime) return false;
  return asBoolean(runtime.applied) === true;
}

export async function maybeBuildWorkflowTemplateDispatch(
  ctx: ControlPlaneContext,
  session: SessionRow,
  message: string,
  markdownContextValue: unknown
): Promise<WorkflowTemplateDispatchResult> {
  if (hasWorkflowTemplateAlreadyBeenApplied(session)) {
    return { ok: true, applied: false };
  }

  const hint = extractWorkflowTemplateHint(markdownContextValue);
  if (!hint) {
    return { ok: true, applied: false };
  }

  // Only apply a template at session start so follow-up chat behaves normally.
  if (ctx.graphd) {
    try {
      const history = ctx.graphd.messagesGet(session.sessionKey, 1, 0) as { messages?: MessageRow[] };
      if (Array.isArray(history.messages) && history.messages.length > 0) {
        return { ok: true, applied: false };
      }
    } catch {
      // Ignore GraphD read failures and continue with best-effort template wiring.
    }
  }

  // --- Inline workflow path ---
  if (hint.inlineSpecs && hint.inlineSpecs.length > 0) {
    const goal = hint.inlineGoal || message.trim();
    if (!goal) {
      return { ok: false, status: 400, error: 'Workflow execution requires a non-empty goal or message' };
    }
    const handoffSpec = {
      goal,
      context: [
        hint.markdownPath ? `Workflow document: ${hint.markdownPath}` : '',
        `User request: ${message.trim()}`,
      ].filter(Boolean).join('\n'),
      workItems: hint.inlineSpecs.map((spec) => ({
        id: spec.id,
        objective: spec.objective,
        agent: spec.agent,
        ...(spec.domain ? { domain: spec.domain } : {}),
        ...(spec.dependencies.length > 0 ? { dependencies: spec.dependencies } : {}),
        ...(spec.targetPaths && spec.targetPaths.length > 0 ? { targetPaths: spec.targetPaths } : {}),
      })),
    };
    const startedAt = new Date().toISOString();
    return {
      ok: true,
      applied: true,
      source: 'inline',
      dispatchMetadata: {
        cockpit_handoff_spec: handoffSpec,
      },
      metadataPatch: {
        workflow_template_applied: true,
        workflow_template_goal: goal,
        workflow_template_runtime: {
          applied: true,
          appliedAt: startedAt,
          source: 'inline-workflow-spec',
        },
      },
    };
  }

  // Workflow-typed doc but no inline specs and no template reference → error
  if (!hint.templateId && !hint.templateName) {
    return {
      ok: false,
      status: 400,
      error: 'Document has type: workflow but no specs could be extracted. '
        + 'Add numbered steps, ### heading sections, or a specs JSON array in frontmatter.',
    };
  }

  // --- DB template path ---
  const loaded = await loadWorkflowTemplateFromDb(hint);
  if (!loaded.found) {
    if (loaded.reason === 'unavailable') {
      return { ok: false, status: 503, error: 'Workflow template database is not available' };
    }
    const requested = hint.templateName ?? hint.templateId ?? 'unknown';
    return { ok: false, status: 404, error: `Workflow template not found: ${requested}` };
  }

  const goal = message.trim();
  if (!goal) {
    return { ok: false, status: 400, error: 'Workflow template execution requires a non-empty message' };
  }

  const handoffSpec = {
    goal,
    context: [
      `Template: ${loaded.template.name}`,
      loaded.template.description ? `Template description: ${loaded.template.description}` : '',
      hint.markdownPath ? `Workflow document: ${hint.markdownPath}` : '',
      `User request: ${goal}`,
    ].filter((line) => line.length > 0).join('\n'),
    workItems: loaded.template.specs.map((spec) => ({
      id: spec.id,
      objective: spec.objective,
      agent: spec.agent,
      ...(spec.domain ? { domain: spec.domain } : {}),
      ...(spec.dependencies.length > 0 ? { dependencies: spec.dependencies } : {}),
      ...(spec.targetPaths && spec.targetPaths.length > 0 ? { targetPaths: spec.targetPaths } : {}),
    })),
  };

  const startedAt = new Date().toISOString();
  return {
    ok: true,
    applied: true,
    source: 'db-template',
    templateId: loaded.template.id,
    templateName: loaded.template.name,
    dispatchMetadata: {
      cockpit_handoff_spec: handoffSpec,
    },
    metadataPatch: {
      workflow_template_applied: true,
      workflow_template_name: loaded.template.name,
      workflow_template_id: loaded.template.id,
      workflow_template_goal: goal,
      workflow_template_runtime: {
        applied: true,
        templateName: loaded.template.name,
        templateId: loaded.template.id,
        appliedAt: startedAt,
        source: 'cockpit-workflow-template',
      },
    },
  };
}
