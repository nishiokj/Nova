import { useCockpit } from '@/hooks/use-cockpit-store';
import { getCockpitDiff, type RepoLensMatch } from '@/lib/api';

export function GrepTab() {
  const { state, set, handleRunGrepSearch } = useCockpit();
  const { lensQuery, lensResults, lensLoading, focusData } = state;

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <input
          value={lensQuery}
          onChange={(e) => set({ lensQuery: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleRunGrepSearch(); } }}
          placeholder="grep repo..."
          className="flex-1 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[var(--text-secondary)]"
        />
        <button
          onClick={() => void handleRunGrepSearch()}
          disabled={!lensQuery.trim() || lensLoading}
          className="px-2 py-1 rounded bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/30 disabled:opacity-60"
        >
          {lensLoading ? 'Grepping...' : 'Grep'}
        </button>
      </div>

      <div className="text-[11px] text-[var(--text-muted)]">
        {focusData?.sessionKey
          ? `Scoped to session ${focusData.sessionKey}`
          : 'Global repo grep (not scoped to a session)'}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
        {([
          ['Definitions', lensResults.defs],
          ['References', lensResults.refs],
          ['Text', lensResults.text],
        ] as [string, RepoLensMatch[]][]).map(([label, rows]) => (
          <div key={label} className="border border-[var(--border-subtle)] rounded overflow-hidden">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
              {label} ({rows.length})
            </div>
            <div className="max-h-56 overflow-y-auto">
              {rows.length === 0 ? (
                <div className="px-2 py-2 text-[var(--text-muted)]">No matches</div>
              ) : (
                rows.slice(0, 60).map((match, idx) => (
                  <button
                    key={`${label}-${match.kind}-${match.path}-${match.line}-${idx}`}
                    onClick={() => {
                      set({ focusTab: 'diff', selectedDiffFile: match.path });
                      if (focusData?.sessionKey) {
                        void getCockpitDiff({ sessionKey: focusData.sessionKey, file: match.path })
                          .then((r) => set({ diffData: r })).catch(() => {});
                      }
                    }}
                    className="w-full text-left px-2 py-1 border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)]"
                  >
                    <div className="font-mono text-[10px] text-[var(--text-secondary)] truncate">{match.path}:{match.line}</div>
                    <div className="text-[10px] text-[var(--text-muted)] truncate">{match.preview}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
