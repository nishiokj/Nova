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

export function DocumentEditor({ workspace }: { workspace: MarkdownWorkspace }) {
  const { state, setContent, editorRef } = workspace;
  const cockpit = useCockpit();

  const docType = getDocumentType(state.content);
  const sessionKey = getDocumentSessionKey(state.content);
  const { frontmatter } = parseFrontmatter(state.content);
  const templateName = typeof frontmatter.template === 'string' ? frontmatter.template : null;
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

        {/* Template name badge */}
        {templateName && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-mono text-[var(--accent-cyan)]" style={{ border: '1px solid var(--accent-cyan)40' }}>
            {templateName}
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
          {/* Promote button */}
          {docType !== 'executable' && (
            <button
              onClick={() => cockpit.set({ upgradePickerOpen: true })}
              className="px-1.5 py-0.5 rounded text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/10"
              title="Promote document (Ctrl+U)"
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
