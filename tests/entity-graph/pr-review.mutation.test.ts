import { scoreRisks } from 'entity-graph/pr-review/scorer.js'
import type { Entity } from 'entity-graph/types.js'
import type { EntityChange } from 'entity-graph/pr-review/types.js'

function entity(overrides: Partial<Entity> & { id: string; kind: Entity['kind']; name: string; filepath: string }): Entity {
  return {
    startLine: null,
    endLine: null,
    exported: false,
    async: false,
    rawText: null,
    ...overrides,
  }
}

describe('PR review mutation/invariant tests', () => {
  test('direct-change severity ordering is stable', () => {
    const base = entity({
      id: 'function:src/service.ts:run',
      kind: 'function',
      name: 'run',
      filepath: 'src/service.ts',
      exported: true,
    })

    const mk = (changeKind: EntityChange['changeKind']) =>
      scoreRisks([{ entity: base, changeKind, fileStatus: 'modified' }], [])[0].score

    const deleted = mk('entity_deleted')
    const signature = mk('signature_changed')
    const exportChanged = mk('export_changed')
    const body = mk('body_changed')
    const added = mk('entity_added')

    expect(deleted).toBeGreaterThan(signature)
    expect(signature).toBeGreaterThan(exportChanged)
    expect(exportChanged).toBeGreaterThan(body)
    expect(body).toBeGreaterThan(added)
  })

  test('dependent risk drops as depth increases', () => {
    const seed = entity({
      id: 'function:src/a.ts:seed',
      kind: 'function',
      name: 'seed',
      filepath: 'src/a.ts',
      exported: true,
    })
    const dep = entity({
      id: 'method:src/b.ts:dep',
      kind: 'method',
      name: 'dep',
      filepath: 'src/b.ts',
      exported: false,
    })
    const change: EntityChange = { entity: seed, changeKind: 'signature_changed', fileStatus: 'modified' }

    const depth1 = scoreRisks([change], [{ entity: dep, depth: 1, via: 'calls', seedId: seed.id }])
      .find(r => r.entity.id === dep.id)!.score
    const depth2 = scoreRisks([change], [{ entity: dep, depth: 2, via: 'calls', seedId: seed.id }])
      .find(r => r.entity.id === dep.id)!.score
    const depth3 = scoreRisks([change], [{ entity: dep, depth: 3, via: 'calls', seedId: seed.id }])
      .find(r => r.entity.id === dep.id)!.score

    expect(depth1).toBeGreaterThan(depth2)
    expect(depth2).toBeGreaterThan(depth3)
  })

  test('entity appears once even when both changed and in blast radius', () => {
    const seed = entity({
      id: 'function:src/a.ts:seed',
      kind: 'function',
      name: 'seed',
      filepath: 'src/a.ts',
      exported: true,
    })

    const risks = scoreRisks(
      [{ entity: seed, changeKind: 'signature_changed', fileStatus: 'modified' }],
      [{ entity: seed, depth: 1, via: 'calls', seedId: seed.id }],
    )

    expect(risks.filter(r => r.entity.id === seed.id)).toHaveLength(1)
    expect(risks[0].factors.some(f => f.includes('directly signature changed'))).toBe(true)
  })
})
