import { useCockpit } from '@/hooks/use-cockpit-store';
import { formatRelativeFromIso } from '@/lib/format';

export function TraceTab() {
  const { state } = useCockpit();

  if (state.traces.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-[var(--text-muted)] text-sm mb-1">No traces</div>
        <div className="text-[var(--text-muted)] text-[11px] opacity-60">Traces appear when the session records VCS snapshots</div>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-xs">
      {state.traces.slice(0, 50).map((trace) => (
        <div key={trace.id} className="border border-[var(--border-subtle)] rounded p-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[var(--text-primary)]">{trace.vcs.revision.slice(0, 8)}</span>
            <span className="text-[var(--text-muted)]">{formatRelativeFromIso(trace.timestamp)}</span>
            <span className="text-[var(--text-muted)] ml-auto">{trace.files.length} files</span>
          </div>
          <div className="mt-1 space-y-0.5">
            {trace.files.slice(0, 6).map((file) => (
              <div key={`${trace.id}-${file.path}`} className="font-mono text-[11px] text-[var(--text-secondary)] truncate">
                {file.path}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
