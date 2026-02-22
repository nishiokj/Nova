import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { Session, FilterCounts, FilterType } from '../domain/models'
import { fetchAPI, type ExportResponse, type GraphDSession, type GraphDMessage } from '../lib/api'
import { mapGraphDSession, parseJSONL } from '../lib/mappers'

const STALE_SESSION_SECONDS = 5 * 60
const IDLE_POLL_INTERVAL_MS = 15000
/** Max concurrent message fetches per poll cycle. */
const MAX_CONCURRENT_MESSAGE_FETCHES = 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keep last occurrence per key (last row = most recently updated). */
function dedup<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>()
  for (const item of items) seen.set(key(item), item)
  return Array.from(seen.values())
}

function toUnixSeconds(ts: number | string): number {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts)
  }
  const asNumber = Number(ts)
  if (!Number.isNaN(asNumber)) return toUnixSeconds(asNumber)
  const parsed = Date.parse(String(ts))
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  return 0
}

/** Cheap fingerprint to detect whether a GraphD session row changed. */
function sessionFingerprint(s: GraphDSession): string {
  return `${s.status}|${s.last_accessed_at}|${s.metadata_json?.length ?? 0}`
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
async function fetchSessionMessages(
  sessionKey: string,
  signal?: AbortSignal,
): Promise<GraphDMessage[]> {
  const res = await fetchAPI<{ messages: ControlPlaneMessage[] }>(
    `/control-plane/sessions/${encodeURIComponent(sessionKey)}/messages`,
    signal ? { signal } : undefined,
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

/**
 * Run async tasks with bounded concurrency.
 * Returns results in the same order as `tasks`.
 */
async function pooled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0

  async function worker() {
    while (next < tasks.length) {
      const idx = next++
      results[idx] = await tasks[idx]()
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

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

  // Fingerprints from last poll — used to skip re-mapping unchanged sessions.
  const fingerprintRef = useRef<Map<string, string>>(new Map())
  // Cached mapped Session objects, keyed by session_key.
  const mappedCacheRef = useRef<Map<string, Session>>(new Map())
  // Cached raw messages, keyed by session_key.
  const messagesCache = useRef<Map<string, GraphDMessage[]>>(new Map())
  // Guard against overlapping fetches.
  const fetchingRef = useRef(false)
  // AbortController for the current poll cycle — cancelled on unmount.
  const abortRef = useRef<AbortController | null>(null)

  const fetchSessions = useCallback(async () => {
    // Skip if a previous fetch is still in-flight.
    if (fetchingRef.current) return
    fetchingRef.current = true

    if (isFirstFetch.current) {
      setState('loading')
      isFirstFetch.current = false
    }
    setError(null)

    // Create a fresh AbortController for this cycle.
    const ac = new AbortController()
    abortRef.current = ac

    try {
      const sessionsResponse = await fetchAPI<ExportResponse>(
        '/export?table=sessions',
        { signal: ac.signal },
      )
      if (ac.signal.aborted) return

      const rawSessions = dedup(
        parseJSONL<GraphDSession>(sessionsResponse.data),
        s => s.session_key,
      )
      rawSessionsRef.current = rawSessions

      // ---- Bounded message fetches for active sessions ----
      const now = Date.now() / 1000
      const activeSessions = rawSessions.filter(
        s => s.status === 'active' && (now - toUnixSeconds(s.last_accessed_at)) < STALE_SESSION_SECONDS,
      )

      if (activeSessions.length > 0) {
        const tasks = activeSessions.map(s => async () => {
          try {
            const msgs = await fetchSessionMessages(s.session_key, ac.signal)
            messagesCache.current.set(s.session_key, msgs)
            loadedRef.current.add(s.session_key)
          } catch { /* individual failures are fine */ }
        })
        await pooled(tasks, MAX_CONCURRENT_MESSAGE_FETCHES)
        if (ac.signal.aborted) return
        setLoadedMessageSessions(new Set(loadedRef.current))
      }

      // ---- Incremental mapping: only re-map sessions whose data changed ----
      const prevFingerprints = fingerprintRef.current
      const nextFingerprints = new Map<string, string>()
      const nextMappedCache = new Map<string, Session>()
      const liveKeys = new Set<string>()

      const mappedSessions: Session[] = []
      for (const raw of rawSessions) {
        liveKeys.add(raw.session_key)
        const fp = sessionFingerprint(raw)
        nextFingerprints.set(raw.session_key, fp)

        // Re-use cached mapping if fingerprint unchanged AND we didn't just refresh its messages.
        const cached = mappedCacheRef.current.get(raw.session_key)
        const messageRefreshed = activeSessions.some(a => a.session_key === raw.session_key)
        if (cached && !messageRefreshed && prevFingerprints.get(raw.session_key) === fp) {
          mappedSessions.push(cached)
          nextMappedCache.set(raw.session_key, cached)
        } else {
          const msgs = messagesCache.current.get(raw.session_key) ?? []
          const mapped = mapGraphDSession(raw, msgs)
          mappedSessions.push(mapped)
          nextMappedCache.set(raw.session_key, mapped)
        }
      }

      // Evict dead sessions from caches.
      for (const key of messagesCache.current.keys()) {
        if (!liveKeys.has(key)) {
          messagesCache.current.delete(key)
          loadedRef.current.delete(key)
        }
      }

      fingerprintRef.current = nextFingerprints
      mappedCacheRef.current = nextMappedCache

      mappedSessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      setSessions(mappedSessions)
      setState('success')
    } catch (err) {
      if (ac.signal.aborted) return
      setError(err instanceof Error ? err.message : 'Unknown error')
      setState('error')
    } finally {
      fetchingRef.current = false
    }
  }, [])

  // Lazy load messages for a specific session when expanded.
  const loadSessionMessages = useCallback(async (sessionId: string) => {
    if (loadedRef.current.has(sessionId)) return

    try {
      const msgs = await fetchSessionMessages(sessionId)
      messagesCache.current.set(sessionId, msgs)

      const rawSession = rawSessionsRef.current.find(s => s.session_key === sessionId)
      if (!rawSession) return

      const updatedSession = mapGraphDSession(rawSession, msgs)
      mappedCacheRef.current.set(sessionId, updatedSession)
      // Update fingerprint so the next poll doesn't re-map it.
      fingerprintRef.current.set(sessionId, sessionFingerprint(rawSession))

      setSessions(prev => prev.map(s => s.id === sessionId ? updatedSession : s))

      loadedRef.current.add(sessionId)
      setLoadedMessageSessions(new Set(loadedRef.current))
    } catch {
      // Silent fail - messages are optional enhancement
    }
  }, [])

  const hasRunningRequests = useMemo(
    () => sessions.some(s => s.state === 'active'),
    [sessions],
  )

  // Initial fetch on mount.
  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  // Polling with adaptive interval + unmount cleanup.
  useEffect(() => {
    if (pollInterval <= 0) return

    const nextInterval = hasRunningRequests
      ? pollInterval
      : Math.max(IDLE_POLL_INTERVAL_MS, pollInterval * 5)
    const interval = setInterval(fetchSessions, nextInterval)

    return () => {
      clearInterval(interval)
      // Abort any in-flight requests when the polling effect re-runs or unmounts.
      abortRef.current?.abort()
    }
  }, [pollInterval, hasRunningRequests, fetchSessions])

  return {
    sessions,
    state,
    error,
    refetch: fetchSessions,
    hasRunningRequests,
    loadSessionMessages,
    loadedMessageSessions,
  }
}

// ---------------------------------------------------------------------------
// Derived hooks (unchanged)
// ---------------------------------------------------------------------------

export function useFilterCounts(sessions: Session[]): FilterCounts {
  return useMemo(() => {
    let errors = 0
    let running = 0
    let completed = 0

    for (const session of sessions) {
      if (session.insights.requestsFailed > 0) errors++
      if (session.state === 'active') running++
      if (session.insights.requestsCompleted > 0 && session.state !== 'active') completed++
    }

    return { all: sessions.length, errors, running, completed }
  }, [sessions])
}

export function useFilteredSessions(sessions: Session[], filter: FilterType): Session[] {
  return useMemo(() => {
    switch (filter) {
      case 'errors':
        return sessions.filter(s => s.insights.requestsFailed > 0)
      case 'running':
        return sessions.filter(s => s.state === 'active')
      case 'completed':
        return sessions.filter(s => s.insights.requestsCompleted > 0 && s.state !== 'active')
      case 'all':
      default:
        return sessions
    }
  }, [sessions, filter])
}
