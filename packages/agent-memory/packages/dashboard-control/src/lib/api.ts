/**
 * Control Plane API Client
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

export interface DecisionProvenance {
  sessionId: string;
  requestId: string;
  decisionId: string;
  decision: string;
  rationale: string;
  timestamp: string;
  filesAffected: string[];
  confidence: string;
}

export interface TraceAnnotation {
  file: string;
  line: number;
  requestId: string;
  toolName: string;
  action: 'read' | 'write' | 'edit';
  timestamp: string;
  success: boolean;
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

export interface JobsOverview {
  stats: {
    totalTasks: number;
    enabledTasks: number;
    circuitOpen: number;
    pendingJobs: number;
    runningJobs: number;
    failedJobs: number;
    completedJobs: number;
  };
  circuitOpenTasks: Array<{
    id: string;
    name: string;
    openUntil: string;
    lastError: string;
    consecutiveFailures: number;
  }>;
  recentJobs: Array<{
    id: string;
    taskId: string;
    status: string;
    createdAt: string;
    completedAt?: string;
    lastError?: string;
  }>;
}

export interface Decision {
  id: string;
  category: string;
  decision: string;
  rationale: string;
  keywords: string[];
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
  const data = await res.json();
  return data.body ?? data;
}

export async function getProjects(): Promise<Project[]> {
  const data = await fetchAPI<{ projects: Project[] }>('/projects');
  return data.projects;
}

export async function getFeatures(projectPath: string): Promise<{ features: Feature[]; currentBranch: string }> {
  const encoded = encodeURIComponent(projectPath);
  return fetchAPI(`/projects/${encoded}/features`);
}

export async function getPRs(owner: string, repo: string, branch?: string): Promise<PRInfo[]> {
  const encoded = encodeURIComponent(branch || '');
  const data = await fetchAPI<{ prs: PRInfo[] }>(`/features/${encoded}/prs?owner=${owner}&repo=${repo}`);
  return data.prs;
}

export async function getProvenance(owner: string, repo: string, prNumber: number): Promise<{
  provenance: DecisionProvenance[];
  affectedFiles: string[];
}> {
  return fetchAPI(`/prs/${prNumber}/provenance?owner=${owner}&repo=${repo}`);
}

export async function getTraceAnnotations(sessionId: string): Promise<TraceAnnotation[]> {
  const data = await fetchAPI<{ annotations: TraceAnnotation[] }>(`/sessions/${sessionId}/trace-annotations`);
  return data.annotations;
}

export async function getGoalHierarchy(): Promise<GoalNode[]> {
  const data = await fetchAPI<{ goals: GoalNode[] }>('/goals/hierarchy');
  return data.goals;
}

export async function getJobsOverview(): Promise<JobsOverview> {
  return fetchAPI('/jobs/overview');
}

export async function searchDecisions(query: string, options?: { category?: string; limit?: number }): Promise<Decision[]> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (options?.category) params.set('category', options.category);
  if (options?.limit) params.set('limit', String(options.limit));
  const data = await fetchAPI<{ decisions: Decision[] }>(`/decisions/search?${params}`);
  return data.decisions;
}

export async function getTokenUsage(since?: string): Promise<TokenUsage[]> {
  const params = since ? `?since=${since}` : '';
  const data = await fetchAPI<{ usage: TokenUsage[] }>(`/token-usage${params}`);
  return data.usage;
}
