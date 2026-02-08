import { useMemo } from 'react';
import { useCockpit } from '@/hooks/use-cockpit-store';
import type { NormalizedSessionEvent, SessionRollup } from '@/lib/api';
import { EntityGraphView } from './EntityGraphView';

const MAX_LIVE_ITEMS = 3;
const LIVE_WINDOW_MS = 45_000;

type LiveAgent = 'explorer' | 'standard' | 'coder' | 'watcher';
type LiveStatus = 'started' | 'completed' | 'failed' | 'skipped' | 'unknown';

export interface LiveWorkItemViewModel {
  workItemId: string;
  objective: string;
  agent: LiveAgent;
  status: LiveStatus;
  isLive: boolean;
  lastEventAtMs: number;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readEventTimestamp(event: NormalizedSessionEvent, index: number): number {
  const parsed = Date.parse(event.at);
  if (Number.isFinite(parsed)) return parsed;
  return index;
}

function canonicalAgent(raw: string | null): LiveAgent {
  const value = (raw ?? '').toLowerCase();
  if (value.includes('explorer')) return 'explorer';
  if (value.includes('watcher')) return 'watcher';
  if (value.includes('coder') || value.includes('coding')) return 'coder';
  return 'standard';
}

function readWorkItemId(event: NormalizedSessionEvent): string | null {
  const payload = event.payload;
  const direct = asNonEmptyString(payload.workItemId)
    ?? asNonEmptyString(payload.workId)
    ?? asNonEmptyString(payload.work_id);
  if (direct) return direct;

  const data = toRecord(payload.data);
  if (!data) return null;
  return (
    asNonEmptyString(data.workItemId)
    ?? asNonEmptyString(data.work_item_id)
    ?? asNonEmptyString(data.workId)
    ?? asNonEmptyString(data.work_id)
  );
}

function readObjective(event: NormalizedSessionEvent): string | null {
  const payloadObjective = asNonEmptyString(event.payload.objective)
    ?? asNonEmptyString(event.payload.current_objective)
    ?? asNonEmptyString(event.payload.goal);
  if (payloadObjective) return payloadObjective;

  const data = toRecord(event.payload.data);
  if (!data) return null;
  return (
    asNonEmptyString(data.objective)
    ?? asNonEmptyString(data.current_objective)
    ?? asNonEmptyString(data.goal)
  );
}

function readAgent(event: NormalizedSessionEvent): LiveAgent {
  const payload = event.payload;
  const data = toRecord(payload.data);
  return canonicalAgent(
    asNonEmptyString(payload.agentType)
    ?? asNonEmptyString(payload.agent_type)
    ?? asNonEmptyString(data?.agentType)
    ?? asNonEmptyString(data?.agent_type)
    ?? asNonEmptyString(data?.agent)
    ?? null
  );
}

function readStatus(event: NormalizedSessionEvent): LiveStatus {
  const data = toRecord(event.payload.data);
  const raw = (asNonEmptyString(data?.status) ?? '').toLowerCase();
  if (raw === 'started') return 'started';
  if (raw === 'completed') return 'completed';
  if (raw === 'failed') return 'failed';
  if (raw === 'skipped') return 'skipped';

  const eventType = (asNonEmptyString(event.payload.eventType) ?? '').toLowerCase();
  if (eventType === 'workitem_created') return 'started';
  return 'unknown';
}

function isTerminalStatus(status: LiveStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'skipped';
}

function summarizeStatus(item: LiveWorkItemViewModel): 'live' | 'done' | 'idle' {
  if (item.isLive) return 'live';
  if (isTerminalStatus(item.status)) return 'done';
  return 'idle';
}

function fallbackObjective(workItemId: string): string {
  return `Work item ${workItemId}`;
}

export function deriveLiveWorkItems(
  events: NormalizedSessionEvent[],
  options: {
    activeWorkItemId?: string | null;
    activeObjective?: string | null;
    maxItems?: number;
    nowMs?: number;
  } = {}
): LiveWorkItemViewModel[] {
  const byId = new Map<string, LiveWorkItemViewModel>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const workItemId = readWorkItemId(event);
    if (!workItemId) continue;

    const ts = readEventTimestamp(event, index);
    const existing = byId.get(workItemId) ?? {
      workItemId,
      objective: fallbackObjective(workItemId),
      agent: 'standard',
      status: 'unknown',
      isLive: false,
      lastEventAtMs: ts,
    };

    const objective = readObjective(event);
    if (objective) existing.objective = objective;
    existing.agent = readAgent(event);

    const nextStatus = readStatus(event);
    if (nextStatus !== 'unknown') existing.status = nextStatus;
    existing.lastEventAtMs = Math.max(existing.lastEventAtMs, ts);

    byId.set(workItemId, existing);
  }

