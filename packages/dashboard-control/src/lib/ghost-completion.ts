/**
 * CM6 Ghost Text Inline Completion Extension
 *
 * Copilot-style ghost text powered by a streaming LLM backend.
 * Self-contained: StateField + ViewPlugin + keybindings + widget + theme.
 *
 * State machine:
 *   idle ──(debounce)──> requesting ──(tokens)──> showing ──(type/Esc)──> idle
 *                                                     └──(Tab)──> idle (inserted)
 *                                                     └──(Ctrl+Right)──> showing (partial)
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
    // Handle multi-line: split on newlines, join with <br>
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
        return false; // stop
      }
    },
  });
  return inside;
}

function shouldSuppress(view: EditorView): boolean {
  const state = view.state;
  // Suppress if read-only
  if (state.readOnly) return true;
  // Suppress if CM autocomplete dropdown is open
  if (completionStatus(state) !== null) return true;
  // Suppress if cursor is inside a fenced code block
  if (isInsideFencedCode(state)) return true;
  return false;
}

// ── ViewPlugin (debounce + fetch lifecycle) ─────────────────────────

function ghostPlugin(config: GhostCompletionConfig) {
  const debounceMs = config.debounceMs ?? 300;
  const maxContext = config.maxContextChars ?? 1500;

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
        if (shouldSuppress(view)) return;

        const state = view.state;
        const pos = state.selection.main.head;
        const docText = state.doc.toString();
        const textBefore = docText.slice(Math.max(0, pos - maxContext), pos);
        const textAfter = docText.slice(pos, Math.min(docText.length, pos + 500));

        if (textBefore.trim().length === 0) return;

        const anchorPos = pos;
        controller = new AbortController();
        const signal = controller.signal;
        let accumulated = '';

        config.fetchCompletion(textBefore, textAfter, signal, (token) => {
          // Stale guard: cursor must still be at the anchor position
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
          // Clear any existing ghost and restart debounce
          if (view.state.field(ghostField) !== null) {
            view.dispatch({ effects: clearGhost.of(undefined) });
          }
          abort();
          scheduleRequest();
        } else if (update.selectionSet) {
          // Cursor moved without doc change — clear ghost, abort inflight
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
  // Skip leading whitespace
  while (i < text.length && /\s/.test(text[i])) i++;
  // Advance to next boundary (whitespace or end)
  while (i < text.length && !/\s/.test(text[i])) i++;
  return Math.max(i, 1); // accept at least 1 char
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
        // Accept all
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
