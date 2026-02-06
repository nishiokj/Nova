import { useEffect, useMemo, useRef, useState } from 'react';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { gatherMarkdownFolders } from '@/lib/markdown';

interface FolderOption {
  path: string;
  label: string;
  depth: number;
  exists: boolean;
}

function buildFolderOptions(workspace: MarkdownWorkspace): FolderOption[] {
  const { state } = workspace;
  const existingFolders = new Set(gatherMarkdownFolders(state.tree));
  const options: FolderOption[] = [];

  const walk = (nodes: typeof state.tree, depth: number) => {
    for (const node of nodes) {
      if (node.type !== 'folder') continue;
      options.push({ path: node.path, label: node.name, depth, exists: true });
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(state.tree, 0);

  for (const suggested of state.suggestedFolders) {
    if (!existingFolders.has(suggested)) {
      options.push({ path: suggested, label: suggested, depth: 0, exists: false });
    }
  }

  return options;
}

export function NewFileDropdown({ workspace }: { workspace: MarkdownWorkspace }) {
  const ref = useRef<HTMLDivElement>(null);
  const filenameRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [filename, setFilename] = useState('untitled.md');
  const intent = workspace.state.newFileIntent ?? 'create';
  const options = useMemo(
    () => buildFolderOptions(workspace),
    [workspace.state.tree, workspace.state.suggestedFolders],
  );
  const safeIndex = Math.min(Math.max(activeIndex, 0), Math.max(options.length - 1, 0));

  useEffect(() => {
    setActiveIndex(0);
    setFilename('untitled.md');
    requestAnimationFrame(() => {
      filenameRef.current?.focus();
      filenameRef.current?.select();
    });
  }, [workspace.state.newFileDropdownOpen, intent]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        workspace.closeNewFilePicker();
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [workspace]);

  useEffect(() => {
    const target = optionRefs.current[safeIndex];
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [safeIndex]);

  const submit = (path?: string) => {
    if (path) {
      void workspace.createFileInFolder(path, { filename });
      return;
    }
    if (options.length === 0) return;
    const option = options[safeIndex];
    if (!option) return;
    void workspace.createFileInFolder(option.path, { filename });
  };

  return (
    <div
      ref={ref}
      className="absolute top-2 left-1/2 -translate-x-1/2 z-50 w-80 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded shadow-lg overflow-hidden"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          workspace.closeNewFilePicker();
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (options.length === 0) return;
          setActiveIndex((prev) => (prev + 1) % options.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (options.length === 0) return;
          setActiveIndex((prev) => (prev - 1 + options.length) % options.length);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className="px-2.5 py-1.5 text-[10px] text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
        {intent === 'save' ? 'Save markdown in...' : 'New markdown in...'}
      </div>
      <div className="px-2.5 py-2 border-b border-[var(--border-subtle)]">
        <label className="block text-[10px] text-[var(--text-muted)] mb-1">
          Filename
        </label>
        <input
          ref={filenameRef}
          value={filename}
          onChange={(event) => setFilename(event.target.value)}
          className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
          spellCheck={false}
          placeholder="untitled.md"
        />
      </div>
      <div className="max-h-48 overflow-y-auto py-0.5">
        {options.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">No folders available</div>
        ) : (
          options.map((opt, index) => (
            <button
              key={opt.path}
              ref={(node) => { optionRefs.current[index] = node; }}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => submit(opt.path)}
              className={`w-full text-left px-3 py-1 text-[11px] text-[var(--text-primary)] flex items-center gap-1 ${
                index === safeIndex ? 'bg-[var(--accent-cyan)]/20' : 'hover:bg-[var(--bg-hover)]'
              }`}
              style={{ paddingLeft: `${opt.depth * 0.75 + 0.75}rem` }}
            >
              <span className="text-[var(--text-muted)]">{index === safeIndex ? '\u25B6' : (opt.depth > 0 ? '\u2514' : '\u25B8')}</span>
              <span>{opt.label}/</span>
              {!opt.exists && <span className="text-[var(--text-muted)] text-[9px]">(new)</span>}
            </button>
          ))
        )}
      </div>
      <div className="px-2.5 py-1 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
        {'\u2191/\u2193'} select folder · Enter confirm · Esc cancel
      </div>
    </div>
  );
}
