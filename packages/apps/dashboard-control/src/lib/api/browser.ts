import { fetchAPI, postAPI } from './fetch';
import type {
  CockpitBrowserActionInput,
  CockpitBrowserEvidence,
  CockpitBrowserState,
} from './types';

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
