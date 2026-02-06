import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdownDecorations, cockpitEditorTheme } from './markdown-extensions';

export interface EditorHandle {
  focus(): void;
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
  if (e.ctrlKey && e.key === 'Enter') return true;
  if (e.key === 'Escape') return true;
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'h' || k === 'j' || k === 'k' || k === 'l') return true;
  }
  return false;
}

export const MarkdownEditor = forwardRef<EditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ content, onChange, readOnly, placeholder }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const readOnlyCompartment = useRef(new Compartment());

    // Expose imperative handle
    useImperativeHandle(ref, () => ({
      focus() {
        viewRef.current?.focus();
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
          onChangeRef.current(update.state.doc.toString());
        }
      });

      const state = EditorState.create({
        doc: content,
        extensions: [
          passthroughKeymap,
          keymap.of([
            ...closeBracketsKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          history(),
          closeBrackets(),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          markdownDecorations,
          cockpitEditorTheme,
          updateListener,
          EditorView.lineWrapping,
          readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly ?? false)),
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
        ],
      });

      const view = new EditorView({ state, parent: containerRef.current });
      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
    }, []);

    // Sync external content changes into CodeMirror
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const currentDoc = view.state.doc.toString();
      if (content !== currentDoc) {
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
