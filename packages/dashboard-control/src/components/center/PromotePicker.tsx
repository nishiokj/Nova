import { useEffect, useRef, useState } from 'react';
import { useCockpit } from '@/hooks/use-cockpit-store';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import type { WorkItemTemplate } from '@/lib/api';
import {
  getDocumentType,
  parseFrontmatter,
  promoteToIssue,
  serializeFrontmatter,
  type DocumentType,
} from '@/lib/markdown';

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
  const { state, set } = useCockpit();
  const ref = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const docType = getDocumentType(workspace.state.content);
  const options = buildOptions(docType, state.templates);
  const safeIndex = Math.min(Math.max(activeIndex, 0), Math.max(options.length - 1, 0));

  useEffect(() => {
    setActiveIndex(0);
    ref.current?.focus();
  }, [state.upgradePickerOpen]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        set({ upgradePickerOpen: false });
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [set]);

  const execute = (option: PromoteOption) => {
    const content = workspace.state.content;

    if (option.action === 'issue') {
      workspace.setContent(promoteToIssue(content));
      set({ upgradePickerOpen: false, commandStatus: 'Promoted to issue' });
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
      set({ upgradePickerOpen: false, commandStatus: `Promoted to workflow: ${option.template.name}` });
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
          set({ upgradePickerOpen: false });
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
          if (opt) execute(opt);
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

      {atMax ? (
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">
          {docType === 'executable' ? 'Already executable — session linked.' : 'Already a workflow. Use chat to execute.'}
        </div>
      ) : options.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">
          No promotion options available.
          {state.templates.length === 0 && ' No workflows loaded from database.'}
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto py-0.5">
          {options.map((opt, index) => (
            <button
              key={`${opt.action}-${opt.template?.id ?? 'default'}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => execute(opt)}
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
        {'\u2191/\u2193'} select · Enter confirm · Esc cancel · Ctrl+U toggle
        <span className="ml-1">· requires project/session workspace</span>
      </div>
    </div>
  );
}
