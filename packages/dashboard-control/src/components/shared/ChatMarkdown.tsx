import { memo, useEffect, useMemo, useRef, useState } from 'react';

/** Lightweight markdown renderer for chat messages. No external deps. */

type InlineSegment = { type: 'text'; value: string } | { type: 'code'; value: string } | { type: 'bold'; value: string } | { type: 'italic'; value: string };

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  // Regex order matters: code first (greedy), then bold, then italic
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) segments.push({ type: 'text', value: text.slice(last, match.index) });
    if (match[1]) segments.push({ type: 'code', value: match[1].slice(1, -1) });
    else if (match[2]) segments.push({ type: 'bold', value: match[2].slice(2, -2) });
    else if (match[3]) segments.push({ type: 'italic', value: match[3].slice(1, -1) });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
  return segments;
}

function InlineContent({ text }: { text: string }) {
  const segments = parseInline(text);
  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case 'code':
            return <code key={i} className="px-1 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--accent-cyan)] text-[11px] font-mono">{seg.value}</code>;
          case 'bold':
            return <strong key={i} className="font-semibold text-[var(--text-primary)]">{seg.value}</strong>;
          case 'italic':
            return <em key={i} className="italic">{seg.value}</em>;
          default:
            return <span key={i}>{seg.value}</span>;
        }
      })}
    </>
  );
}

function MermaidBlock({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
        });
        const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
        const { svg } = await mermaid.render(id, chart);
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = svg;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <pre className="my-1 px-2 py-1.5 rounded bg-[var(--bg-elevated)] text-[11px] font-mono text-[var(--text-secondary)] overflow-x-auto whitespace-pre">
        {chart}
      </pre>
    );
  }

  return (
    <div className="my-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-2 overflow-x-auto">
      <div ref={containerRef} />
    </div>
  );
}

type Block =
  | { type: 'code'; lang: string; content: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list-item'; ordered: boolean; marker: string; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'blank' };

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    const fence = line.match(/^```(\w*)$/);
    if (fence) {
      const lang = fence[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
      i++; // skip closing ```
      continue;
    }
    // Blank line
    if (!line.trim()) {
      blocks.push({ type: 'blank' });
      i++;
      continue;
    }
    // Headers
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    // Unordered list
    if (line.match(/^[-*]\s+/)) {
      blocks.push({ type: 'list-item', ordered: false, marker: '-', text: line.replace(/^[-*]\s+/, '') });
      i++;
      continue;
    }
    // Ordered list
    const ol = line.match(/^(\d+)\.\s+(.+)$/);
    if (ol) {
      blocks.push({ type: 'list-item', ordered: true, marker: `${ol[1]}.`, text: ol[2] });
      i++;
      continue;
    }
    // Paragraph (default)
    blocks.push({ type: 'paragraph', text: line });
    i++;
  }
  return blocks;
}

export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  const blocks = useMemo(() => parseBlocks(content), [content]);
  return (
    <div className="text-[10px] text-[var(--text-primary)] leading-relaxed break-words">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'code':
            if (block.lang.toLowerCase() === 'mermaid') {
              return <MermaidBlock key={idx} chart={block.content} />;
            }
            return (
              <pre key={idx} className="my-1 px-2 py-1.5 rounded bg-[var(--bg-elevated)] text-[11px] font-mono text-[var(--text-secondary)] overflow-x-auto whitespace-pre">
                {block.content}
              </pre>
            );
          case 'heading': {
            const cls = block.level === 1
              ? 'text-sm font-semibold mt-1.5 mb-0.5'
              : block.level === 2
                ? 'text-xs font-semibold mt-1 mb-0.5'
                : 'text-xs font-medium mt-1 mb-0.5 text-[var(--text-secondary)]';
            return <div key={idx} className={cls}><InlineContent text={block.text} /></div>;
          }
          case 'list-item':
            return (
              <div key={idx} className="flex gap-1.5 pl-1">
                <span className="text-[var(--text-muted)] shrink-0 select-none">{block.marker}</span>
                <span><InlineContent text={block.text} /></span>
              </div>
            );
          case 'paragraph':
            return <p key={idx}><InlineContent text={block.text} /></p>;
          case 'blank':
            return <div key={idx} className="h-1" />;
        }
      })}
    </div>
  );
});
