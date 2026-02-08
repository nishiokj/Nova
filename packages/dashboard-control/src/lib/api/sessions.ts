import { fetchAPI, postAPI } from './fetch';
import type {
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

export async function getCockpitEntityGraph(sessionKey: string): Promise<SubgraphResponse> {
  try {
    return await fetchAPI<SubgraphResponse>(
      `/cockpit/entity-graph?sessionKey=${encodeURIComponent(sessionKey)}`
    );
  } catch {
    return EMPTY_SUBGRAPH;
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
