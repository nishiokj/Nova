import { useMemo, useState } from 'react';
import { useCockpit } from '@/hooks/use-cockpit-store';

export function CommitList() {
  const { state, handleSelectCommit } = useCockpit();
  const [collapsed, setCollapsed] = useState(true);

  const uniqueCommits = useMemo(() => {
    const seen = new Set<string>();
    return state.commitRollups.filter((row) => {
      if (seen.has(row.sha)) return false;
      seen.add(row.sha);
      return true;
    });
  }, [state.commitRollups]);

  if (uniqueCommits.length === 0) return null;

  return (
    <div className="border-t border-[var(--border-subtle)]">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full text-left px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
      >
        {collapsed ? '\u25B8' : '\u25BE'} Commits ({uniqueCommits.length})
      </button>
      {!collapsed && uniqueCommits.map((row) => (
        <button
          key={row.sha}
          onClick={() => handleSelectCommit(row)}
          className="w-full text-left px-2 py-1.5 border-b border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
        >
          <div className="font-mono text-[11px] text-[var(--text-secondary)]">{row.sha.slice(0, 8)}</div>
          <div className="text-xs text-[var(--text-primary)] truncate">{row.message}</div>
          <div className="text-[10px] text-[var(--text-muted)]">
            {row.author} · +{row.diffstat.added}/-{row.diffstat.deleted}
          </div>
        </button>
      ))}
    </div>
  );
}
