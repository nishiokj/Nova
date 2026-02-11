import { fetchAPI, postAPI } from './fetch';
import type {
  CockpitDiff,
  CockpitFilesystemState,
  CockpitPatchApplyInput,
  CockpitTestReport,
  RepoLensMatch,
  TraceRecord,
  WorkItemTemplate,
} from './types';

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
  }>(`/cockpit/repo/grep?${params.toString()}`);
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

export async function getCockpitTemplates(): Promise<WorkItemTemplate[]> {
  const data = await fetchAPI<{ templates: WorkItemTemplate[] }>('/cockpit/templates');
  return data.templates ?? [];
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

export async function getCockpitFilesystem(options: {
  projectPath?: string;
} = {}): Promise<CockpitFilesystemState | null> {
  const params = new URLSearchParams();
  if (options.projectPath) params.set('projectPath', options.projectPath);
  try {
    return await fetchAPI<CockpitFilesystemState>(`/cockpit/filesystem?${params.toString()}`);
  } catch {
    return null;
  }
}
