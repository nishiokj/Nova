import { useCockpit } from '@/hooks/use-cockpit-store';

export function Header() {
  const { state, refreshAll, set } = useCockpit();
  const { runningSessions, readySessions, doneSessions, escalations, loading, lastUpdate, globalTool, sessionFilterQuery } = state;

  return (
    <header className="h-9 shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-[var(--text-primary)] font-semibold">Cockpit</span>
        <div className="flex items-center gap-1 text-[11px]">
          <button
            onClick={() => set({ globalTool: 'none' })}
            className={`px-1.5 py-0.5 rounded ${globalTool === 'none' ? 'text-[var(--accent-cyan)] bg-[var(--accent-cyan)]/15' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'}`}
          >
            Doc
          </button>
          <button
            onClick={() => set({ globalTool: 'grep' })}
            className={`px-1.5 py-0.5 rounded ${globalTool === 'grep' ? 'text-[var(--accent-cyan)] bg-[var(--accent-cyan)]/15' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'}`}
          >
            Grep
          </button>
          <button
            onClick={() => set({ globalTool: 'browser' })}
            className={`px-1.5 py-0.5 rounded ${globalTool === 'browser' ? 'text-[var(--accent-cyan)] bg-[var(--accent-cyan)]/15' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'}`}
          >
            Preview
          </button>
        </div>
        <span className="text-xs text-[var(--text-muted)]">
          {runningSessions.length > 0 ? (
            <span className="text-[var(--running)]">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--running)] pulse-live mr-1" />
              Running {runningSessions.length}
            </span>
          ) : (
            <>Running 0</>
          )}
          {readySessions.length > 0 && <> · <span className="text-[var(--accent-cyan)]">Ready {readySessions.length}</span></>}
          {' · '}Done {doneSessions.length}
          {escalations.length > 0 && <> · <span className="text-[var(--warning)]">Esc {escalations.length}</span></>}
          {sessionFilterQuery && <> · <span className="text-[var(--accent-cyan)]">grep:{sessionFilterQuery}</span></>}
        </span>
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
