import { useState } from 'react'
import type { WorkItem, WorkItemStatus, AgentType } from '../domain/models'
import { cn } from '../lib/utils'
import { ExecutionFlow } from './ExecutionFlow'

function getStatusColor(status: WorkItemStatus): string {
  switch (status) {
    case 'completed':
      return 'var(--success)'
    case 'in_progress':
      return 'var(--running)'
    case 'failed':
      return 'var(--error)'
    case 'skipped':
    case 'awaiting_user':
      return 'var(--pending)'
    case 'pending':
    default:
      return 'var(--border-default)'
  }
}

function getStatusBgClass(status: WorkItemStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-[var(--success)]'
    case 'in_progress':
      return 'bg-[var(--running)]'
    case 'failed':
      return 'bg-[var(--error)]'
    case 'awaiting_user':
      return 'bg-[var(--warning)]'
    case 'skipped':
      return 'bg-[var(--pending)] opacity-50'
    case 'pending':
    default:
      return 'bg-[var(--border-default)]'
  }
}

const AGENT_BADGE_COLORS: Record<AgentType, string> = {
  routing: 'var(--text-muted)',
  explorer: 'var(--accent-cyan)',
  runtime_script: 'var(--accent-violet)',
  standard: 'var(--success)',
  linter: '#eab308',
  tester: '#06b6d4',
  context_compactor: '#f97316',
  debugger: '#ef4444',
  web_crawler: '#6366f1',
  orchestrator: 'var(--text-muted)',
}

interface ExecutionTimelineProps {
  workItems: WorkItem[]
  onWorkItemClick?: (item: WorkItem) => void
  selectedWorkId?: string
  compact?: boolean
}

