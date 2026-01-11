import type { ContextWindowMetrics } from '../domain/models'
import { cn } from '../lib/utils'

interface ContextWindowWidgetProps {
  metrics?: ContextWindowMetrics
  className?: string
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return tokens.toString()
}

export function ContextWindowWidget({ metrics, className }: ContextWindowWidgetProps) {
  if (!metrics) return null

  const { inputTokens, peakInputTokens, outputTokens, totalOutputTokens, maxTokens, percentageUsed } = metrics
  const pct = Math.min(100, percentageUsed * 100)

  const barColor = pct > 90
    ? 'var(--error)'
    : pct > 70
      ? 'var(--warning)'
      : 'var(--success)'

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 py-1 rounded',
        'bg-[var(--bg-elevated)] border border-[var(--border-subtle)]',
        'font-mono text-xs',
        className
      )}
    >
      {/* Current context window size (from last API response) */}
      <span className="text-[var(--text-muted)]" title="Current tokens in context window">IN</span>
      <div className="w-16 h-1.5 bg-[var(--bg-surface)] rounded-full overflow-hidden">
        <div
          className="h-full transition-all duration-300"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
      <span className="text-[var(--text-secondary)] tabular-nums">
        {formatTokens(inputTokens)}/{formatTokens(maxTokens)}
      </span>
      <span className="text-[var(--text-muted)]">({pct.toFixed(0)}%)</span>

      {/* Peak context size indicator (only show if different from current) */}
      {peakInputTokens > inputTokens && (
        <>
          <span className="text-[var(--border-subtle)]">|</span>
          <span className="text-[var(--text-muted)]" title="Peak context window size">PEAK</span>
          <span className="text-[var(--text-secondary)] tabular-nums">
            {formatTokens(peakInputTokens)}
          </span>
        </>
      )}

      {/* Last request output tokens */}
      <span className="text-[var(--border-subtle)]">|</span>
      <span className="text-[var(--text-muted)]" title="Output tokens from last request">OUT</span>
      <span className="text-[var(--text-secondary)] tabular-nums">
        {formatTokens(outputTokens)}
      </span>

      {/* Total output tokens (only show if different from last request) */}
      {totalOutputTokens > outputTokens && (
        <>
          <span className="text-[var(--border-subtle)]">/</span>
          <span className="text-[var(--text-secondary)] tabular-nums" title="Total output tokens across all requests">
            {formatTokens(totalOutputTokens)}
          </span>
        </>
      )}
    </div>
  )
}
