import { createContext, useCallback, useContext, useMemo, useReducer, useRef } from 'react';
import {
  applyCockpitPatch,
  getCockpitDiff,
  getCockpitFocus,
  getCockpitRollupSnapshot,
  getCockpitSessionEvents,
  getCockpitSessionPermissions,
  getCockpitSessionPackets,
  postCockpitSessionPermissions,
  type CockpitMarkdownContextInput,
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

export type FocusTab = 'packet' | 'diff' | 'tests' | 'trace' | 'permissions';
export type GlobalTool = 'none' | 'grep' | 'browser';
export type EventFilter = 'all' | 'messages' | 'failures' | 'audit';

const REPO_ROLLUP_REFRESH_INTERVAL_MS = 45_000;
const HEAVY_FOCUS_REFRESH_INTERVAL_MS = 20_000;

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

  // Keyboard nav highlight in right pane
  highlightedSessionIdx: number | null;
  commandPaletteOpen: boolean;
  commandPaletteQuery: string;
  shortcutSheetOpen: boolean;
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

  highlightedSessionIdx: null,
  commandPaletteOpen: false,
  commandPaletteQuery: '',
  shortcutSheetOpen: false,
};

// ─── Actions ─────────────────────────────────────────────────

type Action =
  | { type: 'SET'; payload: Partial<CockpitState> }
  | { type: 'SET_ROLLUPS'; payload: Pick<CockpitState, 'runningSessions' | 'readySessions' | 'doneSessions' | 'escalations' | 'commitRollups' | 'prRollups' | 'metrics'> }
  | { type: 'SET_FOCUS_DATA'; payload: { focusData: FocusData | null; events: NormalizedSessionEvent[]; traces: TraceRecord[]; testReports: CockpitTestReport[]; diffData: CockpitDiff | null; packets: FocusPacket[]; sessionPermissions: CockpitSessionPermissions | null } }
  | { type: 'CLEAR_FOCUS' }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'REFRESH_DONE' };

function reducer(state: CockpitState, action: Action): CockpitState {
  switch (action.type) {
    case 'SET': {
      const normalizedPayload: Partial<CockpitState> = { ...action.payload };
      if (
        Object.prototype.hasOwnProperty.call(normalizedPayload, 'focusTarget')
        && normalizedPayload.focusTarget
        && !Object.prototype.hasOwnProperty.call(normalizedPayload, 'globalTool')
      ) {
        normalizedPayload.globalTool = 'none';
      }
      const entries = Object.entries(normalizedPayload) as [string, unknown][];
      const changed = entries.some(([k, v]) => (state as unknown as Record<string, unknown>)[k] !== v);
      return changed ? { ...state, ...normalizedPayload } : state;
    }
    case 'SET_ROLLUPS': {
      const next = { ...state, ...action.payload, loading: false, lastUpdate: new Date() };
      // Validate that focusTarget still exists in the new data
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
      return next;
    }
    case 'SET_FOCUS_DATA': {
      const { focusData, events, traces, testReports, diffData, packets, sessionPermissions } = action.payload;
      const focusPacketId = focusData?.packet?.packetId ?? null;
      const selectedPacketId = focusPacketId && packets.some((packet) => packet.packetId === focusPacketId)
        ? focusPacketId
        : packets[0]?.packetId ?? focusPacketId;
      const selectedDiffFile = state.selectedDiffFile
        && diffData?.hotspots?.some((h) => h.path === state.selectedDiffFile)
        ? state.selectedDiffFile
        : diffData?.hotspots?.[0]?.path ?? null;
      const highlightedDiffIdx = selectedDiffFile && diffData
        ? Math.max(diffData.hotspots.findIndex((h) => h.path === selectedDiffFile), 0)
        : (diffData?.hotspots?.length ? 0 : null);
      // Auto-open the event drawer when there are messages to show
      const hasMessages = events.some((e) => e.type === 'message');
      return {
        ...state,
        focusData,
        events,
        sessionPackets: packets,
        selectedPacketId,
        traces,
        sessionPermissions,
        testReports,
        diffData: diffData
          ? (state.diffData?.patch && !diffData.patch ? { ...diffData, patch: state.diffData.patch } : diffData)
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
        browserSessionScope: focusData?.sessionKey ?? state.browserSessionScope,
        ...(hasMessages && !state.eventDrawerOpen ? { eventDrawerOpen: true } : {}),
      };
    }
    case 'CLEAR_FOCUS':
      return {
        ...state,
        focusData: null,
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
        selectedTestReport: null,
        selectedTestReportId: null,
        traces: [],
        sessionPermissions: null,
        patchDraft: '',
        patchApplyStatus: null,
        lensResults: { defs: [], refs: [], text: [] },
        permissionsSaving: false,
        permissionsSaveStatus: null,
      };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'REFRESH_DONE':
      return { ...state, loading: false, error: null, lastUpdate: new Date() };
    default:
      return state;
  }
}

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
    return events.filter((event) => {
      if (!isMessageLikeEvent(event)) return false;
      const content = extractMessageContent(event.payload);
      const role = messageRoleForEvent(event);
      const isFromMessagesTable = typeof event.payload.id === 'number' && !event.payload.eventType;
      // User messages: require content, only from messages table (agent_events duplicate them)
      if (role === 'user') return isFromMessagesTable && !!content;
      // Assistant messages from messages table: always include (even if empty — tool-only turns get a summary)
      if (isFromMessagesTable) return true;
      // Agent events: only if substantial text content
      return content.length > 80;
    });
  }
  if (eventFilter === 'failures') return events.filter(isFailureEvent);
  if (eventFilter === 'all') {
    return events.filter((event) => {
      if (event.type === 'tool' || event.type === 'workflow') return isFailureEvent(event);
      return true;
    });
  }
  return events;
}

