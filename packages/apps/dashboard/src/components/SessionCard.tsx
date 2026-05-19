import { memo, useEffect, useMemo, useState } from 'react'
import type { Session } from '../domain/models'
import { StatusBadge, StatusDot, type StatusTone } from './StatusBadge'
import { CollapsibleSection } from './CollapsibleSection'
import { RequestRow } from './RequestRow'
import { WatcherDecisionPanel, WatcherDecisionBadge } from './WatcherDecisionPanel'
import { formatDateTime, formatDuration } from '../lib/time'
import { cn } from '../lib/utils'
import { deleteSession } from '../lib/api'

function toneForSessionState(state: Session['state']): StatusTone {
  switch (state) {
    case 'active':
      return 'active'
    case 'error':
      return 'error'
    case 'idle':
    case 'ended':
      return 'neutral'
  }
}

function envTone(env: Session['env']): StatusTone {
  return env === 'prod' ? 'success' : 'neutral'
}

interface SessionCardProps {
  session: Session
  open: boolean
  onOpenChange: (next: boolean) => void
  onDelete?: (sessionId: string) => void
}

const INITIAL_VISIBLE_REQUESTS = 6
const REQUESTS_PAGE_SIZE = 6
const INITIAL_VISIBLE_WATCHER = 8
const WATCHER_PAGE_SIZE = 8

