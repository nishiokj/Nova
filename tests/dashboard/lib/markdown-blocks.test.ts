import { parseMarkdownBlocks, replaceMarkdownBlock } from '@/lib/markdown-blocks';

describe('parseMarkdownBlocks', () => {
  it('parses frontmatter and block offsets', () => {
    const content = [
      '---',
      'type: workflow',
      '---',
      '# Title',
      '',
      '1. first',
      '2. second',
      '',
      'Paragraph line',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
    ].join('\n');
    const parsed = parseMarkdownBlocks(content);
    expect(parsed.frontmatterRaw).toBe('---\ntype: workflow\n---\n');
    expect(parsed.blocks.length).toBeGreaterThan(4);
    const firstBlock = parsed.blocks[0];
    expect(firstBlock.type).toBe('heading');
    expect(content.slice(firstBlock.startOffset, firstBlock.endOffset)).toBe('# Title\n');
  });

  it('creates editable placeholder when body is empty', () => {
    const parsed = parseMarkdownBlocks('---\ntype: note\n---\n');
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].type).toBe('paragraph');
    expect(parsed.blocks[0].editableText).toBe('');
  });
});

describe('replaceMarkdownBlock', () => {
  it('replaces only the selected block range', () => {
    const content = '# A\n\nParagraph\n\n# B\n';
    const parsed = parseMarkdownBlocks(content);
    const paragraph = parsed.blocks.find((block) => block.type === 'paragraph');
    if (!paragraph) throw new Error('Expected paragraph block');
    const next = replaceMarkdownBlock(content, paragraph, 'Updated paragraph');
    expect(next).toBe('# A\n\nUpdated paragraph\n\n# B\n');
  });
});
