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

  const { contextTokens, outputTokens, maxTokens, percentageUsed } = metrics
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
      {/* Context window usage (prompt tokens) */}
      <span className="text-[var(--text-muted)]">CTX</span>
      <div className="w-16 h-1.5 bg-[var(--bg-surface)] rounded-full overflow-hidden">
        <div
          className="h-full transition-all duration-300"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
      <span className="text-[var(--text-secondary)] tabular-nums">
        {formatTokens(contextTokens)}/{formatTokens(maxTokens)}
      </span>
      <span className="text-[var(--text-muted)]">({pct.toFixed(0)}%)</span>
      {/* Output tokens (completion tokens) */}
      <span className="text-[var(--border-subtle)]">|</span>
      <span className="text-[var(--text-muted)]">OUT</span>
      <span className="text-[var(--text-secondary)] tabular-nums">
        {formatTokens(outputTokens)}
      </span>
    </div>
  )
}
