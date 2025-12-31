import React from 'react'

export function CollapsibleSection({
  open,
  onOpenChange,
  summary,
  children,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  summary: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-4 rounded-xl px-3 py-2 text-left hover:bg-slate-50"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <div className="min-w-0 flex-1">{summary}</div>
        <span
          className={['mt-0.5 inline-block text-slate-500 transition-transform', open ? 'rotate-90' : 'rotate-0']
            .filter(Boolean)
            .join(' ')}
          aria-hidden
        >
          
        </span>
      </button>

      <div
        className={[
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        ].join(' ')}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3">{children}</div>
        </div>
      </div>
    </div>
  )
}
