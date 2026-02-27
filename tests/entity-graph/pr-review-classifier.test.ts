/**
 * Tests for pr-review/classifier.ts — entity change classification
 *
 * Uses a mock SQL layer to avoid requiring a real database.
 */

import { classifyChanges } from 'entity-graph/pr-review/classifier.js'
import type { Entity } from 'entity-graph/types.js'
import type { FileChange } from 'entity-graph/pr-review/types.js'

// --- Mock SQL ---

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

/**
 * Build a mock Sql object that returns canned entities for specific queries.
 * The classifier calls entitiesInFile (plain template query) and
 * entitiesAtLines (sql.unsafe).
 */
function mockSql(entitiesByFile: Record<string, Entity[]>) {
  // Template tag handler (for entitiesInFile/entityById style queries)
  const handler = function (strings: TemplateStringsArray, ...values: unknown[]) {
    const query = strings.join('?')
    // entitiesInFile: WHERE filepath = <value>
    if (query.includes('FROM entity_graph.entities WHERE filepath')) {
      const filepath = values[0] as string
      return Promise.resolve((entitiesByFile[filepath] ?? []).map(entityToRow))
    }
    return Promise.resolve([])
  } as any

  // sql.unsafe handler (for entitiesAtLines dynamic query)
  handler.unsafe = (query: string, params: unknown[]) => {
    if (query.includes('FROM entity_graph.entities e') && query.includes('start_line')) {
      const filepath = params[0] as string
      const entities = entitiesByFile[filepath] ?? []
      // Filter to non-file entities (the real query excludes kind='file')
      const nonFile = entities.filter(e => e.kind !== 'file')

      // Extract line ranges from params (pairs after filepath)
      const ranges: Array<{ startLine: number; endLine: number }> = []
      for (let i = 1; i < params.length; i += 2) {
        ranges.push({ startLine: params[i] as number, endLine: params[i + 1] as number })
      }

      // Filter entities that overlap any range
      const result = nonFile.filter(e => {
        if (e.startLine == null || e.endLine == null) return false
        return ranges.some(r => e.startLine! <= r.endLine && e.endLine! >= r.startLine)
      })
      return Promise.resolve(result.map(entityToRow))
    }
    return Promise.resolve([])
  }

  return handler
}

function entityToRow(e: Entity) {
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    filepath: e.filepath,
    start_line: e.startLine,
    end_line: e.endLine,
    exported: e.exported,
    async: e.async,
    raw_text: e.rawText,
  }
}

// --- Tests ---

