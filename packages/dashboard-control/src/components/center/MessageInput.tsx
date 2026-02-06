import { useRef, useEffect } from 'react';
import { useCockpit } from '@/hooks/use-cockpit-store';

export function MessageInput() {
  const { state, set, handleSendMessage } = useCockpit();
  const { inputVisible, messageDraft, sendingMessage, focusData, commandStatus } = state;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const trimmedDraft = messageDraft.trim();
  const isCommand = trimmedDraft.startsWith('/');

  useEffect(() => {
    if (inputVisible) inputRef.current?.focus();
  }, [inputVisible]);

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
    <div className="shrink-0 border-t border-[var(--border-subtle)] p-2 space-y-1">
      <textarea
        ref={inputRef}
        value={messageDraft}
        onChange={(e) => set({ messageDraft: e.target.value })}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            void handleSendMessage();
          }
        }}
        placeholder={focusData?.sessionKey ? `Message ${focusData.sessionKey} · /grep ...` : 'Type /grep, /grep repo, /browser, /doc'}
        className="w-full min-h-14 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[12px] text-[var(--text-secondary)]"
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--text-muted)]">
          {commandStatus || 'Ctrl+Enter send · /grep (sessions) · /grep repo (code) · Esc close'}
        </span>
        <button
          onClick={() => void handleSendMessage()}
          disabled={sendingMessage || !trimmedDraft || (!focusData?.sessionKey && !isCommand)}
          className="px-2 py-0.5 text-[11px] rounded bg-[var(--running)]/20 text-[var(--running)] hover:bg-[var(--running)]/30 disabled:opacity-60"
        >
          {sendingMessage ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
