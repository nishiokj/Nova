import { lazy, Suspense, useEffect, useState, type KeyboardEvent } from 'react';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { useCockpit, useCockpitStore } from '@/hooks/use-cockpit-store';
import { getDocumentType, parseFrontmatter, type DocumentType } from '@/lib/markdown';
import { ChatMarkdown } from '@/components/shared/ChatMarkdown';

const MarkdownEditor = lazy(() => import('./MarkdownEditor'));

const TYPE_BADGE_COLORS: Record<DocumentType, { color: string; bg: string }> = {
  note: { color: 'var(--text-muted)', bg: 'var(--text-muted)' },
  issue: { color: 'var(--accent-amber)', bg: 'var(--accent-amber)' },
  workflow: { color: 'var(--accent-cyan)', bg: 'var(--accent-cyan)' },
};

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function normalizeSpecsValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function shouldExitPreviewOnKey(event: KeyboardEvent<HTMLDivElement>): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key === 'Escape') return true;
  if (event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete') return true;
  return event.key.length === 1;
}

export function DocumentEditor({ workspace }: { workspace: MarkdownWorkspace }) {
  const { state, setContent, editorRef } = workspace;
  const templates = useCockpit(s => s.templates);
  const store = useCockpitStore();
  const [previewMode, setPreviewMode] = useState(false);

  const docType = getDocumentType(state.content);
  const { frontmatter, body } = parseFrontmatter(state.content);
  const templateName = firstNonEmptyString([
    frontmatter.template,
    frontmatter.templateName,
    frontmatter.template_name,
  ]);
  const templateId = firstNonEmptyString([
    frontmatter.templateId,
    frontmatter.template_id,
    frontmatter.workflowTemplateId,
    frontmatter.workflow_template_id,
  ]);
  const frontmatterSpecs = normalizeSpecsValue(frontmatter.specs);
  const templateBadge = templateName ?? templateId;
  const workflowLike = docType === 'workflow';
  const hasTemplateBinding = workflowLike && (templateName !== null || templateId !== null || frontmatterSpecs.length > 0);
  const matchedTemplate = hasTemplateBinding
    ? templates.find((template) => (
      (templateId !== null && template.id === templateId)
      || (templateName !== null && template.name.toLowerCase() === templateName.toLowerCase())
    )) ?? null
    : null;
  const templateSpecIds = matchedTemplate?.specs.map((spec) => spec.id) ?? [];
  const specsMatch = matchedTemplate
    ? templateSpecIds.length === frontmatterSpecs.length
      && templateSpecIds.every((id, i) => id === frontmatterSpecs[i])
    : true;
  const templateBindingStatus = !hasTemplateBinding
    ? null
    : !matchedTemplate
      ? 'missing-template'
      : !specsMatch
        ? 'spec-mismatch'
        : 'ok';
  const badgeStyle = TYPE_BADGE_COLORS[docType];
  const needsProjectScopeForWorkflow = workflowLike && state.activeRoot === '.cockpit/scratch';
  const needsSaveForWorkflow = workflowLike && !state.selectedPath;
  const workflowHint = !workflowLike
    ? null
    : needsProjectScopeForWorkflow
      ? {
          tone: 'warning' as const,
          text: 'Workflow docs run from project workspaces. Save this file into a project folder first.',
          action: 'save-picker' as const,
        }
      : needsSaveForWorkflow
        ? {
            tone: 'warning' as const,
            text: 'Workflow is unsaved. Save it (Ctrl+S), then send a chat message to start execution.',
            action: 'save' as const,
          }
        : {
            tone: 'info' as const,
            text: 'Ready to run. Use /feature or /bugfix with a prompt to create a session.',
            action: 'chat' as const,
          };

  useEffect(() => {
    setPreviewMode(false);
  }, [state.selectedPath]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-2 py-1 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] flex items-center gap-2">
        <span className="font-mono truncate">{state.selectedPath ?? 'untitled.md'}</span>

        {/* Document type badge */}
        <span
          className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase"
          style={{ color: badgeStyle.color, border: `1px solid ${badgeStyle.bg}40` }}
        >
          {docType}
        </span>

        {/* Workflow name badge */}
        {templateBadge && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-mono text-[var(--accent-cyan)]" style={{ border: '1px solid var(--accent-cyan)40' }}>
            {templateBadge}
          </span>
        )}

        {state.loading && <span className="text-[var(--accent-cyan)]">Loading...</span>}
        {state.autoSaving && <span className="text-[var(--accent-cyan)]">Autosaving...</span>}
        {state.conflictVersion !== null && (
          <span className="text-[var(--warning)]">Conflict v{state.conflictVersion}</span>
        )}

        <span className="ml-auto flex items-center gap-2 text-[10px]">
          {/* New File button */}
          <button
            onClick={() => workspace.openNewFilePicker('create')}
            className="px-1.5 py-0.5 rounded text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/10"
            title="New markdown file (Ctrl+N)"
          >
            + New
          </button>
          {/* Promote button */}
          <button
            onClick={() => store.handleOpenUpgradePicker()}
            className="px-1.5 py-0.5 rounded text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/10"
            title="Promote document (Ctrl+U)"
          >
            Promote
          </button>
          <button
            onClick={() => {
              setPreviewMode((prev) => {
                const next = !prev;
                if (!next) {
                  window.setTimeout(() => editorRef.current?.focus(), 0);
                }
                return next;
              });
            }}
            className="px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]"
            style={{ color: previewMode ? 'var(--accent-cyan)' : 'var(--text-muted)' }}
            title={previewMode ? 'Switch to editable markdown' : 'Preview rendered markdown (read-only)'}
          >
            {previewMode ? 'Edit' : 'Preview'}
          </button>
          <span>
            {state.dirty ? 'Unsaved' : 'Saved'}
            {state.version > 0 && ` · v${state.version}`}
          </span>
        </span>
      </div>
      {templateBindingStatus && (
        <div
          className="px-2 py-1 border-b text-[10px]"
          style={{
            color: templateBindingStatus === 'ok' ? 'var(--text-secondary)' : 'var(--warning)',
            borderColor: templateBindingStatus === 'ok' ? 'var(--border-subtle)' : 'var(--warning)',
            background: templateBindingStatus === 'ok' ? 'var(--bg-elevated)' : 'color-mix(in srgb, var(--warning) 12%, transparent)',
          }}
        >
          {templateBindingStatus === 'ok'
            ? 'Template bindings active: frontmatter template/templateId/specs resolve runtime workItems and subagents from the DB template.'
            : templateBindingStatus === 'spec-mismatch'
              ? 'Frontmatter specs differ from the selected DB template. Runtime resolves from DB template steps, not edited markdown step text.'
              : 'Template binding found, but no matching DB template is loaded in cockpit. Workflow resolution may fail until restored.'}
        </div>
      )}
      {workflowHint && (
        <div
          className="px-2 py-1 border-b text-[10px] flex items-center gap-2"
          style={{
            color: workflowHint.tone === 'warning' ? 'var(--warning)' : 'var(--text-secondary)',
            borderColor: workflowHint.tone === 'warning' ? 'var(--warning)' : 'var(--border-subtle)',
            background: workflowHint.tone === 'warning'
              ? 'color-mix(in srgb, var(--warning) 12%, transparent)'
              : 'var(--bg-elevated)',
          }}
        >
          <span className="flex-1">{workflowHint.text}</span>
          {workflowHint.action === 'save-picker' && (
            <button
              onClick={() => workspace.openNewFilePicker('save', 'plans')}
              className="px-1.5 py-0.5 rounded border border-[var(--warning)]/50 text-[var(--warning)] hover:bg-[var(--warning)]/15"
            >
              Save in project
            </button>
          )}
          {workflowHint.action === 'save' && (
            <button
              onClick={() => { void workspace.save(); }}
              className="px-1.5 py-0.5 rounded border border-[var(--warning)]/50 text-[var(--warning)] hover:bg-[var(--warning)]/15"
            >
              Save
            </button>
          )}
          {workflowHint.action === 'chat' && (
            <button
              onClick={() => store.set({ inputVisible: true, eventDrawerOpen: true, eventFilter: 'messages' })}
              className="px-1.5 py-0.5 rounded border border-[var(--accent-cyan)]/40 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/10"
            >
              Open chat
            </button>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {previewMode ? (
          <div
            tabIndex={0}
            className="h-full overflow-y-auto px-3 py-2 outline-none"
            onKeyDown={(event) => {
              if (!shouldExitPreviewOnKey(event)) return;
              event.preventDefault();
              setPreviewMode(false);
              window.setTimeout(() => editorRef.current?.focus(), 0);
            }}
          >
            <div className="mb-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
              Read-only preview. Toggle to Edit to modify markdown.
            </div>
            <ChatMarkdown content={body} />
          </div>
        ) : (
          <Suspense fallback={<div className="h-full flex items-center justify-center text-[var(--text-muted)] text-xs">Loading editor...</div>}>
            <MarkdownEditor
              ref={editorRef}
              content={state.content}
              onChange={setContent}
              placeholder="# Start writing..."
            />
          </Suspense>
        )}
      </div>
      {state.status && (
        <div className="px-2 py-1 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
          {state.status}
        </div>
      )}
    </div>
  );
}
