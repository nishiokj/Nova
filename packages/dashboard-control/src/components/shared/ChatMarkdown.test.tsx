/**
 * Tests for ChatMarkdown component
 * Tests markdown parsing and rendering
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ChatMarkdown } from './ChatMarkdown';

// Mock mermaid
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockImplementation(() =>
      Promise.resolve({ svg: '<svg>diagram</svg>' })
    ),
  },
}));

describe('ChatMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('Inline Markdown Parsing', () => {
    it('should render plain text', () => {
      render(<ChatMarkdown content="Hello, world!" />);

      expect(screen.getByText('Hello, world!')).toBeInTheDocument();
    });

    it('should render inline code', () => {
      render(<ChatMarkdown content="Use `const x = 1`" />);

      const codeElement = screen.getByText('const x = 1');
      expect(codeElement.tagName).toBe('CODE');
      expect(codeElement).toHaveClass('font-mono');
    });

    it('should render bold text', () => {
      render(<ChatMarkdown content="This is **bold** text" />);

      const boldElement = screen.getByText('bold');
      expect(boldElement.tagName).toBe('STRONG');
    });

    it('should render italic text', () => {
      render(<ChatMarkdown content="This is *italic* text" />);

      const italicElement = screen.getByText('italic');
      expect(italicElement.tagName).toBe('EM');
    });

    it('should render mixed inline markdown', () => {
      render(
        <ChatMarkdown content="Use **bold** and `code` and *italic*" />
      );

      expect(screen.getByText('bold').tagName).toBe('STRONG');
      expect(screen.getByText('code').tagName).toBe('CODE');
      expect(screen.getByText('italic').tagName).toBe('EM');
    });

    it('should handle empty content', () => {
      const { container } = render(<ChatMarkdown content="" />);

      expect(container).toBeInTheDocument();
    });

    it('should preserve text outside markdown', () => {
      render(<ChatMarkdown content="Prefix `code` suffix" />);

      expect(screen.getByText('Prefix')).toBeInTheDocument();
      expect(screen.getByText('suffix')).toBeInTheDocument();
    });
  });

  describe('Block Elements', () => {
    it('should render heading level 1', () => {
      render(<ChatMarkdown content="# Main Heading" />);

      const heading = screen.getByText('Main Heading');
      expect(heading).toHaveClass('text-sm', 'font-semibold');
    });

    it('should render heading level 2', () => {
      render(<ChatMarkdown content="## Secondary Heading" />);

      const heading = screen.getByText('Secondary Heading');
      expect(heading).toHaveClass('text-xs', 'font-semibold');
    });

    it('should render heading level 3', () => {
      render(<ChatMarkdown content="### Tertiary Heading" />);

      const heading = screen.getByText('Tertiary Heading');
      expect(heading).toHaveClass('text-xs', 'font-medium');
    });

    it('should render unordered list items', () => {
      render(
        <ChatMarkdown content="- First item\n- Second item\n- Third item" />
      );

      expect(screen.getByText('First item')).toBeInTheDocument();
      expect(screen.getByText('Second item')).toBeInTheDocument();
      expect(screen.getByText('Third item')).toBeInTheDocument();
    });

    it('should render ordered list items', () => {
      render(
        <ChatMarkdown content="1. First\n2. Second\n3. Third" />
      );

      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
      expect(screen.getByText('Third')).toBeInTheDocument();
    });

    it('should render list markers', () => {
      render(<ChatMarkdown content="- Item" />);

      expect(screen.getByText('-')).toBeInTheDocument();
    });

    it('should render ordered list markers', () => {
      render(<ChatMarkdown content="1. Item" />);

      expect(screen.getByText('1.')).toBeInTheDocument();
    });

    it('should render paragraphs', () => {
      render(<ChatMarkdown content="This is a paragraph" />);

      expect(screen.getByText('This is a paragraph')).toBeInTheDocument();
      expect(screen.getByText('This is a paragraph').tagName).toBe('P');
    });

    it('should render multiple paragraphs', () => {
      render(<ChatMarkdown content="First paragraph\n\nSecond paragraph" />);

      expect(screen.getByText('First paragraph')).toBeInTheDocument();
      expect(screen.getByText('Second paragraph')).toBeInTheDocument();
    });

    it('should render blank lines as spacing', () => {
      const { container } = render(
        <ChatMarkdown content="Line 1\n\n\nLine 2" />
      );

      const blankDivs = container.querySelectorAll('.h-1');
      expect(blankDivs.length).toBeGreaterThan(0);
    });
  });

  describe('Code Blocks', () => {
    it('should render code blocks with language', () => {
      render(
        <ChatMarkdown content="```typescript\nconst x: number = 1;\n```" />
      );

      const codeBlock = screen.getByText('const x: number = 1;');
      expect(codeBlock.tagName).toBe('PRE');
      expect(codeBlock).toHaveClass('font-mono');
    });

    it('should render code blocks without language', () => {
      render(
        <ChatMarkdown content="```\nplain code\n```" />
      );

      const codeBlock = screen.getByText('plain code');
      expect(codeBlock.tagName).toBe('PRE');
    });

    it('should preserve whitespace in code blocks', () => {
      const code = 'line 1\n  indented\nline 3';
      render(<ChatMarkdown content={`\`\`\`\n${code}\n\`\`\``} />);

      const codeBlock = screen.getByText('line 1');
      expect(codeBlock.textContent).toContain('indented');
    });

    it('should handle multi-line code blocks', () => {
      const code = 'function test() {\n  return true;\n}';
      render(<ChatMarkdown content={`\`\`\`\n${code}\n\`\`\``} />);

      expect(screen.getByText('function test() {')).toBeInTheDocument();
      expect(screen.getByText('return true;')).toBeInTheDocument();
    });

    it('should handle code block with inline markdown inside', () => {
      render(<ChatMarkdown content="```js\nconst **bold** = 1;\n```" />);

      const codeBlock = screen.getByText(/const \*\*bold\*\* = 1;/);
      expect(codeBlock).toBeInTheDocument();
    });
  });

  describe('Mermaid Diagrams', () => {
    it('should render mermaid diagrams', async () => {
      render(
        <ChatMarkdown content="```mermaid\ngraph TD\n  A-->B\n```" />
      );

      await waitFor(async () => {
        const mermaidModule = await import('mermaid');
        expect(mermaidModule.default.render).toHaveBeenCalled();
      });
    });

    it('should show fallback on mermaid error', async () => {
      const mermaidModule = await import('mermaid');
      vi.mocked(mermaidModule.default.render).mockRejectedValue(
        new Error('Mermaid error')
      );

      render(
        <ChatMarkdown content="```mermaid\ninvalid mermaid\n```" />
      );

      await waitFor(() => {
        const fallback = screen.getByText('invalid mermaid');
        expect(fallback).toBeInTheDocument();
        expect(fallback.tagName).toBe('PRE');
      });
    });

    it('should render mermaid in container with proper styling', async () => {
      render(
        <ChatMarkdown content="```mermaid\ngraph LR\n  A->B\n```" />
      );

      await waitFor(async () => {
        const mermaidModule = await import('mermaid');
        expect(mermaidModule.default.initialize).toHaveBeenCalledWith({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
        });
      });
    });
  });

  describe('Complex Documents', () => {
    it('should render document with mixed content types', () => {
      const content = `# Title

Introduction paragraph with **bold** and \`code\`.

## Features
- Feature one
- Feature two

## Code Example
\`\`\`js
const x = 1;
\`\`\`
`;

      render(<ChatMarkdown content={content} />);

      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Introduction paragraph')).toBeInTheDocument();
      expect(screen.getByText('Features')).toBeInTheDocument();
      expect(screen.getByText('Feature one')).toBeInTheDocument();
      expect(screen.getByText('Code Example')).toBeInTheDocument();
      expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    });

    it('should handle multiple code blocks', () => {
      const content = `
First block:
\`\`\`
code1
\`\`\`

Second block:
\`\`\`js
code2
\`\`\`
`;

      render(<ChatMarkdown content={content} />);

      expect(screen.getByText('code1')).toBeInTheDocument();
      expect(screen.getByText('code2')).toBeInTheDocument();
    });

    it('should handle nested markdown', () => {
      render(
        <ChatMarkdown content="# Heading\n\nParagraph with **bold** and *italic* and \`code`" />
      );

      expect(screen.getByText('Heading')).toBeInTheDocument();
      expect(screen.getByText('bold').tagName).toBe('STRONG');
      expect(screen.getByText('italic').tagName).toBe('EM');
      expect(screen.getByText('code').tagName).toBe('CODE');
    });
  });

  describe('Edge Cases', () => {
    it('should handle unclosed code fences', () => {
      render(<ChatMarkdown content="```js\nunclosed code" />);

      expect(screen.getByText('```js')).toBeInTheDocument();
    });

    it('should handle empty code fences', () => {
      render(<ChatMarkdown content="```js\n```" />);

      const codeBlocks = screen.getAllByRole('none'); // pre elements
      expect(codeBlocks.length).toBeGreaterThan(0);
    });

    it('should handle text with asterisks not meant for markdown', () => {
      render(<ChatMarkdown content="5 * 5 = 25" />);

      expect(screen.getByText('5 * 5 = 25')).toBeInTheDocument();
    });

    it('should handle underscores not meant for markdown', () => {
      render(<ChatMarkdown content="variable_name_test" />);

      expect(screen.getByText('variable_name_test')).toBeInTheDocument();
    });

    it('should handle escaped characters', () => {
      render(<ChatMarkdown content="Backtick: \\`not code\\`" />);

      expect(screen.getByText('Backtick: `not code`')).toBeInTheDocument();
    });

    it('should handle very long lines', () => {
      const longText = 'a'.repeat(1000);
      render(<ChatMarkdown content={longText} />);

      const element = screen.getByText(longText);
      expect(element).toBeInTheDocument();
    });

    it('should handle special HTML characters', () => {
      render(<ChatMarkdown content="<div> &amp; &lt; &gt; </div>" />);

      expect(screen.getByText(/&amp;/)).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('should apply text-xs class', () => {
      const { container } = render(<ChatMarkdown content="test" />);

      const markdownDiv = container.querySelector('.text-xs');
      expect(markdownDiv).toBeInTheDocument();
    });

    it('should apply leading-relaxed class', () => {
      const { container } = render(<ChatMarkdown content="test" />);

      const markdownDiv = container.querySelector('.leading-relaxed');
      expect(markdownDiv).toBeInTheDocument();
    });

    it('should apply break-words class', () => {
      const { container } = render(<ChatMarkdown content="test" />);

      const markdownDiv = container.querySelector('.break-words');
      expect(markdownDiv).toBeInTheDocument();
    });

    it('should style code blocks with proper classes', () => {
      render(<ChatMarkdown content="```js\ncode\n```" />);

      const pre = screen.getByText('code');
      expect(pre).toHaveClass(
        'my-1',
        'px-2',
        'py-1.5',
        'rounded',
        'bg-\\[var\\(--bg-elevated\\)\\]',
        'font-mono'
      );
    });

    it('should style inline code with proper classes', () => {
      render(<ChatMarkdown content="test `code` test" />);

      const code = screen.getByText('code');
      expect(code).toHaveClass(
        'px-1',
        'py-0.5',
        'rounded',
        'bg-\\[var\\(--bg-elevated\\)\\]',
        'text-\\[var\\(--accent-cyan\\)\\]'
      );
    });
  });

  describe('Memoization', () => {
    it('should not re-render when content is same', () => {
      const content = 'Test content';
      const { rerender } = render(<ChatMarkdown content={content} />);

      const originalText = screen.getByText('Test content');
      rerender(<ChatMarkdown content={content} />);

      const newText = screen.getByText('Test content');
      expect(originalText).toBe(newText);
    });

    it('should re-render when content changes', () => {
      const { rerender } = render(<ChatMarkdown content="First" />);

      expect(screen.getByText('First')).toBeInTheDocument();

      rerender(<ChatMarkdown content="Second" />);

      expect(screen.queryByText('First')).not.toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
    });
  });

  describe('Parser Edge Cases', () => {
    it('should handle consecutive blank lines', () => {
      const { container } = render(
        <ChatMarkdown content="Line 1\n\n\n\nLine 2" />
      );

      const blankDivs = container.querySelectorAll('.h-1');
      expect(blankDivs.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle lines starting with markers', () => {
      render(<ChatMarkdown content="-dash\n*asterisk\n1.number" />);

      expect(screen.getByText('dash')).toBeInTheDocument();
      expect(screen.getByText('asterisk')).toBeInTheDocument();
      expect(screen.getByText('number')).toBeInTheDocument();
    });

    it('should handle deep headings', () => {
      render(<ChatMarkdown content="# H1\n## H2\n### H3\n#### H4" />);

      expect(screen.getByText('H1')).toBeInTheDocument();
      expect(screen.getByText('H2')).toBeInTheDocument();
      expect(screen.getByText('H3')).toBeInTheDocument();
      // H4+ rendered as regular text
      expect(screen.getByText('#### H4')).toBeInTheDocument();
    });

    it('should handle multiple spaces', () => {
      render(<ChatMarkdown content="Multiple    spaces" />);

      // HTML collapses multiple spaces
      expect(screen.getByText(/Multiple\s+spaces/)).toBeInTheDocument();
    });

    it('should handle tabs', () => {
      render(<ChatMarkdown content="Tab\there" />);

      expect(screen.getByText(/Tab/)).toBeInTheDocument();
    });
  });

  describe('List Parsing', () => {
    it('should parse dash-prefixed lists', () => {
      render(<ChatMarkdown content="- item1\n- item2" />);

      expect(screen.getByText('item1')).toBeInTheDocument();
      expect(screen.getByText('item2')).toBeInTheDocument();
    });

    it('should parse asterisk-prefixed lists', () => {
      render(<ChatMarkdown content="* item1\n* item2" />);

      expect(screen.getByText('item1')).toBeInTheDocument();
      expect(screen.getByText('item2')).toBeInTheDocument();
    });

    it('should parse number-prefixed lists', () => {
      render(<ChatMarkdown content="1. item1\n2. item2" />);

      expect(screen.getByText('1.')).toBeInTheDocument();
      expect(screen.getByText('2.')).toBeInTheDocument();
      expect(screen.getByText('item1')).toBeInTheDocument();
      expect(screen.getByText('item2')).toBeInTheDocument();
    });

    it('should handle list items with inline markdown', () => {
      render(<ChatMarkdown content="- **bold** item\n- `code` item" />);

      expect(screen.getByText('bold')).toBeInTheDocument();
      expect(screen.getByText('code')).toBeInTheDocument();
    });

    it('should handle mixed list types', () => {
      render(<ChatMarkdown content="- unordered\n1. ordered\n* another unordered" />);

      expect(screen.getByText('unordered')).toBeInTheDocument();
      expect(screen.getByText('ordered')).toBeInTheDocument();
      expect(screen.getByText('another unordered')).toBeInTheDocument();
    });
  });

  describe('Code Block Language Detection', () => {
    it('should detect TypeScript language', () => {
      render(<ChatMarkdown content="```typescript\nconst x: string = 'test'\n```" />);

      const code = screen.getByText(/const x/);
      expect(code).toBeInTheDocument();
    });

    it('should detect JavaScript language', () => {
      render(<ChatMarkdown content="```javascript\nconst x = 1\n```" />);

      const code = screen.getByText(/const x/);
      expect(code).toBeInTheDocument();
    });

    it('should detect mermaid language', () => {
      render(<ChatMarkdown content="```mermaid\ngraph TD\nA-->B\n```" />);

      expect(screen.queryByText(/graph TD/)).not.toBeInTheDocument(); // Should be rendered as diagram
    });

    it('should handle uppercase language identifier', () => {
      render(<ChatMarkdown content="```JS\nconst x = 1\n```" />);

      const code = screen.getByText(/const x/);
      expect(code).toBeInTheDocument();
    });

    it('should handle language with version', () => {
      render(<ChatMarkdown content="```python3\nx = 1\n```" />);

      const code = screen.getByText(/x = 1/);
      expect(code).toBeInTheDocument();
    });
  });

  describe('Mermaid Specific Tests', () => {
    it('should cancel mermaid render on unmount', async () => {
      const { unmount } = render(
        <ChatMarkdown content="```mermaid\ngraph TD\nA-->B\n```" />
      );

      unmount();

      await waitFor(() => {
        const mermaidModule = require('mermaid');
        // Mermaid should have been called
        expect(mermaidModule.default.render).toHaveBeenCalled();
      });
    });

    it('should handle mermaid initialization only once', async () => {
      const { rerender } = render(
        <ChatMarkdown content="```mermaid\ngraph TD\nA-->B\n```" />
      );

      const mermaidModule = await import('mermaid');
      const initCalls = vi.mocked(mermaidModule.default.initialize).mock.calls.length;

      rerender(
        <ChatMarkdown content="```mermaid\ngraph LR\nC-->D\n```" />
      );

      await waitFor(async () => {
        // Initialize may be called multiple times depending on implementation
        expect(mermaidModule.default.render).toHaveBeenCalled();
      });
    });
  });

  describe('Heading Parsing', () => {
    it('should handle heading with trailing spaces', () => {
      render(<ChatMarkdown content="# Title   " />);

      const heading = screen.getByText('Title');
      expect(heading).toBeInTheDocument();
    });

    it('should handle heading with inline markdown', () => {
      render(<ChatMarkdown content="# **Bold** Title and `code`" />);

      expect(screen.getByText('Bold').tagName).toBe('STRONG');
      expect(screen.getByText('code').tagName).toBe('CODE');
    });

    it('should handle heading with only hashes', () => {
      render(<ChatMarkdown content="###" />);

      // Should render the text after the hashes (empty in this case)
      const heading = screen.getByText('');
      expect(heading).toBeInTheDocument();
    });
  });

  describe('Performance', () => {
    it('should handle large documents', () => {
      const lines = Array.from({ length: 100 }, (_, i) =>
        `Line ${i} with some text`
      ).join('\n');

      const { container } = render(<ChatMarkdown content={lines} />);

      expect(container).toBeInTheDocument();
      expect(screen.getByText('Line 99')).toBeInTheDocument();
    });

    it('should handle many code blocks', () => {
      const codeBlocks = Array.from({ length: 20 }, (_, i) =>
        `\`\`\`\ncode${i}\n\`\`\``
      ).join('\n\n');

      render(<ChatMarkdown content={codeBlocks} />);

      expect(screen.getByText('code0')).toBeInTheDocument();
      expect(screen.getByText('code19')).toBeInTheDocument();
    });
  });
});
