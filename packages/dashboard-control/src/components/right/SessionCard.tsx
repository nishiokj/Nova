import { memo } from 'react';
import type { SessionRollup } from '@/lib/api';
import { formatElapsed, formatTokenCount, statusColor } from '@/lib/format';

export const SessionCard = memo(function SessionCard({
  row,
  selected,
  highlighted,
  onSelect,
}: {
  row: SessionRollup;
  selected: boolean;
  highlighted?: boolean;
  onSelect: () => void;
}) {
  const color = statusColor(row.status);
  const isBlocked = row.blocking.unresolvedEscalationsCount > 0;
  const hasActivity = row.currentActivity.tool !== 'idle';

  return (
    <button
      onClick={onSelect}
      className={`relative w-full text-left px-3 py-2 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] transition-colors ${
        selected ? 'bg-[var(--bg-hover)] border-l-2'
        : highlighted ? 'bg-[var(--accent-cyan)]/8 border-l-2 border-l-[var(--accent-cyan)]/50'
        : 'border-l-2 border-l-transparent'
      }`}
      style={selected ? { borderLeftColor: color } : undefined}
    >
      {isBlocked && (
        <span
          className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-[var(--warning)] escalation-alert-light"
          title={`${row.blocking.unresolvedEscalationsCount} escalation${row.blocking.unresolvedEscalationsCount === 1 ? '' : 's'} pending`}
        />
      )}

      <div className="text-[13px] text-[var(--text-primary)] leading-snug line-clamp-2" title={row.title}>{row.title}</div>

      <div className="flex items-center gap-2 mt-1">
        <span
          className="inline-flex items-center gap-1"
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-[10px] uppercase tracking-wide" style={{ color }}>
            {isBlocked ? `blocked (${row.blocking.unresolvedEscalationsCount})` : row.status}
          </span>
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">{formatElapsed(row.elapsedSec)}</span>
        <span className="text-[10px] text-[var(--text-muted)] font-mono opacity-60 ml-auto">
          {row.sessionKey.slice(-8)}
        </span>
      </div>

      {hasActivity && (
        <div className="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--accent-cyan)]">
          <span className="opacity-80">{'\u2699'}</span>
          <span className="truncate">{row.currentActivity.tool}</span>
          {row.currentActivity.file && (
            <span className="text-[var(--text-muted)] truncate">
              {row.currentActivity.file}{typeof row.currentActivity.line === 'number' ? `:${row.currentActivity.line}` : ''}
            </span>
          )}
        </div>
      )}

      {(row.diffstat.added > 0 || row.diffstat.deleted > 0 || row.diffstat.filesTouched > 0) && (
        <div className="flex items-center gap-2 mt-1 text-[10px] text-[var(--text-muted)]">
          <span className="text-[var(--success)]">+{row.diffstat.added}/-{row.diffstat.deleted}</span>
          {row.diffstat.filesTouched > 0 && <span>{row.diffstat.filesTouched} files</span>}
        </div>
      )}

      {row.tokenMetrics?.llmCalls > 0 && (
        <div className="flex items-center gap-2 mt-1 text-[10px] text-[var(--text-muted)]">
          <span title={`Input: ${formatTokenCount(row.tokenMetrics.input)} | Output: ${formatTokenCount(row.tokenMetrics.output)}${row.tokenMetrics.cached > 0 ? ` | Cached: ${formatTokenCount(row.tokenMetrics.cached)}` : ''}`}>
            {formatTokenCount(row.tokenMetrics.total)} tok
          </span>
          <span>{row.tokenMetrics.llmCalls} calls</span>
          <span>{row.tokenMetrics.avgLatencyMs}ms avg</span>
        </div>
      )}
    </button>
  );
});
