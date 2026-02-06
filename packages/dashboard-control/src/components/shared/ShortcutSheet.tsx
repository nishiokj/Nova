import { useCockpit } from '@/hooks/use-cockpit-store';

const SECTIONS = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: 'Alt+H', desc: 'Focus left pane (files)' },
      { keys: 'Alt+J/K', desc: 'Focus center pane' },
      { keys: 'Alt+L', desc: 'Focus right pane (sessions)' },
      { keys: 'J / K', desc: 'Navigate sessions (right pane)' },
      { keys: 'Enter', desc: 'Select highlighted session' },
      { keys: '/', desc: 'Open command palette' },
    ],
  },
  {
    title: 'Views',
    shortcuts: [
      { keys: 'M', desc: 'Document view' },
      { keys: 'G', desc: 'Grep tool' },
      { keys: 'B', desc: 'Preview' },
      { keys: '1-4', desc: 'Event filter (Msgs/All/Fail/Audit)' },
    ],
  },
  {
    title: 'Session Tabs',
    shortcuts: [
      { keys: 'X', desc: 'Packet tab' },
      { keys: 'D', desc: 'Diff tab' },
      { keys: 'T', desc: 'Tests tab' },
      { keys: 'L', desc: 'Trace tab' },
      { keys: 'P', desc: 'Permissions tab' },
      { keys: 'Tab', desc: 'Next tab' },
      { keys: 'Shift+Tab', desc: 'Previous tab' },
    ],
  },
  {
    title: 'Actions',
    shortcuts: [
      { keys: 'Ctrl+`', desc: 'Toggle chat' },
      { keys: 'Ctrl+Enter', desc: 'Send message' },
      { keys: 'Ctrl+S', desc: 'Save file' },
      { keys: 'Ctrl+N', desc: 'New file' },
      { keys: 'Ctrl+U', desc: 'Upgrade/promote picker (project/session scope)' },
      { keys: 'R', desc: 'Resolve escalation' },
      { keys: 'A', desc: 'Accept review' },
      { keys: 'C', desc: 'Request changes' },
    ],
  },
];

export function ShortcutSheet() {
  const { set } = useCockpit();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={() => set({ shortcutSheetOpen: false })}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full max-w-xl rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-subtle)]">
          <span className="text-sm text-[var(--text-primary)] font-medium">Keyboard Shortcuts</span>
          <kbd className="text-[10px] text-[var(--text-muted)] border border-[var(--border-subtle)] rounded px-1.5 py-0.5">? to close</kbd>
        </div>
        <div className="grid grid-cols-2 gap-4 p-4 max-h-[60vh] overflow-y-auto">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="text-[10px] uppercase tracking-wide text-[var(--accent-cyan)] mb-2">{section.title}</div>
              <div className="space-y-1">
                {section.shortcuts.map((shortcut) => (
                  <div key={`${shortcut.keys}-${shortcut.desc}`} className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[var(--text-secondary)]">{shortcut.desc}</span>
                    <kbd className="text-[10px] text-[var(--text-muted)] border border-[var(--border-subtle)] rounded px-1.5 py-0.5 font-mono whitespace-nowrap shrink-0">{shortcut.keys}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
