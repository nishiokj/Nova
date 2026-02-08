import { describe, expect, it } from 'vitest'
import { computeMetrics } from './metrics.js'
import type { ConcernAssignment } from './types.js'

describe('computeMetrics', () => {
  it('computes concern and boundary metrics deterministically', () => {
    const assignment: ConcernAssignment = {
      byFile: new Map([
        ['a1.ts', 'concern.a'],
        ['a2.ts', 'concern.a'],
        ['b1.ts', 'concern.b'],
        ['b2.ts', 'concern.b'],
      ]),
      concernFiles: new Map([
        ['concern.a', new Set(['a1.ts', 'a2.ts'])],
        ['concern.b', new Set(['b1.ts', 'b2.ts'])],
      ]),
    }

    const result = computeMetrics({
      assignment,
      edges: [
        { fileA: 'a1.ts', fileB: 'a2.ts', weight: 0.9 },
        { fileA: 'b1.ts', fileB: 'b2.ts', weight: 0.9 },
        { fileA: 'a1.ts', fileB: 'b1.ts', weight: 0.6 },
        { fileA: 'a2.ts', fileB: 'b2.ts', weight: 0.6 },
      ],
      directedStaticEdges: [
        { sourceFile: 'a1.ts', targetFile: 'b1.ts', weight: 1.0 },
        { sourceFile: 'b2.ts', targetFile: 'a2.ts', weight: 1.0 },
      ],
      interfaceLikeFiles: new Set(['a1.ts']),
      concernLabels: new Map([
        ['concern.a', 'alpha'],
        ['concern.b', 'beta'],
      ]),
      previousConcernFilesById: new Map([
        ['concern.a', new Set(['a1.ts', 'a2.ts'])],
        ['concern.b', new Set(['b1.ts', 'b2.ts'])],
      ]),
    })

    expect(result.concerns).toHaveLength(2)
    const concernA = result.concerns.find((concern) => concern.concernId === 'concern.a')
    expect(concernA).toBeDefined()
    expect(concernA?.cohesion).toBeCloseTo(0.42857, 4)
    expect(concernA?.stability).toBe(1)
    expect(concernA?.confidence).toBeCloseTo(0.71428, 4)

    expect(result.boundaries).toHaveLength(1)
    const boundary = result.boundaries[0]
    expect(boundary.leftConcernId).toBe('concern.a')
    expect(boundary.rightConcernId).toBe('concern.b')
    expect(boundary.crossWeight).toBeCloseTo(1.2, 4)
    expect(boundary.interfaceRatio).toBeCloseTo(0.5, 4)
    expect(boundary.directBypassRatio).toBeCloseTo(0.5, 4)
    expect(boundary.hardness).toBeGreaterThanOrEqual(0)
    expect(boundary.hardness).toBeLessThanOrEqual(1)
  })
})

