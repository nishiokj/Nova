export function formatRelativeFromIso(iso: string): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h`;
  return `${Math.floor(deltaSec / 86400)}d`;
}

export function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export function statusColor(status: string): string {
  if (status === 'running') return 'var(--running)';
  if (status === 'blocked') return 'var(--warning)';
  if (status === 'ready') return 'var(--accent-cyan)';
  if (status === 'done') return 'var(--success)';
  return 'var(--text-muted)';
}
