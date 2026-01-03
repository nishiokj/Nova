import { useMemo, useState } from 'react'
import { useSessions, useFilterCounts, useFilteredSessions } from './hooks/useSessions'
import { mockSessions } from './domain/mockData'
import type { FilterType } from './domain/models'
import { SessionCard } from './components/SessionCard'
import { QuickFilters } from './components/QuickFilters'
import { LoadingSkeleton } from './components/LoadingSkeleton'
import { EmptyState } from './components/EmptyState'
import { StatusDot } from './components/StatusBadge'

export default function App() {
  const { sessions: fetchedSessions, state, hasRunningRequests } = useSessions()
  const [deletedSessions, setDeletedSessions] = useState<Set<string>>(new Set())

  // Use fetched data when available, fallback to mock only on error
  const rawSessions = state === 'error' ? mockSessions : fetchedSessions
  const sessions = rawSessions.filter((s) => !deletedSessions.has(s.id))
  const showMockWarning = state === 'error'

  // Filter state
  const [filter, setFilter] = useState<FilterType>('all')
  const filterCounts = useFilterCounts(sessions)
  const filteredSessions = useFilteredSessions(sessions, filter)

  // Session expansion state - initialize ALL sessions as COLLAPSED
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const handleDelete = (sessionId: string) => {
    setDeletedSessions((prev) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
    setOpen((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }

  // Global stats
  const totals = useMemo(() => {
    let requests = 0
    let running = 0
    let errors = 0
    let completed = 0

    for (const s of sessions) {
      requests += s.insights.requestCount
      running += s.insights.requestsRunning
      errors += s.insights.requestsFailed
      completed += s.insights.requestsCompleted
    }

    return { sessions: sessions.length, requests, running, errors, completed }
  }, [sessions])

  return (
    <div className="min-h-dvh bg-[var(--bg-base)]">
      <div className="mx-auto max-w-6xl p-6">
        {/* Header */}
        <header className="mb-8">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
                Agent Monitor
              </h1>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                Execution telemetry and task insights
                {showMockWarning && (
                  <span className="ml-2 text-[var(--warning)]">(mock data - API unavailable)</span>
                )}
              </p>
            </div>

            {/* Quick filters */}
            <QuickFilters active={filter} counts={filterCounts} onChange={setFilter} />
          </div>

          {/* Summary stats bar */}
          <div className="mt-4 flex items-center gap-6 py-3 px-4 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
            <div className="flex items-center gap-2">
              <span className="text-2xl font-semibold font-mono tabular-nums text-[var(--text-primary)]">
                {totals.sessions}
              </span>
              <span className="text-sm text-[var(--text-muted)]">sessions</span>
            </div>

            <div className="w-px h-6 bg-[var(--border-subtle)]" />

            <div className="flex items-center gap-2">
              <span className="text-2xl font-semibold font-mono tabular-nums text-[var(--text-primary)]">
                {totals.requests}
              </span>
              <span className="text-sm text-[var(--text-muted)]">requests</span>
            </div>

            {totals.running > 0 && (
              <>
                <div className="w-px h-6 bg-[var(--border-subtle)]" />
                <div className="flex items-center gap-2">
                  <StatusDot status="running" pulse />
                  <span className="text-lg font-semibold font-mono tabular-nums text-[var(--running)]">
                    {totals.running}
                  </span>
                  <span className="text-sm text-[var(--text-muted)]">running</span>
                </div>
              </>
            )}

            {totals.errors > 0 && (
              <>
                <div className="w-px h-6 bg-[var(--border-subtle)]" />
                <div className="flex items-center gap-2">
                  <StatusDot status="error" />
                  <span className="text-lg font-semibold font-mono tabular-nums text-[var(--error)]">
                    {totals.errors}
                  </span>
                  <span className="text-sm text-[var(--text-muted)]">failed</span>
                </div>
              </>
            )}

            {totals.completed > 0 && (
              <>
                <div className="w-px h-6 bg-[var(--border-subtle)]" />
                <div className="flex items-center gap-2">
                  <StatusDot status="success" />
                  <span className="text-lg font-semibold font-mono tabular-nums text-[var(--success)]">
                    {totals.completed}
                  </span>
                  <span className="text-sm text-[var(--text-muted)]">done</span>
                </div>
              </>
            )}

            {/* Live indicator */}
            {hasRunningRequests && (
              <div className="ml-auto flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--running)] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--running)]" />
                </span>
                <span className="text-xs text-[var(--text-muted)]">LIVE</span>
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="space-y-3">
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
                onClick={() => setFilter('all')}
                className="mt-2 text-sm text-[var(--running)] hover:underline"
              >
                Show all sessions
              </button>
            </div>
          )}

          {(state === 'success' || state === 'error') &&
            filteredSessions.length > 0 &&
            filteredSessions.map((s, i) => (
              <div
                key={s.id}
                className="animate-fade-in"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <SessionCard
                  session={s}
                  open={open[s.id] ?? false}
                  onOpenChange={(next) => setOpen((m) => ({ ...m, [s.id]: next }))}
                  onDelete={handleDelete}
                />
              </div>
            ))}
        </main>

        {/* Footer */}
        <footer className="mt-12 pt-6 border-t border-[var(--border-subtle)]">
          <p className="text-xs text-[var(--text-muted)] text-center">
            Agent Monitor • Polling every 2s when tasks running
          </p>
        </footer>
      </div>
    </div>
  )
}
