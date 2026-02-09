import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  applyCockpitPatch,
  getCockpitDiff,
  getCockpitFocus,
  getCockpitRollupSnapshot,
  getCockpitSessionEvents,
  getCockpitSessionPermissions,
  getCockpitSessionPackets,
  getCockpitSessionModel,
  postCockpitPermissionResponse,
  postCockpitSessionModel,
  postCockpitSessionPermissions,
  type CockpitPermissionDecision,
  type CockpitPendingPermissionRequest,
  type CockpitMarkdownContextInput,
  type CockpitModelEntry,
  type CockpitModelSelection,
  type CockpitDiff,
  type CockpitSessionPermissionUpdateInput,
  type CockpitSessionPermissions,
  type CockpitTestReport,
  type CommitRollup,
  type DailyMetrics,
  type EscalationRollup,
  type FocusData,
  type FocusPacket,
  type NormalizedSessionEvent,
  type PRRollup,
  type RepoLensMatch,
  type SessionRollup,
  type TraceRecord,
  type WorkItemTemplate,
  getCockpitMarkdownFile,
  getCockpitTemplates,
  getCockpitTestReport,
  getCockpitTestReports,
  getCockpitTraces,
  postCockpitSessionCreate,
  postCockpitSessionMessage,
  postCockpitSessionReviewDecision,
  postCockpitSessionAsyncStart,
  postCockpitSessionAsyncCancel,
  getCockpitSessionAsyncStatus,
  resolveCockpitEscalation,
  searchCockpitRepoLens,
} from '@/lib/api';
import {
  describeLatestToolSignal,
  extractMessageContent,
  isFailureEvent,
  isMessageLikeEvent,
  messageRoleForEvent,
} from '@/lib/events';
import { extractAtRefs } from '@/lib/autocomplete';
import { parsePacketMarkdown } from '@/lib/packets';

// ─── Types ───────────────────────────────────────────────────

export type FocusTarget =
  | { type: 'session'; id: string }
  | { type: 'escalation'; id: string };

export type FocusTab = 'live' | 'document' | 'packet' | 'escalations' | 'diff' | 'tests' | 'trace' | 'permissions';
export type GlobalTool = 'none' | 'grep' | 'browser';
export type EventFilter = 'all' | 'messages' | 'failures' | 'audit';

const REPO_ROLLUP_REFRESH_INTERVAL_MS = 45_000;
const HEAVY_FOCUS_REFRESH_INTERVAL_MS = 20_000;

function focusChatInputOrCenterPane() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-cockpit-chat-input="true"]');
    if (input) {
      input.focus();
      return;
    }
    const centerPane = document.querySelector<HTMLElement>('[data-cockpit-pane="center"]');
    centerPane?.focus({ preventScroll: true });
  });
}

// ─── State ───────────────────────────────────────────────────

export interface CockpitState {
  runningSessions: SessionRollup[];
  readySessions: SessionRollup[];
  doneSessions: SessionRollup[];
  escalations: EscalationRollup[];
  commitRollups: CommitRollup[];
  prRollups: PRRollup[];
  metrics: DailyMetrics | null;

  focusTarget: FocusTarget | null;
  focusData: FocusData | null;
  focusTab: FocusTab;
  globalTool: GlobalTool;
  events: NormalizedSessionEvent[];
  eventsSessionKey: string | null;
  sessionPackets: FocusPacket[];
  selectedPacketId: string | null;
  diffData: CockpitDiff | null;
  selectedDiffFile: string | null;
  highlightedDiffIdx: number | null;
  diffPatchFile: string | null;
  diffPatchLoadingFile: string | null;
  diffPatchError: string | null;
  testReports: CockpitTestReport[];
  selectedTestReportId: string | null;
  selectedTestReport: CockpitTestReport | null;
  traces: TraceRecord[];
  sessionPermissions: CockpitSessionPermissions | null;
  lensResults: { defs: RepoLensMatch[]; refs: RepoLensMatch[]; text: RepoLensMatch[] };
  lensQuery: string;
  sessionFilterQuery: string;

  eventFilter: EventFilter;
  eventDrawerOpen: boolean;
  eventDrawerHeight: number;
  loading: boolean;
  error: string | null;
  commandStatus: string | null;
  lastUpdate: Date;

  // Preview
  browserSessionScope: string;
  browserUrlDraft: string;

  // Patch
  patchDraft: string;
  patchApplyStatus: string | null;
  applyingPatch: boolean;

  // Message input
  messageDraft: string;
  sendingMessage: boolean;
  inputVisible: boolean;

  // Review / resolve
  resolvingEscalationId: string | null;
  reviewDecisionAction: 'accept' | 'request_changes' | null;
  permissionsSaving: boolean;
  permissionsSaveStatus: string | null;
  pendingPermissionRequests: CockpitPendingPermissionRequest[];
  permissionDialogOpen: boolean;
  permissionResponseSubmitting: boolean;
  permissionResponseError: string | null;

  // Lens
  lensLoading: boolean;

  // Pending commit range (for cross-linking commits → diff)
  pendingCommitRange: { sessionKey: string; base?: string; head?: string } | null;

  // Workflows
  templates: WorkItemTemplate[];
  workspaceProjectPath: string | null;

  // Promote picker
  upgradePickerOpen: boolean;

  // Keyboard nav highlight in right pane
  highlightedSessionIdx: number | null;
  commandPaletteOpen: boolean;
  commandPaletteQuery: string;
  shortcutSheetOpen: boolean;

  // Model selection
  sessionModelSelection: CockpitModelSelection | null;
  sessionModelCatalog: CockpitModelEntry[];
  sessionModelLoading: boolean;
}

const initialState: CockpitState = {
  runningSessions: [],
  readySessions: [],
  doneSessions: [],
  escalations: [],
  commitRollups: [],
  prRollups: [],
  metrics: null,

  focusTarget: null,
  focusData: null,
  focusTab: 'packet',
  globalTool: 'none',
  events: [],
  eventsSessionKey: null,
  sessionPackets: [],
  selectedPacketId: null,
  diffData: null,
  selectedDiffFile: null,
  highlightedDiffIdx: null,
  diffPatchFile: null,
  diffPatchLoadingFile: null,
  diffPatchError: null,
  testReports: [],
  selectedTestReportId: null,
  selectedTestReport: null,
  traces: [],
  sessionPermissions: null,
  lensResults: { defs: [], refs: [], text: [] },
  lensQuery: '',
  sessionFilterQuery: '',

  eventFilter: 'messages',
  eventDrawerOpen: false,
  eventDrawerHeight: 160,
  loading: true,
  error: null,
  commandStatus: null,
  lastUpdate: new Date(),

  browserSessionScope: '',
  browserUrlDraft: '',

  patchDraft: '',
  patchApplyStatus: null,
  applyingPatch: false,

  messageDraft: '',
  sendingMessage: false,
  inputVisible: true,

  resolvingEscalationId: null,
  reviewDecisionAction: null,
  permissionsSaving: false,
  permissionsSaveStatus: null,
  pendingPermissionRequests: [],
  permissionDialogOpen: false,
  permissionResponseSubmitting: false,
  permissionResponseError: null,

  lensLoading: false,
  pendingCommitRange: null,

  templates: [],
  workspaceProjectPath: null,
  upgradePickerOpen: false,

  highlightedSessionIdx: null,
  commandPaletteOpen: false,
  commandPaletteQuery: '',
  shortcutSheetOpen: false,

  sessionModelSelection: null,
  sessionModelCatalog: [],
  sessionModelLoading: false,
};

// ─── Derived selectors ───────────────────────────────────────

export function selectToolSignal(state: CockpitState) {
  return describeLatestToolSignal(state.events);
}

export function selectRecentAssistantMessage(state: CockpitState): string | null {
  for (let idx = state.events.length - 1; idx >= 0; idx -= 1) {
    const event = state.events[idx];
    if (!isMessageLikeEvent(event)) continue;
    const role = messageRoleForEvent(event);
    if (role !== 'assistant') continue;
    const content = extractMessageContent(event.payload);
    if (content) return content;
  }
  return null;
}

