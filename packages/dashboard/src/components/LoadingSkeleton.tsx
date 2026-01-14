export function LoadingSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 animate-pulse"
          style={{ animationDelay: `${i * 100}ms` }}
        >
          {/* Header row */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-4 w-24 rounded bg-[var(--bg-elevated)]" />
              <div className="h-5 w-12 rounded bg-[var(--bg-elevated)]" />
              <div className="h-5 w-16 rounded bg-[var(--bg-elevated)]" />
            </div>
            <div className="flex items-center gap-2">
              <div className="h-4 w-16 rounded bg-[var(--bg-elevated)]" />
              <div className="h-4 w-4 rounded bg-[var(--bg-elevated)]" />
            </div>
          </div>

          {/* Metadata row */}
          <div className="mt-3 flex items-center gap-4">
            <div className="h-3 w-20 rounded bg-[var(--bg-elevated)]" />
            <div className="h-3 w-28 rounded bg-[var(--bg-elevated)]" />
            <div className="h-3 w-16 rounded bg-[var(--bg-elevated)]" />
          </div>
        </div>
      ))}
    </div>
  )
}

// Skeleton for task row
export function TaskSkeleton() {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-[var(--bg-elevated)]" />
        <div className="flex-1">
          <div className="h-4 w-3/4 rounded bg-[var(--bg-elevated)]" />
        </div>
        <div className="h-5 w-16 rounded bg-[var(--bg-elevated)]" />
        <div className="h-3 w-12 rounded bg-[var(--bg-elevated)]" />
      </div>
    </div>
  )
}
