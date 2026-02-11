import { useEffect, useRef, useState } from 'react';
import {
  selectActivePermissionRequest,
  useCockpit,
  useCockpitStore,
} from '@/hooks/use-cockpit-store';

export function PermissionDialog() {
  const open = useCockpit((s) => s.permissionDialogOpen);
  const activeRequest = useCockpit(selectActivePermissionRequest);
  const pendingCount = useCockpit((s) => s.pendingPermissionRequests.length);
  const submitting = useCockpit((s) => s.permissionResponseSubmitting);
  const error = useCockpit((s) => s.permissionResponseError);
  const store = useCockpitStore();
  const allowRef = useRef<HTMLButtonElement>(null);
  const [pattern, setPattern] = useState('');

  useEffect(() => {
    setPattern(activeRequest?.suggestedPattern ?? '');
  }, [activeRequest?.requestId, activeRequest?.suggestedPattern]);

  useEffect(() => {
    if (!open || !activeRequest) return;
    const rafId = window.requestAnimationFrame(() => {
      allowRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [open, activeRequest?.requestId]);

  if (!open || !activeRequest) return null;

  const submit = (decision: 'allow' | 'always_allow' | 'deny') => {
    void store.handleRespondToPermissionRequest(
      decision,
      decision === 'always_allow' ? pattern : undefined
    );
  };

  return (
    <div
      data-permission-dialog="true"
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      onClick={() => store.dismissPermissionDialog()}
      onKeyDown={(event) => {
        if (submitting) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          store.dismissPermissionDialog();
          return;
        }
        if (event.key === '1') {
          event.preventDefault();
          submit('allow');
          return;
        }
        if (event.key === '2') {
          event.preventDefault();
          submit('always_allow');
          return;
        }
        if (event.key === '3') {
          event.preventDefault();
          submit('deny');
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          submit('allow');
        }
      }}
    >
      <div className="absolute inset-0 bg-black/55" />
      <div
        className="relative w-full max-w-2xl rounded-lg border border-[var(--warning)]/40 bg-[var(--bg-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--border-subtle)] px-4 py-3">
          <div className="text-sm font-medium text-[var(--warning)]">Permission Request</div>
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">
            Session <span className="font-mono text-[var(--text-secondary)]">{activeRequest.sessionKey}</span>
            {pendingCount > 1 ? ` · ${pendingCount} pending` : ''}
          </div>
        </div>

        <div className="space-y-3 px-4 py-3 text-xs">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Tool</div>
            <div className="font-mono text-[var(--text-primary)]">{activeRequest.tool}</div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Target</div>
            <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)] break-all">
              {activeRequest.target}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Description</div>
            <div className="text-[var(--text-secondary)]">{activeRequest.description || 'No description provided.'}</div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]" htmlFor="permission-pattern">
              Pattern For Always Allow
            </label>
            <input
              id="permission-pattern"
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              className="mt-1 w-full rounded border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent-cyan)]"
              spellCheck={false}
            />
          </div>

          {error && (
            <div className="rounded border border-[var(--error)]/40 bg-[var(--error)]/10 px-2 py-1 text-[11px] text-[var(--error)]">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-4 py-2.5">
          <div className="text-[10px] text-[var(--text-muted)]">
            <span className="font-mono">1</span> allow · <span className="font-mono">2</span> always allow · <span className="font-mono">3</span> deny
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => store.dismissPermissionDialog()}
              disabled={submitting}
              className="rounded border border-[var(--border-subtle)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              Dismiss
            </button>
            <button
              ref={allowRef}
              type="button"
              onClick={() => submit('allow')}
              disabled={submitting}
              className="rounded border border-[var(--accent-green)]/50 bg-[var(--accent-green)]/15 px-2 py-1 text-[11px] text-[var(--accent-green)] hover:bg-[var(--accent-green)]/25 disabled:opacity-50"
            >
              Allow
            </button>
            <button
              type="button"
              onClick={() => submit('always_allow')}
              disabled={submitting}
              className="rounded border border-[var(--accent-cyan)]/50 bg-[var(--accent-cyan)]/15 px-2 py-1 text-[11px] text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/25 disabled:opacity-50"
            >
              Always Allow
            </button>
            <button
              type="button"
              onClick={() => submit('deny')}
              disabled={submitting}
              className="rounded border border-[var(--error)]/50 bg-[var(--error)]/15 px-2 py-1 text-[11px] text-[var(--error)] hover:bg-[var(--error)]/25 disabled:opacity-50"
            >
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
