import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { gatherMarkdownFolders, normalizeWorkspacePathForClient } from '@/lib/markdown';

const ADD_PROJECT_VALUE = '__add_project__';
const SCRATCH_ROOT = '.cockpit/scratch';

interface FolderOption {
  path: string;
  label: string;
  depth: number;
  exists: boolean;
}

function buildFolderOptions(workspace: MarkdownWorkspace): FolderOption[] {
  const { state } = workspace;
  const optionsByPath = new Map<string, FolderOption>();

  const walk = (nodes: typeof state.tree, depth: number) => {
    for (const node of nodes) {
      if (node.type !== 'folder') continue;
      optionsByPath.set(node.path, {
        path: node.path,
        label: node.path,
        depth,
        exists: true,
      });
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(state.tree, 0);

  // Root of current markdown workspace.
  optionsByPath.set('', {
    path: '',
    label: '(workspace root)',
    depth: 0,
    exists: true,
  });

  return Array.from(optionsByPath.values()).sort((a, b) => {
    if (a.path === '') return -1;
    if (b.path === '') return 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path);
  });
}

export function NewFileDropdown({ workspace }: { workspace: MarkdownWorkspace }) {
  const ref = useRef<HTMLDivElement>(null);
  const rootSelectRef = useRef<HTMLSelectElement>(null);
  const filenameRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [filename, setFilename] = useState('untitled.md');
  const [folderPath, setFolderPath] = useState('');
  const intent = workspace.state.newFileIntent ?? 'create';
  const options = useMemo(
    () => buildFolderOptions(workspace),
    [workspace.state.tree],
  );
  const safeIndex = Math.min(Math.max(activeIndex, 0), Math.max(options.length - 1, 0));
  const folderInputListId = 'new-file-folder-options';
  const rootLabel = workspace.state.activeRoot === SCRATCH_ROOT ? 'scratch' : 'project';

  // Root selector value
  const rootSelectValue = useMemo(() => {
    const match = workspace.state.roots.find((r) => r.path === workspace.state.activeRoot);
    return match?.id ?? SCRATCH_ROOT;
  }, [workspace.state.roots, workspace.state.activeRoot]);

  useEffect(() => {
    setFilename('untitled.md');
    const defaultFolder = workspace.state.newFileDefaultFolder;
    const initialFolder = typeof defaultFolder === 'string' ? defaultFolder : '';
    setFolderPath(initialFolder);
    const idx = options.findIndex((opt) => opt.path === initialFolder);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [workspace.state.newFileDropdownOpen, intent]);

  useLayoutEffect(() => {
    if (!workspace.state.newFileDropdownOpen) return;
    let cancelled = false;
    let rafId = 0;
    let attempts = 0;
    const focusInput = () => {
      const rootSelect = rootSelectRef.current;
      if (!rootSelect) return false;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== rootSelect) {
        active.blur();
      }
      rootSelect.focus({ preventScroll: true });
      return document.activeElement === rootSelect;
    };

    const keepFocusing = () => {
      if (cancelled) return;
      if (focusInput()) return;
      attempts += 1;
      if (attempts < 10) {
        rafId = window.requestAnimationFrame(keepFocusing);
      }
    };

    rafId = window.requestAnimationFrame(keepFocusing);
    return () => {
      cancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
    };
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

  const submit = (pathOverride?: string) => {
    const resolvedFolderInput = typeof pathOverride === 'string' ? pathOverride : folderPath;
    const normalizedFolder = normalizeWorkspacePathForClient(resolvedFolderInput, true);
    if (normalizedFolder === null) {
      workspace.set({ status: 'Invalid folder path' });
      return;
    }
    void workspace.createFileInFolder(normalizedFolder, { filename });
  };

  const getFocusableElements = (): HTMLElement[] => {
    const container = ref.current;
    if (!container) return [];
    const elements = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    return elements.filter((element) => {
      if (!element.isConnected) return false;
      if (element.getAttribute('aria-hidden') === 'true') return false;
      return true;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // Stop all keyboard events in the dropdown from propagating to global handler
    event.stopPropagation();
    const target = event.target as EventTarget | null;
    const targetIsSelect = target instanceof HTMLSelectElement;
    const targetIsButton = target instanceof HTMLButtonElement;

    if (event.key === 'Escape') {
      event.preventDefault();
      workspace.closeNewFilePicker();
      return;
    }

    if (event.key === 'Tab') {
      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const currentIndex = active ? focusableElements.indexOf(active) : -1;
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex = currentIndex === -1
        ? (event.shiftKey ? focusableElements.length - 1 : 0)
        : (currentIndex + direction + focusableElements.length) % focusableElements.length;
      const next = focusableElements[nextIndex];
      if (!next) return;
      event.preventDefault();
      next.focus({ preventScroll: true });
      if (next === filenameRef.current || next === folderRef.current) {
        (next as HTMLInputElement).select();
      }
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      folderRef.current?.focus();
      folderRef.current?.select();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      filenameRef.current?.focus();
      filenameRef.current?.select();
      return;
    }

    // Alt+Up / Alt+Down quickly selects folder candidates without leaving text inputs.
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.altKey && !targetIsSelect) {
      event.preventDefault();
      if (options.length === 0) return;
      setActiveIndex((prev) => {
        const next = event.key === 'ArrowDown'
          ? (prev + 1) % options.length
          : (prev - 1 + options.length) % options.length;
        const option = options[next];
        if (option) setFolderPath(option.path);
        return next;
      });
      return;
    }

    if (event.key === 'Enter') {
      if (targetIsSelect || targetIsButton) {
        return;
      }
      event.preventDefault();
      submit();
      return;
    }
  };

  return (
    <div
      ref={ref}
      data-new-file-dropdown="true"
      className="absolute top-2 left-1/2 -translate-x-1/2 z-50 w-80 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded shadow-lg overflow-hidden"
      onKeyDown={handleKeyDown}
    >
      <div className="px-2.5 py-1.5 text-[10px] text-[var(--text-muted)] border-b border-[var(--border-subtle)]">
        <div>{intent === 'save' ? 'Save markdown in...' : 'New markdown in...'}</div>
        <div className="mt-1">
          <select
            ref={rootSelectRef}
            data-new-file-root-select="true"
            value={rootSelectValue}
            onChange={(event) => {
              event.stopPropagation();
              if (event.target.value === ADD_PROJECT_VALUE) {
                const entered = window.prompt(
                  'Add project workspace folder.\nUse absolute path or path relative to the current cwd.',
                  ''
                );
                if (!entered || !entered.trim()) return;
                void workspace.setActiveRoot(entered.trim());
                return;
              }
              const selected = workspace.state.roots.find((r) => r.id === event.target.value);
              if (!selected) return;
              setFolderPath('');
              setActiveIndex(0);
              void workspace.setActiveRoot(selected.path);
            }}
            className="w-full bg-[var(--bg-surface)] border border-[var(--border-default)] rounded px-1.5 py-1 text-[10px] text-[var(--text-secondary)]"
          >
            {workspace.state.roots.map((root) => (
              <option key={root.id} value={root.id}>
                {root.kind === 'scratch' ? 'Scratch' : root.label || root.path}
              </option>
            ))}
            <option value={ADD_PROJECT_VALUE}>+ Add project path…</option>
          </select>
        </div>
        <div className="font-mono truncate" title={workspace.state.activeRoot}>
          {rootLabel} root: {workspace.state.activeRoot}
        </div>
      </div>
      <div className="px-2.5 py-2 border-b border-[var(--border-subtle)]">
        <label className="block text-[10px] text-[var(--text-muted)] mb-1">
          Filename
        </label>
        <input
          ref={filenameRef}
          data-new-file-filename-input="true"
          value={filename}
          onChange={(event) => {
            setFilename(event.target.value);
          }}
          className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
          spellCheck={false}
          placeholder="untitled.md"
        />
      </div>
      <div className="px-2.5 py-2 border-b border-[var(--border-subtle)]">
        <label className="block text-[10px] text-[var(--text-muted)] mb-1">
          Folder (relative to workspace root)
        </label>
        <input
          ref={folderRef}
          value={folderPath}
          onChange={(event) => {
            const next = event.target.value;
            setFolderPath(next);
            const normalized = normalizeWorkspacePathForClient(next, true);
            if (normalized === null) return;
            const idx = options.findIndex((opt) => opt.path === normalized);
            if (idx >= 0) setActiveIndex(idx);
          }}
          list={folderInputListId}
          className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
          spellCheck={false}
          placeholder=".cockpit root"
        />
        <datalist id={folderInputListId}>
          {options.map((opt) => (
            <option key={opt.path || '__root'} value={opt.path} />
          ))}
        </datalist>
      </div>
      <div className="max-h-48 overflow-y-auto py-0.5" tabIndex={-1}>
        {options.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">No folders available. Create one with Ctrl+Shift+N.</div>
        ) : (
          options.map((opt, index) => (
            <button
              key={opt.path || '__root'}
              ref={(node) => { optionRefs.current[index] = node; }}
              onMouseEnter={() => {
                setActiveIndex(index);
              }}
              onClick={() => {
                setFolderPath(opt.path);
                submit(opt.path);
              }}
              onFocus={() => {
                setActiveIndex(index);
                setFolderPath(opt.path);
              }}
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
        Enter save · Tab cycle popup · Ctrl/Cmd+L folder · Ctrl/Cmd+N name · Alt+↑/↓ folders · Esc cancel
      </div>
    </div>
  );
}
