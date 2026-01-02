import type { PlanStep, StepStatus } from '../domain/models'
import { cn } from '../lib/utils'

function getStepColor(status: StepStatus): string {
  switch (status) {
    case 'completed':
      return 'var(--success)'
    case 'in_progress':
      return 'var(--running)'
    case 'failed':
      return 'var(--error)'
    case 'skipped':
      return 'var(--pending)'
    case 'pending':
    default:
      return 'var(--border-default)'
  }
}

function getStepBgClass(status: StepStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-[var(--success)]'
    case 'in_progress':
      return 'bg-[var(--running)]'
    case 'failed':
      return 'bg-[var(--error)]'
    case 'skipped':
      return 'bg-[var(--pending)] opacity-50'
    case 'pending':
    default:
      return 'bg-[var(--border-default)]'
  }
}

interface ExecutionTimelineProps {
  steps: PlanStep[]
  onStepClick?: (step: PlanStep) => void
  selectedStep?: number
  compact?: boolean
}

export function ExecutionTimeline({
  steps,
  onStepClick,
  selectedStep,
  compact = false,
}: ExecutionTimelineProps) {
  if (steps.length === 0) return null

  // Find current step (first in_progress or first pending after all completed)
  const currentStepNum = steps.find((s) => s.status === 'in_progress')?.stepNum

  return (
    <div className={cn('flex items-center gap-1', compact ? 'gap-0.5' : 'gap-1')}>
      {steps.map((step, idx) => {
        const isFirst = idx === 0
        const isLast = idx === steps.length - 1
        const isCurrent = step.stepNum === currentStepNum
        const isSelected = step.stepNum === selectedStep

        return (
          <div key={step.stepNum} className="flex items-center">
            {/* Connector line before */}
            {!isFirst && (
              <div
                className={cn(
                  'h-0.5 transition-all duration-300',
                  compact ? 'w-2' : 'w-4'
                )}
                style={{
                  backgroundColor:
                    step.status === 'pending' ? 'var(--border-subtle)' : getStepColor(steps[idx - 1].status),
                }}
              />
            )}

            {/* Step dot/circle */}
            <button
              onClick={() => onStepClick?.(step)}
              className={cn(
                'relative rounded-full transition-all duration-200',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                'focus-visible:ring-[var(--running)] focus-visible:ring-offset-[var(--bg-surface)]',
                compact ? 'w-2 h-2' : 'w-3 h-3',
                isCurrent && 'animate-pulse-glow',
                isSelected && 'ring-2 ring-[var(--accent-cyan)] ring-offset-2 ring-offset-[var(--bg-surface)]',
                getStepBgClass(step.status)
              )}
              title={`Step ${step.stepNum}: ${step.objective}`}
              aria-label={`Step ${step.stepNum}: ${step.objective} - ${step.status}`}
            >
              {/* Inner dot for current step */}
              {isCurrent && !compact && (
                <span className="absolute inset-0.5 rounded-full bg-[var(--bg-surface)]" />
              )}
            </button>

            {/* Connector line after (except last) */}
            {!isLast && (
              <div
                className={cn(
                  'h-0.5 transition-all duration-300',
                  compact ? 'w-2' : 'w-4'
                )}
                style={{
                  backgroundColor:
                    steps[idx + 1].status === 'pending' || steps[idx + 1].status === 'skipped'
                      ? 'var(--border-subtle)'
                      : getStepColor(step.status),
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// Vertical timeline variant for expanded view
export function VerticalTimeline({
  steps,
  onStepClick,
  selectedStep,
}: {
  steps: PlanStep[]
  onStepClick?: (step: PlanStep) => void
  selectedStep?: number
}) {
  if (steps.length === 0) return null

  return (
    <div className="space-y-0">
      {steps.map((step, idx) => {
        const isLast = idx === steps.length - 1
        const isSelected = step.stepNum === selectedStep

        return (
          <div key={step.stepNum} className="relative flex gap-3">
            {/* Vertical connector */}
            {!isLast && (
              <div
                className="absolute left-[11px] top-7 bottom-0 w-0.5"
                style={{
                  backgroundColor:
                    step.status === 'completed' ? 'var(--success-muted)' : 'var(--border-subtle)',
                }}
              />
            )}

            {/* Step marker */}
            <div className="relative z-10 pt-1">
              <button
                onClick={() => onStepClick?.(step)}
                className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center',
                  'border-2 transition-all duration-200',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  'focus-visible:ring-[var(--running)] focus-visible:ring-offset-[var(--bg-surface)]',
                  step.status === 'completed' &&
                    'bg-[var(--success-bg)] border-[var(--success)] text-[var(--success)]',
                  step.status === 'in_progress' &&
                    'bg-[var(--running-bg)] border-[var(--running)] text-[var(--running)] animate-pulse-glow',
                  step.status === 'failed' &&
                    'bg-[var(--error-bg)] border-[var(--error)] text-[var(--error)]',
                  step.status === 'pending' &&
                    'bg-[var(--bg-elevated)] border-[var(--border-default)] text-[var(--text-muted)]',
                  step.status === 'skipped' &&
                    'bg-[var(--bg-elevated)] border-[var(--border-subtle)] text-[var(--text-muted)] opacity-50',
                  isSelected && 'ring-2 ring-[var(--accent-cyan)]'
                )}
              >
                {step.status === 'completed' && (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {step.status === 'in_progress' && (
                  <span className="w-2 h-2 rounded-full bg-current" />
                )}
                {step.status === 'failed' && (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
                {(step.status === 'pending' || step.status === 'skipped') && (
                  <span className="font-mono text-[10px] font-medium">{step.stepNum}</span>
                )}
              </button>
            </div>

            {/* Step content */}
            <div className={cn('flex-1 pb-4', isLast && 'pb-0')}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p
                    className={cn(
                      'text-sm font-medium',
                      step.status === 'pending' || step.status === 'skipped'
                        ? 'text-[var(--text-muted)]'
                        : 'text-[var(--text-primary)]'
                    )}
                  >
                    {step.objective}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={cn(
                        'text-xs font-mono px-1.5 py-0.5 rounded',
                        step.phase === 'discovery'
                          ? 'bg-[var(--accent-violet)]/10 text-[var(--accent-violet)]'
                          : 'bg-[var(--accent-cyan)]/10 text-[var(--accent-cyan)]'
                      )}
                    >
                      {step.phase}
                    </span>
                    {step.toolHint && (
                      <span className="text-xs font-mono text-[var(--text-muted)]">
                        → {step.toolHint}
                      </span>
                    )}
                  </div>
                </div>
                {step.durationMs && (
                  <span className="text-xs font-mono text-[var(--text-muted)] tabular-nums whitespace-nowrap">
                    {step.durationMs < 1000
                      ? `${step.durationMs}ms`
                      : `${(step.durationMs / 1000).toFixed(1)}s`}
                  </span>
                )}
              </div>
              {step.error && (
                <p className="mt-2 text-xs text-[var(--error)] bg-[var(--error-bg)] rounded px-2 py-1 font-mono">
                  {step.error}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
