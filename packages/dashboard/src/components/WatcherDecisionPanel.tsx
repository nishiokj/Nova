import type { WatcherDecision } from '../domain/models'
import { formatDateTime } from '../lib/time'

function getActionConfig(action: string): {
  label: string
  color: string
  bgColor: string
  borderColor: string
  icon: React.ReactNode
} {
  const iconClass = 'w-3.5 h-3.5'
  const actionLower = action.toLowerCase()

  if (actionLower.includes('continue') || actionLower.includes('proceed')) {
    return {
      label: action.toUpperCase(),
      color: 'var(--success)',
      bgColor: 'var(--success-bg)',
      borderColor: 'var(--success-muted)',
      icon: (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ),
    }
  }

  if (actionLower.includes('ask') || actionLower.includes('question') || actionLower.includes('clarify')) {
    return {
      label: action.toUpperCase(),
      color: 'var(--accent-cyan)',
      bgColor: 'var(--bg-elevated)',
      borderColor: 'var(--accent-cyan)',
      icon: (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    }
  }

  if (actionLower.includes('intervene') || actionLower.includes('pause') || actionLower.includes('stop')) {
    return {
      label: action.toUpperCase(),
      color: 'var(--warning)',
      bgColor: 'var(--warning-bg)',
      borderColor: 'var(--warning-muted)',
      icon: (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    }
  }

  if (actionLower.includes('abort') || actionLower.includes('cancel') || actionLower.includes('reject')) {
    return {
      label: action.toUpperCase(),
      color: 'var(--error)',
      bgColor: 'var(--error-bg)',
      borderColor: 'var(--error-muted)',
      icon: (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      ),
    }
  }

  // Default: neutral observation
  return {
    label: action.toUpperCase(),
    color: 'var(--text-secondary)',
    bgColor: 'var(--bg-elevated)',
    borderColor: 'var(--border-default)',
    icon: (
      <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    ),
  }
}

interface WatcherDecisionCardProps {
  decision: WatcherDecision
}

function WatcherDecisionCard({ decision }: WatcherDecisionCardProps) {
  const config = getActionConfig(decision.action)

  return (
    <div
      className="rounded-lg border p-3 space-y-2"
      style={{ borderColor: config.borderColor, backgroundColor: config.bgColor }}
    >
      {/* Header: timestamp + action badge */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--text-muted)] font-mono">
          {formatDateTime(decision.timestamp)}
        </span>
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium border"
          style={{
            color: config.color,
            backgroundColor: 'var(--bg-surface)',
            borderColor: config.borderColor,
          }}
        >
          {config.icon}
          {config.label}
        </span>
      </div>

      {/* Trigger */}
      <div>
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Trigger</span>
        <p className="text-sm text-[var(--text-primary)] font-medium">{decision.trigger}</p>
      </div>

      {/* Rationale */}
      {decision.rationale && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Rationale</span>
          <p className="text-sm text-[var(--text-secondary)]">{decision.rationale}</p>
        </div>
      )}

      {/* Question/Answer if present */}
      {decision.question && (
        <div className="space-y-2 pt-1 border-t border-[var(--border-subtle)]">
          <div>
            <span className="text-[10px] uppercase tracking-wider text-[var(--accent-cyan)]">Question</span>
            <p className="text-sm text-[var(--text-primary)]">{decision.question}</p>
          </div>
          {decision.answer && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-[var(--success)]">Answer</span>
              <p className="text-sm text-[var(--text-primary)]">{decision.answer}</p>
            </div>
          )}
        </div>
      )}

      {/* Quality gate if present */}
      {decision.qualityGate && (
        <div className="pt-1 border-t border-[var(--border-subtle)]">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Quality Gate</span>
            <span
              className="text-xs font-mono"
              style={{ color: decision.qualityGate.passed ? 'var(--success)' : 'var(--error)' }}
            >
              {decision.qualityGate.passed ? 'PASSED' : 'FAILED'}
            </span>
          </div>
          {decision.qualityGate.issues && decision.qualityGate.issues.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {decision.qualityGate.issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-[var(--error)]">
                  <span className="mt-1.5 w-1 h-1 rounded-full bg-[var(--error)] flex-shrink-0" />
                  {issue}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Work item ID if present */}
      {decision.workItemId && (
        <div className="text-xs text-[var(--text-muted)] font-mono">
          Work Item: {decision.workItemId}
        </div>
      )}
    </div>
  )
}

interface WatcherDecisionPanelProps {
  decisions: WatcherDecision[]
}

export function WatcherDecisionPanel({ decisions }: WatcherDecisionPanelProps) {
  if (decisions.length === 0) return null

  // Sort by timestamp descending (most recent first)
  const sorted = [...decisions].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  return (
    <div className="space-y-2">
      {sorted.map((decision, i) => (
        <WatcherDecisionCard key={`${decision.timestamp}-${i}`} decision={decision} />
      ))}
    </div>
  )
}

// Compact badge for session summary
export function WatcherDecisionBadge({ decisions }: { decisions: WatcherDecision[] }) {
  if (decisions.length === 0) return null

  const interventions = decisions.filter(
    d => d.action.toLowerCase().includes('intervene') ||
         d.action.toLowerCase().includes('ask') ||
         d.action.toLowerCase().includes('pause')
  ).length

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono border"
      style={{
        color: interventions > 0 ? 'var(--warning)' : 'var(--text-muted)',
        backgroundColor: interventions > 0 ? 'var(--warning-bg)' : 'var(--bg-elevated)',
        borderColor: interventions > 0 ? 'var(--warning-muted)' : 'var(--border-subtle)',
      }}
      title={`${decisions.length} watcher decisions, ${interventions} interventions`}
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
      {decisions.length}
    </span>
  )
}
