import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  const existingFolders = gatherMarkdownFolders(state.tree);
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

  const existingFolderSet = new Set(existingFolders);
  for (const suggested of state.suggestedFolders) {
    if (!existingFolderSet.has(suggested)) {
      optionsByPath.set(suggested, {
        path: suggested,
        label: suggested,
        depth: 0,
        exists: false,
      });
    }
  }

  return Array.from(optionsByPath.values()).sort((a, b) => {
    if (a.path === '') return -1;
    if (b.path === '') return 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path);
  });
}

export function NewFileDropdown({ workspace }: { workspace: MarkdownWorkspace }) {
  const ref = useRef<HTMLDivElement>(null);
  const filenameRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [filename, setFilename] = useState('untitled.md');
  const [isNavigatingFolders, setIsNavigatingFolders] = useState(false);
  const intent = workspace.state.newFileIntent ?? 'create';
  const options = useMemo(
    () => buildFolderOptions(workspace),
    [workspace.state.tree, workspace.state.suggestedFolders],
  );
  const safeIndex = Math.min(Math.max(activeIndex, 0), Math.max(options.length - 1, 0));
  const scopeLabel = workspace.state.scopeMode === 'project'
    ? 'project'
    : workspace.state.scopeMode === 'session'
      ? 'session'
      : 'notes';

  useEffect(() => {
    setFilename('untitled.md');
    setIsNavigatingFolders(false);
  }, [workspace.state.newFileDropdownOpen, intent]);

  useEffect(() => {
    const defaultFolder = workspace.state.newFileDefaultFolder;
    if (typeof defaultFolder !== 'string') {
      setActiveIndex(0);
      return;
    }
    const idx = options.findIndex((opt) => opt.path === defaultFolder);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [workspace.state.newFileDefaultFolder, options]);

  useLayoutEffect(() => {
    if (!workspace.state.newFileDropdownOpen) return;
    let cancelled = false;
    let rafId = 0;
    let attempts = 0;
    const focusInput = () => {
      const input = filenameRef.current;
      if (!input) return false;
      input.focus();
      input.select();
      return document.activeElement === input;
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
    if (target && isNavigatingFolders) {
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [safeIndex, isNavigatingFolders]);

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

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // Stop all keyboard events in the dropdown from propagating to global handler
    event.stopPropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      workspace.closeNewFilePicker();
      return;
    }

    // Tab to switch between filename input and folder list
    if (event.key === 'Tab') {
      event.preventDefault();
      setIsNavigatingFolders(!isNavigatingFolders);
      if (!isNavigatingFolders) {
        // Moving to folder list - focus first option
        requestAnimationFrame(() => {
          optionRefs.current[0]?.focus();
        });
      } else {
        // Moving back to filename input
        requestAnimationFrame(() => {
          filenameRef.current?.focus();
          filenameRef.current?.select();
        });
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (options.length === 0) return;
      if (!isNavigatingFolders) {
        setIsNavigatingFolders(true);
      }
      setActiveIndex((prev) => (prev + 1) % options.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      if (!isNavigatingFolders) {
        setIsNavigatingFolders(true);
      }
      setActiveIndex((prev) => (prev - 1 + options.length) % options.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }

    // When typing in filename input, keep focus there
    if (document.activeElement === filenameRef.current) {
      setIsNavigatingFolders(false);
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
        <div className="font-mono truncate" title={workspace.state.rootDir}>
          {scopeLabel} root: {workspace.state.rootDir}
        </div>
      </div>
      <div className="px-2.5 py-2 border-b border-[var(--border-subtle)]">
        <label className="block text-[10px] text-[var(--text-muted)] mb-1">
          Filename
        </label>
        <input
          ref={filenameRef}
          autoFocus
          value={filename}
          onChange={(event) => {
            setFilename(event.target.value);
            setIsNavigatingFolders(false);
          }}
          onFocus={() => setIsNavigatingFolders(false)}
          className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
          spellCheck={false}
          placeholder="untitled.md"
        />
      </div>
      <div className="max-h-48 overflow-y-auto py-0.5" tabIndex={-1}>
        {options.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">No folders available. Create one with Ctrl+Shift+N.</div>
        ) : (
          options.map((opt, index) => (
            <button
              key={opt.path}
              ref={(node) => { optionRefs.current[index] = node; }}
              onMouseEnter={() => {
                setActiveIndex(index);
                setIsNavigatingFolders(true);
              }}
              onClick={() => submit(opt.path)}
              onFocus={() => {
                setActiveIndex(index);
                setIsNavigatingFolders(true);
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
        {'\u2191/\u2193'} select · Tab toggle · Enter confirm · Esc cancel
      </div>
    </div>
  );
}
