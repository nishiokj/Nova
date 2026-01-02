import { useState, useMemo } from 'react'
import type { AgentTask, TaskState, PlanStep } from '../domain/models'
import { cn } from '../lib/utils'
import { StatusBadge, StatusDot } from './StatusBadge'
import type { StatusTone } from './StatusBadge'
import { SimpleProgress } from './ProgressBar'
import { QualityBar } from './QualityIndicator'
import { VerticalTimeline } from './ExecutionTimeline'
import { ToolCallList } from './ToolCallRow'
import { ReflectionPanel } from './ReflectionPanel'
import { formatDuration } from '../lib/time'

function getTaskTone(state: TaskState): StatusTone {
  switch (state) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'running':
      return 'active'
    case 'queued':
    case 'cancelled':
    default:
      return 'neutral'
  }
}

function getTaskStatusLabel(state: TaskState): string {
  switch (state) {
    case 'success':
      return 'DONE'
    case 'error':
      return 'FAILED'
    case 'running':
      return 'RUNNING'
    case 'queued':
      return 'QUEUED'
    case 'cancelled':
      return 'CANCELLED'
  }
}

// Extract unique file paths from tool calls
function extractFilesTouched(task: AgentTask): string[] {
  const files = new Set<string>()
  for (const call of task.toolCalls) {
    const args = call.arguments as Record<string, unknown>
    // Common arg names for file paths
    for (const key of ['path', 'file_path', 'file', 'target']) {
      if (typeof args[key] === 'string') {
        files.add(args[key] as string)
      }
    }
  }
  return Array.from(files)
}

// Get the current/active step for running tasks
function getCurrentStep(steps: PlanStep[]): PlanStep | undefined {
  return steps.find(s => s.status === 'in_progress')
}

// Get the failed step for error tasks
function getFailedStep(steps: PlanStep[]): PlanStep | undefined {
  return steps.find(s => s.status === 'failed')
}

interface TaskRowProps {
  task: AgentTask
  defaultExpanded?: boolean
}

