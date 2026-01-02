import type { Reflection, ReflectionVerdict } from '../domain/models'
import { QualityBar } from './QualityIndicator'

function getVerdictConfig(verdict: ReflectionVerdict): {
  label: string
  color: string
  bgColor: string
  borderColor: string
  icon: React.ReactNode
} {
  const iconClass = 'w-3.5 h-3.5'

  switch (verdict) {
    case 'accept':
      return {
        label: 'ACCEPT',
        color: 'var(--success)',
        bgColor: 'var(--success-bg)',
        borderColor: 'var(--success-muted)',
        icon: (
          <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ),
      }
    case 'accept_extend':
      return {
        label: 'ACCEPT+',
        color: 'var(--success)',
        bgColor: 'var(--success-bg)',
        borderColor: 'var(--success-muted)',
        icon: (
          <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        ),
      }
    case 'redo':
      return {
        label: 'REDO',
        color: 'var(--warning)',
        bgColor: 'var(--warning-bg)',
        borderColor: 'var(--warning-muted)',
        icon: (
          <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
        ),
      }
    case 'abort_step':
      return {
        label: 'ABORT STEP',
        color: 'var(--error)',
        bgColor: 'var(--error-bg)',
        borderColor: 'var(--error-muted)',
        icon: (
          <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        ),
      }
    case 'abort_goal':
      return {
        label: 'ABORT',
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
}

interface ReflectionPanelProps {
  reflection: Reflection
  compact?: boolean
}

export function ReflectionPanel({ reflection, compact = false }: ReflectionPanelProps) {
  const config = getVerdictConfig(reflection.verdict)
  const confidencePercent = Math.round(reflection.confidence * 100)

  if (compact) {
    return (
      <div className="flex items-center gap-3">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono font-medium border"
          style={{
            color: config.color,
            backgroundColor: config.bgColor,
            borderColor: config.borderColor,
          }}
        >
          {config.icon}
          {config.label}
        </span>
        <QualityBar score={reflection.qualityScore} width={40} />
        <span className="text-xs font-mono text-[var(--text-muted)]">
          {confidencePercent}% conf
        </span>
      </div>
    )
  }

  return (
    <div
      className="rounded-lg border p-3 space-y-3"
      style={{ borderColor: config.borderColor, backgroundColor: config.bgColor }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono font-semibold border"
            style={{
              color: config.color,
              backgroundColor: 'var(--bg-surface)',
              borderColor: config.borderColor,
            }}
          >
            {config.icon}
            {config.label}
          </span>
          <span className="text-xs text-[var(--text-muted)]">Reflection</span>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Quality</span>
          <div className="mt-1">
            <QualityBar score={reflection.qualityScore} width={64} />
          </div>
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Confidence</span>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 w-16 rounded-full bg-[var(--border-subtle)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--accent-cyan)] transition-all duration-300"
                style={{ width: `${confidencePercent}%` }}
              />
            </div>
            <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
              {confidencePercent}%
            </span>
          </div>
        </div>
      </div>

      {/* Reasoning */}
      {reflection.reasoning && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Reasoning</span>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{reflection.reasoning}</p>
        </div>
      )}

      {/* Issues */}
      {reflection.issues.length > 0 && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Issues</span>
          <ul className="mt-1 space-y-1">
            {reflection.issues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-[var(--error)]">
                <span className="mt-1 w-1 h-1 rounded-full bg-[var(--error)] flex-shrink-0" />
                {issue}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// Compact badge version for inline display
export function ReflectionBadge({ reflection }: { reflection: Reflection }) {
  const config = getVerdictConfig(reflection.verdict)

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium border"
      style={{
        color: config.color,
        backgroundColor: config.bgColor,
        borderColor: config.borderColor,
      }}
      title={`${config.label} - Quality: ${Math.round(reflection.qualityScore * 100)}%`}
    >
      {config.icon}
      <span>{Math.round(reflection.qualityScore * 100)}%</span>
    </span>
  )
}
