import { Component, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { CockpitStoreImpl, CockpitStoreContext, useCockpit } from '@/hooks/use-cockpit-store';
import { useMarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { usePolling, useEventStream, type CockpitEventStreamEvent } from '@/hooks/use-polling';
import { useKeyboard } from '@/hooks/use-keyboard';
import { useResizableLayout } from '@/hooks/use-resizable-layout';
import { getCockpitDiff } from '@/lib/api';
import { parseFrontmatter } from '@/lib/markdown';
import { Header } from '@/components/layout/Header';
import { StatusBar } from '@/components/layout/StatusBar';
import { FileExplorer } from '@/components/left/FileExplorer';
import { CenterPanel } from '@/components/center/CenterPanel';
import { RightPanel } from '@/components/right/RightPanel';
import { CommandPalette } from '@/components/shared/CommandPalette';
import { ShortcutSheet } from '@/components/shared/ShortcutSheet';
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
  return (
    <>
      {commandPaletteOpen && <CommandPalette />}
      {shortcutSheetOpen && <ShortcutSheet />}
    </>
  );
}

export default function App() {
  const store = useMemo(() => new CockpitStoreImpl(), []);
  const workspace = useMarkdownWorkspace();
  const { layout, setLeftWidth, setRightWidth } = useResizableLayout();
  const { getActiveContext, flushPendingAutosave, setContent } = workspace;
  const streamRefreshInFlightRef = useRef(false);
  const streamRefreshPendingRef = useRef<CockpitEventStreamEvent | null>(null);
  const lastSseRollupRefreshAtRef = useRef(0);
  const rollupRefreshInFlightRef = useRef(false);

  // Share active markdown context + autosave-before-send + content setter with chat dispatch.
  useEffect(() => {
    const unregisterContext = store.registerMarkdownContextProvider(() => getActiveContext());
    const unregisterSetContent = store.registerMarkdownSetContent(setContent);
    const unregisterBeforeSend = store.registerBeforeSendMessageHook(() => flushPendingAutosave());
    return () => {
      unregisterBeforeSend();
      unregisterSetContent();
      unregisterContext();
    };
  }, [store, getActiveContext, flushPendingAutosave, setContent]);

  // Load templates once on mount.
  useEffect(() => {
    void store.refreshTemplates();
  }, [store]);

  // Keep document-bound session key in sync with markdown frontmatter when available.
  useEffect(() => {
    const { frontmatter } = parseFrontmatter(workspace.state.content);
    const frontmatterSessionKeyRaw = typeof frontmatter.sessionKey === 'string'
      ? frontmatter.sessionKey
      : typeof frontmatter.session_key === 'string'
        ? frontmatter.session_key
        : typeof frontmatter.chatSessionKey === 'string'
          ? frontmatter.chatSessionKey
          : typeof frontmatter.chat_session_key === 'string'
            ? frontmatter.chat_session_key
            : null;
    const nextDocumentSessionKey = typeof frontmatterSessionKeyRaw === 'string' && frontmatterSessionKeyRaw.trim().length > 0
      ? frontmatterSessionKeyRaw.trim()
      : null;
    const current = store.getSnapshot().documentSessionKey;
    if (current !== nextDocumentSessionKey) {
      store.set({ documentSessionKey: nextDocumentSessionKey });
    }
  }, [store, workspace.state.content, workspace.state.selectedPath]);

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
    const incomingType = incoming?.type;
    const incomingData = (typeof incoming?.data === 'object' && incoming.data && !Array.isArray(incoming.data))
      ? incoming.data as Record<string, unknown>
      : null;
    const incomingSessionKey = typeof incoming?.sessionKey === 'string' ? incoming.sessionKey : null;

    // Fast path: stream chunks are injected directly into the store — no REST roundtrip.
    if (incomingType === 'stream' && incomingData) {
      const isReasoning = incomingData.is_reasoning === true;
      const isFinal = incomingData.is_final === true;
      const chunk = typeof incomingData.chunk === 'string' ? incomingData.chunk : '';
      if (!isReasoning && chunk && !isFinal && incomingSessionKey) {
        store.injectStreamChunk(incomingSessionKey, chunk);
        return;
      }
      // is_final or empty reasoning → fall through to REST refresh
    }

    // Response events: agent turn completed — clear streaming, then re-fetch canonical data.
    if (incomingType === 'response') {
      store.clearStreaming();
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
        const focusedSessionKey = state.focusData?.sessionKey
          ?? state.documentSessionKey
          ?? null;
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
        <Header />

        <main
          className="flex-1 min-h-0 flex overflow-hidden"
          style={{ '--left-width': `${layout.leftWidth}px`, '--right-width': `${layout.rightWidth}px` } as React.CSSProperties}
        >
          {/* Left — File Explorer */}
          <section
            data-cockpit-pane="left"
            tabIndex={-1}
            className="min-h-0 flex-shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden focus:outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent-cyan)]/60"
            style={{ width: `var(--left-width)` }}
          >
            <FileExplorer workspace={workspace} />
          </section>

          {/* Resize handle between left and center */}
          <ResizeHandle direction="horizontal" onResize={(delta) => setLeftWidth(layout.leftWidth + delta)} />

          {/* Center — Document editor OR Session detail */}
          <section
            data-cockpit-pane="center"
            tabIndex={-1}
            className="flex-1 min-w-0 bg-[var(--bg-surface)] overflow-hidden flex flex-col focus:outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent-cyan)]/60"
          >
            <CenterPanel workspace={workspace} />
          </section>

          {/* Resize handle between center and right */}
          <ResizeHandle direction="horizontal" onResize={(delta) => setRightWidth(layout.rightWidth - delta)} />

          {/* Right — Session list + commits + PRs */}
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
        <Overlays />
      </div>
    </CockpitStoreContext.Provider>
    </ErrorBoundary>
  );
}
