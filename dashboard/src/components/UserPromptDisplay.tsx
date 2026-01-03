import type { UserPrompt } from '../domain/models'
import { cn } from '../lib/utils'
import { StatusBadge } from './StatusBadge'

interface UserPromptDisplayProps {
  prompt: UserPrompt
  className?: string
}

export function UserPromptDisplay({ prompt, className }: UserPromptDisplayProps) {
  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        'bg-[var(--warning-bg)] border-[var(--warning-muted)]',
        className
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-[var(--warning)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-medium text-[var(--warning)]">Agent Awaiting Input</span>
        </div>
        <StatusBadge tone={prompt.answered ? 'success' : 'warning'}>
          {prompt.answered ? 'ANSWERED' : 'PENDING'}
        </StatusBadge>
      </div>

      <p className="text-sm font-medium text-[var(--text-primary)] mb-2">{prompt.question}</p>

      {prompt.options.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {prompt.options.map((option, idx) => (
            <div
              key={idx}
              className={cn(
                'px-3 py-1.5 rounded text-sm',
                'bg-[var(--bg-surface)] border border-[var(--border-subtle)]',
                prompt.answered && prompt.answer === option &&
                  'border-[var(--success)] bg-[var(--success-bg)]'
              )}
            >
              {option}
            </div>
          ))}
        </div>
      )}

      {prompt.context && (
        <p className="text-xs text-[var(--text-muted)] italic">Context: {prompt.context}</p>
      )}

      {prompt.answered && prompt.answer && (
        <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
          <span className="text-xs text-[var(--text-muted)]">User answered: </span>
          <span className="text-sm text-[var(--success)]">{prompt.answer}</span>
        </div>
      )}
    </div>
  )
}
