import { memo, useEffect, useMemo, useRef } from 'react';
import { useCockpit, selectFilteredEvents, type EventFilter } from '@/hooks/use-cockpit-store';
import { formatRelativeFromIso } from '@/lib/format';
import {
  asRecord,
  eventLabel,
  extractMessageContent,
  isFailureEvent,
  isMessageLikeEvent,
  messageRoleForEvent,
} from '@/lib/events';

const FILTERS: { key: EventFilter; label: string }[] = [
  { key: 'messages', label: 'Messages' },
  { key: 'signal', label: 'Signal' },
  { key: 'all', label: 'All' },
  { key: 'failures', label: 'Failures' },
  { key: 'audit', label: 'Audit' },
];

const ChatMessage = memo(function ChatMessage({ event }: { event: { at: string; type: string; payload: Record<string, unknown> } }) {
  const role = messageRoleForEvent(event as Parameters<typeof messageRoleForEvent>[0]);
  const content = extractMessageContent(event.payload);
  if (!content) return null;
  const isUser = role === 'user';

  return (
    <div className={`px-3 py-2 border-b border-[var(--border-subtle)] ${isUser ? 'bg-[var(--bg-hover)]/40' : ''}`}>
      <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] mb-0.5">
        <span className={`font-medium ${isUser ? 'text-[var(--accent-violet)]' : 'text-[var(--accent-cyan)]'}`}>
          {isUser ? 'You' : 'Agent'}
        </span>
        <span>{formatRelativeFromIso(event.at)}</span>
      </div>
      <div className="text-xs text-[var(--text-primary)] whitespace-pre-wrap break-words leading-relaxed">
        {content.slice(0, 2000)}
      </div>
    </div>
  );
});

const EventRow = memo(function EventRow({ event, eventFilter }: { event: { at: string; type: string; payload: Record<string, unknown>; signalPriority?: string; isStatusOnly?: boolean }; eventFilter: EventFilter }) {
  if (!event?.payload || typeof event.payload !== 'object') {
    return (
      <div className="px-2 py-1.5 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)]">
        <span className="uppercase">{event?.type ?? 'event'}</span>
        <span className="ml-auto">{event?.at ? formatRelativeFromIso(event.at) : ''}</span>
      </div>
    );
  }
  const data = asRecord(event.payload.data);
  const isTool = event.type === 'tool';
  const isMessage = isMessageLikeEvent(event as Parameters<typeof isMessageLikeEvent>[0]);
  const isFailure = isFailureEvent(event as Parameters<typeof isFailureEvent>[0]);
  const messageRole = isMessage ? messageRoleForEvent(event as Parameters<typeof messageRoleForEvent>[0]) : 'message';
  const messageContent = isMessage ? extractMessageContent(event.payload) : '';
  const toolName = isTool ? (typeof data?.tool_name === 'string' ? data.tool_name : null) : null;
  const toolPhase = isTool ? (typeof data?.phase === 'string' ? data.phase : null) : null;
  const toolDuration = isTool && typeof data?.duration_ms === 'number' ? data.duration_ms : null;
  const toolArgs = isTool && data?.arguments ? data.arguments as Record<string, unknown> : null;
  const showToolDetail = eventFilter === 'audit' || isFailure;
  const toolFile = typeof toolArgs?.file_path === 'string' ? toolArgs.file_path
    : typeof toolArgs?.path === 'string' ? toolArgs.path
    : typeof toolArgs?.command === 'string' ? (toolArgs.command as string).slice(0, 80)
    : null;
  const isHighSignal = event.signalPriority === 'high' || (!event.signalPriority && isMessage && messageRole === 'assistant' && messageContent.length > 50);

  return (
    <div className={`px-2 py-1.5 border-b border-[var(--border-subtle)] ${isFailure ? 'bg-[var(--error)]/5' : ''} ${isHighSignal ? 'bg-[var(--success)]/5' : ''}`}>
      <div className="flex items-center gap-2 text-[11px]">
        <span className={`uppercase font-medium ${
          isMessage ? 'text-[var(--running)]'
          : isTool ? 'text-[var(--accent-cyan)]'
          : isFailure ? 'text-[var(--error)]'
          : 'text-[var(--text-muted)]'
        }`}>
          {isMessage ? messageRole : event.type}
        </span>
        {toolName && <span className="text-[var(--text-primary)] font-mono text-[11px]">{toolName}</span>}
        {!toolName && !isMessage && <span className="text-[var(--text-muted)]">{eventLabel(event as Parameters<typeof eventLabel>[0])}</span>}
        {toolPhase === 'completed' && toolDuration !== null && <span className="text-[10px] text-[var(--text-muted)]">{toolDuration}ms</span>}
        <span className="text-[var(--text-muted)] ml-auto shrink-0">{formatRelativeFromIso(event.at)}</span>
      </div>
      {showToolDetail && toolFile && (
        <div className="text-[11px] text-[var(--text-muted)] mt-0.5 font-mono truncate pl-4">{toolFile}</div>
      )}
      {isMessage && messageContent && (
        <div className="text-xs text-[var(--text-secondary)] mt-0.5 whitespace-pre-wrap break-words line-clamp-6">
          {messageContent.slice(0, 500)}
        </div>
      )}
      {isFailure && !isMessage && (
        <div className="text-[11px] text-[var(--error)] mt-0.5 truncate">
          {typeof data?.error === 'string' ? data.error.slice(0, 200) : typeof event.payload.eventType === 'string' ? event.payload.eventType : ''}
        </div>
      )}
    </div>
  );
});

