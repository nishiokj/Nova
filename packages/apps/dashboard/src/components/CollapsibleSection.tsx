import { cn } from '../lib/utils'

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

export function CollapsibleSection({
  open,
  onOpenChange,
  summary,
  children,
  label,
  variant = 'default',
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  summary: React.ReactNode
  children: React.ReactNode
  label?: string
  variant?: 'default' | 'error' | 'running'
}) {
  const borderClass = {
    default: 'border-[var(--border-subtle)]',
    error: 'border-[var(--error-muted)]',
    running: 'border-[var(--running-muted)]',
  }[variant]

  return (
    <div
      className={cn(
        'rounded-lg border bg-[var(--bg-surface)] transition-all duration-200',
        borderClass,
        open && 'ring-1 ring-[var(--border-default)]'
      )}
    >
      <button
        type="button"
        className={cn(
          'flex w-full items-start justify-between gap-3 px-3 py-1.5 text-left',
          'transition-colors hover:bg-[var(--bg-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--running)]',
          'rounded-lg',
          open && 'rounded-b-none'
        )}
        aria-expanded={open}
        aria-label={label ?? 'Toggle section'}
        onClick={() => onOpenChange(!open)}
      >
        <div className="min-w-0 flex-1">{summary}</div>
        <ChevronRight
          className={cn(
            'mt-0.5 text-[var(--text-muted)] transition-transform duration-200',
            open ? 'rotate-90' : 'rotate-0'
          )}
        />
      </button>

      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-250 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="overflow-hidden">
          <div className="border-t border-[var(--border-subtle)] px-3 pb-2.5 pt-2">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
