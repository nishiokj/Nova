import { useState } from 'react'
import type { LLMCall, AgentType } from '../domain/models'
import { cn } from '../lib/utils'
import { formatDuration } from '../lib/time'

const AGENT_COLORS: Record<AgentType, string> = {
  wizard: 'var(--accent-violet)',
  worker: 'var(--accent-cyan)',
  planner: '#f97316',
  reflector: '#ec4899',
  synthesizer: 'var(--success)',
}

function LLMCallRow({ call }: { call: LLMCall }) {
  const [expanded, setExpanded] = useState(false)
  const color = AGENT_COLORS[call.agentType] ?? 'var(--text-muted)'

  return (
    <div className="border border-[var(--border-subtle)] rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="px-1.5 py-0.5 rounded text-xs font-mono uppercase"
              style={{ backgroundColor: `${color}20`, color }}
            >
              {call.agentType}
            </span>
            {call.stepNum !== undefined && (
              <span className="text-xs text-[var(--text-muted)]">Step {call.stepNum}</span>
            )}
            <span className="text-xs text-[var(--text-secondary)] font-mono">{call.model}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
            <span className="tabular-nums">{call.totalTokens.toLocaleString()} tok</span>
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
  )
}

interface LLMCallListProps {
  calls: LLMCall[]
  maxVisible?: number
}

export function LLMCallList({ calls, maxVisible = 5 }: LLMCallListProps) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? calls : calls.slice(0, maxVisible)
  const hasMore = calls.length > maxVisible

  if (calls.length === 0) return null

  const totalTokens = calls.reduce((sum, c) => sum + c.totalTokens, 0)
  const totalDuration = calls.reduce((sum, c) => sum + c.durationMs, 0)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>{calls.length} LLM calls</span>
        <span>{totalTokens.toLocaleString()} total tokens | {formatDuration(totalDuration)}</span>
      </div>

      <div className="space-y-2">
        {visible.map((call) => <LLMCallRow key={call.id} call={call} />)}
      </div>

      {hasMore && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full text-center py-2 text-xs text-[var(--running)] hover:underline"
        >
          Show {calls.length - maxVisible} more calls
        </button>
      )}
    </div>
  )
}
