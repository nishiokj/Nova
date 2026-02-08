/**
 * CM6 Ghost Text Inline Completion Extension
 *
 * Inline ghost text powered by a configurable LLM endpoint.
 * Self-contained: StateField + ViewPlugin + keybindings + widget + theme.
 *
 * Only triggers when you've genuinely stopped typing at a natural boundary —
 * end of sentence, end of line, empty line, or after a heading. Not mid-word.
 *
 * State machine:
 *   idle ──(pause ~1s at boundary)──> requesting ──(tokens)──> showing
 *     showing ──(type/Esc)──> idle
 *     showing ──(Tab)──> idle (inserted)
 *     showing ──(Ctrl+Right)──> showing (partial accept)
 */

import {
  type Extension,
  StateField,
  StateEffect,
  type Transaction,
} from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  Decoration,
  WidgetType,
  keymap,
} from '@codemirror/view';
import { completionStatus } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';

// ── Public config ───────────────────────────────────────────────────

export interface GhostCompletionConfig {
  fetchCompletion: (
    textBefore: string,
    textAfter: string,
    signal: AbortSignal,
    onToken: (token: string) => void,
  ) => Promise<void>;
  /** Return false to suppress all ghost completions. Checked before each request. */
  isEnabled?: () => boolean;
  debounceMs?: number;
  maxContextChars?: number;
}

// ── State ───────────────────────────────────────────────────────────

interface GhostState {
  text: string;
  anchorPos: number;
}

const setGhost = StateEffect.define<GhostState>();
const clearGhost = StateEffect.define<void>();

const ghostField = StateField.define<GhostState | null>({
  create: () => null,
  update(value, tr: Transaction) {
    for (const e of tr.effects) {
      if (e.is(setGhost)) return e.value;
      if (e.is(clearGhost)) return null;
    }
    // Any doc change or cursor movement clears the ghost
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
});

// ── Widget ──────────────────────────────────────────────────────────

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) { super(); }

  eq(other: GhostTextWidget): boolean { return this.text === other.text; }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ghost-text';
    const parts = this.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) span.appendChild(document.createElement('br'));
      span.appendChild(document.createTextNode(parts[i]));
    }
    return span;
  }

  ignoreEvent(): boolean { return true; }
}

// ── Decoration layer ────────────────────────────────────────────────

const ghostDecorations = EditorView.decorations.compute([ghostField], (state) => {
  const ghost = state.field(ghostField);
  if (!ghost || ghost.text.length === 0) return Decoration.none;
  return Decoration.set([
    Decoration.widget({
      widget: new GhostTextWidget(ghost.text),
      side: 1,
    }).range(ghost.anchorPos),
  ]);
});

// ── Guards ──────────────────────────────────────────────────────────

function isInsideFencedCode(state: import('@codemirror/state').EditorState): boolean {
  const pos = state.selection.main.head;
  let inside = false;
  syntaxTree(state).iterate({
    from: 0,
    to: pos + 1,
    enter(node) {
      if (node.name === 'FencedCode' && node.from <= pos && node.to >= pos) {
        inside = true;
        return false;
      }
    },
  });
  return inside;
}

