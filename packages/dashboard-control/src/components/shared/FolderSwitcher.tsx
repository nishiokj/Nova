import { useMemo, type ChangeEvent } from 'react';
import type { WorkspaceRoot } from '@/hooks/use-markdown-workspace';

const ADD_PROJECT_VALUE = '__add_project__';
const SCRATCH_ROOT = '.cockpit/scratch';

interface FolderSwitcherProps {
  roots: WorkspaceRoot[];
  activeRoot: string;
  onSelectRoot: (rootPath: string) => void;
  onAddProjectPath: () => void;
}

export function FolderSwitcher({
  roots,
  activeRoot,
  onSelectRoot,
  onAddProjectPath,
}: FolderSwitcherProps) {
  const value = useMemo(() => {
    const match = roots.find((root) => root.path === activeRoot);
    return match?.id ?? SCRATCH_ROOT;
  }, [roots, activeRoot]);

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const selectedValue = event.target.value;
    if (selectedValue === ADD_PROJECT_VALUE) {
      onAddProjectPath();
      return;
    }
    const selectedRoot = roots.find((root) => root.id === selectedValue);
    if (selectedRoot) {
      onSelectRoot(selectedRoot.path);
    }
  };

  return (
    <div className="space-y-0.5">
      <label className="block text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
        Folder
      </label>
      <select
        value={value}
        onChange={handleChange}
        className="w-full bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-1.5 py-1 text-[10px] text-[var(--text-secondary)]"
        aria-label="Workspace folder"
      >
        {roots.map((root) => (
          <option key={root.id} value={root.id}>
            {root.kind === 'scratch' ? 'Scratch' : root.label || root.path}
          </option>
        ))}
        <option value={ADD_PROJECT_VALUE}>+ Add project path…</option>
      </select>
    </div>
  );
}
