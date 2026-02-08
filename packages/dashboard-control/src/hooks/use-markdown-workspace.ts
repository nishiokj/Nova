import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  getCockpitFilesystem,
  getCockpitMarkdownFile,
  getCockpitMarkdownTree,
  postCockpitMarkdownDelete,
  postCockpitMarkdownFile,
  postCockpitMarkdownFolder,
  postCockpitMarkdownPatch,
  type CockpitFilesystemRoot,
  type CockpitMarkdownContextInput,
  type CockpitMarkdownScopeInput,
  type CockpitMarkdownTreeNode,
} from '@/lib/api';
import {
  flattenMarkdownFiles,
  gatherMarkdownFolders,
  getDocumentType,
  normalizeDocPath,
  normalizeWorkspacePathForClient,
} from '@/lib/markdown';
import type { EditorHandle } from '@/components/center/MarkdownEditor';

const AUTOSAVE_DEBOUNCE_MS = 1400;
const SCRATCH_ROOT = '.cockpit/scratch';

export interface WorkspaceRoot {
  id: string;
  kind: 'scratch' | 'project';
  label: string;
  path: string;
}

interface MarkdownState {
  activeRoot: string;              // '.cockpit/scratch' or absolute project path
  roots: WorkspaceRoot[];          // scratch + discovered projects
  tree: CockpitMarkdownTreeNode[];
  selectedPath: string | null;
  content: string;
  version: number;
  dirty: boolean;
  expandedFolders: Set<string>;
  saving: boolean;
  autoSaving: boolean;
  loading: boolean;
  status: string | null;
  newFileDropdownOpen: boolean;
  newFileIntent: 'create' | 'save' | null;
  newFileDefaultFolder: string | null;
  conflictVersion: number | null;
}

const initialState: MarkdownState = {
  activeRoot: SCRATCH_ROOT,
  roots: [],
  tree: [],
  selectedPath: null,
  content: '',
  version: 0,
  dirty: false,
  expandedFolders: new Set(),
  saving: false,
  autoSaving: false,
  loading: false,
  status: null,
  newFileDropdownOpen: false,
  newFileIntent: null,
  newFileDefaultFolder: null,
  conflictVersion: null,
};

type MdAction =
  | { type: 'SET'; payload: Partial<MarkdownState> }
  | { type: 'SET_TREE'; payload: { rootDir: string; tree: CockpitMarkdownTreeNode[] } }
  | { type: 'TOGGLE_FOLDER'; path: string }
  | { type: 'FILE_LOADED'; payload: { path: string; content: string; version: number } }
  | {
      type: 'FILE_SAVED';
      payload: {
        path: string;
        version: number;
        mode: 'manual' | 'autosave';
      };
    };

