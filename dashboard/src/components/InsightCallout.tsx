import { cn } from '../lib/utils'
import type { StatusTone } from './StatusBadge'

const borderColors: Record<StatusTone, string> = {
  neutral: 'border-l-slate-400',
  success: 'border-l-emerald-500',
  error: 'border-l-rose-500',
  active: 'border-l-blue-500',
  warning: 'border-l-amber-500',
}

export function InsightCallout({
  tone = 'active',
  title,
  children,
}: {
  tone?: StatusTone
  title: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('border-l-2 bg-slate-50 py-2 pl-3', borderColors[tone])}>
      <div className="text-sm font-medium text-slate-900">{title}</div>
      <div className="mt-1 text-sm text-slate-600">{children}</div>
    </div>
  )
}