export function selectFocusRollup(state: CockpitState): SessionRollup | null {
  const sessionKey = state.focusData?.sessionKey;
  if (!sessionKey) return null;
  return state.runningSessions.find((r) => r.sessionKey === sessionKey)
    ?? state.readySessions.find((r) => r.sessionKey === sessionKey)
    ?? state.doneSessions.find((r) => r.sessionKey === sessionKey)
    ?? null;
}

export function selectActivePacket(state: CockpitState): FocusPacket | null {
  if (state.selectedPacketId) {
    const selected = state.sessionPackets.find((packet) => packet.packetId === state.selectedPacketId);
    if (selected) return selected;
  }
  return state.focusData?.packet ?? state.sessionPackets[0] ?? null;
}

export function selectParsedPacket(state: CockpitState) {
  return parsePacketMarkdown(selectActivePacket(state)?.contentMarkdown ?? '');
}

export function selectFocusStatus(state: CockpitState): string | null {
  return typeof state.focusData?.header?.status === 'string' ? state.focusData.header.status : null;
}

export function selectFocusEscalationId(state: CockpitState): string | null {
  return state.focusData?.type === 'escalation' ? state.focusData.id : null;
}

export function selectActivePermissionRequest(state: CockpitState): CockpitPendingPermissionRequest | null {
  return state.pendingPermissionRequests[0] ?? null;
}

export function selectFilteredEvents(state: CockpitState): NormalizedSessionEvent[] {
  const { events, eventFilter } = state;

  if (eventFilter === 'audit') {
    return events.filter((event) => {
      if (event.isStatusOnly) return true;
      if (event.type === 'tool') return true;
      return false;
    });
  }

  if (eventFilter === 'messages') {
    return events.filter((event) => {
      if (!isMessageLikeEvent(event)) return false;
      const content = extractMessageContent(event.payload);
      const role = messageRoleForEvent(event);
      const isFromMessagesTable = typeof event.payload.id === 'number' && !event.payload.eventType;
      const isOptimisticUserMessage = role === 'user' && (
        event.payload.optimistic === true
        || (typeof event.payload.id === 'string' && event.payload.id.startsWith('optimistic-'))
      );
      // User messages: require content, only from messages table (agent_events duplicate them)
      if (role === 'user') return (isFromMessagesTable || isOptimisticUserMessage) && !!content;
      // Assistant messages from messages table: only include if they have content
      if (isFromMessagesTable) return !!content;
      // Assistant agent events: include if they have any content
      if (role === 'assistant') return !!content;
      // Other agent events: only if substantial text content
      return content.length > 80;
    });
  }
  if (eventFilter === 'failures') return events.filter(isFailureEvent);
  if (eventFilter === 'all') {
    return events;
  }
  return events;
}

function toSessionMessageContent(event: NormalizedSessionEvent): string {
  if (event.type !== 'message') return '';
  return extractMessageContent(event.payload);
}

function messageReconcileKeys(event: NormalizedSessionEvent): string[] {
  if (event.type !== 'message') return [];
  const payload = event.payload as Record<string, unknown>;
  const role = typeof payload.role === 'string' ? payload.role.trim().toLowerCase() : '';
  const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
  const content = toSessionMessageContent(event);
  const keys: string[] = [];

  if (typeof payload.id === 'number') {
    keys.push(`db:${String(payload.id)}`);
  } else if (typeof payload.id === 'string' && payload.id.trim() && payload.optimistic !== true) {
    keys.push(`id:${payload.id.trim()}`);
  }

  if (requestId && role && content) {
    keys.push(`req-role-content:${requestId}:${role}:${content}`);
  } else if (requestId && role) {
    keys.push(`req-role-empty:${requestId}:${role}`);
  }

  return keys;
}

function mergeServerAndLocalMessageEvents(
  serverEvents: NormalizedSessionEvent[],
  localEvents: NormalizedSessionEvent[],
  maxEvents: number
): NormalizedSessionEvent[] {
  if (localEvents.length === 0) return serverEvents;

  const serverMessageKeys = new Set<string>();
  for (const event of serverEvents) {
    for (const key of messageReconcileKeys(event)) {
      serverMessageKeys.add(key);
    }
  }

  const carryForwardLocalMessages = localEvents.filter((event) => {
    if (event.type !== 'message') return false;
    const keys = messageReconcileKeys(event);
    if (keys.length === 0) return true;
    return !keys.some((key) => serverMessageKeys.has(key));
  });

  if (carryForwardLocalMessages.length === 0) return serverEvents;

  const merged = [...serverEvents, ...carryForwardLocalMessages]
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  if (merged.length <= maxEvents) return merged;
  return merged.slice(-maxEvents);
}

function isEphemeralLocalMessageEvent(event: NormalizedSessionEvent): boolean {
  if (event.type !== 'message') return false;
  const payload = event.payload as Record<string, unknown>;
  if (payload.streaming === true || payload.optimistic === true) return true;
  const id = payload.id;
  if (typeof id !== 'string') return false;
  return id.startsWith('optimistic-') || id.startsWith('streaming-assistant-');
}

// ─── Store ───────────────────────────────────────────────────

export class CockpitStoreImpl {
  state: CockpitState = initialState;
  private listeners = new Set<() => void>();
  private focusRefreshSeq = 0;
  private diffPatchRequestSeq = 0;
  private diffPatchCache = new Map<string, string | null>();
  private lastRepoRollupRefreshAt = Date.now();
  private lastHeavyFocusRefreshAt = 0;
  private documentSessionPaths = new Map<string, string>();
  private localMessageCarryBySession = new Map<string, NormalizedSessionEvent[]>();
  private markdownContextProvider: (() => CockpitMarkdownContextInput | null) | null = null;
  private beforeSendMessageHook: (() => Promise<boolean> | boolean) | null = null;

  // ─── useSyncExternalStore contract ─────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CockpitState => this.state;

  private notify() {
    for (const l of this.listeners) l();
  }

  private getLocalMessageCarry(sessionKey: string): NormalizedSessionEvent[] {
    return this.localMessageCarryBySession.get(sessionKey) ?? [];
  }

  private syncLocalMessageCarry(sessionKey: string | null, events: NormalizedSessionEvent[]) {
    if (!sessionKey) return;
    const localMessages = events.filter(isEphemeralLocalMessageEvent);
    if (localMessages.length > 0) {
      this.localMessageCarryBySession.set(sessionKey, localMessages);
    } else {
      this.localMessageCarryBySession.delete(sessionKey);
    }
  }

  // ─── Mutations ─────────────────────────────────────────────

  set = (payload: Partial<CockpitState>) => {
    const normalizedPayload: Partial<CockpitState> = { ...payload };
    if (
      Object.prototype.hasOwnProperty.call(normalizedPayload, 'focusTarget')
      && normalizedPayload.focusTarget
      && !Object.prototype.hasOwnProperty.call(normalizedPayload, 'globalTool')
    ) {
      normalizedPayload.globalTool = 'none';
    }
    if (
      Object.prototype.hasOwnProperty.call(normalizedPayload, 'focusTarget')
      && normalizedPayload.focusTarget?.type === 'escalation'
      && !Object.prototype.hasOwnProperty.call(normalizedPayload, 'focusTab')
    ) {
      normalizedPayload.focusTab = 'escalations';
    }
    const entries = Object.entries(normalizedPayload) as [string, unknown][];
    const changed = entries.some(([k, v]) => (this.state as unknown as Record<string, unknown>)[k] !== v);
    if (!changed) return;
    this.state = { ...this.state, ...normalizedPayload };
    const eventsTouched = Object.prototype.hasOwnProperty.call(normalizedPayload, 'events')
      || Object.prototype.hasOwnProperty.call(normalizedPayload, 'eventsSessionKey');
    if (eventsTouched) {
      const eventsSessionKey = this.state.eventsSessionKey ?? this.state.focusData?.sessionKey ?? null;
      this.syncLocalMessageCarry(eventsSessionKey, this.state.events);
    }
    this.notify();
  };