function reducer(state: MarkdownState, action: MdAction): MarkdownState {
  switch (action.type) {
    case 'SET':
      return { ...state, ...action.payload };
    case 'SET_TREE': {
      const { rootDir, tree } = action.payload;
      const folders = gatherMarkdownFolders(tree);
      let expanded = state.expandedFolders;
      if (expanded.size === 0) {
        expanded = new Set(folders.slice(0, 4));
      }
      return { ...state, activeRoot: rootDir, tree, expandedFolders: expanded };
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

function buildScopeInput(state: MarkdownState): CockpitMarkdownScopeInput {
  if (state.activeRoot !== SCRATCH_ROOT) {
    return { projectPath: state.activeRoot };
  }
  return {};
}

export function useMarkdownWorkspace() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const editorRef = useRef<EditorHandle | null>(null);
  const pendingEditorRefocusTimerRef = useRef<number | null>(null);

  const files = useMemo(() => flattenMarkdownFiles(state.tree), [state.tree]);

  const set = useCallback((payload: Partial<MarkdownState>) => {
    dispatch({ type: 'SET', payload });
  }, []);

  const openNewFilePicker = useCallback((
    intent: 'create' | 'save' = 'create',
    defaultFolder?: string | null
  ) => {
    if (pendingEditorRefocusTimerRef.current !== null) {
      window.clearTimeout(pendingEditorRefocusTimerRef.current);
      pendingEditorRefocusTimerRef.current = null;
    }

    const selectedPath = stateRef.current.selectedPath;
    const selectedParent = selectedPath && selectedPath.includes('/')
      ? selectedPath.slice(0, selectedPath.lastIndexOf('/'))
      : '';
    const fallbackDefault = intent === 'create' ? '' : selectedParent;
    const resolvedDefault = defaultFolder ?? fallbackDefault;
    const normalizedDefault = typeof resolvedDefault === 'string'
      ? normalizeWorkspacePathForClient(resolvedDefault, true)
      : null;

    editorRef.current?.blur();
    set({
      newFileDropdownOpen: true,
      newFileIntent: intent,
      newFileDefaultFolder: normalizedDefault ?? null,
    });
  }, [set]);

  const closeNewFilePicker = useCallback(() => {
    set({ newFileDropdownOpen: false, newFileIntent: null, newFileDefaultFolder: null });
    if (pendingEditorRefocusTimerRef.current !== null) {
      window.clearTimeout(pendingEditorRefocusTimerRef.current);
    }
    pendingEditorRefocusTimerRef.current = window.setTimeout(() => {
      editorRef.current?.focus();
      pendingEditorRefocusTimerRef.current = null;
    }, 0);
  }, [set]);

  const applyWorkspaceTree = useCallback((workspace: {
    rootDir?: string;
    tree?: CockpitMarkdownTreeNode[];
  }) => {
    dispatch({
      type: 'SET_TREE',
      payload: {
        rootDir: workspace.rootDir || SCRATCH_ROOT,
        tree: workspace.tree ?? [],
      },
    });
  }, []);

  const refreshTree = useCallback(async (scopeOverride?: CockpitMarkdownScopeInput) => {
    try {
      const scopeInput = scopeOverride ?? buildScopeInput(stateRef.current);
      const workspace = await getCockpitMarkdownTree(scopeInput);
      applyWorkspaceTree(workspace);
    } catch {
      // tree refresh is best-effort
    }
  }, [applyWorkspaceTree]);

  const refreshRoots = useCallback(async () => {
    const filesystem = await getCockpitFilesystem();
    if (!filesystem) return;
    const roots: WorkspaceRoot[] = (filesystem.roots ?? []).map((r: CockpitFilesystemRoot) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      path: r.path,
    }));
    set({ roots });
  }, [set]);

  const setActiveRoot = useCallback(async (rootPath: string) => {
    const isProject = rootPath !== SCRATCH_ROOT;
    const scopeInput: CockpitMarkdownScopeInput = isProject
      ? { projectPath: rootPath }
      : {};
    set({
      loading: true,
      status: isProject
        ? `Switching to project ${rootPath}...`
        : 'Switching to scratch...',
    });
    try {
      const workspace = await getCockpitMarkdownTree(scopeInput);
      applyWorkspaceTree(workspace);
      set({
        loading: false,
        status: isProject ? rootPath : 'scratch',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        loading: false,
        status: `Could not switch workspace: ${message}`,
      });
    }
  }, [set, applyWorkspaceTree]);

  const openFile = useCallback(async (filePath: string) => {
    set({ loading: true, status: null });
    try {
      const normalized = normalizeDocPath(filePath);
      if (!normalized) {
        set({ loading: false, status: 'Invalid markdown path' });
        return;
      }
      const file = await getCockpitMarkdownFile(normalized, buildScopeInput(stateRef.current));
      dispatch({
        type: 'FILE_LOADED',
        payload: {
          path: file.path,
          content: file.content ?? '',
          version: file.version ?? 0,
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
    const scopeInput = buildScopeInput(s);
    const expectedVersion = typeof expectedVersionOverride === 'number'
      ? expectedVersionOverride
      : s.version;

    let response = await postCockpitMarkdownPatch({
      path: s.selectedPath,
      ...scopeInput,
      expectedVersion,
      content: s.content,
      source: 'dashboard-control',
    });

    // Compatibility fallback: older control-plane builds may not yet expose /markdown/patch.
    if (!response.success && response.statusCode === 404) {
      response = await postCockpitMarkdownFile({
        path: s.selectedPath,
        ...scopeInput,
        content: s.content,
        expectedVersion,
        source: 'dashboard-control',
      });
    }

    if (response.success && response.file) {
      dispatch({
        type: 'FILE_SAVED',
        payload: {
          path: response.file.path,
          version: response.file.version,
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
    if (s.saving || s.autoSaving) return;

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
  }, [openNewFilePicker, saveExistingFile, set]);

  const createFile = useCallback(() => {
    openNewFilePicker('create');
    set({ status: 'Select a folder and filename for the new markdown file.' });
  }, [openNewFilePicker, set]);

  const createFolder = useCallback(async () => {
    const entered = window.prompt(
      'Create folder in current workspace (relative path)',
      ''
    );
    if (!entered) return;
    const normalized = normalizeWorkspacePathForClient(entered);
    if (!normalized) {
      set({ status: 'Invalid folder path' });
      return;
    }
    try {
      await postCockpitMarkdownFolder({
        path: normalized,
        ...buildScopeInput(stateRef.current),
      });
      dispatch({ type: 'TOGGLE_FOLDER', path: normalized });
      set({ status: `Created folder ${normalized}` });
      await refreshTree();
    } catch (err) {
      set({ status: err instanceof Error ? err.message : String(err) });
    }
  }, [set, refreshTree]);

  const deletePath = useCallback(async (
    targetPath: string,
    type: 'file' | 'folder',
    options?: { recursive?: boolean }
  ) => {
    const normalized = normalizeWorkspacePathForClient(targetPath);
    if (!normalized) {
      set({ status: 'Invalid path' });
      return false;
    }
    try {
      const response = await postCockpitMarkdownDelete({
        path: normalized,
        type,
        recursive: options?.recursive === true,
        ...buildScopeInput(stateRef.current),
      });
      if (!response.success) {
        set({ status: response.error ?? `Failed deleting ${type}` });
        return false;
      }

      const s = stateRef.current;
      const selected = s.selectedPath;
      const removedSelected = selected
        ? (type === 'file'
            ? selected === normalized
            : selected === normalized || selected.startsWith(`${normalized}/`))
        : false;
      if (removedSelected) {
        set({
          selectedPath: null,
          content: '',
          version: 0,
          dirty: false,
          conflictVersion: null,
        });
      }

      set({ status: `Deleted ${type}: ${normalized}` });
      await refreshTree();
      return true;
    } catch (err) {
      set({ status: err instanceof Error ? err.message : String(err) });
      return false;
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
      projectPath: s.activeRoot !== SCRATCH_ROOT ? s.activeRoot : undefined,
      version: s.version,
      content: s.content,
      isDirty: s.dirty,
      selectionStart: typeof selectionStart === 'number' ? selectionStart : undefined,
      selectionEnd: typeof selectionEnd === 'number' ? selectionEnd : undefined,
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

    const normalizedFolder = normalizeWorkspacePathForClient(folder, true);
    if (normalizedFolder === null) {
      set({ status: 'Invalid folder path', newFileDropdownOpen: false, newFileIntent: null });
      return;
    }

    let filename = requestedName;
    if (!/\.(md|markdown|mdx)$/i.test(filename)) {
      filename = `${filename}.md`;
    }
    let path = normalizedFolder ? `${normalizedFolder}/${filename}` : filename;
    let counter = 2;
    while (existing.has(path)) {
      const extMatch = filename.match(/\.[^./]+$/);
      const ext = extMatch ? extMatch[0] : '.md';
      const stem = filename.slice(0, filename.length - ext.length);
      filename = `${stem}-${counter}${ext}`;
      path = normalizedFolder ? `${normalizedFolder}/${filename}` : filename;
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
        ...buildScopeInput(s),
        content,
        expectedVersion: 0,
        source: 'dashboard-control',
      });
      if (!response.success || !response.file) {
        set({
          status: response.error ?? 'Failed creating file',
          newFileDropdownOpen: false,
          newFileIntent: null,
          newFileDefaultFolder: null,
        });
        return;
      }
      set({
        newFileDropdownOpen: false,
        newFileIntent: null,
        newFileDefaultFolder: null,
        status: `Created ${response.file.path}`,
      });
      await refreshTree();
      await openFile(response.file.path);
    } catch (err) {
      set({
        status: err instanceof Error ? err.message : String(err),
        newFileDropdownOpen: false,
        newFileIntent: null,
        newFileDefaultFolder: null,
      });
    }
  }, [files, set, refreshTree, openFile]);

  // Initial tree load
  useEffect(() => {
    void refreshTree();
    void refreshRoots();
  }, [refreshTree, refreshRoots]);

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

  useEffect(() => () => {
    if (pendingEditorRefocusTimerRef.current !== null) {
      window.clearTimeout(pendingEditorRefocusTimerRef.current);
      pendingEditorRefocusTimerRef.current = null;
    }
  }, []);

  return {
    state,
    files,
    editorRef,
    set,
    setActiveRoot,
    refreshRoots,
    refreshTree,
    openFile,
    save,
    createFile,
    createFolder,
    deletePath,
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
