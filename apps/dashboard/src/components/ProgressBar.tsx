import type { PlanStep, StepStatus } from '../domain/models'
import { cn } from '../lib/utils'

function getSegmentClass(status: StepStatus): string {
  switch (status) {
    case 'completed':
      return 'progress-completed'
    case 'in_progress':
      return 'progress-running'
    case 'failed':
      return 'progress-failed'
    case 'skipped':
      return 'progress-skipped'
    case 'pending':
    default:
      return 'progress-pending'
  }
}

interface ProgressBarProps {
  steps: PlanStep[]
  compact?: boolean
  showLabel?: boolean
}

export function ProgressBar({ steps, compact = false, showLabel = true }: ProgressBarProps) {
  if (steps.length === 0) return null

  const completed = steps.filter((s) => s.status === 'completed').length
  const failed = steps.filter((s) => s.status === 'failed').length
  const total = steps.length

  return (
    <div className={cn('flex items-center gap-2', compact ? 'gap-1.5' : 'gap-2')}>
      {showLabel && (
        <span className="font-mono text-xs text-[var(--text-muted)] tabular-nums whitespace-nowrap">
          {completed}/{total}
        </span>
      )}
      <div className={cn('flex gap-0.5 flex-1', compact ? 'max-w-16' : 'max-w-24')}>
        {steps.map((step, i) => (
          <div
            key={step.stepNum}
            className={cn('progress-segment flex-1 min-w-1', getSegmentClass(step.status))}
            style={{ animationDelay: `${i * 100}ms` }}
            title={`Step ${step.stepNum}: ${step.objective}`}
          />
        ))}
      </div>
      {failed > 0 && (
        <span className="text-xs text-[var(--error)] font-mono">{failed} failed</span>
      )}
    </div>
  )
}

// Simpler progress for when we just have counts
export function SimpleProgress({
  completed,
  total,
  hasError = false,
}: {
  completed: number
  total: number
  hasError?: boolean
}) {
  const percent = total > 0 ? (completed / total) * 100 : 0

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs text-[var(--text-muted)] tabular-nums">
        {completed}/{total}
      </span>
      <div className="h-1 w-16 rounded-full bg-[var(--border-subtle)] overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            hasError ? 'bg-[var(--error)]' : 'bg-[var(--success)]'
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
