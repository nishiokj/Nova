import { Component, useEffect, type ReactNode } from 'react';
import { useCockpitStore, CockpitContext } from '@/hooks/use-cockpit-store';
import { useMarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { usePolling, useEventStream } from '@/hooks/use-polling';
import { useKeyboard } from '@/hooks/use-keyboard';
import { useResizableLayout } from '@/hooks/use-resizable-layout';
import { getCockpitDiff } from '@/lib/api';
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

export default function App() {
  const store = useCockpitStore();
  const workspace = useMarkdownWorkspace();
  const { layout, setLeftWidth, setRightWidth } = useResizableLayout();
  const { registerMarkdownContextProvider, registerMarkdownSetContent, registerBeforeSendMessageHook } = store;
  const { getActiveContext, flushPendingAutosave, setContent } = workspace;

  // Share active markdown context + autosave-before-send + content setter with chat dispatch.
  useEffect(() => {
    const unregisterContext = registerMarkdownContextProvider(() => getActiveContext());
    const unregisterSetContent = registerMarkdownSetContent(setContent);
    const unregisterBeforeSend = registerBeforeSendMessageHook(() => flushPendingAutosave());
    return () => {
      unregisterBeforeSend();
      unregisterSetContent();
      unregisterContext();
    };
  }, [registerMarkdownContextProvider, registerMarkdownSetContent, registerBeforeSendMessageHook, getActiveContext, flushPendingAutosave, setContent]);

  // Load templates once on mount.
  useEffect(() => {
    void store.refreshTemplates();
  }, [store.refreshTemplates]);

  // Poll as fallback; SSE event stream handles real-time updates.
  usePolling(async () => {
    await store.refreshAll();
    if (!workspace.state.dirty) void workspace.refreshTree();
  }, POLL_INTERVAL_MS);

  // SSE event stream — triggers immediate refresh on any bus event.
  useEventStream(async () => {
    await store.refreshAll();
    if (!workspace.state.dirty) void workspace.refreshTree();
  });

  // Refresh focus only when focusTarget changes (periodic refresh handled by refreshAll).
  useEffect(() => {
    void store.refreshFocus(store.state.focusTarget);
  }, [store.state.focusTarget]);

  // Handle pending commit range → diff
  useEffect(() => {
    const { pendingCommitRange, focusData } = store.state;
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
  }, [store.state.focusData?.sessionKey, store.state.pendingCommitRange]);

  // Keyboard shortcuts
  useKeyboard(store, workspace);

  return (
    <ErrorBoundary>
    <CockpitContext.Provider value={store}>
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
        {store.state.commandPaletteOpen && <CommandPalette />}
        {store.state.shortcutSheetOpen && <ShortcutSheet />}
      </div>
    </CockpitContext.Provider>
    </ErrorBoundary>
  );
}
