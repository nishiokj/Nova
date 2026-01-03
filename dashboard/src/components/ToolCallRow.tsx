import { useState } from 'react'
import type { ToolCall } from '../domain/models'
import { cn } from '../lib/utils'
import { StatusDot } from './StatusBadge'

// Tool icons for common tools
function ToolIcon({ tool }: { tool: string }) {
  const iconClass = 'w-3.5 h-3.5'

  switch (tool) {
    case 'file_read':
    case 'Read':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      )
    case 'file_write':
    case 'Write':
    case 'Edit':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
        </svg>
      )
    case 'grep':
    case 'Grep':
    case 'Glob':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
      )
    case 'bash':
    case 'Bash':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
        </svg>
      )
    default:
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
        </svg>
      )
  }
}

function formatArgs(args: Record<string, unknown>): string {
  // Smart arg formatting - show most relevant info
  if ('path' in args) return String(args.path)
  if ('command' in args) return String(args.command).slice(0, 60)
  if ('pattern' in args) return `/${args.pattern}/`
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  return `${keys[0]}: ${String(args[keys[0]]).slice(0, 40)}`
}

interface ToolCallRowProps {
  call: ToolCall
  expanded?: boolean
}

export function ToolCallRow({ call, expanded: defaultExpanded = false }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  const formattedDuration =
    call.durationMs < 1000 ? `${call.durationMs}ms` : `${(call.durationMs / 1000).toFixed(1)}s`

  return (
    <div
      className={cn(
        'group rounded border transition-all',
        call.success
          ? 'border-[var(--border-subtle)] hover:border-[var(--border-default)]'
          : 'border-[var(--error-muted)] bg-[var(--error-bg)]'
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'w-full flex items-center gap-2 px-2.5 py-1.5 text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--running)]'
        )}
      >
        <StatusDot status={call.success ? 'success' : 'error'} />

        <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
          <ToolIcon tool={call.toolName} />
          <span className="font-mono text-xs font-medium">{call.toolName}</span>
        </span>

        <span className="flex-1 font-mono text-xs text-[var(--text-muted)] truncate">
          {formatArgs(call.arguments)}
        </span>

        {call.result && !expanded && (
          <span className="font-mono text-xs text-[var(--text-muted)] truncate max-w-32">
            → {call.result.slice(0, 30)}
          </span>
        )}

        <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums whitespace-nowrap">
          {formattedDuration}
        </span>

        <svg
          className={cn(
            'w-3.5 h-3.5 text-[var(--text-muted)] transition-transform',
            expanded && 'rotate-180'
          )}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-2.5 pb-2.5 pt-0 space-y-2 animate-fade-in">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Arguments</span>
              <pre className="mt-1 p-2 rounded bg-[var(--bg-base)] text-xs font-mono text-[var(--text-secondary)] overflow-x-auto max-h-32">
                {JSON.stringify(call.arguments, null, 2)}
              </pre>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Result</span>
              <pre
                className={cn(
                  'mt-1 p-2 rounded text-xs font-mono overflow-x-auto max-h-32',
                  call.success
                    ? 'bg-[var(--bg-base)] text-[var(--text-secondary)]'
                    : 'bg-[var(--error-bg)] text-[var(--error)]'
                )}
              >
                {call.result || '(no output)'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Compact list of tool calls
export function ToolCallList({ calls, maxVisible = 3 }: { calls: ToolCall[]; maxVisible?: number }) {
  const [showAll, setShowAll] = useState(false)
  const visibleCalls = showAll ? calls : calls.slice(0, maxVisible)
  const hiddenCount = calls.length - maxVisible

  return (
    <div className="space-y-1">
      {visibleCalls.map((call) => (
        <ToolCallRow key={call.id} call={call} />
      ))}
      {!showAll && hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full text-center py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          + {hiddenCount} more tool call{hiddenCount > 1 ? 's' : ''}
        </button>
      )}
    </div>
  )
}
