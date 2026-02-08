/**
 * Tests for FileExplorer component
 * Tests tree navigation and user interactions
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { FileExplorer } from './FileExplorer';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import * as api from '@/lib/api';
import { CockpitStoreContext } from '@/hooks/use-cockpit-store';

// Need React for JSX in wrapper
const React = { createElement };

// Mock API functions
vi.mock('@/lib/api', () => ({
  postCockpitSessionCreate: vi.fn(),
}));

const mockPostCockpitSessionCreate = vi.mocked(api.postCockpitSessionCreate);

// Mock useCockpitStore hook
const mockStore = {
  set: vi.fn(),
  refreshRollups: vi.fn(),
  refreshTemplates: vi.fn(),
  clearFocus: vi.fn(),
  handleSendMessage: vi.fn(),
  refreshFocus: vi.fn(),
  refreshFocusEvents: vi.fn(),
  refreshAll: vi.fn(),
  handleSelectDiffFile: vi.fn(),
  handleApplyPatch: vi.fn(),
  handleResolveEscalation: vi.fn(),
  handleReviewDecision: vi.fn(),
  handleRefreshSessionPermissions: vi.fn(),
  handleUpdateSessionPermissions: vi.fn(),
  handleRunGrepSearch: vi.fn(),
  handleSlashCommand: vi.fn(),
  handleSelectTestReport: vi.fn(),
  handleSelectCommit: vi.fn(),
  handleSelectPR: vi.fn(),
  resolvePacketRef: vi.fn(),
  handlePacketRefClick: vi.fn(),
  handlePacketLinkClick: vi.fn(),
  injectStreamChunk: vi.fn(),
  clearStreaming: vi.fn(),
  handleOpenUpgradePicker: vi.fn(),
  registerMarkdownContextProvider: vi.fn(() => () => {}),
  registerMarkdownSetContent: vi.fn(() => () => {}),
  registerBeforeSendMessageHook: vi.fn(() => () => {}),
  getSnapshot: () => ({
    runningSessions: [],
    readySessions: [],
    doneSessions: [],
    escalations: [],
    commitRollups: [],
    prRollups: [],
    metrics: null,
    focusTarget: null,
    focusData: null,
    focusTab: 'packet',
    globalTool: 'none',
    events: [],
    sessionPackets: [],
    selectedPacketId: null,
    diffData: null,
    selectedDiffFile: null,
    highlightedDiffIdx: null,
    diffPatchFile: null,
    diffPatchLoadingFile: null,
    diffPatchError: null,
    testReports: [],
    selectedTestReportId: null,
    selectedTestReport: null,
    traces: [],
    sessionPermissions: null,
    lensResults: { defs: [], refs: [], text: [] },
    lensQuery: '',
    sessionFilterQuery: '',
    eventFilter: 'messages',
    eventDrawerOpen: false,
    eventDrawerHeight: 160,
    loading: true,
    error: null,
    commandStatus: null,
    lastUpdate: new Date(),
    browserSessionScope: '',
    browserUrlDraft: '',
    patchDraft: '',
    patchApplyStatus: null,
    applyingPatch: false,
    messageDraft: '',
    sendingMessage: false,
    inputVisible: true,
    resolvingEscalationId: null,
    reviewDecisionAction: null,
    permissionsSaving: false,
    permissionsSaveStatus: null,
    lensLoading: false,
    pendingCommitRange: null,
    templates: [],
    documentSessionKey: null,
    upgradePickerOpen: false,
    streamingText: '',
    highlightedSessionIdx: null,
    commandPaletteOpen: false,
    commandPaletteQuery: '',
    shortcutSheetOpen: false,
    autocompleteEnabled: false,
  }),
  subscribe: vi.fn(() => () => {}),
};

vi.mock('@/hooks/use-cockpit-store', () => ({
  useCockpit: vi.fn((selector) => selector(mockStore.getSnapshot())),
  useCockpitStore: () => mockStore,
  CockpitStoreContext: CockpitStoreContext,
}));

// Mock workspace
const createMockWorkspace = (): MarkdownWorkspace => ({
  state: {
    activeRoot: '.cockpit/scratch',
    roots: [
      { id: 'scratch', kind: 'scratch', label: 'Scratch', path: '.cockpit/scratch' },
      { id: 'project-1', kind: 'project', label: 'Project 1', path: '/path/to/project' },
    ],
    tree: [
      {
        type: 'folder',
        name: 'notes',
        path: 'notes',
        children: [
          { type: 'file', name: 'test.md', path: 'notes/test.md', children: [] },
          { type: 'file', name: 'other.md', path: 'notes/other.md', children: [] },
        ],
      },
      { type: 'file', name: 'root.md', path: 'root.md', children: [] },
    ],
    selectedPath: null,
    content: '',
    version: 0,
    dirty: false,
    expandedFolders: new Set(['notes']),
    saving: false,
    autoSaving: false,
    loading: false,
    status: null,
    newFileDropdownOpen: false,
    newFileIntent: null,
    newFileDefaultFolder: null,
    conflictVersion: null,
  },
  files: ['notes/test.md', 'notes/other.md', 'root.md'],
  editorRef: { current: null },
  set: vi.fn(),
  setActiveRoot: vi.fn(),
  refreshRoots: vi.fn(),
  refreshTree: vi.fn(),
  openFile: vi.fn(),
  save: vi.fn(),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  deletePath: vi.fn(),
  toggleFolder: vi.fn(),
  setContent: vi.fn(),
  openNewFilePicker: vi.fn(),
  closeNewFilePicker: vi.fn(),
  getActiveContext: vi.fn(),
  flushPendingAutosave: vi.fn(),
  createFileInFolder: vi.fn(),
});

describe('FileExplorer', () => {
  let mockWorkspace: MarkdownWorkspace;
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspace = createMockWorkspace();
    user = userEvent.setup({ delay: null });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  const renderFileExplorer = () => {
    return render(
      <CockpitStoreContext.Provider value={mockStore}>
        <FileExplorer workspace={mockWorkspace} />
      </CockpitStoreContext.Provider>
    );
  };

  describe('Rendering', () => {
    it('should render file tree', () => {
      renderFileExplorer();

      expect(screen.getByText('notes')).toBeInTheDocument();
      expect(screen.getByText('root.md')).toBeInTheDocument();
    });

    it('should render files in expanded folder', () => {
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      expect(screen.getByText('test.md')).toBeInTheDocument();
      expect(screen.getByText('other.md')).toBeInTheDocument();
    });

    it('should not render files in collapsed folder', () => {
      mockWorkspace.state.expandedFolders.delete('notes');
      renderFileExplorer();

      expect(screen.queryByText('test.md')).not.toBeInTheDocument();
      expect(screen.queryByText('other.md')).not.toBeInTheDocument();
    });

    it('should render root selector', () => {
      renderFileExplorer();

      const selector = screen.getByRole('combobox');
      expect(selector).toBeInTheDocument();
    });

    it('should display root options', async () => {
      renderFileExplorer();

      const selector = screen.getByRole('combobox');
      await user.click(selector);

      expect(screen.getByText('Scratch')).toBeInTheDocument();
      expect(screen.getByText('Project 1')).toBeInTheDocument();
      expect(screen.getByText('+ Add project path…')).toBeInTheDocument();
    });

    it('should render action buttons', () => {
      renderFileExplorer();

      expect(screen.getByText('+ File')).toBeInTheDocument();
      expect(screen.getByText('+ Folder')).toBeInTheDocument();
      expect(screen.getByText('+ Session')).toBeInTheDocument();
    });

    it('should render expand/collapse buttons', () => {
      renderFileExplorer();

      const expandButtons = screen.getAllByText('▾'); // or similar
      expect(expandButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('should render empty state when no files', () => {
      mockWorkspace.state.tree = [];
      renderFileExplorer();

      expect(screen.getByText(/No markdown files/)).toBeInTheDocument();
    });

    it('should render workflows section when templates exist', () => {
      mockStore.getSnapshot = vi.fn(() => ({ ...mockStore.getSnapshot(), templates: [
        { id: 'template-1', name: 'Test Template', description: 'A test template', specs: [] },
      ]}));

      renderFileExplorer();

      expect(screen.getByText('Workflows')).toBeInTheDocument();
    });

    it('should not render workflows section when no templates', () => {
      mockStore.getSnapshot = vi.fn(() => ({ ...mockStore.getSnapshot(), templates: [] }));

      renderFileExplorer();

      expect(screen.queryByText('Workflows')).not.toBeInTheDocument();
    });
  });

  describe('File Selection', () => {
    it('should open file on click', async () => {
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const fileButton = screen.getByText('test.md');
      await user.click(fileButton);

      expect(mockWorkspace.openFile).toHaveBeenCalledWith('notes/test.md');
      expect(mockStore.set).toHaveBeenCalledWith({
        focusTarget: null,
        globalTool: 'none',
      });
    });

    it('should highlight selected file', () => {
      mockWorkspace.state.selectedPath = 'notes/test.md';
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const fileButton = screen.getByText('test.md');
      expect(fileButton.closest('button')).toHaveClass(
        'bg-\\[var\\(--accent-cyan\\)\\]/15',
        'border-l-\\[var\\(--accent-cyan\\)\\]'
      );
    });

    it('should not highlight unselected files', () => {
      mockWorkspace.state.selectedPath = 'other.md';
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const fileButton = screen.getByText('test.md');
      expect(fileButton.closest('button')).toHaveClass('border-l-transparent');
    });
  });

  describe('Folder Toggle', () => {
    it('should toggle folder on click', async () => {
      mockWorkspace.state.expandedFolders.delete('notes');
      renderFileExplorer();

      const folderButton = screen.getByText('notes');
      await user.click(folderButton);

      expect(mockWorkspace.toggleFolder).toHaveBeenCalledWith('notes');
    });

    it('should show expanded icon when folder is expanded', () => {
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const folderButton = screen.getByText('notes');
      expect(folderButton.textContent).toContain('▾'); // Down arrow
    });

    it('should show collapsed icon when folder is collapsed', () => {
      mockWorkspace.state.expandedFolders.delete('notes');
      renderFileExplorer();

      const folderButton = screen.getByText('notes');
      expect(folderButton.textContent).toContain('▸'); // Right arrow
    });
  });

  describe('Root Switching', () => {
    it('should switch root on selection', async () => {
      renderFileExplorer();

      const selector = screen.getByRole('combobox');
      await user.click(selector);
      await user.click(screen.getByText('Project 1'));

      expect(mockWorkspace.setActiveRoot).toHaveBeenCalledWith('/path/to/project');
    });

    it('should prompt for custom project path', async () => {
      const originalPrompt = window.prompt;
      window.prompt = vi.fn(() => '/custom/path');
      mockWorkspace.setActiveRoot = vi.fn();

      renderFileExplorer();

      const selector = screen.getByRole('combobox');
      await user.click(selector);
      await user.click(screen.getByText('+ Add project path…'));

      expect(window.prompt).toHaveBeenCalled();
      expect(mockWorkspace.setActiveRoot).toHaveBeenCalledWith('/custom/path');

      window.prompt = originalPrompt;
    });

    it('should not switch root on empty prompt', async () => {
      const originalPrompt = window.prompt;
      window.prompt = vi.fn(() => null);

      renderFileExplorer();

      const selector = screen.getByRole('combobox');
      await user.click(selector);
      await user.click(screen.getByText('+ Add project path…'));

      expect(mockWorkspace.setActiveRoot).not.toHaveBeenCalled();

      window.prompt = originalPrompt;
    });
  });

  describe('Action Buttons', () => {
    it('should open new file picker', async () => {
      renderFileExplorer();

      const newFileButton = screen.getByText('+ File');
      await user.click(newFileButton);

      expect(mockWorkspace.openNewFilePicker).toHaveBeenCalledWith('create');
    });

    it('should create folder', async () => {
      const originalPrompt = window.prompt;
      window.prompt = vi.fn(() => 'new-folder');
      mockWorkspace.createFolder = vi.fn();

      renderFileExplorer();

      const newFolderButton = screen.getByText('+ Folder');
      await user.click(newFolderButton);

      expect(window.prompt).toHaveBeenCalled();
      expect(mockWorkspace.createFolder).toHaveBeenCalled();

      window.prompt = originalPrompt;
    });

    it('should open new session dialog', async () => {
      renderFileExplorer();

      const newSessionButton = screen.getByText('+ Session');
      await user.click(newSessionButton);

      expect(screen.getByText('Create Session')).toBeInTheDocument();
    });

    it('should expand all folders', async () => {
      renderFileExplorer();

      const expandButton = screen.getByTitle('Expand All');
      await user.click(expandButton);

      expect(mockWorkspace.set).toHaveBeenCalledWith(
        expect.objectContaining({
          expandedFolders: expect.any(Set),
        })
      );
    });

    it('should collapse all folders', async () => {
      renderFileExplorer();

      const collapseButton = screen.getByTitle('Collapse All');
      await user.click(collapseButton);

      expect(mockWorkspace.set).toHaveBeenCalledWith(
        expect.objectContaining({
          expandedFolders: expect.any(Set),
        })
      );
    });
  });

  describe('Context Menu', () => {
    it('should show context menu on right-click', async () => {
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const fileButton = screen.getByText('test.md');
      await user.pointer({
        target: fileButton,
        keys: '[MouseRight]',
      });

      expect(screen.getByText('New File')).toBeInTheDocument();
      expect(screen.getByText('New Folder')).toBeInTheDocument();
      expect(screen.getByText('Delete File')).toBeInTheDocument();
    });

    it('should show toggle option for folders', async () => {
      renderFileExplorer();

      const folderButton = screen.getByText('notes');
      await user.pointer({
        target: folderButton,
        keys: '[MouseRight]',
      });

      expect(screen.getByText(/Collapse Folder/)).toBeInTheDocument();
    });

    it('should close context menu on click outside', async () => {
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const fileButton = screen.getByText('test.md');
      await user.pointer({
        target: fileButton,
        keys: '[MouseRight]',
      });

      expect(screen.getByText('New File')).toBeInTheDocument();

      // Click outside
      await user.click(document.body);

      expect(screen.queryByText('New File')).not.toBeInTheDocument();
    });

    it('should handle New File from context menu', async () => {
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const fileButton = screen.getByText('test.md');
      await user.pointer({
        target: fileButton,
        keys: '[MouseRight]',
      });

      const newFileOption = screen.getByText('New File');
      await user.click(newFileOption);

      expect(mockWorkspace.openNewFilePicker).toHaveBeenCalledWith('create', 'notes');
    });

    it('should handle New Folder from context menu', async () => {
      renderFileExplorer();

      await user.pointer({
        target: screen.getByText('notes'),
        keys: '[MouseRight]',
      });

      const newFolderOption = screen.getByText('New Folder');
      await user.click(newFolderOption);

      expect(mockWorkspace.createFolder).toHaveBeenCalled();
    });

    it('should handle delete with confirmation', async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => true);
      mockWorkspace.deletePath = vi.fn().mockResolvedValue(true);
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const fileButton = screen.getByText('test.md');
      await user.pointer({
        target: fileButton,
        keys: '[MouseRight]',
      });

      const deleteOption = screen.getByText('Delete File');
      await user.click(deleteOption);

      expect(window.confirm).toHaveBeenCalled();
      expect(mockWorkspace.deletePath).toHaveBeenCalledWith('notes/test.md', 'file');

      window.confirm = originalConfirm;
    });

    it('should cancel delete on confirmation cancel', async () => {
      const originalConfirm = window.confirm;
      window.confirm = vi.fn(() => false);

      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const fileButton = screen.getByText('test.md');
      await user.pointer({
        target: fileButton,
        keys: '[MouseRight]',
      });

      const deleteOption = screen.getByText('Delete File');
      await user.click(deleteOption);

      expect(mockWorkspace.deletePath).not.toHaveBeenCalled();

      window.confirm = originalConfirm;
    });
  });

  describe('New Session Dialog', () => {
    beforeEach(() => {
      mockPostCockpitSessionCreate.mockResolvedValue({
        success: true,
        sessionKey: 'session-new',
      });
      mockStore.refreshRollups = vi.fn();
    });

    it('should open new session dialog', async () => {
      renderFileExplorer();

      const newSessionButton = screen.getByText('+ Session');
      await user.click(newSessionButton);

      expect(screen.getByText('Create Session')).toBeInTheDocument();
      expect(screen.getByDisplayValue('New session')).toBeInTheDocument();
    });

    it('should create session with default project', async () => {
      renderFileExplorer();

      const newSessionButton = screen.getByText('+ Session');
      await user.click(newSessionButton);

      const createButton = screen.getByText('Create Session').parentElement?.querySelector('button:last-child');
      if (createButton) {
        await user.click(createButton);
      }

      await waitFor(() => {
        expect(mockPostCockpitSessionCreate).toHaveBeenCalledWith({
          goal: 'New session',
          projectPath: '/path/to/project',
          createProjectPath: true,
        });
      });
    });

    it('should create session with custom goal', async () => {
      renderFileExplorer();

      const newSessionButton = screen.getByText('+ Session');
      await user.click(newSessionButton);

      const goalInput = screen.getByPlaceholderText('New session');
      await user.clear(goalInput);
      await user.type(goalInput, 'Custom goal');

      const createButton = screen.getByText('Create Session').parentElement?.querySelector('button:last-child');
      if (createButton) {
        await user.click(createButton);
      }

      await waitFor(() => {
        expect(mockPostCockpitSessionCreate).toHaveBeenCalledWith({
          goal: 'Custom goal',
          projectPath: '/path/to/project',
          createProjectPath: true,
        });
      });
    });

    it('should close dialog on cancel', async () => {
      renderFileExplorer();

      const newSessionButton = screen.getByText('+ Session');
      await user.click(newSessionButton);

      const cancelButton = screen.getByText('Cancel');
      await user.click(cancelButton);

      expect(screen.queryByText('Create Session')).not.toBeInTheDocument();
    });

    it('should handle session creation failure', async () => {
      mockPostCockpitSessionCreate.mockResolvedValue({
        success: false,
        error: 'Failed to create session',
      });

      renderFileExplorer();

      const newSessionButton = screen.getByText('+ Session');
      await user.click(newSessionButton);

      const createButton = screen.getByText('Create Session').parentElement?.querySelector('button:last-child');
      if (createButton) {
        await user.click(createButton);
      }

      await waitFor(() => {
        expect(mockStore.set).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'Failed to create session',
          })
        );
      });
    });
  });

  describe('Template Selection', () => {
    beforeEach(() => {
      mockStore.getSnapshot = () => ({
        ...mockStore.getSnapshot(),
        templates: [
          {
            id: 'template-1',
            name: 'Feature Template',
            description: 'Create a new feature',
            specs: [
              { id: 'spec-1', objective: 'Plan the feature', agent: 'planner', dependencies: [] },
            ],
          },
        ],
      });
    });

    it('should render template item', () => {
      renderFileExplorer();

      expect(screen.getByText('Feature Template')).toBeInTheDocument();
      expect(screen.getByText(/Create a new feature/)).toBeInTheDocument();
    });

    it('should show template steps count', () => {
      renderFileExplorer();

      expect(screen.getByText('1 steps')).toBeInTheDocument();
    });

    it('should handle template selection', async () => {
      renderFileExplorer();

      // Expand workflows
      const workflowsHeader = screen.getByText('Workflows (1)');
      await user.click(workflowsHeader);

      const templateButton = screen.getByText('Feature Template');
      await user.click(templateButton);

      expect(mockWorkspace.set).toHaveBeenCalled();
      expect(mockWorkspace.openNewFilePicker).toHaveBeenCalledWith('save');
    });
  });

  describe('Keyboard Navigation', () => {
    it('should navigate with arrow down', async () => {
      renderFileExplorer();

      const leftPane = document.querySelector('[data-cockpit-pane="left"]');
      if (leftPane) {
        leftPane.focus();
      }

      const actionButton = screen.getByText('+ File');
      await user.click(actionButton);
      await user.keyboard('{ArrowDown}');

      // Should navigate to next action button or tree node
      // Implementation details depend on focus behavior
    });

    it('should trigger action button with Enter', async () => {
      renderFileExplorer();

      const actionButton = screen.getByText('+ File');
      actionButton.focus();
      await user.keyboard('{Enter}');

      expect(mockWorkspace.openNewFilePicker).toHaveBeenCalled();
    });

    it('should close menu on Escape', async () => {
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      const fileButton = screen.getByText('test.md');
      await user.pointer({
        target: fileButton,
        keys: '[MouseRight]',
      });

      expect(screen.getByText('New File')).toBeInTheDocument();

      await user.keyboard('{Escape}');

      expect(screen.queryByText('New File')).not.toBeInTheDocument();
    });
  });

  describe('Workspace Integration', () => {
    it('should sync with workspace state', () => {
      mockWorkspace.state.selectedPath = 'notes/test.md';
      mockWorkspace.state.expandedFolders.add('notes');
      renderFileExplorer();

      expect(screen.getByText('test.md')).toBeInTheDocument();
      expect(screen.getByText('test.md').closest('button')).toHaveClass(
        'bg-\\[var\\(--accent-cyan\\)\\]/15'
      );
    });

    it('should update when workspace changes', () => {
      const { rerender } = render(<FileExplorer workspace={mockWorkspace} />);

      mockWorkspace.state.tree = [
        { type: 'file', name: 'new.md', path: 'new.md', children: [] },
      ];

      rerender(<FileExplorer workspace={mockWorkspace} />);

      expect(screen.getByText('new.md')).toBeInTheDocument();
      expect(screen.queryByText('test.md')).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should provide proper button labels', () => {
      renderFileExplorer();

      const newFileButton = screen.getByText('+ File');
      expect(newFileButton).toHaveAccessibleName(/\+ File/);

      const newFolderButton = screen.getByText('+ Folder');
      expect(newFolderButton).toHaveAccessibleName(/\+ Folder/);
    });

    it('should provide keyboard access to actions', async () => {
      renderFileExplorer();

      // Tab to action buttons
      await user.tab();

      // Should focus on first action button
      const focused = document.activeElement as HTMLElement;
      expect(focused.textContent).toContain('+ File');
    });
  });

  describe('Global Actions Registration', () => {
    it('should register actions on window', () => {
      renderFileExplorer();

      expect((window as any).__cockpitFileExplorerActions).toBeDefined();
    });

    it('should clean up actions on unmount', () => {
      const { unmount } = renderFileExplorer();

      unmount();

      expect((window as any).__cockpitFileExplorerActions).toBeUndefined();
    });

    it('should trigger new file via registered action', () => {
      renderFileExplorer();

      (window as any).__cockpitFileExplorerActions.triggerNewFile();

      expect(mockWorkspace.openNewFilePicker).toHaveBeenCalledWith('create');
    });

    it('should trigger new folder via registered action', () => {
      renderFileExplorer();

      (window as any).__cockpitFileExplorerActions.triggerNewFolder();

      expect(mockWorkspace.createFolder).toHaveBeenCalled();
    });

    it('should trigger new session via registered action', () => {
      renderFileExplorer();

      (window as any).__cockpitFileExplorerActions.triggerNewSession();

      expect(screen.getByText('Create Session')).toBeInTheDocument();
    });
  });

  describe('Empty State', () => {
    it('should show helpful message when tree is empty', () => {
      mockWorkspace.state.tree = [];
      renderFileExplorer();

      expect(screen.getByText(/No markdown files/)).toBeInTheDocument();
      expect(screen.getByText(/Right-click or press Ctrl+N/)).toBeInTheDocument();
    });

    it('should still render action buttons when tree is empty', () => {
      mockWorkspace.state.tree = [];
      renderFileExplorer();

      expect(screen.getByText('+ File')).toBeInTheDocument();
      expect(screen.getByText('+ Folder')).toBeInTheDocument();
      expect(screen.getByText('+ Session')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle file with special characters in name', () => {
      mockWorkspace.state.tree = [
        { type: 'file', name: 'test file [1].md', path: 'test file [1].md', children: [] },
      ];

      renderFileExplorer();

      expect(screen.getByText('test file [1].md')).toBeInTheDocument();
    });

    it('should handle very long file names', () => {
      const longName = 'a'.repeat(100) + '.md';
      mockWorkspace.state.tree = [
        { type: 'file', name: longName, path: longName, children: [] },
      ];

      renderFileExplorer();

      expect(screen.getByText(longName)).toBeInTheDocument();
    });

    it('should handle nested folder structure', () => {
      mockWorkspace.state.tree = [
        {
          type: 'folder',
          name: 'a',
          path: 'a',
          children: [
            {
              type: 'folder',
              name: 'b',
              path: 'a/b',
              children: [
                { type: 'file', name: 'c.md', path: 'a/b/c.md', children: [] },
              ],
            },
          ],
        },
      ];

      mockWorkspace.state.expandedFolders = new Set(['a', 'a/b']);
      renderFileExplorer();

      expect(screen.getByText('a')).toBeInTheDocument();
      expect(screen.getByText('b')).toBeInTheDocument();
      expect(screen.getByText('c.md')).toBeInTheDocument();
    });

    it('should handle mixed file and folder nodes', () => {
      mockWorkspace.state.tree = [
        { type: 'file', name: 'file1.md', path: 'file1.md', children: [] },
        {
          type: 'folder',
          name: 'folder',
          path: 'folder',
          children: [
            { type: 'file', name: 'file2.md', path: 'folder/file2.md', children: [] },
          ],
        },
        { type: 'file', name: 'file3.md', path: 'file3.md', children: [] },
      ];

      renderFileExplorer();

      expect(screen.getByText('file1.md')).toBeInTheDocument();
      expect(screen.getByText('file3.md')).toBeInTheDocument();
    });
  });
});
