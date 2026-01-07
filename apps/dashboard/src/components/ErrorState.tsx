import { cn } from '../lib/utils'

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <svg className="h-12 w-12 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <h3 className="mt-3 text-sm font-medium text-slate-900">Failed to load sessions</h3>
      <p className="mt-1 text-sm text-slate-500">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className={cn(
            'mt-4 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white',
            'hover:bg-slate-800',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2'
          )}
        >
          Retry
        </button>
      )}
    </div>
  )
}
