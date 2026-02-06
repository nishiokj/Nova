import { useCallback, useEffect, useRef } from 'react';
import { useCockpit, type FocusTarget } from '@/hooks/use-cockpit-store';
import { SessionCard } from './SessionCard';
import { CommitList } from './CommitList';
import { PRList } from './PRList';

function useStableSelect(type: FocusTarget['type']) {
  const { set } = useCockpit();
  const cacheRef = useRef(new Map<string, () => void>());

  return useCallback((id: string) => {
    let fn = cacheRef.current.get(id);
    if (!fn) {
      fn = () => set({ focusTarget: { type, id } });
      cacheRef.current.set(id, fn);
    }
    return fn;
  }, [set, type]);
}

export function RightPanel() {
  const { state, handleResolveEscalation } = useCockpit();
  const {
    runningSessions,
    readySessions,
    doneSessions,
    escalations,
    focusTarget,
    resolvingEscalationId,
    sessionFilterQuery,
    highlightedSessionIdx,
  } = state;
  const getSessionSelect = useStableSelect('session');
  const getEscalationSelect = useStableSelect('escalation');
  const highlightRef = useRef<HTMLDivElement>(null);
  const query = sessionFilterQuery.trim().toLowerCase();
  const matchesSession = (row: { sessionKey: string; title: string; currentActivity: { tool: string; file?: string } }) => {
    if (!query) return true;
    return row.sessionKey.toLowerCase().includes(query)
      || row.title.toLowerCase().includes(query)
      || row.currentActivity.tool.toLowerCase().includes(query)
      || (row.currentActivity.file ?? '').toLowerCase().includes(query);
  };
  const filteredRunning = runningSessions.filter(matchesSession);
  const filteredReady = readySessions.filter(matchesSession);
  const filteredDone = doneSessions.filter(matchesSession);
  const filteredEscalations = query
    ? escalations.filter((row) =>
      row.sessionKey.toLowerCase().includes(query)
      || row.headline.toLowerCase().includes(query)
      || row.escalationId.toLowerCase().includes(query))
    : escalations;

  // Build flat session list for keyboard nav index mapping
  const runningOffset = 0;
  const readyOffset = filteredRunning.length;
  const doneOffset = readyOffset + filteredReady.length;

  // Auto-scroll highlighted card into view
  useEffect(() => {
    if (highlightedSessionIdx !== null) {
      highlightRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [highlightedSessionIdx]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-2 py-1.5 border-b border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)] flex items-center gap-2">
        <span className="text-[var(--running)]">Running {runningSessions.length}</span>
        <span className="text-[var(--accent-cyan)]">Ready {readySessions.length}</span>
        <span>Done {doneSessions.length}</span>
        {escalations.length > 0 && <span className="text-[var(--warning)]">Esc {escalations.length}</span>}
        {sessionFilterQuery && (
          <span className="ml-auto text-[var(--accent-cyan)] truncate" title={sessionFilterQuery}>
            grep:{sessionFilterQuery}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* RUNNING section */}
        {filteredRunning.length > 0 && (
          <>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--running)] bg-[var(--running)]/10 border-b border-[var(--border-subtle)]">
              Running ({filteredRunning.length})
            </div>
            {filteredRunning.map((row, i) => (
              <div key={row.sessionKey} ref={highlightedSessionIdx === runningOffset + i ? highlightRef : undefined}>
                <SessionCard
                  row={row}
                  selected={focusTarget?.type === 'session' && focusTarget.id === row.sessionKey}
                  highlighted={highlightedSessionIdx === runningOffset + i}
                  onSelect={getSessionSelect(row.sessionKey)}
                />
              </div>
            ))}
          </>
        )}

        {/* READY section */}
        {filteredReady.length > 0 && (
          <>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--accent-cyan)] bg-[var(--accent-cyan)]/10 border-b border-[var(--border-subtle)]">
              Ready ({filteredReady.length})
            </div>
            {filteredReady.map((row, i) => (
              <div key={row.sessionKey} ref={highlightedSessionIdx === readyOffset + i ? highlightRef : undefined}>
                <SessionCard
                  row={row}
                  selected={focusTarget?.type === 'session' && focusTarget.id === row.sessionKey}
                  highlighted={highlightedSessionIdx === readyOffset + i}
                  onSelect={getSessionSelect(row.sessionKey)}
                />
              </div>
            ))}
          </>
        )}

        {/* DONE section */}
        {filteredDone.length > 0 && (
          <>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--success)] bg-[var(--success)]/10 border-b border-[var(--border-subtle)]">
              Done ({filteredDone.length})
            </div>
            {filteredDone.slice(0, 10).map((row, i) => (
              <div key={row.sessionKey} ref={highlightedSessionIdx === doneOffset + i ? highlightRef : undefined}>
                <SessionCard
                  row={row}
                  selected={focusTarget?.type === 'session' && focusTarget.id === row.sessionKey}
                  highlighted={highlightedSessionIdx === doneOffset + i}
                  onSelect={getSessionSelect(row.sessionKey)}
                />
              </div>
            ))}
          </>
        )}

        {/* Escalations */}
        {filteredEscalations.length > 0 && (
          <>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--warning)] bg-[var(--warning)]/10 border-b border-[var(--border-subtle)]">
              Escalations ({filteredEscalations.length})
            </div>
            {filteredEscalations.map((row) => (
              <div
                key={row.escalationId}
                className={`px-2 py-1.5 border-b border-[var(--border-subtle)] ${
                  focusTarget?.type === 'escalation' && focusTarget.id === row.escalationId
                    ? 'bg-[var(--warning)]/10 border-l-2 border-l-[var(--warning)]'
                    : ''
                }`}
              >
                <button
                  onClick={getEscalationSelect(row.escalationId)}
                  className="w-full text-left hover:bg-[var(--bg-hover)] rounded px-1 py-0.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--warning)] uppercase">{row.requestedDecision}</span>
                    <span className="text-xs text-[var(--text-primary)] truncate flex-1">{row.headline}</span>
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    {row.sessionKey.slice(0, 12)} · {Math.floor(row.ageSec / 60)}m
                  </div>
                </button>
                <button
                  onClick={() => void handleResolveEscalation(row.escalationId)}
                  disabled={resolvingEscalationId === row.escalationId}
                  className="mt-1 px-1.5 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
                >
                  {resolvingEscalationId === row.escalationId ? 'Resolving...' : 'Resolve'}
                </button>
              </div>
            ))}
          </>
        )}

        {/* Collapsible commits & PRs */}
        <CommitList />
        <PRList />
      </div>
    </div>
  );
}
