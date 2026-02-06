import { useState } from 'react';
import { useCockpit } from '@/hooks/use-cockpit-store';

export function PRList() {
  const { state, handleSelectPR } = useCockpit();
  const [collapsed, setCollapsed] = useState(true);

  if (state.prRollups.length === 0) return null;

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full text-left px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
      >
        {collapsed ? '\u25B8' : '\u25BE'} PRs ({state.prRollups.length})
      </button>
      {!collapsed && state.prRollups.map((row) => (
        <button
          key={row.prId}
          onClick={() => handleSelectPR(row)}
          className="w-full text-left px-2 py-1.5 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
        >
          <div className="text-[11px] text-[var(--text-muted)]">#{row.number} · {row.status}</div>
          <div className="text-xs text-[var(--text-primary)] truncate">{row.title}</div>
          <div className="text-[10px] text-[var(--text-muted)]">{row.author}</div>
        </button>
      ))}
    </div>
  );
}
