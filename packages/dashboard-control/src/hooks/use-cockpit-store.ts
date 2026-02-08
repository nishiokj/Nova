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
  postCockpitSessionModel,
  postCockpitSessionPermissions,
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
  getCockpitTemplates,
  getCockpitTestReport,
  getCockpitTestReports,
  getCockpitTraces,
  postCockpitSessionCreate,
  postCockpitSessionMessage,
  postCockpitSessionReviewDecision,
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
import { parseFrontmatter, serializeFrontmatter } from '@/lib/markdown';
import { parsePacketMarkdown } from '@/lib/packets';

// ─── Types ───────────────────────────────────────────────────

export type FocusTarget =
  | { type: 'session'; id: string }
  | { type: 'escalation'; id: string };

export type FocusTab = 'live' | 'packet' | 'escalations' | 'diff' | 'tests' | 'trace' | 'permissions';
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

  // Lens
  lensLoading: boolean;

  // Pending commit range (for cross-linking commits → diff)
  pendingCommitRange: { sessionKey: string; base?: string; head?: string } | null;

  // Workflows
  templates: WorkItemTemplate[];

  // Document session (lazy creation)
  documentSessionKey: string | null;

  // Promote picker
  upgradePickerOpen: boolean;

  // SSE streaming — live agent message text before REST canonicalization
  streamingText: string;

  // Keyboard nav highlight in right pane
  highlightedSessionIdx: number | null;
  commandPaletteOpen: boolean;
  commandPaletteQuery: string;
  shortcutSheetOpen: boolean;

  // Inline ghost autocomplete
  autocompleteEnabled: boolean;

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

  lensLoading: false,
  pendingCommitRange: null,

  templates: [],
  documentSessionKey: null,
  upgradePickerOpen: false,

  streamingText: '',

  highlightedSessionIdx: null,
  commandPaletteOpen: false,
  commandPaletteQuery: '',
  shortcutSheetOpen: false,

  autocompleteEnabled: false,

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
    const result = events.filter((event) => {
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
    // Append live streaming text from SSE as a synthetic assistant message
    if (state.streamingText) {
      result.push({
        at: new Date().toISOString(),
        type: 'message',
        payload: { role: 'assistant', content: state.streamingText, streaming: true },
      });
    }
    return result;
  }
  if (eventFilter === 'failures') return events.filter(isFailureEvent);
  if (eventFilter === 'all') {
    return events;
  }
  return events;
}

// ─── Store ───────────────────────────────────────────────────

export class CockpitStoreImpl {
  state: CockpitState = initialState;
  private listeners = new Set<() => void>();
  private diffPatchRequestSeq = 0;
  private diffPatchCache = new Map<string, string | null>();
  private lastRepoRollupRefreshAt = Date.now();
  private lastHeavyFocusRefreshAt = 0;
  private markdownContextProvider: (() => CockpitMarkdownContextInput | null) | null = null;
  private markdownSetContent: ((content: string) => void) | null = null;
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
    const hasMessages = events.some((e) => e.type === 'message');
    this.state = {
      ...this.state,
      focusData,
      events,
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
    this.notify();
  }

