import { useState, useMemo } from 'react'
import type { PlanSnapshot } from '../domain/models'
import { cn } from '../lib/utils'
import { VerticalTimeline } from './ExecutionTimeline'

interface PlanCarouselProps {
  snapshots: PlanSnapshot[]
  className?: string
}

export function PlanCarousel({ snapshots, className }: PlanCarouselProps) {
  const sorted = useMemo(
    () => [...snapshots].sort((a, b) => b.version - a.version),
    [snapshots]
  )

  const [currentIndex, setCurrentIndex] = useState(0)
  const current = sorted[currentIndex]

  if (sorted.length === 0 || !current) return null

  const canPrev = currentIndex < sorted.length - 1
  const canNext = currentIndex > 0

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentIndex((i) => Math.min(i + 1, sorted.length - 1))}
            disabled={!canPrev}
            className={cn(
              'p-1 rounded hover:bg-[var(--bg-hover)] transition-colors',
              !canPrev && 'opacity-30 cursor-not-allowed'
            )}
            title="Older version"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <span className="text-sm font-mono">
            v{current.version}
            <span className="text-[var(--text-muted)] ml-1">
              ({sorted.length - currentIndex}/{sorted.length})
            </span>
          </span>

          <button
            onClick={() => setCurrentIndex((i) => Math.max(i - 1, 0))}
            disabled={!canNext}
            className={cn(
              'p-1 rounded hover:bg-[var(--bg-hover)] transition-colors',
              !canNext && 'opacity-30 cursor-not-allowed'
            )}
            title="Newer version"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={cn(
              'px-2 py-0.5 rounded text-xs font-mono',
              current.snapshotType === 'initial' && 'bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)]',
              current.snapshotType === 'pre_patch' && 'bg-[var(--warning)]/10 text-[var(--warning)]',
              current.snapshotType === 'post_patch' && 'bg-[var(--success)]/10 text-[var(--success)]'
            )}
          >
            {current.snapshotType.replace('_', ' ')}
          </span>

          {currentIndex === 0 && (
            <span className="px-2 py-0.5 rounded text-xs bg-[var(--running)]/10 text-[var(--running)]">
              CURRENT
            </span>
          )}
        </div>
      </div>

      {current.trigger && (
        <p className="text-xs text-[var(--text-muted)] italic">Trigger: {current.trigger}</p>
      )}

      <div className="flex items-center justify-center gap-1">
        {sorted.map((_, idx) => (
          <button
            key={idx}
            onClick={() => setCurrentIndex(idx)}
            className={cn(
              'w-2 h-2 rounded-full transition-all',
              idx === currentIndex
                ? 'bg-[var(--running)] scale-125'
                : 'bg-[var(--border-default)] hover:bg-[var(--border-strong)]'
            )}
          />
        ))}
      </div>

      <div className="bg-[var(--bg-elevated)] rounded-lg p-3 border border-[var(--border-subtle)]">
        <p className="text-xs text-[var(--text-muted)] mb-2">Goal: {current.goal}</p>
        <VerticalTimeline steps={current.steps} />
      </div>
    </div>
  )
}
