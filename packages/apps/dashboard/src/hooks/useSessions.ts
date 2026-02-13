import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { Session, FilterCounts, FilterType } from '../domain/models'
import { fetchAPI, type ExportResponse, type GraphDSession, type GraphDMessage } from '../lib/api'
import { mapGraphDSession, parseJSONL } from '../lib/mappers'

/** Keep last occurrence per key (last row = most recently updated). */
function dedup<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>()
  for (const item of items) seen.set(key(item), item)
  return Array.from(seen.values())
}

interface ControlPlaneMessage {
  id: number
  role: string
  content: string
  requestId: string | null
  createdAt: string | null
  metadata: unknown
}

/** Fetch messages for a single session via the control-plane API. */
async function fetchSessionMessages(sessionKey: string): Promise<GraphDMessage[]> {
  const res = await fetchAPI<{ messages: ControlPlaneMessage[] }>(
    `/control-plane/sessions/${encodeURIComponent(sessionKey)}/messages`
  )
  return (res.messages ?? []).map((m, i) => ({
    id: m.id ?? i,
    session_key: sessionKey,
    message_index: i,
    role: m.role,
    content: m.content,
    request_id: m.requestId,
    created_at: m.createdAt ? Math.floor(new Date(m.createdAt).getTime() / 1000) : 0,
    metadata_json: m.metadata ? JSON.stringify(m.metadata) : null,
  }))
}

type FetchState = 'idle' | 'loading' | 'success' | 'error'

interface UseSessionsResult {
  sessions: Session[]
  state: FetchState
  error: string | null
  refetch: () => void
  hasRunningRequests: boolean
  loadSessionMessages: (sessionId: string) => Promise<void>
  loadedMessageSessions: Set<string>
}

export function useSessions(pollInterval = 2000): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([])
  const [state, setState] = useState<FetchState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [loadedMessageSessions, setLoadedMessageSessions] = useState<Set<string>>(new Set())
  const loadedRef = useRef<Set<string>>(new Set())
  const isFirstFetch = useRef(true)
  const rawSessionsRef = useRef<GraphDSession[]>([])
  // Cache of already-fetched messages, keyed by session_key
  const messagesCache = useRef<Map<string, GraphDMessage[]>>(new Map())

  const fetchSessions = useCallback(async () => {
    if (isFirstFetch.current) {
      setState('loading')
      isFirstFetch.current = false
    }
    setError(null)

    try {
      const sessionsResponse = await fetchAPI<ExportResponse>('/export?table=sessions')
      const rawSessions = dedup(parseJSONL<GraphDSession>(sessionsResponse.data), s => s.session_key)
      rawSessionsRef.current = rawSessions

      // For genuinely active sessions, refresh their messages in parallel
      const now = Date.now() / 1000
      const staleThreshold = 5 * 60
      const activeSessions = rawSessions.filter(s =>
        s.status === 'active' && (now - s.last_accessed_at) < staleThreshold
      )

      if (activeSessions.length > 0) {
        const fetches = activeSessions.map(async (s) => {
          try {
            const msgs = await fetchSessionMessages(s.session_key)
            messagesCache.current.set(s.session_key, msgs)
            loadedRef.current.add(s.session_key)
          } catch { /* individual failures are fine */ }
        })
        await Promise.all(fetches)
        setLoadedMessageSessions(new Set(loadedRef.current))
      }

      const mappedSessions = rawSessions
        .map((raw) => {
          const msgs = messagesCache.current.get(raw.session_key) ?? []
          return mapGraphDSession(raw, msgs)
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

      setSessions(mappedSessions)
      setState('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setState('error')
    }
  }, [])

  // Lazy load messages for a specific session when expanded
  const loadSessionMessages = useCallback(async (sessionId: string) => {
    if (loadedRef.current.has(sessionId)) return

    try {
      const msgs = await fetchSessionMessages(sessionId)
      messagesCache.current.set(sessionId, msgs)

      const rawSession = rawSessionsRef.current.find(s => s.session_key === sessionId)
      if (!rawSession) return

      const updatedSession = mapGraphDSession(rawSession, msgs)

      setSessions(prev =>
        prev.map(s => s.id === sessionId ? updatedSession : s)
      )

      loadedRef.current.add(sessionId)
      setLoadedMessageSessions(new Set(loadedRef.current))
    } catch {
      // Silent fail - messages are optional enhancement
    }
  }, [])

  const hasRunningRequests = useMemo(() => {
    return sessions.some((s) => s.insights.requestsRunning > 0 || s.state === 'active')
  }, [sessions])

  // Initial fetch on mount
  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  // Auto-poll when there are running requests
  useEffect(() => {
    if (pollInterval > 0 && hasRunningRequests) {
      const interval = setInterval(fetchSessions, pollInterval)
      return () => clearInterval(interval)
    }
  }, [pollInterval, hasRunningRequests, fetchSessions])

  return { sessions, state, error, refetch: fetchSessions, hasRunningRequests, loadSessionMessages, loadedMessageSessions }
}

// Hook for computing filter counts
export function useFilterCounts(sessions: Session[]): FilterCounts {
  return useMemo(() => {
    let errors = 0
    let running = 0
    let completed = 0

    for (const session of sessions) {
      if (session.insights.requestsFailed > 0) errors++
      if (session.insights.requestsRunning > 0) running++
      if (session.insights.requestsCompleted > 0 && session.insights.requestsRunning === 0) completed++
    }

    return {
      all: sessions.length,
      errors,
      running,
      completed,
    }
  }, [sessions])
}

// Hook for filtering sessions
export function useFilteredSessions(sessions: Session[], filter: FilterType): Session[] {
  return useMemo(() => {
    switch (filter) {
      case 'errors':
        return sessions.filter((s) => s.insights.requestsFailed > 0)
      case 'running':
        return sessions.filter((s) => s.insights.requestsRunning > 0)
      case 'completed':
        return sessions.filter(
          (s) => s.insights.requestsCompleted > 0 && s.insights.requestsRunning === 0
        )
      case 'all':
      default:
        return sessions
    }
  }, [sessions, filter])
}
