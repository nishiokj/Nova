import { useEffect, useRef } from 'react';
import type { CockpitStoreImpl, FocusTab } from './use-cockpit-store';
import { selectFocusEscalationId, selectFocusStatus } from './use-cockpit-store';
import type { MarkdownWorkspace } from './use-markdown-workspace';

type PaneId = 'left' | 'center' | 'right';

function isAsyncFocus(
  state: ReturnType<CockpitStoreImpl['getSnapshot']>
): boolean {
  if (state.focusData?.type === 'escalation') return true;
  if (state.focusData?.isAsync) return true;
  const focusedKey = state.focusData?.sessionKey;
  if (!focusedKey) return false;
  const row = [...state.runningSessions, ...state.readySessions, ...state.doneSessions]
    .find((session) => session.sessionKey === focusedKey);
  return Boolean(row?.isAsync || row?.blocking.unresolvedEscalationsCount);
}

function getFocusableTabs(
  state: ReturnType<CockpitStoreImpl['getSnapshot']>,
  store: CockpitStoreImpl,
): FocusTab[] {
  const sessionKey = state.focusData?.sessionKey;
  if (sessionKey && store.getDocumentSessionPath(sessionKey)) {
    const tabs: FocusTab[] = ['document', 'permissions'];
    if (isAsyncFocus(state)) {
      tabs.splice(1, 0, 'escalations');
    }
    return tabs;
  }
  const tabs: FocusTab[] = ['live', 'diff', 'tests', 'trace', 'permissions'];
  if (isAsyncFocus(state)) {
    tabs.splice(1, 0, 'escalations');
  }
  return tabs;
}

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

function isInteractiveElement(node: EventTarget | Element | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return (
    node instanceof HTMLInputElement
    || node instanceof HTMLTextAreaElement
    || node instanceof HTMLSelectElement
    || node instanceof HTMLButtonElement
    || node instanceof HTMLAnchorElement
    || node.isContentEditable
  );
}

