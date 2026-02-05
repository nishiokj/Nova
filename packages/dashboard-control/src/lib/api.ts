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

async function fetchAPI<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
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