  const activeWorkItemId = asNonEmptyString(options.activeWorkItemId);
  const activeObjective = asNonEmptyString(options.activeObjective);
  if (activeWorkItemId) {
    const existing = byId.get(activeWorkItemId) ?? {
      workItemId: activeWorkItemId,
      objective: activeObjective ?? fallbackObjective(activeWorkItemId),
      agent: 'standard',
      status: 'started',
      isLive: true,
      lastEventAtMs: options.nowMs ?? Date.now(),
    };
    if (activeObjective && existing.objective === fallbackObjective(activeWorkItemId)) {
      existing.objective = activeObjective;
    }
    if (!isTerminalStatus(existing.status)) existing.status = 'started';
    byId.set(activeWorkItemId, existing);
  }

  const nowMs = options.nowMs ?? Date.now();
  const maxItems = Math.max(1, Math.min(MAX_LIVE_ITEMS, options.maxItems ?? MAX_LIVE_ITEMS));

  return Array.from(byId.values())
    .map((entry) => {
      const recentlyActive = nowMs - entry.lastEventAtMs <= LIVE_WINDOW_MS;
      const isLive = !isTerminalStatus(entry.status) && (entry.status === 'started' || recentlyActive || entry.workItemId === activeWorkItemId);
      return { ...entry, isLive };
    })
    .sort((a, b) => {
      if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      return b.lastEventAtMs - a.lastEventAtMs;
    })
    .slice(0, maxItems);
}

function relativeAge(lastEventAtMs: number): string {
  const deltaMs = Date.now() - lastEventAtMs;
  if (deltaMs < 1000) return 'just now';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function sessionForFocus(
  sessionKey: string | undefined,
  runningSessions: SessionRollup[],
  readySessions: SessionRollup[],
  doneSessions: SessionRollup[]
): SessionRollup | null {
  if (!sessionKey) return null;
  return [...runningSessions, ...readySessions, ...doneSessions].find((session) => session.sessionKey === sessionKey) ?? null;
}

export function LiveTab() {
  const focusData = useCockpit(s => s.focusData);
  const events = useCockpit(s => s.events);
  const runningSessions = useCockpit(s => s.runningSessions);
  const readySessions = useCockpit(s => s.readySessions);
  const doneSessions = useCockpit(s => s.doneSessions);

  const activeSession = useMemo(
    () => sessionForFocus(focusData?.sessionKey, runningSessions, readySessions, doneSessions),
    [focusData?.sessionKey, runningSessions, readySessions, doneSessions]
  );

  const liveItems = useMemo(
    () => deriveLiveWorkItems(events, {
      activeWorkItemId: activeSession?.activeWorkItemId ?? null,
      activeObjective: activeSession?.title ?? null,
      maxItems: MAX_LIVE_ITEMS,
    }),
    [events, activeSession?.activeWorkItemId, activeSession?.title]
  );

  if (!focusData?.sessionKey) {
    return (
      <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
        No session selected.
      </div>
    );
  }

  if (liveItems.length === 0) {
    return (
      <div className="space-y-2">
        <div className="text-[11px] text-[var(--text-muted)]">Live view is waiting for work-item activity.</div>
        <div className="rounded border border-[var(--border-subtle)] overflow-hidden h-[300px]">
          <EntityGraphView sessionKey={focusData.sessionKey} />
        </div>
      </div>
    );
  }

  const singleItem = liveItems.length === 1;
  const twoItems = liveItems.length === 2;
  const gridClass = singleItem
    ? 'grid-cols-1'
    : twoItems
      ? 'grid-cols-1 2xl:grid-cols-2'
      : 'grid-cols-1 2xl:grid-cols-3';
  const graphHeightClass = singleItem
    ? 'h-[min(62vh,560px)]'
    : twoItems
      ? 'h-[340px]'
      : 'h-[240px]';

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] text-[var(--text-muted)]">
        Live work items {singleItem ? '· focused view' : `· showing ${liveItems.length}/3`}
      </div>
      <div className={`grid ${gridClass} gap-2`}>
        {liveItems.map((item) => {
          const status = summarizeStatus(item);
          return (
            <section
              key={item.workItemId}
              className={`live-work-card rounded overflow-hidden bg-[var(--bg-surface)] ${
                item.isLive ? `live-card-pulse live-agent-${item.agent}` : ''
              }`}
            >
              <header className="px-1.5 py-1 border-b border-[var(--border-subtle)]">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[10px] text-[var(--text-primary)]">{item.objective}</span>
                  <span className={`shrink-0 text-[9px] uppercase rounded px-1 py-[1px] ${
                    status === 'live'
                      ? 'text-[var(--running)] bg-[var(--running)]/15'
                      : status === 'done'
                        ? 'text-[var(--text-secondary)] bg-[var(--bg-elevated)]'
                        : 'text-[var(--warning)] bg-[var(--warning)]/15'
                  }`}
                  >
                    {status}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[9px] text-[var(--text-muted)]">
                  <span className="uppercase">{item.agent}</span>
                  <span>{relativeAge(item.lastEventAtMs)}</span>
                </div>
              </header>
              <div className={graphHeightClass}>
                <EntityGraphView sessionKey={focusData.sessionKey} workItemId={item.workItemId} />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
