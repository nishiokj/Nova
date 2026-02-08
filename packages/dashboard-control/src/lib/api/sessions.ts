import { fetchAPI, postAPI } from './fetch';
import type {
  ArchitectureAlertSeverity,
  ArchitectureAlertStatus,
  CockpitArchitectureAlertSummary,
  CockpitArchitectureOverview,
  CockpitMarkdownContextInput,
  CockpitSessionControlInput,
  CockpitSessionPermissions,
  CockpitSessionPermissionUpdateInput,
  CockpitSessionReviewDecisionInput,
  FocusData,
  FocusPacket,
  NormalizedSessionEvent,
  SubgraphResponse,
} from './types';

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

export async function getCockpitSessionPermissions(sessionKey: string): Promise<CockpitSessionPermissions> {
  return fetchAPI<CockpitSessionPermissions>(
    `/cockpit/session/${encodeURIComponent(sessionKey)}/permissions`
  );
}

export async function postCockpitSessionPermissions(
  sessionKey: string,
  input: CockpitSessionPermissionUpdateInput
): Promise<{ success: boolean } & CockpitSessionPermissions> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/permissions`, input);
}

export interface CockpitModelEntry {
  id: string;
  name: string;
  provider: string;
  reasoning?: string[];
}

export interface CockpitModelSelection {
  provider: string;
  model: string;
  reasoning?: string;
}

export async function getCockpitSessionModel(
  sessionKey: string
): Promise<{ selections: Record<string, CockpitModelSelection>; models: CockpitModelEntry[] }> {
  return fetchAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/model`);
}

export async function postCockpitSessionModel(
  sessionKey: string,
  input: { provider: string; model: string; agentType?: string; reasoning?: string }
): Promise<{ success: boolean; agentType: string; selection: CockpitModelSelection }> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/model`, input);
}

export async function postCockpitSessionMessage(
  sessionKey: string,
  message: string,
  options?: { markdownContext?: CockpitMarkdownContextInput }
): Promise<{
  success: boolean;
  requestId?: string;
  queued?: boolean;
  markdownContextAttached?: boolean;
  workflowTemplateApplied?: boolean;
  workflowTemplate?: { id?: string; name?: string };
}> {
  return postAPI(`/cockpit/session/${encodeURIComponent(sessionKey)}/message`, {
    message,
    ...(options?.markdownContext ? { markdownContext: options.markdownContext } : {}),
  });
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

export async function postCockpitSessionCreate(input: {
  goal?: string;
  markdownPath?: string;
  projectPath?: string;
  createProjectPath?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; sessionKey?: string; workingDir?: string; error?: string }> {
  return postAPI('/cockpit/session/create', input);
}

const EMPTY_SUBGRAPH: SubgraphResponse = {
  nodes: [], edges: [], stats: { readFiles: 0, editedFiles: 0, totalNodes: 0, totalEdges: 0 },
};

const EMPTY_ARCHITECTURE_OVERVIEW: CockpitArchitectureOverview = {
  runId: null,
  generatedAt: new Date(0).toISOString(),
  touched: { totalFiles: 0, readFiles: 0, editedFiles: 0 },
  concerns: [],
  boundaries: [],
  alerts: [],
};

export async function getCockpitEntityGraph(
  sessionKey: string,
  options: { workItemId?: string } = {}
): Promise<SubgraphResponse> {
  try {
    const params = new URLSearchParams({ sessionKey });
    if (options.workItemId) params.set('workItemId', options.workItemId);
    return await fetchAPI<SubgraphResponse>(
      `/cockpit/entity-graph?${params.toString()}`
    );
  } catch {
    return EMPTY_SUBGRAPH;
  }
}

export async function getCockpitArchitectureOverview(
  sessionKey: string,
  options: {
    runId?: string;
    concernLimit?: number;
    boundaryLimit?: number;
    alertLimit?: number;
  } = {}
): Promise<CockpitArchitectureOverview> {
  try {
    const params = new URLSearchParams({
      sessionKey,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(typeof options.concernLimit === 'number' ? { concernLimit: String(options.concernLimit) } : {}),
      ...(typeof options.boundaryLimit === 'number' ? { boundaryLimit: String(options.boundaryLimit) } : {}),
      ...(typeof options.alertLimit === 'number' ? { alertLimit: String(options.alertLimit) } : {}),
    });
    return await fetchAPI<CockpitArchitectureOverview>(
      `/cockpit/architecture/overview?${params.toString()}`
    );
  } catch {
    return EMPTY_ARCHITECTURE_OVERVIEW;
  }
}

export async function getCockpitArchitectureAlerts(options: {
  sessionKey?: string;
  runId?: string;
  status?: ArchitectureAlertStatus;
  severity?: ArchitectureAlertSeverity;
  type?: string;
  limit?: number;
} = {}): Promise<{ runId: string | null; alerts: CockpitArchitectureAlertSummary[] }> {
  try {
    const params = new URLSearchParams({
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.severity ? { severity: options.severity } : {}),
      ...(options.type ? { type: options.type } : {}),
      ...(typeof options.limit === 'number' ? { limit: String(options.limit) } : {}),
    });
    return await fetchAPI<{ runId: string | null; alerts: CockpitArchitectureAlertSummary[] }>(
      `/cockpit/architecture/alerts${params.toString() ? `?${params.toString()}` : ''}`
    );
  } catch {
    return { runId: null, alerts: [] };
  }
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
