import { useEffect, useRef } from 'react';
import type { CockpitStore, FocusTab } from './use-cockpit-store';
import { selectFocusEscalationId, selectFocusStatus } from './use-cockpit-store';
import type { MarkdownWorkspace } from './use-markdown-workspace';

const FOCUS_TABS: FocusTab[] = ['packet', 'diff', 'tests', 'trace', 'permissions'];
type PaneId = 'left' | 'center' | 'right';

function paneFromNode(node: EventTarget | Element | null): PaneId | null {
  if (!(node instanceof Element)) return null;
  const pane = node.closest('[data-cockpit-pane]')?.getAttribute('data-cockpit-pane');
  if (pane === 'left' || pane === 'center' || pane === 'right') return pane;
  return null;
}

function inCockpit(node: EventTarget | Element | null): boolean {
  if (!(node instanceof Element)) return false;
  return !!node.closest('[data-cockpit-root="true"]');
}

export function useKeyboard(store: CockpitStore, workspace: MarkdownWorkspace) {
  const {
    state,
    set,
    handleSendMessage,
    handleResolveEscalation,
    handleReviewDecision,
    handleOpenUpgradePicker,
    handleSelectDiffFile,
  } = store;
  const { save, createFolder, editorRef, openNewFilePicker, closeNewFilePicker } = workspace;
  const lastPaneRef = useRef<PaneId>('center');

  useEffect(() => {
    const focusPane = (pane: PaneId) => {
      lastPaneRef.current = pane;
      const paneEl = document.querySelector<HTMLElement>(`[data-cockpit-pane="${pane}"]`);
      paneEl?.focus({ preventScroll: true });
      if (
        pane === 'center'
        && !state.focusTarget
        && !workspace.state.newFileDropdownOpen
        && !state.upgradePickerOpen
      ) {
        editorRef.current?.focus();
      }
    };

    const onPanePointer = (event: MouseEvent | FocusEvent) => {
      const pane = paneFromNode(event.target);
      if (pane) focusPane(pane);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const activeElement = document.activeElement as HTMLElement | null;
      const insideCockpit = inCockpit(target) || inCockpit(activeElement);
      if (!insideCockpit) return;

      const activePane = paneFromNode(target) ?? paneFromNode(activeElement) ?? lastPaneRef.current;
      const isTypingTarget = !!target && (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target.isContentEditable
      );

      // While the filename picker is open, keep keyboard handling scoped there.
      if (workspace.state.newFileDropdownOpen && event.key !== 'Escape') return;

      // Alt+h/j/k/l — pane focus navigation (vim-like, circular).
      if (event.altKey && !event.metaKey && !event.ctrlKey) {
        const code = event.code;
        const key = event.key.toLowerCase();
        if (code === 'KeyH' || key === 'h') {
          event.preventDefault();
          event.stopPropagation();
          // Circular navigation: go left, wrap to right
          const panes: PaneId[] = ['left', 'center', 'right'];
          const currentIdx = panes.indexOf(activePane);
          const prevIdx = (currentIdx - 1 + panes.length) % panes.length;
          focusPane(panes[prevIdx]);
          return;
        }
        if (code === 'KeyJ' || code === 'KeyK' || key === 'j' || key === 'k') {
          event.preventDefault();
          event.stopPropagation();
          // j/k always go to center pane
          focusPane('center');
          return;
        }
        if (code === 'KeyL' || key === 'l') {
          event.preventDefault();
          event.stopPropagation();
          // Circular navigation: go right, wrap to left
          const panes: PaneId[] = ['left', 'center', 'right'];
          const currentIdx = panes.indexOf(activePane);
          const nextIdx = (currentIdx + 1) % panes.length;
          focusPane(panes[nextIdx]);
          return;
        }
      }

      // Ctrl+` — toggle chat (input + events drawer in messages mode)
      if (event.ctrlKey && event.key === '`') {
        event.preventDefault();
        if (!state.inputVisible) {
          set({ inputVisible: true, eventDrawerOpen: true, eventFilter: 'messages' });
        } else {
          set({ inputVisible: false, eventDrawerOpen: false });
        }
        return;
      }

      // Ctrl+U — promote picker (skip in textarea/input — they handle Ctrl+U as clear)
      if (event.ctrlKey && !event.shiftKey && (event.key === 'u' || event.key === 'U')) {
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
        event.preventDefault();
        handleOpenUpgradePicker();
        return;
      }

      // Ctrl+S — save markdown
      if (event.ctrlKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        void save();
        return;
      }

      // Ctrl+N — new file (folder picker)
      if (event.ctrlKey && !event.shiftKey && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault();
        set({ focusTarget: null });
        if (workspace.state.newFileDropdownOpen) {
          closeNewFilePicker();
        } else {
          openNewFilePicker('create');
        }
        return;
      }

      // Ctrl+Shift+N — new folder
      if (event.ctrlKey && event.shiftKey && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault();
        void createFolder();
        return;
      }


      // Escape — close overlay / dropdown / input
      if (event.key === 'Escape') {
        if (state.commandPaletteOpen) {
          set({ commandPaletteOpen: false, commandPaletteQuery: '' });
          return;
        }
        if (state.shortcutSheetOpen) {
          set({ shortcutSheetOpen: false });
          return;
        }
        if (state.upgradePickerOpen) {
          set({ upgradePickerOpen: false });
          return;
        }
        if (workspace.state.newFileDropdownOpen) {
          closeNewFilePicker();
          return;
        }
        if (state.highlightedSessionIdx !== null) {
          set({ highlightedSessionIdx: null });
          return;
        }
        if (state.inputVisible) set({ inputVisible: false });
        return;
      }

      // Tab/Shift+Tab — cycle center session tabs, or let CodeMirror handle it in editor.
      if (event.key === 'Tab' && !event.metaKey && !event.altKey && !event.ctrlKey) {
        // When the editor is focused, let CodeMirror handle Tab/Shift+Tab natively.
        if (!state.focusTarget && activePane === 'center') return;

        if (state.focusTarget && state.globalTool === 'none' && activePane === 'center') {
          event.preventDefault();
          const idx = FOCUS_TABS.indexOf(state.focusTab);
          const next = event.shiftKey
            ? (idx - 1 + FOCUS_TABS.length) % FOCUS_TABS.length
            : (idx + 1) % FOCUS_TABS.length;
          set({ focusTab: FOCUS_TABS[next] });
          return;
        }

        // Do not let browser Tab traversal escape cockpit panes.
        event.preventDefault();
        return;
      }

      if (isTypingTarget || event.metaKey || event.altKey) return;

      const allSessions = [...state.runningSessions, ...state.readySessions, ...state.doneSessions.slice(0, 10)];
      const diffHotspots = state.diffData?.hotspots.slice(0, 20) ?? [];

      // Arrow keys + Enter for diff hotspot navigation/select.
      if (
        state.focusTarget
        && state.focusTab === 'diff'
        && diffHotspots.length > 0
        && !event.ctrlKey
        && !event.shiftKey
      ) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          const currentIdx = state.highlightedDiffIdx ?? Math.max(diffHotspots.findIndex((h) => h.path === state.selectedDiffFile), 0);
          const nextIdx = (currentIdx + 1) % diffHotspots.length;
          set({ highlightedDiffIdx: nextIdx });
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          const currentIdx = state.highlightedDiffIdx ?? Math.max(diffHotspots.findIndex((h) => h.path === state.selectedDiffFile), 0);
          const nextIdx = (currentIdx - 1 + diffHotspots.length) % diffHotspots.length;
          set({ highlightedDiffIdx: nextIdx });
          return;
        }
        if (event.key === 'Enter') {
          const idx = state.highlightedDiffIdx ?? Math.max(diffHotspots.findIndex((h) => h.path === state.selectedDiffFile), 0);
          const hotspot = diffHotspots[idx];
          if (hotspot) {
            event.preventDefault();
            void handleSelectDiffFile(hotspot.path);
            return;
          }
        }
      }

      // Letter shortcuts
      if (state.focusTarget) {
        if (event.key === 'd' || event.key === 'D') { set({ focusTab: 'diff' }); return; }
        if (event.key === 't' || event.key === 'T') { set({ focusTab: 'tests' }); return; }
        if (event.key === 'l' || event.key === 'L') { set({ focusTab: 'trace' }); return; }
        if (event.key === 'p' || event.key === 'P') { set({ focusTab: 'permissions' }); return; }
        if (event.key === 'x' || event.key === 'X') { set({ focusTab: 'packet' }); return; }
      }
      if (event.key === 'g' || event.key === 'G') { set({ globalTool: 'grep' }); return; }
      if (event.key === 'b' || event.key === 'B') { set({ globalTool: 'browser' }); return; }
      if (event.key === 'm' || event.key === 'M') { set({ focusTarget: null, globalTool: 'none' }); return; }

      // 1-4 — switch event filter (Messages, All, Failures, Audit)
      const FILTER_KEYS: Record<string, 'messages' | 'all' | 'failures' | 'audit'> = {
        '1': 'messages', '2': 'all', '3': 'failures', '4': 'audit',
      };
      if (event.key in FILTER_KEYS) {
        set({ eventFilter: FILTER_KEYS[event.key], eventDrawerOpen: true });
        return;
      }

      // / — open command palette
      if (event.key === '/' && !event.ctrlKey) {
        event.preventDefault();
        set({ commandPaletteOpen: true, commandPaletteQuery: '' });
        return;
      }

      // ? — toggle keyboard shortcut cheat sheet
      if (event.key === '?' && !event.ctrlKey) {
        event.preventDefault();
        set({ shortcutSheetOpen: !state.shortcutSheetOpen });
        return;
      }

      // j/k or arrows — navigate sessions in right pane
      if (activePane === 'right' && (event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown')) {
        event.preventDefault();
        const currentIdx = state.highlightedSessionIdx ?? -1;
        const nextIdx = Math.min(currentIdx + 1, allSessions.length - 1);
        set({ highlightedSessionIdx: nextIdx });
        return;
      }
      if (activePane === 'right' && (event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const currentIdx = state.highlightedSessionIdx ?? 0;
        const nextIdx = Math.max(currentIdx - 1, 0);
        set({ highlightedSessionIdx: nextIdx });
        return;
      }
      if (event.key === 'Enter' && state.highlightedSessionIdx !== null) {
        const session = allSessions[state.highlightedSessionIdx];
        if (session) {
          event.preventDefault();
          set({ focusTarget: { type: 'session', id: session.sessionKey }, highlightedSessionIdx: null });
        }
        return;
      }

      const escalationId = selectFocusEscalationId(state);
      const focusStatus = selectFocusStatus(state);

      if ((event.key === 'r' || event.key === 'R') && escalationId) {
        void handleResolveEscalation(escalationId);
        return;
      }
      if ((event.key === 'a' || event.key === 'A') && focusStatus === 'ready') {
        void handleReviewDecision('accept');
        return;
      }
      if ((event.key === 'c' || event.key === 'C') && focusStatus === 'ready') {
        void handleReviewDecision('request_changes');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPanePointer, true);
    window.addEventListener('focusin', onPanePointer, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPanePointer, true);
      window.removeEventListener('focusin', onPanePointer, true);
    };
  }, [
    state,
    set,
    save,
    createFolder,
    editorRef,
    openNewFilePicker,
    closeNewFilePicker,
    workspace,
    handleSendMessage,
    handleResolveEscalation,
    handleReviewDecision,
    handleOpenUpgradePicker,
    handleSelectDiffFile,
  ]);
}
