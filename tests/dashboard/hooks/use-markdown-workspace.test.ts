/**
 * Tests for use-markdown-workspace hook
 * Tests file operations, reducers, and callbacks
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useMarkdownWorkspace, MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import * as api from '@/lib/api';

// Mock API functions
vi.mock('@/lib/api', () => ({
  getCockpitFilesystem: vi.fn(),
  getCockpitMarkdownFile: vi.fn(),
  getCockpitMarkdownTree: vi.fn(),
  postCockpitMarkdownDelete: vi.fn(),
  postCockpitMarkdownFile: vi.fn(),
  postCockpitMarkdownFolder: vi.fn(),
  postCockpitMarkdownPatch: vi.fn(),
}));

const mockGetCockpitFilesystem = vi.mocked(api.getCockpitFilesystem);
const mockGetCockpitMarkdownFile = vi.mocked(api.getCockpitMarkdownFile);
const mockGetCockpitMarkdownTree = vi.mocked(api.getCockpitMarkdownTree);
const mockPostCockpitMarkdownDelete = vi.mocked(api.postCockpitMarkdownDelete);
const mockPostCockpitMarkdownFile = vi.mocked(api.postCockpitMarkdownFile);
const mockPostCockpitMarkdownFolder = vi.mocked(api.postCockpitMarkdownFolder);
const mockPostCockpitMarkdownPatch = vi.mocked(api.postCockpitMarkdownPatch);

// Mock editor interface
const mockEditor = {
  focus: vi.fn(),
  blur: vi.fn(),
  selectionStart: 0,
  selectionEnd: 10,
};

describe('useMarkdownWorkspace', () => {
  let result: { current: MarkdownWorkspace };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default mock responses
    mockGetCockpitFilesystem.mockResolvedValue({
      roots: [
        { id: 'scratch', kind: 'scratch', label: 'Scratch', path: '.cockpit/scratch' },
        { id: 'project-1', kind: 'project', label: 'Project 1', path: '/path/to/project' },
      ],
    });
    mockGetCockpitMarkdownTree.mockResolvedValue({
      rootDir: '.cockpit/scratch',
      tree: [
        { type: 'folder', name: 'notes', path: 'notes', children: [
          { type: 'file', name: 'test.md', path: 'notes/test.md', children: [] },
        ]},
        { type: 'file', name: 'untitled.md', path: 'untitled.md', children: [] },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  const setupHook = () => {
    const { result: hookResult } = renderHook(() => useMarkdownWorkspace());
    result = hookResult;
    // Attach mock editor ref
    act(() => {
      result.current.editorRef.current = mockEditor as any;
    });
    return result;
  };

  describe('Initial State', () => {
    it('should initialize with correct default state', async () => {
      setupHook();

      // Wait for initial effects
      await waitFor(() => {
        expect(result.current.state.loading).toBe(false);
      });

      const { state } = result.current;
      expect(state.activeRoot).toBe('.cockpit/scratch');
      expect(state.selectedPath).toBeNull();
      expect(state.content).toBe('');
      expect(state.dirty).toBe(false);
      expect(state.version).toBe(0);
      expect(state.saving).toBe(false);
      expect(state.autoSaving).toBe(false);
    });

    it('should load roots on mount', async () => {
      setupHook();

      await waitFor(() => {
        expect(result.current.state.roots).toHaveLength(2);
      });

      const { roots } = result.current.state;
      expect(roots[0].kind).toBe('scratch');
      expect(roots[1].kind).toBe('project');
    });

    it('should load tree on mount', async () => {
      setupHook();

      await waitFor(() => {
        expect(mockGetCockpitMarkdownTree).toHaveBeenCalled();
      });
    });
  });

  describe('Tree Operations', () => {
    it('should refresh tree', async () => {
      setupHook();

      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [{ type: 'file', name: 'new.md', path: 'new.md', children: [] }],
      });

      act(() => {
        result.current.refreshTree();
      });

      await waitFor(() => {
        expect(result.current.state.tree[0].name).toBe('new.md');
      });
    });

    it('should refresh roots', async () => {
      setupHook();

      mockGetCockpitFilesystem.mockResolvedValue({
        roots: [
          { id: 'project-2', kind: 'project', label: 'Project 2', path: '/new/path' },
        ],
      });

      await act(async () => {
        await result.current.refreshRoots();
      });

      expect(result.current.state.roots).toHaveLength(1);
      expect(result.current.state.roots[0].id).toBe('project-2');
    });

    it('should apply workspace tree', () => {
      setupHook();

      const newTree = [
        { type: 'folder', name: 'docs', path: 'docs', children: [] },
      ] as any;

      act(() => {
        result.current.applyWorkspaceTree({ tree: newTree, rootDir: '.cockpit/scratch' });
      });

      expect(result.current.state.tree).toEqual(newTree);
    });
  });

  describe('File Operations', () => {
    it('should open a file', async () => {
      setupHook();

      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'notes/test.md',
        content: '# Test Content',
        version: 5,
      });

      await act(async () => {
        await result.current.openFile('notes/test.md');
      });

      const { state } = result.current;
      expect(state.selectedPath).toBe('notes/test.md');
      expect(state.content).toBe('# Test Content');
      expect(state.version).toBe(5);
      expect(state.dirty).toBe(false);
      expect(state.loading).toBe(false);
    });

    it('should handle file open error', async () => {
      setupHook();

      mockGetCockpitMarkdownFile.mockRejectedValue(new Error('File not found'));

      await act(async () => {
        await result.current.openFile('nonexistent.md');
      });

      expect(result.current.state.status).toBe('File not found');
      expect(result.current.state.loading).toBe(false);
    });

    it('should open file and focus editor', async () => {
      setupHook();

      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'test.md',
        content: 'content',
        version: 1,
      });

      await act(async () => {
        await result.current.openFile('test.md');
      });

      // Editor focus is called with setTimeout(0)
      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(mockEditor.focus).toHaveBeenCalled();
    });

    it('should open new file picker for create', () => {
      setupHook();

      act(() => {
        result.current.openNewFilePicker('create');
      });

      expect(result.current.state.newFileDropdownOpen).toBe(true);
      expect(result.current.state.newFileIntent).toBe('create');
    });

    it('should open new file picker for save with default folder', () => {
      setupHook();

      // First select a file to set context
      act(() => {
        result.current.set({ selectedPath: 'notes/test.md' });
      });

      act(() => {
        result.current.openNewFilePicker('save');
      });

      expect(result.current.state.newFileDropdownOpen).toBe(true);
      expect(result.current.state.newFileIntent).toBe('save');
      expect(result.current.state.newFileDefaultFolder).toBe('notes');
    });

    it('should close new file picker and refocus editor', () => {
      setupHook();

      act(() => {
        result.current.openNewFilePicker('create');
        result.current.closeNewFilePicker();
      });

      // Run pending timers
      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(result.current.state.newFileDropdownOpen).toBe(false);
      expect(mockEditor.focus).toHaveBeenCalled();
    });
  });

  describe('Content Management', () => {
    beforeEach(async () => {
      setupHook();

      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'test.md',
        content: '',
        version: 1,
      });

      await act(async () => {
        await result.current.openFile('test.md');
      });
    });

    it('should set content and mark dirty', () => {
      act(() => {
        result.current.setContent('# New Content');
      });

      expect(result.current.state.content).toBe('# New Content');
      expect(result.current.state.dirty).toBe(true);
    });

    it('should update files list when tree changes', () => {
      const newTree = [
        { type: 'file', name: 'file1.md', path: 'file1.md', children: [] },
        { type: 'file', name: 'file2.md', path: 'file2.md', children: [] },
      ] as any;

      act(() => {
        result.current.applyWorkspaceTree({ tree: newTree });
      });

      const files = result.current.files;
      expect(files).toHaveLength(2);
      expect(files).toContain('file1.md');
      expect(files).toContain('file2.md');
    });
  });

  describe('Save Operations', () => {
    beforeEach(async () => {
      setupHook();

      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'test.md',
        content: 'original',
        version: 1,
      });

      await act(async () => {
        await result.current.openFile('test.md');
        result.current.setContent('updated content');
      });
    });

    it('should save existing file manually', async () => {
      mockPostCockpitMarkdownPatch.mockResolvedValue({
        success: true,
        file: { path: 'test.md', content: 'updated content', version: 2 },
      });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [{ type: 'file', name: 'test.md', path: 'test.md', children: [] }],
      });

      await act(async () => {
        await result.current.save();
      });

      const { state } = result.current;
      expect(state.dirty).toBe(false);
      expect(state.version).toBe(2);
      expect(state.saving).toBe(false);
      expect(state.status).toContain('Saved');
    });

    it('should handle save conflict', async () => {
      mockPostCockpitMarkdownPatch.mockResolvedValue({
        success: false,
        currentVersion: 5,
      });

      // Mock confirm dialog
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);
      mockPostCockpitMarkdownPatch.mockResolvedValueOnce({
        success: false,
        currentVersion: 5,
      }).mockResolvedValueOnce({
        success: true,
        file: { path: 'test.md', version: 6 },
      });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [{ type: 'file', name: 'test.md', path: 'test.md', children: [] }],
      });

      await act(async () => {
        await result.current.save();
      });

      // First attempt detects conflict
      expect(window.confirm).toHaveBeenCalled();

      // After confirm, overwrite
      expect(result.current.state.version).toBe(6);

      window.confirm = originalConfirm;
    });

    it('should open file picker when no file selected for save', async () => {
      act(() => {
        result.current.set({ selectedPath: null, dirty: true });
      });

      await act(async () => {
        await result.current.save();
      });

      expect(result.current.state.newFileDropdownOpen).toBe(true);
      expect(result.current.state.newFileIntent).toBe('save');
    });

    it('should fallback to postCockpitMarkdownFile on 404', async () => {
      mockPostCockpitMarkdownPatch.mockRejectedValue({ statusCode: 404 });
      mockPostCockpitMarkdownFile.mockResolvedValue({
        success: true,
        file: { path: 'test.md', version: 2 },
      });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [{ type: 'file', name: 'test.md', path: 'test.md', children: [] }],
      });

      await act(async () => {
        await result.current.save();
      });

      expect(mockPostCockpitMarkdownFile).toHaveBeenCalled();
      expect(result.current.state.version).toBe(2);
    });
  });

  describe('Autosave', () => {
    beforeEach(async () => {
      setupHook();

      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'test.md',
        content: '',
        version: 1,
      });
      mockPostCockpitMarkdownPatch.mockResolvedValue({
        success: true,
        file: { path: 'test.md', version: 2 },
      });

      await act(async () => {
        await result.current.openFile('test.md');
      });
    });

    it('should autosave after debounce delay', async () => {
      act(() => {
        result.current.setContent('autosave test');
      });

      // Fast-forward time before debounce expires
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // Should not have saved yet
      expect(mockPostCockpitMarkdownPatch).not.toHaveBeenCalled();

      // Fast-forward past debounce
      act(() => {
        vi.advanceTimersByTime(500);
      });

      await waitFor(() => {
        expect(result.current.state.autoSaving).toBe(true);
      });

      // Wait for async save to complete
      await act(async () => {
        await waitFor(() => {
          expect(result.current.state.autoSaving).toBe(false);
        });
      });

      expect(result.current.state.dirty).toBe(false);
      expect(result.current.state.status).toContain('Autosaved');
    });

    it('should not autosave if not dirty', () => {
      act(() => {
        result.current.set({ dirty: false });
      });

      act(() => {
        vi.runAllTimers();
      });

      expect(mockPostCockpitMarkdownPatch).not.toHaveBeenCalled();
    });

    it('should not autosave if no selected path', () => {
      act(() => {
        result.current.set({ selectedPath: null, dirty: true });
      });

      act(() => {
        vi.runAllTimers();
      });

      expect(mockPostCockpitMarkdownPatch).not.toHaveBeenCalled();
    });

    it('should not autosave if conflict exists', () => {
      act(() => {
        result.current.set({ conflictVersion: 5, dirty: true });
      });

      act(() => {
        vi.runAllTimers();
      });

      expect(mockPostCockpitMarkdownPatch).not.toHaveBeenCalled();
    });

    it('should not autosave while saving', () => {
      act(() => {
        result.current.set({ saving: true, dirty: true });
      });

      act(() => {
        vi.runAllTimers();
      });

      expect(mockPostCockpitMarkdownPatch).not.toHaveBeenCalled();
    });

    it('should flush pending autosave on demand', async () => {
      act(() => {
        result.current.setContent('content to flush');
      });

      const flushed = await act(async () => {
        return await result.current.flushPendingAutosave();
      });

      await waitFor(() => {
        expect(result.current.state.dirty).toBe(false);
      });
    });
  });

  describe('Folder Operations', () => {
    beforeEach(() => {
      setupHook();
    });

    it('should create folder', async () => {
      const originalPrompt = window.prompt;
      window.prompt = vi.fn(() => 'new-folder');
      mockPostCockpitMarkdownFolder.mockResolvedValue({ success: true });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [
          { type: 'folder', name: 'new-folder', path: 'new-folder', children: [] },
        ],
      });

      await act(async () => {
        await result.current.createFolder();
      });

      expect(window.prompt).toHaveBeenCalled();
      expect(mockPostCockpitMarkdownFolder).toHaveBeenCalledWith({
        path: 'new-folder',
      });
      expect(result.current.state.status).toContain('Created folder');

      window.prompt = originalPrompt;
    });

    it('should cancel folder creation on empty prompt', async () => {
      const originalPrompt = window.prompt;
      window.prompt = vi.fn(() => null);

      await act(async () => {
        await result.current.createFolder();
      });

      expect(mockPostCockpitMarkdownFolder).not.toHaveBeenCalled();

      window.prompt = originalPrompt;
    });

    it('should toggle folder expansion', () => {
      const folderPath = 'notes';
      const tree = [
        { type: 'folder', name: 'notes', path: 'notes', children: [] },
      ] as any;

      act(() => {
        result.current.applyWorkspaceTree({ tree });
        result.current.toggleFolder(folderPath);
      });

      expect(result.current.state.expandedFolders.has(folderPath)).toBe(true);

      act(() => {
        result.current.toggleFolder(folderPath);
      });

      expect(result.current.state.expandedFolders.has(folderPath)).toBe(false);
    });
  });

  describe('Delete Operations', () => {
    beforeEach(() => {
      setupHook();
    });

    it('should delete file', async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);
      mockPostCockpitMarkdownDelete.mockResolvedValue({ success: true });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [],
      });

      // Set selected file
      act(() => {
        result.current.set({ selectedPath: 'test.md' });
      });

      const deleted = await act(async () => {
        return await result.current.deletePath('test.md', 'file');
      });

      expect(deleted).toBe(true);
      expect(result.current.state.selectedPath).toBeNull();
      expect(result.current.state.status).toContain('Deleted file');

      window.confirm = originalConfirm;
    });

    it('should delete folder recursively', async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);
      mockPostCockpitMarkdownDelete.mockResolvedValue({ success: true });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [],
      });

      const deleted = await act(async () => {
        return await result.current.deletePath('folder', 'folder', { recursive: true });
      });

      expect(deleted).toBe(true);
      expect(mockPostCockpitMarkdownDelete).toHaveBeenCalledWith({
        path: 'folder',
        type: 'folder',
        recursive: true,
      });

      window.confirm = originalConfirm;
    });

    it('should cancel delete on confirm cancel', async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => false);

      const deleted = await act(async () => {
        return await result.current.deletePath('test.md', 'file');
      });

      expect(deleted).toBe(false);
      expect(mockPostCockpitMarkdownDelete).not.toHaveBeenCalled();

      window.confirm = originalConfirm;
    });

    it('should handle delete error', async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);
      mockPostCockpitMarkdownDelete.mockResolvedValue({ success: false, error: 'Delete failed' });

      const deleted = await act(async () => {
        return await result.current.deletePath('test.md', 'file');
      });

      expect(deleted).toBe(false);
      expect(result.current.state.status).toContain('Failed');

      window.confirm = originalConfirm;
    });
  });

  describe('Root Switching', () => {
    beforeEach(() => {
      setupHook();
    });

    it('should switch to project root', async () => {
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '/path/to/project',
        tree: [{ type: 'file', name: 'project.md', path: 'project.md', children: [] }],
      });

      await act(async () => {
        await result.current.setActiveRoot('/path/to/project');
      });

      expect(result.current.state.activeRoot).toBe('/path/to/project');
      expect(result.current.state.status).toBe('/path/to/project');
    });

    it('should switch to scratch root', async () => {
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [],
      });

      await act(async () => {
        await result.current.setActiveRoot('.cockpit/scratch');
      });

      expect(result.current.state.activeRoot).toBe('.cockpit/scratch');
      expect(result.current.state.status).toBe('scratch');
    });

    it('should handle root switch error', async () => {
      mockGetCockpitMarkdownTree.mockRejectedValue(new Error('Invalid path'));

      await act(async () => {
        await result.current.setActiveRoot('/invalid/path');
      });

      expect(result.current.state.status).toContain('Could not switch');
      expect(result.current.state.loading).toBe(false);
    });
  });

  describe('File Creation in Folder', () => {
    beforeEach(() => {
      setupHook();

      const tree = [
        { type: 'file', name: 'existing.md', path: 'existing.md', children: [] },
      ] as any;

      act(() => {
        result.current.applyWorkspaceTree({ tree });
      });
    });

    it('should create new file with unique name', async () => {
      mockPostCockpitMarkdownFile.mockResolvedValue({
        success: true,
        file: { path: 'notes/new.md', version: 1 },
      });
      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'notes/new.md',
        content: '',
        version: 1,
      });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [{ type: 'file', name: 'new.md', path: 'notes/new.md', children: [] }],
      });

      await act(async () => {
        await result.current.createFileInFolder('notes', { filename: 'new.md' });
      });

      expect(result.current.state.status).toContain('Created notes/new.md');
      expect(result.current.state.newFileDropdownOpen).toBe(false);
    });

    it('should add .md extension if missing', async () => {
      mockPostCockpitMarkdownFile.mockResolvedValue({
        success: true,
        file: { path: 'test.md', version: 1 },
      });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [{ type: 'file', name: 'test.md', path: 'test.md', children: [] }],
      });
      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'test.md',
        content: '',
        version: 1,
      });

      await act(async () => {
        await result.current.createFileInFolder('', { filename: 'test' });
      });

      expect(mockPostCockpitMarkdownFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'test.md' })
      );
    });

    it('should increment filename suffix for duplicates', async () => {
      const tree = [
        { type: 'file', name: 'untitled.md', path: 'untitled.md', children: [] },
      ] as any;

      act(() => {
        result.current.applyWorkspaceTree({ tree });
      });

      mockPostCockpitMarkdownFile.mockResolvedValue({
        success: true,
        file: { path: 'untitled-2.md', version: 1 },
      });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [{ type: 'file', name: 'untitled-2.md', path: 'untitled-2.md', children: [] }],
      });
      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'untitled-2.md',
        content: '',
        version: 1,
      });

      await act(async () => {
        await result.current.createFileInFolder('', { filename: 'untitled.md' });
      });

      expect(mockPostCockpitMarkdownFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'untitled-2.md' })
      );
    });

    it('should use current content for save intent', async () => {
      act(() => {
        result.current.set({ content: '# Existing content', newFileIntent: 'save' });
      });

      mockPostCockpitMarkdownFile.mockResolvedValue({
        success: true,
        file: { path: 'saved.md', version: 1 },
      });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [{ type: 'file', name: 'saved.md', path: 'saved.md', children: [] }],
      });
      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'saved.md',
        content: '# Existing content',
        version: 1,
      });

      await act(async () => {
        await result.current.createFileInFolder('', { filename: 'saved.md' });
      });

      expect(mockPostCockpitMarkdownFile).toHaveBeenCalledWith(
        expect.objectContaining({ content: '# Existing content' })
      );
    });
  });

  describe('Context Provider', () => {
    it('should return null context when no file selected and empty content', () => {
      setupHook();

      const context = result.current.getActiveContext();
      expect(context).toBeNull();
    });

    it('should return context with selected file', async () => {
      setupHook();

      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'test.md',
        content: '# Test',
        version: 1,
      });

      await act(async () => {
        await result.current.openFile('test.md');
      });

      const context = result.current.getActiveContext();
      expect(context).toEqual({
        path: 'test.md',
        projectPath: undefined,
        version: 1,
        content: '# Test',
        isDirty: false,
        selectionStart: 0,
        selectionEnd: 10,
      });
    });

    it('should return context with project path when project root active', async () => {
      setupHook();

      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '/project',
        tree: [{ type: 'file', name: 'test.md', path: 'test.md', children: [] }],
      });
      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'test.md',
        content: '# Test',
        version: 1,
      });

      await act(async () => {
        await result.current.setActiveRoot('/project');
        await result.current.openFile('test.md');
      });

      const context = result.current.getActiveContext();
      expect(context?.projectPath).toBe('/project');
    });

    it('should return context without content when dirty only', () => {
      setupHook();

      act(() => {
        result.current.set({ content: '# New', dirty: true });
      });

      const context = result.current.getActiveContext();
      expect(context).toEqual({
        path: undefined,
        projectPath: undefined,
        version: 0,
        content: '# New',
        isDirty: true,
        selectionStart: 0,
        selectionEnd: 10,
      });
    });
  });

  describe('Set Helper', () => {
    it('should update state with set helper', () => {
      setupHook();

      act(() => {
        result.current.set({ status: 'test status', loading: true });
      });

      expect(result.current.state.status).toBe('test status');
      expect(result.current.state.loading).toBe(true);
    });
  });

  describe('Reducer Actions', () => {
    it('should handle SET action', () => {
      setupHook();

      act(() => {
        result.current.set({ status: 'test', dirty: true });
      });

      expect(result.current.state.status).toBe('test');
      expect(result.current.state.dirty).toBe(true);
    });

    it('should handle FILE_LOADED action', async () => {
      setupHook();

      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'test.md',
        content: 'content',
        version: 5,
      });

      await act(async () => {
        await result.current.openFile('test.md');
      });

      expect(result.current.state.selectedPath).toBe('test.md');
      expect(result.current.state.content).toBe('content');
      expect(result.current.state.version).toBe(5);
      expect(result.current.state.dirty).toBe(false);
    });

    it('should handle FILE_SAVED action', async () => {
      setupHook();

      mockGetCockpitMarkdownFile.mockResolvedValue({
        path: 'test.md',
        content: '',
        version: 1,
      });
      mockPostCockpitMarkdownPatch.mockResolvedValue({
        success: true,
        file: { path: 'test.md', version: 3 },
      });
      mockGetCockpitMarkdownTree.mockResolvedValue({
        rootDir: '.cockpit/scratch',
        tree: [{ type: 'file', name: 'test.md', path: 'test.md', children: [] }],
      });

      await act(async () => {
        await result.current.openFile('test.md');
        result.current.setContent('new');
        await result.current.save();
      });

      expect(result.current.state.version).toBe(3);
      expect(result.current.state.dirty).toBe(false);
    });

    it('should handle TOGGLE_FOLDER action', () => {
      setupHook();

      const tree = [
        { type: 'folder', name: 'folder', path: 'folder', children: [] },
      ] as any;

      act(() => {
        result.current.applyWorkspaceTree({ tree });
      });

      // Initial state: folders expanded (first 4 folders)
      expect(result.current.state.expandedFolders.has('folder')).toBe(true);

      act(() => {
        result.current.toggleFolder('folder');
      });

      expect(result.current.state.expandedFolders.has('folder')).toBe(false);

      act(() => {
        result.current.toggleFolder('folder');
      });

      expect(result.current.state.expandedFolders.has('folder')).toBe(true);
    });

    it('should handle SET_TREE action with initial folders expanded', () => {
      setupHook();

      const tree = [
        { type: 'folder', name: 'f1', path: 'f1', children: [] },
        { type: 'folder', name: 'f2', path: 'f2', children: [] },
      ] as any;

      act(() => {
        result.current.applyWorkspaceTree({ tree, rootDir: '.cockpit/scratch' });
      });

      // First 4 folders should be expanded by default
      expect(result.current.state.expandedFolders.has('f1')).toBe(true);
      expect(result.current.state.expandedFolders.has('f2')).toBe(true);
    });
  });

  describe('Files Memoization', () => {
    it('should memoize files list', () => {
      setupHook();

      const files1 = result.current.files;
      const files2 = result.current.files;

      expect(files1).toBe(files2);
    });

    it('should update files list when tree changes', () => {
      setupHook();

      const files1 = result.current.files;

      const newTree = [
        { type: 'file', name: 'new.md', path: 'new.md', children: [] },
      ] as any;

      act(() => {
        result.current.applyWorkspaceTree({ tree: newTree });
      });

      const files2 = result.current.files;

      expect(files2).toContain('new.md');
      // Should be a new array reference
      expect(files2).not.toBe(files1);
    });
  });
});
