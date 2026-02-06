import { useCockpit } from '@/hooks/use-cockpit-store';

export function Header() {
  const { state, refreshAll, set } = useCockpit();
  const { loading, lastUpdate } = state;

  return (
    <header className="h-9 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 flex items-center justify-between">
      <div className="flex items-center">
        <span className="text-[var(--text-primary)] font-semibold">Cockpit</span>
      </div>
      <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
        <span>{lastUpdate.toLocaleTimeString()}</span>
        <button
          onClick={() => void refreshAll()}
          className={`px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] transition-transform ${loading ? 'animate-spin' : ''}`}
          title="Refresh (↻)"
        >
          {'\u21BB'}
        </button>
        <button
          onClick={() => set({ shortcutSheetOpen: true })}
          className="px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)]"
          title="Keyboard shortcuts (?)"
        >
          ?
        </button>
      </div>
    </header>
  );
}
