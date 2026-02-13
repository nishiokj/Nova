import { percentile, shouldTriggerLeakyBoundary } from 'agent-memory/architecture/alerts.js'

describe('architecture alerts helpers', () => {
  it('evaluates leaky boundary trigger threshold', () => {
    expect(shouldTriggerLeakyBoundary(0.65, 0.35)).toBe(true)
    expect(shouldTriggerLeakyBoundary(0.80, 0.20)).toBe(true)
    expect(shouldTriggerLeakyBoundary(0.64, 0.20)).toBe(false)
    expect(shouldTriggerLeakyBoundary(0.80, 0.36)).toBe(false)
  })

  it('computes deterministic percentile for sparse arrays', () => {
    expect(percentile([], 75)).toBe(0)
    expect(percentile([1], 99)).toBe(1)
    expect(percentile([1, 2, 3, 4], 75)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5], 99)).toBe(4)
  })
})

