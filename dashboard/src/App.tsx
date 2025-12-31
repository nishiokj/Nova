import { useMemo, useState } from 'react'
import { mockSessions } from './domain/mockData'
import type { Session } from './domain/models'
import { SessionCard, StatusBadge } from './components'

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">{children}</div>
}

function CardHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-3">
      <div>
        <h1 className="text-base font-semibold">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-slate-600">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  )
}

export default function App() {
  const sessions = useMemo(() => mockSessions, [])

  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const s of sessions) init[s.id] = true
    return init
  })

  const totals = useMemo(() => {
    const allReq = sessions.flatMap((s: Session) => s.requests)
    const errors = allReq.filter((r) => r.state === 'error').length
    const running = allReq.filter((r) => r.state === 'running').length
    return { sessions: sessions.length, requests: allReq.length, errors, running }
  }, [sessions])

  return (
    <div className="min-h-dvh">
      <div className="mx-auto max-w-6xl p-6">
        <Card>
          <CardHeader
            title="Sessions → Requests"
            subtitle="Actionable state, metadata, and insights with a collapsible hierarchy"
            right={
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="slate">{totals.sessions} sessions</StatusBadge>
                <StatusBadge tone="slate">{totals.requests} requests</StatusBadge>
                <StatusBadge tone={totals.errors ? 'red' : 'slate'}>{totals.errors} errors</StatusBadge>
                <StatusBadge tone={totals.running ? 'blue' : 'slate'}>{totals.running} running</StatusBadge>
              </div>
            }
          />

          <div className="space-y-3 p-4">
            {sessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                open={open[s.id] ?? false}
                onOpenChange={(next) => setOpen((m) => ({ ...m, [s.id]: next }))}
              />
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
