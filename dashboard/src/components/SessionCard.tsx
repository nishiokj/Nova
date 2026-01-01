import type { Session } from '../domain/models'
import { StatusBadge } from './StatusBadge'
import { CollapsibleSection } from './CollapsibleSection'
import { MetadataGrid } from './MetadataGrid'
import { InsightCallout } from './InsightCallout'
import { RequestRow } from './RequestRow'

function toneForSessionState(state: Session['state']) {
  switch (state) {
    case 'active':
      return 'blue'
    case 'idle':
      return 'amber'
    case 'ended':
      return 'slate'
    case 'error':
      return 'red'
  }
}

function envTone(env: Session['env']) {
  return env === 'prod' ? 'green' : env === 'staging' ? 'amber' : 'slate'
}

function fmtMs(ms?: number) {
  if (typeof ms !== 'number') return ''
  const s = Math.round(ms / 100) / 10
  return s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`
}

export function SessionCard({
  session,
  open,
  onOpenChange,
}: {
  session: Session
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const errors = session.requests.filter((r) => r.state === 'error').length
  const running = session.requests.filter((r) => r.state === 'running').length

  const action =
    errors > 0
      ? 'Investigate failing requests (review error details + traceIds)'
      : running > 0
        ? 'Monitor in-flight requests; check queue/backlog metadata'
        : 'Review slow endpoints and optimize hot paths'

  return (
    <CollapsibleSection
      open={open}
      onOpenChange={onOpenChange}
      summary={
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Session {session.id}</span>
              <StatusBadge tone={envTone(session.env)}>{session.env}</StatusBadge>
              <StatusBadge tone={toneForSessionState(session.state)}>{session.state}</StatusBadge>
              <StatusBadge tone={errors > 0 ? 'red' : 'slate'}>{errors} errors</StatusBadge>
              <StatusBadge tone={running > 0 ? 'blue' : 'slate'}>{running} running</StatusBadge>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              <span className="truncate">user: {session.userId}</span>
              <span>started: {new Date(session.startedAt).toLocaleString()}</span>
              <span>duration: {fmtMs(session.insights.durationMs)}</span>
              <span>error rate: {(session.insights.errorRate * 100).toFixed(0)}%</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {session.tags.slice(0, 3).map((t) => (
              <StatusBadge key={t} tone="slate">
                {t}
              </StatusBadge>
            ))}
          </div>
        </div>
      }
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <InsightCallout tone={errors > 0 ? 'red' : running > 0 ? 'blue' : 'green'} title="Actionable">
            {action}
          </InsightCallout>
          <MetadataGrid
            title="Metadata"
            items={{
              sessionId: session.id,
              userId: session.userId,
              env: session.env,
              ...session.meta,
            }}
            columns={2}
          />
          <MetadataGrid
            title="Requests summary"
            items={{
              total: session.requests.length,
              errors,
              running,
              p50: session.insights.latency.p50 ? `${session.insights.latency.p50}ms` : undefined,
              p90: session.insights.latency.p90 ? `${session.insights.latency.p90}ms` : undefined,
            }}
            columns={1}
          />
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-600">Requests</div>
          {session.requests.map((r) => (
            <RequestRow key={r.id} request={r} />
          ))}
        </div>
      </div>
    </CollapsibleSection>
  )
}
