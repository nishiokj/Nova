import { useMemo } from 'react';
import { useCockpit, useCockpitStore, selectToolSignal, selectRecentAssistantMessage, selectFocusRollup, selectFocusStatus, selectFocusEscalationId, type FocusTab } from '@/hooks/use-cockpit-store';
import { DiffstatLine } from '@/components/shared/DiffstatLine';
import { ResizeHandle } from '@/components/shared/ResizeHandle';
import { PacketTab } from './tabs/PacketTab';
import { DiffTab } from './tabs/DiffTab';
import { TestsTab } from './tabs/TestsTab';
import { TraceTab } from './tabs/TraceTab';
import { PermissionsTab } from './tabs/PermissionsTab';
import { EventDrawer } from './EventDrawer';
import { MessageInput } from './MessageInput';

const TABS: { key: FocusTab; label: string }[] = [
  { key: 'packet', label: 'Packet' },
  { key: 'diff', label: 'Diff' },
  { key: 'tests', label: 'Tests' },
  { key: 'trace', label: 'Trace' },
  { key: 'permissions', label: 'Permissions' },
];

function TabContent({ tab }: { tab: FocusTab }) {
  switch (tab) {
    case 'packet': return <PacketTab />;
    case 'diff': return <DiffTab />;
    case 'tests': return <TestsTab />;
    case 'trace': return <TraceTab />;
    case 'permissions': return <PermissionsTab />;
  }
}

export function SessionDetail({ mentionFiles = [] }: { mentionFiles?: string[] }) {
  const focusData = useCockpit(s => s.focusData);
  const focusTab = useCockpit(s => s.focusTab);
  const reviewDecisionAction = useCockpit(s => s.reviewDecisionAction);
  const resolvingEscalationId = useCockpit(s => s.resolvingEscalationId);
  const diffData = useCockpit(s => s.diffData);
  const eventDrawerHeight = useCockpit(s => s.eventDrawerHeight);
  const events = useCockpit(s => s.events);
  const runningSessions = useCockpit(s => s.runningSessions);
  const readySessions = useCockpit(s => s.readySessions);
  const doneSessions = useCockpit(s => s.doneSessions);
  const store = useCockpitStore();
  const state = store.getSnapshot();
  const toolSignal = useMemo(() => selectToolSignal(state), [events]);
  const recentMessage = useMemo(() => selectRecentAssistantMessage(state), [events]);
  const focusRollup = useMemo(() => selectFocusRollup(state), [focusData?.sessionKey, runningSessions, readySessions, doneSessions]);
  const focusStatus = selectFocusStatus(state);
  const escalationId = selectFocusEscalationId(state);

  const diffSummary = diffData?.summary ?? focusRollup?.diffstat ?? null;

  const setEventDrawerHeight = (height: number) => store.set({ eventDrawerHeight: Math.max(80, Math.min(600, height)) });

  if (!focusData) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">
        Select a session or escalation
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Session header */}
      <div className="px-3 py-1.5 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-[var(--text-primary)] font-medium truncate">
            {typeof focusData.header?.title === 'string' ? focusData.header.title : 'Session'}
          </span>
          {focusData.type === 'escalation' && (
            <span className="text-[11px] uppercase text-[var(--warning)]">Escalation</span>
          )}
        </div>

        <div className="flex items-center gap-x-3 gap-y-0.5 mt-0.5 flex-wrap text-xs text-[var(--text-muted)]">
          <span className="font-mono">{focusData.sessionKey}</span>
          {toolSignal ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--accent-cyan)]/15 text-[var(--accent-cyan)] text-[10px]">
              <span aria-hidden>{toolSignal.icon}</span>
              <span>{toolSignal.label}</span>
              <span className="text-[var(--text-muted)]">{toolSignal.detail}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] text-[10px]">Idle</span>
          )}
          {diffSummary && (
            <span className="flex-1 min-w-0">
              <DiffstatLine added={diffSummary.added} deleted={diffSummary.deleted} files={diffSummary.filesTouched} />
            </span>
          )}
        </div>

        {recentMessage && (
          <div className="text-[10px] text-[var(--text-secondary)] mt-0.5 truncate">
            Latest: {recentMessage}
          </div>
        )}

        {/* Review actions */}
        {focusStatus === 'ready' && (
          <div className="mt-1 flex items-center gap-1">
            <button
              onClick={() => void store.handleReviewDecision('accept')}
              disabled={reviewDecisionAction !== null}
              className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
            >{reviewDecisionAction === 'accept' ? 'Accepting...' : 'Accept'}</button>
            <button
              onClick={() => void store.handleReviewDecision('request_changes')}
              disabled={reviewDecisionAction !== null}
              className="px-2 py-0.5 text-[11px] rounded bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 disabled:opacity-60"
            >{reviewDecisionAction === 'request_changes' ? 'Sending...' : 'Request Changes'}</button>
          </div>
        )}

        {escalationId && (
          <div className="mt-1">
            <button
              onClick={() => void store.handleResolveEscalation(escalationId)}
              disabled={resolvingEscalationId === escalationId}
              className="px-2 py-0.5 text-xs rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
            >{resolvingEscalationId === escalationId ? 'Resolving...' : 'Resolve Escalation'}</button>
          </div>
        )}

        {/* Tab bar */}
        <div className="mt-1.5 flex items-center border-b border-[var(--border-subtle)] -mx-3 px-3">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => store.set({ focusTab: tab.key })}
              className={`px-2.5 py-1 text-[11px] border-b-2 -mb-px transition-colors ${
                focusTab === tab.key
                  ? 'border-[var(--accent-cyan)] text-[var(--accent-cyan)]'
                  : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
          <span className="ml-auto text-[9px] text-[var(--text-muted)] pr-1 select-none">{'\u21E5'} tab</span>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <TabContent tab={focusTab} />
      </div>

      {/* Resize handle for event drawer */}
      <ResizeHandle direction="vertical" onResize={(delta) => setEventDrawerHeight(eventDrawerHeight - delta)} aria-label="Resize chat panel" />

      {/* Event drawer */}
      <EventDrawer />

      {/* Message input */}
      <MessageInput fileSuggestions={mentionFiles} />
    </div>
  );
}