export const SessionCard = memo(function SessionCard({
  session,
  open,
  onOpenChange,
  onDelete,
}: SessionCardProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [visibleRequestCount, setVisibleRequestCount] = useState(INITIAL_VISIBLE_REQUESTS)
  const [visibleWatcherCount, setVisibleWatcherCount] = useState(INITIAL_VISIBLE_WATCHER)
  const { insights } = session
  const hasErrors = insights.requestsFailed > 0
  const hasRunning = session.state === 'active'
  const visibleRequests = useMemo(
    () => session.requests.slice(-visibleRequestCount),
    [session.requests, visibleRequestCount]
  )
  const hasMoreRequests = session.requests.length > visibleRequestCount
  const visibleWatcherDecisions = useMemo(
    () => session.watcherDecisions.slice(-visibleWatcherCount),
    [session.watcherDecisions, visibleWatcherCount]
  )
  const hasMoreWatcher = session.watcherDecisions.length > visibleWatcherCount

  const variant = hasErrors ? 'error' : hasRunning ? 'running' : 'default'

  useEffect(() => {
    if (!open) {
      setVisibleRequestCount(INITIAL_VISIBLE_REQUESTS)
      setVisibleWatcherCount(INITIAL_VISIBLE_WATCHER)
    }
  }, [open, session.id])

  return (
    <>
      <CollapsibleSection
        open={open}
        onOpenChange={onOpenChange}
        label={`Toggle session ${session.id}`}
        variant={variant}
        summary={
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1">
              {/* Session ID and badges */}
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs font-semibold text-[var(--text-primary)]">
                  {session.id}
                </span>
                <StatusBadge tone={envTone(session.env)}>{session.env}</StatusBadge>
                {session.state !== 'idle' && (
                  <StatusBadge
                    tone={toneForSessionState(session.state)}
                    pulse={session.state === 'active'}
                  >
                    {session.state}
                  </StatusBadge>
                )}
              </div>

              {/* Session metadata — inline with ID */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
                <span className="font-mono">{session.userId}</span>
                <span>{formatDateTime(session.startedAt)}</span>
                <span>{formatDuration(insights.durationMs)}</span>
                {session.meta.workingDir && (
                  <span className="font-mono truncate max-w-48" title={session.meta.workingDir}>
                    {session.meta.workingDir}
                  </span>
                )}
              </div>
            </div>

            {/* Right side: request stats */}
            <div className="flex items-center gap-2">
              {/* Request count */}
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-sm tabular-nums text-[var(--text-secondary)]">
                  {insights.requestCount}
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  request{insights.requestCount !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Error indicator */}
              {hasErrors && (
                <div className="flex items-center gap-1.5">
                  <StatusDot status="error" />
                  <span className="font-mono text-xs tabular-nums text-[var(--error)]">
                    {insights.requestsFailed}
                  </span>
                </div>
              )}

              {/* Running indicator */}
              {hasRunning && (
                <div className="flex items-center gap-1.5">
                  <StatusDot status="running" pulse />
                  {insights.requestsRunning > 0 && (
                    <span className="font-mono text-xs tabular-nums text-[var(--running)]">
                      {insights.requestsRunning}
                    </span>
                  )}
                </div>
              )}

              {/* Average quality */}
              {insights.avgQuality !== undefined && (
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'font-mono text-xs tabular-nums',
                      insights.avgQuality >= 0.8
                        ? 'text-[var(--success)]'
                        : insights.avgQuality >= 0.5
                          ? 'text-[var(--warning)]'
                          : 'text-[var(--error)]'
                    )}
                  >
                    {Math.round(insights.avgQuality * 100)}%
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">avg</span>
                </div>
              )}

              {/* Watcher decisions indicator */}
              {session.watcherDecisions.length > 0 && (
                <WatcherDecisionBadge decisions={session.watcherDecisions} />
              )}

              {/* Tags */}
              {session.tags.slice(0, 2).map((t) => (
                <StatusBadge key={t} tone="neutral" className="hidden md:inline-flex">
                  {t}
                </StatusBadge>
              ))}

              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation()
                  setShowDeleteConfirm(true)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation()
                    setShowDeleteConfirm(true)
                  }
                }}
                className="p-1 rounded hover:bg-[var(--error-bg)] text-[var(--text-muted)] hover:text-[var(--error)] transition-colors"
                title="Delete session"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </span>
            </div>
          </div>
        }
      >
        <div className="space-y-2">
          {/* Watcher Decisions */}
          {session.watcherDecisions.length > 0 && (
            <div className="mb-2">
              <div className="flex items-center gap-1.5 mb-1">
                <svg className="w-4 h-4 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Watcher Decisions ({session.watcherDecisions.length})
                </span>
              </div>
              <WatcherDecisionPanel decisions={visibleWatcherDecisions} />
              {hasMoreWatcher && (
                <button
                  type="button"
                  onClick={() => setVisibleWatcherCount((prev) => prev + WATCHER_PAGE_SIZE)}
                  className="mt-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                >
                  Show older decisions ({session.watcherDecisions.length - visibleWatcherCount} more)
                </button>
              )}
            </div>
          )}

          {/* Requests list */}
          {session.requests.length > 0 ? (
            <div className="space-y-1">
              {visibleRequests.map((request) => (
                <RequestRow key={request.id} request={request} />
              ))}
              {hasMoreRequests && (
                <button
                  type="button"
                  onClick={() => setVisibleRequestCount((prev) => prev + REQUESTS_PAGE_SIZE)}
                  className="w-full py-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] rounded transition-colors"
                >
                  Show older requests ({session.requests.length - visibleRequestCount} more)
                </button>
              )}
            </div>
          ) : (
            <div className="py-4 text-center">
              <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-[var(--bg-elevated)] mb-2">
                <svg
                  className="w-4 h-4 text-[var(--text-muted)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
                  />
                </svg>
              </div>
              <p className="text-xs text-[var(--text-muted)]">No requests in this session</p>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Requests will appear when the agent processes user input
              </p>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-surface)] rounded-lg p-4 max-w-sm">
            <p className="text-sm mb-4">Delete this session? This cannot be undone.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowDeleteConfirm(false)} className="px-3 py-1.5 text-sm rounded hover:bg-[var(--bg-hover)]">
                Cancel
              </button>
              <button
                onClick={async () => {
                  try {
                    const deleted = await deleteSession(session.id)
                    setShowDeleteConfirm(false)
                    if (deleted) {
                      onDelete?.(session.id)
                    }
                  } catch {
                    setShowDeleteConfirm(false)
                  }
                }}
                className="px-3 py-1.5 text-sm rounded bg-[var(--error)] text-white hover:opacity-90"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
})
