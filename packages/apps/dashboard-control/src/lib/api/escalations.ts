import { postAPI } from './fetch';
import type { PostCockpitPacketInput } from './types';

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
