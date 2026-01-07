import { cn } from '../lib/utils'

export function MetadataGrid({
  title,
  items,
  columns = 2,
}: {
  title?: string
  items: Record<string, string | number | undefined | null>
  columns?: 1 | 2 | 3
}) {
  const entries = Object.entries(items).filter(([, v]) => v !== undefined && v !== null)

  if (entries.length === 0) return null

  return (
    <div>
      {title && <div className="mb-2 text-sm font-medium text-slate-900">{title}</div>}
      <dl
        className={cn(
          'grid gap-x-6 gap-y-1 text-sm',
          columns === 1 && 'grid-cols-1',
          columns === 2 && 'grid-cols-1 sm:grid-cols-2',
          columns === 3 && 'grid-cols-1 sm:grid-cols-3'
        )}
      >
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <dt className="text-slate-500">{k}</dt>
            <dd className="max-w-[60%] truncate font-medium text-slate-800">{String(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
