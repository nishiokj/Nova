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
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ControlPlaneContext {
  graphd: GraphDManager | null;
  isGraphDReady: () => boolean;
  workingDir: string;
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
}

interface SessionRow {
  session_key: string;
  client_type: string;
  working_dir: string | null;
  status: string;
  created_at: number;
  last_accessed_at: number;
  metadata: Record<string, unknown> | null;
}

interface MessageRow {
  id: number;
  role: string;
  content: string;
  request_id: string | null;
  created_at: number;
  metadata: Record<string, unknown> | null;
}

// Cache for GitHub data
const prCache = new Map<string, { data: PRInfo[]; fetchedAt: number }>();
const PR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
      `pr list --repo ${owner}/${repo} --state all --limit 50 --json number,title,state,author,url,additions,deletions,changedFiles,createdAt,updatedAt,isDraft`
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
    }));

    prCache.set(cacheKey, { data: prs, fetchedAt: Date.now() });
    return prs;
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
  return {
    id: row.session_key,
    clientType: row.client_type,
    workingDir: row.working_dir,
    status: row.status,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    lastAccessedAt: new Date(row.last_accessed_at * 1000).toISOString(),
    metadata: row.metadata,
  };
}

/**
 * Format message row for API response
 */
function formatMessage(row: MessageRow) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    requestId: row.request_id,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    metadata: row.metadata,
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

  // 404 for unmatched control-plane routes
  sendJson(res, { error: 'Not found' }, 404);
  return true;
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
    const sessions = result.sessions ?? [];

    // Group by working directory
    const projectMap = new Map<string, { count: number; lastAccessed: number }>();
    for (const session of sessions) {
      const wd = session.working_dir;
      if (!wd) continue;

      const existing = projectMap.get(wd);
      if (existing) {
        existing.count++;
        existing.lastAccessed = Math.max(existing.lastAccessed, session.last_accessed_at);
      } else {
        projectMap.set(wd, { count: 1, lastAccessed: session.last_accessed_at });
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
