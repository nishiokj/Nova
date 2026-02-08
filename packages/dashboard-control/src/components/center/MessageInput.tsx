import { useRef, useEffect, useCallback, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCockpit, useCockpitStore } from '@/hooks/use-cockpit-store';
import { detectAtMention, rankPathSuggestions } from '@/lib/autocomplete';

const MAX_HEIGHT = 120;
const MENTION_LIMIT = 8;

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
}

interface MessageInputProps {
  fileSuggestions?: string[];
}

interface MentionState {
  open: boolean;
  query: string;
  from: number;
  to: number;
  activeIdx: number;
  options: string[];
}

const EMPTY_MENTION: MentionState = {
  open: false,
  query: '',
  from: -1,
  to: -1,
  activeIdx: 0,
  options: [],
};

function isPaneSwitchShortcut(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  if (!event.altKey || event.metaKey || event.ctrlKey) return false;
  const code = event.code;
  const key = event.key.toLowerCase();
  return code === 'KeyH' || code === 'KeyJ' || code === 'KeyK' || code === 'KeyL'
    || key === 'h' || key === 'j' || key === 'k' || key === 'l';
}

export function MessageInput({ fileSuggestions = [] }: MessageInputProps) {
  const inputVisible = useCockpit(s => s.inputVisible);
  const sendingMessage = useCockpit(s => s.sendingMessage);
  const focusData = useCockpit(s => s.focusData);
  const commandStatus = useCockpit(s => s.commandStatus);
  const storeDraft = useCockpit(s => s.messageDraft);
  const store = useCockpitStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(storeDraft);
  const [mention, setMention] = useState<MentionState>(EMPTY_MENTION);
  const mentionPool = useMemo(
    () => Array.from(new Set(fileSuggestions.filter((item) => item && item.trim().length > 0))),
    [fileSuggestions],
  );

  // Keep send affordance aligned with handleSendMessage (which can lazily create context/session).
  const trimmedDraft = draft.trim();
  const canSend = !!trimmedDraft && !sendingMessage;

  // Focus textarea when chat opens or session changes
  useEffect(() => {
    if (inputVisible) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [inputVisible, focusData?.sessionKey]);

  // Sync from store only for external updates (e.g. failed send restore / explicit clear).
  const prevStoreDraftRef = useRef(storeDraft);
  useEffect(() => {
    if (prevStoreDraftRef.current !== storeDraft) {
      setDraft(storeDraft);
      if (!storeDraft) {
        setMention(EMPTY_MENTION);
      }
    }
    prevStoreDraftRef.current = storeDraft;
  }, [storeDraft]);

  useEffect(() => {
    if (!inputRef.current) return;
    autoResize(inputRef.current);
  }, [draft]);

  const clearMention = useCallback(() => {
    setMention((prev) => (prev.open ? EMPTY_MENTION : prev));
  }, []);

  const refreshMention = useCallback(() => {
    const el = inputRef.current;
    if (!el) {
      clearMention();
      return;
    }
    const selectionStart = el.selectionStart ?? el.value.length;
    const selectionEnd = el.selectionEnd ?? selectionStart;
    if (selectionStart !== selectionEnd) {
      clearMention();
      return;
    }
    const match = detectAtMention(el.value, selectionStart);
    if (!match) {
      clearMention();
      return;
    }
    const options = rankPathSuggestions(mentionPool, match.query, MENTION_LIMIT);
    if (options.length === 0) {
      clearMention();
      return;
    }
    setMention((prev) => ({
      open: true,
      query: match.query,
      from: match.from,
      to: match.to,
      options,
      activeIdx: prev.open && prev.query === match.query
        ? Math.max(0, Math.min(prev.activeIdx, options.length - 1))
        : 0,
    }));
  }, [mentionPool, clearMention]);

  const handleChange = useCallback((nextValue: string) => {
    setDraft(nextValue);
    refreshMention();
  }, [refreshMention]);

  const applyMention = useCallback((path: string) => {
    const el = inputRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? el.value.length;
    const match = detectAtMention(el.value, cursor);
    if (!match) {
      clearMention();
      return;
    }
    const before = el.value.slice(0, match.from);
    const after = el.value.slice(match.to);
    let inserted = `@${path}`;
    if (after.length === 0 || !/^\s/.test(after)) inserted += ' ';
    const next = `${before}${inserted}${after}`;
    const nextCursor = (before + inserted).length;
    setDraft(next);
    store.set({ messageDraft: next });
    autoResize(el);
    setMention(EMPTY_MENTION);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(nextCursor, nextCursor);
    });
  }, [store, clearMention]);

  const clearInput = useCallback(() => {
    setDraft('');
    store.set({ messageDraft: '' });
    setMention(EMPTY_MENTION);
  }, [store]);

  const handleSend = useCallback(() => {
    const outgoing = draft.trim();
    if (!outgoing || sendingMessage) return;
    setDraft('');
    store.set({ messageDraft: '' });
    void store.handleSendMessage(draft);
  }, [draft, sendingMessage, store]);

  useEffect(() => {
    if (!inputVisible) {
      setMention(EMPTY_MENTION);
      return;
    }
    refreshMention();
  }, [inputVisible, refreshMention]);

  if (!inputVisible) {
    return (
      <button
        onClick={() => store.set({ inputVisible: true })}
        className="shrink-0 border-t border-[var(--border-subtle)] px-3 py-1.5 text-left text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
      >
        Ctrl+` to chat
      </button>
    );
  }

  return (
    <div className="shrink-0 border-t border-[var(--border-subtle)] px-2 py-1.5">
      <div className="flex items-end gap-1.5">
        <textarea
          ref={inputRef}
          data-cockpit-chat-input="true"
          rows={1}
          value={draft}
          onChange={(event) => handleChange(event.target.value)}
          onSelect={refreshMention}
          onClick={refreshMention}
          onKeyUp={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (
              e.key === 'ArrowLeft'
              || e.key === 'ArrowRight'
              || e.key === 'ArrowUp'
              || e.key === 'ArrowDown'
              || e.key === 'Home'
              || e.key === 'End'
              || e.key === 'Backspace'
              || e.key === 'Delete'
            ) {
              refreshMention();
            }
          }}
          onKeyDown={(e) => {
            // Ctrl+` — let it bubble to global handler for chat toggle
            if (e.ctrlKey && e.key === '`') return;
            // Alt+h/j/k/l — let global pane navigation handler process this.
            if (isPaneSwitchShortcut(e)) return;
            // Keep chat input keyboard handling local; avoid global shortcut interference.
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            if (mention.open) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMention((prev) => ({
                  ...prev,
                  activeIdx: prev.options.length > 0 ? (prev.activeIdx + 1) % prev.options.length : 0,
                }));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMention((prev) => ({
                  ...prev,
                  activeIdx: prev.options.length > 0
                    ? (prev.activeIdx - 1 + prev.options.length) % prev.options.length
                    : 0,
                }));
                return;
              }
              if (
                (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey)
                || (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey)
              ) {
                e.preventDefault();
                const next = mention.options[mention.activeIdx] ?? mention.options[0];
                if (next) applyMention(next);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                clearMention();
                return;
              }
            }
            // Enter — send (Shift+Enter for newline)
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              if (trimmedDraft) handleSend();
              return;
            }
            // Ctrl+U — clear input (readline kill-line)
            if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
              e.preventDefault();
              clearInput();
              return;
            }
          }}
          placeholder={focusData?.sessionKey ? `Message ${focusData.sessionKey}` : '/grep · /browser · /doc'}
          className="flex-1 min-w-0 resize-none overflow-y-auto bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[12px] text-[var(--text-secondary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-cyan)]/40 leading-snug"
          style={{ maxHeight: MAX_HEIGHT }}
        />
        <button
          onClick={handleSend}
          disabled={sendingMessage || !canSend}
          className="shrink-0 h-[26px] w-[26px] flex items-center justify-center rounded bg-[var(--running)]/20 text-[var(--running)] hover:bg-[var(--running)]/30 disabled:opacity-30 transition-colors text-xs"
        >
          {sendingMessage ? <span className="animate-pulse">·</span> : '\u21B5'}
        </button>
      </div>
      {mention.open && (
        <div className="mt-1 border border-[var(--border-subtle)] bg-[var(--bg-elevated)] rounded py-1 max-h-40 overflow-y-auto">
          {mention.options.map((path, idx) => (
            <button
              key={path}
              onMouseDown={(event) => {
                event.preventDefault();
                applyMention(path);
              }}
              className={`w-full text-left px-2 py-1 text-[11px] font-mono ${
                idx === mention.activeIdx
                  ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              @{path}
            </button>
          ))}
        </div>
      )}
      {commandStatus && (
        <div className="mt-1 text-[10px] text-[var(--text-muted)] truncate">{commandStatus}</div>
      )}
    </div>
  );
}
