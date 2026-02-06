import { memo, useCallback, useMemo, useState } from 'react';
import type { CockpitMarkdownTreeNode, WorkItemTemplate } from '@/lib/api';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { useCockpit } from '@/hooks/use-cockpit-store';
import { gatherMarkdownFolders, serializeFrontmatter } from '@/lib/markdown';

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
  const cockpit = useCockpit();
  const { set: setCockpit } = cockpit;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; type: 'file' | 'folder' } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const allFolders = useMemo(() => gatherMarkdownFolders(state.tree), [state.tree]);

  const handleExpandAll = useCallback(() => {
    workspace.set({ expandedFolders: new Set(allFolders) });
  }, [workspace, allFolders]);

  const handleCollapseAll = useCallback(() => {
    workspace.set({ expandedFolders: new Set() });
  }, [workspace]);

  const handleFileSelect = useCallback((path: string) => {
    setCockpit({ focusTarget: null, globalTool: 'none' });
    void openFile(path);
  }, [setCockpit, openFile]);

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
    setCockpit({ focusTarget: null, globalTool: 'none' });
    workspace.set({ content, dirty: true, selectedPath: null, status: `Created from template: ${template.name}` });
    openNewFilePicker('save');
  }, [setCockpit, workspace, openNewFilePicker]);

  const templates = cockpit.state.templates;
  const NEW_PROJECT_SCOPE_VALUE = '__new_project_scope__';
  const scopeOptions = useMemo(() => {
    const base = state.filesystemRoots.length > 0
      ? [...state.filesystemRoots]
      : [{
        id: 'notes:fallback',
        kind: 'notes' as const,
        label: '.cockpit/markdown',
        path: state.rootDir,
        pinned: true,
        source: 'daemon' as const,
      }];
    if (
      state.scopeMode === 'project'
      && state.scopeProjectPath
      && !base.some((root) => root.kind === 'project' && root.path === state.scopeProjectPath)
    ) {
      base.push({
        id: `project:custom:${state.scopeProjectPath}`,
        kind: 'project',
        label: state.scopeProjectPath.split('/').filter(Boolean).pop() || state.scopeProjectPath,
        path: state.scopeProjectPath,
        pinned: false,
        source: 'discovered',
      });
    }
    return base;
  }, [state.filesystemRoots, state.rootDir, state.scopeMode, state.scopeProjectPath]);
  const selectedScopeId = useMemo(() => {
    if (state.scopeMode === 'project' && state.scopeProjectPath) {
      const matched = scopeOptions.find((root) => root.kind === 'project' && root.path === state.scopeProjectPath);
      if (matched) return matched.id;
    }
    return scopeOptions.find((root) => root.kind === 'notes')?.id ?? scopeOptions[0]?.id ?? '';
  }, [scopeOptions, state.scopeMode, state.scopeProjectPath]);

  return (
    <div className="h-full flex flex-col" onClick={closeMenu}>
      <div className="px-2 py-1.5 border-b border-[var(--border-subtle)] space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Workspace</div>
        <select
          value={selectedScopeId}
          onChange={(event) => {
            if (event.target.value === NEW_PROJECT_SCOPE_VALUE) {
              const entered = window.prompt(
                'Add project workspace folder.\nUse absolute path or path relative to the current cwd.',
                state.filesystemCwd ?? ''
              );
              if (!entered || !entered.trim()) return;
              void workspace.setScope({ mode: 'project', projectPath: entered.trim() });
              return;
            }
            const selected = scopeOptions.find((root) => root.id === event.target.value);
            if (!selected) return;
            if (selected.kind === 'notes') {
              void workspace.setScope({ mode: 'global' });
              return;
            }
            void workspace.setScope({ mode: 'project', projectPath: selected.path });
          }}
          className="w-full bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-1.5 py-1 text-[10px] text-[var(--text-secondary)]"
        >
          {scopeOptions.map((root) => (
            <option key={root.id} value={root.id}>
              {root.kind === 'notes' ? 'Notes (Pinned)' : `Project: ${root.label}`}
            </option>
          ))}
          <option value={NEW_PROJECT_SCOPE_VALUE}>+ Add project path…</option>
        </select>
        <div className="text-[10px] text-[var(--text-muted)] font-mono truncate" title={state.rootDir}>
          root: {state.rootDir}
        </div>
      </div>
      <div className="px-2 py-1 border-b border-[var(--border-subtle)] flex items-center gap-1">
        <button
          onClick={() => openNewFilePicker('create')}
          className="px-1.5 py-0.5 text-[10px] rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          title="New File (Ctrl+N)"
        >+ File</button>
        <button
          onClick={() => void createFolder()}
          className="px-1.5 py-0.5 text-[10px] rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          title="New Folder (Ctrl+Shift+N)"
        >+ Folder</button>
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
