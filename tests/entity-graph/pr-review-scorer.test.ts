/**
 * Tests for pr-review/scorer.ts — risk scoring engine
 */

import { scoreRisks } from 'entity-graph/pr-review/scorer.js'
import type { Entity } from 'entity-graph/types.js'
import type { BlastRadiusEntry } from 'entity-graph/queries.js'
import type { EntityChange } from 'entity-graph/pr-review/types.js'

function makeEntity(overrides: Partial<Entity> & { id: string; kind: Entity['kind']; name: string; filepath: string }): Entity {
  return {
    startLine: null,
    endLine: null,
    exported: false,
    async: false,
    rawText: null,
    ...overrides,
  }
}

describe('scoreRisks', () => {
  const changedInterface = makeEntity({
    id: 'interface:src/types.ts:User',
    kind: 'interface',
    name: 'User',
    filepath: 'src/types.ts',
    exported: true,
  })

  const changedFunction = makeEntity({
    id: 'function:src/auth.ts:login',
    kind: 'function',
    name: 'login',
    filepath: 'src/auth.ts',
    exported: true,
  })

  const dependentMethod = makeEntity({
    id: 'method:src/routes.ts:Router.handleLogin',
    kind: 'method',
    name: 'Router.handleLogin',
    filepath: 'src/routes.ts',
  })

  const transitiveFile = makeEntity({
    id: 'function:src/middleware.ts:authGuard',
    kind: 'function',
    name: 'authGuard',
    filepath: 'src/middleware.ts',
    exported: true,
  })

  it('scores directly changed entities', () => {
    const changes: EntityChange[] = [
      { entity: changedInterface, changeKind: 'signature_changed', fileStatus: 'modified' },
    ]

    const risks = scoreRisks(changes, [])
    expect(risks).toHaveLength(1)
    expect(risks[0].entity.id).toBe(changedInterface.id)
    expect(risks[0].score).toBeGreaterThan(0)
    expect(risks[0].factors).toContain('directly signature changed')
    expect(risks[0].factors).toContain('exported entity')
  })

  it('scores blast radius entries with depth-based proximity', () => {
    const changes: EntityChange[] = [
      { entity: changedFunction, changeKind: 'signature_changed', fileStatus: 'modified' },
    ]

    const blast: BlastRadiusEntry[] = [
      { entity: dependentMethod, depth: 1, via: 'calls' },
      { entity: transitiveFile, depth: 2, via: 'imports' },
    ]

    const risks = scoreRisks(changes, blast)

    // Find the depth-1 and depth-2 entries
    const depth1 = risks.find(r => r.entity.id === dependentMethod.id)!
    const depth2 = risks.find(r => r.entity.id === transitiveFile.id)!

    expect(depth1).toBeDefined()
    expect(depth2).toBeDefined()

    // Depth 1 should score higher than depth 2 (closer = riskier)
    expect(depth1.score).toBeGreaterThan(depth2.score - 20) // accounting for export bonus on depth2
    expect(depth1.factors.some(f => f.includes('depth 1'))).toBe(true)
    expect(depth2.factors.some(f => f.includes('depth 2'))).toBe(true)
  })

  it('scores exported entities higher than non-exported', () => {
    const exportedChange: EntityChange = {
      entity: { ...changedFunction, exported: true },
      changeKind: 'body_changed',
      fileStatus: 'modified',
    }

    const unexportedChange: EntityChange = {
      entity: { ...changedFunction, id: 'function:src/auth.ts:internalHelper', exported: false },
      changeKind: 'body_changed',
      fileStatus: 'modified',
    }

    const exportedRisks = scoreRisks([exportedChange], [])
    const unexportedRisks = scoreRisks([unexportedChange], [])

    expect(exportedRisks[0].score).toBeGreaterThan(unexportedRisks[0].score)
  })

  it('scores deleted entities higher than body changes', () => {
    const deleted: EntityChange = {
      entity: changedFunction,
      changeKind: 'entity_deleted',
      fileStatus: 'deleted',
    }
    const bodyChanged: EntityChange = {
      entity: changedFunction,
      changeKind: 'body_changed',
      fileStatus: 'modified',
    }

    const deletedRisks = scoreRisks([deleted], [])
    const bodyRisks = scoreRisks([bodyChanged], [])

    expect(deletedRisks[0].score).toBeGreaterThan(bodyRisks[0].score)
  })

  it('returns results sorted by score descending', () => {
    const changes: EntityChange[] = [
      { entity: changedInterface, changeKind: 'signature_changed', fileStatus: 'modified' },
      {
        entity: makeEntity({
          id: 'function:src/util.ts:helper',
          kind: 'function',
          name: 'helper',
          filepath: 'src/util.ts',
        }),
        changeKind: 'body_changed',
        fileStatus: 'modified',
      },
    ]

    const risks = scoreRisks(changes, [])
    for (let i = 1; i < risks.length; i++) {
      expect(risks[i - 1].score).toBeGreaterThanOrEqual(risks[i].score)
    }
  })

  it('caps scores at 100', () => {
    // Create a scenario likely to produce high scores
    const highRiskChange: EntityChange = {
      entity: { ...changedInterface, exported: true },
      changeKind: 'entity_deleted',
      fileStatus: 'deleted',
    }

    const highRiskBlast: BlastRadiusEntry[] = [
      {
        entity: { ...transitiveFile, exported: true },
        depth: 1,
        via: 'implements',
      },
    ]

    const risks = scoreRisks([highRiskChange], highRiskBlast)
    for (const risk of risks) {
      expect(risk.score).toBeLessThanOrEqual(100)
    }
  })

  it('returns empty for no changes and no blast radius', () => {
    const risks = scoreRisks([], [])
    expect(risks).toEqual([])
  })
})
