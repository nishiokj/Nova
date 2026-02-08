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
  parseFrontmatter,
} from '@/lib/markdown';
import type { EditorHandle } from '@/components/center/MarkdownEditor';

const DEFAULT_SUGGESTED_FOLDERS = ['scratch', 'packets', 'plans', 'specs', 'handoffs'];
const AUTOSAVE_DEBOUNCE_MS = 1400;

function createClientDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface MarkdownState {
  rootDir: string;
  scopeMode: 'global' | 'session' | 'project';
  scopeSessionKey: string | null;
  scopeProjectPath: string | null;
  filesystemRoots: CockpitFilesystemRoot[];
  filesystemCwd: string | null;
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
  newFileDefaultFolder: string | null;
  conflictVersion: number | null;
}

const initialState: MarkdownState = {
  rootDir: '.cockpit/markdown',
  scopeMode: 'global',
  scopeSessionKey: null,
  scopeProjectPath: null,
  filesystemRoots: [],
  filesystemCwd: null,
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
  newFileDefaultFolder: null,
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

function buildScopeInput(state: MarkdownState): CockpitMarkdownScopeInput {
  if (state.scopeMode === 'session' && state.scopeSessionKey) {
    return { sessionKey: state.scopeSessionKey };
  }
  if (state.scopeMode === 'project' && state.scopeProjectPath) {
    return { projectPath: state.scopeProjectPath };
  }
  return {};
}

export function useMarkdownWorkspace() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const editorRef = useRef<EditorHandle | null>(null);
  const unsavedDraftIdRef = useRef<string | null>(null);
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
    // New-file create should start from workspace root unless caller explicitly chooses a folder.
    const fallbackDefault = intent === 'create' ? '' : selectedParent;
    const resolvedDefault = defaultFolder ?? fallbackDefault;
    const normalizedDefault = typeof resolvedDefault === 'string'
      ? normalizeWorkspacePathForClient(resolvedDefault, true)
      : null;

    // Blur the editor to move cursor away from the document
    editorRef.current?.blur();
    set({
      newFileDropdownOpen: true,
      newFileIntent: intent,
      newFileDefaultFolder: normalizedDefault ?? null,
    });
  }, [set]);

  const closeNewFilePicker = useCallback(() => {
    set({ newFileDropdownOpen: false, newFileIntent: null, newFileDefaultFolder: null });
    // Refocus the editor when the dropdown is closed
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
    suggestedFolders?: string[];
  }) => {
    dispatch({
      type: 'SET_TREE',
      payload: {
        rootDir: workspace.rootDir || '.cockpit/markdown',
        tree: workspace.tree ?? [],
        suggestedFolders: workspace.suggestedFolders?.length ? workspace.suggestedFolders : DEFAULT_SUGGESTED_FOLDERS,
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

  const refreshFilesystem = useCallback(async (scopeOverride?: {
    mode: 'global' | 'session' | 'project';
    sessionKey?: string | null;
    projectPath?: string | null;
  }) => {
    const s = stateRef.current;
    const effectiveMode = scopeOverride?.mode ?? s.scopeMode;
    const effectiveSessionKey = scopeOverride?.sessionKey ?? s.scopeSessionKey;
    const effectiveProjectPath = scopeOverride?.projectPath ?? s.scopeProjectPath;
    const filesystem = await getCockpitFilesystem(
      effectiveMode === 'session' && effectiveSessionKey
        ? { sessionKey: effectiveSessionKey }
        : effectiveMode === 'project' && effectiveProjectPath
          ? { projectPath: effectiveProjectPath }
        : {}
    );
    if (!filesystem) return;
    set({
      filesystemRoots: filesystem.roots ?? [],
      filesystemCwd: filesystem.cwd ?? null,
    });
  }, [set]);

  const setScope = useCallback(async (scope: {
    mode: 'global' | 'session' | 'project';
    sessionKey?: string | null;
    projectPath?: string | null;
  }) => {
    const nextSessionKey = scope.mode === 'session' ? (scope.sessionKey ?? null) : null;
    const nextProjectPath = scope.mode === 'project'
      ? (scope.projectPath?.trim() || null)
      : null;
    if (scope.mode === 'project' && !nextProjectPath) {
      set({ status: 'Enter a project folder path to switch workspace.' });
      return;
    }
    const scopeInput: CockpitMarkdownScopeInput = scope.mode === 'session'
      ? (nextSessionKey ? { sessionKey: nextSessionKey } : {})
      : scope.mode === 'project'
        ? (nextProjectPath ? { projectPath: nextProjectPath } : {})
        : {};
    set({
      loading: true,
      status: scope.mode === 'global'
        ? 'Switching workspace to scratch...'
        : scope.mode === 'session'
          ? `Switching workspace to session ${nextSessionKey ?? ''}...`
          : `Switching workspace to project ${nextProjectPath}...`,
    });
    try {
      const workspace = await getCockpitMarkdownTree(scopeInput);
      applyWorkspaceTree(workspace);
      set({
        loading: false,
        scopeMode: scope.mode,
        scopeSessionKey: nextSessionKey,
        scopeProjectPath: nextProjectPath,
        status: scope.mode === 'global'
          ? 'Workspace: scratch (.cockpit/markdown)'
          : scope.mode === 'session'
            ? `Workspace: session ${nextSessionKey ?? ''}`
            : `Workspace: project ${nextProjectPath}`,
      });
      await refreshFilesystem({
        mode: scope.mode,
        ...(nextSessionKey ? { sessionKey: nextSessionKey } : {}),
        ...(nextProjectPath ? { projectPath: nextProjectPath } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        loading: false,
        status: scope.mode === 'project'
          ? `Could not switch to project ${nextProjectPath}: ${message}`
          : `Could not switch workspace: ${message}`,
      });
    }
  }, [set, refreshFilesystem, applyWorkspaceTree]);

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
          updatedAt: file.updatedAt ?? null,
          hash: file.hash ?? null,
        },
      });
      unsavedDraftIdRef.current = null;
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
        ...scopeInput,
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
    const baseFolder = stateRef.current.suggestedFolders[0] ?? 'scratch';
    const entered = window.prompt(
      'Create folder in current workspace (relative path)',
      baseFolder
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
          updatedAt: null,
          hash: null,
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
    if (stateRef.current.selectedPath) {
      unsavedDraftIdRef.current = null;
    } else if (content.trim().length === 0) {
      unsavedDraftIdRef.current = null;
    }
    set({ content, dirty: true });
  }, [set]);

  const getActiveContext = useCallback((): CockpitMarkdownContextInput | null => {
    const s = stateRef.current;
    if (!s.selectedPath && !s.content.trim()) return null;
    if (s.selectedPath) {
      unsavedDraftIdRef.current = null;
    } else if (!unsavedDraftIdRef.current) {
      unsavedDraftIdRef.current = createClientDraftId();
    }
    const draftId = s.selectedPath ? undefined : (unsavedDraftIdRef.current ?? undefined);
    const selectionStart = editorRef.current?.selectionStart;
    const selectionEnd = editorRef.current?.selectionEnd;
    const { frontmatter } = parseFrontmatter(s.content);
    const frontmatterSessionKeyRaw = typeof frontmatter.sessionKey === 'string'
      ? frontmatter.sessionKey
      : typeof frontmatter.session_key === 'string'
        ? frontmatter.session_key
        : typeof frontmatter.chatSessionKey === 'string'
          ? frontmatter.chatSessionKey
          : typeof frontmatter.chat_session_key === 'string'
            ? frontmatter.chat_session_key
            : undefined;
    const frontmatterSessionKey = typeof frontmatterSessionKeyRaw === 'string' && frontmatterSessionKeyRaw.trim().length > 0
      ? frontmatterSessionKeyRaw.trim()
      : undefined;
    const templateNameRaw = typeof frontmatter.template === 'string'
      ? frontmatter.template
      : typeof frontmatter.templateName === 'string'
        ? frontmatter.templateName
        : typeof frontmatter.template_name === 'string'
          ? frontmatter.template_name
          : undefined;
    const templateName = typeof templateNameRaw === 'string' && templateNameRaw.trim().length > 0
      ? templateNameRaw.trim()
      : undefined;
    const templateIdRaw = typeof frontmatter.templateId === 'string'
      ? frontmatter.templateId
      : typeof frontmatter.template_id === 'string'
        ? frontmatter.template_id
        : typeof frontmatter.workflowTemplateId === 'string'
          ? frontmatter.workflowTemplateId
          : typeof frontmatter.workflow_template_id === 'string'
            ? frontmatter.workflow_template_id
            : undefined;
    const templateId = typeof templateIdRaw === 'string' && templateIdRaw.trim().length > 0
      ? templateIdRaw.trim()
      : undefined;
    const specs = Array.isArray(frontmatter.specs)
      ? frontmatter.specs.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : typeof frontmatter.specs === 'string' && frontmatter.specs.trim().length > 0
        ? [frontmatter.specs.trim()]
      : undefined;
    return {
      path: s.selectedPath ?? undefined,
      workspaceScope: s.scopeMode,
      scopeSessionKey: s.scopeSessionKey ?? undefined,
      projectPath: s.scopeProjectPath ?? undefined,
      version: s.version,
      updatedAt: s.updatedAt ?? undefined,
      content: s.content,
      isDirty: s.dirty,
      selectionStart: typeof selectionStart === 'number' ? selectionStart : undefined,
      selectionEnd: typeof selectionEnd === 'number' ? selectionEnd : undefined,
      metadata: {
        editor: 'cockpit',
        rootDir: s.rootDir,
        workspaceScope: s.scopeMode,
        workspaceSessionKey: s.scopeSessionKey,
        workspaceProjectPath: s.scopeProjectPath,
        hash: s.hash,
        conflictVersion: s.conflictVersion,
        documentType: getDocumentType(s.content),
        ...(frontmatterSessionKey ? { documentSessionKey: frontmatterSessionKey } : {}),
        ...(draftId ? { draftId } : {}),
        ...(templateName ? { templateName } : {}),
        ...(templateId ? { templateId } : {}),
        ...(specs && specs.length > 0 ? { specs } : {}),
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
        metadata: {
          editor: 'cockpit',
          createdBy: 'user',
          intent: s.newFileIntent ?? 'create',
        },
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
      unsavedDraftIdRef.current = null;
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
    void refreshFilesystem();
  }, [refreshTree, refreshFilesystem]);

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
    setScope,
    refreshFilesystem,
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
