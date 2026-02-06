import { Component, useEffect, type ReactNode } from 'react';
import { useCockpitStore, CockpitContext } from '@/hooks/use-cockpit-store';
import { useMarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { usePolling } from '@/hooks/use-polling';
import { useKeyboard } from '@/hooks/use-keyboard';
import { getCockpitDiff } from '@/lib/api';
import { Header } from '@/components/layout/Header';
import { StatusBar } from '@/components/layout/StatusBar';
import { FileExplorer } from '@/components/left/FileExplorer';
import { CenterPanel } from '@/components/center/CenterPanel';
import { RightPanel } from '@/components/right/RightPanel';
import { CommandPalette } from '@/components/shared/CommandPalette';
import { ShortcutSheet } from '@/components/shared/ShortcutSheet';

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

const POLL_INTERVAL_MS = 5000;

export default function App() {
  const store = useCockpitStore();
  const workspace = useMarkdownWorkspace();
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

  // Poll for rollup updates + side-effects (tree refresh).
  usePolling(async () => {
    await store.refreshAll();
    if (!workspace.state.dirty) void workspace.refreshTree();
  }, POLL_INTERVAL_MS);

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

        <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)_20rem] gap-0 overflow-hidden">
          {/* Left — File Explorer */}
          <section
            data-cockpit-pane="left"
            tabIndex={-1}
            className="min-h-0 border-r border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden focus:outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent-cyan)]/60"
          >
            <FileExplorer workspace={workspace} />
          </section>

          {/* Center — Document editor OR Session detail */}
          <section
            data-cockpit-pane="center"
            tabIndex={-1}
            className="min-h-0 bg-[var(--bg-surface)] overflow-hidden flex flex-col focus:outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent-cyan)]/60"
          >
            <CenterPanel workspace={workspace} />
          </section>

          {/* Right — Session list + commits + PRs */}
          <section
            data-cockpit-pane="right"
            tabIndex={-1}
            className="min-h-0 border-l border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden focus:outline-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent-cyan)]/60"
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
