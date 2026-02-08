import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatMarkdown } from '@/components/shared/ChatMarkdown';
import { parseMarkdownBlocks, replaceMarkdownBlock, type MarkdownBlock } from '@/lib/markdown-blocks';

interface RenderedMarkdownSurfaceProps {
  content: string;
  onChange: (next: string) => void;
}

function BlockRenderer({ block }: { block: MarkdownBlock }) {
  if (block.type === 'blank') {
    return <div className="h-4 rounded border border-dashed border-[var(--border-subtle)]/60" />;
  }
  return (
    <div className="pointer-events-none">
      <ChatMarkdown content={block.raw} />
    </div>
  );
}

export function RenderedMarkdownSurface({ content, onChange }: RenderedMarkdownSurfaceProps) {
  const parsed = useMemo(() => parseMarkdownBlocks(content), [content]);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
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

  return (
    <div className="h-full overflow-y-auto px-3 py-2 text-[12px] text-[var(--text-primary)]">
      {parsed.frontmatterRaw && (
        <div className="mb-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
          Frontmatter hidden · Raw edit to modify
        </div>
      )}

      <div className="space-y-1">
        {parsed.blocks.map((block) => {
          const isActive = activeBlockId === block.id;
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
              className="w-full rounded border border-transparent px-1.5 py-1 text-left hover:border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
              title="Click to edit this block"
            >
              <BlockRenderer block={block} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default RenderedMarkdownSurface;
