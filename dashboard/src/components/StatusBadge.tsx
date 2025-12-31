import React from 'react'

export type StatusTone = 'slate' | 'green' | 'red' | 'amber' | 'blue' | 'violet'

const toneClass: Record<StatusTone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  red: 'bg-rose-100 text-rose-800 ring-rose-200',
  amber: 'bg-amber-100 text-amber-900 ring-amber-200',
  blue: 'bg-sky-100 text-sky-900 ring-sky-200',
  violet: 'bg-violet-100 text-violet-900 ring-violet-200',
}

export function StatusBadge({
  tone = 'slate',
  children,
  className,
}: {
  tone?: StatusTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        toneClass[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  )
}
