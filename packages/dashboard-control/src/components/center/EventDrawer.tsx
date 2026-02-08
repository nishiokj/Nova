import { memo, useEffect, useMemo, useRef } from 'react';
import { useCockpit, useCockpitStore, selectFilteredEvents, type EventFilter } from '@/hooks/use-cockpit-store';
import { formatRelativeFromIso } from '@/lib/format';
import {
  asRecord,
  eventLabel,
  extractMessageContent,
  isFailureEvent,
  isMessageLikeEvent,
  messageRoleForEvent,
} from '@/lib/events';
import { ChatMarkdown } from '@/components/shared/ChatMarkdown';

const FILTERS: { key: EventFilter; label: string }[] = [
  { key: 'messages', label: 'Messages' },
  { key: 'all', label: 'All' },
  { key: 'failures', label: 'Failures' },
  { key: 'audit', label: 'Audit' },
];

const ChatMessage = memo(function ChatMessage({ event, toolSummary }: { event: { at: string; type: string; payload: Record<string, unknown> }; toolSummary?: string }) {
  const role = messageRoleForEvent(event as Parameters<typeof messageRoleForEvent>[0]);
  const content = extractMessageContent(event.payload);
  const isUser = role === 'user';

  // Assistant turns that are entirely tool calls have empty content — show a summary instead
  if (!content && !toolSummary) return null;

  return (
    <div className={`px-3 py-2 border-b border-[var(--border-subtle)] ${isUser ? 'bg-[var(--bg-hover)]/40' : ''}`}>
      <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] mb-0.5">
        <span className={`font-medium ${isUser ? 'text-[var(--accent-violet)]' : 'text-[var(--accent-cyan)]'}`}>
          {isUser ? 'You' : 'Agent'}
        </span>
        <span>{formatRelativeFromIso(event.at)}</span>
      </div>
      {content ? (
        <ChatMarkdown content={content.slice(0, 2000)} />
      ) : toolSummary ? (
        <div className="text-[11px] text-[var(--text-muted)] italic">
          {toolSummary}
        </div>
      ) : null}
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

/** Build a tool-activity summary for an empty assistant message by scanning nearby events. */
function buildToolSummary(allEvents: Array<{ at: string; type: string; payload: Record<string, unknown> }>, msgIndex: number): string {
  const tools: string[] = [];
  const files = new Set<string>();
  let toolCalls = 0;
  let llmCalls = 0;
  // Scan backwards from this message for tool/workflow events in the same request window
  for (let i = msgIndex - 1; i >= 0 && i >= msgIndex - 40; i--) {
    const ev = allEvents[i];
    if (!ev) break;
    // Stop at the previous user/assistant message
    if (ev.type === 'message' && isMessageLikeEvent(ev as Parameters<typeof isMessageLikeEvent>[0])) break;
    if (ev.type === 'tool') {
      const data = asRecord(ev.payload.data);
      const name = typeof data?.tool_name === 'string' ? data.tool_name : null;
      if (name && !tools.includes(name)) tools.push(name);
      const args = data?.arguments as Record<string, unknown> | undefined;
      const filePath = typeof args?.file_path === 'string' ? args.file_path
        : typeof args?.path === 'string' ? args.path : null;
      if (filePath) files.add(filePath.split('/').pop() ?? filePath);
    }
    // Extract tool/llm call counts from iteration_completed workflow events
    if (ev.type === 'workflow') {
      const data = asRecord(ev.payload.data);
      const result = asRecord(data?.result);
      if (result) {
        if (typeof result.tool_calls === 'number') toolCalls += result.tool_calls;
        if (typeof result.llm_calls === 'number') llmCalls += result.llm_calls;
      }
    }
  }
  if (tools.length > 0) {
    const toolStr = tools.slice(0, 4).join(', ');
    const fileStr = files.size > 0 ? ` on ${[...files].slice(0, 3).join(', ')}` : '';
    return `[${toolStr}${fileStr}]`;
  }
  // Fallback: use iteration stats
  if (toolCalls > 0 || llmCalls > 0) {
    const parts: string[] = [];
    if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls > 1 ? 's' : ''}`);
    if (llmCalls > 0) parts.push(`${llmCalls} LLM call${llmCalls > 1 ? 's' : ''}`);
    return `[${parts.join(', ')}]`;
  }
  return '[completed]';
}

export function EventDrawer() {
  const eventFilter = useCockpit(s => s.eventFilter);
  const eventDrawerOpen = useCockpit(s => s.eventDrawerOpen);
  const eventDrawerHeight = useCockpit(s => s.eventDrawerHeight);
  const events = useCockpit(s => s.events);
  const streamingText = useCockpit(s => s.streamingText);
  const store = useCockpitStore();
  const filteredEvents = useMemo(() => selectFilteredEvents(store.getSnapshot()), [events, eventFilter, streamingText]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isChatMode = eventFilter === 'messages';

  // Show thinking indicator when the last chat message is from the user and no streaming text is active.
  const showThinking = useMemo(() => {
    if (!isChatMode || filteredEvents.length === 0) return false;
    const lastEvent = filteredEvents[filteredEvents.length - 1];
    if (!isMessageLikeEvent(lastEvent)) return false;
    // Streaming events (injected from SSE) are already visible — no need for dots.
    if (lastEvent.payload?.streaming === true) return false;
    const role = messageRoleForEvent(lastEvent);
    return role === 'user';
  }, [isChatMode, filteredEvents]);

  // Pre-compute tool summaries for empty assistant messages
  const toolSummaries = useMemo(() => {
    if (!isChatMode) return new Map<number, string>();
    const map = new Map<number, string>();
    for (let i = 0; i < filteredEvents.length; i++) {
      const ev = filteredEvents[i];
      const role = messageRoleForEvent(ev as Parameters<typeof messageRoleForEvent>[0]);
      if (role === 'assistant' && !extractMessageContent(ev.payload)) {
        // Find this event's index in the full events array
        const fullIdx = events.indexOf(ev);
        if (fullIdx >= 0) {
          const summary = buildToolSummary(events, fullIdx);
          if (summary) map.set(i, summary);
        }
      }
    }
    return map;
  }, [isChatMode, filteredEvents, events]);

  // Auto-scroll to bottom when drawer opens, new messages arrive, or thinking indicator appears
  useEffect(() => {
    if (eventDrawerOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [eventDrawerOpen, filteredEvents.length, showThinking]);

  return (
    <div
      className={`border-t border-[var(--border-subtle)] flex flex-col transition-all duration-200 ease-in-out ${
        eventDrawerOpen ? `min-h-[120px]` : 'h-6'
      }`}
      style={eventDrawerOpen ? { height: `${eventDrawerHeight}px` } : undefined}
    >
      {/* Header bar — toggle + filter pills side by side */}
      <div className="shrink-0 flex items-center justify-between px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
        <button
          onClick={() => store.set({ eventDrawerOpen: !eventDrawerOpen })}
          className="hover:bg-[var(--bg-hover)] px-1 py-0.5 rounded"
        >
          {eventDrawerOpen ? '\u25BE' : '\u25B8'} {isChatMode ? 'Chat' : 'Events'} ({filteredEvents.length})
        </button>
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => store.set({ eventFilter: f.key })}
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
          <>
            {filteredEvents.map((event, idx) => (
              <ChatMessage key={`${event.at}-${idx}`} event={event} toolSummary={toolSummaries.get(idx)} />
            ))}
            {showThinking && (
              <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
                <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] mb-0.5">
                  <span className="font-medium text-[var(--accent-cyan)]">Agent</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                  <span className="inline-flex gap-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-cyan)] animate-pulse" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-cyan)] animate-pulse" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-cyan)] animate-pulse" style={{ animationDelay: '300ms' }} />
                  </span>
                </div>
              </div>
            )}
          </>
        ) : (
          filteredEvents.map((event, idx) => (
            <EventRow key={`${event.at}-${idx}`} event={event} eventFilter={eventFilter} />
          ))
        )}
      </div>
    </div>
  );
}
