import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatMarkdown } from '@/components/shared/ChatMarkdown';
import { parseMarkdownBlocks, replaceMarkdownBlock, type MarkdownBlock, ParsedMarkdownBlocks } from '@/lib/markdown-blocks';
import { getDocumentType } from '@/lib/markdown';

interface RenderedMarkdownSurfaceProps {
  content: string;
  onChange: (next: string) => void;
}

function BlockRenderer({ block, showEditHint }: { block: MarkdownBlock; showEditHint?: boolean }) {
  if (block.type === 'blank') {
    return <div className="h-4 rounded border border-dashed border-[var(--border-subtle)]/60" />;
  }
  return (
    <div className="relative">
      {showEditHint && (
        <div className="absolute -top-2 -left-1 px-1 text-[9px] text-[var(--accent-cyan)] bg-[var(--bg-surface)] border border-[var(--accent-cyan)]/40 rounded">
          EDIT HERE
        </div>
      )}
      <div className="pointer-events-none">
        <ChatMarkdown content={block.raw} />
      </div>
    </div>
  );
}

export function RenderedMarkdownSurface({ content, onChange }: RenderedMarkdownSurfaceProps) {
  const parsed = useMemo(() => parseMarkdownBlocks(content), [content]);
  const docType = useMemo(() => getDocumentType(content), [content]);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showMetadata, setShowMetadata] = useState(false);
  const cancelBlurRef = useRef(false);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeBlock = useMemo(
    () => parsed.blocks.find((block) => block.id === activeBlockId) ?? null,
    [parsed.blocks, activeBlockId],
  );

  useEffect(() => {
    if (activeBlockId && !activeBlock) {
      setActiveBlockId(null);
      setDraft('');
    }
  }, [activeBlockId, activeBlock]);

  useEffect(() => {
    if (!activeBlock) return;
    textAreaRef.current?.focus();
    const cursor = draft.length;
    textAreaRef.current?.setSelectionRange(cursor, cursor);
    // Focus only when a block enters edit mode; avoid cursor jumps during typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBlockId]);

  const openBlockEditor = (block: MarkdownBlock) => {
    setActiveBlockId(block.id);
    setDraft(block.editableText);
  };

  const closeBlockEditor = () => {
    setActiveBlockId(null);
    setDraft('');
  };

  const commitBlock = () => {
    if (!activeBlock) return;
    const nextContent = replaceMarkdownBlock(content, activeBlock, draft);
    if (nextContent !== content) {
      onChange(nextContent);
    }
    closeBlockEditor();
  };

  const cancelBlock = () => {
    cancelBlurRef.current = true;
    closeBlockEditor();
  };

  // Determine which blocks should show "EDIT HERE" hints
  // Typically workflow descriptions and objective sections
  const editableBlockIds = useMemo(() => {
    const ids = new Set<string>();
    if (docType === 'workflow') {
      // Mark blocks that come after certain headings as editable
      let afterEditableHeading = false;
      for (const block of parsed.blocks) {
        if (block.type === 'heading') {
          if (block.raw.toLowerCase().includes('description') || 
              block.raw.toLowerCase().includes('objective') ||
              block.raw.toLowerCase().includes('context')) {
            afterEditableHeading = true;
          } else {
            afterEditableHeading = false;
          }
        } else if (afterEditableHeading && (block.type === 'paragraph' || block.type === 'list-item')) {
          ids.add(block.id);
        }
      }
    }
    return ids;
  }, [parsed.blocks, docType]);

  return (
    <div className="h-full overflow-y-auto px-3 py-2 text-[12px] text-[var(--text-primary)]">
      {/* Workflow Descriptor */}
      {(docType === 'workflow') && (
        <div className="mb-3 rounded border border-[var(--accent-cyan)]/30 bg-[var(--accent-cyan)]/5 px-3 py-2">
          <div className="text-[11px] font-medium text-[var(--accent-cyan)] mb-1">
            Agentic workflow with predefined stages
          </div>
          <div className="text-[10px] text-[var(--text-secondary)]">
            A durable, robust unit of work. Each workflow step corresponds to a subagent task.
          </div>
        </div>
      )}

      {/* Custom Spec Link Field - for workflows that need external spec references */}
      {(docType === 'workflow') && (
        <div className="mb-3 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2">
          <div className="text-[10px] text-[var(--text-muted)] mb-1">Custom Spec Link (optional)</div>
          <input
            type="text"
            placeholder="https://github.com/owner/repo/blob/main/spec.md"
            className="w-full px-2 py-1 text-[11px] text-[var(--text-primary)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded focus:border-[var(--accent-cyan)] focus:outline-none"
            // This is a UI-only field - not persisted to the document
            title="Link to external specification document (display only)"
          />
        </div>
      )}

      {/* Frontmatter toggle - hidden by default for cleaner view */}
      {parsed.frontmatterRaw && (
        <button
          onClick={() => setShowMetadata(!showMetadata)}
          className="mb-2 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] text-left flex items-center gap-2"
        >
          <span className="shrink-0">{showMetadata ? '▼' : '▶'}</span>
          <span>{showMetadata ? 'Hide' : 'Show'} frontmatter metadata</span>
        </button>
      )}

      {/* Expandable frontmatter section */}
      {showMetadata && parsed.frontmatterRaw && (
        <div className="mb-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
          <pre className="whitespace-pre-wrap break-all">{parsed.frontmatterRaw}</pre>
        </div>
      )}

      <div className="space-y-1">
        {parsed.blocks.map((block) => {
          const isActive = activeBlockId === block.id;
          const showEditHint = editableBlockIds.has(block.id);
          if (isActive) {
            const rows = Math.min(24, Math.max(2, draft.split('\n').length + 1));
            return (
              <div key={block.id} className="rounded border border-[var(--accent-cyan)]/60 bg-[var(--bg-elevated)] p-1.5">
                <textarea
                  ref={textAreaRef}
                  rows={rows}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => {
                    if (cancelBlurRef.current) {
                      cancelBlurRef.current = false;
                      return;
                    }
                    commitBlock();
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault();
                      commitBlock();
                      return;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelBlock();
                    }
                  }}
                  className={`w-full resize-y rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)] ${
                    block.type === 'code-fence' ? 'font-mono leading-relaxed' : 'leading-normal'
                  }`}
                  spellCheck={block.type !== 'code-fence'}
                />
                <div className="mt-1 text-[10px] text-[var(--text-muted)]">
                  Ctrl/Cmd+Enter commit · Esc cancel · blur commits
                </div>
              </div>
            );
          }

          return (
            <button
              key={block.id}
              onClick={() => openBlockEditor(block)}
              className={`w-full rounded border border-transparent px-1.5 py-1 text-left hover:border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] ${
                showEditHint ? 'ring-1 ring-inset ring-[var(--accent-cyan)]/20' : ''
              }`}
              title="Click to edit this block"
            >
              <BlockRenderer block={block} showEditHint={showEditHint} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default RenderedMarkdownSurface;
