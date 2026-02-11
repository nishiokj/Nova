export type MarkdownBlockType =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'code-fence'
  | 'blank';

export interface MarkdownBlock {
  id: string;
  type: MarkdownBlockType;
  startOffset: number;
  endOffset: number;
  raw: string;
  editableText: string;
  trailingNewline: string;
}

export interface ParsedMarkdownBlocks {
  frontmatterRaw: string | null;
  bodyStartOffset: number;
  blocks: MarkdownBlock[];
}

interface LineRecord {
  text: string;
  start: number;
  end: number;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const FENCE_RE = /^```/;
const HEADING_RE = /^#{1,6}\s+/;
const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+/;

function splitTrailingNewline(value: string): { editableText: string; trailingNewline: string } {
  const match = value.match(/(\r?\n)+$/);
  if (!match) {
    return { editableText: value, trailingNewline: '' };
  }
  const trailingNewline = match[0];
  return {
    editableText: value.slice(0, value.length - trailingNewline.length),
    trailingNewline,
  };
}

function scanLines(text: string): LineRecord[] {
  if (text.length === 0) return [];
  const lines: LineRecord[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const newlineIdx = text.indexOf('\n', cursor);
    if (newlineIdx === -1) {
      lines.push({
        text: text.slice(cursor),
        start: cursor,
        end: text.length,
      });
      break;
    }

    const lineEnd = newlineIdx > cursor && text[newlineIdx - 1] === '\r'
      ? newlineIdx - 1
      : newlineIdx;
    lines.push({
      text: text.slice(cursor, lineEnd),
      start: cursor,
      end: newlineIdx + 1,
    });
    cursor = newlineIdx + 1;
  }
  return lines;
}

function pushBlock(
  content: string,
  blocks: MarkdownBlock[],
  type: MarkdownBlockType,
  startOffset: number,
  endOffset: number,
): void {
  const raw = content.slice(startOffset, endOffset);
  const { editableText, trailingNewline } = splitTrailingNewline(raw);
  blocks.push({
    id: `${type}:${startOffset}:${endOffset}`,
    type,
    startOffset,
    endOffset,
    raw,
    editableText,
    trailingNewline,
  });
}

export function parseMarkdownBlocks(content: string): ParsedMarkdownBlocks {
  const frontmatterMatch = content.match(FRONTMATTER_RE);
  const bodyStartOffset = frontmatterMatch ? frontmatterMatch[0].length : 0;
  const frontmatterRaw = frontmatterMatch ? frontmatterMatch[0] : null;
  const body = content.slice(bodyStartOffset);
  const lines = scanLines(body);
  const blocks: MarkdownBlock[] = [];

  if (lines.length === 0) {
    blocks.push({
      id: `paragraph:${bodyStartOffset}:${bodyStartOffset}`,
      type: 'paragraph',
      startOffset: bodyStartOffset,
      endOffset: bodyStartOffset,
      raw: '',
      editableText: '',
      trailingNewline: '',
    });
    return { frontmatterRaw, bodyStartOffset, blocks };
  }

  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.text.trim();

    if (trimmed.length === 0) {
      pushBlock(
        content,
        blocks,
        'blank',
        bodyStartOffset + line.start,
        bodyStartOffset + line.end,
      );
      idx += 1;
      continue;
    }

    if (FENCE_RE.test(line.text)) {
      const start = idx;
      let end = idx;
      idx += 1;
      while (idx < lines.length) {
        end = idx;
        if (FENCE_RE.test(lines[idx].text)) {
          idx += 1;
          break;
        }
        idx += 1;
      }
      pushBlock(
        content,
        blocks,
        'code-fence',
        bodyStartOffset + lines[start].start,
        bodyStartOffset + lines[end].end,
      );
      continue;
    }

    if (HEADING_RE.test(line.text)) {
      pushBlock(
        content,
        blocks,
        'heading',
        bodyStartOffset + line.start,
        bodyStartOffset + line.end,
      );
      idx += 1;
      continue;
    }

    if (LIST_RE.test(line.text)) {
      pushBlock(
        content,
        blocks,
        'list-item',
        bodyStartOffset + line.start,
        bodyStartOffset + line.end,
      );
      idx += 1;
      continue;
    }

    const start = idx;
    let end = idx;
    idx += 1;
    while (idx < lines.length) {
      const next = lines[idx];
      if (
        next.text.trim().length === 0
        || FENCE_RE.test(next.text)
        || HEADING_RE.test(next.text)
        || LIST_RE.test(next.text)
      ) {
        break;
      }
      end = idx;
      idx += 1;
    }
    pushBlock(
      content,
      blocks,
      'paragraph',
      bodyStartOffset + lines[start].start,
      bodyStartOffset + lines[end].end,
    );
  }

  return { frontmatterRaw, bodyStartOffset, blocks };
}

export function replaceMarkdownBlock(
  content: string,
  block: Pick<MarkdownBlock, 'startOffset' | 'endOffset' | 'trailingNewline'>,
  nextEditableText: string,
): string {
  return `${content.slice(0, block.startOffset)}${nextEditableText}${block.trailingNewline}${content.slice(block.endOffset)}`;
}
