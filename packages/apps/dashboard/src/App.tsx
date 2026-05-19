import { useCallback, useMemo, useState } from 'react'
import { useSessions, useFilterCounts, useFilteredSessions } from './hooks/useSessions'
import { mockSessions } from './domain/mockData'
import type { FilterType, Session } from './domain/models'
import { SessionCard } from './components/SessionCard'
import { QuickFilters } from './components/QuickFilters'
import { LoadingSkeleton } from './components/LoadingSkeleton'
import { EmptyState } from './components/EmptyState'
import { StatusDot } from './components/StatusBadge'

type SessionTab = 'active' | 'inactive'

const ACTIVE_PAGE_SIZE = 12
const INACTIVE_PAGE_SIZE = 5

function isSessionActive(s: Session): boolean {
  return s.state === 'active'
}

export default function App() {
  const { sessions: fetchedSessions, state, error, refetch, hasRunningRequests, loadSessionMessages, loadedMessageSessions } = useSessions()
  const [deletedSessions, setDeletedSessions] = useState<Set<string>>(new Set())

  // Use fetched data when available, fallback to mock only on error
  const rawSessions = state === 'error' ? mockSessions : fetchedSessions
  const sessions = rawSessions.filter((s) => !deletedSessions.has(s.id))
  const showMockWarning = state === 'error'

  // Filter state
  const [filter, setFilter] = useState<FilterType>('all')
  const filterCounts = useFilterCounts(sessions)
  const filteredSessions = useFilteredSessions(sessions, filter)

  // Active/Inactive tab state
  const [tab, setTab] = useState<SessionTab>('active')
  const [activeLimit, setActiveLimit] = useState(ACTIVE_PAGE_SIZE)
  const [inactiveLimit, setInactiveLimit] = useState(INACTIVE_PAGE_SIZE)

  // Split filtered sessions into active and inactive
  const { activeSessions, inactiveSessions } = useMemo(() => {
    const active: Session[] = []
    const inactive: Session[] = []
    for (const s of filteredSessions) {
      if (isSessionActive(s)) {
        active.push(s)
      } else {
        inactive.push(s)
      }
    }
    return { activeSessions: active, inactiveSessions: inactive }
  }, [filteredSessions])

  const visibleActiveSessions = useMemo(
    () => activeSessions.slice(0, activeLimit),
    [activeSessions, activeLimit]
  )
  const hasMoreActive = activeLimit < activeSessions.length

  const loadMoreActive = useCallback(() => {
    setActiveLimit((prev) => prev + ACTIVE_PAGE_SIZE)
  }, [])

  // Lazy-load inactive sessions
  const visibleInactiveSessions = useMemo(
    () => inactiveSessions.slice(0, inactiveLimit),
    [inactiveSessions, inactiveLimit]
  )
  const hasMoreInactive = inactiveLimit < inactiveSessions.length

  const loadMoreInactive = useCallback(() => {
    setInactiveLimit((prev) => prev + INACTIVE_PAGE_SIZE)
  }, [])

  // Reset inactive limit when filter changes
  const handleFilterChange = useCallback((f: FilterType) => {
    setFilter(f)
    setActiveLimit(ACTIVE_PAGE_SIZE)
    setInactiveLimit(INACTIVE_PAGE_SIZE)
  }, [])

  // Session expansion state - initialize ALL sessions as COLLAPSED
  const [open, setOpen] = useState<Set<string>>(new Set())
  const handleOpenChange = useCallback((sessionId: string, next: boolean) => {
    setOpen((prev) => {
      const updated = new Set(prev)
      if (next) {
        updated.add(sessionId)
        // Lazy load messages when expanding a session that hasn't been loaded
        if (!loadedMessageSessions.has(sessionId)) {
          loadSessionMessages(sessionId)
        }
      } else {
        updated.delete(sessionId)
      }
      return updated
    })
  }, [loadSessionMessages, loadedMessageSessions])

  const handleDelete = useCallback((sessionId: string) => {
    setDeletedSessions((prev) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
    setOpen((prev) => {
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  // Global stats
  const totals = useMemo(() => {
    let requests = 0
    let running = 0
    let errors = 0
    let completed = 0

    for (const s of sessions) {
      requests += s.insights.requestCount
      running += s.state === 'active' ? s.insights.requestsRunning : 0
      errors += s.insights.requestsFailed
      completed += s.insights.requestsCompleted
    }

    return { sessions: sessions.length, requests, running, errors, completed }
  }, [sessions])

  return (
    <div className="min-h-dvh bg-[var(--bg-base)]">
      <div className="mx-auto max-w-7xl px-4 py-3">
        {/* Header */}
        <header className="mb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-baseline gap-3">
              <h1 className="text-base font-semibold text-[var(--text-primary)] tracking-tight">
                Agent Monitor
              </h1>
              <p className="text-xs text-[var(--text-muted)]">
                Execution telemetry and task insights
                {showMockWarning && (
                  <span className="ml-2 text-[var(--error)]" title={error ?? undefined}>
                    Connection failed: {error ?? 'API unavailable'}
                  </span>
                )}
              </p>
            </div>

            {/* Quick filters */}
            <QuickFilters active={filter} counts={filterCounts} onChange={handleFilterChange} />
          </div>

          {/* Summary stats bar */}
          <div className="mt-2 flex items-center gap-4 py-1.5 px-3 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
            <div className="flex items-baseline gap-1.5">
              <span className="text-base font-semibold font-mono tabular-nums text-[var(--text-primary)]">
                {totals.sessions}
              </span>
              <span className="text-xs text-[var(--text-muted)]">sessions</span>
            </div>

            <div className="w-px h-4 bg-[var(--border-subtle)]" />

            <div className="flex items-baseline gap-1.5">
              <span className="text-base font-semibold font-mono tabular-nums text-[var(--text-primary)]">
                {totals.requests}
              </span>
              <span className="text-xs text-[var(--text-muted)]">requests</span>
            </div>

            {totals.running > 0 && (
              <>
                <div className="w-px h-4 bg-[var(--border-subtle)]" />
                <div className="flex items-center gap-1.5">
                  <StatusDot status="running" pulse />
                  <span className="text-sm font-semibold font-mono tabular-nums text-[var(--running)]">
                    {totals.running}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">running</span>
                </div>
              </>
            )}

            {totals.errors > 0 && (
              <>
                <div className="w-px h-4 bg-[var(--border-subtle)]" />
                <div className="flex items-center gap-1.5">
                  <StatusDot status="error" />
                  <span className="text-sm font-semibold font-mono tabular-nums text-[var(--error)]">
                    {totals.errors}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">failed</span>
                </div>
              </>
            )}

            {totals.completed > 0 && (
              <>
                <div className="w-px h-4 bg-[var(--border-subtle)]" />
                <div className="flex items-center gap-1.5">
                  <StatusDot status="success" />
                  <span className="text-sm font-semibold font-mono tabular-nums text-[var(--success)]">
                    {totals.completed}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">done</span>
                </div>
              </>
            )}

            {/* Live indicator */}
            {hasRunningRequests && (
              <div className="ml-auto flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--running)] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--running)]" />
                </span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Live</span>
              </div>
            )}
          </div>
        </header>

        {/* Error Banner */}
        {state === 'error' && (
          <div className="mb-2 px-3 py-2 rounded-md bg-[var(--error)]/10 border border-[var(--error)]/30">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-[var(--error)] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p className="text-xs">
                  <span className="font-medium text-[var(--error)]">Connection error</span>
                  <span className="ml-2 text-[var(--text-muted)]">{error ?? 'Failed to connect to backend'}</span>
                </p>
              </div>
              <button
                onClick={refetch}
                className="px-2 py-1 text-xs font-medium rounded bg-[var(--error)]/20 text-[var(--error)] hover:bg-[var(--error)]/30 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Content */}
        <main className="space-y-2">
          {state === 'loading' && <LoadingSkeleton count={3} />}

          {state === 'success' && filteredSessions.length === 0 && filter === 'all' && (
            <EmptyState />
          )}

          {state === 'success' && filteredSessions.length === 0 && filter !== 'all' && (
            <div className="py-12 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[var(--bg-elevated)] mb-3">
                <svg
                  className="w-6 h-6 text-[var(--text-muted)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                  />
                </svg>
              </div>
              <p className="text-sm text-[var(--text-muted)]">
                No sessions match the "{filter}" filter
              </p>
              <button
                onClick={() => handleFilterChange('all')}
                className="mt-2 text-sm text-[var(--running)] hover:underline"
              >
                Show all sessions
              </button>
            </div>
          )}

          {(state === 'success' || state === 'error') && filteredSessions.length > 0 && (
            <>
              {/* Active/Inactive Tabs */}
              <div className="flex gap-0.5 p-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] w-fit">
                <button
                  onClick={() => setTab('active')}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                    tab === 'active'
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  Active
                  {activeSessions.length > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 text-[10px] leading-none rounded-full bg-[var(--running)]/20 text-[var(--running)]">
                      {activeSessions.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setTab('inactive')}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                    tab === 'inactive'
                      ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  Inactive
                  {inactiveSessions.length > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 text-[10px] leading-none rounded-full bg-[var(--text-muted)]/20 text-[var(--text-muted)]">
                      {inactiveSessions.length}
                    </span>
                  )}
                </button>
              </div>

              {/* Active Sessions */}
              {tab === 'active' && (
                <div className="space-y-1.5">
                  {activeSessions.length === 0 ? (
                    <div className="py-8 text-center">
                      <p className="text-sm text-[var(--text-muted)]">No active sessions</p>
                      <button
                        onClick={() => setTab('inactive')}
                        className="mt-2 text-sm text-[var(--running)] hover:underline"
                      >
                        View inactive sessions
                      </button>
                    </div>
                  ) : (
                    <>
                      {visibleActiveSessions.map((s) => (
                        <SessionCard
                          key={s.id}
                          session={s}
                          open={open.has(s.id)}
                          onOpenChange={(next) => handleOpenChange(s.id, next)}
                          onDelete={handleDelete}
                        />
                      ))}
                      {hasMoreActive && (
                        <button
                          onClick={loadMoreActive}
                          className="w-full py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] rounded-md transition-colors"
                        >
                          Load more ({activeSessions.length - activeLimit} remaining)
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Inactive Sessions (lazy loaded) */}
              {tab === 'inactive' && (
                <div className="space-y-1.5">
                  {inactiveSessions.length === 0 ? (
                    <div className="py-8 text-center">
                      <p className="text-sm text-[var(--text-muted)]">No inactive sessions</p>
                      <button
                        onClick={() => setTab('active')}
                        className="mt-2 text-sm text-[var(--running)] hover:underline"
                      >
                        View active sessions
                      </button>
                    </div>
                  ) : (
                    <>
                      {visibleInactiveSessions.map((s) => (
                        <SessionCard
                          key={s.id}
                          session={s}
                          open={open.has(s.id)}
                          onOpenChange={(next) => handleOpenChange(s.id, next)}
                          onDelete={handleDelete}
                        />
                      ))}
                      {hasMoreInactive && (
                        <button
                          onClick={loadMoreInactive}
                          className="w-full py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] rounded-md transition-colors"
                        >
                          Load more ({inactiveSessions.length - inactiveLimit} remaining)
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </main>

        {/* Footer */}
        <footer className="mt-6 pt-3 border-t border-[var(--border-subtle)]">
          <p className="text-[10px] text-[var(--text-muted)] text-center">
            Agent Monitor • Polling every 2s when tasks running
          </p>
        </footer>
      </div>
    </div>
  )
}
