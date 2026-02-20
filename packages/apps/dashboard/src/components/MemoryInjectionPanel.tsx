import { useState } from 'react'
import type { MemoryInjection } from '../domain/models'
import { cn } from '../lib/utils'
import { StatusDot } from './StatusBadge'

function formatLatency(latencyMs?: number): string {
  if (!latencyMs && latencyMs !== 0) return ''
  return latencyMs < 1000 ? `${latencyMs}ms` : `${(latencyMs / 1000).toFixed(1)}s`
}

function formatCoverage(coverage?: Record<string, number>): string {
  if (!coverage) return ''
  const entries = Object.entries(coverage)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}:${value}`)
  return entries.join(', ')
}

interface MemoryInjectionRowProps {
  injection: MemoryInjection
  expanded?: boolean
}

function MemoryInjectionRow({ injection, expanded: defaultExpanded = false }: MemoryInjectionRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const injectedMemory = injection.memoryContent ?? injection.resultPreview ?? ''

  return (
    <div
      className={cn(
        'group rounded border transition-all',
        injection.success
          ? 'border-[var(--border-subtle)] hover:border-[var(--border-default)]'
          : 'border-[var(--warning-muted)] bg-[var(--warning-bg)]'
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'w-full flex items-center gap-2 px-2.5 py-1.5 text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--running)]'
        )}
      >
        <StatusDot status={injection.success ? 'success' : 'warning'} />

        <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
          <span className="font-mono text-xs font-medium">memory_injected</span>
        </span>

        <span className="flex-1 font-mono text-xs text-[var(--text-muted)] truncate">
          {injection.query || '(empty query)'}
        </span>

        <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums whitespace-nowrap">
          {injection.itemCount} items
          {injection.totalTokens ? ` • ${injection.totalTokens} tok` : ''}
          {injection.latencyMs !== undefined ? ` • ${formatLatency(injection.latencyMs)}` : ''}
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
          <div className="space-y-2">
            <div>
              <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Query</span>
              <pre className="mt-1 p-2 rounded bg-[var(--bg-base)] text-xs font-mono text-[var(--text-secondary)] overflow-x-auto max-h-32">
                {injection.query || '(empty query)'}
              </pre>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                {injection.memoryContent ? 'Injected Memory' : 'Preview'}
              </span>
              <pre className="mt-1 p-2 rounded bg-[var(--bg-base)] text-xs font-mono text-[var(--text-secondary)] overflow-x-auto max-h-48">
                {injectedMemory || '(no memory)'}
              </pre>
            </div>
            {injection.contextWithMemory && (
              <div>
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Context (Task + Memory)</span>
                <pre className="mt-1 p-2 rounded bg-[var(--bg-base)] text-xs font-mono text-[var(--text-secondary)] overflow-x-auto max-h-48">
                  {injection.contextWithMemory}
                </pre>
              </div>
            )}
          </div>

          {(injection.coverage || injection.discriminatorsIncluded !== undefined) && (
            <div className="text-[11px] text-[var(--text-muted)] font-mono">
              {injection.coverage && `coverage: ${formatCoverage(injection.coverage)}`}
              {injection.discriminatorsIncluded !== undefined
                ? ` • discriminators: ${injection.discriminatorsIncluded}`
                : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function MemoryInjectionList({ injections, maxVisible = 3 }: { injections: MemoryInjection[]; maxVisible?: number }) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? injections : injections.slice(0, maxVisible)
  const hiddenCount = injections.length - maxVisible

  return (
    <div className="space-y-1">
      {visible.map((injection) => (
        <MemoryInjectionRow key={injection.id} injection={injection} />
      ))}
      {!showAll && hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full text-center py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          + {hiddenCount} more memory injections
        </button>
      )}
    </div>
  )
}
