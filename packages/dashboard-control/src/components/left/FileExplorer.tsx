import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { postCockpitSessionCreate, type CockpitMarkdownTreeNode, type WorkItemTemplate } from '@/lib/api';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { useCockpit, useCockpitStore } from '@/hooks/use-cockpit-store';
import { gatherMarkdownFolders, serializeFrontmatter } from '@/lib/markdown';
import { FolderSwitcher } from '@/components/shared/FolderSwitcher';

const NEW_SESSION_CUSTOM_PROJECT_VALUE = '__new_session_custom_project__';
const SCRATCH_ROOT = '.cockpit/scratch';

const TreeNode = memo(function TreeNode({
  node,
  depth,
  workspace,
  onFileSelect,
  onContextMenu,
}: {
  node: CockpitMarkdownTreeNode;
  depth: number;
  workspace: MarkdownWorkspace;
  onFileSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, type: 'file' | 'folder') => void;
}) {
  const { state, toggleFolder } = workspace;
  const pad = `${depth * 0.8}rem`;

  if (node.type === 'folder') {
    const isOpen = state.expandedFolders.has(node.path);
    return (
      <div>
        <button
          data-cockpit-tree-node="true"
          onClick={() => toggleFolder(node.path)}
          onContextMenu={(e) => onContextMenu(e, node.path, 'folder')}
          className="w-full text-left px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
          style={{ paddingLeft: `calc(${pad} + 0.5rem)` }}
        >
          <span className="mr-1 text-[var(--text-muted)]">{isOpen ? '\u25BE' : '\u25B8'}</span>
          <span>{node.name}</span>
        </button>
        {isOpen && (node.children ?? []).map((child) => (
          <TreeNode
            key={`${child.type}:${child.path}`}
            node={child}
            depth={depth + 1}
            workspace={workspace}
            onFileSelect={onFileSelect}
            onContextMenu={onContextMenu}
          />
        ))}
      </div>
    );
  }

  const selected = state.selectedPath === node.path;
  return (
    <button
      data-cockpit-tree-node="true"
      onClick={() => onFileSelect(node.path)}
      onContextMenu={(e) => onContextMenu(e, node.path, 'file')}
      className={`w-full text-left px-2 py-1 text-[11px] border-l-2 ${
        selected
          ? 'bg-[var(--accent-cyan)]/15 text-[var(--text-primary)] border-l-[var(--accent-cyan)]'
          : 'text-[var(--text-muted)] border-l-transparent hover:bg-[var(--bg-hover)]'
      }`}
      style={{ paddingLeft: `calc(${pad} + 1.1rem)` }}
      title={node.path}
    >
      <span className="truncate block">{node.name}</span>
    </button>
  );
});

function TemplateItem({ template, onSelect }: { template: WorkItemTemplate; onSelect: (t: WorkItemTemplate) => void }) {
  return (
    <button
      onClick={() => onSelect(template)}
      className="w-full text-left px-2 py-1.5 text-[11px] hover:bg-[var(--bg-hover)] border-l-2 border-l-transparent"
      title={template.description}
    >
      <div className="text-[var(--text-primary)] font-medium">{template.name}</div>
      <div className="text-[var(--text-muted)] text-[10px]">
        {template.description.slice(0, 50)} · {template.specs.length} steps
      </div>
    </button>
  );
}

