import { useMemo } from 'react';
import { useCockpit, useCockpitStore } from '@/hooks/use-cockpit-store';
import { PacketTab } from './PacketTab';

export function EscalationsTab() {
  const focusData = useCockpit((s) => s.focusData);
  const escalations = useCockpit((s) => s.escalations);
  const resolvingEscalationId = useCockpit((s) => s.resolvingEscalationId);
  const store = useCockpitStore();

  const sessionEscalations = useMemo(() => {
    const sessionKey = focusData?.sessionKey;
    if (!sessionKey) return [];
    return escalations
      .filter((row) => row.sessionKey === sessionKey)
      .sort((a, b) => b.ageSec - a.ageSec);
  }, [escalations, focusData?.sessionKey]);

  const focusedEscalationId = focusData?.type === 'escalation'
    ? focusData.id
    : null;

  const primaryEscalationId = focusedEscalationId ?? sessionEscalations[0]?.escalationId ?? null;

  return (
    <div className="space-y-3">
      <div className="rounded border border-[var(--warning)]/50 bg-[var(--warning)]/10 px-3 py-2 escalation-tab-glow">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-[var(--warning)] font-semibold uppercase tracking-wide">
            Escalations {sessionEscalations.length > 0 ? `(${sessionEscalations.length})` : ''}
          </div>
          {primaryEscalationId && (
            <button
              onClick={() => void store.handleResolveEscalation(primaryEscalationId)}
              disabled={resolvingEscalationId === primaryEscalationId}
              className="px-2 py-1 text-[11px] rounded bg-[var(--warning)]/25 text-[var(--warning)] hover:bg-[var(--warning)]/35 disabled:opacity-60"
            >
              {resolvingEscalationId === primaryEscalationId ? 'Resolving...' : 'Resolve Escalation'}
            </button>
          )}
        </div>
        <div className="text-[11px] text-[var(--text-secondary)] mt-1">
          Human decision required before this session can safely continue.
        </div>
      </div>

      {sessionEscalations.length === 0 ? (
        <div className="text-[11px] text-[var(--text-muted)] border border-[var(--border-subtle)] rounded px-3 py-2">
          No open escalations for this session.
        </div>
      ) : (
        <div className="space-y-2">
          {sessionEscalations.map((row) => {
            const selected = focusedEscalationId === row.escalationId;
            return (
              <div
                key={row.escalationId}
                className={`border rounded px-2.5 py-2 ${
                  selected
                    ? 'border-[var(--warning)]/70 bg-[var(--warning)]/12'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase text-[var(--warning)]">{row.requestedDecision}</span>
                  <span className="text-xs text-[var(--text-primary)] truncate flex-1">{row.headline}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">{Math.floor(row.ageSec / 60)}m</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <button
                    onClick={() => store.set({ focusTarget: { type: 'escalation', id: row.escalationId }, focusTab: 'escalations' })}
                    className="px-2 py-0.5 text-[11px] rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    Open
                  </button>
                  <button
                    onClick={() => void store.handleResolveEscalation(row.escalationId)}
                    disabled={resolvingEscalationId === row.escalationId}
                    className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
                  >
                    {resolvingEscalationId === row.escalationId ? 'Resolving...' : 'Resolve Escalation'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="border border-[var(--border-subtle)] rounded p-2 bg-[var(--bg-elevated)]">
        <PacketTab />
      </div>
    </div>
  );
}