  setRollups(payload: Pick<CockpitState, 'runningSessions' | 'readySessions' | 'doneSessions' | 'escalations' | 'commitRollups' | 'prRollups' | 'metrics'>) {
    const next: CockpitState = { ...this.state, ...payload, loading: false, lastUpdate: new Date() };
    if (next.focusTarget) {
      if (next.focusTarget.type === 'escalation') {
        const exists = next.escalations.some((r) => r.escalationId === next.focusTarget!.id);
        if (!exists) next.focusTarget = null;
      } else {
        const allSessions = [...next.runningSessions, ...next.readySessions, ...next.doneSessions];
        const exists = allSessions.some((r) => r.sessionKey === next.focusTarget!.id);
        if (!exists) next.focusTarget = null;
      }
    }
    this.state = next;
    this.notify();
  }

  setFocusData(payload: { focusData: FocusData | null; events: NormalizedSessionEvent[]; traces: TraceRecord[]; testReports: CockpitTestReport[]; diffData: CockpitDiff | null; packets: FocusPacket[]; sessionPermissions: CockpitSessionPermissions | null }) {
    const { focusData, events, traces, testReports, diffData, packets, sessionPermissions } = payload;
    const nextSessionKey = focusData?.sessionKey ?? null;
    const currentSessionKey = this.state.eventsSessionKey ?? this.state.focusData?.sessionKey ?? null;
    const localEvents = nextSessionKey
      ? (currentSessionKey === nextSessionKey
          ? this.state.events
          : this.getLocalMessageCarry(nextSessionKey))
      : [];
    const mergedEvents = nextSessionKey
      ? mergeServerAndLocalMessageEvents(events, localEvents, 1200)
      : events;
    const currentSelectedPacketId = this.state.selectedPacketId;
    const selectedPacketId = currentSelectedPacketId && packets.some((packet) => packet.packetId === currentSelectedPacketId)
      ? currentSelectedPacketId
      : null;
    const selectedDiffFile = this.state.selectedDiffFile
      && diffData?.hotspots?.some((h) => h.path === this.state.selectedDiffFile)
      ? this.state.selectedDiffFile
      : diffData?.hotspots?.[0]?.path ?? null;
    const highlightedDiffIdx = selectedDiffFile && diffData
      ? Math.max(diffData.hotspots.findIndex((h) => h.path === selectedDiffFile), 0)
      : (diffData?.hotspots?.length ? 0 : null);
    const hasMessages = mergedEvents.some((e) => e.type === 'message');
    this.state = {
      ...this.state,
      focusData,
      events: mergedEvents,
      eventsSessionKey: focusData?.sessionKey ?? null,
      sessionPackets: packets,
      selectedPacketId,
      traces,
      sessionPermissions,
      testReports,
      diffData: diffData
        ? (this.state.diffData?.patch && !diffData.patch ? { ...diffData, patch: this.state.diffData.patch } : diffData)
        : null,
      selectedDiffFile,
      highlightedDiffIdx,
      diffPatchFile: null,
      diffPatchLoadingFile: null,
      diffPatchError: null,
      selectedTestReportId: testReports[0]?.id ?? null,
      selectedTestReport: testReports[0] ?? null,
      patchDraft: '',
      patchApplyStatus: null,
      lensResults: { defs: [], refs: [], text: [] },
      permissionsSaveStatus: null,
      browserSessionScope: focusData?.sessionKey ?? this.state.browserSessionScope,
      sessionModelSelection: null,
      sessionModelCatalog: [],
      sessionModelLoading: false,
      ...(hasMessages && !this.state.eventDrawerOpen ? { eventDrawerOpen: true } : {}),
    };
    this.syncLocalMessageCarry(nextSessionKey, mergedEvents);
    this.notify();
  }

  clearFocus() {
    this.state = {
      ...this.state,
      focusTarget: null,
      focusData: null,
      events: [],
      eventsSessionKey: null,
      sessionPackets: [],
      selectedPacketId: null,
      diffData: null,
      selectedDiffFile: null,
      highlightedDiffIdx: null,
      diffPatchFile: null,
      diffPatchLoadingFile: null,
      diffPatchError: null,
      testReports: [],
      selectedTestReport: null,
      selectedTestReportId: null,
      traces: [],
      sessionPermissions: null,
      patchDraft: '',
      patchApplyStatus: null,
      lensResults: { defs: [], refs: [], text: [] },
      permissionsSaving: false,
      permissionsSaveStatus: null,
      sessionModelSelection: null,
      sessionModelCatalog: [],
      sessionModelLoading: false,
    };
    this.notify();
  }

  // ─── SSE streaming injection ─────────────────────────────

