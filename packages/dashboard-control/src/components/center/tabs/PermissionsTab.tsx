import { useEffect, useMemo, useState } from 'react';
import { useCockpit } from '@/hooks/use-cockpit-store';

const EMPTY_TEMPLATE = `{
  "permissions": {
    "allow": [],
    "deny": []
  }
}
`;

export function PermissionsTab() {
  const { state, handleUpdateSessionPermissions, handleRefreshSessionPermissions } = useCockpit();
  const permissions = state.sessionPermissions;
  const [customJsonDraft, setCustomJsonDraft] = useState('');

  useEffect(() => {
    if (!permissions) return;
    setCustomJsonDraft(permissions.customConfigJson ?? EMPTY_TEMPLATE);
  }, [permissions?.sessionKey, permissions?.customConfigPath, permissions?.customConfigJson]);

  const rootLabel = useMemo(() => {
    if (!permissions) return 'root';
    return permissions.rootLabel || permissions.workingDir || 'root';
  }, [permissions?.rootLabel, permissions?.workingDir]);

  if (!permissions) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="text-[var(--text-muted)] text-sm mb-1">No permissions loaded</div>
        <div className="text-[var(--text-muted)] text-[11px] opacity-60">
          Select a session to manage runtime permissions.
        </div>
      </div>
    );
  }

  const current = permissions.state;
  const dangerousMode = current.dangerousMode === true;
  const writesNoDeletes = current.writesNoDeletes === true;
  const webSearchEnabled = current.webSearchEnabled !== false;
  const allowOutsideRoot = current.allowOutsideRoot === true;

  return (
    <div className="space-y-3 text-xs">
      <div className="text-[11px] text-[var(--text-muted)] break-all">
        Session root: <span className="font-mono text-[var(--text-secondary)]">{permissions.workingDir}</span>
      </div>

      <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
        <label className="flex items-center gap-2 text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={dangerousMode}
            onChange={(event) => void handleUpdateSessionPermissions({ dangerousMode: event.target.checked })}
            disabled={state.permissionsSaving}
          />
          <span>Dangerous mode</span>
        </label>

        <label className="flex items-center gap-2 text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={writesNoDeletes}
            onChange={(event) => void handleUpdateSessionPermissions({ writesNoDeletes: event.target.checked })}
            disabled={state.permissionsSaving}
          />
          <span>Writes only (No Deletes)</span>
        </label>

        <label className="flex items-center gap-2 text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={webSearchEnabled}
            onChange={(event) => void handleUpdateSessionPermissions({ webSearchEnabled: event.target.checked })}
            disabled={state.permissionsSaving}
          />
          <span>WebSearch Enabled</span>
        </label>

        <label className="flex items-center gap-2 text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={allowOutsideRoot}
            onChange={(event) => void handleUpdateSessionPermissions({ allowOutsideRoot: event.target.checked })}
            disabled={state.permissionsSaving}
          />
          <span>Work outside of {rootLabel}</span>
        </label>
      </div>

      <div className="border border-[var(--border-subtle)] rounded p-2 space-y-2">
        <div className="text-[var(--text-muted)]">
          Custom (JSON) <span className="font-mono">{permissions.customConfigPath}</span>
        </div>
        <textarea
          value={customJsonDraft}
          onChange={(event) => setCustomJsonDraft(event.target.value)}
          className="w-full min-h-36 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded px-2 py-1 text-[11px] font-mono text-[var(--text-secondary)]"
          spellCheck={false}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleUpdateSessionPermissions({ profile: 'custom', customJson: customJsonDraft })}
            disabled={state.permissionsSaving}
            className="px-2 py-0.5 text-[11px] rounded bg-[var(--accent-cyan)]/20 text-[var(--accent-cyan)] hover:bg-[var(--accent-cyan)]/30 disabled:opacity-60"
          >
            {state.permissionsSaving ? 'Saving...' : 'Save Custom JSON'}
          </button>
          <button
            onClick={() => void handleRefreshSessionPermissions()}
            disabled={state.permissionsSaving}
            className="px-2 py-0.5 text-[11px] rounded bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] disabled:opacity-60"
          >
            Reload
          </button>
        </div>
      </div>

      <div className="text-[10px] text-[var(--text-muted)]">
        Persistent rules: allow {current.persistent.allow.length} / deny {current.persistent.deny.length}
      </div>

      {(state.permissionsSaveStatus || permissions.warning) && (
        <div className="text-[11px] text-[var(--text-muted)]">
          {state.permissionsSaveStatus ?? permissions.warning}
        </div>
      )}
    </div>
  );
}
