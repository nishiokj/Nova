import { useCockpit } from '@/hooks/use-cockpit-store';

export function DiffTab() {
  const { state, set, handleApplyPatch, handleSelectDiffFile } = useCockpit();
  const {
    diffData,
    selectedDiffFile,
    highlightedDiffIdx,
    diffPatchFile,
    diffPatchLoadingFile,
    diffPatchError,
    patchDraft,
    patchApplyStatus,
    applyingPatch,
  } = state;

  const hotspots = diffData?.hotspots.slice(0, 20) ?? [];

  if (!diffData) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-[var(--text-muted)] text-sm mb-1">No diff available</div>
        <div className="text-[var(--text-muted)] text-[11px] opacity-60">Diffs appear after the session makes file changes</div>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="text-[var(--text-muted)]">
        <span className="text-[var(--text-primary)]">{diffData.baseSha.slice(0, 8)}</span>
        {' -> '}
        <span className="text-[var(--text-primary)]">{diffData.headSha.slice(0, 8)}</span>
        {' · '}
        {diffData.summary.filesTouched} files · +{diffData.summary.added} / -{diffData.summary.deleted}
      </div>

      <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
        <div className="px-2 py-1 border-b border-[var(--border-subtle)] text-[var(--text-muted)] flex items-center justify-between">
          <span>Hotspots</span>
          <span className="text-[10px] opacity-80">{'\u2191/\u2193'} navigate · Enter open</span>
        </div>
        {hotspots.length === 0 ? (
          <div className="px-2 py-2 text-[var(--text-muted)]">No changed files in range.</div>
        ) : (
          hotspots.map((hotspot, index) => {
            const selected = selectedDiffFile === hotspot.path;
            const highlighted = highlightedDiffIdx === index || (highlightedDiffIdx === null && selected);
            return (
              <div key={hotspot.path} className="border-b border-[var(--border-subtle)] last:border-b-0">
                <button
                  onClick={() => void handleSelectDiffFile(hotspot.path)}
                  onMouseEnter={() => set({ highlightedDiffIdx: index })}
                  className={`w-full px-2 py-1 text-left transition-colors ${
                    selected
                      ? 'bg-[var(--accent-cyan)]/12'
                      : highlighted
                        ? 'bg-[var(--bg-hover)]'
                        : 'hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <div className="font-mono text-[11px] text-[var(--text-secondary)] truncate">{hotspot.path}</div>
                  <div className="text-[10px] text-[var(--text-muted)]">+{hotspot.added} / -{hotspot.deleted}</div>
                </button>
                {selected && (
                  <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                    {diffPatchLoadingFile === hotspot.path ? (
                      <div className="px-2 py-1.5 text-[10px] text-[var(--text-muted)]">Loading patch…</div>
                    ) : diffPatchError && diffPatchFile === hotspot.path ? (
                      <div className="px-2 py-1.5 text-[10px] text-[var(--error)]">{diffPatchError}</div>
                    ) : (
                      <>
                        {(diffPatchFile === hotspot.path || (!diffPatchFile && diffData.patch)) && diffData.patch ? (
                          <pre className="p-2 text-[10px] overflow-auto max-h-64 whitespace-pre font-mono leading-relaxed">
                            {diffData.patch.split('\n').map((line, i) => {
                              const color = line.startsWith('+') ? 'text-[var(--success)]'
                                : line.startsWith('-') ? 'text-[var(--error)]'
                                : line.startsWith('@@') ? 'text-[var(--accent-cyan)]'
                                : 'text-[var(--text-secondary)]';
                              return <div key={i} className={color}>{line || '\u00A0'}</div>;
                            })}
                          </pre>
                        ) : (
                          <div className="px-2 py-1.5 text-[10px] text-[var(--text-muted)]">
                            Press Enter or click to open this diff.
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {hotspots.length > 0 && !selectedDiffFile ? (
        <div className="text-[11px] text-[var(--text-muted)] italic">Use arrows or click to pick a file, Enter to open.</div>
      ) : null}

      <div className="flex items-center gap-2 border border-[var(--border-subtle)] rounded px-2 py-1">
        <input
          value={patchDraft}
          onChange={(e) => set({ patchDraft: e.target.value })}
          placeholder="Paste unified diff..."
          className="flex-1 min-w-0 bg-transparent text-[11px] font-mono text-[var(--text-secondary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        <button
          onClick={() => void handleApplyPatch()}
          disabled={applyingPatch || !patchDraft.trim()}
          className="flex-shrink-0 px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
        >
          {applyingPatch ? 'Applying...' : 'Apply'}
        </button>
        {patchApplyStatus && <span className="flex-shrink-0 text-[10px] text-[var(--text-muted)]">{patchApplyStatus}</span>}
      </div>
    </div>
  );
}