  /** Append a stream chunk from the SSE event stream for the focused session. */
  injectStreamChunk(sessionKey: string, chunk: string, requestId?: string) {
    const focused = this.state.focusData?.sessionKey ?? null;
    if (!focused || focused !== sessionKey) return;
    if (!chunk) return;

    const trimmedRequestId = typeof requestId === 'string' && requestId.trim().length > 0
      ? requestId.trim()
      : null;
    let streamEventIdx = -1;
    let unattributedStreamEventIdx = -1;

    for (let idx = this.state.events.length - 1; idx >= 0; idx -= 1) {
      const event = this.state.events[idx];
      if (event.type !== 'message') continue;
      const payload = event.payload as Record<string, unknown>;
      if (payload.role !== 'assistant') continue;
      if (payload.streaming !== true) continue;
      const payloadRequestId = typeof payload.requestId === 'string' ? payload.requestId : '';
      if (trimmedRequestId) {
        if (payloadRequestId === trimmedRequestId) {
          streamEventIdx = idx;
          break;
        }
        if (!payloadRequestId && unattributedStreamEventIdx < 0) {
          unattributedStreamEventIdx = idx;
        }
        continue;
      }
      if (!payloadRequestId) {
        streamEventIdx = idx;
        break;
      }
    }
    if (streamEventIdx < 0 && trimmedRequestId && unattributedStreamEventIdx >= 0) {
      streamEventIdx = unattributedStreamEventIdx;
    }

    let nextEvents = this.state.events;
    if (streamEventIdx >= 0) {
      const event = this.state.events[streamEventIdx];
      const payload = event.payload as Record<string, unknown>;
      const existingContent = typeof payload.content === 'string' ? payload.content : '';
      const updatedEvent: NormalizedSessionEvent = {
        ...event,
        at: new Date().toISOString(),
        payload: {
          ...payload,
          content: `${existingContent}${chunk}`,
          optimistic: true,
          streaming: true,
          ...(trimmedRequestId ? { requestId: trimmedRequestId } : {}),
        },
      };
      nextEvents = [...this.state.events];
      nextEvents[streamEventIdx] = updatedEvent;
    } else {
      const streamMessageId = trimmedRequestId
        ? `streaming-assistant-${trimmedRequestId}`
        : `streaming-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const streamEvent: NormalizedSessionEvent = {
        at: new Date().toISOString(),
        type: 'message',
        payload: {
          role: 'assistant',
          content: chunk,
          id: streamMessageId,
          optimistic: true,
          streaming: true,
          ...(trimmedRequestId ? { requestId: trimmedRequestId } : {}),
        },
      };
      nextEvents = [...this.state.events, streamEvent];
    }

    this.set({
      events: nextEvents,
      eventsSessionKey: sessionKey,
      eventDrawerOpen: true,
      eventFilter: 'messages',
    });
  }

  /**
   * Inject an optimistic assistant message from SSE response payloads.
   * This prevents the chat timeline from dropping completed replies when
   * the REST event refresh races ahead of GraphD persistence.
   */
  injectOptimisticAssistantMessage(sessionKey: string, content: string, requestId?: string) {
    const rawTrimmedContent = content.trim();
    const trimmedRequestId = typeof requestId === 'string' && requestId.trim().length > 0
      ? requestId.trim()
      : null;
    const focused = this.state.focusData?.sessionKey ?? null;
    if (!focused || focused !== sessionKey) {
      if (rawTrimmedContent.length === 0) return;
      const cached = this.getLocalMessageCarry(sessionKey);
      const alreadyPresent = cached.some((event) => {
        if (event.type !== 'message') return false;
        const payload = event.payload as Record<string, unknown>;
        if (payload.role !== 'assistant') return false;
        const payloadContent = typeof payload.content === 'string' ? payload.content.trim() : '';
        if (payloadContent !== rawTrimmedContent) return false;
        if (trimmedRequestId) return payload.requestId === trimmedRequestId;
        return payload.optimistic === true;
      });
      if (alreadyPresent) return;
      const optimisticMessageId = `optimistic-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.syncLocalMessageCarry(sessionKey, [
        ...cached,
        {
          at: new Date().toISOString(),
          type: 'message',
          payload: {
            role: 'assistant',
            content,
            id: optimisticMessageId,
            optimistic: true,
            ...(trimmedRequestId ? { requestId: trimmedRequestId } : {}),
          },
        },
      ]);
      return;
    }
    let streamingEventIdx = -1;
    let unattributedStreamingEventIdx = -1;
    for (let idx = this.state.events.length - 1; idx >= 0; idx -= 1) {
      const event = this.state.events[idx];
      if (event.type !== 'message') continue;
      const payload = event.payload as Record<string, unknown>;
      if (payload.role !== 'assistant') continue;
      if (payload.streaming !== true) continue;
      const payloadRequestId = typeof payload.requestId === 'string' ? payload.requestId : '';
      const payloadContent = typeof payload.content === 'string' ? payload.content.trim() : '';
      if (trimmedRequestId) {
        if (payloadRequestId === trimmedRequestId) {
          streamingEventIdx = idx;
          break;
        }
        if (!payloadRequestId && unattributedStreamingEventIdx < 0) {
          unattributedStreamingEventIdx = idx;
        }
      } else if (payloadContent === rawTrimmedContent) {
        streamingEventIdx = idx;
        break;
      }
    }
    if (streamingEventIdx < 0 && trimmedRequestId && unattributedStreamingEventIdx >= 0) {
      streamingEventIdx = unattributedStreamingEventIdx;
    }
    if (streamingEventIdx < 0 && !trimmedRequestId && rawTrimmedContent.length === 0) {
      for (let idx = this.state.events.length - 1; idx >= 0; idx -= 1) {
        const event = this.state.events[idx];
        if (event.type !== 'message') continue;
        const payload = event.payload as Record<string, unknown>;
        if (payload.role !== 'assistant') continue;
        if (payload.streaming !== true) continue;
        streamingEventIdx = idx;
        break;
      }
    }
    const streamFallbackContent = streamingEventIdx >= 0
      ? (() => {
          const streamPayload = this.state.events[streamingEventIdx].payload as Record<string, unknown>;
          return typeof streamPayload.content === 'string' ? streamPayload.content : '';
        })()
      : '';
    const effectiveContent = rawTrimmedContent.length > 0 ? content : streamFallbackContent;
    const trimmedContent = effectiveContent.trim();
    if (!trimmedContent) return;
    if (streamingEventIdx >= 0) {
      const nextEvents = [...this.state.events];
      const streamEvent = nextEvents[streamingEventIdx];
      const streamPayload = streamEvent.payload as Record<string, unknown>;
      nextEvents[streamingEventIdx] = {
        ...streamEvent,
        at: new Date().toISOString(),
        payload: {
          ...streamPayload,
          content: effectiveContent,
          optimistic: true,
          streaming: false,
          ...(trimmedRequestId ? { requestId: trimmedRequestId } : {}),
        },
      };
      this.set({
        events: nextEvents,
        eventsSessionKey: sessionKey,
        eventDrawerOpen: true,
        eventFilter: 'messages',
      });
      return;
    }
    const alreadyPresent = this.state.events.some((event) => {
      if (event.type !== 'message') return false;
      const payload = event.payload as Record<string, unknown>;
      if (payload.role !== 'assistant') return false;
      if (payload.streaming === true) return false;
      const payloadContent = typeof payload.content === 'string' ? payload.content.trim() : '';
      if (payloadContent !== trimmedContent) return false;
      if (trimmedRequestId) {
        return payload.requestId === trimmedRequestId;
      }
      return payload.optimistic === true;
    });
    if (alreadyPresent) return;
    const optimisticMessageId = `optimistic-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: NormalizedSessionEvent = {
      at: new Date().toISOString(),
      type: 'message',
      payload: {
        role: 'assistant',
        content: effectiveContent,
        id: optimisticMessageId,
        optimistic: true,
        ...(trimmedRequestId ? { requestId: trimmedRequestId } : {}),
      },
    };
    this.set({
      events: [...this.state.events, optimistic],
      eventsSessionKey: sessionKey,
      eventDrawerOpen: true,
      eventFilter: 'messages',
    });
  }

  /** Remove transient streaming events (called on response event or focus change). */
  clearStreaming(sessionKey?: string, requestId?: string) {
    const focused = this.state.focusData?.sessionKey ?? null;
    const targetSessionKey = typeof sessionKey === 'string' && sessionKey.trim().length > 0
      ? sessionKey.trim()
      : this.state.eventsSessionKey ?? focused;
    const effectiveRequestId = typeof requestId === 'string' && requestId.trim().length > 0
      ? requestId.trim()
      : null;

    if (
      targetSessionKey
      && this.state.eventsSessionKey
      && targetSessionKey !== this.state.eventsSessionKey
    ) {
      return;
    }

    const shouldRemoveStreamingEvent = (event: NormalizedSessionEvent): boolean => {
      if (event.type !== 'message') return false;
      const payload = event.payload as Record<string, unknown>;
      if (payload.streaming !== true) return false;
      if (payload.role !== 'assistant') return false;
      const payloadRequestId = typeof payload.requestId === 'string' ? payload.requestId : '';
      if (effectiveRequestId) return payloadRequestId === effectiveRequestId || !payloadRequestId;
      // Legacy cleanup path: only remove unattributed stream events.
      return !payloadRequestId;
    };

    const hasStreamingEvents = this.state.events.some(shouldRemoveStreamingEvent);
    const nextEvents = hasStreamingEvents
      ? this.state.events.filter((event) => !shouldRemoveStreamingEvent(event))
      : this.state.events;

    if (!hasStreamingEvents) {
      return;
    }

    this.set({
      events: nextEvents,
    });
  }

  enqueuePermissionRequest = (request: CockpitPendingPermissionRequest) => {
    const requestId = request.requestId.trim();
    const sessionKey = request.sessionKey.trim();
    if (!requestId || !sessionKey) return;

    const alreadyQueued = this.state.pendingPermissionRequests.some(
      (entry) => entry.requestId === requestId && entry.sessionKey === sessionKey
    );
    if (alreadyQueued) return;

    this.set({
      pendingPermissionRequests: [...this.state.pendingPermissionRequests, request],
      permissionDialogOpen: true,
      permissionResponseError: null,
    });
  };

  dismissPermissionDialog = () => {
    this.set({ permissionDialogOpen: false, permissionResponseError: null });
  };

  handleRespondToPermissionRequest = async (
    decision: CockpitPermissionDecision,
    pattern?: string
  ) => {
    const active = this.state.pendingPermissionRequests[0];
    if (!active) return;
    this.set({ permissionResponseSubmitting: true, permissionResponseError: null });
    try {
      const response = await postCockpitPermissionResponse({
        sessionKey: active.sessionKey,
        requestId: active.requestId,
        decision,
        ...(typeof pattern === 'string' && pattern.trim().length > 0 ? { pattern: pattern.trim() } : {}),
      });
      if (!response.success) {
        this.set({
          permissionResponseSubmitting: false,
          permissionResponseError: response.error ?? 'Failed to submit permission response',
        });
        return;
      }

      const remaining = this.state.pendingPermissionRequests.filter(
        (entry) => !(entry.requestId === active.requestId && entry.sessionKey === active.sessionKey)
      );
      this.set({
        pendingPermissionRequests: remaining,
        permissionDialogOpen: remaining.length > 0,
        permissionResponseSubmitting: false,
        permissionResponseError: null,
        commandStatus: `Permission ${decision.replace('_', ' ')} sent`,
      });
    } catch (err) {
      this.set({
        permissionResponseSubmitting: false,
        permissionResponseError: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ─── Async handlers ────────────────────────────────────────

  handleOpenUpgradePicker = (): boolean => {
    this.set({ upgradePickerOpen: true });
    return true;
  };

  refreshTemplates = async () => {
    try {
      const templates = await getCockpitTemplates();
      this.set({ templates });
    } catch {
      // Templates are best-effort
    }
  };

  refreshRollups = async () => {
    try {
      const now = Date.now();
      const includeRepo = (now - this.lastRepoRollupRefreshAt) >= REPO_ROLLUP_REFRESH_INTERVAL_MS;
      const snapshot = await getCockpitRollupSnapshot({
        sessionLimit: 120,
        escalationLimit: 120,
        repoLimit: 50,
        includeRepo,
      });
      if (includeRepo) {
        this.lastRepoRollupRefreshAt = now;
      }
      this.setRollups({
        runningSessions: snapshot.runningSessions ?? [],
        readySessions: snapshot.readySessions ?? [],
        doneSessions: snapshot.doneSessions ?? [],
        escalations: snapshot.escalations ?? [],
        commitRollups: includeRepo ? (snapshot.commitRollups ?? []) : this.state.commitRollups,
        prRollups: includeRepo ? (snapshot.prRollups ?? []) : this.state.prRollups,
        metrics: snapshot.metrics ?? null,
      });
      if (snapshot.error) {
        this.set({ error: snapshot.error });
      }
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  refreshFocus = async (target: FocusTarget | null, options?: { includeHeavy?: boolean }) => {
    if (!target) {
      this.focusRefreshSeq += 1;
      this.clearFocus();
      return;
    }
    const requestSeq = this.focusRefreshSeq + 1;
    this.focusRefreshSeq = requestSeq;
    const isStale = (): boolean => {
      return requestSeq !== this.focusRefreshSeq;
    };
    const focusData = await getCockpitFocus(target.type, target.id);
    if (isStale()) return;
    if (!focusData) {
      this.clearFocus();
      return;
    }
    const includeHeavy = options?.includeHeavy ?? true;
    const [eventResponse, packetRows, sessionPermissions] = await Promise.all([
      getCockpitSessionEvents(focusData.sessionKey, { limit: 200 }),
      getCockpitSessionPackets(focusData.sessionKey, 50).catch(() => [] as FocusPacket[]),
      getCockpitSessionPermissions(focusData.sessionKey).catch(() => null),
    ]);
    if (isStale()) return;
    let traceRows: TraceRecord[];
    let reportRows: CockpitTestReport[];
    let diffResponse: CockpitDiff | null;
    if (includeHeavy) {
      const heavyResults = await Promise.all([
        getCockpitTraces(focusData.sessionKey, { limit: 120 }).catch(() => [] as TraceRecord[]),
        getCockpitTestReports({ sessionKey: focusData.sessionKey, limit: 20 }).catch(() => [] as CockpitTestReport[]),
        getCockpitDiff({ sessionKey: focusData.sessionKey }).catch(() => null),
      ]);
      if (isStale()) return;
      [traceRows, reportRows, diffResponse] = heavyResults;
    } else {
      traceRows = this.state.traces;
      reportRows = this.state.testReports;
      diffResponse = this.state.diffData;
    }
    if (isStale()) return;
    const selectedPacket = focusData.packet ?? packetRows[0] ?? null;
    this.setFocusData({
      focusData: { ...focusData, packet: selectedPacket },
      events: eventResponse.events,
      packets: packetRows,
      traces: traceRows,
      testReports: reportRows,
      diffData: diffResponse,
      sessionPermissions,
    });
    const focusPreviewUrl = typeof focusData?.header?.previewUrl === 'string'
      ? focusData.header.previewUrl
      : '';
    if (focusPreviewUrl && !this.state.browserUrlDraft) {
      this.set({ browserUrlDraft: focusPreviewUrl });
    }
    // Lazy-load model selection for the focused session
    void this.refreshSessionModel(focusData.sessionKey);
  };

  refreshFocusEvents = async (sessionKey?: string, limit = 200) => {
    const key = sessionKey ?? this.state.focusData?.sessionKey;
    if (!key) return;
    try {
      const eventResponse = await getCockpitSessionEvents(key, { limit });
      const focusedSessionKey = this.state.focusData?.sessionKey ?? null;
      if (focusedSessionKey !== key) return;
      const currentEventsSessionKey = this.state.eventsSessionKey ?? focusedSessionKey;
      const localEvents = currentEventsSessionKey === key
        ? this.state.events
        : this.getLocalMessageCarry(key);
      const maxEvents = Math.max(limit * 4, 800);
      const mergedEvents = mergeServerAndLocalMessageEvents(
        eventResponse.events,
        localEvents,
        maxEvents
      );
      const hasMessages = mergedEvents.some((event) => event.type === 'message');
      this.set({
        events: mergedEvents,
        eventsSessionKey: key,
        ...(hasMessages && !this.state.eventDrawerOpen ? { eventDrawerOpen: true } : {}),
      });
    } catch {
      // Keep streaming refresh resilient to transient event endpoint errors.
    }
  };

  refreshAll = async () => {
    const target = this.state.focusTarget;
    const now = Date.now();
    const includeHeavyFocus = target
      ? (now - this.lastHeavyFocusRefreshAt) >= HEAVY_FOCUS_REFRESH_INTERVAL_MS
      : false;
    if (includeHeavyFocus) {
      this.lastHeavyFocusRefreshAt = now;
    }
    await Promise.all([
      this.refreshRollups(),
      target ? this.refreshFocus(target, { includeHeavy: includeHeavyFocus }) : undefined,
    ]);
  };

  handleSelectDiffFile = async (path: string) => {
    if (!path || !this.state.diffData || !this.state.focusData?.sessionKey) return;

    const hotspotIdx = this.state.diffData.hotspots.findIndex((h) => h.path === path);
    if (hotspotIdx < 0) return;

    const cacheKey = `${this.state.focusData.sessionKey}:${this.state.diffData.baseSha}:${this.state.diffData.headSha}:${path}`;
    const cachedPatch = this.diffPatchCache.get(cacheKey);
    if (cachedPatch !== undefined) {
      this.set({
        selectedDiffFile: path,
        highlightedDiffIdx: hotspotIdx,
        diffPatchFile: path,
        diffPatchLoadingFile: null,
        diffPatchError: null,
        diffData: { ...this.state.diffData, patch: cachedPatch },
      });
      return;
    }

    const reqSeq = this.diffPatchRequestSeq + 1;
    this.diffPatchRequestSeq = reqSeq;
    this.set({
      selectedDiffFile: path,
      highlightedDiffIdx: hotspotIdx,
      diffPatchLoadingFile: path,
      diffPatchError: null,
    });

    try {
      const response = await getCockpitDiff({
        sessionKey: this.state.focusData.sessionKey,
        base: this.state.diffData.baseSha,
        head: this.state.diffData.headSha,
        file: path,
      });
      if (this.diffPatchRequestSeq !== reqSeq) return;
      this.diffPatchCache.set(cacheKey, response.patch);
      const latestDiff = this.state.diffData;
      if (!latestDiff) return;
      this.set({
        diffData: { ...latestDiff, patch: response.patch },
        diffPatchFile: path,
        diffPatchLoadingFile: null,
        diffPatchError: null,
      });
    } catch (err) {
      if (this.diffPatchRequestSeq !== reqSeq) return;
      this.set({
        diffPatchFile: path,
        diffPatchLoadingFile: null,
        diffPatchError: err instanceof Error ? err.message : String(err),
      });
    }
  };

  handleApplyPatch = async () => {
    const { focusData, patchDraft, diffData: dd } = this.state;
    if (!focusData?.sessionKey || !patchDraft.trim()) return;
    this.set({ applyingPatch: true, patchApplyStatus: null });
    try {
      const response = await applyCockpitPatch({
        sessionKey: focusData.sessionKey,
        patch: patchDraft,
        ...(dd?.baseSha ? { baseSha: dd.baseSha } : {}),
      });
      if (response.success) {
        this.set({
          patchApplyStatus: `Applied ${response.mode ?? 'patch'}: ${response.files?.length ?? 0} files, ${response.changedLines ?? 0} lines`,
          patchDraft: '',
          applyingPatch: false,
        });
        await this.refreshAll();
      } else {
        this.set({ patchApplyStatus: 'Patch apply failed', applyingPatch: false });
      }
    } catch (err) {
      this.set({ patchApplyStatus: err instanceof Error ? err.message : String(err), applyingPatch: false });
    }
  };

  handleResolveEscalation = async (escalationId: string) => {
    const freeformResponse = window.prompt('Resolution note (optional):');
    if (freeformResponse === null) return;
    this.set({ resolvingEscalationId: escalationId });
    try {
      await resolveCockpitEscalation(escalationId, {
        freeformResponse: freeformResponse.trim() || undefined,
      });
      this.set({ focusTarget: null, resolvingEscalationId: null });
      await this.refreshAll();
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err), resolvingEscalationId: null });
    }
  };

  handleReviewDecision = async (decision: 'accept' | 'request_changes') => {
    const sessionKey = this.state.focusData?.sessionKey;
    if (!sessionKey) return;
    const note = window.prompt(
      decision === 'accept' ? 'Optional acceptance note:' : 'Optional request-changes note:'
    );
    if (note === null) return;
    this.set({ reviewDecisionAction: decision });
    try {
      await postCockpitSessionReviewDecision(sessionKey, {
        decision,
        note: note.trim() || undefined,
      });
      this.set({ reviewDecisionAction: null });
      await this.refreshAll();
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err), reviewDecisionAction: null });
    }
  };

  handleRefreshSessionPermissions = async () => {
    const sessionKey = this.state.focusData?.sessionKey;
    if (!sessionKey) return;
    try {
      const response = await getCockpitSessionPermissions(sessionKey);
      this.set({ sessionPermissions: response, permissionsSaveStatus: null });
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  refreshSessionModel = async (sessionKey?: string) => {
    const key = sessionKey ?? this.state.focusData?.sessionKey;
    if (!key) return;
    this.set({ sessionModelLoading: true });
    try {
      const response = await getCockpitSessionModel(key);
      const standardSelection = response.selections?.standard ?? null;
      this.set({
        sessionModelSelection: standardSelection,
        sessionModelCatalog: response.models ?? [],
        sessionModelLoading: false,
      });
    } catch {
      this.set({ sessionModelLoading: false });
    }
  };

  handleSetSessionModel = async (provider: string, model: string, reasoning?: string) => {
    const sessionKey = this.state.focusData?.sessionKey;
    if (!sessionKey) return;
    this.set({ sessionModelLoading: true });
    try {
      const result = await postCockpitSessionModel(sessionKey, {
        provider,
        model,
        agentType: 'standard',
        ...(reasoning ? { reasoning } : {}),
      });
      if (result.success) {
        this.set({
          sessionModelSelection: result.selection,
          sessionModelLoading: false,
        });
      } else {
        this.set({ sessionModelLoading: false });
      }
    } catch (err) {
      this.set({
        error: err instanceof Error ? err.message : String(err),
        sessionModelLoading: false,
      });
    }
  };

  handleUpdateSessionPermissions = async (input: CockpitSessionPermissionUpdateInput) => {
    const sessionKey = this.state.focusData?.sessionKey;
    if (!sessionKey) return;
    this.set({ permissionsSaving: true, permissionsSaveStatus: null });
    try {
      const response = await postCockpitSessionPermissions(sessionKey, input);
      this.set({
        sessionPermissions: response,
        permissionsSaving: false,
        permissionsSaveStatus: 'Permissions updated',
      });
    } catch (err) {
      this.set({
        permissionsSaving: false,
        permissionsSaveStatus: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  handleRunGrepSearch = async (query?: string, sessionKey?: string | null) => {
    const q = (query ?? this.state.lensQuery).trim();
    if (!q) return;
    const scopedSessionKey = sessionKey ?? this.state.focusData?.sessionKey;
    this.set({ lensLoading: true, lensQuery: q, globalTool: 'grep' });
    try {
      const results = await searchCockpitRepoLens({
        ...(scopedSessionKey ? { sessionKey: scopedSessionKey } : {}),
        q,
        kind: 'all',
        limit: 120,
      });
      const total = results.defs.length + results.refs.length + results.text.length;
      this.set({
        lensResults: results,
        lensLoading: false,
        commandStatus: `Repo grep: ${total} match${total === 1 ? '' : 'es'}`,
      });
    } catch (err) {
      this.set({
        error: err instanceof Error ? err.message : String(err),
        lensLoading: false,
      });
    }
  };

  handleSlashCommand = async (raw: string): Promise<boolean> => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/')) return false;

    const [commandRaw, ...rest] = trimmed.slice(1).split(/\s+/);
    const command = commandRaw.toLowerCase();
    const args = rest.join(' ').trim();

    if (command === 'grep') {
      if (!args || args.toLowerCase() === 'clear') {
        this.set({ sessionFilterQuery: '', commandStatus: 'Session grep cleared' });
        return true;
      }
      if (args.toLowerCase().startsWith('repo ')) {
        const repoQuery = args.slice('repo '.length).trim();
        if (!repoQuery) {
          this.set({ commandStatus: 'Usage: /grep <query>' });
          return true;
        }
        await this.handleRunGrepSearch(repoQuery, null);
        return true;
      }
      const allSessions = [
        ...this.state.runningSessions,
        ...this.state.readySessions,
        ...this.state.doneSessions,
      ];
      const queryLower = args.toLowerCase();
      const matched = allSessions.filter((row) =>
        row.sessionKey.toLowerCase().includes(queryLower)
        || row.title.toLowerCase().includes(queryLower)
        || row.currentActivity.tool.toLowerCase().includes(queryLower)
        || (row.currentActivity.file ?? '').toLowerCase().includes(queryLower)
      );
      this.set({
        sessionFilterQuery: args,
        globalTool: 'none',
        commandStatus: `Session grep: ${matched.length} match${matched.length === 1 ? '' : 'es'}`,
      });
      return true;
    }

    if (command === 'browser' || command === 'preview') {
      const target = args || this.state.focusData?.sessionKey || '';
      this.set({
        globalTool: 'browser',
        ...(target ? { browserSessionScope: target } : {}),
        commandStatus: target ? `Preview scoped to ${target}` : 'Preview opened',
      });
      return true;
    }

    if (command === 'doc' || command === 'document') {
      this.set({ globalTool: 'none', commandStatus: 'Document view' });
      return true;
    }

    if (command === 'promote') {
      this.handleOpenUpgradePicker();
      return true;
    }

    if (command === 'async') {
      // /async cancel — cancel running async on focused session
      if (args.toLowerCase() === 'cancel') {
        const focusedKey = this.state.focusData?.sessionKey ?? this.state.focusTarget?.id;
        if (!focusedKey) {
          this.set({ commandStatus: 'No session focused' });
          return true;
        }
        this.set({ commandStatus: 'Cancelling async run…' });
        try {
          const result = await postCockpitSessionAsyncCancel(focusedKey);
          this.set({ commandStatus: result.success ? 'Async run cancelled' : (result.error ?? 'Failed to cancel') });
        } catch (err) {
          this.set({ commandStatus: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      // /async status — check async status on focused session
      if (args.toLowerCase() === 'status') {
        const focusedKey = this.state.focusData?.sessionKey ?? this.state.focusTarget?.id;
        if (!focusedKey) {
          this.set({ commandStatus: 'No session focused' });
          return true;
        }
        this.set({ commandStatus: 'Checking async status…' });
        try {
          const result = await getCockpitSessionAsyncStatus(focusedKey);
          if (result.running) {
            const elapsed = typeof result.elapsedMs === 'number' ? `${Math.round(result.elapsedMs / 1000)}s` : '?';
            this.set({ commandStatus: `Async running: "${result.goal}" (${elapsed})` });
          } else {
            this.set({ commandStatus: 'No async run active on this session' });
          }
        } catch (err) {
          this.set({ commandStatus: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      // /async <goal> — create session + start async
      const goal = args;
      if (!goal) {
        this.set({ commandStatus: 'Usage: /async <goal>' });
        return true;
      }
      const projectPath = this.state.workspaceProjectPath;
      if (!projectPath) {
        this.set({ commandStatus: 'Select a project workspace first' });
        return true;
      }

      this.set({ commandStatus: 'Creating async session…' });
      try {
        const createResult = await postCockpitSessionCreate({
          goal,
          projectPath,
          createProjectPath: true,
          metadata: { source: 'cockpit-async-command' },
        });
        if (!createResult.success || !createResult.sessionKey) {
          this.set({ commandStatus: createResult.error ?? 'Failed to create session' });
          return true;
        }

        const asyncResult = await postCockpitSessionAsyncStart(createResult.sessionKey, goal);
        if (!asyncResult.success) {
          this.set({ commandStatus: asyncResult.error ?? 'Failed to start async session' });
          return true;
        }

        this.set({
          focusTarget: { type: 'session', id: createResult.sessionKey },
          focusTab: 'live',
          globalTool: 'none',
          eventDrawerOpen: true,
          eventFilter: 'messages',
          inputVisible: true,
          commandStatus: `Async session ${createResult.sessionKey} started`,
        });
        focusChatInputOrCenterPane();

        void this.refreshFocusEvents(createResult.sessionKey, 200);
        void this.refreshRollups();
      } catch (err) {
        this.set({ commandStatus: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (command === 'new') {
      const goal = args || 'New session';
      this.set({ commandStatus: 'Creating session…' });
      try {
        const result = await postCockpitSessionCreate({ goal });
        if (result.success && result.sessionKey) {
          this.set({
            focusTarget: { type: 'session', id: result.sessionKey },
            eventDrawerOpen: true,
            eventFilter: 'messages',
            inputVisible: true,
            globalTool: 'none',
            commandStatus: `Session ${result.sessionKey} created`,
          });
          focusChatInputOrCenterPane();
        } else {
          this.set({ commandStatus: result.error ?? 'Failed to create session' });
        }
      } catch (err) {
        this.set({ commandStatus: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (command === 'diff') {
      if (!this.state.focusData?.sessionKey) {
        this.set({ commandStatus: 'Focus a session first to view diff' });
        return true;
      }
      this.set({ focusTab: 'diff', commandStatus: null });
      return true;
    }

    if (command === 'tests') {
      if (!this.state.focusData?.sessionKey) {
        this.set({ commandStatus: 'Focus a session first to view tests' });
        return true;
      }
      this.set({ focusTab: 'tests', commandStatus: null });
      return true;
    }

    if (command === 'fork' || command === 'stop') {
      return false;
    }

    // Workflow template commands — match against all loaded templates
    const matchedTemplate = this.state.templates.find(
      (t) => t.name.toLowerCase() === command
    );
    if (matchedTemplate) {
      await this.handleWorkflowCommand(matchedTemplate, args);
      return true;
    }

    this.set({ commandStatus: `Unknown command: /${command}` });
    return true;
  };

  handleWorkflowCommand = async (template: WorkItemTemplate, rawArgs: string) => {
    const { refs, rest: prompt } = extractAtRefs(rawArgs);
    if (!prompt) {
      this.set({ commandStatus: `Usage: /${template.name} <prompt>` });
      return;
    }
    const projectPath = this.state.workspaceProjectPath;
    if (!projectPath) {
      this.set({ commandStatus: 'Select a project workspace first' });
      return;
    }

    this.set({ commandStatus: `Creating ${template.name} workflow…` });

    try {
      // Load spec file content if @refs provided
      let specContent: string | undefined;
      if (refs.length > 0) {
        try {
          const file = await getCockpitMarkdownFile(refs[0], { projectPath });
          specContent = file.content;
        } catch (err) {
          this.set({ commandStatus: `Failed to load @${refs[0]}: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
      }

