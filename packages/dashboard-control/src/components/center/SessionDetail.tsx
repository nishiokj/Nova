import { useMemo } from 'react';
import { useCockpit, selectToolSignal, selectRecentAssistantMessage, selectFocusRollup, selectFocusStatus, selectFocusEscalationId, type FocusTab } from '@/hooks/use-cockpit-store';
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

export function SessionDetail() {
  const { state, set, handleReviewDecision, handleResolveEscalation } = useCockpit();
  const { focusData, focusTab, reviewDecisionAction, resolvingEscalationId, diffData, eventDrawerHeight } = state;

  const toolSignal = useMemo(() => selectToolSignal(state), [state.events]);
  const recentMessage = useMemo(() => selectRecentAssistantMessage(state), [state.events]);
  const focusRollup = useMemo(() => selectFocusRollup(state), [state.focusData?.sessionKey, state.runningSessions, state.readySessions, state.doneSessions]);
  const focusStatus = selectFocusStatus(state);
  const escalationId = selectFocusEscalationId(state);

  const diffSummary = diffData?.summary ?? focusRollup?.diffstat ?? null;

  const setEventDrawerHeight = (height: number) => set({ eventDrawerHeight: Math.max(80, Math.min(600, height)) });

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
      <div className="px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--text-primary)] font-medium truncate">
            {typeof focusData.header?.title === 'string' ? focusData.header.title : 'Session'}
          </span>
          {focusData.type === 'escalation' && (
            <span className="text-[11px] uppercase text-[var(--warning)]">Escalation</span>
          )}
        </div>

        <div className="text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-2">
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
        </div>

        {diffSummary && (
          <div className="mt-0.5">
            <DiffstatLine added={diffSummary.added} deleted={diffSummary.deleted} files={diffSummary.filesTouched} />
          </div>
        )}

        {recentMessage && (
          <div className="text-[11px] text-[var(--text-secondary)] mt-0.5 truncate">
            Latest: {recentMessage}
          </div>
        )}

        {/* Review actions */}
        {focusStatus === 'ready' && (
          <div className="mt-1 flex items-center gap-1">
            <button
              onClick={() => void handleReviewDecision('accept')}
              disabled={reviewDecisionAction !== null}
              className="px-2 py-0.5 text-[11px] rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
            >{reviewDecisionAction === 'accept' ? 'Accepting...' : 'Accept'}</button>
            <button
              onClick={() => void handleReviewDecision('request_changes')}
              disabled={reviewDecisionAction !== null}
              className="px-2 py-0.5 text-[11px] rounded bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 disabled:opacity-60"
            >{reviewDecisionAction === 'request_changes' ? 'Sending...' : 'Request Changes'}</button>
          </div>
        )}

        {escalationId && (
          <div className="mt-1">
            <button
              onClick={() => void handleResolveEscalation(escalationId)}
              disabled={resolvingEscalationId === escalationId}
              className="px-2 py-0.5 text-xs rounded bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 disabled:opacity-60"
            >{resolvingEscalationId === escalationId ? 'Resolving...' : 'Resolve Escalation'}</button>
          </div>
        )}

        {/* Tab bar */}
        <div className="mt-2 flex items-center border-b border-[var(--border-subtle)]">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => set({ focusTab: tab.key })}
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
      <MessageInput />
    </div>
  );
}
