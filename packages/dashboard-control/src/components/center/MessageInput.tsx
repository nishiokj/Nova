import { useRef, useEffect, useCallback } from 'react';
import { useCockpit } from '@/hooks/use-cockpit-store';

const MAX_HEIGHT = 120;

function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
}

export function MessageInput() {
  const { state, set, handleSendMessage } = useCockpit();
  const { inputVisible, sendingMessage, focusData, commandStatus, messageDraft: storeDraft } = state;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Derive canSend from store draft (synced on every keystroke)
  const trimmedDraft = storeDraft.trim();
  const isCommand = trimmedDraft.startsWith('/');
  const canSend = !!trimmedDraft && (!!focusData?.sessionKey || isCommand);

  // Focus textarea when chat opens or session changes
  useEffect(() => {
    if (inputVisible) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [inputVisible, focusData?.sessionKey]);

  // Clear textarea DOM when store draft is cleared externally (after send)
  const prevDraftRef = useRef(storeDraft);
  useEffect(() => {
    if (prevDraftRef.current !== '' && storeDraft === '') {
      if (inputRef.current) {
        inputRef.current.value = '';
        autoResize(inputRef.current);
      }
    }
    prevDraftRef.current = storeDraft;
  }, [storeDraft]);

  const handleChange = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    set({ messageDraft: el.value });
    autoResize(el);
  }, [set]);

  const clearInput = useCallback(() => {
    set({ messageDraft: '' });
    if (inputRef.current) {
      inputRef.current.value = '';
      autoResize(inputRef.current);
    }
  }, [set]);

  if (!inputVisible) {
    return (
      <button
        onClick={() => set({ inputVisible: true })}
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
          rows={1}
          defaultValue={storeDraft}
          onChange={handleChange}
          onKeyDown={(e) => {
            // Enter — send (Shift+Enter for newline)
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              if (canSend) void handleSendMessage();
              return;
            }
            // Ctrl+U — clear input (readline kill-line)
            if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
              e.preventDefault();
              clearInput();
              return;
            }
          }}
          placeholder={focusData?.sessionKey ? `Message ${focusData.sessionKey}` : '/grep · /grep repo · /browser · /doc'}
          className="flex-1 min-w-0 resize-none overflow-y-auto bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[12px] text-[var(--text-secondary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-cyan)]/40 leading-snug"
          style={{ maxHeight: MAX_HEIGHT }}
        />
        <button
          onClick={() => void handleSendMessage()}
          disabled={sendingMessage || !canSend}
          className="shrink-0 h-[26px] w-[26px] flex items-center justify-center rounded bg-[var(--running)]/20 text-[var(--running)] hover:bg-[var(--running)]/30 disabled:opacity-30 transition-colors text-xs"
        >
          {sendingMessage ? <span className="animate-pulse">·</span> : '\u21B5'}
        </button>
      </div>
      {commandStatus && (
        <div className="mt-1 text-[10px] text-[var(--text-muted)] truncate">{commandStatus}</div>
      )}
    </div>
  );
}
