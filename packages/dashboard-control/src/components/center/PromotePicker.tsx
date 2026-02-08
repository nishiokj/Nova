import { useEffect, useRef, useState } from 'react';
import { useCockpit, useCockpitStore } from '@/hooks/use-cockpit-store';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import type { WorkItemTemplate } from '@/lib/api';
import {
  getDocumentType,
  parseFrontmatter,
  promoteToIssue,
  serializeFrontmatter,
  type DocumentType,
} from '@/lib/markdown';

const SCRATCH_ROOT = '.cockpit/scratch';

interface PromoteOption {
  label: string;
  description: string;
  action: 'issue' | 'workflow';
  template?: WorkItemTemplate;
}

function buildOptions(docType: DocumentType, templates: WorkItemTemplate[]): PromoteOption[] {
  const options: PromoteOption[] = [];

  if (docType === 'note') {
    options.push({
      label: 'Promote to Issue',
      description: 'Extract title + description, add acceptance criteria',
      action: 'issue',
    });
  }

  if (docType === 'note' || docType === 'issue') {
    for (const template of templates) {
      options.push({
        label: `Workflow: ${template.name}`,
        description: `${template.description} (${template.specs.length} steps)`,
        action: 'workflow',
        template,
      });
    }
  }

  return options;
}

const TYPE_COLORS: Record<DocumentType, string> = {
  note: 'var(--text-muted)',
  issue: 'var(--accent-amber)',
  workflow: 'var(--accent-cyan)',
  executable: 'var(--accent-green)',
};