export function useKeyboard(store: CockpitStoreImpl, workspace: MarkdownWorkspace) {
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const lastPaneRef = useRef<PaneId>('center');

  useEffect(() => {
    const focusPane = (pane: PaneId) => {
      const state = store.getSnapshot();
      const ws = workspaceRef.current;
      lastPaneRef.current = pane;
      const paneEl = document.querySelector<HTMLElement>(`[data-cockpit-pane="${pane}"]`);
      paneEl?.focus({ preventScroll: true });
      if (
        pane === 'center'
        && !state.focusTarget
        && !ws.state.newFileDropdownOpen
        && !state.upgradePickerOpen
      ) {
        ws.editorRef.current?.focus();
      }
    };

    const onPaneMouseDown = (event: MouseEvent) => {
      const pane = paneFromNode(event.target);
      if (!pane) return;
      if (isInteractiveElement(event.target)) {
        lastPaneRef.current = pane;
        return;
      }
      focusPane(pane);
    };

    const onPaneFocusIn = (event: FocusEvent) => {
      const pane = paneFromNode(event.target);
      if (!pane) return;
      lastPaneRef.current = pane;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const state = store.getSnapshot();
      const ws = workspaceRef.current;
      const target = event.target as HTMLElement | null;
      const activeElement = document.activeElement as HTMLElement | null;
      const targetIsDocumentRoot = target === document.body || target === document.documentElement;
      const hasCockpitRoot = !!document.querySelector('[data-cockpit-root="true"]');
      const insideCockpit = inCockpit(target) || inCockpit(activeElement) || (targetIsDocumentRoot && hasCockpitRoot);
      if (!insideCockpit) return;

      const activePane = paneFromNode(target) ?? paneFromNode(activeElement) ?? lastPaneRef.current;
      const isTypingTarget = !!target && (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target.isContentEditable
      );

      if (state.permissionDialogOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          store.dismissPermissionDialog();
        }
        return;
      }

      // While the filename picker is open, keep keyboard handling scoped there.
      if (ws.state.newFileDropdownOpen && event.key !== 'Escape') return;

      // Alt+h/j/k/l — pane focus navigation (vim-like, circular).
      if (event.altKey && !event.metaKey && !event.ctrlKey) {
        const code = event.code;
        const key = event.key.toLowerCase();
        if (code === 'KeyH' || key === 'h') {
          event.preventDefault();
          event.stopPropagation();
          const panes: PaneId[] = ['left', 'center', 'right'];
          const currentIdx = panes.indexOf(activePane);
          const prevIdx = (currentIdx - 1 + panes.length) % panes.length;
          focusPane(panes[prevIdx]);
          return;
        }
        if (code === 'KeyJ' || code === 'KeyK' || key === 'j' || key === 'k') {
          event.preventDefault();
          event.stopPropagation();
          focusPane('center');
          return;
        }
        if (code === 'KeyL' || key === 'l') {
          event.preventDefault();
          event.stopPropagation();
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
          store.set({ inputVisible: true, eventDrawerOpen: true, eventFilter: 'messages' });
        } else {
          store.set({ inputVisible: false, eventDrawerOpen: false });
        }
        return;
      }

      // Ctrl+U — promote picker (skip in textarea/input — they handle Ctrl+U as clear)
      if (event.ctrlKey && !event.shiftKey && (event.key === 'u' || event.key === 'U')) {
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
        event.preventDefault();
        store.handleOpenUpgradePicker();
        return;
      }

      // Ctrl+S — save markdown
      if (event.ctrlKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        void ws.save();
        return;
      }

      // Ctrl+N — new file (folder picker)
      if (event.ctrlKey && !event.shiftKey && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault();
        store.set({ focusTarget: null });
        if (ws.state.newFileDropdownOpen) {
          ws.closeNewFilePicker();
        } else {
          ws.openNewFilePicker('create');
        }
        return;
      }

      // Ctrl+Shift+N — new folder
      if (event.ctrlKey && event.shiftKey && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault();
        void ws.createFolder();
        return;
      }

      // Ctrl+Shift+S — new session (when focused on left pane)
      if (event.ctrlKey && event.shiftKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        if (activePane === 'left') {
          // Trigger the openNewSessionDialog action via the stored function
          const actions = (window as any).__cockpitFileExplorerActions;
          if (actions?.triggerNewSession) {
            actions.triggerNewSession();
          }
        }
        return;
      }


      // Escape — close overlay / dropdown / input
      if (event.key === 'Escape') {
        if (state.commandPaletteOpen) {
          store.set({ commandPaletteOpen: false, commandPaletteQuery: '' });
          return;
        }
        if (state.shortcutSheetOpen) {
          store.set({ shortcutSheetOpen: false });
          return;
        }
        if (state.upgradePickerOpen) {
          store.set({ upgradePickerOpen: false });
          return;
        }
        if (ws.state.newFileDropdownOpen) {
          ws.closeNewFilePicker();
          return;
        }
        if (state.highlightedSessionIdx !== null) {
          store.set({ highlightedSessionIdx: null });
          return;
        }
        if (state.inputVisible) store.set({ inputVisible: false });
        return;
      }

      // Tab/Shift+Tab — cycle center session tabs, or let CodeMirror handle it in editor.
      if (event.key === 'Tab' && !event.metaKey && !event.altKey && !event.ctrlKey) {
        if (!state.focusTarget && activePane === 'center') return;

        if (state.focusTarget && state.globalTool === 'none' && activePane === 'center') {
          event.preventDefault();
          const focusTabs = getFocusableTabs(state, store);
          const idx = focusTabs.indexOf(state.focusTab);
          if (idx < 0) {
            store.set({ focusTab: focusTabs[0] ?? 'live' });
            return;
          }
          const next = event.shiftKey
            ? (idx - 1 + focusTabs.length) % focusTabs.length
            : (idx + 1) % focusTabs.length;
          store.set({ focusTab: focusTabs[next] });
          return;
        }

        event.preventDefault();
        return;
      }

      // Permissions tab: arrow keys navigate checkboxes, Enter toggles
      if (
        state.focusTarget
        && state.focusTab === 'permissions'
        && !event.ctrlKey
        && !event.shiftKey
        && !event.metaKey
        && !event.altKey
      ) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const checkboxes = Array.from(
            document.querySelectorAll<HTMLInputElement>('[data-cockpit-pane="center"] input[type="checkbox"]')
          );
          if (checkboxes.length > 0) {
            const currentIdx = checkboxes.indexOf(document.activeElement as HTMLInputElement);
            const nextIdx = event.key === 'ArrowDown'
              ? (currentIdx + 1) % checkboxes.length
              : (currentIdx - 1 + checkboxes.length) % checkboxes.length;
            checkboxes[nextIdx].focus();
          }
          return;
        }
        if (event.key === 'Enter' && document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'checkbox') {
          event.preventDefault();
          document.activeElement.click();
          return;
        }
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
          store.set({ highlightedDiffIdx: nextIdx });
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          const currentIdx = state.highlightedDiffIdx ?? Math.max(diffHotspots.findIndex((h) => h.path === state.selectedDiffFile), 0);
          const nextIdx = (currentIdx - 1 + diffHotspots.length) % diffHotspots.length;
          store.set({ highlightedDiffIdx: nextIdx });
          return;
        }
        if (event.key === 'Enter') {
          const idx = state.highlightedDiffIdx ?? Math.max(diffHotspots.findIndex((h) => h.path === state.selectedDiffFile), 0);
          const hotspot = diffHotspots[idx];
          if (hotspot) {
            event.preventDefault();
            void store.handleSelectDiffFile(hotspot.path);
            return;
          }
        }
      }

      // Letter shortcuts
      if (state.focusTarget) {
        if (event.key === 'x' || event.key === 'X') { store.set({ focusTab: 'live' }); return; }
        if (event.key === 'o' || event.key === 'O') {
          if (isAsyncFocus(state)) {
            store.set({ focusTab: 'escalations' });
          }
          return;
        }
        if (event.key === 'd' || event.key === 'D') { store.set({ focusTab: 'diff' }); return; }
        if (event.key === 't' || event.key === 'T') { store.set({ focusTab: 'tests' }); return; }
        if (event.key === 'l' || event.key === 'L') { store.set({ focusTab: 'trace' }); return; }
        if (event.key === 'p' || event.key === 'P') { store.set({ focusTab: 'permissions' }); return; }
      }
      if (event.key === 'm' || event.key === 'M') { store.set({ focusTarget: null, globalTool: 'none' }); return; }

      // 1-4 — switch event filter (Messages, All, Failures, Audit)
      const FILTER_KEYS: Record<string, 'messages' | 'all' | 'failures' | 'audit'> = {
        '1': 'messages', '2': 'all', '3': 'failures', '4': 'audit',
      };
      if (event.key in FILTER_KEYS) {
        store.set({ eventFilter: FILTER_KEYS[event.key], eventDrawerOpen: true });
        return;
      }

      // / — open command palette
      if (event.key === '/' && !event.ctrlKey) {
        event.preventDefault();
        store.set({ commandPaletteOpen: true, commandPaletteQuery: '' });
        return;
      }

      // ? — toggle keyboard shortcut cheat sheet
      if (event.key === '?' && !event.ctrlKey) {
        event.preventDefault();
        store.set({ shortcutSheetOpen: !state.shortcutSheetOpen });
        return;
      }

      // j/k or arrows — navigate sessions in right pane
      if (activePane === 'right' && (event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown')) {
        event.preventDefault();
        const currentIdx = state.highlightedSessionIdx ?? -1;
        const nextIdx = Math.min(currentIdx + 1, allSessions.length - 1);
        store.set({ highlightedSessionIdx: nextIdx });
        return;
      }
      if (activePane === 'right' && (event.key === 'k' || event.key === 'K' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const currentIdx = state.highlightedSessionIdx ?? 0;
        const nextIdx = Math.max(currentIdx - 1, 0);
        store.set({ highlightedSessionIdx: nextIdx });
        return;
      }
      if (event.key === 'Enter' && state.highlightedSessionIdx !== null) {
        const session = allSessions[state.highlightedSessionIdx];
        if (session) {
          event.preventDefault();
          store.set({
            focusTarget: { type: 'session', id: session.sessionKey },
            ...(session.blocking.unresolvedEscalationsCount > 0 ? { focusTab: 'escalations' as const } : {}),
            highlightedSessionIdx: null,
          });
        }
        return;
      }

      const escalationId = selectFocusEscalationId(state);
      const focusStatus = selectFocusStatus(state);

      if ((event.key === 'r' || event.key === 'R') && escalationId) {
        void store.handleResolveEscalation(escalationId);
        return;
      }
      if ((event.key === 'a' || event.key === 'A') && focusStatus === 'ready') {
        void store.handleReviewDecision('accept');
        return;
      }
      if ((event.key === 'c' || event.key === 'C') && focusStatus === 'ready') {
        void store.handleReviewDecision('request_changes');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPaneMouseDown, true);
    window.addEventListener('focusin', onPaneFocusIn, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPaneMouseDown, true);
      window.removeEventListener('focusin', onPaneFocusIn, true);
    };
  }, [store]); // store is stable — registers ONCE
}