      const metadata: Record<string, unknown> = {
        source: 'cockpit-workflow-command',
        documentType: 'workflow',
        templateName: template.name,
        templateId: template.id,
      };

      // Create session
      const result = await postCockpitSessionCreate({
        goal: prompt,
        projectPath,
        createProjectPath: true,
        metadata,
      });
      if (!result.success || !result.sessionKey) {
        this.set({ commandStatus: result.error ?? 'Failed to create session' });
        return;
      }

      // Send first message with workflow metadata + optional spec content
      const markdownContext: CockpitMarkdownContextInput = {
        projectPath,
        metadata: {
          documentType: 'workflow',
          templateName: template.name,
          templateId: template.id,
          workspaceProjectPath: projectPath,
        },
        ...(specContent ? { content: specContent } : {}),
      };

      await postCockpitSessionMessage(result.sessionKey, prompt, { markdownContext });

      this.set({
        focusTarget: { type: 'session', id: result.sessionKey },
        focusTab: 'live',
        globalTool: 'none',
        eventDrawerOpen: true,
        eventFilter: 'messages',
        inputVisible: true,
        commandStatus: `${template.name} session ${result.sessionKey} created`,
      });
      focusChatInputOrCenterPane();

      void this.refreshFocusEvents(result.sessionKey, 200);
      void this.refreshRollups();
    } catch (err) {
      this.set({ commandStatus: err instanceof Error ? err.message : String(err) });
    }
  };

  handleSendMessage = async (draftOverride?: string) => {
    const { focusData, messageDraft, sendingMessage: alreadySending } = this.state;
    const draft = typeof draftOverride === 'string' ? draftOverride : messageDraft;
    if (alreadySending || !draft.trim()) return;
    const trimmedDraft = draft.trim();
    const optimisticMessageId = `optimistic-${Date.now()}`;
    this.set({ sendingMessage: true });
    try {
      if (trimmedDraft.startsWith('/')) {
        const handledLocally = await this.handleSlashCommand(trimmedDraft);
        if (handledLocally) {
          this.set({ messageDraft: '', sendingMessage: false });
          return;
        }
      }

      const markdownContext = this.markdownContextProvider?.() ?? null;
      let sessionKey = focusData?.sessionKey ?? null;

      // No focused session but a document is open — create a document session
      if (!sessionKey && markdownContext?.path) {
        const projectPath = this.state.workspaceProjectPath;
        if (!projectPath) {
          this.set({ sendingMessage: false, error: 'Select a project workspace first' });
          return;
        }
        const result = await postCockpitSessionCreate({
          goal: trimmedDraft,
          markdownPath: markdownContext.path,
          projectPath,
          createProjectPath: true,
          metadata: { source: 'cockpit-document-chat', documentPath: markdownContext.path },
        });
        if (!result.success || !result.sessionKey) {
          this.set({ sendingMessage: false, error: result.error ?? 'Failed to create session' });
          return;
        }
        sessionKey = result.sessionKey;
        this.documentSessionPaths.set(sessionKey, markdownContext.path);
        this.set({
          focusTarget: { type: 'session', id: sessionKey },
          focusTab: 'document',
        });
        void this.refreshRollups();
      }

      if (!sessionKey) {
        this.set({ sendingMessage: false, error: 'Select a session or open a document to send a message' });
        return;
      }
      if (this.beforeSendMessageHook) {
        const proceed = await this.beforeSendMessageHook();
        if (proceed === false) {
          this.set({ sendingMessage: false });
          return;
        }
      }
      // Optimistic: render user message immediately while the backend dispatch is being prepared.
      const optimistic: NormalizedSessionEvent = {
        at: new Date().toISOString(),
        type: 'message',
        payload: { role: 'user', content: trimmedDraft, id: optimisticMessageId, optimistic: true },
      };
      this.set({
        messageDraft: '',
        commandStatus: null,
        events: [...this.state.events, optimistic],
        eventsSessionKey: sessionKey,
        eventDrawerOpen: true,
        eventFilter: 'messages',
      });

      const response = await postCockpitSessionMessage(
        sessionKey,
        trimmedDraft,
        markdownContext ? { markdownContext } : undefined
      );
      const responseRequestId = typeof response.requestId === 'string' && response.requestId.trim().length > 0
        ? response.requestId.trim()
        : null;
      if (responseRequestId) {
        const nextEvents = this.state.events.map((event) => {
          if (event.type !== 'message') return event;
          const payload = event.payload;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return event;
          if ((payload as Record<string, unknown>).id !== optimisticMessageId) return event;
          return {
            ...event,
            payload: {
              ...(payload as Record<string, unknown>),
              requestId: responseRequestId,
            },
          };
        });
        this.set({
          events: nextEvents,
          sendingMessage: false,
        });
      } else {
        this.set({
          sendingMessage: false,
        });
      }
      // Background refresh: prioritize focused session events first, then rollups.
      void this.refreshFocusEvents(sessionKey, 200);
      void this.refreshRollups();
    } catch (err) {
      const revertedEvents = this.state.events.filter((event) => {
        if (event.type !== 'message') return true;
        const payload = event.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return true;
        return (payload as Record<string, unknown>).id !== optimisticMessageId;
      });
      this.set({
        error: err instanceof Error ? err.message : String(err),
        sendingMessage: false,
        messageDraft: trimmedDraft,
        events: revertedEvents,
      });
    }
  };

  handleSelectTestReport = async (reportId: string) => {
    const existing = this.state.testReports.find((r) => r.id === reportId);
    if (existing) {
      this.set({ selectedTestReportId: reportId, selectedTestReport: existing });
      return;
    }
    this.set({ selectedTestReportId: reportId });
    const report = await getCockpitTestReport(reportId);
    if (report) this.set({ selectedTestReport: report });
  };

  handleSelectCommit = (row: CommitRollup) => {
    if (!row.sessionKey) return;
    this.set({
      focusTarget: { type: 'session', id: row.sessionKey },
      pendingCommitRange: {
        sessionKey: row.sessionKey,
        ...(row.baseSha ? { base: row.baseSha } : {}),
        ...(row.headSha ? { head: row.headSha } : {}),
      },
    });
  };

  handleSelectPR = (row: PRRollup) => {
    if (row.sessionKey) {
      this.set({ focusTarget: { type: 'session', id: row.sessionKey } });
    }
    window.open(row.url, '_blank', 'noopener,noreferrer');
  };

  resolvePacketRef = (refTypeRaw: string, targetRaw: string): boolean => {
    const refType = refTypeRaw.trim().toLowerCase();
    const target = targetRaw.trim();
    if (!refType || !target) return false;

    const shaShort = (a: string | undefined, b: string) => {
      if (!a) return false;
      const l = a.toLowerCase(), r = b.toLowerCase();
      return l === r || l.startsWith(r) || r.startsWith(l);
    };

    if (refType === 'commit') {
      if (shaShort(this.state.diffData?.headSha, target) || shaShort(this.state.diffData?.baseSha, target)) return true;
      return this.state.commitRollups.some((r) => shaShort(r.sha, target))
        || this.state.traces.some((t) => shaShort(t.vcs?.revision, target));
    }
    if (refType === 'file') {
      const path = target.split('#')[0];
      const hotspotPaths = new Set((this.state.diffData?.hotspots ?? []).map((h) => h.path));
      const tracePaths = new Set(this.state.traces.flatMap((t) => (t.files ?? []).map((f) => f.path)).filter(Boolean));
      return hotspotPaths.has(path) || tracePaths.has(path);
    }
    if (refType === 'testreport') return this.state.testReports.some((r) => r.id === target);
    if (refType === 'trace') return this.state.traces.some((t) => t.id === target || shaShort(t.vcs?.revision, target));
    if (refType === 'workitem') {
      if (typeof this.state.focusData?.header?.activeWorkItemId === 'string' && this.state.focusData.header.activeWorkItemId === target) return true;
      return this.state.events.some((e) => String(e.payload.workItemId ?? '') === target);
    }
    if (refType === 'session') {
      const allKeys = new Set([...this.state.runningSessions, ...this.state.readySessions, ...this.state.doneSessions].map((r) => r.sessionKey));
      return this.state.focusData?.sessionKey === target || allKeys.has(target);
    }
    if (refType === 'pr') {
      const num = Number(target.replace(/^#/, '').trim());
      return this.state.prRollups.some((r) => r.prId === target || r.url.includes(target) || (Number.isFinite(num) && r.number === num));
    }
    return false;
  };

  handlePacketRefClick = async (refType: string, target: string) => {
    const type = refType.toLowerCase();

    if (type === 'commit') {
      this.set({ focusTab: 'diff' });
      if (this.state.focusData?.sessionKey) {
        const response = await getCockpitDiff({ sessionKey: this.state.focusData.sessionKey, head: target }).catch(() => null);
        if (response) {
          this.set({
            diffData: response,
            selectedDiffFile: response.hotspots[0]?.path ?? null,
            highlightedDiffIdx: response.hotspots.length > 0 ? 0 : null,
            diffPatchFile: null,
            diffPatchLoadingFile: null,
            diffPatchError: null,
          });
        }
      }
      return;
    }
    if (type === 'file') {
      const path = target.split('#')[0];
      this.set({ focusTab: 'diff' });
      await this.handleSelectDiffFile(path);
      return;
    }
    if (type === 'testreport') {
      this.set({ focusTab: 'tests' });
      await this.handleSelectTestReport(target);
      return;
    }
    if (type === 'trace') {
      this.set({ focusTab: 'trace' });
    }
  };

  handlePacketLinkClick = async (target: string) => {
    if (!target) return;
    let parsed: URL;
    try {
      parsed = new URL(target, window.location.origin);
    } catch {
      return;
    }
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.includes('/diff')) {
      this.set({ focusTab: 'diff' });
      if (this.state.focusData?.sessionKey) {
        const response = await getCockpitDiff({
          sessionKey: this.state.focusData.sessionKey,
          ...(parsed.searchParams.get('base') ? { base: String(parsed.searchParams.get('base')) } : {}),
          ...(parsed.searchParams.get('head') ? { head: String(parsed.searchParams.get('head')) } : {}),
        }).catch(() => null);
        if (response) {
          this.set({
            diffData: response,
            selectedDiffFile: response.hotspots[0]?.path ?? null,
            highlightedDiffIdx: response.hotspots.length > 0 ? 0 : null,
            diffPatchFile: null,
            diffPatchLoadingFile: null,
            diffPatchError: null,
          });
        }
      }
      return;
    }
    if (pathname.includes('/tests')) {
      this.set({ focusTab: 'tests' });
      const reportId = parsed.searchParams.get('id');
      if (reportId) await this.handleSelectTestReport(reportId);
      return;
    }
    if (pathname.includes('/trace')) {
      this.set({ focusTab: 'trace' });
      return;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    }
  };

  // ─── Registration hooks (called from App.tsx) ──────────────

  getDocumentSessionPath = (sessionKey: string): string | null => {
    return this.documentSessionPaths.get(sessionKey) ?? null;
  };

  registerMarkdownContextProvider = (provider: () => CockpitMarkdownContextInput | null): (() => void) => {
    this.markdownContextProvider = provider;
    return () => {
      if (this.markdownContextProvider === provider) {
        this.markdownContextProvider = null;
      }
    };
  };

  registerBeforeSendMessageHook = (hook: () => Promise<boolean> | boolean): (() => void) => {
    this.beforeSendMessageHook = hook;
    return () => {
      if (this.beforeSendMessageHook === hook) {
        this.beforeSendMessageHook = null;
      }
    };
  };
}

// ─── React integration ───────────────────────────────────────

export const CockpitStoreContext = createContext<CockpitStoreImpl | null>(null);

/** Selector hook — re-renders ONLY when the selected value changes. */
export function useCockpit<T>(selector: (state: CockpitState) => T): T {
  const store = useContext(CockpitStoreContext)!;
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()));
}

/** Returns the store instance. Stable ref — never causes re-renders on its own. */
export function useCockpitStore(): CockpitStoreImpl {
  return useContext(CockpitStoreContext)!;
}
