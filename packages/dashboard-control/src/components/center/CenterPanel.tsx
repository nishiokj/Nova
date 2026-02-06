import { useCockpit } from '@/hooks/use-cockpit-store';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { DocumentEditor } from './DocumentEditor';
import { SessionDetail } from './SessionDetail';
import { GlobalToolsPanel } from './GlobalToolsPanel';
import { NewFileDropdown } from './NewFileDropdown';
import { PromotePicker } from './PromotePicker';
import { EventDrawer } from './EventDrawer';
import { MessageInput } from './MessageInput';

export function CenterPanel({ workspace }: { workspace: MarkdownWorkspace }) {
  const { state } = useCockpit();

  if (state.globalTool !== 'none') {
    return (
      <div className="relative h-full flex flex-col">
        <GlobalToolsPanel />
        <EventDrawer />
        <MessageInput />
      </div>
    );
  }

  if (state.focusTarget) {
    return <SessionDetail />;
  }

  return (
    <div className="relative h-full flex flex-col">
      {workspace.state.newFileDropdownOpen && <NewFileDropdown workspace={workspace} />}
      {state.upgradePickerOpen && <PromotePicker workspace={workspace} />}
      <div className="flex-1 min-h-0">
        <DocumentEditor workspace={workspace} />
      </div>
      <EventDrawer />
      <MessageInput />
    </div>
  );
}
