import { cn } from '../lib/utils'

export type StatusTone = 'neutral' | 'success' | 'error' | 'active' | 'warning'

const toneClasses: Record<StatusTone, string> = {
  neutral: 'bg-[var(--pending-bg)] text-[var(--text-secondary)] border-[var(--border-subtle)]',
  success: 'bg-[var(--success-bg)] text-[var(--success)] border-[var(--success-muted)]',
  error: 'bg-[var(--error-bg)] text-[var(--error)] border-[var(--error-muted)]',
  active: 'bg-[var(--running-bg)] text-[var(--running)] border-[var(--running-muted)]',
  warning: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-muted)]',
}

export function StatusBadge({
  tone = 'neutral',
  children,
  className,
  pulse = false,
}: {
  tone?: StatusTone
  children: React.ReactNode
  className?: string
  pulse?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0 text-[10px] leading-[1.4] font-medium border',
        'font-mono tracking-tight',
        toneClasses[tone],
        pulse && 'animate-pulse-glow',
        className
      )}
    >
      {children}
    </span>
  )
}

// Dot indicator for compact status display
export function StatusDot({
  status,
  size = 'sm',
  pulse = false,
  className,
}: {
  status: 'success' | 'error' | 'running' | 'pending' | 'skipped'
  size?: 'sm' | 'md'
  pulse?: boolean
  className?: string
}) {
  const sizeClass = size === 'sm' ? 'w-2 h-2' : 'w-3 h-3'

  const colorClass = {
    success: 'bg-[var(--success)]',
    error: 'bg-[var(--error)]',
    running: 'bg-[var(--running)]',
    pending: 'bg-[var(--pending)]',
    skipped: 'bg-[var(--pending)] opacity-50',
  }[status]

  return (
    <span
      className={cn(
        'inline-block rounded-full',
        sizeClass,
        colorClass,
        pulse && status === 'running' && 'animate-pulse-glow',
        className
      )}
    />
  )
}
