import { useState, useMemo, memo } from 'react'
import type { AgentRequest, AgentRequestState, WorkItem } from '../domain/models'
import { cn } from '../lib/utils'
import { StatusBadge, StatusDot } from './StatusBadge'
import type { StatusTone } from './StatusBadge'
import { SimpleProgress } from './ProgressBar'
import { QualityBar } from './QualityIndicator'
import { VerticalTimeline } from './ExecutionTimeline'
import { MemoryInjectionList } from './MemoryInjectionPanel'
import { ReflectionPanel } from './ReflectionPanel'
import { formatDuration } from '../lib/time'
import { ContextWindowWidget } from './ContextWindowWidget'
import { UserPromptDisplay } from './UserPromptDisplay'
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

// Get the current/active work item for running requests
function getCurrentWorkItem(items: WorkItem[]): WorkItem | undefined {
  return items.find(w => w.status === 'in_progress')
}

// Get the failed work item for error requests
function getFailedWorkItem(items: WorkItem[]): WorkItem | undefined {
  return items.find(w => w.status === 'failed')
}

interface RequestRowProps {
  request: AgentRequest
  defaultExpanded?: boolean
}

export const RequestRow = memo(function RequestRow({ request, defaultExpanded = false }: RequestRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const tone = getRequestTone(request.state)

  const hasWorkItems = request.plan && request.plan.workItems.length > 0
  const duration = request.durationMs
    ? formatDuration(request.durationMs)
    : request.startedAt
      ? formatDuration(Date.now() - new Date(request.startedAt).getTime())
      : null

  // Compute useful summary info
  const filesTouched = useMemo(() => extractFilesTouched(request), [request.toolCalls])
  const currentWorkItem = hasWorkItems ? getCurrentWorkItem(request.plan!.workItems) : undefined
  const failedWorkItem = hasWorkItems ? getFailedWorkItem(request.plan!.workItems) : undefined

  // Build status line for collapsed view
  const statusLine = useMemo(() => {
    if (request.state === 'running' && currentWorkItem) {
      return currentWorkItem.objective
    }
    if (request.state === 'error') {
      if (failedWorkItem?.error) return failedWorkItem.error
      if (request.errorMessage) return request.errorMessage
      return 'Request failed - no error details available'
    }
    if (request.state === 'success' && request.reflection?.reasoning) {
      return request.reflection.reasoning.slice(0, 120)
    }
    return null
  }, [request, currentWorkItem, failedWorkItem])

  // Check if we have any telemetry data
  const hasTelemetry = hasWorkItems
    || request.toolCalls.length > 0
    || request.reflection
    || request.llmCalls.length > 0
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
          'w-full text-left px-2.5 py-2',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--running)]',
          'hover:bg-[var(--bg-hover)] transition-colors'
        )}
      >
        {/* Top row: status, prompt, metrics */}
        <div className="flex items-start gap-2.5">
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
          <div className="flex-1 min-w-0 space-y-1">
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
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                {/* Progress */}
                {hasWorkItems && (
                  <div className="flex items-center gap-1.5">
                    <SimpleProgress
                      completed={request.workItemsCompleted}
                      total={request.workItemsTotal}
                      hasError={request.state === 'error'}
                    />
                    <span className="text-xs text-[var(--text-muted)]">
                      {request.workItemsCompleted}/{request.workItemsTotal} work items
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
        <div className="px-2.5 pb-2 pt-1.5 space-y-1.5 animate-fade-in border-t border-[var(--border-subtle)]">
          {/* Files touched summary */}
          {filesTouched.length > 0 && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Files Touched ({filesTouched.length})
              </span>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {filesTouched.slice(0, 10).map((path) => (
                  <span
                    key={path}
                    className="px-1.5 py-0 text-[11px] font-mono bg-[var(--bg-elevated)] rounded border border-[var(--border-subtle)] text-[var(--text-secondary)]"
                    title={path}
                  >
                    {path.split('/').pop()}
                  </span>
                ))}
                {filesTouched.length > 10 && (
                  <span className="px-1.5 py-0 text-[11px] text-[var(--text-muted)]">
                    +{filesTouched.length - 10} more
                  </span>
                )}
              </div>
            </div>
          )}

          {request.userPrompts.length > 0 && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                User Input Requests ({request.userPrompts.length})
              </span>
              <div className="mt-0.5 space-y-1">
                {request.userPrompts.map((prompt) => (
                  <UserPromptDisplay key={prompt.requestId} prompt={prompt} />
                ))}
              </div>
            </div>
          )}

          {/* Execution plan */}
          {hasWorkItems && (
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Work Items ({request.plan!.workItems.length})
                </span>
                {request.plan?.systemContext && (
                  <span className="text-[11px] text-[var(--text-muted)] font-mono">
                    {request.plan.systemContext.languages.join(', ')}
                  </span>
                )}
              </div>
              <div className="bg-[var(--bg-elevated)] rounded-md p-1.5 border border-[var(--border-subtle)]">
                <VerticalTimeline workItems={request.plan!.workItems} />
              </div>
            </div>
          )}

          {/* Trace - interleaved LLM and tool calls */}
          {(request.llmCalls.length > 0 || request.toolCalls.length > 0) && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Trace
              </span>
              <div className="mt-0.5 bg-[var(--bg-elevated)] rounded-md p-1.5 border border-[var(--border-subtle)]">
                <ExecutionFlow llmCalls={request.llmCalls} toolCalls={request.toolCalls} />
              </div>
            </div>
          )}

          {request.memoryInjections.length > 0 && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Memory Injection ({request.memoryInjections.length})
              </span>
              <div className="mt-0.5 bg-[var(--bg-elevated)] rounded-md p-1.5 border border-[var(--border-subtle)]">
                <MemoryInjectionList injections={request.memoryInjections} />
              </div>
            </div>
          )}

          {/* Reflection */}
          {request.reflection && (
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Reflection
              </span>
              <div className="mt-0.5">
                <ReflectionPanel reflection={request.reflection} />
              </div>
            </div>
          )}

          {/* No data warning */}
          {!hasTelemetry && (
            <div className="text-center py-2">
              <p className="text-xs text-[var(--text-muted)]">
                No execution telemetry available
              </p>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                Wizard events were not recorded for this request
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
