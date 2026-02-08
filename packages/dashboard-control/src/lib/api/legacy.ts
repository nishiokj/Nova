import { fetchAPI, postAPI } from './fetch';
import type {
  Feature,
  GitInfo,
  GoalNode,
  Message,
  PRInfo,
  Project,
  Session,
  TokenUsage,
  TraceRecord,
} from './types';

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

export async function getPRs(owner: string, repo: string, branch?: string): Promise<PRInfo[]> {
  const encoded = encodeURIComponent(branch || '');
  const data = await fetchAPI<{ prs: PRInfo[] }>(`/features/${encoded}/prs?owner=${owner}&repo=${repo}`);
  return data.prs ?? [];
}

export async function getGoalHierarchy(): Promise<GoalNode[]> {
  const data = await fetchAPI<{ goals: GoalNode[]; note?: string }>('/goals/hierarchy');
  return data.goals ?? [];
}

export async function getTokenUsage(): Promise<TokenUsage[]> {
  const data = await fetchAPI<{ usage: TokenUsage[] }>('/token-usage');
  return data.usage ?? [];
}

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

export async function getGitInfo(projectPath: string): Promise<GitInfo | null> {
  try {
    const encoded = encodeURIComponent(projectPath);
    return fetchAPI<GitInfo>(`/projects/${encoded}/git`);
  } catch {
    return null;
  }
}

export async function sendSessionMessage(sessionId: string, message: string): Promise<{ success: boolean }> {
  return postAPI(`/sessions/${encodeURIComponent(sessionId)}/message`, { message });
}

export async function stopSession(sessionId: string): Promise<{ success: boolean }> {
  return postAPI(`/sessions/${encodeURIComponent(sessionId)}/stop`, {});
}
