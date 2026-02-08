import { useEffect, useMemo, useRef } from 'react';
import { useCockpit, useCockpitStore, selectRecentAssistantMessage } from '@/hooks/use-cockpit-store';
import type { MarkdownWorkspace } from '@/hooks/use-markdown-workspace';
import { DocumentEditor } from './DocumentEditor';
import { SessionDetail } from './SessionDetail';
import { GrepTab } from './tabs/GrepTab';
import { BrowserTab } from './tabs/BrowserTab';
import { NewFileDropdown } from './NewFileDropdown';
import { PromotePicker } from './PromotePicker';
import { ResizeHandle } from '@/components/shared/ResizeHandle';
import { EventDrawer } from './EventDrawer';
import { MessageInput } from './MessageInput';

const LOCALHOST_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)[^\s)"']*/;

export function CenterPanel({ workspace }: { workspace: MarkdownWorkspace }) {
  const eventDrawerHeight = useCockpit(s => s.eventDrawerHeight);
  const globalTool = useCockpit(s => s.globalTool);
  const focusTarget = useCockpit(s => s.focusTarget);
  const events = useCockpit(s => s.events);
  const upgradePickerOpen = useCockpit(s => s.upgradePickerOpen);
  const store = useCockpitStore();

  const setEventDrawerHeight = (height: number) => store.set({ eventDrawerHeight: Math.max(80, Math.min(600, height)) });

  // Auto-detect localhost URLs in assistant messages and launch browser preview
  const recentMessage = useMemo(() => selectRecentAssistantMessage(store.getSnapshot()), [events]);
  const lastAutoLaunchedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!recentMessage || globalTool === 'browser') return;
    const match = recentMessage.match(LOCALHOST_URL_RE);
    if (match && match[0] !== lastAutoLaunchedUrlRef.current) {
      lastAutoLaunchedUrlRef.current = match[0];
      store.set({ globalTool: 'browser', browserUrlDraft: match[0] });
    }
  }, [recentMessage, globalTool, store]);

  // Overlays that render regardless of view
  const overlays = (
    <>
      {workspace.state.newFileDropdownOpen && <NewFileDropdown workspace={workspace} />}
      {upgradePickerOpen && <PromotePicker workspace={workspace} />}
    </>
  );

  if (globalTool !== 'none') {
    return (
      <div className="relative h-full flex flex-col">
        {overlays}
        <div className={`flex-1 min-h-0 p-3 ${globalTool === 'grep' ? 'overflow-y-auto' : ''}`}>
          {globalTool === 'grep' ? <GrepTab /> : <BrowserTab />}
        </div>
        <ResizeHandle direction="vertical" onResize={(delta) => setEventDrawerHeight(eventDrawerHeight - delta)} aria-label="Resize chat panel" />
        <EventDrawer />
        <MessageInput fileSuggestions={workspace.files} />
      </div>
    );
  }

  if (focusTarget) {
    return (
      <div className="relative h-full flex flex-col">
        {overlays}
        <div className="flex-1 min-h-0">
          <SessionDetail mentionFiles={workspace.files} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full flex flex-col" style={{ backgroundColor: 'var(--bg-editor)' }}>
      {overlays}
      <div className="flex-1 min-h-0">
        <DocumentEditor workspace={workspace} />
      </div>
      <ResizeHandle direction="vertical" onResize={(delta) => setEventDrawerHeight(eventDrawerHeight - delta)} aria-label="Resize chat panel" />
      <EventDrawer />
      <MessageInput fileSuggestions={workspace.files} />
    </div>
  );
}
