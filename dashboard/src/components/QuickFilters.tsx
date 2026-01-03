import type { FilterType, FilterCounts } from '../domain/models'
import { cn } from '../lib/utils'

interface QuickFiltersProps {
  active: FilterType
  counts: FilterCounts
  onChange: (filter: FilterType) => void
}

const filters: { key: FilterType; label: string; icon: React.ReactNode }[] = [
  {
    key: 'all',
    label: 'All',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    ),
  },
  {
    key: 'errors',
    label: 'Errors',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
  },
  {
    key: 'running',
    label: 'Running',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    key: 'completed',
    label: 'Done',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
]

export function QuickFilters({ active, counts, onChange }: QuickFiltersProps) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)]">
      {filters.map((filter) => {
        const count = counts[filter.key]
        const isActive = active === filter.key
        const isEmpty = count === 0 && filter.key !== 'all'

        return (
          <button
            key={filter.key}
            onClick={() => onChange(filter.key)}
            disabled={isEmpty}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--running)]',
              isActive
                ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              isEmpty && 'opacity-40 cursor-not-allowed',
              filter.key === 'errors' && count > 0 && !isActive && 'text-[var(--error)]',
              filter.key === 'running' && count > 0 && !isActive && 'text-[var(--running)]'
            )}
          >
            {filter.icon}
            <span>{filter.label}</span>
            {count > 0 && (
              <span
                className={cn(
                  'font-mono tabular-nums px-1.5 py-0.5 rounded text-[10px] leading-none',
                  isActive
                    ? 'bg-[var(--border-subtle)] text-[var(--text-secondary)]'
                    : 'bg-[var(--bg-base)] text-[var(--text-muted)]'
                )}
              >
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
