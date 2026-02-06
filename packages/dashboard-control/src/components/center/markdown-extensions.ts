import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';

// --- Line decorations (headings, blockquotes, HR) ---

const headingLineDecos: Record<string, Decoration> = {
  ATXHeading1: Decoration.line({ class: 'cm-h1' }),
  ATXHeading2: Decoration.line({ class: 'cm-h2' }),
  ATXHeading3: Decoration.line({ class: 'cm-h3' }),
  ATXHeading4: Decoration.line({ class: 'cm-h4' }),
  ATXHeading5: Decoration.line({ class: 'cm-h5' }),
  ATXHeading6: Decoration.line({ class: 'cm-h6' }),
  SetextHeading1: Decoration.line({ class: 'cm-h1' }),
  SetextHeading2: Decoration.line({ class: 'cm-h2' }),
};

const blockquoteLineDeco = Decoration.line({ class: 'cm-blockquote' });
const hrLineDeco = Decoration.line({ class: 'cm-hr' });

// --- Inline mark decorations ---

const strongMark = Decoration.mark({ class: 'cm-strong' });
const emMark = Decoration.mark({ class: 'cm-em' });
const inlineCodeMark = Decoration.mark({ class: 'cm-code' });
const linkUrlMark = Decoration.mark({ class: 'cm-link' });
const syntaxDimMark = Decoration.mark({ class: 'cm-syntax-dim' });
const listMarkDeco = Decoration.mark({ class: 'cm-list-mark' });

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const name = node.type.name;

        // Line-level heading decorations
        if (name in headingLineDecos) {
          const doc = view.state.doc;
          const startLine = doc.lineAt(node.from).number;
          const endLine = doc.lineAt(node.to).number;
          for (let ln = startLine; ln <= endLine; ln++) {
            ranges.push(headingLineDecos[name].range(doc.line(ln).from));
          }
          return;
        }

        // Blockquote lines
        if (name === 'Blockquote') {
          const doc = view.state.doc;
          const startLine = doc.lineAt(node.from).number;
          const endLine = doc.lineAt(node.to).number;
          for (let ln = startLine; ln <= endLine; ln++) {
            ranges.push(blockquoteLineDeco.range(doc.line(ln).from));
          }
          return;
        }

        // Horizontal rule
        if (name === 'HorizontalRule') {
          ranges.push(hrLineDeco.range(view.state.doc.lineAt(node.from).from));
          return;
        }

        // Inline: strong emphasis
        if (name === 'StrongEmphasis') {
          ranges.push(strongMark.range(node.from, node.to));
          return;
        }

        // Inline: emphasis
        if (name === 'Emphasis') {
          ranges.push(emMark.range(node.from, node.to));
          return;
        }

        // Inline code
        if (name === 'InlineCode') {
          ranges.push(inlineCodeMark.range(node.from, node.to));
          return;
        }

        // Link URL portion
        if (name === 'URL') {
          ranges.push(linkUrlMark.range(node.from, node.to));
          return;
        }

        // Syntax dimming for marker characters
        if (
          name === 'HeaderMark' ||
          name === 'EmphasisMark' ||
          name === 'CodeMark' ||
          name === 'QuoteMark' ||
          name === 'LinkMark'
        ) {
          ranges.push(syntaxDimMark.range(node.from, node.to));
          return;
        }

        // List markers
        if (name === 'ListMark') {
          ranges.push(listMarkDeco.range(node.from, node.to));
          return;
        }
      },
    });
  }

  // Decorations must be sorted by position
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(ranges);
}

export const markdownDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// --- Theme ---

export const cockpitEditorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    fontSize: '13px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    lineHeight: '1.6',
  },
  '.cm-content': {
    padding: '12px',
    caretColor: 'var(--accent-cyan)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent-cyan)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(121, 192, 255, 0.15) !important',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(110, 118, 129, 0.06)',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },

  // Heading sizes
  '.cm-h1': { fontSize: '1.6em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-h2': { fontSize: '1.35em', fontWeight: '650', lineHeight: '1.35' },
  '.cm-h3': { fontSize: '1.15em', fontWeight: '600', lineHeight: '1.4' },
  '.cm-h4': { fontSize: '1.05em', fontWeight: '600' },
  '.cm-h5': { fontSize: '1em', fontWeight: '600' },
  '.cm-h6': { fontSize: '0.9em', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' },

  // Inline marks
  '.cm-strong': { fontWeight: '700' },
  '.cm-em': { fontStyle: 'italic' },
  '.cm-code': {
    backgroundColor: 'var(--bg-elevated)',
    borderRadius: '3px',
    padding: '1px 4px',
    fontFamily: 'inherit',
  },

  // Blockquotes
  '.cm-blockquote': {
    borderLeft: '3px solid var(--border-default)',
    paddingLeft: '12px',
    color: 'var(--text-secondary)',
  },

  // Horizontal rules
  '.cm-hr': {
    borderBottom: '1px solid var(--border-default)',
    color: 'var(--text-muted)',
  },

  // Links
  '.cm-link': { color: 'var(--accent-cyan)' },

  // List markers
  '.cm-list-mark': { color: 'var(--accent-cyan)' },

  // Syntax dimming for markers (#, **, `, etc.)
  '.cm-syntax-dim': { color: 'var(--text-muted)', opacity: '0.7' },
});