export function TaskRow({ task, defaultExpanded = false }: TaskRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const tone = getTaskTone(task.state)

  const hasSteps = task.plan && task.plan.steps.length > 0
  const duration = task.durationMs
    ? formatDuration(task.durationMs)
    : task.startedAt
      ? formatDuration(Date.now() - new Date(task.startedAt).getTime())
      : null

  // Compute useful summary info
  const filesTouched = useMemo(() => extractFilesTouched(task), [task.toolCalls])
  const currentStep = hasSteps ? getCurrentStep(task.plan!.steps) : undefined
  const failedStep = hasSteps ? getFailedStep(task.plan!.steps) : undefined

  // Build status line for collapsed view
  const statusLine = useMemo(() => {
    if (task.state === 'running' && currentStep) {
      return `Step ${currentStep.stepNum}: ${currentStep.objective}`
    }
    if (task.state === 'error') {
      if (failedStep?.error) return failedStep.error
      if (task.errorMessage) return task.errorMessage
      return 'Task failed - no error details available'
    }
    if (task.state === 'success' && task.reflection?.reasoning) {
      return task.reflection.reasoning.slice(0, 120)
    }
    return null
  }, [task, currentStep, failedStep])

  // Check if we have any telemetry data
  const hasTelemetry = hasSteps || task.toolCalls.length > 0 || task.reflection

  return (
    <div
      className={cn(
        'rounded-lg border transition-all duration-200',
        'bg-[var(--bg-surface)]',
        task.state === 'error'
          ? 'border-[var(--error-muted)]'
          : task.state === 'running'
            ? 'border-[var(--running-muted)]'
            : 'border-[var(--border-subtle)]',
        expanded && 'ring-1 ring-[var(--border-default)]'
      )}
    >
      {/* Main row header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'w-full text-left px-3 py-2.5',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--running)]',
          'hover:bg-[var(--bg-hover)] transition-colors'
        )}
      >
        {/* Top row: status, prompt, metrics */}
        <div className="flex items-start gap-3">
          <StatusDot
            status={
              task.state === 'success'
                ? 'success'
                : task.state === 'error'
                  ? 'error'
                  : task.state === 'running'
                    ? 'running'
                    : 'pending'
            }
            pulse={task.state === 'running'}
            className="mt-1 flex-shrink-0"
          />

          {/* Task content */}
          <div className="flex-1 min-w-0 space-y-1.5">
            {/* Prompt */}
            <p className="text-sm font-medium text-[var(--text-primary)] break-words">
              {task.userInput}
            </p>

            {/* Status line - shows current step, error, or summary */}
            {statusLine && (
              <p
                className={cn(
                  'text-xs font-mono',
                  task.state === 'error'
                    ? 'text-[var(--error)]'
                    : task.state === 'running'
                      ? 'text-[var(--running)]'
                      : 'text-[var(--text-muted)]'
                )}
              >
                {statusLine}
              </p>
            )}

            {/* Collapsed summary row */}
            {!expanded && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                {/* Progress */}
                {hasSteps && (
                  <div className="flex items-center gap-1.5">
                    <SimpleProgress
                      completed={task.stepsCompleted}
                      total={task.stepsTotal}
                      hasError={task.state === 'error'}
                    />
                    <span className="text-xs text-[var(--text-muted)]">
                      {task.stepsCompleted}/{task.stepsTotal} steps
                    </span>
                  </div>
                )}

                {/* Files touched */}
                {filesTouched.length > 0 && (
                  <span className="text-xs text-[var(--text-muted)] font-mono">
                    {filesTouched.length === 1
                      ? filesTouched[0].split('/').pop()
                      : `${filesTouched.length} files`}
                  </span>
                )}

                {/* Duration */}
                {duration && (
                  <span className="text-xs text-[var(--text-muted)] font-mono tabular-nums">
                    {duration}
                  </span>
                )}

                {/* Tool calls */}
                {task.totalToolCalls > 0 && (
                  <span className="text-xs text-[var(--text-muted)] tabular-nums">
                    {task.totalToolCalls} calls
                  </span>
                )}

                {/* Quality */}
                {task.reflection && (
                  <QualityBar score={task.reflection.qualityScore} width={40} />
                )}

                {/* No telemetry warning */}
                {!hasTelemetry && (
                  <span className="text-xs text-[var(--warning)] italic">
                    No execution data available
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right side: status badge and chevron */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <StatusBadge tone={tone} pulse={task.state === 'running'}>
              {getTaskStatusLabel(task.state)}
            </StatusBadge>

            <svg
              className={cn(
                'w-4 h-4 text-[var(--text-muted)] transition-transform duration-200',
                expanded && 'rotate-180'
              )}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 pt-0 space-y-4 animate-fade-in border-t border-[var(--border-subtle)]">
          {/* Files touched summary */}
          {filesTouched.length > 0 && (
            <div className="pt-3">
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Files Touched ({filesTouched.length})
              </span>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {filesTouched.slice(0, 10).map((path) => (
                  <span
                    key={path}
                    className="px-2 py-0.5 text-xs font-mono bg-[var(--bg-elevated)] rounded border border-[var(--border-subtle)] text-[var(--text-secondary)]"
                    title={path}
                  >
                    {path.split('/').pop()}
                  </span>
                ))}
                {filesTouched.length > 10 && (
                  <span className="px-2 py-0.5 text-xs text-[var(--text-muted)]">
                    +{filesTouched.length - 10} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Execution plan */}
          {hasSteps && (
            <div className="pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Execution Plan
                </span>
                <span className="text-xs text-[var(--text-muted)]">{task.plan!.goal}</span>
              </div>
              <div className="bg-[var(--bg-elevated)] rounded-lg p-3 border border-[var(--border-subtle)]">
                <VerticalTimeline steps={task.plan!.steps} />
              </div>
            </div>
          )}

          {/* Tool calls */}
          {task.toolCalls.length > 0 && (
            <div>
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Tool Calls ({task.toolCalls.length})
              </span>
              <div className="mt-2">
                <ToolCallList calls={task.toolCalls} maxVisible={5} />
              </div>
            </div>
          )}

          {/* Reflection */}
          {task.reflection && (
            <div>
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Reflection
              </span>
              <div className="mt-2">
                <ReflectionPanel reflection={task.reflection} />
              </div>
            </div>
          )}

          {/* No data warning */}
          {!hasTelemetry && (
            <div className="pt-3 text-center py-6">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[var(--bg-elevated)] mb-2">
                <svg
                  className="w-5 h-5 text-[var(--warning)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                  />
                </svg>
              </div>
              <p className="text-sm text-[var(--text-muted)]">
                No execution telemetry available
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Wizard events were not recorded for this task
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
