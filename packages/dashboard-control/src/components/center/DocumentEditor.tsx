import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { useCockpit } from '@/hooks/use-cockpit-store';
import { MarkdownEditor } from './MarkdownEditor';
import { getDocumentType, getDocumentSessionKey, parseFrontmatter, type DocumentType } from '@/lib/markdown';

const TYPE_BADGE_COLORS: Record<DocumentType, { color: string; bg: string }> = {
  note: { color: 'var(--text-muted)', bg: 'var(--text-muted)' },
  issue: { color: 'var(--accent-amber)', bg: 'var(--accent-amber)' },
  workflow: { color: 'var(--accent-cyan)', bg: 'var(--accent-cyan)' },
  executable: { color: 'var(--accent-green)', bg: 'var(--accent-green)' },
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

export function DocumentEditor({ workspace }: { workspace: MarkdownWorkspace }) {
  const { state, setContent, editorRef } = workspace;
  const cockpit = useCockpit();

  const docType = getDocumentType(state.content);
  const sessionKey = getDocumentSessionKey(state.content);
  const { frontmatter } = parseFrontmatter(state.content);
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
  const workflowLike = docType === 'workflow' || docType === 'executable';
  const hasTemplateBinding = workflowLike && (templateName !== null || templateId !== null || frontmatterSpecs.length > 0);
  const matchedTemplate = hasTemplateBinding
    ? cockpit.state.templates.find((template) => (
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

        {/* Session key link */}
        {sessionKey && (
          <button
            onClick={() => cockpit.set({ focusTarget: { type: 'session', id: sessionKey } })}
            className="px-1.5 py-0.5 rounded text-[9px] font-mono text-[var(--accent-green)] hover:underline"
          >
            {sessionKey.slice(0, 20)}...
          </button>
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
          {docType !== 'executable' && (
            <button
              onClick={() => cockpit.handleOpenUpgradePicker()}
              className="px-1.5 py-0.5 rounded text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/10"
              title="Promote document (Ctrl+U, requires project/session scope)"
            >
              Promote
            </button>
          )}
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
      <div className="flex-1 min-h-0">
        <MarkdownEditor
          ref={editorRef}
          content={state.content}
          onChange={setContent}
          placeholder="# Start writing..."
        />
      </div>
      {state.status && (
        <div className="px-2 py-1 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
          {state.status}
        </div>
      )}
    </div>
  );
}
