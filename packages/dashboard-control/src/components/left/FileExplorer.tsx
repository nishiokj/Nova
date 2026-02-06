import { memo, useCallback, useState } from 'react';
import type { CockpitMarkdownTreeNode, WorkItemTemplate } from '@/lib/api';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { useCockpit } from '@/hooks/use-cockpit-store';
import { serializeFrontmatter } from '@/lib/markdown';

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
  const { state, openFile, openNewFilePicker, createFolder } = workspace;
  const cockpit = useCockpit();
  const { set: setCockpit } = cockpit;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; type: 'file' | 'folder' } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

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

  return (
    <div className="h-full flex flex-col" onClick={closeMenu}>
      <div className="px-2 py-1.5 text-[10px] text-[var(--text-muted)] font-mono truncate border-b border-[var(--border-subtle)]">
        {state.rootDir}
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
            No markdown files. Right-click or Ctrl+N.
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

        {/* Templates section */}
        {templates.length > 0 && (
          <div className="border-t border-[var(--border-subtle)] mt-1">
            <button
              onClick={() => setTemplatesOpen((prev) => !prev)}
              className="w-full text-left px-2 py-1.5 text-[10px] text-[var(--accent-cyan)] font-medium hover:bg-[var(--bg-hover)]"
            >
              <span className="mr-1">{templatesOpen ? '\u25BE' : '\u25B8'}</span>
              Templates ({templates.length})
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
          <button
            onClick={() => { closeMenu(); openNewFilePicker('create'); }}
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
        </div>
      )}
    </div>
  );
}
