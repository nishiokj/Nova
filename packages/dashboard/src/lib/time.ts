/**
 * Format ISO timestamp to HH:MM (24-hour)
 */
export function formatTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * Format ISO timestamp to "Jan 5, 14:30"
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * Format milliseconds to human readable duration
 * - < 1s: "180ms"
 * - < 60s: "2.5s"
 * - >= 60s: "3m 20s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remainingS = Math.round(s % 60)
  return remainingS > 0 ? `${m}m ${remainingS}s` : `${m}m`
}

/**
 * Format ISO timestamp to relative time
 * - < 1m: "just now"
 * - < 60m: "5m ago"
 * - < 24h: "3h ago"
 * - >= 24h: falls back to formatDateTime
 */
export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return formatDateTime(iso)
}
