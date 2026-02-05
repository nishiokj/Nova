import { useState, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { LLMCall, ToolCall, AgentType } from '../domain/models'
import { cn } from '../lib/utils'
import { formatDuration } from '../lib/time'
import { StatusDot } from './StatusBadge'

// Unified execution event - either an LLM call or a tool call
type ExecutionEvent =
  | { type: 'llm'; data: LLMCall; timestamp: number }
  | { type: 'tool'; data: ToolCall; timestamp: number }

// Merge LLM calls and tool calls into a chronological stream
function mergeExecutionEvents(llmCalls: LLMCall[], toolCalls: ToolCall[]): ExecutionEvent[] {
  const events: ExecutionEvent[] = [
    ...llmCalls.map(c => ({
      type: 'llm' as const,
      data: c,
      timestamp: new Date(c.timestamp).getTime(),
    })),
    ...toolCalls.map(c => ({
      type: 'tool' as const,
      data: c,
      timestamp: new Date(c.timestamp).getTime(),
    })),
  ]
  return events.sort((a, b) => a.timestamp - b.timestamp)
}

// ============================================
// LLM Event Row
// ============================================

const AGENT_COLORS: Record<AgentType, string> = {
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

function LLMEventRow({ call, toolCount }: { call: LLMCall; toolCount: number }) {
  const [expanded, setExpanded] = useState(false)
  const color = AGENT_COLORS[call.agentType] ?? 'var(--text-muted)'

  return (
    <div className="relative">
      {/* Timeline connector line */}
      <div className="absolute left-[11px] top-6 bottom-0 w-px bg-[var(--border-subtle)]" />

      <div className="border border-[var(--border-subtle)] rounded-lg overflow-hidden bg-[var(--bg-surface)]">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors"
        >
          <div className="flex items-center gap-2">
            {/* LLM indicator */}
            <div
              className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: `${color}20`, border: `2px solid ${color}` }}
            >
              <svg className="w-3 h-3" style={{ color }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
            </div>

            <div className="flex-1 min-w-0 flex items-center gap-2">
              <span
                className="px-1.5 py-0.5 rounded text-xs font-mono uppercase font-medium"
                style={{ backgroundColor: `${color}20`, color }}
              >
                {call.agentType}
              </span>
              {call.workItemId && (
                <span className="text-xs text-[var(--text-muted)] font-mono truncate max-w-24">{call.workItemId}</span>
              )}
              <span className="text-xs text-[var(--text-secondary)] font-mono truncate">{call.model}</span>
            </div>

            <div className="flex items-center gap-3 text-xs text-[var(--text-muted)] flex-shrink-0">
              <span className="tabular-nums">{call.totalTokens.toLocaleString()} tok</span>
              {toolCount > 0 && (
                <span className="tabular-nums text-[var(--accent-cyan)]">→ {toolCount} tools</span>
              )}
              <span className="tabular-nums">{formatDuration(call.durationMs)}</span>
              <svg
                className={cn('w-4 h-4 transition-transform', expanded && 'rotate-180')}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </button>

        {expanded && (
          <div className="border-t border-[var(--border-subtle)] px-3 py-3 space-y-3 bg-[var(--bg-elevated)]">
            <div>
              <span className="text-xs font-medium uppercase text-[var(--text-muted)]">Prompt Preview</span>
              <pre className="mt-1 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto bg-[var(--bg-surface)] p-2 rounded">
                {call.promptPreview || '(empty)'}
              </pre>
            </div>
            <div>
              <span className="text-xs font-medium uppercase text-[var(--text-muted)]">Response Preview</span>
              <pre className="mt-1 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto bg-[var(--bg-surface)] p-2 rounded">
                {call.responsePreview || '(empty)'}
              </pre>
            </div>
            <div className="flex gap-4 text-xs text-[var(--text-muted)]">
              <span>Prompt: {call.promptTokens.toLocaleString()} tok</span>
              <span>Completion: {call.completionTokens.toLocaleString()} tok</span>
              {call.toolCallsCount > 0 && <span>Tool calls: {call.toolCallsCount}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================
// Tool Event Row
// ============================================

function ToolIcon({ tool }: { tool: string }) {
  const iconClass = 'w-3 h-3'

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
  if ('path' in args) return String(args.path)
  if ('file_path' in args) return String(args.file_path)
  if ('command' in args) return String(args.command).slice(0, 60)
  if ('pattern' in args) return `/${args.pattern}/`
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  return `${keys[0]}: ${String(args[keys[0]]).slice(0, 40)}`
}

function ToolEventRow({ call, isLast }: { call: ToolCall; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false)

  const formattedDuration =
    call.durationMs < 1000 ? `${call.durationMs}ms` : `${(call.durationMs / 1000).toFixed(1)}s`

  return (
    <div className="relative pl-6">
      {/* Timeline connector */}
      {!isLast && (
        <div className="absolute left-[11px] top-0 bottom-0 w-px bg-[var(--border-subtle)]" />
      )}
      {/* Tool node */}
      <div className="absolute left-[6px] top-2 w-[12px] h-[12px] rounded-full border-2 border-[var(--border-default)] bg-[var(--bg-surface)]" />

      <div
        className={cn(
          'rounded border transition-all ml-2',
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
    </div>
  )
}

// ============================================
// Main ExecutionFlow Component
// ============================================

// Threshold for enabling virtual scrolling
const VIRTUALIZATION_THRESHOLD = 30

interface ExecutionFlowProps {
  llmCalls: LLMCall[]
  toolCalls: ToolCall[]
  maxVisible?: number
}

export function ExecutionFlow({ llmCalls, toolCalls, maxVisible = 10 }: ExecutionFlowProps) {
  const [showAll, setShowAll] = useState(false)
  const parentRef = useRef<HTMLDivElement>(null)

  const events = useMemo(
    () => mergeExecutionEvents(llmCalls, toolCalls),
    [llmCalls, toolCalls]
  )

  // Calculate tool count following each LLM call
  const toolCountAfterLLM = useMemo(() => {
    const counts = new Map<string, number>()
    for (let i = 0; i < events.length; i++) {
      if (events[i].type === 'llm') {
        let count = 0
        for (let j = i + 1; j < events.length; j++) {
          if (events[j].type === 'tool') count++
          else break
        }
        counts.set(events[i].data.id, count)
      }
    }
    return counts
  }, [events])

  // Determine which events to show
  const visible = showAll ? events : events.slice(0, maxVisible)
  const hasMore = events.length > maxVisible
  const useVirtual = showAll && events.length > VIRTUALIZATION_THRESHOLD

  // Virtual list for large event sets
  const virtualizer = useVirtualizer({
    count: useVirtual ? events.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      // LLM rows are taller than tool rows
      return events[index].type === 'llm' ? 52 : 36
    },
    overscan: 5,
  })

  if (events.length === 0) return null

  // Stats summary
  const totalTokens = llmCalls.reduce((sum, c) => sum + c.totalTokens, 0)
  const totalDuration = [...llmCalls, ...toolCalls].reduce((sum, c) => sum + c.durationMs, 0)

  const renderEvent = (event: ExecutionEvent, idx: number, allVisible: ExecutionEvent[]) => {
    if (event.type === 'llm') {
      const toolCount = toolCountAfterLLM.get(event.data.id) ?? 0
      return (
        <LLMEventRow
          key={event.data.id}
          call={event.data}
          toolCount={toolCount}
        />
      )
    } else {
      const nextEvent = allVisible[idx + 1]
      const isLastTool = !nextEvent || nextEvent.type === 'llm'
      return (
        <ToolEventRow
          key={event.data.id}
          call={event.data}
          isLast={isLastTool}
        />
      )
    }
  }

  return (
    <div className="space-y-2">
      {/* Summary header */}
      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>{llmCalls.length} LLM calls · {toolCalls.length} tool calls</span>
        <span>{totalTokens.toLocaleString()} tokens · {formatDuration(totalDuration)}</span>
      </div>

      {/* Timeline - virtualized when showing all with many events */}
      {useVirtual ? (
        <div
          ref={parentRef}
          className="max-h-[600px] overflow-auto"
          style={{ contain: 'strict' }}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const event = events[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderEvent(event, virtualRow.index, events)}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((event, idx) => renderEvent(event, idx, visible))}
        </div>
      )}

      {hasMore && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full text-center py-2 text-xs text-[var(--running)] hover:underline"
        >
          Show {events.length - maxVisible} more events
        </button>
      )}
    </div>
  )
}
