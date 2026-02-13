import { computeMemoryState } from 'agent-memory/memory/state.js'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

describe('computeMemoryState', () => {
  test('returns processing for running job', () => {
    expect(computeMemoryState({ hasDigest: false, lastJobStatus: 'running' })).toBe('processing')
  })

  test('returns queued for pending job', () => {
    expect(computeMemoryState({ hasDigest: false, lastJobStatus: 'pending' })).toBe('queued')
  })

  test('returns failed when last job failed and no digest', () => {
    expect(computeMemoryState({ hasDigest: false, lastJobStatus: 'failed' })).toBe('failed')
  })

  test('returns missing when no digest and no job status', () => {
    expect(computeMemoryState({ hasDigest: false })).toBe('missing')
  })

  test('returns stale when source timestamp is newer than processed', () => {
    const processedAt = iso(Date.now() - 10_000)
    const sourceAt = iso(Date.now())
    expect(computeMemoryState({ hasDigest: true, lastProcessedAt: processedAt, lastSourceTimestamp: sourceAt })).toBe('stale')
  })

  test('returns ready when digest exists and is not stale', () => {
    const processedAt = iso(Date.now())
    const sourceAt = iso(Date.now() - 10_000)
    expect(computeMemoryState({ hasDigest: true, lastProcessedAt: processedAt, lastSourceTimestamp: sourceAt })).toBe('ready')
  })

  test('ignores failed job if success is newer than failure', () => {
    const processedAt = iso(Date.now())
    const failedAt = iso(Date.now() - 10_000)
    expect(
      computeMemoryState({
        hasDigest: true,
        lastProcessedAt: processedAt,
        lastSourceTimestamp: processedAt,
        lastJobStatus: 'failed',
        lastJobCreatedAt: failedAt,
      })
    ).toBe('ready')
  })
})