export function ExecutionTimeline({
  workItems,
  onWorkItemClick,
  selectedWorkId,
  compact = false,
}: ExecutionTimelineProps) {
  if (workItems.length === 0) return null

  // Find current work item (first in_progress)
  const currentWorkId = workItems.find((w) => w.status === 'in_progress')?.workId

  return (
    <div className={cn('flex items-center gap-1', compact ? 'gap-0.5' : 'gap-1')}>
      {workItems.map((item, idx) => {
        const isFirst = idx === 0
        const isLast = idx === workItems.length - 1
        const isCurrent = item.workId === currentWorkId
        const isSelected = item.workId === selectedWorkId

        return (
          <div key={item.workId} className="flex items-center">
            {/* Connector line before */}
            {!isFirst && (
              <div
                className={cn(
                  'h-0.5 transition-all duration-300',
                  compact ? 'w-2' : 'w-4'
                )}
                style={{
                  backgroundColor:
                    item.status === 'pending' ? 'var(--border-subtle)' : getStatusColor(workItems[idx - 1].status),
                }}
              />
            )}

            {/* Work item dot/circle */}
            <button
              onClick={() => onWorkItemClick?.(item)}
              className={cn(
                'relative rounded-full transition-all duration-200',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                'focus-visible:ring-[var(--running)] focus-visible:ring-offset-[var(--bg-surface)]',
                compact ? 'w-2 h-2' : 'w-3 h-3',
                isCurrent && 'animate-pulse-glow',
                isSelected && 'ring-2 ring-[var(--accent-cyan)] ring-offset-2 ring-offset-[var(--bg-surface)]',
                getStatusBgClass(item.status)
              )}
              title={`${item.workId}: ${item.objective}`}
              aria-label={`${item.workId}: ${item.objective} - ${item.status}`}
            >
              {/* Inner dot for current item */}
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
                    workItems[idx + 1].status === 'pending' || workItems[idx + 1].status === 'skipped'
                      ? 'var(--border-subtle)'
                      : getStatusColor(item.status),
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
  workItems,
  onWorkItemClick,
  selectedWorkId,
}: {
  workItems: WorkItem[]
  onWorkItemClick?: (item: WorkItem) => void
  selectedWorkId?: string
}) {
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())

  if (workItems.length === 0) return null

  const toggleItem = (workId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev)
      if (next.has(workId)) {
        next.delete(workId)
      } else {
        next.add(workId)
      }
      return next
    })
  }

  return (
    <div className="space-y-0">
      {workItems.map((item, idx) => {
        const isLast = idx === workItems.length - 1
        const isSelected = item.workId === selectedWorkId
        const isExpanded = expandedItems.has(item.workId)
        const toolCallCount = item.toolCalls?.length ?? 0
        const llmCallCount = item.llmCalls?.length ?? 0
        const hasNestedCalls = toolCallCount > 0 || llmCallCount > 0
        const agentColor = AGENT_BADGE_COLORS[item.agent] ?? 'var(--text-muted)'

        return (
          <div key={item.workId} className="relative flex gap-3">
            {/* Vertical connector */}
            {!isLast && (
              <div
                className="absolute left-[11px] top-7 bottom-0 w-0.5"
                style={{
                  backgroundColor:
                    item.status === 'completed' ? 'var(--success-muted)' : 'var(--border-subtle)',
                }}
              />
            )}

            {/* Work item marker */}
            <div className="relative z-10 pt-1">
              <button
                onClick={() => onWorkItemClick?.(item)}
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center',
                  'border-2 transition-all duration-200',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  'focus-visible:ring-[var(--running)] focus-visible:ring-offset-[var(--bg-surface)]',
                  item.status === 'completed' &&
                    'bg-[var(--success-bg)] border-[var(--success)] text-[var(--success)]',
                  item.status === 'in_progress' &&
                    'bg-[var(--running-bg)] border-[var(--running)] text-[var(--running)] animate-pulse-glow',
                  item.status === 'failed' &&
                    'bg-[var(--error-bg)] border-[var(--error)] text-[var(--error)]',
                  item.status === 'pending' &&
                    'bg-[var(--bg-elevated)] border-[var(--border-default)] text-[var(--text-muted)]',
                  item.status === 'awaiting_user' &&
                    'bg-[var(--warning-bg)] border-[var(--warning)] text-[var(--warning)]',
                  item.status === 'skipped' && item.error &&
                    'bg-[var(--warning-bg)] border-[var(--warning)] text-[var(--warning)]',
                  item.status === 'skipped' && !item.error &&
                    'bg-[var(--bg-elevated)] border-[var(--border-subtle)] text-[var(--text-muted)] opacity-50',
                  isSelected && 'ring-2 ring-[var(--accent-cyan)]'
                )}
                title={`${item.workId}${item.dependencies.length ? ` (after: ${item.dependencies.join(', ')})` : ''}`}
              >
                <span className="font-mono text-[11px] font-bold">{idx + 1}</span>
              </button>
            </div>

            {/* Work item content */}
            <div className={cn('flex-1 pb-4', isLast && 'pb-0')}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      item.status === 'pending' || item.status === 'skipped'
                        ? 'text-[var(--text-muted)]'
                        : 'text-[var(--text-primary)]'
                    )}
                  >
                    {item.objective}
                  </p>
                  {item.delta && (
                    <p className="text-xs text-[var(--text-muted)] mt-0.5 italic">
                      {item.delta}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {/* Agent type badge */}
                    <span
                      className="text-xs font-mono px-1.5 py-0.5 rounded uppercase"
                      style={{ backgroundColor: `${agentColor}20`, color: agentColor }}
                    >
                      {item.agent}
                    </span>
                    {/* Dependencies badge */}
                    {item.dependencies.length > 0 && (
                      <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-muted)]">
                        after {item.dependencies.join(', ')}
                      </span>
                    )}
                    {item.toolHint && (
                      <span className="text-xs font-mono text-[var(--text-muted)]">
                        → {item.toolHint}
                      </span>
                    )}
                    {/* Call counts badge - clickable to expand */}
                    {hasNestedCalls && (
                      <button
                        onClick={() => toggleItem(item.workId)}
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
                {item.durationMs && (
                  <span className="text-xs font-mono text-[var(--text-muted)] tabular-nums whitespace-nowrap">
                    {item.durationMs < 1000
                      ? `${item.durationMs}ms`
                      : `${(item.durationMs / 1000).toFixed(1)}s`}
                  </span>
                )}
              </div>

              {/* Error message */}
              {item.error && (
                <p className="mt-2 text-xs text-[var(--error)] bg-[var(--error-bg)] rounded px-2 py-1 font-mono">
                  {item.error}
                </p>
              )}

              {/* Expanded nested calls - chronological execution flow */}
              {isExpanded && hasNestedCalls && (
                <div className="mt-3 animate-fade-in">
                  <ExecutionFlow
                    llmCalls={item.llmCalls ?? []}
                    toolCalls={item.toolCalls ?? []}
                    maxVisible={15}
                  />
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
