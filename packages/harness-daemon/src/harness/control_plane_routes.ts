/**
 * Control Plane API Routes for harness-daemon
 *
 * Thin dispatcher that imports handler functions from ./routes/* modules
 * and dispatches incoming requests to the appropriate handler.
 */

import type { IncomingMessage, ServerResponse } from 'http';

export { type ControlPlaneContext } from './routes/utils.js';
import { parseUrl, sendJson, matchRoute } from './routes/utils.js';

import {
  handleGetProjects,
  handleGetFeatures,
  handleGetProjectSessions,
  handleGetPRs,
  handleGetSessions,
  handleGetSession,
  handleDeleteSession,
  handleGetSessionMessages,
  handlePostSessionMessage,
  handlePostSessionControl,
  handlePostSessionReviewDecision,
  handleGetGoalHierarchy,
  handleGetTokenUsage,
  handleGetGitInfo,
  handleGetTraces,
  handleGetTraceByRevision,
  handleGetLiveSessions,
  handleSSEEventStream,
  buildForkSessionKey,
  maybeBuildWorkflowTemplateDispatch,
} from './routes/sessions.js';

import {
  handlePostCockpitPatchApply,
} from './routes/git.js';

import {
  handleGetCockpitBrowserState,
  handlePostCockpitBrowserAction,
  handlePostCockpitBrowserRunbook,
} from './routes/browser.js';

import { handlePostAutocomplete } from './routes/autocomplete.js';

import {
  handleGetCockpitMarkdownTree,
  handleGetCockpitMarkdownFile,
  handlePostCockpitMarkdownFile,
  handlePostCockpitMarkdownFolder,
  handlePostCockpitMarkdownDelete,
  handlePostCockpitMarkdownImport,
  handlePostCockpitMarkdownPatch,
} from './routes/markdown.js';

import {
  handleGetDebugMemory,
  handleGetCockpitSessionRollups,
  handleGetCockpitRollupSnapshot,
  handleGetCockpitEscalationRollups,
  handleGetCockpitCommitRollups,
  handleGetCockpitPRRollups,
  handleGetCockpitDailyMetrics,
  handleGetCockpitFocus,
  handleGetCockpitTraces,
  handleGetCockpitDiff,
  handleGetCockpitTestReports,
  handleGetCockpitTestReportById,
  handleGetCockpitRepoLens,
  handleGetCockpitPreview,
  handleGetCockpitFilesystem,
  handleGetCockpitSessionEvents,
  handleGetCockpitSessionPackets,
  handleGetCockpitSessionPermissions,
  handlePostCockpitSessionPermissions,
  handlePostCockpitPacket,
  handleResolveCockpitEscalation,
  handleGetCockpitTemplates,
  handlePostCockpitSessionCreate,
  handleGetCockpitEntityGraph,
} from './routes/cockpit.js';

// Re-export helpers needed by other modules
export { buildForkSessionKey, maybeBuildWorkflowTemplateDispatch } from './routes/sessions.js';

