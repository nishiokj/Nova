import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { Session, FilterCounts, FilterType } from '../domain/models'
import { fetchAPI, type ExportResponse, type GraphDSession, type GraphDMessage } from '../lib/api'
import { mapGraphDSession, parseJSONL } from '../lib/mappers'

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
  const isFirstFetch = useRef(true)
  const rawSessionsRef = useRef<GraphDSession[]>([])

  const fetchSessions = useCallback(async () => {
    // Only show loading on first fetch
    if (isFirstFetch.current) {
      setState('loading')
      isFirstFetch.current = false
    }
    setError(null)

    try {
      // First, fetch only sessions (lightweight)
      const sessionsResponse = await fetchAPI<ExportResponse>('/export?table=sessions')
      const rawSessions = parseJSONL<GraphDSession>(sessionsResponse.data)
      rawSessionsRef.current = rawSessions

      // Check if any sessions are active - if so, also fetch messages for them
      const activeSessions = rawSessions.filter(s => s.status === 'active')
      let messagesBySession = new Map<string, GraphDMessage[]>()

      if (activeSessions.length > 0) {
        // Fetch messages only for active sessions via separate queries
        // For now, we'll still fetch all messages but only map active ones initially
        const messagesResponse = await fetchAPI<ExportResponse>('/export?table=conversation_messages').catch(() => ({ data: '' }))
        const rawMessages = parseJSONL<GraphDMessage>(messagesResponse.data)

        // Group messages by session_key
        for (const msg of rawMessages) {
          if (!messagesBySession.has(msg.session_key)) {
            messagesBySession.set(msg.session_key, [])
          }
          messagesBySession.get(msg.session_key)!.push(msg)
        }

        // Sort messages within each session by message_index
        for (const msgs of messagesBySession.values()) {
          msgs.sort((a, b) => a.message_index - b.message_index)
        }

        // Mark active sessions as having loaded messages
        setLoadedMessageSessions(prev => {
          const next = new Set(prev)
          for (const s of activeSessions) {
            next.add(s.session_key)
          }
          return next
        })
      }

      const mappedSessions = rawSessions
        .map((raw) => {
          // Only include messages for active sessions or previously loaded ones
          const isActive = raw.status === 'active'
          const wasLoaded = loadedMessageSessions.has(raw.session_key)
          const msgs = (isActive || wasLoaded) ? messagesBySession.get(raw.session_key) ?? [] : []
          return mapGraphDSession(raw, msgs)
        })
        // Sort by createdAt descending (newest first)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

      setSessions(mappedSessions)
      setState('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setState('error')
    }
  }, [loadedMessageSessions])

  // Lazy load messages for a specific session when expanded
  const loadSessionMessages = useCallback(async (sessionId: string) => {
    if (loadedMessageSessions.has(sessionId)) return

    try {
      const messagesResponse = await fetchAPI<ExportResponse>('/export?table=conversation_messages')
      const rawMessages = parseJSONL<GraphDMessage>(messagesResponse.data)

      // Filter to just this session's messages
      const sessionMessages = rawMessages
        .filter(m => m.session_key === sessionId)
        .sort((a, b) => a.message_index - b.message_index)

      // Find the raw session data
      const rawSession = rawSessionsRef.current.find(s => s.session_key === sessionId)
      if (!rawSession) return

      // Remap the session with messages
      const updatedSession = mapGraphDSession(rawSession, sessionMessages)

      setSessions(prev =>
        prev.map(s => s.id === sessionId ? updatedSession : s)
      )

      setLoadedMessageSessions(prev => {
        const next = new Set(prev)
        next.add(sessionId)
        return next
      })
    } catch {
      // Silent fail - messages are optional enhancement
    }
  }, [loadedMessageSessions])

  // Check if any session has running requests (for auto-polling)
  const hasRunningRequests = useMemo(() => {
    return sessions.some((s) => s.insights.requestsRunning > 0 || s.state === 'active')
  }, [sessions])

  // Initial fetch on mount
  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  // Auto-poll ONLY when there are running requests
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
