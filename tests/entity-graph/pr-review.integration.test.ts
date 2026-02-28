import postgres, { type Sql } from 'postgres'
import { SCHEMA_DDL } from 'entity-graph/schema.js'
import { reviewDiff } from 'entity-graph/pr-review/review.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL
const describeWithDb = TEST_DB_URL ? describe : describe.skip

interface SeedEntity {
  id: string
  kind: 'file' | 'class' | 'function' | 'method' | 'type' | 'interface' | 'enum'
  name: string
  filepath: string
  startLine?: number | null
  endLine?: number | null
  exported?: boolean
}

describeWithDb('PR review integration (real postgres)', () => {
  let sql: Sql

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL!, { max: 1 })
    await sql.unsafe(SCHEMA_DDL)
  })

  afterAll(async () => {
    await sql.end()
  })

  beforeEach(async () => {
    await resetGraph(sql)
  })

  test('dedupes multi-seed blast radius entities in review output', async () => {
    const changedA = await insertEntity(sql, {
      id: 'function:src/a.ts:a',
      kind: 'function',
      name: 'a',
      filepath: 'src/a.ts',
      startLine: 1,
      endLine: 10,
      exported: true,
    })
    const changedB = await insertEntity(sql, {
      id: 'function:src/b.ts:b',
      kind: 'function',
      name: 'b',
      filepath: 'src/b.ts',
      startLine: 1,
      endLine: 10,
      exported: true,
    })
    const dependent = await insertEntity(sql, {
      id: 'method:src/routes.ts:handle',
      kind: 'method',
      name: 'handle',
      filepath: 'src/routes.ts',
      startLine: 20,
      endLine: 30,
    })

    await sql`
      INSERT INTO entity_graph.calls (caller_id, callee_id)
      VALUES (${dependent.id}, ${changedA.id}), (${dependent.id}, ${changedB.id})
    `

    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-export function a() {}',
      '+export function a(x: number) {}',
      'diff --git a/src/b.ts b/src/b.ts',
      'index 3333333..4444444 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-export function b() {}',
      '+export function b(y: string) {}',
    ].join('\n')

    const review = await reviewDiff(sql, diff, 2)
    const dependentDirect = review.blastRadius.direct.filter(e => e.entity.id === dependent.id)
    const dependentRisks = review.risks.filter(r => r.entity.id === dependent.id)

    expect(dependentDirect).toHaveLength(1)
    expect(dependentRisks).toHaveLength(1)
    expect(review.blastRadius.direct).toHaveLength(1)
  })

  test('applies upstream severity using the actual seed path', async () => {
    const lowSeed = await insertEntity(sql, {
      id: 'function:src/low.ts:login',
      kind: 'function',
      name: 'login',
      filepath: 'src/low.ts',
      startLine: 1,
      endLine: 20,
      exported: true,
    })
    const highSeed = await insertEntity(sql, {
      id: 'interface:src/high.ts:User',
      kind: 'interface',
      name: 'User',
      filepath: 'src/high.ts',
      startLine: 1,
      endLine: 5,
      exported: true,
    })
    const lowDependent = await insertEntity(sql, {
      id: 'method:src/routes.ts:lowDependent',
      kind: 'method',
      name: 'lowDependent',
      filepath: 'src/routes.ts',
      startLine: 30,
      endLine: 40,
    })
    const highDependent = await insertEntity(sql, {
      id: 'function:src/middleware.ts:highDependent',
      kind: 'function',
      name: 'highDependent',
      filepath: 'src/middleware.ts',
      startLine: 10,
      endLine: 20,
      exported: true,
    })

    await sql`
      INSERT INTO entity_graph.calls (caller_id, callee_id)
      VALUES (${lowDependent.id}, ${lowSeed.id})
    `
    await sql`
      INSERT INTO entity_graph.uses (user_id, used_id)
      VALUES (${highDependent.id}, ${highSeed.id})
    `

    const diff = [
      'diff --git a/src/low.ts b/src/low.ts',
      'index 1000000..2000000 100644',
      '--- a/src/low.ts',
      '+++ b/src/low.ts',
      '@@ -10,2 +10,2 @@',
      '-  return oldLogin(token)',
      '+  return newLogin(token)',
      'diff --git a/src/high.ts b/src/high.ts',
      'deleted file mode 100644',
      'index 3000000..0000000',
      '--- a/src/high.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
      '-export interface User { id: string }',
    ].join('\n')

    const review = await reviewDiff(sql, diff, 2)
    const lowRisk = review.risks.find(r => r.entity.id === lowDependent.id)
    const highRisk = review.risks.find(r => r.entity.id === highDependent.id)

    expect(lowRisk).toBeDefined()
    expect(highRisk).toBeDefined()
    expect(highRisk!.score).toBeGreaterThan(lowRisk!.score)
    expect(lowRisk!.factors.some(f => f.includes('upstream body changed in login'))).toBe(true)
    expect(highRisk!.factors.some(f => f.includes('upstream entity deleted in User'))).toBe(true)
  })

  test('uses highest-severity upstream when one dependent is reached by multiple seeds', async () => {
    const lowSeed = await insertEntity(sql, {
      id: 'function:src/a.ts:aaaLow',
      kind: 'function',
      name: 'aaaLow',
      filepath: 'src/a.ts',
      startLine: 1,
      endLine: 20,
      exported: true,
    })
    const highSeed = await insertEntity(sql, {
      id: 'interface:src/z.ts:zzzHigh',
      kind: 'interface',
      name: 'zzzHigh',
      filepath: 'src/z.ts',
      startLine: 1,
      endLine: 5,
      exported: true,
    })
    const sharedDependent = await insertEntity(sql, {
      id: 'method:src/routes.ts:shared',
      kind: 'method',
      name: 'shared',
      filepath: 'src/routes.ts',
      startLine: 10,
      endLine: 30,
    })

    await sql`
      INSERT INTO entity_graph.calls (caller_id, callee_id)
      VALUES (${sharedDependent.id}, ${lowSeed.id}), (${sharedDependent.id}, ${highSeed.id})
    `

    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1010101..2020202 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,2 +10,2 @@',
      '-  return oldPath(v)',
      '+  return newPath(v)',
      'diff --git a/src/z.ts b/src/z.ts',
      'deleted file mode 100644',
      'index 3030303..0000000',
      '--- a/src/z.ts',
      '+++ /dev/null',
      '@@ -1,4 +0,0 @@',
      '-export interface zzzHigh { id: string }',
    ].join('\n')

    const review = await reviewDiff(sql, diff, 2)
    const sharedRisk = review.risks.find(r => r.entity.id === sharedDependent.id)
    expect(sharedRisk).toBeDefined()
    expect(sharedRisk!.factors.some(f => f.includes('upstream entity deleted in zzzHigh'))).toBe(true)
  })

  test('reports deleted files even when old entities are absent from current snapshot', async () => {
    const diff = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index aaaabbb..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-export const removed = true',
    ].join('\n')

    const review = await reviewDiff(sql, diff, 2)
    expect(review.changedEntities).toHaveLength(1)
    expect(review.changedEntities[0].changeKind).toBe('entity_deleted')
    expect(review.changedEntities[0].entity.kind).toBe('file')
    expect(review.changedEntities[0].entity.filepath).toBe('src/gone.ts')
  })

  test('reports renamed old path deletion even when old path is absent in snapshot', async () => {
    await insertEntity(sql, {
      id: 'function:src/new-name.ts:foo',
      kind: 'function',
      name: 'foo',
      filepath: 'src/new-name.ts',
      startLine: 1,
      endLine: 10,
      exported: true,
    })

    const diff = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 100%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
    ].join('\n')

    const review = await reviewDiff(sql, diff, 2)
    const oldDeletion = review.changedEntities.find(
      c => c.changeKind === 'entity_deleted' && c.entity.filepath === 'src/old-name.ts',
    )
    const newAddition = review.changedEntities.find(
      c => c.changeKind === 'entity_added' && c.entity.filepath === 'src/new-name.ts',
    )

    expect(oldDeletion).toBeDefined()
    expect(oldDeletion?.entity.kind).toBe('file')
    expect(newAddition).toBeDefined()
  })

  test('includes renamed files in dead-code detection', async () => {
    const renamedExport = await insertEntity(sql, {
      id: 'function:src/new-dead.ts:unusedExport',
      kind: 'function',
      name: 'unusedExport',
      filepath: 'src/new-dead.ts',
      startLine: 1,
      endLine: 8,
      exported: true,
    })

    const diff = [
      'diff --git a/src/old-dead.ts b/src/new-dead.ts',
      'similarity index 95%',
      'rename from src/old-dead.ts',
      'rename to src/new-dead.ts',
      'index abc1234..def5678 100644',
      '--- a/src/old-dead.ts',
      '+++ b/src/new-dead.ts',
      '@@ -1,1 +1,1 @@',
      '-export function oldName() {}',
      '+export function unusedExport() {}',
    ].join('\n')

    const review = await reviewDiff(sql, diff, 2)
    expect(review.deadCode.some(e => e.id === renamedExport.id)).toBe(true)
  })

  test('reports unresolved direct dependents as contract impact gaps', async () => {
    const userInterface = await insertEntity(sql, {
      id: 'interface:src/types.ts:User',
      kind: 'interface',
      name: 'User',
      filepath: 'src/types.ts',
      startLine: 1,
      endLine: 5,
      exported: true,
    })
    const userConsumer = await insertEntity(sql, {
      id: 'function:src/routes.ts:consumeUser',
      kind: 'function',
      name: 'consumeUser',
      filepath: 'src/routes.ts',
      startLine: 1,
      endLine: 10,
      exported: false,
    })

    await sql`
      INSERT INTO entity_graph.uses (user_id, used_id)
      VALUES (${userConsumer.id}, ${userInterface.id})
    `

    const diff = [
      'diff --git a/src/types.ts b/src/types.ts',
      'index 1111111..2222222 100644',
      '--- a/src/types.ts',
      '+++ b/src/types.ts',
      '@@ -1,1 +1,1 @@',
      '-export interface User { id: string }',
      '+export interface User { id: string; email: string }',
    ].join('\n')

    const review = await reviewDiff(sql, diff, 2)
    expect(review.impactGaps).toHaveLength(1)
    expect(review.impactGaps[0].seed.id).toBe(userInterface.id)
    expect(review.impactGaps[0].unresolvedDependents.map(e => e.id)).toContain(userConsumer.id)
  })
})

async function resetGraph(sql: Sql): Promise<void> {
  await sql.unsafe(`
    TRUNCATE
      entity_graph.imports,
      entity_graph.calls,
      entity_graph.uses,
      entity_graph.owns,
      entity_graph.extends,
      entity_graph.implements,
      entity_graph.entities,
      entity_graph.file_leases
  `)
}

async function insertEntity(sql: Sql, entity: SeedEntity): Promise<SeedEntity> {
  await sql`
    INSERT INTO entity_graph.entities (
      id, kind, name, filepath, start_line, end_line, exported, async, raw_text
    )
    VALUES (
      ${entity.id},
      ${entity.kind},
      ${entity.name},
      ${entity.filepath},
      ${entity.startLine ?? null},
      ${entity.endLine ?? null},
      ${entity.exported ?? false},
      false,
      null
    )
  `
  return entity
}