// ─── Hook ────────────────────────────────────────────────────

export function useCockpitStore() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastRepoRollupRefreshAtRef = useRef(0);
  const lastHeavyFocusRefreshAtRef = useRef(0);
  const diffPatchRequestSeqRef = useRef(0);
  const diffPatchCacheRef = useRef(new Map<string, string | null>());
  const markdownContextProviderRef = useRef<(() => CockpitMarkdownContextInput | null) | null>(null);
  const markdownSetContentRef = useRef<((content: string) => void) | null>(null);
  const beforeSendMessageRef = useRef<(() => Promise<boolean> | boolean) | null>(null);

  const set = useCallback((payload: Partial<CockpitState>) => {
    dispatch({ type: 'SET', payload });
  }, []);

  const handleOpenUpgradePicker = useCallback((): boolean => {
    const markdownContext = markdownContextProviderRef.current?.();
    const markdownMetadata = (
      markdownContext?.metadata
      && typeof markdownContext.metadata === 'object'
      && !Array.isArray(markdownContext.metadata)
    )
      ? markdownContext.metadata as Record<string, unknown>
      : {};
    const workspaceScope = typeof markdownMetadata.workspaceScope === 'string'
      ? markdownMetadata.workspaceScope
      : null;
    const workspaceProjectPath = typeof markdownMetadata.workspaceProjectPath === 'string'
      ? markdownMetadata.workspaceProjectPath
      : null;
    const workspaceSessionKey = typeof markdownMetadata.workspaceSessionKey === 'string'
      ? markdownMetadata.workspaceSessionKey
      : null;
    if (workspaceScope !== 'project' && workspaceScope !== 'session' && !workspaceProjectPath && !workspaceSessionKey) {
      set({
        commandStatus: 'Promote/upgrade needs Project or Session workspace. Use the Files pane workspace selector to pick a project first.',
      });
      return false;
    }
    set({ upgradePickerOpen: true });
    return true;
  }, [set]);

  const refreshTemplates = useCallback(async () => {
    try {
      const templates = await getCockpitTemplates();
      set({ templates });
    } catch {
      // Templates are best-effort
    }
  }, [set]);

  const refreshRollups = useCallback(async () => {
    try {
      const now = Date.now();
      const includeRepo = (now - lastRepoRollupRefreshAtRef.current) >= REPO_ROLLUP_REFRESH_INTERVAL_MS;
      const snapshot = await getCockpitRollupSnapshot({
        sessionLimit: 120,
        escalationLimit: 120,
        repoLimit: 50,
        includeRepo,
      });
      if (includeRepo) {
        lastRepoRollupRefreshAtRef.current = now;
      }
      dispatch({
        type: 'SET_ROLLUPS',
        payload: {
          runningSessions: snapshot.runningSessions ?? [],
          readySessions: snapshot.readySessions ?? [],
          doneSessions: snapshot.doneSessions ?? [],
          escalations: snapshot.escalations ?? [],
          commitRollups: includeRepo ? (snapshot.commitRollups ?? []) : stateRef.current.commitRollups,
          prRollups: includeRepo ? (snapshot.prRollups ?? []) : stateRef.current.prRollups,
          metrics: snapshot.metrics ?? null,
        },
      });
      if (snapshot.error) {
        dispatch({ type: 'SET_ERROR', payload: snapshot.error });
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  const refreshFocus = useCallback(async (
    target: FocusTarget | null,
    options?: { includeHeavy?: boolean }
  ) => {
    if (!target) {
      dispatch({ type: 'CLEAR_FOCUS' });
      return;
    }
    const focusData = await getCockpitFocus(target.type, target.id);
    if (!focusData) {
      dispatch({ type: 'CLEAR_FOCUS' });
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
      // Keep the freshest heavy panels to avoid races with in-flight heavy refreshes.
      traceRows = stateRef.current.traces;
      reportRows = stateRef.current.testReports;
      diffResponse = stateRef.current.diffData;
    }
    const selectedPacket = focusData.packet ?? packetRows[0] ?? null;
    dispatch({
      type: 'SET_FOCUS_DATA',
      payload: {
        focusData: { ...focusData, packet: selectedPacket },
        events: eventResponse.events,
        packets: packetRows,
        traces: traceRows,
        testReports: reportRows,
        diffData: diffResponse,
        sessionPermissions,
      },
    });
    const focusPreviewUrl = typeof focusData?.header?.previewUrl === 'string'
      ? focusData.header.previewUrl
      : '';
    if (focusPreviewUrl && !stateRef.current.browserUrlDraft) {
      set({ browserUrlDraft: focusPreviewUrl });
    }
  }, [set]);

  const refreshAll = useCallback(async () => {
    const target = stateRef.current.focusTarget;
    const now = Date.now();
    const includeHeavyFocus = target
      ? (now - lastHeavyFocusRefreshAtRef.current) >= HEAVY_FOCUS_REFRESH_INTERVAL_MS
      : false;
    if (includeHeavyFocus) {
      lastHeavyFocusRefreshAtRef.current = now;
    }
    await Promise.all([
      refreshRollups(),
      target ? refreshFocus(target, { includeHeavy: includeHeavyFocus }) : undefined,
    ]);
  }, [refreshRollups, refreshFocus]);

  const setFocusTarget = useCallback((target: FocusTarget | null) => {
    set({ focusTarget: target });
  }, [set]);

  const handleSelectDiffFile = useCallback(async (path: string) => {
    const s = stateRef.current;
    if (!path || !s.diffData || !s.focusData?.sessionKey) return;

    const hotspotIdx = s.diffData.hotspots.findIndex((h) => h.path === path);
    if (hotspotIdx < 0) return;

    const cacheKey = `${s.focusData.sessionKey}:${s.diffData.baseSha}:${s.diffData.headSha}:${path}`;
    const cachedPatch = diffPatchCacheRef.current.get(cacheKey);
    if (cachedPatch !== undefined) {
      set({
        selectedDiffFile: path,
        highlightedDiffIdx: hotspotIdx,
        diffPatchFile: path,
        diffPatchLoadingFile: null,
        diffPatchError: null,
        diffData: { ...s.diffData, patch: cachedPatch },
      });
      return;
    }

    const reqSeq = diffPatchRequestSeqRef.current + 1;
    diffPatchRequestSeqRef.current = reqSeq;
    set({
      selectedDiffFile: path,
      highlightedDiffIdx: hotspotIdx,
      diffPatchLoadingFile: path,
      diffPatchError: null,
    });

    try {
      const response = await getCockpitDiff({
        sessionKey: s.focusData.sessionKey,
        base: s.diffData.baseSha,
        head: s.diffData.headSha,
        file: path,
      });
      if (diffPatchRequestSeqRef.current !== reqSeq) return;
      diffPatchCacheRef.current.set(cacheKey, response.patch);
      const latestDiff = stateRef.current.diffData;
      if (!latestDiff) return;
      set({
        diffData: { ...latestDiff, patch: response.patch },
        diffPatchFile: path,
        diffPatchLoadingFile: null,
        diffPatchError: null,
      });
    } catch (err) {
      if (diffPatchRequestSeqRef.current !== reqSeq) return;
      set({
        diffPatchFile: path,
        diffPatchLoadingFile: null,
        diffPatchError: err instanceof Error ? err.message : String(err),
      });
    }
  }, [set]);

  const handleApplyPatch = useCallback(async () => {
    const { focusData, patchDraft, diffData: dd } = stateRef.current;
    if (!focusData?.sessionKey || !patchDraft.trim()) return;
    set({ applyingPatch: true, patchApplyStatus: null });
    try {
      const response = await applyCockpitPatch({
        sessionKey: focusData.sessionKey,
        patch: patchDraft,
        ...(dd?.baseSha ? { baseSha: dd.baseSha } : {}),
      });
      if (response.success) {
        set({
          patchApplyStatus: `Applied ${response.mode ?? 'patch'}: ${response.files?.length ?? 0} files, ${response.changedLines ?? 0} lines`,
          patchDraft: '',
          applyingPatch: false,
        });
        await refreshAll();
      } else {
        set({ patchApplyStatus: 'Patch apply failed', applyingPatch: false });
      }
    } catch (err) {
      set({ patchApplyStatus: err instanceof Error ? err.message : String(err), applyingPatch: false });
    }
  }, [set, refreshAll]);

  const handleResolveEscalation = useCallback(async (escalationId: string) => {
    const freeformResponse = window.prompt('Resolution note (optional):');
    if (freeformResponse === null) return;
    set({ resolvingEscalationId: escalationId });
    try {
      await resolveCockpitEscalation(escalationId, {
        freeformResponse: freeformResponse.trim() || undefined,
      });
      set({ focusTarget: null, resolvingEscalationId: null });
      await refreshAll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), resolvingEscalationId: null });
    }
  }, [set, refreshAll]);

  const handleReviewDecision = useCallback(async (decision: 'accept' | 'request_changes') => {
    const sessionKey = stateRef.current.focusData?.sessionKey;
    if (!sessionKey) return;
    const note = window.prompt(
      decision === 'accept' ? 'Optional acceptance note:' : 'Optional request-changes note:'
    );
    if (note === null) return;
    set({ reviewDecisionAction: decision });
    try {
      await postCockpitSessionReviewDecision(sessionKey, {
        decision,
        note: note.trim() || undefined,
      });
      set({ reviewDecisionAction: null });
      await refreshAll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), reviewDecisionAction: null });
    }
  }, [set, refreshAll]);

  const handleRefreshSessionPermissions = useCallback(async () => {
    const sessionKey = stateRef.current.focusData?.sessionKey;
    if (!sessionKey) return;
    try {
      const response = await getCockpitSessionPermissions(sessionKey);
      set({ sessionPermissions: response, permissionsSaveStatus: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [set]);

  const handleUpdateSessionPermissions = useCallback(async (input: CockpitSessionPermissionUpdateInput) => {
    const sessionKey = stateRef.current.focusData?.sessionKey;
    if (!sessionKey) return;
    set({ permissionsSaving: true, permissionsSaveStatus: null });
    try {
      const response = await postCockpitSessionPermissions(sessionKey, input);
      set({
        sessionPermissions: response,
        permissionsSaving: false,
        permissionsSaveStatus: 'Permissions updated',
      });
    } catch (err) {
      set({
        permissionsSaving: false,
        permissionsSaveStatus: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [set]);

  const handleRunGrepSearch = useCallback(async (query?: string, sessionKey?: string | null) => {
    const q = (query ?? stateRef.current.lensQuery).trim();
    if (!q) return;
    const scopedSessionKey = sessionKey ?? stateRef.current.focusData?.sessionKey;
    set({ lensLoading: true, lensQuery: q, globalTool: 'grep' });
    try {
      const results = await searchCockpitRepoLens({
        ...(scopedSessionKey ? { sessionKey: scopedSessionKey } : {}),
        q,
        kind: 'all',
        limit: 120,
      });
      const total = results.defs.length + results.refs.length + results.text.length;
      set({
        lensResults: results,
        lensLoading: false,
        commandStatus: `Repo grep: ${total} match${total === 1 ? '' : 'es'}`,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        lensLoading: false,
      });
    }
  }, [set]);

  const handleSlashCommand = useCallback(async (raw: string): Promise<boolean> => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('/')) return false;

    const [commandRaw, ...rest] = trimmed.slice(1).split(/\s+/);
    const command = commandRaw.toLowerCase();
    const args = rest.join(' ').trim();

    if (command === 'grep') {
      if (!args || args.toLowerCase() === 'clear') {
        set({ sessionFilterQuery: '', commandStatus: 'Session grep cleared' });
        return true;
      }
      if (args.toLowerCase().startsWith('repo ')) {
        const repoQuery = args.slice('repo '.length).trim();
        if (!repoQuery) {
          set({ commandStatus: 'Usage: /grep repo <query>' });
          return true;
        }
        await handleRunGrepSearch(repoQuery, null);
        return true;
      }
      const allSessions = [
        ...stateRef.current.runningSessions,
        ...stateRef.current.readySessions,
        ...stateRef.current.doneSessions,
      ];
      const queryLower = args.toLowerCase();
      const matched = allSessions.filter((row) =>
        row.sessionKey.toLowerCase().includes(queryLower)
        || row.title.toLowerCase().includes(queryLower)
        || row.currentActivity.tool.toLowerCase().includes(queryLower)
        || (row.currentActivity.file ?? '').toLowerCase().includes(queryLower)
      );
      set({
        sessionFilterQuery: args,
        globalTool: 'none',
        commandStatus: `Session grep: ${matched.length} match${matched.length === 1 ? '' : 'es'}`,
      });
      return true;
    }

    if (command === 'browser' || command === 'preview') {
      const target = args || stateRef.current.focusData?.sessionKey || '';
      set({
        globalTool: 'browser',
        ...(target ? { browserSessionScope: target } : {}),
        commandStatus: target ? `Preview scoped to ${target}` : 'Preview opened',
      });
      return true;
    }

    if (command === 'doc' || command === 'document') {
      set({ globalTool: 'none', commandStatus: 'Document view' });
      return true;
    }

    if (command === 'upgrade' || command === 'promote') {
      handleOpenUpgradePicker();
      return true;
    }

    if (command === 'new') {
      const goal = args || 'New session';
      set({ commandStatus: 'Creating session…' });
      try {
        const result = await postCockpitSessionCreate({ goal });
        if (result.success && result.sessionKey) {
          set({
            focusTarget: { type: 'session', id: result.sessionKey },
            eventDrawerOpen: true,
            commandStatus: `Session ${result.sessionKey} created`,
          });
        } else {
          set({ commandStatus: result.error ?? 'Failed to create session' });
        }
      } catch (err) {
        set({ commandStatus: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (command === 'diff') {
      if (!stateRef.current.focusData?.sessionKey) {
        set({ commandStatus: 'Focus a session first to view diff' });
        return true;
      }
      set({ focusTab: 'diff', commandStatus: null });
      return true;
    }

    if (command === 'tests') {
      if (!stateRef.current.focusData?.sessionKey) {
        set({ commandStatus: 'Focus a session first to view tests' });
        return true;
      }
      set({ focusTab: 'tests', commandStatus: null });
      return true;
    }

    if (command === 'fork' || command === 'stop') {
      return false;
    }

    set({ commandStatus: `Unknown command: /${command}` });
    return true;
  }, [set, handleRunGrepSearch, handleOpenUpgradePicker]);

  const handleSendMessage = useCallback(async () => {
    const { focusData, messageDraft: draft, sendingMessage: alreadySending } = stateRef.current;
    if (alreadySending || !draft.trim()) return;
    const trimmedDraft = draft.trim();
    set({ sendingMessage: true });
    try {
      if (trimmedDraft.startsWith('/')) {
        const handledLocally = await handleSlashCommand(trimmedDraft);
        if (handledLocally) {
          set({ messageDraft: '', sendingMessage: false });
          return;
        }
      }

      let sessionKey = focusData?.sessionKey ?? stateRef.current.documentSessionKey ?? null;

      // Lazy session creation: no focused session, but we have markdown context
      if (!sessionKey && !stateRef.current.focusTarget && stateRef.current.globalTool === 'none') {
        const markdownContext = markdownContextProviderRef.current?.();
        if (markdownContext) {
          const firstLine = trimmedDraft.split('\n')[0].slice(0, 200);
          const markdownMetadata = (
            markdownContext.metadata
            && typeof markdownContext.metadata === 'object'
            && !Array.isArray(markdownContext.metadata)
          )
            ? markdownContext.metadata as Record<string, unknown>
            : {};
          const workspaceProjectPath = typeof markdownMetadata.workspaceProjectPath === 'string'
            && markdownMetadata.workspaceProjectPath.trim().length > 0
            ? markdownMetadata.workspaceProjectPath.trim()
            : undefined;
          const documentType = typeof markdownMetadata.documentType === 'string'
            ? markdownMetadata.documentType
            : undefined;
          if ((documentType === 'workflow' || documentType === 'executable') && !workspaceProjectPath) {
            set({
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
            },
          });
          if (result.success && result.sessionKey) {
            sessionKey = result.sessionKey;
            set({ documentSessionKey: result.sessionKey });
            // Persist sessionKey into the markdown file's frontmatter
            if (markdownContext.content && markdownSetContentRef.current) {
              const { frontmatter: fm, body: bd } = parseFrontmatter(markdownContext.content);
              fm.sessionKey = result.sessionKey;
              markdownSetContentRef.current(serializeFrontmatter(fm, bd));
            }
          } else {
            set({ sendingMessage: false, error: result.error ?? 'Failed to create session' });
            return;
          }
        }
      }

      if (!sessionKey) {
        set({ sendingMessage: false, error: 'Select a session to send a message' });
        return;
      }
      if (beforeSendMessageRef.current) {
        const proceed = await beforeSendMessageRef.current();
        if (proceed === false) {
          set({ sendingMessage: false });
          return;
        }
      }
      const markdownContext = markdownContextProviderRef.current?.() ?? null;
      await postCockpitSessionMessage(
        sessionKey,
        trimmedDraft,
        markdownContext ? { markdownContext } : undefined
      );
      // Optimistic: inject local user message so it renders instantly
      const optimistic: NormalizedSessionEvent = {
        at: new Date().toISOString(),
        type: 'message',
        payload: { role: 'user', content: trimmedDraft, id: Date.now() },
      };
      set({
        messageDraft: '',
        sendingMessage: false,
        commandStatus: null,
        events: [...stateRef.current.events, optimistic],
        eventDrawerOpen: true,
        eventFilter: 'messages',
      });
      // Background refresh replaces events with real data from backend
      void refreshAll();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), sendingMessage: false });
    }
  }, [set, refreshAll, handleSlashCommand]);

  const registerMarkdownContextProvider = useCallback((provider: () => CockpitMarkdownContextInput | null) => {
    markdownContextProviderRef.current = provider;
    return () => {
      if (markdownContextProviderRef.current === provider) {
        markdownContextProviderRef.current = null;
      }
    };
  }, []);

  const registerMarkdownSetContent = useCallback((setter: (content: string) => void) => {
    markdownSetContentRef.current = setter;
    return () => {
      if (markdownSetContentRef.current === setter) {
        markdownSetContentRef.current = null;
      }
    };
  }, []);

  const registerBeforeSendMessageHook = useCallback((hook: () => Promise<boolean> | boolean) => {
    beforeSendMessageRef.current = hook;
    return () => {
      if (beforeSendMessageRef.current === hook) {
        beforeSendMessageRef.current = null;
      }
    };
  }, []);

  const handleSelectTestReport = useCallback(async (reportId: string) => {
    const existing = stateRef.current.testReports.find((r) => r.id === reportId);
    if (existing) {
      set({ selectedTestReportId: reportId, selectedTestReport: existing });
      return;
    }
    set({ selectedTestReportId: reportId });
    const report = await getCockpitTestReport(reportId);
    if (report) set({ selectedTestReport: report });
  }, [set]);

  const handleSelectCommit = useCallback((row: CommitRollup) => {
    if (!row.sessionKey) return;
    set({
      focusTarget: { type: 'session', id: row.sessionKey },
      pendingCommitRange: {
        sessionKey: row.sessionKey,
        ...(row.baseSha ? { base: row.baseSha } : {}),
        ...(row.headSha ? { head: row.headSha } : {}),
      },
    });
  }, [set]);

  const handleSelectPR = useCallback((row: PRRollup) => {
    if (row.sessionKey) {
      set({ focusTarget: { type: 'session', id: row.sessionKey } });
    }
    window.open(row.url, '_blank', 'noopener,noreferrer');
  }, [set]);

  // Resolve packet references
  const resolvePacketRef = useCallback((refTypeRaw: string, targetRaw: string): boolean => {
    const s = stateRef.current;
    const refType = refTypeRaw.trim().toLowerCase();
    const target = targetRaw.trim();
    if (!refType || !target) return false;

    const shaShort = (a: string | undefined, b: string) => {
      if (!a) return false;
      const l = a.toLowerCase(), r = b.toLowerCase();
      return l === r || l.startsWith(r) || r.startsWith(l);
    };

    if (refType === 'commit') {
      if (shaShort(s.diffData?.headSha, target) || shaShort(s.diffData?.baseSha, target)) return true;
      return s.commitRollups.some((r) => shaShort(r.sha, target))
        || s.traces.some((t) => shaShort(t.vcs?.revision, target));
    }
    if (refType === 'file') {
      const path = target.split('#')[0];
      const hotspotPaths = new Set((s.diffData?.hotspots ?? []).map((h) => h.path));
      const tracePaths = new Set(s.traces.flatMap((t) => (t.files ?? []).map((f) => f.path)).filter(Boolean));
      return hotspotPaths.has(path) || tracePaths.has(path);
    }
    if (refType === 'testreport') return s.testReports.some((r) => r.id === target);
    if (refType === 'trace') return s.traces.some((t) => t.id === target || shaShort(t.vcs?.revision, target));
    if (refType === 'workitem') {
      if (typeof s.focusData?.header?.activeWorkItemId === 'string' && s.focusData.header.activeWorkItemId === target) return true;
      return s.events.some((e) => String(e.payload.workItemId ?? '') === target);
    }
    if (refType === 'session') {
      const allKeys = new Set([...s.runningSessions, ...s.readySessions, ...s.doneSessions].map((r) => r.sessionKey));
      return s.focusData?.sessionKey === target || allKeys.has(target);
    }
    if (refType === 'pr') {
      const num = Number(target.replace(/^#/, '').trim());
      return s.prRollups.some((r) => r.prId === target || r.url.includes(target) || (Number.isFinite(num) && r.number === num));
    }
    return false;
  }, []);

  const handlePacketRefClick = useCallback(async (refType: string, target: string) => {
    const s = stateRef.current;
    const type = refType.toLowerCase();

    if (type === 'commit') {
      set({ focusTab: 'diff' });
      if (s.focusData?.sessionKey) {
        const response = await getCockpitDiff({ sessionKey: s.focusData.sessionKey, head: target }).catch(() => null);
        if (response) {
          set({
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
      set({ focusTab: 'diff' });
      await handleSelectDiffFile(path);
      return;
    }
    if (type === 'testreport') {
      set({ focusTab: 'tests' });
      await handleSelectTestReport(target);
      return;
    }
    if (type === 'trace') {
      set({ focusTab: 'trace' });
    }
  }, [set, handleSelectTestReport, handleSelectDiffFile]);

  const handlePacketLinkClick = useCallback(async (target: string) => {
    if (!target) return;
    let parsed: URL;
    try {
      parsed = new URL(target, window.location.origin);
    } catch {
      return;
    }
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.includes('/diff')) {
      set({ focusTab: 'diff' });
      const s = stateRef.current;
      if (s.focusData?.sessionKey) {
        const response = await getCockpitDiff({
          sessionKey: s.focusData.sessionKey,
          ...(parsed.searchParams.get('base') ? { base: String(parsed.searchParams.get('base')) } : {}),
          ...(parsed.searchParams.get('head') ? { head: String(parsed.searchParams.get('head')) } : {}),
        }).catch(() => null);
        if (response) {
          set({
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
      set({ focusTab: 'tests' });
      const reportId = parsed.searchParams.get('id');
      if (reportId) await handleSelectTestReport(reportId);
      return;
    }
    if (pathname.includes('/trace')) {
      set({ focusTab: 'trace' });
      return;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    }
  }, [set, handleSelectTestReport]);

  return useMemo(() => ({
    state,
    dispatch,
    set,
    refreshRollups,
    refreshTemplates,
    refreshFocus,
    refreshAll,
    setFocusTarget,
    handleSelectDiffFile,
    handleApplyPatch,
    handleResolveEscalation,
    handleReviewDecision,
    handleRefreshSessionPermissions,
    handleUpdateSessionPermissions,
    handleSendMessage,
    handleOpenUpgradePicker,
    handleRunGrepSearch,
    handleSelectTestReport,
    handleSelectCommit,
    handleSelectPR,
    resolvePacketRef,
    handlePacketRefClick,
    handlePacketLinkClick,
    registerMarkdownContextProvider,
    registerMarkdownSetContent,
    registerBeforeSendMessageHook,
  }), [
    state,
    dispatch,
    set,
    refreshRollups,
    refreshTemplates,
    refreshFocus,
    refreshAll,
    setFocusTarget,
    handleSelectDiffFile,
    handleApplyPatch,
    handleResolveEscalation,
    handleReviewDecision,
    handleRefreshSessionPermissions,
    handleUpdateSessionPermissions,
    handleSendMessage,
    handleOpenUpgradePicker,
    handleRunGrepSearch,
    handleSelectTestReport,
    handleSelectCommit,
    handleSelectPR,
    resolvePacketRef,
    handlePacketRefClick,
    handlePacketLinkClick,
    registerMarkdownContextProvider,
    registerMarkdownSetContent,
    registerBeforeSendMessageHook,
  ]);
}

export type CockpitStore = ReturnType<typeof useCockpitStore>;

export const CockpitContext = createContext<CockpitStore | null>(null);

export function useCockpit(): CockpitStore {
  const ctx = useContext(CockpitContext);
  if (!ctx) throw new Error('useCockpit must be used within CockpitContext.Provider');
  return ctx;
}
