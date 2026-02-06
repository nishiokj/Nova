import { useEffect, useState } from 'react';
import { useCockpit } from '@/hooks/use-cockpit-store';

export function StatusBar() {
  const { state, set } = useCockpit();
  const [visible, setVisible] = useState(false);
  const [displayedError, setDisplayedError] = useState<string | null>(null);

  useEffect(() => {
    if (state.error) {
      setDisplayedError(state.error);
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(() => set({ error: null }), 300);
      }, 8000);
      return () => clearTimeout(timer);
    } else {
      setVisible(false);
    }
  }, [state.error, set]);

  if (!displayedError) return null;

  return (
    <div className={`fixed bottom-4 right-4 z-40 max-w-sm transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}>
      <div className="rounded-lg border border-[var(--error)]/40 bg-[var(--bg-surface)] shadow-lg px-4 py-3 flex items-start gap-3">
        <span className="text-[var(--error)] text-sm shrink-0 mt-0.5">!</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-[var(--text-primary)] font-medium mb-0.5">Error</div>
          <div className="text-[11px] text-[var(--text-secondary)] break-words">{displayedError}</div>
        </div>
        <button
          onClick={() => { setVisible(false); setTimeout(() => set({ error: null }), 300); }}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs shrink-0"
        >
          ×
        </button>
      </div>
    </div>
  );
}
