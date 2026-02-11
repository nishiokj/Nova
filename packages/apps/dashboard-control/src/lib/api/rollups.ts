import { fetchAPI } from './fetch';
import type {
  CockpitRollupSnapshot,
  DailyMetrics,
  SessionPanelStatus,
  SessionRollup,
  EscalationRollup,
  CommitRollup,
  PRRollup,
} from './types';

export async function getCockpitRollupSnapshot(options: {
  sessionLimit?: number;
  escalationLimit?: number;
  repoLimit?: number;
  includeRepo?: boolean;
  date?: string;
} = {}): Promise<CockpitRollupSnapshot> {
  const params = new URLSearchParams();
  params.set('sessionLimit', String(options.sessionLimit ?? 120));
  params.set('escalationLimit', String(options.escalationLimit ?? 120));
  params.set('repoLimit', String(options.repoLimit ?? 50));
  params.set('includeRepo', options.includeRepo === false ? '0' : '1');
  if (options.date) params.set('date', options.date);
  return fetchAPI<CockpitRollupSnapshot>(`/cockpit/rollups/snapshot?${params.toString()}`);
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
