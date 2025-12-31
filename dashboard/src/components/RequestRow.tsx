import React from 'react'
import type { Request } from '../domain/models'
import { StatusBadge } from './StatusBadge'
import { MetadataGrid } from './MetadataGrid'

function toneForRequestState(state: Request['state']) {
  switch (state) {
    case 'success':
      return 'green'
    case 'error':
      return 'red'
    case 'running':
      return 'blue'
    case 'queued':
      return 'amber'
    case 'cancelled':
      return 'slate'
  }
}

export function RequestRow({ request }: { request: Request }) {
  const t = toneForRequestState(request.state)
  const duration = request.insights.durationMs

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="grid grid-cols-12 items-center gap-2 px-3 py-2 text-sm">
        <div className="col-span-2 text-xs text-slate-500">{new Date(request.createdAt).toLocaleTimeString()}</div>
        <div className="col-span-1 font-mono text-xs text-slate-700">{request.method}</div>
        <div className="col-span-5 truncate">{request.path}</div>
        <div className="col-span-2">
          <StatusBadge tone={t}>{request.state}</StatusBadge>
        </div>
        <div className="col-span-2 text-right tabular-nums text-slate-700">
          {typeof duration === 'number' ? `${duration} ms` : ''}
        </div>
      </div>

      {(request.errorMessage || Object.keys(request.meta).length > 0) && (
        <div className="border-t border-slate-200 bg-slate-50 px-3 py-2">
          {request.errorMessage ? (
            <div className="mb-2 text-sm">
              <span className="font-medium text-rose-700">{request.errorCode ?? 'ERROR'}:</span>{' '}
              <span className="text-slate-700">{request.errorMessage}</span>
            </div>
          ) : null}
          {Object.keys(request.meta).length ? <MetadataGrid items={request.meta} columns={3} /> : null}
        </div>
      )}
    </div>
  )
}
