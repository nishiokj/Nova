import { useCallback, useEffect, useRef, useState } from 'react';
import { useCockpit } from '@/hooks/use-cockpit-store';
import { getCockpitBrowserState, getCockpitPreview, type CockpitFilesystemRoot } from '@/lib/api';

export function BrowserTab() {
  const { state, set } = useCockpit();
  const {
    focusData, browserUrlDraft, browserSessionScope,
    runningSessions, readySessions, doneSessions,
  } = state;

  const sessionKey = browserSessionScope || focusData?.sessionKey || '';
  const sessionOptions = [...runningSessions, ...readySessions, ...doneSessions];

  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cwd, setCwd] = useState<string | null>(null);
  const [filesystemRoots, setFilesystemRoots] = useState<CockpitFilesystemRoot[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Auto-fetch preview URL when session changes
  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;
    Promise.all([
      getCockpitPreview({ sessionKey }),
      getCockpitBrowserState(sessionKey),
    ]).then(([preview, browserState]) => {
      if (cancelled) return;
      if (preview?.url) {
        set({ browserUrlDraft: preview.url });
        setIframeUrl(preview.url);
        setError(null);
      }
      setCwd(browserState?.cwd ?? null);
      setFilesystemRoots(browserState?.filesystemRoots ?? []);
    });
    return () => { cancelled = true; };
  }, [sessionKey, set]);

  const handleNavigate = useCallback(() => {
    const url = browserUrlDraft.trim();
    if (!url) return;
    setLoading(true);
    setError(null);
    setIframeUrl(url);
  }, [browserUrlDraft]);

  const handleIframeLoad = useCallback(() => {
    setLoading(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setLoading(false);
    setError('Failed to load preview. The dev server may not be running.');
  }, []);

  const handleRefresh = useCallback(() => {
    if (!iframeRef.current || !iframeUrl) return;
    setLoading(true);
    // Force reload by briefly clearing src
    const url = iframeUrl;
    iframeRef.current.src = '';
    requestAnimationFrame(() => {
      if (iframeRef.current) iframeRef.current.src = url;
    });
  }, [iframeUrl]);

  return (
    <div className="h-full flex flex-col gap-2">
      {/* Session + URL bar */}
      <div className="shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={sessionKey}
            onChange={(e) => set({ browserSessionScope: e.target.value })}
            className="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] text-[var(--text-secondary)]"
          >
            <option value="">Select session...</option>
            {sessionOptions.map((row) => (
              <option key={row.sessionKey} value={row.sessionKey}>{row.sessionKey}</option>
            ))}
          </select>
        </div>
        {cwd && (
          <div className="text-[10px] text-[var(--text-muted)] font-mono truncate" title={cwd}>
            session cwd: {cwd}
          </div>
        )}
        {filesystemRoots.length > 0 && (
          <div className="text-[10px] text-[var(--text-muted)] truncate">
            filesystem roots: {filesystemRoots.slice(0, 3).map((root) => (
              root.kind === 'notes' ? 'Notes (Pinned)' : root.label
            )).join(', ')}
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            value={browserUrlDraft}
            onChange={(e) => set({ browserUrlDraft: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') handleNavigate(); }}
            placeholder="http://localhost:3000"
            className="flex-1 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-xs text-[var(--text-secondary)] font-mono"
          />
          <button
            onClick={handleNavigate}
            disabled={!browserUrlDraft.trim()}
            className="px-3 py-1 rounded text-xs bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/30 disabled:opacity-60"
          >Go</button>
          <button
            onClick={handleRefresh}
            disabled={!iframeUrl}
            className="px-2 py-1 rounded text-xs bg-[var(--text-muted)]/20 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/30 disabled:opacity-60"
          >Reload</button>
        </div>
      </div>

      {/* Preview area */}
      <div className="flex-1 min-h-0 rounded border border-[var(--border-subtle)] overflow-hidden bg-white relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-elevated)]/80 z-10">
            <span className="text-xs text-[var(--text-muted)]">Loading preview...</span>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-elevated)] z-10">
            <span className="text-xs text-[var(--error)]">{error}</span>
          </div>
        )}

        {iframeUrl ? (
          <iframe
            ref={iframeRef}
            src={iframeUrl}
            onLoad={handleIframeLoad}
            onError={handleIframeError}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title="Localhost Preview"
          />
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-[var(--text-muted)]">
            {sessionKey
              ? 'No preview URL found. Enter a URL above or start a dev server in the session.'
              : 'Select a session to load its preview, or enter a localhost URL.'}
          </div>
        )}
      </div>
    </div>
  );
}
