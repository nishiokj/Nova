import { useCockpit } from '@/hooks/use-cockpit-store';
import { GrepTab } from './tabs/GrepTab';
import { BrowserTab } from './tabs/BrowserTab';

export function GlobalToolsPanel() {
  const { state, set } = useCockpit();
  const active = state.globalTool === 'browser' ? 'browser' : 'grep';

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => set({ globalTool: 'grep' })}
            className={`px-2 py-1 text-[11px] rounded ${
              active === 'grep'
                ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            Grep
          </button>
          <button
            onClick={() => set({ globalTool: 'browser' })}
            className={`px-2 py-1 text-[11px] rounded ${
              active === 'browser'
                ? 'bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            Preview
          </button>
          <button
            onClick={() => set({ globalTool: 'none' })}
            className="ml-auto px-2 py-1 text-[11px] rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          >
            Back to Document
          </button>
        </div>
      </div>
      <div className={`flex-1 min-h-0 p-3 ${active === 'grep' ? 'overflow-y-auto' : ''}`}>
        {active === 'grep' ? <GrepTab /> : <BrowserTab />}
      </div>
    </div>
  );
}
