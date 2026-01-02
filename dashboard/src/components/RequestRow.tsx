import type { Request } from '../domain/models'
import { StatusBadge, type StatusTone } from './StatusBadge'
import { MetadataGrid } from './MetadataGrid'
import { formatTime } from '../lib/time'

function toneForRequestState(state: Request['state']): StatusTone {
  switch (state) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'running':
      return 'active'
    case 'queued':
    case 'cancelled':
      return 'neutral'
  }
}

export function RequestRow({ request }: { request: Request }) {
  const tone = toneForRequestState(request.state)
  const duration = request.insights.durationMs

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="grid grid-cols-12 items-center gap-2 px-3 py-2 text-sm">
        <div className="col-span-2 tabular-nums text-slate-500">{formatTime(request.createdAt)}</div>
        <div className="col-span-1 font-mono text-slate-700">{request.method}</div>
        <div className="col-span-5 truncate">{request.path}</div>
        <div className="col-span-2">
          <StatusBadge tone={tone}>{request.state}</StatusBadge>
        </div>
        <div className="col-span-2 text-right tabular-nums text-slate-700">
          {typeof duration === 'number' ? `${duration}ms` : ''}
        </div>
      </div>

      {(request.errorMessage || Object.keys(request.meta).length > 0) && (
        <div className="border-t border-slate-100 bg-slate-50 px-3 py-2">
          {request.errorMessage && (
            <div className="mb-2 text-sm">
              <span className="font-medium text-rose-700">{request.errorCode ?? 'ERROR'}:</span>{' '}
              <span className="text-slate-700">{request.errorMessage}</span>
            </div>
          )}
          {Object.keys(request.meta).length > 0 && <MetadataGrid items={request.meta} columns={3} />}
        </div>
      )}
    </div>
  )
}
