/**
 * Markdown rendering utilities using marked-terminal.
 * Provides proper terminal markdown rendering with ANSI codes.
 * Integrates with Tree-sitter syntax highlighting for code blocks.
 */

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { Chalk } from 'chalk';
import { highlightCode } from './syntax.js';

// Create a chalk instance with forced color support
// This bypasses chalk's auto-detection which fails under Bun
const chalk = new Chalk({ level: 3 });

// Create a custom renderer that uses Tree-sitter for code highlighting
const renderer = new marked.Renderer();

// Override the code block renderer
renderer.code = function(code: string, language: string | undefined) {
  // Try Tree-sitter syntax highlighting
  const highlighted = highlightCode(code, language);

  // Tree-sitter adds background internally, return as-is
  return '\n' + highlighted + '\n';
};

// Configure marked with terminal renderer and our custom renderer
marked.use({
  renderer,
  ...markedTerminal({
    // Don't reflowText since we handle wrapping ourselves
    reflowText: false,
    // Keep width large so marked doesn't wrap
    width: 9999,
    // Emoji support
    emoji: true,
    // Custom colors using our forced-color chalk instance
    code: chalk.bgBlack.yellow,  // Fallback (renderer.code handles this)
    blockquote: chalk.gray.italic,
    heading: chalk.magenta.underline.bold,
    firstHeading: chalk.magenta.underline.bold,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.bgBlack.yellow,
    del: chalk.strikethrough,
    link: chalk.blue,
    href: chalk.blue.underline,
    listitem: chalk.reset,
    // Table rendering options
    tableOptions: {
      chars: {
        'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
        'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
        'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
        'right': '│', 'right-mid': '┤', 'middle': '│'
      }
    }
  })
});

/**
 * Render markdown text to terminal-styled text with ANSI codes.
 * The output can be displayed directly in the terminal.
 *
 * Code blocks in supported languages (ts, js, tsx, jsx) will be
 * syntax-highlighted using Tree-sitter from entity-graph.
 */
export function renderMarkdown(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  try {
    // Parse the markdown and return styled text
    const result = marked.parse(text);
    // marked.parse returns string | Promise<string> but with our config it's sync
    if (typeof result === 'string') {
      // Trim trailing newlines that marked adds
      return result.replace(/\n+$/, '');
    }
    return text;
  } catch {
    // If parsing fails, return original text
    return text;
  }
}

/**
 * Wrap text that may contain ANSI codes to fit within a width.
 * Properly handles ANSI escape sequences.
 */
export function wrapAnsiText(text: string, width: number): string[] {
  if (!text || width <= 0) {
    return [''];
  }

  try {
    // wrapAnsi handles ANSI codes properly
    const wrapped = wrapAnsi(text, width, {
      hard: true,  // Hard wrap long words
      wordWrap: true  // Try to break at word boundaries
    });
    return wrapped.split('\n');
  } catch {
    // Fallback to simple split
    return text.split('\n');
  }
}

/**
 * Get the visual width of a string, ignoring ANSI codes.
 * Properly handles wide characters (CJK, emoji, etc.).
 */
export function getVisualWidth(text: string): number {
  if (!text) return 0;
  try {
    return stringWidth(text);
  } catch {
    return text.length;
  }
}

/**
 * Strip ANSI codes from text.
 */
export function removeAnsi(text: string): string {
  if (!text) return '';
  try {
    return stripAnsi(text);
  } catch {
    return text;
  }
}

/**
 * Render markdown and wrap to fit width.
 * This is the main function to use for rendering messages.
 */
export function renderAndWrap(text: string, width: number): string[] {
  if (!text) return [''];

  // First render markdown
  const rendered = renderMarkdown(text);

  // Then wrap with ANSI awareness
  return wrapAnsiText(rendered, width);
}
