import { useState, useEffect, useCallback, useMemo } from 'react'
import type { Session, FilterCounts, FilterType } from '../domain/models'
import { fetchAPI, type ExportResponse, type GraphDSession, type GraphDMessage } from '../lib/api'
import { mapGraphDSession, parseJSONL } from '../lib/mappers'

type FetchState = 'idle' | 'loading' | 'success' | 'error'

interface UseSessionsResult {
  sessions: Session[]
  state: FetchState
  error: string | null
  refetch: () => void
  hasRunningTasks: boolean
}

export function useSessions(pollInterval = 5000): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([])
  const [state, setState] = useState<FetchState>('idle')
  const [error, setError] = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    // Only show loading on first fetch
    if (state === 'idle') {
      setState('loading')
    }
    setError(null)

    try {
      // Fetch sessions and messages in parallel
      const [sessionsResponse, messagesResponse] = await Promise.all([
        fetchAPI<ExportResponse>('/export?table=sessions'),
        fetchAPI<ExportResponse>('/export?table=conversation_messages').catch(() => ({ data: '' })),
      ])

      const rawSessions = parseJSONL<GraphDSession>(sessionsResponse.data)
      const rawMessages = parseJSONL<GraphDMessage>(messagesResponse.data)

      // Group messages by session_key
      const messagesBySession = new Map<string, GraphDMessage[]>()
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

      const mappedSessions = rawSessions
        .map((raw) => mapGraphDSession(raw, messagesBySession.get(raw.session_key) ?? []))
        // Sort by createdAt descending (newest first)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

      setSessions(mappedSessions)
      setState('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setState('error')
    }
  }, [state])

  // Check if any session has running tasks (for auto-polling)
  const hasRunningTasks = useMemo(() => {
    return sessions.some((s) => s.insights.tasksRunning > 0 || s.state === 'active')
  }, [sessions])

  useEffect(() => {
    fetchSessions()
  }, []) // Only fetch on mount

  // Auto-poll when there are running tasks
  useEffect(() => {
    if (pollInterval > 0 && (hasRunningTasks || state === 'success')) {
      const interval = setInterval(fetchSessions, pollInterval)
      return () => clearInterval(interval)
    }
  }, [pollInterval, hasRunningTasks, state])

  return { sessions, state, error, refetch: fetchSessions, hasRunningTasks }
}

// Hook for computing filter counts
export function useFilterCounts(sessions: Session[]): FilterCounts {
  return useMemo(() => {
    let errors = 0
    let running = 0
    let completed = 0

    for (const session of sessions) {
      if (session.insights.tasksFailed > 0) errors++
      if (session.insights.tasksRunning > 0) running++
      if (session.insights.tasksCompleted > 0 && session.insights.tasksRunning === 0) completed++
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
        return sessions.filter((s) => s.insights.tasksFailed > 0)
      case 'running':
        return sessions.filter((s) => s.insights.tasksRunning > 0)
      case 'completed':
        return sessions.filter(
          (s) => s.insights.tasksCompleted > 0 && s.insights.tasksRunning === 0
        )
      case 'all':
      default:
        return sessions
    }
  }, [sessions, filter])
}
