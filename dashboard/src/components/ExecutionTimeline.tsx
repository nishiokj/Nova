import { useState } from 'react'
import type { PlanStep, StepStatus } from '../domain/models'
import { cn } from '../lib/utils'
import { ToolCallList } from './ToolCallRow'
import { LLMCallList } from './LLMCallList'

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

// Vertical timeline variant for expanded view with nested calls
export function VerticalTimeline({
  steps,
  onStepClick,
  selectedStep,
}: {
  steps: PlanStep[]
  onStepClick?: (step: PlanStep) => void
  selectedStep?: number
}) {
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set())

  if (steps.length === 0) return null

  const toggleStep = (stepNum: number) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(stepNum)) {
        next.delete(stepNum)
      } else {
        next.add(stepNum)
      }
      return next
    })
  }

  return (
    <div className="space-y-0">
      {steps.map((step, idx) => {
        const isLast = idx === steps.length - 1
        const isSelected = step.stepNum === selectedStep
        const isExpanded = expandedSteps.has(step.stepNum)
        const toolCallCount = step.toolCalls?.length ?? 0
        const llmCallCount = step.llmCalls?.length ?? 0
        const hasNestedCalls = toolCallCount > 0 || llmCallCount > 0

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
                  step.status === 'skipped' && step.error &&
                    'bg-[var(--warning-bg)] border-[var(--warning)] text-[var(--warning)]',
                  step.status === 'skipped' && !step.error &&
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
                {step.status === 'skipped' && step.error && (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                )}
                {step.status === 'skipped' && !step.error && (
                  <span className="font-mono text-[10px] font-medium">{step.stepNum}</span>
                )}
                {step.status === 'pending' && (
                  <span className="font-mono text-[10px] font-medium">{step.stepNum}</span>
                )}
              </button>
            </div>

            {/* Step content */}
            <div className={cn('flex-1 pb-4', isLast && 'pb-0')}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
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
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
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
                    {/* Call counts badge - clickable to expand */}
                    {hasNestedCalls && (
                      <button
                        onClick={() => toggleStep(step.stepNum)}
                        className={cn(
                          'flex items-center gap-1 text-xs px-1.5 py-0.5 rounded',
                          'bg-[var(--bg-surface)] border border-[var(--border-subtle)]',
                          'hover:bg-[var(--bg-hover)] transition-colors',
                          isExpanded && 'bg-[var(--bg-hover)] border-[var(--border-default)]'
                        )}
                      >
                        {toolCallCount > 0 && (
                          <span className="font-mono text-[var(--text-muted)]">
                            {toolCallCount} tool{toolCallCount !== 1 ? 's' : ''}
                          </span>
                        )}
                        {toolCallCount > 0 && llmCallCount > 0 && (
                          <span className="text-[var(--border-default)]">·</span>
                        )}
                        {llmCallCount > 0 && (
                          <span className="font-mono text-[var(--text-muted)]">
                            {llmCallCount} LLM
                          </span>
                        )}
                        <svg
                          className={cn(
                            'w-3 h-3 text-[var(--text-muted)] transition-transform',
                            isExpanded && 'rotate-180'
                          )}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
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

              {/* Error message */}
              {step.error && (
                <p className="mt-2 text-xs text-[var(--error)] bg-[var(--error-bg)] rounded px-2 py-1 font-mono">
                  {step.error}
                </p>
              )}

              {/* Expanded nested calls */}
              {isExpanded && hasNestedCalls && (
                <div className="mt-3 space-y-3 animate-fade-in">
                  {toolCallCount > 0 && (
                    <div>
                      <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                        Tool Calls
                      </span>
                      <div className="mt-1">
                        <ToolCallList calls={step.toolCalls!} maxVisible={10} />
                      </div>
                    </div>
                  )}
                  {llmCallCount > 0 && (
                    <div>
                      <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                        LLM Calls
                      </span>
                      <div className="mt-1">
                        <LLMCallList calls={step.llmCalls!} maxVisible={5} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
