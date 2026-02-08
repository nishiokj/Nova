export function DiffstatLine({ added, deleted, files }: { added: number; deleted: number; files?: number }) {
  const hasStats = added > 0 || deleted > 0 || (files ?? 0) > 0;
  if (!hasStats) return null;
  return (
    <span className="text-[10px] text-[var(--text-muted)]">
      <span className="text-[var(--success)]">+{added}</span>
      /<span className="text-[var(--error)]">-{deleted}</span>
      {typeof files === 'number' && files > 0 && <span> {files} files</span>}
    </span>
  );
}
