import { useEffect, useImperativeHandle, useMemo, useRef, forwardRef } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  type Completion,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { markdownDecorations, cockpitEditorTheme } from './markdown-extensions';
import { detectAtMention, rankPathSuggestions } from '@/lib/autocomplete';
import { ghostCompletion } from '@/lib/ghost-completion';
import { streamCompletion } from '@/lib/api/autocomplete';

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
  fileSuggestions?: string[];
  autocompleteEnabled?: boolean;
}

const STATIC_MARKDOWN_COMPLETIONS: Completion[] = [
  { label: 'title', type: 'property' },
  { label: 'summary', type: 'property' },
  { label: 'context', type: 'property' },
  { label: 'steps', type: 'property' },
  { label: 'notes', type: 'property' },
  { label: 'sessionKey', type: 'property' },
  { label: 'template', type: 'property' },
  { label: 'templateId', type: 'property' },
  { label: 'specs', type: 'property' },
  { label: 'workflow', type: 'keyword' },
  { label: 'executable', type: 'keyword' },
  { label: 'issue', type: 'keyword' },
  { label: 'checklist', type: 'keyword' },
  { label: 'acceptance-criteria', type: 'keyword' },
];

function buildAutocompleteSource(fileSuggestions: string[]) {
  const mentionPool = Array.from(new Set(fileSuggestions.filter((path) => path && path.trim().length > 0)));
  return (context: CompletionContext) => {
    const line = context.state.doc.lineAt(context.pos);
    const mentionInLine = detectAtMention(line.text, context.pos - line.from);
    if (mentionInLine) {
      const options = rankPathSuggestions(mentionPool, mentionInLine.query, 12).map((path) => ({
        label: `@${path}`,
        type: 'variable',
        apply: `@${path}`,
      }));
      if (options.length === 0) return null;
      return {
        from: line.from + mentionInLine.from,
        to: line.from + mentionInLine.to,
        options,
        validFor: /@[A-Za-z0-9_./-]*/,
      };
    }

    const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_-]*/);
    if (!word) {
      if (!context.explicit) return null;
      return { from: context.pos, options: STATIC_MARKDOWN_COMPLETIONS };
    }
    if (word.from === word.to && !context.explicit) return null;

    const query = word.text.toLowerCase();
    const options = STATIC_MARKDOWN_COMPLETIONS
      .filter((item) => query.length === 0 || item.label.toLowerCase().includes(query))
      .slice(0, 12);

    if (options.length === 0 && !context.explicit) return null;
    return {
      from: word.from,
      to: context.pos,
      options: options.length > 0 ? options : STATIC_MARKDOWN_COMPLETIONS.slice(0, 8),
      validFor: /[A-Za-z0-9_-]*/,
    };
  };
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
  function MarkdownEditor({ content, onChange, readOnly, placeholder, fileSuggestions = [], autocompleteEnabled = false }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const pendingChangeRef = useRef<string | null>(null);
    const pendingChangeTimerRef = useRef<number | null>(null);
    const autocompleteEnabledRef = useRef(autocompleteEnabled);
    autocompleteEnabledRef.current = autocompleteEnabled;
    const readOnlyCompartment = useRef(new Compartment());
    const autocompleteCompartment = useRef(new Compartment());
    const completionSource = useMemo(
      () => buildAutocompleteSource(fileSuggestions),
      [fileSuggestions],
    );
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
          ghostCompletion({
            fetchCompletion: (textBefore, textAfter, signal, onToken) =>
              streamCompletion({ textBefore, textAfter }, signal, onToken),
            isEnabled: () => autocompleteEnabledRef.current,
          }),
          keymap.of([
            ...closeBracketsKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          history(),
          closeBrackets(),
          autocompleteCompartment.current.of(autocompletion({
            activateOnTyping: true,
            override: [completionSource, completeAnyWord],
          })),
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

    // Sync external content changes into CodeMirror
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const currentDoc = view.state.doc.toString();
      if (content !== currentDoc) {
        clearPendingChange();
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

    // Sync autocomplete source.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: autocompleteCompartment.current.reconfigure(autocompletion({
          activateOnTyping: true,
          override: [completionSource, completeAnyWord],
        })),
      });
    }, [completionSource]);

    return <div ref={containerRef} className="h-full min-h-0 overflow-hidden" />;
  },
);

export { MarkdownEditor };
export default MarkdownEditor;
