import React from 'react'
import { StatusBadge, type StatusTone } from './StatusBadge'

export function InsightCallout({
  tone = 'blue',
  title,
  children,
}: {
  tone?: StatusTone
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3 px-3 py-2">
        <div className="text-sm font-medium">{title}</div>
        <StatusBadge tone={tone}>insight</StatusBadge>
      </div>
      <div className="px-3 pb-3 text-sm text-slate-700">{children}</div>
    </div>
  )
}