/** Check if the cursor is at a position where a suggestion would be useful. */
function isAtNaturalBoundary(state: import('@codemirror/state').EditorState): boolean {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const textBeforeCursor = line.text.slice(0, pos - line.from);
  const textAfterCursor = line.text.slice(pos - line.from);

  // Empty line or line with only whitespace — good place for a suggestion
  if (textBeforeCursor.trim().length === 0) {
    // But only if there's meaningful content above (not a blank doc)
    return pos > 50;
  }

  // Substantial text after cursor on this line — we're editing mid-line, skip
  if (textAfterCursor.trim().length > 3) return false;

  // Cursor at or near end of line — check if the line ends naturally
  const trimmed = textBeforeCursor.trimEnd();

  // After a heading (# ...) — scaffold the section
  if (/^#{1,6}\s+.+/.test(trimmed)) return true;

  // End of sentence (., !, ?, :, ;)
  if (/[.!?:;]\s*$/.test(trimmed)) return true;

  // After a list marker with content (- item, * item, 1. item)
  if (/^[\s]*[-*]\s+.{5,}$/.test(trimmed)) return true;
  if (/^[\s]*\d+\.\s+.{5,}$/.test(trimmed)) return true;

  // End of a paragraph-length line (40+ chars, cursor at end)
  if (trimmed.length >= 40 && textAfterCursor.trim().length === 0) return true;

  return false;
}

function shouldSuppress(view: EditorView, isEnabled?: () => boolean): boolean {
  if (isEnabled && !isEnabled()) return true;
  const state = view.state;
  if (state.readOnly) return true;
  if (completionStatus(state) !== null) return true;
  if (isInsideFencedCode(state)) return true;
  if (state.doc.length < 50) return true;
  if (!isAtNaturalBoundary(state)) return true;
  return false;
}

// ── ViewPlugin (debounce + fetch lifecycle) ─────────────────────────

function ghostPlugin(config: GhostCompletionConfig) {
  const debounceMs = config.debounceMs ?? 900;
  const maxContext = config.maxContextChars ?? 800;
  const isEnabled = config.isEnabled;

  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    function abort() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (controller) { controller.abort(); controller = null; }
    }

    function scheduleRequest() {
      abort();
      timer = setTimeout(() => {
        timer = null;
        if (shouldSuppress(view, isEnabled)) return;

        const state = view.state;
        const pos = state.selection.main.head;
        const docText = state.doc.toString();
        const textBefore = docText.slice(Math.max(0, pos - maxContext), pos);
        const textAfter = docText.slice(pos, Math.min(docText.length, pos + 300));

        const anchorPos = pos;
        controller = new AbortController();
        const signal = controller.signal;
        let accumulated = '';

        config.fetchCompletion(textBefore, textAfter, signal, (token) => {
          if (view.state.selection.main.head !== anchorPos) {
            controller?.abort();
            return;
          }
          accumulated += token;
          view.dispatch({ effects: setGhost.of({ text: accumulated, anchorPos }) });
        }).catch(() => {
          // Aborted or network error — ignore silently
        }).finally(() => {
          controller = null;
        });
      }, debounceMs);
    }

    return {
      update(update: ViewUpdate) {
        if (update.docChanged) {
          if (view.state.field(ghostField) !== null) {
            view.dispatch({ effects: clearGhost.of(undefined) });
          }
          abort();
          scheduleRequest();
        } else if (update.selectionSet) {
          if (view.state.field(ghostField) !== null) {
            view.dispatch({ effects: clearGhost.of(undefined) });
          }
          abort();
        }
      },
      destroy() {
        abort();
      },
    };
  });
}

// ── Keybindings ─────────────────────────────────────────────────────

function findNextWordBoundary(text: string): number {
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return Math.max(i, 1);
}

const ghostKeymap = keymap.of([
  {
    key: 'Tab',
    run(view) {
      const ghost = view.state.field(ghostField);
      if (!ghost) return false;
      view.dispatch({
        changes: { from: ghost.anchorPos, insert: ghost.text },
        selection: { anchor: ghost.anchorPos + ghost.text.length },
        effects: clearGhost.of(undefined),
      });
      return true;
    },
  },
  {
    key: 'Mod-Right',
    run(view) {
      const ghost = view.state.field(ghostField);
      if (!ghost) return false;
      const boundary = findNextWordBoundary(ghost.text);
      const accepted = ghost.text.slice(0, boundary);
      const remainder = ghost.text.slice(boundary);

      if (remainder.length === 0) {
        view.dispatch({
          changes: { from: ghost.anchorPos, insert: ghost.text },
          selection: { anchor: ghost.anchorPos + ghost.text.length },
          effects: clearGhost.of(undefined),
        });
      } else {
        const newAnchor = ghost.anchorPos + accepted.length;
        view.dispatch({
          changes: { from: ghost.anchorPos, insert: accepted },
          selection: { anchor: newAnchor },
          effects: setGhost.of({ text: remainder, anchorPos: newAnchor }),
        });
      }
      return true;
    },
  },
  {
    key: 'Escape',
    run(view) {
      const ghost = view.state.field(ghostField);
      if (!ghost) return false;
      view.dispatch({ effects: clearGhost.of(undefined) });
      return true;
    },
  },
]);

// ── Theme ───────────────────────────────────────────────────────────

const ghostTheme = EditorView.baseTheme({
  '.cm-ghost-text': {
    opacity: '0.4',
    fontStyle: 'italic',
    pointerEvents: 'none',
    userSelect: 'none',
  },
});

// ── Factory ─────────────────────────────────────────────────────────

export function ghostCompletion(config: GhostCompletionConfig): Extension {
  return [ghostField, ghostPlugin(config), ghostKeymap, ghostDecorations, ghostTheme];
}
