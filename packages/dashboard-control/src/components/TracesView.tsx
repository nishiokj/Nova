/**
 * Traces View - Git commit traces with AI attribution
 *
 * Shows agent-trace records tied to git commits.
 * Each trace shows which files were modified by which model/session.
 */

import { useState } from 'react';
import type { TraceRecord } from '@/lib/api';

interface TracesViewProps {
  traces: TraceRecord[];
  loading: boolean;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function TraceCard({ trace, isExpanded, onToggle }: { trace: TraceRecord; isExpanded: boolean; onToggle: () => void }) {
  const totalLines = trace.files.reduce((sum, f) =>
    sum + f.conversations.reduce((s, c) =>
      s + c.ranges.reduce((r, range) => r + (range.end_line - range.start_line + 1), 0), 0), 0);

  const models = new Set<string>();
  trace.files.forEach(f =>
    f.conversations.forEach(c => {
      if (c.contributor.model_id) models.add(c.contributor.model_id.split('/').pop() || 'unknown');
    })
  );

  return (
    <div className="border-b border-[var(--border-subtle)] last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-[var(--bg-hover)] transition-colors text-left"
      >
        <span className="font-mono text-[var(--accent-cyan)] text-xs w-16 shrink-0">
          {trace.vcs.revision.slice(0, 7)}
        </span>
        <span className="text-[var(--text-primary)] text-xs truncate flex-1">
          {trace.files.length} file{trace.files.length !== 1 ? 's' : ''} · {totalLines} lines
        </span>
        <span className="text-[var(--accent-violet)] text-xs truncate max-w-32">
          {Array.from(models).join(', ')}
        </span>
        <span className="text-[var(--text-muted)] text-xs w-16 text-right shrink-0">
          {relativeTime(trace.timestamp)}
        </span>
        <svg
          className={`w-3 h-3 text-[var(--text-muted)] transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-2 py-2 bg-[var(--bg-elevated)] border-t border-[var(--border-subtle)]">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs mb-2">
            <span className="text-[var(--text-muted)]">Revision:</span>
            <span className="text-[var(--text-secondary)] font-mono">{trace.vcs.revision}</span>
            <span className="text-[var(--text-muted)]">Tool:</span>
            <span className="text-[var(--text-secondary)]">{trace.tool.name} v{trace.tool.version}</span>
            <span className="text-[var(--text-muted)]">Time:</span>
            <span className="text-[var(--text-secondary)]">{new Date(trace.timestamp).toLocaleString()}</span>
          </div>

          <div className="text-xs text-[var(--text-muted)] mb-1">Files modified:</div>
          <div className="space-y-1">
            {trace.files.map((file, i) => (
              <div key={i} className="bg-[var(--bg-surface)] rounded px-2 py-1">
                <div className="font-mono text-[var(--text-primary)] text-xs truncate">
                  {file.path}
                </div>
                {file.conversations.map((conv, j) => (
                  <div key={j} className="flex items-center gap-2 mt-1 text-xs">
                    <span className="text-[var(--accent-violet)]">
                      {conv.contributor.model_id?.split('/').pop() || 'ai'}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      {conv.ranges.map(r => `L${r.start_line}-${r.end_line}`).join(', ')}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TracesView({ traces, loading }: TracesViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-[var(--text-muted)]">
          Agent traces tied to git commits
        </span>
        <span className="text-[var(--text-muted)] ml-auto">
          {traces.length} trace{traces.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Traces List */}
      <div className="flex-1 bg-[var(--bg-surface)] rounded border border-[var(--border-subtle)] overflow-y-auto">
        {loading ? (
          <div className="p-4 text-xs text-[var(--text-muted)] text-center">Loading...</div>
        ) : traces.length === 0 ? (
          <div className="p-4 text-center">
            <div className="text-xs text-[var(--text-muted)]">
              No traces yet.
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 opacity-60">
              Traces are created when agents make git commits.
            </div>
          </div>
        ) : (
          traces.map((trace) => (
            <TraceCard
              key={trace.id}
              trace={trace}
              isExpanded={expandedId === trace.id}
              onToggle={() => setExpandedId(expandedId === trace.id ? null : trace.id)}
            />
          ))
        )}
      </div>

      {/* Help text */}
      <div className="mt-2 text-xs text-[var(--text-muted)] opacity-60">
        Traces record AI contributions per file/line range. Stored in .agent-trace/
      </div>
    </div>
  );
}
