import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { markdownDecorations, cockpitEditorTheme } from './markdown-extensions';

const CHANGE_SYNC_DEBOUNCE_MS = 90;

export interface EditorHandle {
  focus(): void;
  blur(): void;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

interface MarkdownEditorProps {
  content: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
  placeholder?: string;
}

/** Keybindings that should bubble up to the window-level cockpit handler. */
function isCockpitGlobal(e: KeyboardEvent): boolean {
  if (e.ctrlKey && (e.key === 's' || e.key === 'S')) return true;
  if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) return true;
  if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) return true;
  if (e.ctrlKey && e.key === '`') return true;
  if (e.key === 'Escape') return true;
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'h' || k === 'j' || k === 'k' || k === 'l') return true;
  }
  return false;
}

const MarkdownEditor = forwardRef<EditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ content, onChange, readOnly, placeholder }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const pendingChangeRef = useRef<string | null>(null);
    const pendingChangeTimerRef = useRef<number | null>(null);
    const readOnlyCompartment = useRef(new Compartment());
    // Track the last value we sent to the parent via onChange so we can
    // distinguish our own round-tripped content from genuinely external changes.
    const lastSyncedOutRef = useRef(content);
    const clearPendingChange = () => {
      if (pendingChangeTimerRef.current !== null) {
        window.clearTimeout(pendingChangeTimerRef.current);
        pendingChangeTimerRef.current = null;
      }
      pendingChangeRef.current = null;
    };
    const flushPendingChange = () => {
      if (pendingChangeTimerRef.current !== null) {
        window.clearTimeout(pendingChangeTimerRef.current);
        pendingChangeTimerRef.current = null;
      }
      if (pendingChangeRef.current === null) return;
      const nextDoc = pendingChangeRef.current;
      pendingChangeRef.current = null;
      lastSyncedOutRef.current = nextDoc;
      onChangeRef.current(nextDoc);
    };
    const scheduleChangeSync = (nextDoc: string) => {
      pendingChangeRef.current = nextDoc;
      if (pendingChangeTimerRef.current !== null) {
        window.clearTimeout(pendingChangeTimerRef.current);
      }
      pendingChangeTimerRef.current = window.setTimeout(() => {
        pendingChangeTimerRef.current = null;
        if (pendingChangeRef.current === null) return;
        const latestDoc = pendingChangeRef.current;
        pendingChangeRef.current = null;
        lastSyncedOutRef.current = latestDoc;
        onChangeRef.current(latestDoc);
      }, CHANGE_SYNC_DEBOUNCE_MS);
    };

    // Expose imperative handle
    useImperativeHandle(ref, () => ({
      focus() {
        viewRef.current?.focus();
      },
      blur() {
        viewRef.current?.contentDOM.blur();
      },
      get selectionStart() {
        const sel = viewRef.current?.state.selection.main;
        return sel ? Math.min(sel.anchor, sel.head) : 0;
      },
      get selectionEnd() {
        const sel = viewRef.current?.state.selection.main;
        return sel ? Math.max(sel.anchor, sel.head) : 0;
      },
    }));

    // Create editor once
    useEffect(() => {
      if (!containerRef.current) return;

      // Highest-priority keymap: prevent CodeMirror from capturing cockpit globals.
      // `any` returning false = "not handled" → event propagates to window handler.
      const passthroughKeymap = keymap.of([{
        any(_view, e) {
          if (isCockpitGlobal(e)) return false;
          return false;
        },
      }]);

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleChangeSync(update.state.doc.toString());
        }
      });
      const flushOnBlur = EditorView.domEventHandlers({
        blur() {
          flushPendingChange();
          return false;
        },
      });

      const state = EditorState.create({
        doc: content,
        extensions: [
          passthroughKeymap,
          keymap.of([
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          history(),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          markdownDecorations,
          cockpitEditorTheme,
          updateListener,
          flushOnBlur,
          EditorView.lineWrapping,
          readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly ?? false)),
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
        ],
      });

      const view = new EditorView({ state, parent: containerRef.current });
      viewRef.current = view;

      return () => {
        flushPendingChange();
        view.destroy();
        viewRef.current = null;
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
    }, []);

    // Sync external content changes into CodeMirror.
    // Skip if the incoming content is just our own debounced value round-tripping
    // back through the parent — applying it would clobber any characters typed
    // between the debounce flush and this render.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      if (content === lastSyncedOutRef.current) return;
      const currentDoc = view.state.doc.toString();
      if (content !== currentDoc) {
        clearPendingChange();
        lastSyncedOutRef.current = content;
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: content },
        });
      }
    }, [content]);

    // Sync readOnly
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: readOnlyCompartment.current.reconfigure(
          EditorState.readOnly.of(readOnly ?? false),
        ),
      });
    }, [readOnly]);

    return <div ref={containerRef} className="h-full min-h-0 overflow-hidden" />;
  },
);

export { MarkdownEditor };
export default MarkdownEditor;
