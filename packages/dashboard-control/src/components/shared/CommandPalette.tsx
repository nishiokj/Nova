import { useEffect, useMemo, useRef, useState } from 'react';
import { useCockpit, useCockpitStore } from '@/hooks/use-cockpit-store';
import { formatElapsed, statusColor } from '@/lib/format';
import { rankByQuery } from '@/lib/autocomplete';

export function CommandPalette() {
  const runningSessions = useCockpit(s => s.runningSessions);
  const readySessions = useCockpit(s => s.readySessions);
  const doneSessions = useCockpit(s => s.doneSessions);
  const store = useCockpitStore();
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allSessions = useMemo(() => [
    ...runningSessions,
    ...readySessions,
    ...doneSessions,
  ], [runningSessions, readySessions, doneSessions]);

  const filtered = useMemo(() => {
    return rankByQuery(
      allSessions,
      query,
      (session) => {
        const shortKey = session.sessionKey.slice(-8);
        const currentFile = session.currentActivity.file ?? '';
        const fileName = currentFile.split('/').pop() ?? currentFile;
        return [
          { text: session.title, weight: 1 },
          { text: session.sessionKey, weight: 1.1 },
          { text: shortKey, weight: 1.15 },
          { text: session.status, weight: 1.25 },
          { text: session.kind, weight: 1.35 },
          { text: session.currentActivity.tool, weight: 1.45 },
          { text: fileName, weight: 1.5 },
          { text: currentFile, weight: 1.75 },
        ];
      },
      20,
    );
  }, [query, allSessions]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedIdx(0);
      return;
    }
    setSelectedIdx((prev) => Math.max(0, Math.min(prev, filtered.length - 1)));
  }, [filtered.length]);

  const selectSession = (sessionKey: string) => {
    store.set({ focusTarget: { type: 'session', id: sessionKey }, commandPaletteOpen: false, commandPaletteQuery: '' });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const session = filtered[selectedIdx];
      if (session) selectSession(session.sessionKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      store.set({ commandPaletteOpen: false, commandPaletteQuery: '' });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => store.set({ commandPaletteOpen: false, commandPaletteQuery: '' })}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full max-w-lg rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-[var(--border-subtle)] px-3">
          <span className="text-[var(--text-muted)] text-sm mr-2">/</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search sessions by goal, key, status, tool..."
            className="flex-1 bg-transparent py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
          <kbd className="text-[10px] text-[var(--text-muted)] border border-[var(--border-subtle)] rounded px-1 py-0.5">esc</kbd>
        </div>
        <div className="max-h-[40vh] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">No sessions match</div>
          ) : (
            filtered.map((session, idx) => (
              <button
                key={session.sessionKey}
                onClick={() => selectSession(session.sessionKey)}
                className={`w-full text-left px-3 py-2 flex items-start gap-3 border-b border-[var(--border-subtle)] last:border-b-0 transition-colors ${
                  idx === selectedIdx ? 'bg-[var(--accent-cyan)]/10' : 'hover:bg-[var(--bg-hover)]'
                }`}
              >
                <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: statusColor(session.status) }} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-[var(--text-primary)] truncate">{session.title}</div>
                  <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] mt-0.5">
                    <span className="uppercase" style={{ color: statusColor(session.status) }}>{session.status}</span>
                    <span>{formatElapsed(session.elapsedSec)}</span>
                    <span className="font-mono">{session.sessionKey.slice(-8)}</span>
                    {session.currentActivity.tool !== 'idle' && (
                      <span className="text-[var(--accent-cyan)]">{session.currentActivity.tool}</span>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
        <div className="px-3 py-1.5 border-t border-[var(--border-subtle)] flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
          <span><kbd className="border border-[var(--border-subtle)] rounded px-1 py-0.5">↑↓</kbd> navigate</span>
          <span><kbd className="border border-[var(--border-subtle)] rounded px-1 py-0.5">↵</kbd> select</span>
          <span><kbd className="border border-[var(--border-subtle)] rounded px-1 py-0.5">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