export function PromotePicker({ workspace }: { workspace: MarkdownWorkspace }) {
  const templates = useCockpit(s => s.templates);
  const upgradePickerOpen = useCockpit(s => s.upgradePickerOpen);
  const store = useCockpitStore();
  const ref = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const docType = getDocumentType(workspace.state.content);
  const isProjectScoped = workspace.state.activeRoot !== SCRATCH_ROOT;
  const options = buildOptions(docType, templates);
  const safeIndex = Math.min(Math.max(activeIndex, 0), Math.max(options.length - 1, 0));

  useEffect(() => {
    setActiveIndex(0);
    ref.current?.focus();
  }, [upgradePickerOpen]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        store.set({ upgradePickerOpen: false });
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [store]);

  const suggestProjectPath = () => {
    if (isProjectScoped) {
      return workspace.state.activeRoot;
    }
    const firstProject = workspace.state.roots.find((root) => root.kind === 'project');
    if (firstProject) return firstProject.path;
    return '';
  };

  const maybePlaceInProject = async (
    commandStatus: string,
    defaultFolder: string,
    options?: {
      requireConfirm?: boolean;
      confirmMessage?: string;
    },
  ): Promise<string> => {
    const requireConfirm = options?.requireConfirm !== false;
    if (requireConfirm) {
      const placeInProject = window.confirm(
        options?.confirmMessage
          ?? 'This promoted artifact is outside a project folder. Move it into a project folder now?'
      );
      if (!placeInProject) return commandStatus;
    }

    const entered = window.prompt(
      'Project folder path (absolute or relative to current cwd):',
      suggestProjectPath()
    );
    if (!entered || !entered.trim()) return commandStatus;

    const projectPath = entered.trim();
    await workspace.setActiveRoot(projectPath);
    workspace.set({
      selectedPath: null,
      dirty: true,
      status: 'Select a project folder and filename to save the promoted document.',
    });
    workspace.openNewFilePicker('save', defaultFolder);
    return `${commandStatus}. Select destination in project workspace.`;
  };

  const moveToProjectFromPicker = async () => {
    const status = await maybePlaceInProject('Project scope selected', 'specs', {
      requireConfirm: false,
    });
    store.set({
      upgradePickerOpen: false,
      commandStatus: status,
    });
  };

  const execute = async (option: PromoteOption) => {
    const content = workspace.state.content;

    if (option.action === 'issue') {
      workspace.setContent(promoteToIssue(content));
      let status = 'Promoted to issue';
      if (!isProjectScoped) {
        status = await maybePlaceInProject(status, 'issues');
      }
      workspace.set({
        status: isProjectScoped
          ? 'Promoted to issue. Next: save if needed, then send a chat message to create or continue a linked session.'
          : 'Promoted to issue. Next: choose a project destination in the save picker to continue.',
      });
      store.set({ upgradePickerOpen: false, commandStatus: status });
      return;
    }

    if (option.action === 'workflow' && option.template) {
      const { frontmatter: currentFm } = parseFrontmatter(content);
      // If not yet an issue, promote to issue first
      const isIssue = currentFm.type === 'issue';
      const base = isIssue ? content : promoteToIssue(content);
      const { frontmatter: issueFm, body: issueBody } = parseFrontmatter(base);

      const workflowFm: Record<string, unknown> = {
        ...issueFm,
        type: 'workflow',
        template: option.template.name,
        templateId: option.template.id,
        specs: option.template.specs.map((s) => s.id),
      };

      const specsSection = [
        '',
        '## Workflow Steps',
        '',
        ...option.template.specs.map((spec, i) => {
          const deps = spec.dependencies.length ? ` (after: ${spec.dependencies.join(', ')})` : '';
          return `${i + 1}. **${spec.id}** — ${spec.objective} [${spec.agent}]${deps}`;
        }),
      ].join('\n');

      workspace.setContent(serializeFrontmatter(workflowFm, issueBody + specsSection));
      let status = `Promoted to workflow: ${option.template.name}`;
      if (!isProjectScoped) {
        status = await maybePlaceInProject(status, 'plans');
      }
      workspace.set({
        status: isProjectScoped
          ? `Promoted to workflow: ${option.template.name}. Next: save if needed (Ctrl+S), then send a chat message to start execution.`
          : `Promoted to workflow: ${option.template.name}. Next: choose a project destination in the save picker.`,
      });
      store.set({ upgradePickerOpen: false, commandStatus: status });
      return;
    }
  };

  const atMax = docType === 'workflow' || docType === 'executable';

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="absolute top-2 left-1/2 -translate-x-1/2 z-50 w-80 bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded shadow-lg overflow-hidden outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          store.set({ upgradePickerOpen: false });
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
          const opt = options[safeIndex];
          if (opt) void execute(opt);
        }
      }}
    >
      <div className="px-2.5 py-1.5 text-[10px] border-b border-[var(--border-subtle)] flex items-center gap-2">
        <span className="text-[var(--text-muted)]">Promote Document</span>
        <span
          className="px-1.5 py-0.5 rounded text-[9px] font-mono"
          style={{ color: TYPE_COLORS[docType], border: `1px solid ${TYPE_COLORS[docType]}40` }}
        >
          {docType}
        </span>
      </div>
      {!isProjectScoped && (
        <div className="px-3 py-2 border-b border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[10px] flex items-center gap-2">
          <span className="text-[var(--warning)] flex-1">
            Promoted artifacts are easier to execute/review when saved in a project folder.
          </span>
          <button
            onClick={() => { void moveToProjectFromPicker(); }}
            className="px-1.5 py-0.5 rounded border border-[var(--warning)]/50 text-[var(--warning)] hover:bg-[var(--warning)]/15"
          >
            Move now
          </button>
        </div>
      )}

      {atMax ? (
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">
          {docType === 'executable' ? 'Already executable — session linked.' : 'Already a workflow. Use chat to execute.'}
        </div>
      ) : options.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">
          No promotion options available.
          {templates.length === 0 && ' No workflows loaded from database.'}
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto py-0.5">
          {options.map((opt, index) => (
            <button
              key={`${opt.action}-${opt.template?.id ?? 'default'}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => { void execute(opt); }}
              className={`w-full text-left px-3 py-1.5 text-[11px] ${
                index === safeIndex ? 'bg-[var(--accent-cyan)]/20' : 'hover:bg-[var(--bg-hover)]'
              }`}
            >
              <div className="text-[var(--text-primary)] font-medium">{opt.label}</div>
              <div className="text-[var(--text-muted)] text-[10px] mt-0.5">{opt.description}</div>
            </button>
          ))}
        </div>
      )}

      <div className="px-2.5 py-1 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
        {'\u2191/\u2193'} select · Enter confirm · Esc cancel · Ctrl+U toggle · /promote
        <span className="block mt-0.5">Workflow next step: save in project scope, then send a chat message to run.</span>
      </div>
    </div>
  );
}
