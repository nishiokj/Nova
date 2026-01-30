import type { DerivedJobStatus } from '../db/repositories/derived-job.js'
import type { MemoryState } from '../models/conversation-memory.js'

export interface MemoryStateInput {
  hasDigest: boolean
  lastProcessedAt?: string | null
  lastSourceTimestamp?: string | null
  lastJobStatus?: DerivedJobStatus | null
  lastJobError?: string | null
  lastJobCreatedAt?: string | null
}

function toMs(value?: string | null): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function isFailureLatest(input: MemoryStateInput): boolean {
  if (input.lastJobStatus !== 'failed') return false
  const failedAt = toMs(input.lastJobCreatedAt)
  const processedAt = toMs(input.lastProcessedAt)
  if (!processedAt) return true
  if (!failedAt) return true
  return failedAt >= processedAt
}

export function computeMemoryState(input: MemoryStateInput): MemoryState {
  if (input.lastJobStatus === 'running') return 'processing'
  if (input.lastJobStatus === 'pending') return 'queued'
  if (isFailureLatest(input) && !input.hasDigest) return 'failed'

  if (!input.hasDigest) return 'missing'

  const processedAt = toMs(input.lastProcessedAt)
  const sourceAt = toMs(input.lastSourceTimestamp)
  if (processedAt && sourceAt && sourceAt > processedAt) return 'stale'

  return 'ready'
}
