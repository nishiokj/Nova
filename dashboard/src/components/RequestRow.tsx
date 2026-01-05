import { useState, useMemo } from 'react'
import type { AgentRequest, AgentRequestState, PlanStep } from '../domain/models'
import { cn } from '../lib/utils'
import { StatusBadge, StatusDot } from './StatusBadge'
import type { StatusTone } from './StatusBadge'
import { SimpleProgress } from './ProgressBar'
import { QualityBar } from './QualityIndicator'
import { VerticalTimeline } from './ExecutionTimeline'
import { ReflectionPanel } from './ReflectionPanel'
import { formatDuration } from '../lib/time'
import { ContextWindowWidget } from './ContextWindowWidget'
import { UserPromptDisplay } from './UserPromptDisplay'
import { PlanCarousel } from './PlanCarousel'
import { ExecutionFlow } from './ExecutionFlow'

function getRequestTone(state: AgentRequestState): StatusTone {
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

function getRequestStatusLabel(state: AgentRequestState): string {
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
function extractFilesTouched(request: AgentRequest): string[] {
  const files = new Set<string>()
  for (const call of request.toolCalls) {
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

// Get the current/active step for running requests
function getCurrentStep(steps: PlanStep[]): PlanStep | undefined {
  return steps.find(s => s.status === 'in_progress')
}

// Get the failed step for error requests
function getFailedStep(steps: PlanStep[]): PlanStep | undefined {
  return steps.find(s => s.status === 'failed')
}

interface RequestRowProps {
  request: AgentRequest
  defaultExpanded?: boolean
}

export function RequestRow({ request, defaultExpanded = false }: RequestRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const tone = getRequestTone(request.state)

  const hasSteps = request.plan && request.plan.steps.length > 0
  const duration = request.durationMs
    ? formatDuration(request.durationMs)
    : request.startedAt
      ? formatDuration(Date.now() - new Date(request.startedAt).getTime())
      : null

  // Compute useful summary info
  const filesTouched = useMemo(() => extractFilesTouched(request), [request.toolCalls])
  const currentStep = hasSteps ? getCurrentStep(request.plan!.steps) : undefined
  const failedStep = hasSteps ? getFailedStep(request.plan!.steps) : undefined

  // Build status line for collapsed view
  const statusLine = useMemo(() => {
    if (request.state === 'running' && currentStep) {
      return `Step ${currentStep.stepNum}: ${currentStep.objective}`
    }
    if (request.state === 'error') {
      if (failedStep?.error) return failedStep.error
      if (request.errorMessage) return request.errorMessage
      return 'Request failed - no error details available'
    }
    if (request.state === 'success' && request.reflection?.reasoning) {
      return request.reflection.reasoning.slice(0, 120)
    }
    return null
  }, [request, currentStep, failedStep])

  // Check if we have any telemetry data
  const hasTelemetry = hasSteps
    || request.toolCalls.length > 0
    || request.reflection
    || request.llmCalls.length > 0
    || request.planSnapshots.length > 0
    || request.userPrompts.length > 0
    || Boolean(request.contextWindow)

  return (
    <div
      className={cn(
        'rounded-lg border transition-all duration-200',
        'bg-[var(--bg-surface)]',
        request.state === 'error'
          ? 'border-[var(--error-muted)]'
          : request.state === 'running'
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
              request.state === 'success'
                ? 'success'
                : request.state === 'error'
                  ? 'error'
                  : request.state === 'running'
                    ? 'running'
                    : 'pending'
            }
            pulse={request.state === 'running'}
            className="mt-1 flex-shrink-0"
          />

          {/* Request content */}
          <div className="flex-1 min-w-0 space-y-1.5">
            {/* Prompt */}
            <p className="text-sm font-medium text-[var(--text-primary)] break-words">
              {request.userInput}
            </p>

            {/* Status line - shows current step, error, or summary */}
            {statusLine && (
              <p
                className={cn(
                  'text-xs font-mono',
                  request.state === 'error'
                    ? 'text-[var(--error)]'
                    : request.state === 'running'
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
                      completed={request.stepsCompleted}
                      total={request.stepsTotal}
                      hasError={request.state === 'error'}
                    />
                    <span className="text-xs text-[var(--text-muted)]">
                      {request.stepsCompleted}/{request.stepsTotal} steps
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
                {request.totalToolCalls > 0 && (
                  <span className="text-xs text-[var(--text-muted)] tabular-nums">
                    {request.totalToolCalls} calls
                  </span>
                )}

                {/* Quality */}
                {request.reflection && (
                  <QualityBar score={request.reflection.qualityScore} width={40} />
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
            <StatusBadge tone={tone} pulse={request.state === 'running'}>
              {getRequestStatusLabel(request.state)}
            </StatusBadge>
            {request.contextWindow && <ContextWindowWidget metrics={request.contextWindow} />}

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

          {request.userPrompts.length > 0 && (
            <div className="pt-3">
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                User Input Requests ({request.userPrompts.length})
              </span>
              <div className="mt-2 space-y-2">
                {request.userPrompts.map((prompt) => (
                  <UserPromptDisplay key={prompt.requestId} prompt={prompt} />
                ))}
              </div>
            </div>
          )}

          {/* Execution plan */}
          {(hasSteps || request.planSnapshots.length > 0) && (
            <div className="pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Execution Plan
                  {request.planSnapshots.length > 1 && ` (${request.planSnapshots.length} versions)`}
                </span>
              </div>
              {request.planSnapshots.length > 0 ? (
                <PlanCarousel snapshots={request.planSnapshots} />
              ) : hasSteps && (
                <div className="bg-[var(--bg-elevated)] rounded-lg p-3 border border-[var(--border-subtle)]">
                  <VerticalTimeline steps={request.plan!.steps} />
                </div>
              )}
            </div>
          )}

          {/* Execution Flow - interleaved LLM and tool calls */}
          {(request.llmCalls.length > 0 || request.toolCalls.length > 0) && (
            <div className="pt-3">
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Execution Flow
              </span>
              <div className="mt-2 bg-[var(--bg-elevated)] rounded-lg p-3 border border-[var(--border-subtle)]">
                <ExecutionFlow llmCalls={request.llmCalls} toolCalls={request.toolCalls} />
              </div>
            </div>
          )}

          {/* Reflection */}
          {request.reflection && (
            <div>
              <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Reflection
              </span>
              <div className="mt-2">
                <ReflectionPanel reflection={request.reflection} />
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
                Wizard events were not recorded for this request
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
