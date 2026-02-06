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
  message: string
): Promise<{ success: boolean; requestId?: string; queued?: boolean }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/message`, { message });
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
