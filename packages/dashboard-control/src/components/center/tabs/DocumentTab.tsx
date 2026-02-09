import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { getCockpitMarkdownFile, postCockpitMarkdownPatch } from '@/lib/api';

const MarkdownEditor = lazy(() => import('../MarkdownEditor'));

const AUTOSAVE_DEBOUNCE_MS = 1200;
const POLL_INTERVAL_MS = 2000;

interface DocumentTabProps {
  /** Normalized markdown path (relative, no leading slash) */
  documentPath: string;
  /** Optional project path for scoped file resolution */
  projectPath?: string | null;
}

/**
 * Self-contained document viewer/editor that reads and writes the actual file.
 * Does NOT share state with the workspace (file explorer). Polls the server
 * to reflect external writes (agent edits) in near-real-time.
 */
export function DocumentTab({ documentPath, projectPath }: DocumentTabProps) {
  const [content, setContent] = useState('');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Refs for autosave and polling coordination
  const contentRef = useRef(content);
  contentRef.current = content;
  const versionRef = useRef(version);
  versionRef.current = version;
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);

  const scope = projectPath ? { projectPath } : {};

  // ─── Fetch from server ──────────────────────────────────────
  const fetchFile = useCallback(async () => {
    try {
      const file = await getCockpitMarkdownFile(documentPath, scope);
      return file;
    } catch {
      return null;
    }
  // scope is derived from projectPath — stable enough
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentPath, projectPath]);

  // ─── Initial load ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchFile().then((file) => {
      if (cancelled) return;
      if (!file) {
        setError(`Could not load ${documentPath}`);
        setLoading(false);
        return;
      }
      setContent(file.content);
      setVersion(file.version);
      dirtyRef.current = false;
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fetchFile, documentPath]);

  // ─── Autosave ───────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!dirtyRef.current || savingRef.current) return;
    savingRef.current = true;
    try {
      const result = await postCockpitMarkdownPatch({
        path: documentPath,
        expectedVersion: versionRef.current,
        content: contentRef.current,
        ...scope,
      });
      if (result.success && typeof result.file?.version === 'number') {
        versionRef.current = result.file.version;
        setVersion(result.file.version);
        dirtyRef.current = false;
      }
    } catch {
      // Will retry on next autosave cycle
    } finally {
      savingRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentPath, projectPath]);

  const handleChange = useCallback((next: string) => {
    setContent(next);
    dirtyRef.current = true;
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void save();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [save]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      if (dirtyRef.current) void save();
    };
  }, [save]);

  // ─── Poll for external writes ──────────────────────────────
  useEffect(() => {
    const id = window.setInterval(async () => {
      // Don't clobber local edits
      if (dirtyRef.current || savingRef.current) return;
      const file = await fetchFile();
      if (!file) return;
      if (file.version !== versionRef.current) {
        setContent(file.content);
        setVersion(file.version);
        versionRef.current = file.version;
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [fetchFile]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--text-muted)] text-xs">
        Loading {documentPath}...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--error)] text-xs">
        {error}
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="h-full flex items-center justify-center text-[var(--text-muted)] text-xs">Loading editor...</div>}>
      <MarkdownEditor
        content={content}
        onChange={handleChange}
      />
    </Suspense>
  );
}