export function FileExplorer({ workspace }: { workspace: MarkdownWorkspace }) {
  const { state, openFile, openNewFilePicker, createFolder, deletePath, toggleFolder } = workspace;
  const templates = useCockpit(s => s.templates);
  const store = useCockpitStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; type: 'file' | 'folder' } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessionGoal, setNewSessionGoal] = useState('New session');
  const [newSessionProjectId, setNewSessionProjectId] = useState('');
  const [newSessionCustomProjectPath, setNewSessionCustomProjectPath] = useState('');
  const [focusedActionIndex, setFocusedActionIndex] = useState<number | null>(null);
  const allFolders = useMemo(() => gatherMarkdownFolders(state.tree), [state.tree]);

  const isProjectScoped = state.activeRoot !== SCRATCH_ROOT;
  const projectRoots = useMemo(
    () => state.roots.filter((r) => r.kind === 'project'),
    [state.roots],
  );

  const handleExpandAll = useCallback(() => {
    workspace.set({ expandedFolders: new Set(allFolders) });
  }, [workspace, allFolders]);

  const handleCollapseAll = useCallback(() => {
    workspace.set({ expandedFolders: new Set() });
  }, [workspace]);

  const handleFileSelect = useCallback((path: string) => {
    store.set({ focusTarget: null, globalTool: 'none' });
    void openFile(path);
  }, [store, openFile]);

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, type: 'file' | 'folder') => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path, type });
  }, []);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  const handleTemplateSelect = useCallback((template: WorkItemTemplate) => {
    const frontmatter: Record<string, unknown> = {
      type: 'workflow',
      title: `New ${template.name}`,
      template: template.name,
      templateId: template.id,
      specs: template.specs.map((s) => s.id),
    };

    const body = [
      `# New ${template.name}`,
      '',
      `*${template.description}*`,
      '',
      '## Workflow Steps',
      '',
      ...template.specs.map((spec, i) => {
        const deps = spec.dependencies.length ? ` (after: ${spec.dependencies.join(', ')})` : '';
        return `${i + 1}. **${spec.id}** — ${spec.objective} [${spec.agent}]${deps}`;
      }),
      '',
      '## Description',
      '',
      '*Describe what you want to build...*',
    ].join('\n');

    const content = serializeFrontmatter(frontmatter, body);
    store.set({ focusTarget: null, globalTool: 'none' });
    workspace.set({ content, dirty: true, selectedPath: null, status: `Created from template: ${template.name}` });
    openNewFilePicker('save');
  }, [store, workspace, openNewFilePicker]);

  const handleAddProjectRoot = useCallback(() => {
    const entered = window.prompt(
      'Add project workspace folder.\nUse absolute path or path relative to the current cwd.',
      ''
    );
    if (!entered || !entered.trim()) return;
    void workspace.setActiveRoot(entered.trim());
  }, [workspace]);

  const openNewSessionDialog = useCallback(() => {
    const defaultProjectId = projectRoots[0]?.id ?? NEW_SESSION_CUSTOM_PROJECT_VALUE;
    setNewSessionGoal('New session');
    setNewSessionProjectId(defaultProjectId);
    setNewSessionCustomProjectPath(
      isProjectScoped ? state.activeRoot : projectRoots[0]?.path ?? ''
    );
    setNewSessionOpen(true);
  }, [projectRoots, isProjectScoped, state.activeRoot]);

  // Action button definitions for keyboard navigation (defined after openNewSessionDialog)
  const actionButtons = useMemo(() => [
    { id: 'file', label: '+ File', action: () => openNewFilePicker('create'), shortcut: 'Ctrl+N' },
    { id: 'folder', label: '+ Folder', action: () => void createFolder(), shortcut: 'Ctrl+Shift+N' },
    { id: 'session', label: '+ Session', action: openNewSessionDialog, shortcut: 'Ctrl+Shift+S' },
  ], [openNewFilePicker, createFolder, openNewSessionDialog]);

  // Store action button functions for external access (via window for keyboard hook)
  useEffect(() => {
    (window as any).__cockpitFileExplorerActions = {
      triggerNewSession: openNewSessionDialog,
      triggerNewFile: () => openNewFilePicker('create'),
      triggerNewFolder: () => void createFolder(),
    };
    return () => {
      (window as any).__cockpitFileExplorerActions = undefined;
    };
  }, [openNewSessionDialog, openNewFilePicker, createFolder]);

  const selectedSessionProjectPath = useMemo(() => {
    if (newSessionProjectId === NEW_SESSION_CUSTOM_PROJECT_VALUE) {
      return newSessionCustomProjectPath.trim();
    }
    return projectRoots.find((root) => root.id === newSessionProjectId)?.path ?? '';
  }, [newSessionProjectId, newSessionCustomProjectPath, projectRoots]);

  const handleCreateSessionDirect = useCallback(async () => {
    const projectPath = selectedSessionProjectPath.trim();
    if (!projectPath) {
      store.set({ error: 'Pick a project folder before creating a session.' });
      return;
    }
    setCreatingSession(true);
    store.set({ commandStatus: 'Creating session…' });
    try {
      const result = await postCockpitSessionCreate({
        goal: newSessionGoal.trim() || 'New session',
        projectPath,
        createProjectPath: true,
      });
      if (!result.success || !result.sessionKey) {
        store.set({ error: result.error ?? 'Failed creating session' });
        return;
      }
      store.set({
        focusTarget: { type: 'session', id: result.sessionKey },
        eventDrawerOpen: true,
        eventFilter: 'messages',
        inputVisible: true,
        globalTool: 'none',
        commandStatus: `Session ${result.sessionKey} created`,
      });
      setNewSessionOpen(false);
      window.requestAnimationFrame(() => {
        const input = document.querySelector<HTMLTextAreaElement>('[data-cockpit-chat-input="true"]');
        if (input) {
          input.focus();
          return;
        }
        const centerPane = document.querySelector<HTMLElement>('[data-cockpit-pane="center"]');
        centerPane?.focus({ preventScroll: true });
      });
      await store.refreshRollups();
      await workspace.setActiveRoot(projectPath);
    } catch (err) {
      store.set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setCreatingSession(false);
    }
  }, [selectedSessionProjectPath, store, newSessionGoal, workspace]);

  // Handle keyboard navigation for action buttons when left pane is focused
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const leftPane = document.querySelector<HTMLElement>('[data-cockpit-pane="left"]');
      const activeElement = document.activeElement;
      const isInLeftPane = leftPane?.contains(activeElement);
      const isContentEditable = activeElement instanceof HTMLElement && activeElement.isContentEditable;
      const isActionButton = activeElement instanceof HTMLElement
        && activeElement.dataset.cockpitActionButton === 'true';
      const isTreeButton = activeElement instanceof HTMLElement
        && activeElement.dataset.cockpitTreeNode === 'true';

      // Only handle when left pane is focused or contains focus
      if (!isInLeftPane) return;

      // Don't handle if typing in an input/textarea
      if (
        activeElement instanceof HTMLInputElement
        || activeElement instanceof HTMLTextAreaElement
        || activeElement instanceof HTMLSelectElement
        || (activeElement instanceof HTMLButtonElement && !isActionButton && !isTreeButton)
        || activeElement instanceof HTMLAnchorElement
        || isContentEditable
      ) {
        return;
      }

      // Escape - clear focus
      if (event.key === 'Escape') {
        event.preventDefault();
        setFocusedActionIndex(null);
        leftPane?.focus();
        return;
      }

      const isDownKey = event.key === 'ArrowDown' || event.key === 'j' || event.key === 'J';
      const isUpKey = event.key === 'ArrowUp' || event.key === 'k' || event.key === 'K';

      // Unified left-pane navigation: action buttons + tree nodes share one vertical flow.
      if ((isDownKey || isUpKey) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (activeElement !== leftPane && !isActionButton && !isTreeButton) return;
        const actionButtonNodes = leftPane
          ? Array.from(leftPane.querySelectorAll<HTMLButtonElement>('[data-cockpit-action-button="true"]'))
          : [];
        const treeButtonNodes = leftPane
          ? Array.from(leftPane.querySelectorAll<HTMLButtonElement>('[data-cockpit-tree-node="true"]'))
          : [];
        const navNodes = [...actionButtonNodes, ...treeButtonNodes];
        if (navNodes.length === 0) return;

        event.preventDefault();
        const step = isDownKey ? 1 : -1;
        const activeNode = activeElement instanceof HTMLButtonElement ? activeElement : null;
        const currentIndex = activeNode
          ? navNodes.indexOf(activeNode)
          : (step > 0 ? -1 : navNodes.length);
        const nextIndex = Math.max(0, Math.min(currentIndex + step, navNodes.length - 1));
        const nextNode = navNodes[nextIndex];
        if (!nextNode) return;

        nextNode.focus();
        const nextActionIndex = actionButtonNodes.indexOf(nextNode);
        setFocusedActionIndex(nextActionIndex >= 0 ? nextActionIndex : null);
        return;
      }

      // Enter - trigger focused action button
      if (event.key === 'Enter' && isActionButton && activeElement instanceof HTMLButtonElement) {
        event.preventDefault();
        activeElement.click();
        return;
      }

      if (event.key === 'Enter' && focusedActionIndex !== null && activeElement === leftPane) {
        event.preventDefault();
        actionButtons[focusedActionIndex].action();
        return;
      }

      // Enter on focused tree item should activate it.
      if (event.key === 'Enter' && isTreeButton && activeElement instanceof HTMLButtonElement) {
        event.preventDefault();
        activeElement.click();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusedActionIndex, actionButtons]);

  // Reset focused action index when pane loses focus
  useEffect(() => {
    const handleBlur = () => {
      setFocusedActionIndex(null);
    };

    const leftPane = document.querySelector('[data-cockpit-pane="left"]');
    leftPane?.addEventListener('blur', handleBlur, true);
    return () => {
      leftPane?.removeEventListener('blur', handleBlur, true);
    };
  }, []);

  return (
    <div className="h-full flex flex-col" onClick={closeMenu}>
      <div className="px-2 py-1.5 border-b border-[var(--border-subtle)] space-y-1">
        <FolderSwitcher
          roots={state.roots}
          activeRoot={state.activeRoot}
          onSelectRoot={(rootPath) => { void workspace.setActiveRoot(rootPath); }}
          onAddProjectPath={handleAddProjectRoot}
        />
      </div>
      <div className="px-2 py-1 border-b border-[var(--border-subtle)] flex items-center gap-1">
        {actionButtons.map((btn, idx) => (
          <button
            key={btn.id}
            data-cockpit-action-button="true"
            onClick={btn.action}
            onMouseEnter={() => setFocusedActionIndex(idx)}
            onFocus={() => setFocusedActionIndex(idx)}
            onMouseLeave={() => setFocusedActionIndex(null)}
            onBlur={() => setFocusedActionIndex(null)}
            title={`${btn.label} (${btn.shortcut})`}
            className={`px-1.5 py-0.5 text-[10px] rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] relative group ${
              focusedActionIndex === idx ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]' : ''
            }`}
          >
            {btn.label}
            {/* Hover hint tooltip */}
            <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 hidden group-hover:block z-50">
              <div className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[10px] text-[var(--text-muted)] whitespace-nowrap shadow-lg">
                <kbd className="font-mono">{btn.shortcut}</kbd>
              </div>
            </div>
          </button>
        ))}
        <span className="flex-1" />
        <button
          onClick={handleExpandAll}
          className="px-1 py-0.5 text-[10px] rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          title="Expand All"
        >{'\u25BC'}</button>
        <button
          onClick={handleCollapseAll}
          className="px-1 py-0.5 text-[10px] rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          title="Collapse All"
        >{'\u25B6'}</button>
      </div>
      <div
        className="flex-1 overflow-y-auto"
        onClick={() => setFocusedActionIndex(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, path: '', type: 'folder' });
        }}
      >
        {state.tree.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-[var(--text-muted)]">
            No markdown files in this workspace yet. Right-click or press Ctrl+N.
          </div>
        ) : (
          state.tree.map((node) => (
            <TreeNode
              key={`${node.type}:${node.path}`}
              node={node}
              depth={0}
              workspace={workspace}
              onFileSelect={handleFileSelect}
              onContextMenu={handleContextMenu}
            />
          ))
        )}

        {/* Workflows section */}
        {templates.length > 0 && (
          <div className="border-t border-[var(--border-subtle)] mt-1">
            <button
              onClick={() => setTemplatesOpen((prev) => !prev)}
              className="w-full text-left px-2 py-1.5 text-[10px] text-[var(--accent-cyan)] font-medium hover:bg-[var(--bg-hover)]"
            >
              <span className="mr-1">{templatesOpen ? '\u25BE' : '\u25B8'}</span>
              Workflows ({templates.length})
            </button>
            {templatesOpen && templates.map((t) => (
              <TemplateItem key={t.id} template={t} onSelect={handleTemplateSelect} />
            ))}
          </div>
        )}
      </div>

      {newSessionOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
          onClick={() => {
            if (!creatingSession) setNewSessionOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative w-[28rem] max-w-[92vw] rounded border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="px-3 py-2 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">
              Create Session
            </div>
            <div className="p-3 space-y-2">
              <div>
                <label className="block text-[10px] text-[var(--text-muted)] mb-1">Goal</label>
                <input
                  autoFocus
                  value={newSessionGoal}
                  onChange={(event) => setNewSessionGoal(event.target.value)}
                  onFocus={(event) => event.target.select()}
                  placeholder="New session"
                  className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
                />
              </div>
              <div>
                <label className="block text-[10px] text-[var(--text-muted)] mb-1">Project Folder</label>
                <select
                  value={newSessionProjectId}
                  onChange={(event) => setNewSessionProjectId(event.target.value)}
                  className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
                >
                  {projectRoots.map((root) => (
                    <option key={root.id} value={root.id}>{root.path}</option>
                  ))}
                  <option value={NEW_SESSION_CUSTOM_PROJECT_VALUE}>Custom path...</option>
                </select>
              </div>
              {newSessionProjectId === NEW_SESSION_CUSTOM_PROJECT_VALUE && (
                <div>
                  <label className="block text-[10px] text-[var(--text-muted)] mb-1">Custom Project Path</label>
                  <input
                    value={newSessionCustomProjectPath}
                    onChange={(event) => setNewSessionCustomProjectPath(event.target.value)}
                    placeholder="/absolute/or/relative/path"
                    className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)] font-mono"
                  />
                </div>
              )}
              <div className="text-[10px] text-[var(--text-muted)] font-mono truncate" title={selectedSessionProjectPath}>
                target: {selectedSessionProjectPath || '(select project folder)'}
              </div>
            </div>
            <div className="px-3 py-2 border-t border-[var(--border-subtle)] flex items-center justify-end gap-2">
              <button
                onClick={() => setNewSessionOpen(false)}
                disabled={creatingSession}
                className="px-2 py-1 text-[11px] rounded border border-[var(--border-subtle)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleCreateSessionDirect()}
                disabled={creatingSession || !selectedSessionProjectPath.trim()}
                className="px-2 py-1 text-[11px] rounded bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/30 disabled:opacity-60"
              >
                {creatingSession ? 'Creating...' : 'Create Session'}
              </button>
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed z-50 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded shadow-lg py-1 text-[11px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'folder' && contextMenu.path && (
            <button
              onClick={() => { toggleFolder(contextMenu.path); closeMenu(); }}
              className="w-full text-left px-3 py-1 hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
            >
              {state.expandedFolders.has(contextMenu.path) ? 'Collapse Folder' : 'Expand Folder'}
            </button>
          )}
          <button
            onClick={() => {
              const defaultFolder = contextMenu.path
                ? (
                  contextMenu.type === 'folder'
                    ? contextMenu.path
                    : (contextMenu.path.includes('/') ? contextMenu.path.slice(0, contextMenu.path.lastIndexOf('/')) : '')
                )
                : '';
              closeMenu();
              openNewFilePicker('create', defaultFolder);
            }}
            className="w-full text-left px-3 py-1 hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
          >
            New File
          </button>
          <button
            onClick={() => { closeMenu(); void createFolder(); }}
            className="w-full text-left px-3 py-1 hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
          >
            New Folder
          </button>
          {contextMenu.path && (
            <button
              onClick={() => {
                const isFolder = contextMenu.type === 'folder';
                const confirmed = window.confirm(
                  isFolder
                    ? `Delete folder "${contextMenu.path}" and all contents? This cannot be undone.`
                    : `Delete file "${contextMenu.path}"? This cannot be undone.`
                );
                if (!confirmed) return;
                closeMenu();
                void deletePath(
                  contextMenu.path,
                  contextMenu.type,
                  isFolder ? { recursive: true } : undefined
                );
              }}
              className="w-full text-left px-3 py-1 hover:bg-[var(--bg-hover)] text-[var(--error)]"
            >
              {contextMenu.type === 'folder' ? 'Delete Folder' : 'Delete File'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
