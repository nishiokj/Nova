import React from 'react'

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

  return (
    <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
      {title ? <div className="px-3 py-2 text-sm font-medium">{title}</div> : null}
      <dl
        className={[
          'grid gap-x-6 gap-y-2 px-3 pb-3 text-xs',
          columns === 1 ? 'grid-cols-1' : columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3',
        ].join(' ')}
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
