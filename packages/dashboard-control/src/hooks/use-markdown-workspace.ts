import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  getCockpitMarkdownFile,
  getCockpitMarkdownTree,
  postCockpitMarkdownFile,
  postCockpitMarkdownFolder,
  postCockpitMarkdownPatch,
  type CockpitMarkdownContextInput,
  type CockpitMarkdownTreeNode,
} from '@/lib/api';
import {
  flattenMarkdownFiles,
  gatherMarkdownFolders,
  normalizeDocPath,
  normalizeWorkspacePathForClient,
} from '@/lib/markdown';
import type { EditorHandle } from '@/components/center/MarkdownEditor';

const DEFAULT_SUGGESTED_FOLDERS = ['notes', 'packets', 'plans', 'scratch', 'specs'];
const AUTOSAVE_DEBOUNCE_MS = 1400;

interface MarkdownState {
  rootDir: string;
  tree: CockpitMarkdownTreeNode[];
  suggestedFolders: string[];
  selectedPath: string | null;
  content: string;
  version: number;
  updatedAt: string | null;
  hash: string | null;
  dirty: boolean;
  expandedFolders: Set<string>;
  saving: boolean;
  autoSaving: boolean;
  loading: boolean;
  status: string | null;
  newFileDropdownOpen: boolean;
  newFileIntent: 'create' | 'save' | null;
  conflictVersion: number | null;
}

const initialState: MarkdownState = {
  rootDir: '.cockpit/markdown',
  tree: [],
  suggestedFolders: DEFAULT_SUGGESTED_FOLDERS,
  selectedPath: null,
  content: '',
  version: 0,
  updatedAt: null,
  hash: null,
  dirty: false,
  expandedFolders: new Set(),
  saving: false,
  autoSaving: false,
  loading: false,
  status: null,
  newFileDropdownOpen: false,
  newFileIntent: null,
  conflictVersion: null,
};

type MdAction =
  | { type: 'SET'; payload: Partial<MarkdownState> }
  | { type: 'SET_TREE'; payload: { rootDir: string; tree: CockpitMarkdownTreeNode[]; suggestedFolders: string[] } }
  | { type: 'TOGGLE_FOLDER'; path: string }
  | { type: 'FILE_LOADED'; payload: { path: string; content: string; version: number; updatedAt: string | null; hash: string | null } }
  | {
      type: 'FILE_SAVED';
      payload: {
        path: string;
        version: number;
        updatedAt: string | null;
        hash: string | null;
        mode: 'manual' | 'autosave';
      };
    };

function reducer(state: MarkdownState, action: MdAction): MarkdownState {
  switch (action.type) {
    case 'SET':
      return { ...state, ...action.payload };
    case 'SET_TREE': {
      const { rootDir, tree, suggestedFolders } = action.payload;
      const folders = gatherMarkdownFolders(tree);
      let expanded = state.expandedFolders;
      if (expanded.size === 0) {
        expanded = new Set(folders.slice(0, 4));
      }
      return { ...state, rootDir, tree, suggestedFolders, expandedFolders: expanded };
    }
    case 'TOGGLE_FOLDER': {
      const next = new Set(state.expandedFolders);
      if (next.has(action.path)) next.delete(action.path);
      else next.add(action.path);
      return { ...state, expandedFolders: next };
    }
    case 'FILE_LOADED':
      return {
        ...state,
        selectedPath: action.payload.path,
        content: action.payload.content,
        version: action.payload.version,
        updatedAt: action.payload.updatedAt,
        hash: action.payload.hash,
        dirty: false,
        loading: false,
        conflictVersion: null,
        status: `${action.payload.path} loaded`,
      };
    case 'FILE_SAVED':
      return {
        ...state,
        selectedPath: action.payload.path,
        version: action.payload.version,
        updatedAt: action.payload.updatedAt,
        hash: action.payload.hash,
        dirty: false,
        conflictVersion: null,
        saving: false,
        autoSaving: false,
        status: action.payload.mode === 'manual'
          ? `Saved ${action.payload.path}`
          : `Autosaved ${action.payload.path}`,
      };
    default:
      return state;
  }
}