export function handleControlPlaneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: import('./routes/utils.js').ControlPlaneContext
): boolean {
  const { pathname, query } = parseUrl(req);

  // Only handle /control-plane/* routes
  if (!pathname.startsWith('/control-plane/')) {
    return false;
  }

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

  // DELETE /control-plane/sessions/:id
  params = matchRoute('/control-plane/sessions/:id', pathname);
  if (params && req.method === 'DELETE') {
    handleDeleteSession(res, ctx, params.id);
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

  // GET /control-plane/cockpit/rollups/sessions
  if (pathname === '/control-plane/cockpit/rollups/sessions' && req.method === 'GET') {
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '100', 10);
    void handleGetCockpitSessionRollups(res, ctx, status, limit);
    return true;
  }

  // GET /control-plane/cockpit/rollups/snapshot
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

  // GET /control-plane/cockpit/rollups/escalations
  if (pathname === '/control-plane/cockpit/rollups/escalations' && req.method === 'GET') {
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '100', 10);
    handleGetCockpitEscalationRollups(res, ctx, status, limit);
    return true;
  }

  // GET /control-plane/cockpit/rollups/commits
  if (pathname === '/control-plane/cockpit/rollups/commits' && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '50', 10);
    void handleGetCockpitCommitRollups(res, ctx, limit);
    return true;
  }

  // GET /control-plane/cockpit/rollups/prs
  if (pathname === '/control-plane/cockpit/rollups/prs' && req.method === 'GET') {
    const status = query.get('status');
    const limit = parseInt(query.get('limit') ?? '50', 10);
    void handleGetCockpitPRRollups(res, ctx, status, limit);
    return true;
  }

  // GET /control-plane/cockpit/metrics/daily
  if (pathname === '/control-plane/cockpit/metrics/daily' && req.method === 'GET') {
    const date = query.get('date');
    void handleGetCockpitDailyMetrics(res, ctx, date);
    return true;
  }

  // GET /control-plane/cockpit/focus
  if (pathname === '/control-plane/cockpit/focus' && req.method === 'GET') {
    const type = query.get('type');
    const id = query.get('id');
    const packetId = query.get('packetId');
    void handleGetCockpitFocus(res, ctx, type, id, packetId);
    return true;
  }

  // GET /control-plane/cockpit/traces
  if (pathname === '/control-plane/cockpit/traces' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    const workItemId = query.get('workItemId');
    const limit = parseInt(query.get('limit') ?? '200', 10);
    void handleGetCockpitTraces(res, ctx, sessionKey, workItemId, limit);
    return true;
  }

  // GET /control-plane/cockpit/diff
  if (pathname === '/control-plane/cockpit/diff' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    const base = query.get('base');
    const head = query.get('head');
    const file = query.get('file');
    void handleGetCockpitDiff(res, ctx, sessionKey, base, head, file);
    return true;
  }

  // GET /control-plane/cockpit/tests
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

  // GET /control-plane/cockpit/repo/lens|grep
  if ((pathname === '/control-plane/cockpit/repo/lens' || pathname === '/control-plane/cockpit/repo/grep') && req.method === 'GET') {
    const q = query.get('q');
    const kind = query.get('kind');
    const sessionKey = query.get('sessionKey');
    const limit = parseInt(query.get('limit') ?? '120', 10);
    void handleGetCockpitRepoLens(res, ctx, q, kind, sessionKey, limit);
    return true;
  }

  // GET /control-plane/cockpit/preview
  if (pathname === '/control-plane/cockpit/preview' && req.method === 'GET') {
    const url = query.get('url');
    const sessionKey = query.get('sessionKey');
    handleGetCockpitPreview(res, ctx, url, sessionKey);
    return true;
  }

  // GET /control-plane/cockpit/filesystem
  if (pathname === '/control-plane/cockpit/filesystem' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    const projectPath = query.get('projectPath');
    void handleGetCockpitFilesystem(res, ctx, sessionKey, projectPath);
    return true;
  }

  // GET /control-plane/cockpit/browser/state
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
    const sessionKey = query.get('sessionKey');
    const projectPath = query.get('projectPath');
    void handleGetCockpitMarkdownTree(res, ctx, { sessionKey, projectPath });
    return true;
  }

  // GET /control-plane/cockpit/markdown/file
  if (pathname === '/control-plane/cockpit/markdown/file' && req.method === 'GET') {
    const filePath = query.get('path');
    const sessionKey = query.get('sessionKey');
    const projectPath = query.get('projectPath');
    void handleGetCockpitMarkdownFile(res, ctx, filePath, { sessionKey, projectPath });
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

  // POST /control-plane/cockpit/markdown/delete
  if (pathname === '/control-plane/cockpit/markdown/delete' && req.method === 'POST') {
    void handlePostCockpitMarkdownDelete(req, res, ctx);
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

  // GET /control-plane/cockpit/session/:sessionKey/events
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/events', pathname);
  if (params && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '200', 10);
    const cursor = query.get('cursor');
    handleGetCockpitSessionEvents(res, ctx, params.sessionKey, limit, cursor);
    return true;
  }

  // GET /control-plane/cockpit/session/:sessionKey/packets
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/packets', pathname);
  if (params && req.method === 'GET') {
    const limit = parseInt(query.get('limit') ?? '20', 10);
    handleGetCockpitSessionPackets(res, ctx, params.sessionKey, limit);
    return true;
  }

  // GET|POST /control-plane/cockpit/session/:sessionKey/permissions
  params = matchRoute('/control-plane/cockpit/session/:sessionKey/permissions', pathname);
  if (params && req.method === 'GET') {
    void handleGetCockpitSessionPermissions(res, ctx, params.sessionKey);
    return true;
  }
  if (params && req.method === 'POST') {
    void handlePostCockpitSessionPermissions(req, res, ctx, params.sessionKey);
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

  // GET /control-plane/cockpit/entity-graph
  if (pathname === '/control-plane/cockpit/entity-graph' && req.method === 'GET') {
    const sessionKey = query.get('sessionKey');
    void handleGetCockpitEntityGraph(res, ctx, sessionKey);
    return true;
  }

  // POST /control-plane/cockpit/autocomplete/complete
  if (pathname === '/control-plane/cockpit/autocomplete/complete' && req.method === 'POST') {
    void handlePostAutocomplete(req, res);
    return true;
  }

  // GET /control-plane/cockpit/events/stream (SSE)
  if (pathname === '/control-plane/cockpit/events/stream' && req.method === 'GET') {
    handleSSEEventStream(req, res, ctx);
    return true;
  }

  // GET /control-plane/debug/memory
  if (pathname === '/control-plane/debug/memory' && req.method === 'GET') {
    handleGetDebugMemory(res, ctx);
    return true;
  }

  // 404 for unmatched control-plane routes
  sendJson(res, { error: 'Not found' }, 404);
  return true;
}