  clearFocus() {
    this.state = {
      ...this.state,
      focusData: null,
      events: [],
      streamingText: '',
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
  injectStreamChunk(sessionKey: string, chunk: string) {
    const focused = this.state.focusData?.sessionKey ?? this.state.documentSessionKey ?? null;
    if (!focused || focused !== sessionKey) return;
    this.set({ streamingText: this.state.streamingText + chunk });
  }

  /** Clear accumulated streaming text (called on response event or focus change). */
  clearStreaming() {
    if (!this.state.streamingText) return;
    this.set({ streamingText: '' });
  }

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
      this.clearFocus();
      return;
    }
    const focusData = await getCockpitFocus(target.type, target.id);
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
    let traceRows: TraceRecord[];
    let reportRows: CockpitTestReport[];
    let diffResponse: CockpitDiff | null;
    if (includeHeavy) {
      const heavyResults = await Promise.all([
        getCockpitTraces(focusData.sessionKey, { limit: 120 }).catch(() => [] as TraceRecord[]),
        getCockpitTestReports({ sessionKey: focusData.sessionKey, limit: 20 }).catch(() => [] as CockpitTestReport[]),
        getCockpitDiff({ sessionKey: focusData.sessionKey }).catch(() => null),
      ]);
      [traceRows, reportRows, diffResponse] = heavyResults;
    } else {
      traceRows = this.state.traces;
      reportRows = this.state.testReports;
      diffResponse = this.state.diffData;
    }
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
      const documentSessionKey = this.state.documentSessionKey;
      const shouldApply = focusedSessionKey === key || (!focusedSessionKey && documentSessionKey === key);
      if (!shouldApply) return;
      // Carry forward optimistic messages not yet matched by a server-side entry
      const optimistic = this.state.events.filter(e =>
        e.type === 'message' && (e.payload as Record<string, unknown>).optimistic === true
      );
      const serverMessages = eventResponse.events.filter(e => e.type === 'message');
      const survivingOptimistic = optimistic.filter(opt => {
        const optContent = (opt.payload as Record<string, unknown>).content;
        return !serverMessages.some(s =>
          (s.payload as Record<string, unknown>).role === (opt.payload as Record<string, unknown>).role
          && (s.payload as Record<string, unknown>).content === optContent
        );
      });
      const mergedEvents = survivingOptimistic.length > 0
        ? [...eventResponse.events, ...survivingOptimistic].sort(
            (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
          )
        : eventResponse.events;
      const hasMessages = mergedEvents.some((event) => event.type === 'message');
      this.set({
        events: mergedEvents,
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

    this.set({ commandStatus: `Unknown command: /${command}` });
    return true;
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
      const markdownMetadata = (
        markdownContext?.metadata
        && typeof markdownContext.metadata === 'object'
        && !Array.isArray(markdownContext.metadata)
      )
        ? markdownContext.metadata as Record<string, unknown>
        : {};
      const markdownBoundSessionKey = typeof markdownMetadata.documentSessionKey === 'string'
        && markdownMetadata.documentSessionKey.trim().length > 0
        ? markdownMetadata.documentSessionKey.trim()
        : null;

      let sessionKey = focusData?.sessionKey ?? this.state.documentSessionKey ?? null;
      if (!focusData?.sessionKey && markdownBoundSessionKey) {
        sessionKey = markdownBoundSessionKey;
        if (this.state.documentSessionKey !== markdownBoundSessionKey) {
          this.set({ documentSessionKey: markdownBoundSessionKey });
        }
      }

      // Lazy session creation: no focused session, but we have markdown context
      if (!sessionKey && !this.state.focusTarget && this.state.globalTool === 'none') {
        if (markdownContext) {
          const firstLine = trimmedDraft.split('\n')[0].slice(0, 200);
          const workspaceProjectPath = typeof markdownMetadata.workspaceProjectPath === 'string'
            && markdownMetadata.workspaceProjectPath.trim().length > 0
            ? markdownMetadata.workspaceProjectPath.trim()
            : undefined;
          const documentType = typeof markdownMetadata.documentType === 'string'
            ? markdownMetadata.documentType
            : undefined;
          if ((documentType === 'workflow' || documentType === 'executable') && !workspaceProjectPath) {
            this.set({
              sendingMessage: false,
              error: 'Workflow/executable docs need project scope before creating a session. Pick a project in the Files workspace selector.',
            });
            return;
          }
          const result = await postCockpitSessionCreate({
            goal: firstLine,
            markdownPath: markdownContext.path,
            ...(workspaceProjectPath ? { projectPath: workspaceProjectPath } : {}),
            ...(workspaceProjectPath ? { createProjectPath: true } : {}),
            metadata: {
              source: 'cockpit-document',
              markdownPath: markdownContext.path,
              ...(typeof markdownMetadata.documentType === 'string'
                ? { documentType: markdownMetadata.documentType }
                : {}),
              ...(typeof markdownMetadata.templateName === 'string'
                ? { templateName: markdownMetadata.templateName }
                : {}),
              ...(typeof markdownMetadata.templateId === 'string'
                ? { templateId: markdownMetadata.templateId }
                : {}),
              ...(Array.isArray(markdownMetadata.specs)
                ? { specs: markdownMetadata.specs }
                : {}),
              chatScope: 'document',
            },
          });
          if (result.success && result.sessionKey) {
            sessionKey = result.sessionKey;
            this.set({
              documentSessionKey: result.sessionKey,
              focusTarget: { type: 'session', id: result.sessionKey },
              eventDrawerOpen: true,
              eventFilter: 'messages',
              inputVisible: true,
              globalTool: 'none',
            });
            focusChatInputOrCenterPane();
            // Persist sessionKey into the markdown file's frontmatter
            if (markdownContext.content && this.markdownSetContent) {
              const { frontmatter: fm, body: bd } = parseFrontmatter(markdownContext.content);
              fm.sessionKey = result.sessionKey;
              this.markdownSetContent(serializeFrontmatter(fm, bd));
            }
          } else {
            this.set({ sendingMessage: false, error: result.error ?? 'Failed to create session' });
            return;
          }
        }
      }

      if (!sessionKey) {
        this.set({ sendingMessage: false, error: 'Select a session to send a message' });
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
        eventDrawerOpen: true,
        eventFilter: 'messages',
        streamingText: '',
      });

      await postCockpitSessionMessage(
        sessionKey,
        trimmedDraft,
        markdownContext ? { markdownContext } : undefined
      );
      this.set({
        sendingMessage: false,
      });
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

  registerMarkdownContextProvider = (provider: () => CockpitMarkdownContextInput | null): (() => void) => {
    this.markdownContextProvider = provider;
    return () => {
      if (this.markdownContextProvider === provider) {
        this.markdownContextProvider = null;
      }
    };
  };

  registerMarkdownSetContent = (setter: (content: string) => void): (() => void) => {
    this.markdownSetContent = setter;
    return () => {
      if (this.markdownSetContent === setter) {
        this.markdownSetContent = null;
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
