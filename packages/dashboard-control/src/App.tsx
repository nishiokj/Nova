import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CockpitStoreImpl, CockpitStoreContext, useCockpit } from '@/hooks/use-cockpit-store';
import { useMarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { usePolling, useEventStream, type CockpitEventStreamEvent } from '@/hooks/use-polling';
import { useKeyboard } from '@/hooks/use-keyboard';
import { useResizableLayout, useIsMobile } from '@/hooks/use-resizable-layout';
import { getCockpitDiff } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { StatusBar } from '@/components/layout/StatusBar';
import { FileExplorer } from '@/components/left/FileExplorer';
import { CenterPanel } from '@/components/center/CenterPanel';
import { RightPanel } from '@/components/right/RightPanel';
import { CommandPalette } from '@/components/shared/CommandPalette';
import { ShortcutSheet } from '@/components/shared/ShortcutSheet';
import { PermissionDialog } from '@/components/shared/PermissionDialog';
import { ResizeHandle } from '@/components/shared/ResizeHandle';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="h-screen flex items-center justify-center bg-[var(--bg-base)] text-[var(--text-primary)]">
          <div className="max-w-lg p-6 rounded border border-[var(--error)]/40 bg-[var(--error)]/5">
            <div className="text-sm font-medium text-[var(--error)] mb-2">Cockpit crashed</div>
            <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words mb-3">{this.state.error.message}</pre>
            <button onClick={() => this.setState({ error: null })} className="px-3 py-1 text-xs rounded bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/30">Retry</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const POLL_INTERVAL_MS = 30_000; // Fallback only — SSE handles real-time updates
const SSE_ROLLUP_REFRESH_INTERVAL_MS = 4_000;

/** Thin wrapper that reads two booleans from the store to conditionally render overlays. */
function Overlays() {
  const commandPaletteOpen = useCockpit(s => s.commandPaletteOpen);
  const shortcutSheetOpen = useCockpit(s => s.shortcutSheetOpen);
  const permissionDialogOpen = useCockpit(s => s.permissionDialogOpen);
  return (
    <>
      {commandPaletteOpen && <CommandPalette />}
      {shortcutSheetOpen && <ShortcutSheet />}
      {permissionDialogOpen && <PermissionDialog />}
    </>
  );
}

type MobilePane = 'left' | 'center' | 'right';

const MOBILE_TABS: { pane: MobilePane; label: string }[] = [
  { pane: 'left', label: 'Files' },
  { pane: 'center', label: 'Session' },
  { pane: 'right', label: 'Sessions' },
];

function MobileBottomNav({ active, onSelect }: { active: MobilePane; onSelect: (p: MobilePane) => void }) {
  const escalationCount = useCockpit(s => s.escalations.length);
  return (
    <nav className="mobile-bottom-nav">
      {MOBILE_TABS.map(({ pane, label }) => (
        <button
          key={pane}
          onClick={() => onSelect(pane)}
          className={`mobile-bottom-nav-btn ${active === pane ? 'active' : ''}`}
        >
          {label}
          {pane === 'right' && escalationCount > 0 && (
            <span className="mobile-badge">{escalationCount}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

export default function App() {
  const store = useMemo(() => new CockpitStoreImpl(), []);
  const workspace = useMarkdownWorkspace();
  const { layout, setLeftWidth, setRightWidth } = useResizableLayout();
  const isMobile = useIsMobile();
  const [mobilePane, setMobilePane] = useState<MobilePane>('center');
  const { getActiveContext, flushPendingAutosave } = workspace;
  const streamRefreshInFlightRef = useRef(false);
  const streamRefreshPendingRef = useRef<CockpitEventStreamEvent | null>(null);
  const lastSseRollupRefreshAtRef = useRef(0);
  const rollupRefreshInFlightRef = useRef(false);

  // Share active markdown context + autosave-before-send with chat dispatch.
  useEffect(() => {
    const unregisterContext = store.registerMarkdownContextProvider(() => getActiveContext());
    const unregisterBeforeSend = store.registerBeforeSendMessageHook(() => flushPendingAutosave());
    return () => {
      unregisterBeforeSend();
      unregisterContext();
    };
  }, [store, getActiveContext, flushPendingAutosave]);

  // Load templates once on mount.
  useEffect(() => {
    void store.refreshTemplates();
  }, [store]);

  // Sync workspace project path into cockpit store for workflow commands.
  useEffect(() => {
    const root = workspace.state.activeRoot;
    const projectPath = root !== '.cockpit/scratch' ? root : null;
    if (store.getSnapshot().workspaceProjectPath !== projectPath) {
      store.set({ workspaceProjectPath: projectPath });
    }
  }, [store, workspace.state.activeRoot]);

  // Poll as fallback; SSE event stream handles real-time updates.
  usePolling(async () => {
    await store.refreshAll();
    if (!workspace.state.dirty) void workspace.refreshTree();
  }, POLL_INTERVAL_MS);

  const triggerRollupRefresh = useCallback((refreshWorkspaceTree: boolean) => {
    if (rollupRefreshInFlightRef.current) return;
    rollupRefreshInFlightRef.current = true;
    void store.refreshRollups()
      .then(() => {
        if (refreshWorkspaceTree && !workspace.state.dirty) {
          void workspace.refreshTree();
        }
      })
      .finally(() => {
        rollupRefreshInFlightRef.current = false;
      });
  }, [store, workspace]);

  const handleSseRefresh = useCallback(async (incoming: CockpitEventStreamEvent | null) => {
    const incomingRecord = (typeof incoming === 'object' && incoming && !Array.isArray(incoming))
      ? incoming as Record<string, unknown>
      : null;
    const incomingType = typeof incomingRecord?.type === 'string' ? incomingRecord.type : undefined;
    const payloadData = (typeof incomingRecord?.data === 'object' && incomingRecord.data && !Array.isArray(incomingRecord.data))
      ? incomingRecord.data as Record<string, unknown>
      : null;
    const incomingData = payloadData ?? incomingRecord;
    const incomingSessionKey = typeof incomingRecord?.sessionKey === 'string'
      ? incomingRecord.sessionKey
      : typeof incomingRecord?.session_key === 'string'
        ? incomingRecord.session_key
        : typeof incomingData?.session_key === 'string'
          ? incomingData.session_key
          : typeof incomingData?.sessionKey === 'string'
            ? incomingData.sessionKey
            : null;

    // Fast path: stream chunks are injected directly into the store — no REST roundtrip.
    if ((incomingType === 'stream' || incomingType === 'agent_message' || incomingType === 'agent_reasoning') && incomingData) {
      const isReasoning = incomingData.is_reasoning === true;
      const isFinal = incomingData.is_final === true;
      const chunk = typeof incomingData.chunk === 'string' ? incomingData.chunk : '';
      const fallbackChunk = typeof incomingData.message === 'string'
        ? incomingData.message
        : typeof incomingData.content === 'string'
          ? incomingData.content
          : '';
      const effectiveChunk = chunk || fallbackChunk;
      const streamRequestId = typeof incomingData.request_id === 'string'
        ? incomingData.request_id
        : typeof incomingData.requestId === 'string'
          ? incomingData.requestId
          : undefined;
      if (!isReasoning && effectiveChunk && !isFinal && incomingSessionKey) {
        store.injectStreamChunk(incomingSessionKey, effectiveChunk, streamRequestId);
        return;
      }
      // is_final or empty reasoning → fall through to REST refresh
    }

    // Response events: agent turn completed — clear streaming, then re-fetch canonical data.
    if (incomingType === 'response' || incomingType === 'harness_response') {
      const responseContent = typeof incomingData?.content === 'string'
        ? incomingData.content
        : typeof incomingData?.response === 'string'
          ? incomingData.response
          : '';
      const responseRequestId = typeof incomingData?.request_id === 'string'
        ? incomingData.request_id
        : typeof incomingData?.requestId === 'string'
          ? incomingData.requestId
          : undefined;
      const responseSessionKey = incomingSessionKey
        ?? store.getSnapshot().focusData?.sessionKey
        ?? null;
      if (responseSessionKey) {
        // Inject response payload when present; otherwise the store will finalize
        // from request-scoped streaming events if available.
        store.injectOptimisticAssistantMessage(responseSessionKey, responseContent, responseRequestId);
      }
      store.clearStreaming(responseSessionKey ?? undefined, responseRequestId);
    }

    if (incomingType === 'permission_request' && incomingData) {
      const requestId = typeof incomingData.request_id === 'string' ? incomingData.request_id.trim() : '';
      const tool = incomingData.tool;
      const target = typeof incomingData.target === 'string' ? incomingData.target : '';
      const suggestedPattern = typeof incomingData.suggested_pattern === 'string' ? incomingData.suggested_pattern : '';
      const workingDirectory = typeof incomingData.working_directory === 'string' ? incomingData.working_directory : '';
      const description = typeof incomingData.description === 'string' ? incomingData.description : '';
      const sessionKey = incomingSessionKey
        ?? (typeof incomingData.session_key === 'string' ? incomingData.session_key : '');

      if (
        requestId
        && sessionKey
        && (tool === 'Bash' || tool === 'Write' || tool === 'Edit')
      ) {
        store.enqueuePermissionRequest({
          requestId,
          sessionKey,
          tool,
          target,
          suggestedPattern,
          workingDirectory,
          description,
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }

    // Files modified by agent — re-read the open file if it was touched.
    if (incomingType === 'files_modified' && incomingData) {
      const paths = Array.isArray(incomingData.paths) ? incomingData.paths as string[] : [];
      const openPath = workspace.state.selectedPath;
      if (openPath && !workspace.state.dirty && paths.some((p) => typeof p === 'string' && p.endsWith(openPath))) {
        void workspace.openFile(openPath);
      }
      // Fall through to normal refresh so events/rollups update too.
    }

    // Back-pressure: only one REST refresh in flight at a time.
    if (streamRefreshInFlightRef.current) {
      streamRefreshPendingRef.current = incoming;
      return;
    }

    streamRefreshInFlightRef.current = true;
    let currentEvent: CockpitEventStreamEvent | null = incoming;
    try {
      while (true) {
        const state = store.getSnapshot();
        const focusedSessionKey = state.focusData?.sessionKey ?? null;
        const eventSessionKey = typeof currentEvent?.sessionKey === 'string' ? currentEvent.sessionKey : null;
        const isForDifferentSession = !!eventSessionKey && !!focusedSessionKey && eventSessionKey !== focusedSessionKey;
        const now = Date.now();

        if (focusedSessionKey && !isForDifferentSession) {
          await store.refreshFocusEvents(focusedSessionKey, 200);
          if ((now - lastSseRollupRefreshAtRef.current) >= SSE_ROLLUP_REFRESH_INTERVAL_MS) {
            lastSseRollupRefreshAtRef.current = now;
            triggerRollupRefresh(false);
          }
        } else if ((now - lastSseRollupRefreshAtRef.current) >= SSE_ROLLUP_REFRESH_INTERVAL_MS) {
          lastSseRollupRefreshAtRef.current = now;
          triggerRollupRefresh(true);
        }

        const pending = streamRefreshPendingRef.current;
        streamRefreshPendingRef.current = null;
        if (!pending) break;
        currentEvent = pending;
      }
    } finally {
      streamRefreshInFlightRef.current = false;
    }
  }, [store, triggerRollupRefresh]);

  // SSE event stream — lightweight focused updates for low-latency chat rendering.
  useEventStream(handleSseRefresh);

  // Refresh focus only when focusTarget changes (periodic refresh handled by refreshAll).
  useEffect(() => {
    // We need to track focusTarget reactively — subscribe to the store for this one field.
    let currentFocusTarget = store.getSnapshot().focusTarget;
    void store.refreshFocus(currentFocusTarget);
    const unsub = store.subscribe(() => {
      const next = store.getSnapshot().focusTarget;
      if (next === currentFocusTarget) return;
      currentFocusTarget = next;
      void store.refreshFocus(next);
    });
    return unsub;
  }, [store]);

  // Handle pending commit range → diff
  useEffect(() => {
    let currentSessionKey = store.getSnapshot().focusData?.sessionKey;
    let currentCommitRange = store.getSnapshot().pendingCommitRange;

    const handleCommitRange = () => {
      const state = store.getSnapshot();
      const { pendingCommitRange, focusData } = state;
      if (!pendingCommitRange || !focusData?.sessionKey) return;
      if (pendingCommitRange.sessionKey !== focusData.sessionKey) return;
      void getCockpitDiff({
        sessionKey: focusData.sessionKey,
        ...(pendingCommitRange.base ? { base: pendingCommitRange.base } : {}),
        ...(pendingCommitRange.head ? { head: pendingCommitRange.head } : {}),
      }).then((response) => {
        store.set({
          diffData: response,
          selectedDiffFile: response.hotspots[0]?.path ?? null,
          highlightedDiffIdx: response.hotspots.length > 0 ? 0 : null,
          diffPatchFile: null,
          diffPatchLoadingFile: null,
          diffPatchError: null,
          focusTab: 'diff',
          pendingCommitRange: null,
        });
      }).catch(() => {
        store.set({ pendingCommitRange: null });
      });
    };

    handleCommitRange();
    const unsub = store.subscribe(() => {
      const state = store.getSnapshot();
      const nextSessionKey = state.focusData?.sessionKey;
      const nextCommitRange = state.pendingCommitRange;
      if (nextSessionKey === currentSessionKey && nextCommitRange === currentCommitRange) return;
      currentSessionKey = nextSessionKey;
      currentCommitRange = nextCommitRange;
      handleCommitRange();
    });
    return unsub;
  }, [store]);

  // Keyboard shortcuts
  useKeyboard(store, workspace);

  return (
    <ErrorBoundary>
    <CockpitStoreContext.Provider value={store}>
      <div className="h-screen flex flex-col overflow-hidden" data-cockpit-root="true">
        <Header isMobile={isMobile} />

        {isMobile ? (
          /* ── Mobile: single-pane layout ── */
          <>
            <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <section className="flex-1 min-h-0 bg-[var(--bg-surface)] overflow-hidden flex flex-col">
                {mobilePane === 'left' && <FileExplorer workspace={workspace} />}
                {mobilePane === 'center' && <CenterPanel workspace={workspace} />}
                {mobilePane === 'right' && <RightPanel />}
              </section>
            </main>
            <MobileBottomNav active={mobilePane} onSelect={setMobilePane} />
          </>
        ) : (
          /* ── Desktop: 3-column resizable layout ── */
          <>
            <main
              className="flex-1 min-h-0 flex overflow-hidden"
              style={{ '--left-width': `${layout.leftWidth}px`, '--right-width': `${layout.rightWidth}px` } as React.CSSProperties}
            >
              <section
                data-cockpit-pane="left"
                tabIndex={-1}
                className="min-h-0 flex-shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden focus:outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent-cyan)]/60"
                style={{ width: `var(--left-width)` }}
              >
                <FileExplorer workspace={workspace} />
              </section>

              <ResizeHandle direction="horizontal" onResize={(delta) => setLeftWidth(layout.leftWidth + delta)} />

              <section
                data-cockpit-pane="center"
                tabIndex={-1}
                className="flex-1 min-w-0 bg-[var(--bg-surface)] overflow-hidden flex flex-col focus:outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent-cyan)]/60"
              >
                <CenterPanel workspace={workspace} />
              </section>

              <ResizeHandle direction="horizontal" onResize={(delta) => setRightWidth(layout.rightWidth - delta)} />

              <section
                data-cockpit-pane="right"
                tabIndex={-1}
                className="min-h-0 flex-shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden focus:outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent-cyan)]/60"
                style={{ width: `var(--right-width)` }}
              >
                <RightPanel />
              </section>
            </main>

            <StatusBar />
          </>
        )}

        <Overlays />
      </div>
    </CockpitStoreContext.Provider>
    </ErrorBoundary>
  );
}
