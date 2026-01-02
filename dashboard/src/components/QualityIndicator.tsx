import { cn } from '../lib/utils'

interface QualityIndicatorProps {
  score: number // 0-1
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
}

export function QualityIndicator({ score, size = 'md', showLabel = true }: QualityIndicatorProps) {
  const percent = Math.round(score * 100)

  const getColor = () => {
    if (score >= 0.8) return 'var(--success)'
    if (score >= 0.5) return 'var(--warning)'
    return 'var(--error)'
  }

  const sizeClasses = {
    sm: 'w-6 h-6',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  }

  const strokeWidth = size === 'lg' ? 3 : 2
  const radius = size === 'lg' ? 20 : size === 'md' ? 14 : 10
  const circumference = 2 * Math.PI * radius
  const offset = circumference - score * circumference

  return (
    <div className="flex items-center gap-1.5">
      <div className={cn('relative', sizeClasses[size])}>
        <svg className="w-full h-full -rotate-90" viewBox="0 0 48 48">
          {/* Background circle */}
          <circle
            cx="24"
            cy="24"
            r={radius}
            fill="none"
            stroke="var(--border-subtle)"
            strokeWidth={strokeWidth}
          />
          {/* Progress circle */}
          <circle
            cx="24"
            cy="24"
            r={radius}
            fill="none"
            stroke={getColor()}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-500 ease-out"
          />
        </svg>
        {size === 'lg' && (
          <span
            className="absolute inset-0 flex items-center justify-center font-mono text-xs font-medium"
            style={{ color: getColor() }}
          >
            {percent}
          </span>
        )}
      </div>
      {showLabel && size !== 'lg' && (
        <span
          className="font-mono text-xs tabular-nums"
          style={{ color: getColor() }}
        >
          {percent}%
        </span>
      )}
    </div>
  )
}

// Compact horizontal bar version
export function QualityBar({ score, width = 48 }: { score: number; width?: number }) {
  const percent = Math.round(score * 100)

  const getColor = () => {
    if (score >= 0.8) return 'var(--success)'
    if (score >= 0.5) return 'var(--warning)'
    return 'var(--error)'
  }

  return (
    <div className="flex items-center gap-1.5">
      <div
        className="h-1.5 rounded-full bg-[var(--border-subtle)] overflow-hidden"
        style={{ width }}
      >
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${percent}%`, backgroundColor: getColor() }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
        {percent}%
      </span>
    </div>
  )
}