export function EventDrawer() {
  const { state, set } = useCockpit();
  const { eventFilter, eventDrawerOpen } = state;
  const filteredEvents = useMemo(() => selectFilteredEvents(state), [state.events, state.eventFilter]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isChatMode = eventFilter === 'messages';

  // Auto-scroll to bottom when drawer opens or new messages arrive in chat mode
  useEffect(() => {
    if (eventDrawerOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [eventDrawerOpen, filteredEvents.length]);

  return (
    <div className={`border-t border-[var(--border-subtle)] flex flex-col transition-[max-height] duration-200 ${
      eventDrawerOpen ? (isChatMode ? 'max-h-[40vh]' : 'max-h-[30vh]') : 'max-h-6'
    }`}>
      {/* Header bar — toggle + filter pills side by side */}
      <div className="shrink-0 flex items-center justify-between px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
        <button
          onClick={() => set({ eventDrawerOpen: !eventDrawerOpen })}
          className="hover:bg-[var(--bg-hover)] px-1 py-0.5 rounded"
        >
          {eventDrawerOpen ? '\u25BE' : '\u25B8'} {isChatMode ? 'Chat' : 'Events'} ({filteredEvents.length})
        </button>
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => set({ eventFilter: f.key })}
              className={`px-1.5 py-0.5 rounded text-[10px] ${
                eventFilter === f.key
                  ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                  : 'hover:bg-[var(--bg-hover)]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content — hidden via CSS when collapsed to preserve scroll position */}
      <div
        ref={scrollRef}
        className={`flex-1 min-h-0 overflow-y-auto ${eventDrawerOpen ? '' : 'invisible h-0 overflow-hidden'}`}
      >
        {filteredEvents.length === 0 ? (
          <div className="p-3 text-xs text-[var(--text-muted)]">
            {isChatMode ? 'No messages yet. Send a message below.' : 'No events.'}
          </div>
        ) : isChatMode ? (
          filteredEvents.map((event, idx) => (
            <ChatMessage key={`${event.at}-${idx}`} event={event} />
          ))
        ) : (
          filteredEvents.map((event, idx) => (
            <EventRow key={`${event.at}-${idx}`} event={event} eventFilter={eventFilter} />
          ))
        )}
      </div>
    </div>
  );
}
