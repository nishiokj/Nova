import { discoverConcerns } from 'agent-memory/architecture/cluster.js'

describe('discoverConcerns', () => {
  it('moves an ambiguous file deterministically to lexical-first concern on score tie', () => {
    const files = ['x1.ts', 'x2.ts', 'y1.ts', 'y2.ts', 'mid.ts']
    const edges = [
      { fileA: 'x1.ts', fileB: 'x2.ts', weight: 0.60 },
      { fileA: 'y1.ts', fileB: 'y2.ts', weight: 0.60 },
      { fileA: 'mid.ts', fileB: 'x1.ts', weight: 0.20 },
      { fileA: 'mid.ts', fileB: 'y1.ts', weight: 0.20 },
    ]

    const first = discoverConcerns(files, edges, 0.30)
    const second = discoverConcerns(files, edges, 0.30)

    expect(first.byFile.get('mid.ts')).toBe(first.byFile.get('x1.ts'))
    expect(first.byFile.get('mid.ts')).not.toBe(first.byFile.get('y1.ts'))
    expect([...first.byFile.entries()].sort()).toEqual([...second.byFile.entries()].sort())
  })
})

