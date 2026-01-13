import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Session } from '@shared/domain/models';
import { fetchAPI, type ExportResponse, type GraphDSession, type GraphDMessage } from '@shared/lib/api';
import { mapGraphDSession, parseJSONL } from '@shared/lib/mappers';

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

  const fetchSessions = useCallback(async () => {
    if (state === 'idle') {
      setState('loading');
    }
    setError(null);

    try {
      const [sessionsResponse, messagesResponse] = await Promise.all([
        fetchAPI<ExportResponse>('/export?table=sessions'),
        fetchAPI<ExportResponse>('/export?table=conversation_messages').catch(() => ({ data: '' })),
      ]);

      const rawSessions = parseJSONL<GraphDSession>(sessionsResponse.data);
      const rawMessages = parseJSONL<GraphDMessage>(messagesResponse.data);

      const messagesBySession = new Map<string, GraphDMessage[]>();
      for (const msg of rawMessages) {
        if (!messagesBySession.has(msg.session_key)) {
          messagesBySession.set(msg.session_key, []);
        }
        messagesBySession.get(msg.session_key)!.push(msg);
      }

      for (const msgs of messagesBySession.values()) {
        msgs.sort((a, b) => a.message_index - b.message_index);
      }

      const mappedSessions = rawSessions
        .map((raw) => mapGraphDSession(raw, messagesBySession.get(raw.session_key) ?? []))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      setSessions(mappedSessions);
      setState('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setState('error');
    }
  }, [state]);

  const hasRunningRequests = useMemo(() => {
    return sessions.some((s) => s.insights.requestsRunning > 0 || s.state === 'active');
  }, [sessions]);

  useEffect(() => {
    fetchSessions();
  }, []);

  useEffect(() => {
    if (pollInterval > 0 && (hasRunningRequests || state === 'success')) {
      const interval = setInterval(fetchSessions, pollInterval);
      return () => clearInterval(interval);
    }
  }, [pollInterval, hasRunningRequests, state]);

  return { sessions, state, error, refetch: fetchSessions, hasRunningRequests };
}
