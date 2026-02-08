import { useCockpit } from '@/hooks/use-cockpit-store';
import { GrepTab } from './tabs/GrepTab';
import { BrowserTab } from './tabs/BrowserTab';

export function GlobalToolsPanel() {
  const globalTool = useCockpit(s => s.globalTool);
  const active = globalTool === 'browser' ? 'browser' : 'grep';

  return (
    <div className="h-full flex flex-col">
      <div className={`flex-1 min-h-0 p-3 ${active === 'grep' ? 'overflow-y-auto' : ''}`}>
        {active === 'grep' ? <GrepTab /> : <BrowserTab />}
      </div>
    </div>
  );
}