export function useMarkdownWorkspace() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const editorRef = useRef<EditorHandle | null>(null);

  const files = useMemo(() => flattenMarkdownFiles(state.tree), [state.tree]);

  const set = useCallback((payload: Partial<MarkdownState>) => {
    dispatch({ type: 'SET', payload });
  }, []);

  const openNewFilePicker = useCallback((intent: 'create' | 'save' = 'create') => {
    set({ newFileDropdownOpen: true, newFileIntent: intent });
  }, [set]);

  const closeNewFilePicker = useCallback(() => {
    set({ newFileDropdownOpen: false, newFileIntent: null });
  }, [set]);

  const refreshTree = useCallback(async () => {
    try {
      const workspace = await getCockpitMarkdownTree();
      dispatch({
        type: 'SET_TREE',
        payload: {
          rootDir: workspace.rootDir || '.cockpit/markdown',
          tree: workspace.tree ?? [],
          suggestedFolders: workspace.suggestedFolders?.length ? workspace.suggestedFolders : DEFAULT_SUGGESTED_FOLDERS,
        },
      });
    } catch {
      // tree refresh is best-effort
    }
  }, []);

  const openFile = useCallback(async (filePath: string) => {
    set({ loading: true, status: null });
    try {
      const normalized = normalizeDocPath(filePath);
      if (!normalized) {
        set({ loading: false, status: 'Invalid markdown path' });
        return;
      }
      const file = await getCockpitMarkdownFile(normalized);
      dispatch({
        type: 'FILE_LOADED',
        payload: {
          path: file.path,
          content: file.content ?? '',
          version: file.version ?? 0,
          updatedAt: file.updatedAt ?? null,
          hash: file.hash ?? null,
        },
      });
      setTimeout(() => editorRef.current?.focus(), 0);
    } catch (err) {
      set({ loading: false, status: err instanceof Error ? err.message : String(err) });
    }
  }, [set]);

  const saveExistingFile = useCallback(async (
    mode: 'manual' | 'autosave',
    expectedVersionOverride?: number,
    forceOverwrite = false,
  ): Promise<{ ok: true } | { ok: false; conflict?: boolean }> => {
    const s = stateRef.current;
    if (!s.selectedPath) return { ok: false };
    const expectedVersion = typeof expectedVersionOverride === 'number'
      ? expectedVersionOverride
      : s.version;

    let response = await postCockpitMarkdownPatch({
      path: s.selectedPath,
      expectedVersion,
      content: s.content,
      source: 'dashboard-control',
      metadata: {
        editor: 'cockpit',
        mode,
        dirty: s.dirty,
        forceOverwrite,
      },
    });

    // Compatibility fallback: older control-plane builds may not yet expose /markdown/patch.
    if (!response.success && response.statusCode === 404) {
      response = await postCockpitMarkdownFile({
        path: s.selectedPath,
        content: s.content,
        expectedVersion,
        source: 'dashboard-control',
        metadata: {
          editor: 'cockpit',
          mode,
          dirty: s.dirty,
          forceOverwrite,
          fallbackRoute: 'markdown-file',
        },
      });
    }

    if (response.success && response.file) {
      dispatch({
        type: 'FILE_SAVED',
        payload: {
          path: response.file.path,
          version: response.file.version,
          updatedAt: response.file.updatedAt ?? null,
          hash: response.file.hash ?? null,
          mode,
        },
      });
      await refreshTree();
      return { ok: true };
    }

    if (typeof response.currentVersion === 'number') {
      set({
        saving: false,
        autoSaving: false,
        conflictVersion: response.currentVersion,
        status: mode === 'autosave'
          ? `Autosave paused: remote document advanced to v${response.currentVersion}. Press Ctrl+S to resolve.`
          : `Version conflict: remote is v${response.currentVersion}. Save again to overwrite with local content.`,
      });
      return { ok: false, conflict: true };
    }

    set({
      saving: false,
      autoSaving: false,
      status: response.error ?? 'Failed saving markdown file',
    });
    return { ok: false };
  }, [refreshTree, set]);

  const saveAutosave = useCallback(async (): Promise<boolean> => {
    const s = stateRef.current;
    if (!s.selectedPath || !s.dirty || s.conflictVersion !== null) return false;
    if (s.saving || s.autoSaving) return false;

    set({ autoSaving: true });
    try {
      const result = await saveExistingFile('autosave');
      return result.ok;
    } catch (err) {
      set({ autoSaving: false, status: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }, [saveExistingFile, set]);

  const save = useCallback(async () => {
    const s = stateRef.current;
    if (s.saving) return;

    set({ saving: true, status: null });
    try {
      if (!stateRef.current.selectedPath) {
        set({
          saving: false,
          status: 'Select a folder and filename to save this markdown file.',
        });
        openNewFilePicker('save');
        return;
      }

      const result = await saveExistingFile('manual');
      if (!result.ok && result.conflict && typeof stateRef.current.conflictVersion === 'number') {
        const overwrite = window.confirm(
          `Remote document changed (v${stateRef.current.conflictVersion}). Overwrite with your local content?`
        );
        if (!overwrite) {
          set({ saving: false });
          return;
        }
        set({ saving: true, status: 'Overwriting remote version with local content...' });
        await saveExistingFile('manual', stateRef.current.conflictVersion, true);
      }
    } catch (err) {
      set({ saving: false, status: err instanceof Error ? err.message : String(err) });
    }
  }, [openNewFilePicker, refreshTree, saveExistingFile, set]);

  const createFile = useCallback(() => {
    openNewFilePicker('create');
    set({ status: 'Select a folder and filename for the new markdown file.' });
  }, [openNewFilePicker, set]);

  const createFolder = useCallback(async () => {
    const baseFolder = stateRef.current.suggestedFolders[0] ?? 'notes';
    const entered = window.prompt('Create folder in markdown workspace', baseFolder);
    if (!entered) return;
    const normalized = normalizeWorkspacePathForClient(entered);
    if (!normalized) {
      set({ status: 'Invalid folder path' });
      return;
    }
    try {
      await postCockpitMarkdownFolder({ path: normalized });
      dispatch({ type: 'TOGGLE_FOLDER', path: normalized });
      set({ status: `Created folder ${normalized}` });
      await refreshTree();
    } catch (err) {
      set({ status: err instanceof Error ? err.message : String(err) });
    }
  }, [set, refreshTree]);

  const toggleFolder = useCallback((path: string) => {
    dispatch({ type: 'TOGGLE_FOLDER', path });
  }, []);

  const setContent = useCallback((content: string) => {
    set({ content, dirty: true });
  }, [set]);

  const getActiveContext = useCallback((): CockpitMarkdownContextInput | null => {
    const s = stateRef.current;
    if (!s.selectedPath && !s.content.trim()) return null;
    const selectionStart = editorRef.current?.selectionStart;
    const selectionEnd = editorRef.current?.selectionEnd;
    return {
      path: s.selectedPath ?? undefined,
      version: s.version,
      updatedAt: s.updatedAt ?? undefined,
      content: s.content,
      isDirty: s.dirty,
      selectionStart: typeof selectionStart === 'number' ? selectionStart : undefined,
      selectionEnd: typeof selectionEnd === 'number' ? selectionEnd : undefined,
      metadata: {
        editor: 'cockpit',
        rootDir: s.rootDir,
        hash: s.hash,
        conflictVersion: s.conflictVersion,
      },
    };
  }, []);

  const flushPendingAutosave = useCallback(async (): Promise<boolean> => {
    const s = stateRef.current;
    if (!s.dirty || !s.selectedPath || s.conflictVersion !== null) return true;
    const result = await saveAutosave();
    return result;
  }, [saveAutosave]);

  const createFileInFolder = useCallback(async (
    folder: string,
    options?: { filename?: string }
  ) => {
    const s = stateRef.current;
    const existing = new Set(files);
    const requestedNameRaw = options?.filename?.trim() || 'untitled.md';
    const requestedName = normalizeWorkspacePathForClient(requestedNameRaw, true) ?? '';
    if (!requestedName) {
      set({ status: 'Invalid filename', newFileDropdownOpen: false, newFileIntent: null });
      return;
    }

    let filename = requestedName;
    if (!/\.(md|markdown|mdx)$/i.test(filename)) {
      filename = `${filename}.md`;
    }
    let path = folder ? `${folder}/${filename}` : filename;
    let counter = 2;
    while (existing.has(path)) {
      const extMatch = filename.match(/\.[^./]+$/);
      const ext = extMatch ? extMatch[0] : '.md';
      const stem = filename.slice(0, filename.length - ext.length);
      filename = `${stem}-${counter}${ext}`;
      path = folder ? `${folder}/${filename}` : filename;
      counter++;
    }
    const normalized = normalizeDocPath(path);
    if (!normalized) {
      set({ status: 'Invalid path', newFileDropdownOpen: false, newFileIntent: null });
      return;
    }
    try {
      const content = s.newFileIntent === 'save' ? s.content : '';
      const response = await postCockpitMarkdownFile({
        path: normalized,
        content,
        expectedVersion: 0,
        source: 'dashboard-control',
        metadata: {
          editor: 'cockpit',
          createdBy: 'user',
          intent: s.newFileIntent ?? 'create',
        },
      });
      if (!response.success || !response.file) {
        set({ status: response.error ?? 'Failed creating file', newFileDropdownOpen: false, newFileIntent: null });
        return;
      }
      set({ newFileDropdownOpen: false, newFileIntent: null, status: `Created ${response.file.path}` });
      await refreshTree();
      await openFile(response.file.path);
    } catch (err) {
      set({
        status: err instanceof Error ? err.message : String(err),
        newFileDropdownOpen: false,
        newFileIntent: null,
      });
    }
  }, [files, set, refreshTree, openFile]);

  // Initial tree load
  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  // Debounced autosave for existing files.
  useEffect(() => {
    if (!state.dirty || !state.selectedPath) return;
    if (state.conflictVersion !== null) return;
    if (state.saving || state.autoSaving) return;
    const timer = window.setTimeout(() => {
      void saveAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    state.content,
    state.dirty,
    state.selectedPath,
    state.version,
    state.conflictVersion,
    state.saving,
    state.autoSaving,
    saveAutosave,
  ]);

  return {
    state,
    files,
    editorRef,
    set,
    refreshTree,
    openFile,
    save,
    createFile,
    createFolder,
    toggleFolder,
    setContent,
    openNewFilePicker,
    closeNewFilePicker,
    getActiveContext,
    flushPendingAutosave,
    createFileInFolder,
  };
}

export type MarkdownWorkspace = ReturnType<typeof useMarkdownWorkspace>;
