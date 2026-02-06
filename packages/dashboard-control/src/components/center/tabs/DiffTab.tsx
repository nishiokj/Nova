import { useCockpit } from '@/hooks/use-cockpit-store';
import { getCockpitDiff } from '@/lib/api';

export function DiffTab() {
  const { state, set, handleApplyPatch } = useCockpit();
  const { diffData, selectedDiffFile, patchDraft, patchApplyStatus, applyingPatch, focusData } = state;

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
        <div className="px-2 py-1 border-b border-[var(--border-subtle)] text-[var(--text-muted)]">Hotspots</div>
        {diffData.hotspots.length === 0 ? (
          <div className="px-2 py-2 text-[var(--text-muted)]">No changed files in range.</div>
        ) : (
          diffData.hotspots.slice(0, 20).map((hotspot) => (
            <button
              key={hotspot.path}
              onClick={() => {
                set({ selectedDiffFile: hotspot.path });
                if (focusData?.sessionKey) {
                  void getCockpitDiff({
                    sessionKey: focusData.sessionKey,
                    base: diffData.baseSha,
                    head: diffData.headSha,
                    file: hotspot.path,
                  }).then((r) => set({ diffData: r })).catch(() => {});
                }
              }}
              className={`w-full px-2 py-1 text-left border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)] ${
                selectedDiffFile === hotspot.path ? 'bg-[var(--accent-cyan)]/10' : ''
              }`}
            >
              <div className="font-mono text-[11px] text-[var(--text-secondary)] truncate">{hotspot.path}</div>
              <div className="text-[10px] text-[var(--text-muted)]">+{hotspot.added} / -{hotspot.deleted}</div>
            </button>
          ))
        )}
      </div>

      {diffData.patch && (
        <pre className="p-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] overflow-x-auto whitespace-pre-wrap">
          {diffData.patch}
        </pre>
      )}

      <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
        <div className="text-[var(--text-muted)]">Patch Pad (max 3 files / 30 lines)</div>
        <textarea
          value={patchDraft}
          onChange={(e) => set({ patchDraft: e.target.value })}
          placeholder="Paste unified diff here..."
          className="w-full min-h-28 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] font-mono text-[var(--text-secondary)]"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleApplyPatch()}
            disabled={applyingPatch || !patchDraft.trim()}
            className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
          >
            {applyingPatch ? 'Applying...' : 'Apply Patch'}
          </button>
          {patchApplyStatus && <span className="text-[10px] text-[var(--text-muted)]">{patchApplyStatus}</span>}
        </div>
      </div>
    </div>
  );
}