describe('classifyChanges', () => {
  const authFunction = makeEntity({
    id: 'function:src/auth.ts:authenticate',
    kind: 'function',
    name: 'authenticate',
    filepath: 'src/auth.ts',
    startLine: 10,
    endLine: 25,
    exported: true,
  })

  const helperFunction = makeEntity({
    id: 'function:src/auth.ts:hashPassword',
    kind: 'function',
    name: 'hashPassword',
    filepath: 'src/auth.ts',
    startLine: 30,
    endLine: 40,
  })

  const fileEntity = makeEntity({
    id: 'file:src/auth.ts:src/auth.ts',
    kind: 'file',
    name: 'src/auth.ts',
    filepath: 'src/auth.ts',
    startLine: 1,
    endLine: 50,
  })

  const entities: Record<string, Entity[]> = {
    'src/auth.ts': [fileEntity, authFunction, helperFunction],
  }

  it('classifies added file entities as entity_added', async () => {
    const newEntity = makeEntity({
      id: 'function:src/new.ts:greet',
      kind: 'function',
      name: 'greet',
      filepath: 'src/new.ts',
      startLine: 1,
      endLine: 5,
    })

    const sql = mockSql({ 'src/new.ts': [newEntity] })
    const changes: FileChange[] = [
      { filepath: 'src/new.ts', status: 'added', hunks: [] },
    ]

    const result = await classifyChanges(sql, changes)
    expect(result).toHaveLength(1)
    expect(result[0].changeKind).toBe('entity_added')
    expect(result[0].entity.name).toBe('greet')
    expect(result[0].fileStatus).toBe('added')
  })

  it('classifies deleted file entities as entity_deleted', async () => {
    const sql = mockSql(entities)
    const changes: FileChange[] = [
      { filepath: 'src/auth.ts', status: 'deleted', hunks: [] },
    ]

    const result = await classifyChanges(sql, changes)
    expect(result).toHaveLength(2) // file entity excluded, 2 functions remain
    expect(result.every(r => r.changeKind === 'entity_deleted')).toBe(true)
  })

  it('classifies modified file — hunk overlapping signature as signature_changed', async () => {
    const sql = mockSql(entities)
    const changes: FileChange[] = [
      {
        filepath: 'src/auth.ts',
        status: 'modified',
        hunks: [{ oldStart: 10, oldCount: 2, newStart: 10, newCount: 3 }],
      },
    ]

    const result = await classifyChanges(sql, changes)
    expect(result).toHaveLength(1)
    expect(result[0].entity.name).toBe('authenticate')
    expect(result[0].changeKind).toBe('signature_changed')
  })

  it('classifies modified file — hunk in body only as body_changed', async () => {
    const sql = mockSql(entities)
    const changes: FileChange[] = [
      {
        filepath: 'src/auth.ts',
        status: 'modified',
        hunks: [{ oldStart: 15, oldCount: 2, newStart: 15, newCount: 3 }],
      },
    ]

    const result = await classifyChanges(sql, changes)
    expect(result).toHaveLength(1)
    expect(result[0].entity.name).toBe('authenticate')
    expect(result[0].changeKind).toBe('body_changed')
  })

  it('classifies exported entity with hunk on export line only as export_changed', async () => {
    // authenticate starts at line 10, is exported — hunk touching only line 10
    const sql = mockSql(entities)
    const changes: FileChange[] = [
      {
        filepath: 'src/auth.ts',
        status: 'modified',
        hunks: [{ oldStart: 10, oldCount: 1, newStart: 10, newCount: 1 }],
      },
    ]

    const result = await classifyChanges(sql, changes)
    expect(result).toHaveLength(1)
    expect(result[0].entity.name).toBe('authenticate')
    expect(result[0].changeKind).toBe('export_changed')
  })

  it('classifies non-exported entity with hunk on first line as signature_changed, not export_changed', async () => {
    // hashPassword starts at line 30, is NOT exported — hunk on line 30 only
    const sql = mockSql(entities)
    const changes: FileChange[] = [
      {
        filepath: 'src/auth.ts',
        status: 'modified',
        hunks: [{ oldStart: 30, oldCount: 1, newStart: 30, newCount: 1 }],
      },
    ]

    const result = await classifyChanges(sql, changes)
    expect(result).toHaveLength(1)
    expect(result[0].entity.name).toBe('hashPassword')
    expect(result[0].changeKind).toBe('signature_changed')
  })

  it('classifies renamed file — old entities deleted, new entities added', async () => {
    const oldEntity = makeEntity({
      id: 'function:src/old.ts:foo',
      kind: 'function',
      name: 'foo',
      filepath: 'src/old.ts',
      startLine: 1,
      endLine: 5,
    })
    const newEntity = makeEntity({
      id: 'function:src/new.ts:foo',
      kind: 'function',
      name: 'foo',
      filepath: 'src/new.ts',
      startLine: 1,
      endLine: 5,
    })

    const sql = mockSql({
      'src/old.ts': [oldEntity],
      'src/new.ts': [newEntity],
    })

    const changes: FileChange[] = [
      {
        filepath: 'src/new.ts',
        status: 'renamed',
        oldFilepath: 'src/old.ts',
        hunks: [],
      },
    ]

    const result = await classifyChanges(sql, changes)
    expect(result).toHaveLength(2)
    expect(result[0].changeKind).toBe('entity_deleted')
    expect(result[0].entity.filepath).toBe('src/old.ts')
    expect(result[1].changeKind).toBe('entity_added')
    expect(result[1].entity.filepath).toBe('src/new.ts')
  })

  it('returns empty for modified file with no hunks', async () => {
    const sql = mockSql(entities)
    const changes: FileChange[] = [
      { filepath: 'src/auth.ts', status: 'modified', hunks: [] },
    ]

    const result = await classifyChanges(sql, changes)
    expect(result).toHaveLength(0)
  })

  it('handles multiple file changes in one call', async () => {
    const newEntity = makeEntity({
      id: 'function:src/new.ts:bar',
      kind: 'function',
      name: 'bar',
      filepath: 'src/new.ts',
      startLine: 1,
      endLine: 3,
    })

    const sql = mockSql({
      ...entities,
      'src/new.ts': [newEntity],
    })

    const changes: FileChange[] = [
      { filepath: 'src/new.ts', status: 'added', hunks: [] },
      {
        filepath: 'src/auth.ts',
        status: 'modified',
        hunks: [{ oldStart: 35, oldCount: 2, newStart: 35, newCount: 3 }],
      },
    ]

    const result = await classifyChanges(sql, changes)
    expect(result).toHaveLength(2)
    expect(result[0].entity.name).toBe('bar')
    expect(result[0].changeKind).toBe('entity_added')
    expect(result[1].entity.name).toBe('hashPassword')
    expect(result[1].changeKind).toBe('body_changed')
  })
})
