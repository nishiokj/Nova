import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Session } from '@shared/domain/models';
import { fetchAPI, type ExportResponse, type GraphDSession, type GraphDMessage } from '@shared/lib/api';
import { mapGraphDSession, parseJSONL } from '@shared/lib/mappers';

const STALE_SESSION_SECONDS = 5 * 60;
const IDLE_POLL_INTERVAL_MS = 15000;

interface ControlPlaneMessage {
  id: number;
  role: string;
  content: string;
  requestId: string | null;
  createdAt: string | null;
  metadata: unknown;
}

function dedup<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(key(item), item);
  return Array.from(seen.values());
}

function toUnixSeconds(ts: number | string): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  }
  const asNumber = Number(ts);
  if (!Number.isNaN(asNumber)) {
    return toUnixSeconds(asNumber);
  }
  const parsed = Date.parse(String(ts));
  if (!Number.isNaN(parsed)) {
    return Math.floor(parsed / 1000);
  }
  return 0;
}

async function fetchSessionMessages(sessionKey: string): Promise<GraphDMessage[]> {
  const res = await fetchAPI<{ messages: ControlPlaneMessage[] }>(
    `/control-plane/sessions/${encodeURIComponent(sessionKey)}/messages`
  );
  return (res.messages ?? []).map((m, i) => ({
    id: m.id ?? i,
    session_key: sessionKey,
    message_index: i,
    role: m.role,
    content: m.content,
    request_id: m.requestId,
    created_at: m.createdAt ? Math.floor(new Date(m.createdAt).getTime() / 1000) : 0,
    metadata_json: m.metadata ? JSON.stringify(m.metadata) : null,
  }));
}

type FetchState = 'idle' | 'loading' | 'success' | 'error';

interface UseSessionsResult {
  sessions: Session[];
  state: FetchState;
  error: string | null;
  refetch: () => void;
  hasRunningRequests: boolean;
}

export function useSessions(pollInterval = 2000): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [state, setState] = useState<FetchState>('idle');
  const [error, setError] = useState<string | null>(null);
  const isFirstFetch = useRef(true);
  const messagesCache = useRef<Map<string, GraphDMessage[]>>(new Map());

  const fetchSessions = useCallback(async () => {
    if (isFirstFetch.current) {
      setState('loading');
      isFirstFetch.current = false;
    }
    setError(null);

    try {
      const sessionsResponse = await fetchAPI<ExportResponse>('/export?table=sessions');
      const rawSessions = dedup(parseJSONL<GraphDSession>(sessionsResponse.data), (s) => s.session_key);

      const now = Date.now() / 1000;
      const activeSessions = rawSessions.filter(
        (s) => s.status === 'active' && (now - toUnixSeconds(s.last_accessed_at)) < STALE_SESSION_SECONDS
      );

      if (activeSessions.length > 0) {
        await Promise.all(
          activeSessions.map(async (session) => {
            try {
              const messages = await fetchSessionMessages(session.session_key);
              messagesCache.current.set(session.session_key, messages);
            } catch {
              // Keep stale cache if this refresh fails.
            }
          })
        );
      }

      const mappedSessions = rawSessions
        .map((raw) => mapGraphDSession(raw, messagesCache.current.get(raw.session_key) ?? []))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      setSessions(mappedSessions);
      setState('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setState('error');
    }
  }, []);

  const hasRunningRequests = useMemo(() => {
    return sessions.some((s) => s.state === 'active');
  }, [sessions]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (pollInterval <= 0) return;
    const nextInterval = hasRunningRequests
      ? pollInterval
      : Math.max(IDLE_POLL_INTERVAL_MS, pollInterval * 5);
    const interval = setInterval(fetchSessions, nextInterval);
    return () => clearInterval(interval);
  }, [pollInterval, hasRunningRequests, fetchSessions]);

  return { sessions, state, error, refetch: fetchSessions, hasRunningRequests };
}
