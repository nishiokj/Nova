import { useCockpit } from '@/hooks/use-cockpit-store';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { DocumentEditor } from './DocumentEditor';
import { SessionDetail } from './SessionDetail';
import { GlobalToolsPanel } from './GlobalToolsPanel';
import { NewFileDropdown } from './NewFileDropdown';
import { PromotePicker } from './PromotePicker';
import { ResizeHandle } from '@/components/shared/ResizeHandle';
import { EventDrawer } from './EventDrawer';
import { MessageInput } from './MessageInput';

export function CenterPanel({ workspace }: { workspace: MarkdownWorkspace }) {
  const { state, set } = useCockpit();
  const { eventDrawerHeight, globalTool, focusTarget } = state;

  const setEventDrawerHeight = (height: number) => set({ eventDrawerHeight: Math.max(80, Math.min(600, height)) });
  const docActive = globalTool === 'none' && !focusTarget;

  if (state.globalTool !== 'none') {
    return (
      <div className="relative h-full flex flex-col">
        <GlobalToolsPanel />
        <ResizeHandle direction="vertical" onResize={(delta) => setEventDrawerHeight(eventDrawerHeight - delta)} aria-label="Resize chat panel" />
        <EventDrawer />
        <MessageInput />
      </div>
    );
  }

  const toolStrip = (
    <div className="px-2 py-1 border-b border-[var(--border-subtle)] text-[11px] flex items-center gap-1">
      <button
        onClick={() => set({ globalTool: 'none', focusTarget: null })}
        className={`px-2 py-0.5 rounded ${
          docActive
            ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
            : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
        }`}
      >
        Doc
      </button>
      <button
        onClick={() => set({ globalTool: 'grep' })}
        className="px-2 py-0.5 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
      >
        Grep
      </button>
      <button
        onClick={() => set({ globalTool: 'browser' })}
        className="px-2 py-0.5 rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
      >
        Preview
      </button>
    </div>
  );

  if (state.focusTarget) {
    return (
      <div className="h-full flex flex-col">
        {toolStrip}
        <div className="flex-1 min-h-0">
          <SessionDetail />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col">
      {workspace.state.newFileDropdownOpen && <NewFileDropdown workspace={workspace} />}
      {state.upgradePickerOpen && <PromotePicker workspace={workspace} />}
      {toolStrip}
      <div className="flex-1 min-h-0">
        <DocumentEditor workspace={workspace} />
      </div>
      <ResizeHandle direction="vertical" onResize={(delta) => setEventDrawerHeight(eventDrawerHeight - delta)} aria-label="Resize chat panel" />
      <EventDrawer />
      <MessageInput />
    </div>
  );
}
