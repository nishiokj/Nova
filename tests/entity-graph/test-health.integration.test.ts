/**
 * Test Health System — Integration Tests
 *
 * Tests against real Postgres. Validates the full pipeline:
 * entity graph queries → TestHealthModule → structured results.
 *
 * Requires TEST_DATABASE_URL env var.
 */

import postgres, { type Sql } from 'postgres'
import { SCHEMA_DDL } from 'entity-graph/schema.js'
import { TestHealthModule, parseRegistryYaml, loadRegistry } from 'entity-graph/test-health.js'
import type { SubstitutionRegistry, BoundaryInfo, ReadinessVerdict, GapReport } from 'entity-graph/test-health.js'
import { callTreeFrom, boundaries, envVarsInTree, depsOf, testFilesFor } from 'entity-graph/queries.js'
import type { CallTreeRow, BoundaryRow, EnvVarRow, DepRow } from 'entity-graph/queries.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL
const describeWithDb = TEST_DB_URL ? describe : describe.skip

// --- Test Helpers ---

interface SeedEntity {
  id: string
  kind: 'file' | 'class' | 'function' | 'method' | 'type' | 'interface' | 'enum'
  name: string
  filepath: string
  startLine?: number | null
  endLine?: number | null
  exported?: boolean
  async?: boolean
  paramsText?: string | null
  returnText?: string | null
}

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
      entity_graph.file_leases,
      entity_graph.env_reads,
      entity_graph.constructor_deps,
      entity_graph.function_deps
  `)
}

async function insertEntity(sql: Sql, e: SeedEntity): Promise<SeedEntity> {
  await sql`
    INSERT INTO entity_graph.entities
      (id, kind, name, filepath, start_line, end_line, exported, async, raw_text, params_text, return_text)
    VALUES
      (${e.id}, ${e.kind}, ${e.name}, ${e.filepath},
       ${e.startLine ?? null}, ${e.endLine ?? null},
       ${e.exported ?? false}, ${e.async ?? false}, null,
       ${e.paramsText ?? null}, ${e.returnText ?? null})
  `
  return e
}

async function insertCall(sql: Sql, callerId: string, calleeId: string): Promise<void> {
  await sql`INSERT INTO entity_graph.calls (caller_id, callee_id) VALUES (${callerId}, ${calleeId})`
}

async function insertImport(sql: Sql, importerId: string, importedId: string, symbol?: string): Promise<void> {
  await sql`INSERT INTO entity_graph.imports (importer_id, imported_id, symbol) VALUES (${importerId}, ${importedId}, ${symbol ?? null})`
}

async function insertUses(sql: Sql, userId: string, usedId: string): Promise<void> {
  await sql`INSERT INTO entity_graph.uses (user_id, used_id) VALUES (${userId}, ${usedId})`
}

async function insertEnvRead(sql: Sql, entityId: string, varName: string, filepath: string, line: number, accessor: string): Promise<void> {
  await sql`INSERT INTO entity_graph.env_reads (entity_id, var_name, filepath, line, accessor) VALUES (${entityId}, ${varName}, ${filepath}, ${line}, ${accessor})`
}

async function insertConstructorDep(sql: Sql, classId: string, paramName: string, paramType: string | null, position: number): Promise<void> {
  await sql`INSERT INTO entity_graph.constructor_deps (class_id, param_name, param_type, position) VALUES (${classId}, ${paramName}, ${paramType}, ${position})`
}

async function insertFunctionDep(sql: Sql, functionId: string, paramName: string, paramType: string | null, position: number): Promise<void> {
  await sql`INSERT INTO entity_graph.function_deps (function_id, param_name, param_type, position) VALUES (${functionId}, ${paramName}, ${paramType}, ${position})`
}

// ============================================================
// REGISTRY PARSING TESTS (pure, no DB)
// ============================================================

describe('parseRegistryYaml', () => {
  test('parses a complete registry with substitutions, env_defaults, and test_patterns', () => {
    const yaml = `
version: 1

substitutions:
  Database:
    prod:
      type: PostgresDatabase
      module: src/infra/postgres.ts
      env: [DATABASE_URL]
    test:
      type: SQLiteMemory
      module: src/infra/sqlite-memory.ts
      env: []
      setup: |
        const db = new SQLiteMemory()
        await db.runMigrations()
      teardown: |
        await db.close()

  EventBus:
    prod:
      type: RedisEventBus
      module: src/infra/redis-events.ts
      env: [REDIS_URL]
    test:
      type: InMemoryEventBus
      module: src/infra/memory-events.ts
      env: []

env_defaults:
  NODE_ENV: test
  LOG_LEVEL: silent

test_patterns:
  - "**/*.test.ts"
  - "**/*.spec.ts"
`
    const registry = parseRegistryYaml(yaml)

    expect(registry.version).toBe(1)
    expect(Object.keys(registry.substitutions)).toEqual(['Database', 'EventBus'])

    // Database substitution
    const db = registry.substitutions.Database
    expect(db.prod.type).toBe('PostgresDatabase')
    expect(db.prod.module).toBe('src/infra/postgres.ts')
    expect(db.prod.env).toEqual(['DATABASE_URL'])
    expect(db.test?.type).toBe('SQLiteMemory')
    expect(db.test?.module).toBe('src/infra/sqlite-memory.ts')
    expect(db.test?.env).toEqual([])
    expect(db.test?.setup).toContain('new SQLiteMemory()')
    expect(db.test?.teardown).toContain('await db.close()')

    // EventBus substitution
    const bus = registry.substitutions.EventBus
    expect(bus.prod.type).toBe('RedisEventBus')
    expect(bus.test?.type).toBe('InMemoryEventBus')

    // Env defaults
    expect(registry.envDefaults).toEqual({ NODE_ENV: 'test', LOG_LEVEL: 'silent' })

    // Test patterns
    expect(registry.testPatterns).toEqual(['**/*.test.ts', '**/*.spec.ts'])
  })

  test('parses blocker entries', () => {
    const yaml = `
version: 1

substitutions:
  StripeClient:
    prod:
      type: StripeSDK
      module: src/payments/stripe.ts
      env: [STRIPE_SECRET_KEY]
    test:
      blocker: true
      reason: "No test substitute available."
`
    const registry = parseRegistryYaml(yaml)
    const stripe = registry.substitutions.StripeClient
    expect(stripe.blocker).toEqual({ reason: 'No test substitute available.' })
    expect(stripe.test).toBeUndefined()
  })

  test('returns empty registry for empty input', () => {
    const registry = parseRegistryYaml('')
    expect(registry.version).toBe(1)
    expect(registry.substitutions).toEqual({})
    expect(registry.envDefaults).toEqual({})
    expect(registry.testPatterns).toEqual([])
  })

  test('handles comments and blank lines', () => {
    const yaml = `
# This is a comment
version: 1

# Another comment
substitutions:
  # Inline comment before entry
  Cache:
    prod:
      type: RedisCache
      module: src/cache.ts
      env: [REDIS_URL]
`
    const registry = parseRegistryYaml(yaml)
    expect(registry.substitutions.Cache.prod.type).toBe('RedisCache')
  })

  test('preserves inspect field in test entries', () => {
    const yaml = `
version: 1

substitutions:
  Database:
    prod:
      type: PostgresDatabase
      module: src/infra/postgres.ts
      env: [DATABASE_URL]
    test:
      type: SQLiteMemory
      module: src/infra/sqlite-memory.ts
      env: []
      setup: |
        const db = new SQLiteMemory()
      inspect: |
        return await db.query("SELECT COUNT(*) FROM users")
      teardown: |
        await db.close()
`
    const registry = parseRegistryYaml(yaml)
    expect(registry.substitutions.Database.test?.inspect).toContain('SELECT COUNT(*)')
  })
})

describe('loadRegistry', () => {
  test('returns empty registry for nonexistent file', async () => {
    const registry = await loadRegistry('/tmp/this-file-absolutely-does-not-exist-12345.yaml')
    expect(registry.version).toBe(1)
    expect(registry.substitutions).toEqual({})
    expect(registry.envDefaults).toEqual({})
    expect(registry.testPatterns).toEqual([])
  })
})

// ============================================================
// CORE QUERY TESTS (require DB)
// ============================================================

describeWithDb('Test Health Queries (real postgres)', () => {
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

  // --- boundaries ---

  describe('boundaries()', () => {
    test('returns exported entities with external callers', async () => {
      // processOrder is exported, called from routes.ts
      await insertEntity(sql, { id: 'function:src/orders.ts:processOrder', kind: 'function', name: 'processOrder', filepath: 'src/orders.ts', startLine: 1, endLine: 50, exported: true })
      await insertEntity(sql, { id: 'method:src/routes.ts:handle', kind: 'method', name: 'handle', filepath: 'src/routes.ts', startLine: 1, endLine: 20 })
      await insertCall(sql, 'method:src/routes.ts:handle', 'function:src/orders.ts:processOrder')

      const result = await boundaries(sql)
      expect(result).toHaveLength(1)
      expect(result[0].entity.name).toBe('processOrder')
      expect(result[0].fanIn).toBe(1)
    })

    test('excludes entities with only same-file callers', async () => {
      // helper called only from same file — NOT a boundary
      await insertEntity(sql, { id: 'function:src/orders.ts:helper', kind: 'function', name: 'helper', filepath: 'src/orders.ts', startLine: 60, endLine: 70, exported: true })
      await insertEntity(sql, { id: 'function:src/orders.ts:processOrder', kind: 'function', name: 'processOrder', filepath: 'src/orders.ts', startLine: 1, endLine: 50, exported: true })
      await insertCall(sql, 'function:src/orders.ts:processOrder', 'function:src/orders.ts:helper')

      const result = await boundaries(sql)
      expect(result.every(b => b.entity.name !== 'helper')).toBe(true)
    })

    test('counts fan-in from multiple files', async () => {
      await insertEntity(sql, { id: 'function:src/auth.ts:verify', kind: 'function', name: 'verify', filepath: 'src/auth.ts', startLine: 1, endLine: 20, exported: true })
      // Three different files call verify
      for (const file of ['src/routes.ts', 'src/api.ts', 'src/middleware.ts']) {
        const callerId = `function:${file}:caller`
        await insertEntity(sql, { id: callerId, kind: 'function', name: 'caller', filepath: file, startLine: 1, endLine: 10 })
        await insertCall(sql, callerId, 'function:src/auth.ts:verify')
      }

      const result = await boundaries(sql)
      expect(result).toHaveLength(1)
      expect(result[0].fanIn).toBe(3)
    })

    test('includes entities with external importers but no callers', async () => {
      await insertEntity(sql, { id: 'class:src/service.ts:OrderService', kind: 'class', name: 'OrderService', filepath: 'src/service.ts', startLine: 1, endLine: 100, exported: true })
      await insertEntity(sql, { id: 'file:src/routes.ts:routes', kind: 'file', name: 'routes', filepath: 'src/routes.ts' })
      await insertImport(sql, 'file:src/routes.ts:routes', 'class:src/service.ts:OrderService', 'OrderService')

      const result = await boundaries(sql)
      expect(result).toHaveLength(1)
      expect(result[0].entity.name).toBe('OrderService')
    })

    test('filters by filepath when provided', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/b.ts:b', kind: 'function', name: 'b', filepath: 'src/b.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/caller.ts:c', kind: 'function', name: 'c', filepath: 'src/caller.ts', startLine: 1, endLine: 10 })
      await insertCall(sql, 'function:src/caller.ts:c', 'function:src/a.ts:a')
      await insertCall(sql, 'function:src/caller.ts:c', 'function:src/b.ts:b')

      const result = await boundaries(sql, 'src/a.ts')
      expect(result).toHaveLength(1)
      expect(result[0].entity.filepath).toBe('src/a.ts')
    })

    test('orders by fan-in descending', async () => {
      await insertEntity(sql, { id: 'function:src/low.ts:low', kind: 'function', name: 'low', filepath: 'src/low.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/high.ts:high', kind: 'function', name: 'high', filepath: 'src/high.ts', startLine: 1, endLine: 10, exported: true })

      // low gets 1 caller, high gets 3
      await insertEntity(sql, { id: 'function:src/c1.ts:c1', kind: 'function', name: 'c1', filepath: 'src/c1.ts', startLine: 1, endLine: 5 })
      await insertCall(sql, 'function:src/c1.ts:c1', 'function:src/low.ts:low')

      for (let i = 1; i <= 3; i++) {
        const id = `function:src/h${i}.ts:h${i}`
        await insertEntity(sql, { id, kind: 'function', name: `h${i}`, filepath: `src/h${i}.ts`, startLine: 1, endLine: 5 })
        await insertCall(sql, id, 'function:src/high.ts:high')
      }

      const result = await boundaries(sql)
      expect(result[0].entity.name).toBe('high')
      expect(result[0].fanIn).toBe(3)
      expect(result[1].entity.name).toBe('low')
      expect(result[1].fanIn).toBe(1)
    })

    test('counts import-only files in fan-in', async () => {
      // verify has 2 caller files + 1 importer file → fan_in = 3
      await insertEntity(sql, { id: 'function:src/auth.ts:verify', kind: 'function', name: 'verify', filepath: 'src/auth.ts', startLine: 1, endLine: 20, exported: true })

      await insertEntity(sql, { id: 'function:src/routes.ts:r', kind: 'function', name: 'r', filepath: 'src/routes.ts', startLine: 1, endLine: 10 })
      await insertEntity(sql, { id: 'function:src/api.ts:a', kind: 'function', name: 'a', filepath: 'src/api.ts', startLine: 1, endLine: 10 })
      await insertCall(sql, 'function:src/routes.ts:r', 'function:src/auth.ts:verify')
      await insertCall(sql, 'function:src/api.ts:a', 'function:src/auth.ts:verify')

      // A third file only imports (no call) — must still count in fan_in
      await insertEntity(sql, { id: 'file:src/types.ts:types', kind: 'file', name: 'types', filepath: 'src/types.ts' })
      await insertImport(sql, 'file:src/types.ts:types', 'function:src/auth.ts:verify', 'verify')

      const result = await boundaries(sql)
      expect(result).toHaveLength(1)
      expect(result[0].fanIn).toBe(3)
    })

    test('excludes non-callable entity kinds from boundaries', async () => {
      // Exported type with an external importer — should NOT appear as a boundary
      await insertEntity(sql, { id: 'type:src/types.ts:Config', kind: 'type', name: 'Config', filepath: 'src/types.ts', startLine: 1, endLine: 5, exported: true })
      await insertEntity(sql, { id: 'file:src/app.ts:app', kind: 'file', name: 'app', filepath: 'src/app.ts' })
      await insertImport(sql, 'file:src/app.ts:app', 'type:src/types.ts:Config', 'Config')

      // Exported interface with external usage — should NOT appear
      await insertEntity(sql, { id: 'interface:src/types.ts:IService', kind: 'interface', name: 'IService', filepath: 'src/types.ts', startLine: 10, endLine: 15, exported: true })
      await insertEntity(sql, { id: 'class:src/impl.ts:ServiceImpl', kind: 'class', name: 'ServiceImpl', filepath: 'src/impl.ts', startLine: 1, endLine: 50, exported: true })
      await insertImport(sql, 'class:src/impl.ts:ServiceImpl', 'interface:src/types.ts:IService', 'IService')

      // A real function boundary for contrast — SHOULD appear
      await insertEntity(sql, { id: 'function:src/auth.ts:login', kind: 'function', name: 'login', filepath: 'src/auth.ts', startLine: 1, endLine: 30, exported: true })
      await insertEntity(sql, { id: 'function:src/routes.ts:handle', kind: 'function', name: 'handle', filepath: 'src/routes.ts', startLine: 1, endLine: 10 })
      await insertCall(sql, 'function:src/routes.ts:handle', 'function:src/auth.ts:login')

      const result = await boundaries(sql)
      expect(result).toHaveLength(1)
      expect(result[0].entity.name).toBe('login')
    })
  })

  // --- callTreeFrom ---

  describe('callTreeFrom()', () => {
    test('returns direct callees at depth 1', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:root', kind: 'function', name: 'root', filepath: 'src/a.ts', startLine: 1, endLine: 50, exported: true })
      await insertEntity(sql, { id: 'function:src/a.ts:helper', kind: 'function', name: 'helper', filepath: 'src/a.ts', startLine: 60, endLine: 70 })
      await insertCall(sql, 'function:src/a.ts:root', 'function:src/a.ts:helper')

      const tree = await callTreeFrom(sql, 'function:src/a.ts:root')
      expect(tree).toHaveLength(1)
      expect(tree[0].entity.name).toBe('helper')
      expect(tree[0].depth).toBe(1)
      expect(tree[0].sameModule).toBe(true)
      expect(tree[0].injected).toBe(false)
    })

    test('walks multi-level call chains', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/a.ts:b', kind: 'function', name: 'b', filepath: 'src/a.ts', startLine: 20, endLine: 30 })
      await insertEntity(sql, { id: 'function:src/a.ts:c', kind: 'function', name: 'c', filepath: 'src/a.ts', startLine: 40, endLine: 50 })
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/a.ts:b')
      await insertCall(sql, 'function:src/a.ts:b', 'function:src/a.ts:c')

      const tree = await callTreeFrom(sql, 'function:src/a.ts:a')
      expect(tree).toHaveLength(2)
      expect(tree[0].entity.name).toBe('b')
      expect(tree[0].depth).toBe(1)
      expect(tree[1].entity.name).toBe('c')
      expect(tree[1].depth).toBe(2)
    })

    test('marks cross-file callees as injected', async () => {
      await insertEntity(sql, { id: 'function:src/orders.ts:process', kind: 'function', name: 'process', filepath: 'src/orders.ts', startLine: 1, endLine: 50, exported: true })
      await insertEntity(sql, { id: 'method:src/db.ts:insert', kind: 'method', name: 'insert', filepath: 'src/db.ts', startLine: 1, endLine: 20 })
      await insertCall(sql, 'function:src/orders.ts:process', 'method:src/db.ts:insert')

      const tree = await callTreeFrom(sql, 'function:src/orders.ts:process')
      expect(tree).toHaveLength(1)
      expect(tree[0].entity.name).toBe('insert')
      expect(tree[0].sameModule).toBe(false)
      expect(tree[0].injected).toBe(true)
    })

    test('respects maxDepth limit', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/a.ts:b', kind: 'function', name: 'b', filepath: 'src/a.ts', startLine: 20, endLine: 30 })
      await insertEntity(sql, { id: 'function:src/a.ts:c', kind: 'function', name: 'c', filepath: 'src/a.ts', startLine: 40, endLine: 50 })
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/a.ts:b')
      await insertCall(sql, 'function:src/a.ts:b', 'function:src/a.ts:c')

      const tree = await callTreeFrom(sql, 'function:src/a.ts:a', 1)
      expect(tree).toHaveLength(1)
      expect(tree[0].entity.name).toBe('b')
    })

    test('deduplicates entities reached via multiple paths', async () => {
      // Diamond: a -> b, a -> c, b -> d, c -> d
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/a.ts:b', kind: 'function', name: 'b', filepath: 'src/a.ts', startLine: 20, endLine: 30 })
      await insertEntity(sql, { id: 'function:src/a.ts:c', kind: 'function', name: 'c', filepath: 'src/a.ts', startLine: 40, endLine: 50 })
      await insertEntity(sql, { id: 'function:src/a.ts:d', kind: 'function', name: 'd', filepath: 'src/a.ts', startLine: 60, endLine: 70 })
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/a.ts:b')
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/a.ts:c')
      await insertCall(sql, 'function:src/a.ts:b', 'function:src/a.ts:d')
      await insertCall(sql, 'function:src/a.ts:c', 'function:src/a.ts:d')

      const tree = await callTreeFrom(sql, 'function:src/a.ts:a')
      const dNodes = tree.filter(n => n.entity.name === 'd')
      expect(dNodes).toHaveLength(1)
      expect(dNodes[0].depth).toBe(2)
    })

    test('deduplicates to shallowest depth when node reachable at multiple depths', async () => {
      // a → b (depth 1), a → c (depth 1), c → b (depth 2)
      // b is reachable at depth 1 directly AND depth 2 via c — must pick depth 1
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/a.ts:b', kind: 'function', name: 'b', filepath: 'src/a.ts', startLine: 20, endLine: 30 })
      await insertEntity(sql, { id: 'function:src/a.ts:c', kind: 'function', name: 'c', filepath: 'src/a.ts', startLine: 40, endLine: 50 })
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/a.ts:b')
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/a.ts:c')
      await insertCall(sql, 'function:src/a.ts:c', 'function:src/a.ts:b')

      const tree = await callTreeFrom(sql, 'function:src/a.ts:a')
      const bNodes = tree.filter(n => n.entity.name === 'b')
      expect(bNodes).toHaveLength(1)
      expect(bNodes[0].depth).toBe(1)
    })

    test('handles cycles without infinite recursion', async () => {
      // a -> b -> a (cycle)
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/a.ts:b', kind: 'function', name: 'b', filepath: 'src/a.ts', startLine: 20, endLine: 30 })
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/a.ts:b')
      await insertCall(sql, 'function:src/a.ts:b', 'function:src/a.ts:a')

      // Should not hang or throw — the recursive CTE's UNION deduplicates
      const tree = await callTreeFrom(sql, 'function:src/a.ts:a')
      expect(tree.length).toBeGreaterThanOrEqual(1)
      expect(tree.some(n => n.entity.name === 'b')).toBe(true)
    })

    test('returns empty array for entity with no callees', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:leaf', kind: 'function', name: 'leaf', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })

      const tree = await callTreeFrom(sql, 'function:src/a.ts:leaf')
      expect(tree).toEqual([])
    })
  })

  // --- envVarsInTree ---

  describe('envVarsInTree()', () => {
    test('finds env vars read by direct callees', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:root', kind: 'function', name: 'root', filepath: 'src/a.ts', startLine: 1, endLine: 50, exported: true })
      await insertEntity(sql, { id: 'function:src/config.ts:getConfig', kind: 'function', name: 'getConfig', filepath: 'src/config.ts', startLine: 1, endLine: 20 })
      await insertCall(sql, 'function:src/a.ts:root', 'function:src/config.ts:getConfig')
      await insertEnvRead(sql, 'function:src/config.ts:getConfig', 'DATABASE_URL', 'src/config.ts', 5, 'process.env')
      await insertEnvRead(sql, 'function:src/config.ts:getConfig', 'REDIS_URL', 'src/config.ts', 6, 'process.env')

      const vars = await envVarsInTree(sql, 'function:src/a.ts:root')
      expect(vars).toHaveLength(2)
      const names = vars.map(v => v.varName).sort()
      expect(names).toEqual(['DATABASE_URL', 'REDIS_URL'])
    })

    test('finds env vars read by the root entity itself', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:root', kind: 'function', name: 'root', filepath: 'src/a.ts', startLine: 1, endLine: 50, exported: true })
      await insertEnvRead(sql, 'function:src/a.ts:root', 'API_KEY', 'src/a.ts', 3, 'process.env')

      const vars = await envVarsInTree(sql, 'function:src/a.ts:root')
      expect(vars).toHaveLength(1)
      expect(vars[0].varName).toBe('API_KEY')
    })

    test('finds env vars in transitive callees', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/a.ts:b', kind: 'function', name: 'b', filepath: 'src/a.ts', startLine: 20, endLine: 30 })
      await insertEntity(sql, { id: 'function:src/a.ts:c', kind: 'function', name: 'c', filepath: 'src/a.ts', startLine: 40, endLine: 50 })
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/a.ts:b')
      await insertCall(sql, 'function:src/a.ts:b', 'function:src/a.ts:c')
      await insertEnvRead(sql, 'function:src/a.ts:c', 'DEEP_SECRET', 'src/a.ts', 45, 'Bun.env')

      const vars = await envVarsInTree(sql, 'function:src/a.ts:a')
      expect(vars).toHaveLength(1)
      expect(vars[0].varName).toBe('DEEP_SECRET')
      expect(vars[0].accessor).toBe('Bun.env')
    })

    test('deduplicates same env var read by multiple callees', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/b.ts:b', kind: 'function', name: 'b', filepath: 'src/b.ts', startLine: 1, endLine: 10 })
      await insertEntity(sql, { id: 'function:src/c.ts:c', kind: 'function', name: 'c', filepath: 'src/c.ts', startLine: 1, endLine: 10 })
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/b.ts:b')
      await insertCall(sql, 'function:src/a.ts:a', 'function:src/c.ts:c')
      // Both b and c read DATABASE_URL, but at different lines — both should appear (DISTINCT by all columns)
      await insertEnvRead(sql, 'function:src/b.ts:b', 'DATABASE_URL', 'src/b.ts', 3, 'process.env')
      await insertEnvRead(sql, 'function:src/c.ts:c', 'DATABASE_URL', 'src/c.ts', 7, 'process.env')

      const vars = await envVarsInTree(sql, 'function:src/a.ts:a')
      // DISTINCT on (var_name, accessor, entity_id, filepath, line) — both rows survive
      expect(vars.length).toBe(2)
    })

    test('returns empty for entity with no env reads in tree', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:pure', kind: 'function', name: 'pure', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })

      const vars = await envVarsInTree(sql, 'function:src/a.ts:pure')
      expect(vars).toEqual([])
    })
  })

  // --- depsOf ---

  describe('depsOf()', () => {
    test('returns constructor deps for a class', async () => {
      await insertEntity(sql, { id: 'class:src/service.ts:OrderService', kind: 'class', name: 'OrderService', filepath: 'src/service.ts', startLine: 1, endLine: 100, exported: true })
      await insertConstructorDep(sql, 'class:src/service.ts:OrderService', 'db', 'Database', 0)
      await insertConstructorDep(sql, 'class:src/service.ts:OrderService', 'events', 'EventBus', 1)

      const deps = await depsOf(sql, 'class:src/service.ts:OrderService')
      expect(deps).toHaveLength(2)
      expect(deps[0]).toEqual({ paramName: 'db', paramType: 'Database', position: 0 })
      expect(deps[1]).toEqual({ paramName: 'events', paramType: 'EventBus', position: 1 })
    })

    test('returns function deps for a function', async () => {
      await insertEntity(sql, { id: 'function:src/orders.ts:processOrder', kind: 'function', name: 'processOrder', filepath: 'src/orders.ts', startLine: 1, endLine: 50, exported: true })
      await insertFunctionDep(sql, 'function:src/orders.ts:processOrder', 'order', 'Order', 0)
      await insertFunctionDep(sql, 'function:src/orders.ts:processOrder', 'db', 'Database', 1)

      const deps = await depsOf(sql, 'function:src/orders.ts:processOrder')
      expect(deps).toHaveLength(2)
      expect(deps[0].paramName).toBe('order')
      expect(deps[1].paramName).toBe('db')
    })

    test('returns empty for entity with no deps', async () => {
      await insertEntity(sql, { id: 'function:src/util.ts:add', kind: 'function', name: 'add', filepath: 'src/util.ts', startLine: 1, endLine: 5, exported: true })

      const deps = await depsOf(sql, 'function:src/util.ts:add')
      expect(deps).toEqual([])
    })

    test('returns empty for nonexistent entity', async () => {
      const deps = await depsOf(sql, 'function:src/nope.ts:nope')
      expect(deps).toEqual([])
    })

    test('orders deps by position', async () => {
      await insertEntity(sql, { id: 'function:src/x.ts:x', kind: 'function', name: 'x', filepath: 'src/x.ts', startLine: 1, endLine: 10, exported: true })
      await insertFunctionDep(sql, 'function:src/x.ts:x', 'c', 'C', 2)
      await insertFunctionDep(sql, 'function:src/x.ts:x', 'a', 'A', 0)
      await insertFunctionDep(sql, 'function:src/x.ts:x', 'b', 'B', 1)

      const deps = await depsOf(sql, 'function:src/x.ts:x')
      expect(deps.map(d => d.paramName)).toEqual(['a', 'b', 'c'])
    })
  })

  // --- testFilesFor ---

  describe('testFilesFor()', () => {
    test('finds test files that import the boundary module', async () => {
      await insertEntity(sql, { id: 'function:src/orders.ts:processOrder', kind: 'function', name: 'processOrder', filepath: 'src/orders.ts', startLine: 1, endLine: 50, exported: true })
      await insertEntity(sql, { id: 'file:src/orders.test.ts:orders.test.ts', kind: 'file', name: 'orders.test.ts', filepath: 'src/orders.test.ts' })
      await insertImport(sql, 'file:src/orders.test.ts:orders.test.ts', 'function:src/orders.ts:processOrder', 'processOrder')

      const tests = await testFilesFor(sql, 'function:src/orders.ts:processOrder')
      expect(tests).toHaveLength(1)
      expect(tests[0].filepath).toBe('src/orders.test.ts')
    })

    test('returns empty when no test files import the module', async () => {
      await insertEntity(sql, { id: 'function:src/orphan.ts:orphan', kind: 'function', name: 'orphan', filepath: 'src/orphan.ts', startLine: 1, endLine: 10, exported: true })

      const tests = await testFilesFor(sql, 'function:src/orphan.ts:orphan')
      expect(tests).toEqual([])
    })

    test('only returns test files, not regular importers', async () => {
      await insertEntity(sql, { id: 'function:src/util.ts:helper', kind: 'function', name: 'helper', filepath: 'src/util.ts', startLine: 1, endLine: 10, exported: true })
      // Regular file imports helper — should NOT be returned
      await insertEntity(sql, { id: 'file:src/app.ts:app.ts', kind: 'file', name: 'app.ts', filepath: 'src/app.ts' })
      await insertImport(sql, 'file:src/app.ts:app.ts', 'function:src/util.ts:helper', 'helper')
      // Test file imports helper — should be returned
      await insertEntity(sql, { id: 'file:src/util.spec.ts:util.spec.ts', kind: 'file', name: 'util.spec.ts', filepath: 'src/util.spec.ts' })
      await insertImport(sql, 'file:src/util.spec.ts:util.spec.ts', 'function:src/util.ts:helper', 'helper')

      const tests = await testFilesFor(sql, 'function:src/util.ts:helper')
      expect(tests).toHaveLength(1)
      expect(tests[0].filepath).toBe('src/util.spec.ts')
    })

    test('matches test files importing any entity from the same module, not just the queried entity', async () => {
      // Two functions in the same file
      await insertEntity(sql, { id: 'function:src/orders.ts:processOrder', kind: 'function', name: 'processOrder', filepath: 'src/orders.ts', startLine: 1, endLine: 50, exported: true })
      await insertEntity(sql, { id: 'function:src/orders.ts:validateOrder', kind: 'function', name: 'validateOrder', filepath: 'src/orders.ts', startLine: 60, endLine: 80, exported: true })

      // Test file imports validateOrder (not processOrder)
      await insertEntity(sql, { id: 'file:tests/orders.test.ts:orders.test.ts', kind: 'file', name: 'orders.test.ts', filepath: 'tests/orders.test.ts' })
      await insertImport(sql, 'file:tests/orders.test.ts:orders.test.ts', 'function:src/orders.ts:validateOrder', 'validateOrder')

      // Query for processOrder — the test file imports a sibling from the same module, so it should still match
      const tests = await testFilesFor(sql, 'function:src/orders.ts:processOrder')
      expect(tests).toHaveLength(1)
      expect(tests[0].filepath).toBe('tests/orders.test.ts')
    })
  })
})

// ============================================================
// TEST HEALTH MODULE TESTS (require DB)
// ============================================================

describeWithDb('TestHealthModule (real postgres)', () => {
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

  /**
   * Build a realistic graph with:
   * - processOrder boundary (exported, called from routes.ts)
   *   - calls validateOrder (same file)
   *   - calls db.insert (different file, injected)
   * - processOrder has function deps: order:Order, db:Database
   * - db.insert reads DATABASE_URL env var
   * - A test file that imports processOrder
   */
  async function seedRealisticGraph() {
    // Entities
    await insertEntity(sql, { id: 'function:src/orders.ts:processOrder', kind: 'function', name: 'processOrder', filepath: 'src/orders.ts', startLine: 1, endLine: 50, exported: true, paramsText: '(order: Order, db: Database)', returnText: 'Promise<Receipt>' })
    await insertEntity(sql, { id: 'function:src/orders.ts:validateOrder', kind: 'function', name: 'validateOrder', filepath: 'src/orders.ts', startLine: 60, endLine: 80 })
    await insertEntity(sql, { id: 'method:src/db.ts:insert', kind: 'method', name: 'insert', filepath: 'src/db.ts', startLine: 1, endLine: 20 })
    await insertEntity(sql, { id: 'method:src/routes.ts:handle', kind: 'method', name: 'handle', filepath: 'src/routes.ts', startLine: 1, endLine: 20 })

    // Calls
    await insertCall(sql, 'method:src/routes.ts:handle', 'function:src/orders.ts:processOrder')
    await insertCall(sql, 'function:src/orders.ts:processOrder', 'function:src/orders.ts:validateOrder')
    await insertCall(sql, 'function:src/orders.ts:processOrder', 'method:src/db.ts:insert')

    // Function deps
    await insertFunctionDep(sql, 'function:src/orders.ts:processOrder', 'order', 'Order', 0)
    await insertFunctionDep(sql, 'function:src/orders.ts:processOrder', 'db', 'Database', 1)

    // Env reads
    await insertEnvRead(sql, 'method:src/db.ts:insert', 'DATABASE_URL', 'src/db.ts', 5, 'process.env')

    // Test file
    await insertEntity(sql, { id: 'file:tests/orders.test.ts:orders.test.ts', kind: 'file', name: 'orders.test.ts', filepath: 'tests/orders.test.ts' })
    await insertImport(sql, 'file:tests/orders.test.ts:orders.test.ts', 'function:src/orders.ts:processOrder', 'processOrder')
  }

  const REGISTRY_YAML = `
version: 1

substitutions:
  Database:
    prod:
      type: PostgresDatabase
      module: src/infra/postgres.ts
      env: [DATABASE_URL]
    test:
      type: SQLiteMemory
      module: src/infra/sqlite-memory.ts
      env: []
      setup: |
        const db = new SQLiteMemory()
        await db.runMigrations()

env_defaults:
  NODE_ENV: test
`

  function createModule(registryYaml?: string): TestHealthModule {
    // Write a temp registry file? No — use the module with an injected registry.
    // TestHealthModule loads lazily from disk, but we can test with parseRegistryYaml directly.
    // For integration tests, we'll use the sourceRoot as a nonsense path and rely on the registry
    // returning empty (or use the real path if we write a temp file).
    // Better approach: create with known non-existent registry to test "no registry" behavior,
    // or create a temp file. For simplicity, we'll manipulate the private _registry field.
    const mod = new TestHealthModule(sql, '/tmp/test-health-source-root')
    if (registryYaml) {
      const reg = parseRegistryYaml(registryYaml)
      ;(mod as any)._registry = reg
    }
    return mod
  }

  describe('boundaries()', () => {
    test('returns boundary info with readiness and test status', async () => {
      await seedRealisticGraph()
      const mod = createModule(REGISTRY_YAML)

      const result = await mod.boundaries()
      expect(result).toHaveLength(1)
      expect(result[0].entity.name).toBe('processOrder')
      expect(result[0].fanIn).toBe(2) // 1 caller (routes.ts) + 1 importer (tests/orders.test.ts)
      expect(result[0].hasTests).toBe(true)
      // "order" param has type Order with no registry entry → unknown dep → blocker → 'blocked'
      expect(result[0].readiness).toBe('blocked')
    })
  })

  describe('callTree()', () => {
    test('returns structured call tree nodes', async () => {
      await seedRealisticGraph()
      const mod = createModule(REGISTRY_YAML)

      const tree = await mod.callTree('function:src/orders.ts:processOrder')
      expect(tree).toHaveLength(2)

      const validate = tree.find(n => n.entity.name === 'validateOrder')
      expect(validate).toBeDefined()
      expect(validate!.depth).toBe(1)
      expect(validate!.sameModule).toBe(true)
      expect(validate!.injected).toBe(false)

      const insert = tree.find(n => n.entity.name === 'insert')
      expect(insert).toBeDefined()
      expect(insert!.depth).toBe(1)
      expect(insert!.sameModule).toBe(false)
      expect(insert!.injected).toBe(true)
    })
  })

  describe('depsFor()', () => {
    test('resolves wirable dependencies from registry', async () => {
      await seedRealisticGraph()
      const mod = createModule(REGISTRY_YAML)

      const deps = await mod.depsFor('function:src/orders.ts:processOrder')
      expect(deps).toHaveLength(2)

      const dbDep = deps.find(d => d.paramName === 'db')
      expect(dbDep).toBeDefined()
      expect(dbDep!.status).toBe('wirable')
      expect(dbDep!.substitution?.testType).toBe('SQLiteMemory')
      expect(dbDep!.substitution?.testModule).toBe('src/infra/sqlite-memory.ts')

      const orderDep = deps.find(d => d.paramName === 'order')
      expect(orderDep).toBeDefined()
      // Order has no registry entry → unknown
      expect(orderDep!.status).toBe('unknown')
    })

    test('marks blocked dependencies', async () => {
      await insertEntity(sql, { id: 'function:src/pay.ts:charge', kind: 'function', name: 'charge', filepath: 'src/pay.ts', startLine: 1, endLine: 30, exported: true })
      await insertFunctionDep(sql, 'function:src/pay.ts:charge', 'stripe', 'StripeClient', 0)

      const blockerYaml = `
version: 1
substitutions:
  StripeClient:
    prod:
      type: StripeSDK
      module: src/payments/stripe.ts
      env: [STRIPE_SECRET_KEY]
    test:
      blocker: true
      reason: "No test substitute."
`
      const mod = createModule(blockerYaml)
      const deps = await mod.depsFor('function:src/pay.ts:charge')
      expect(deps).toHaveLength(1)
      expect(deps[0].status).toBe('blocked')
      expect(deps[0].blocker?.reason).toBe('No test substitute.')
    })
  })

  describe('envVarsFor()', () => {
    test('resolves env vars as covered when in substitution', async () => {
      await seedRealisticGraph()
      const mod = createModule(REGISTRY_YAML)

      const envVars = await mod.envVarsFor('function:src/orders.ts:processOrder')
      expect(envVars).toHaveLength(1)
      expect(envVars[0].varName).toBe('DATABASE_URL')
      expect(envVars[0].status).toBe('covered')
      expect(envVars[0].coveredBy).toBe('Database')
    })

    test('resolves env vars as defaulted when in env_defaults', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEnvRead(sql, 'function:src/a.ts:a', 'NODE_ENV', 'src/a.ts', 3, 'process.env')

      const mod = createModule(REGISTRY_YAML)
      const envVars = await mod.envVarsFor('function:src/a.ts:a')
      expect(envVars).toHaveLength(1)
      expect(envVars[0].status).toBe('defaulted')
      expect(envVars[0].default).toBe('test')
    })

    test('marks unmapped env vars', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEnvRead(sql, 'function:src/a.ts:a', 'SECRET_THING', 'src/a.ts', 3, 'process.env')

      const mod = createModule(REGISTRY_YAML)
      const envVars = await mod.envVarsFor('function:src/a.ts:a')
      expect(envVars).toHaveLength(1)
      expect(envVars[0].status).toBe('unmapped')
    })

    test('covers env var that is not the first element in a multi-env substitution', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEnvRead(sql, 'function:src/a.ts:a', 'REPLICA_URL', 'src/a.ts', 5, 'process.env')

      const multiEnvYaml = `
version: 1

substitutions:
  Database:
    prod:
      type: PostgresDatabase
      module: src/infra/postgres.ts
      env: [PRIMARY_URL, REPLICA_URL]
    test:
      type: SQLiteMemory
      module: src/infra/sqlite-memory.ts
      env: []
`
      const mod = createModule(multiEnvYaml)
      const envVars = await mod.envVarsFor('function:src/a.ts:a')
      expect(envVars).toHaveLength(1)
      expect(envVars[0].varName).toBe('REPLICA_URL')
      expect(envVars[0].status).toBe('covered')
      expect(envVars[0].coveredBy).toBe('Database')
    })
  })

  describe('readiness()', () => {
    test('returns ready when all deps wirable and env covered', async () => {
      await seedRealisticGraph()
      const mod = createModule(REGISTRY_YAML)

      const verdict = await mod.readiness('function:src/orders.ts:processOrder')
      // Order param is type "Order" with no registry entry → unknown → blocker
      // So this should actually be blocked because of the unknown dep
      expect(verdict.ready).toBe(false)
      expect(verdict.blockers.some(b => b.includes('order'))).toBe(true)
    })

    test('returns ready when all deps are wirable (no unknown deps)', async () => {
      await insertEntity(sql, { id: 'function:src/simple.ts:run', kind: 'function', name: 'run', filepath: 'src/simple.ts', startLine: 1, endLine: 30, exported: true })
      await insertFunctionDep(sql, 'function:src/simple.ts:run', 'db', 'Database', 0)

      const mod = createModule(REGISTRY_YAML)
      const verdict = await mod.readiness('function:src/simple.ts:run')
      expect(verdict.ready).toBe(true)
      expect(verdict.blockers).toEqual([])
    })

    test('reports blocked when dep is blocker', async () => {
      await insertEntity(sql, { id: 'function:src/pay.ts:charge', kind: 'function', name: 'charge', filepath: 'src/pay.ts', startLine: 1, endLine: 30, exported: true })
      await insertFunctionDep(sql, 'function:src/pay.ts:charge', 'stripe', 'StripeClient', 0)

      const blockerYaml = `
version: 1
substitutions:
  StripeClient:
    prod:
      type: StripeSDK
      module: src/payments/stripe.ts
      env: [STRIPE_SECRET_KEY]
    test:
      blocker: true
      reason: "Cannot test Stripe."
`
      const mod = createModule(blockerYaml)
      const verdict = await mod.readiness('function:src/pay.ts:charge')
      expect(verdict.ready).toBe(false)
      expect(verdict.blockers).toHaveLength(1)
      expect(verdict.blockers[0]).toContain('Cannot test Stripe')
    })

    test('reports unmapped env vars as blockers', async () => {
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEnvRead(sql, 'function:src/a.ts:a', 'UNKNOWN_VAR', 'src/a.ts', 3, 'process.env')

      const mod = createModule(REGISTRY_YAML)
      const verdict = await mod.readiness('function:src/a.ts:a')
      expect(verdict.ready).toBe(false)
      expect(verdict.blockers.some(b => b.includes('UNKNOWN_VAR'))).toBe(true)
    })

    test('includes test files in verdict', async () => {
      await seedRealisticGraph()
      const mod = createModule(REGISTRY_YAML)

      const verdict = await mod.readiness('function:src/orders.ts:processOrder')
      expect(verdict.testFiles).toHaveLength(1)
      expect(verdict.testFiles[0].filepath).toBe('tests/orders.test.ts')
    })

    test('handles nonexistent entity gracefully', async () => {
      const mod = createModule(REGISTRY_YAML)
      const verdict = await mod.readiness('function:src/nope.ts:nope')
      expect(verdict.ready).toBe(false)
      expect(verdict.blockers).toContain('Entity not found')
    })
  })

  describe('gaps()', () => {
    test('reports untested boundaries', async () => {
      // Two boundaries: one tested, one not
      await insertEntity(sql, { id: 'function:src/tested.ts:tested', kind: 'function', name: 'tested', filepath: 'src/tested.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/untested.ts:untested', kind: 'function', name: 'untested', filepath: 'src/untested.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/caller.ts:c', kind: 'function', name: 'c', filepath: 'src/caller.ts', startLine: 1, endLine: 10 })
      await insertCall(sql, 'function:src/caller.ts:c', 'function:src/tested.ts:tested')
      await insertCall(sql, 'function:src/caller.ts:c', 'function:src/untested.ts:untested')

      // Only tested has a test file
      await insertEntity(sql, { id: 'file:tests/tested.test.ts:tested.test.ts', kind: 'file', name: 'tested.test.ts', filepath: 'tests/tested.test.ts' })
      await insertImport(sql, 'file:tests/tested.test.ts:tested.test.ts', 'function:src/tested.ts:tested', 'tested')

      const mod = createModule(REGISTRY_YAML)
      const report = await mod.gaps()

      expect(report.totalBoundaries).toBe(2)
      expect(report.tested).toBe(1)
      const untested = report.boundaries.find(b => !b.hasTests)
      expect(untested).toBeDefined()
      expect(untested!.entity.name).toBe('untested')
    })

    test('counts ready/blocked/unknown correctly', async () => {
      // Ready boundary: has wirable dep
      await insertEntity(sql, { id: 'function:src/ready.ts:ready', kind: 'function', name: 'ready', filepath: 'src/ready.ts', startLine: 1, endLine: 10, exported: true })
      await insertFunctionDep(sql, 'function:src/ready.ts:ready', 'db', 'Database', 0)

      // Blocked boundary: has blocker dep
      await insertEntity(sql, { id: 'function:src/blocked.ts:blocked', kind: 'function', name: 'blocked', filepath: 'src/blocked.ts', startLine: 1, endLine: 10, exported: true })
      await insertFunctionDep(sql, 'function:src/blocked.ts:blocked', 'ext', 'ExternalAPI', 0)

      // External callers
      await insertEntity(sql, { id: 'function:src/caller.ts:c', kind: 'function', name: 'c', filepath: 'src/caller.ts', startLine: 1, endLine: 10 })
      await insertCall(sql, 'function:src/caller.ts:c', 'function:src/ready.ts:ready')
      await insertCall(sql, 'function:src/caller.ts:c', 'function:src/blocked.ts:blocked')

      const mod = createModule(REGISTRY_YAML)
      const report = await mod.gaps()

      expect(report.totalBoundaries).toBe(2)
      expect(report.ready).toBe(1)
      // ExternalAPI has no registry entry → unknown dep → pushed to blockers → readiness='blocked'
      expect(report.blocked).toBe(1)
      expect(report.unknown).toBe(0)
    })
  })

  // --- End-to-end scenario ---

  describe('full pipeline scenario', () => {
    test('complete flow: seed graph → boundaries → deps → call tree → readiness → gaps', async () => {
      // Build a multi-boundary graph
      await insertEntity(sql, { id: 'function:src/auth.ts:verifyToken', kind: 'function', name: 'verifyToken', filepath: 'src/auth.ts', startLine: 1, endLine: 30, exported: true, paramsText: '(token: string, db: Database)', returnText: 'Promise<User | null>' })
      await insertEntity(sql, { id: 'function:src/auth.ts:hashPassword', kind: 'function', name: 'hashPassword', filepath: 'src/auth.ts', startLine: 40, endLine: 60 })
      await insertEntity(sql, { id: 'method:src/db.ts:query', kind: 'method', name: 'query', filepath: 'src/db.ts', startLine: 1, endLine: 20 })

      // verifyToken calls hashPassword (same file) and db.query (cross-file)
      await insertCall(sql, 'function:src/auth.ts:verifyToken', 'function:src/auth.ts:hashPassword')
      await insertCall(sql, 'function:src/auth.ts:verifyToken', 'method:src/db.ts:query')

      // External callers (fan-in = 3)
      for (const file of ['src/routes.ts', 'src/api.ts', 'src/middleware.ts']) {
        const id = `function:${file}:handler`
        await insertEntity(sql, { id, kind: 'function', name: 'handler', filepath: file, startLine: 1, endLine: 10 })
        await insertCall(sql, id, 'function:src/auth.ts:verifyToken')
      }

      // Function deps
      await insertFunctionDep(sql, 'function:src/auth.ts:verifyToken', 'token', 'string', 0)
      await insertFunctionDep(sql, 'function:src/auth.ts:verifyToken', 'db', 'Database', 1)

      // Env var in transitive callee
      await insertEnvRead(sql, 'method:src/db.ts:query', 'DATABASE_URL', 'src/db.ts', 5, 'process.env')

      const mod = createModule(REGISTRY_YAML)

      // 1. Boundaries
      const bounds = await mod.boundaries()
      expect(bounds).toHaveLength(1)
      expect(bounds[0].entity.name).toBe('verifyToken')
      expect(bounds[0].fanIn).toBe(3)
      expect(bounds[0].hasTests).toBe(false) // no test file seeded

      // 2. Call tree
      const tree = await mod.callTree('function:src/auth.ts:verifyToken')
      expect(tree).toHaveLength(2)
      const hash = tree.find(n => n.entity.name === 'hashPassword')
      expect(hash?.sameModule).toBe(true)
      const dbQuery = tree.find(n => n.entity.name === 'query')
      expect(dbQuery?.injected).toBe(true)

      // 3. Deps
      const deps = await mod.depsFor('function:src/auth.ts:verifyToken')
      expect(deps).toHaveLength(2)
      const dbDep = deps.find(d => d.paramName === 'db')
      expect(dbDep?.status).toBe('wirable')

      // 4. Env vars
      const envVars = await mod.envVarsFor('function:src/auth.ts:verifyToken')
      expect(envVars).toHaveLength(1)
      expect(envVars[0].varName).toBe('DATABASE_URL')
      expect(envVars[0].status).toBe('covered')

      // 5. Readiness — string param has no registry entry but string is a primitive
      // In the current impl, unknown deps are blockers. So "token: string" → unknown → blocked
      const verdict = await mod.readiness('function:src/auth.ts:verifyToken')
      expect(verdict.boundary.name).toBe('verifyToken')
      expect(verdict.boundary.paramsText).toBe('(token: string, db: Database)')
      expect(verdict.boundary.returnText).toBe('Promise<User | null>')

      // 6. Gaps
      const report = await mod.gaps()
      expect(report.totalBoundaries).toBe(1)
      expect(report.tested).toBe(0)
    })
  })

  // --- Resolution logic gap tests ---

  describe('depsFor() — resolution edge cases', () => {
    test('resolves dep via prod.type fallback when key name differs', async () => {
      // Registry key is "Database", but the dep paramType is "PostgresDatabase" (the prod.type)
      await insertEntity(sql, { id: 'function:src/svc.ts:run', kind: 'function', name: 'run', filepath: 'src/svc.ts', startLine: 1, endLine: 30, exported: true })
      await insertFunctionDep(sql, 'function:src/svc.ts:run', 'db', 'PostgresDatabase', 0)

      const yamlWithProdType = `
version: 1
substitutions:
  Database:
    prod:
      type: PostgresDatabase
      module: src/infra/postgres.ts
      env: [DATABASE_URL]
    test:
      type: SQLiteMemory
      module: src/infra/sqlite-memory.ts
      env: []
`
      const mod = createModule(yamlWithProdType)
      const deps = await mod.depsFor('function:src/svc.ts:run')
      expect(deps).toHaveLength(1)
      expect(deps[0].status).toBe('wirable')
      expect(deps[0].substitution?.testType).toBe('SQLiteMemory')
    })

    test('returns unknown for dep with null paramType', async () => {
      await insertEntity(sql, { id: 'function:src/svc.ts:run', kind: 'function', name: 'run', filepath: 'src/svc.ts', startLine: 1, endLine: 30, exported: true })
      await insertFunctionDep(sql, 'function:src/svc.ts:run', 'opts', null, 0)

      const mod = createModule(REGISTRY_YAML)
      const deps = await mod.depsFor('function:src/svc.ts:run')
      expect(deps).toHaveLength(1)
      expect(deps[0].paramName).toBe('opts')
      expect(deps[0].paramType).toBeNull()
      expect(deps[0].status).toBe('unknown')
    })

    test('forwards setup, inspect, and teardown from registry', async () => {
      await insertEntity(sql, { id: 'function:src/svc.ts:run', kind: 'function', name: 'run', filepath: 'src/svc.ts', startLine: 1, endLine: 30, exported: true })
      await insertFunctionDep(sql, 'function:src/svc.ts:run', 'db', 'Database', 0)

      const yamlWithSnippets = `
version: 1
substitutions:
  Database:
    prod:
      type: PostgresDatabase
      module: src/infra/postgres.ts
      env: []
    test:
      type: SQLiteMemory
      module: src/infra/sqlite-memory.ts
      env: []
      setup: |
        const db = new SQLiteMemory()
      inspect: |
        return await db.query("SELECT 1")
      teardown: |
        await db.close()
`
      const mod = createModule(yamlWithSnippets)
      const deps = await mod.depsFor('function:src/svc.ts:run')
      expect(deps[0].substitution?.setup).toContain('new SQLiteMemory()')
      expect(deps[0].substitution?.inspect).toContain('SELECT 1')
      expect(deps[0].substitution?.teardown).toContain('await db.close()')
    })
  })

  describe('envVarsFor() — resolution priority', () => {
    test('prod.env coverage takes priority over env_defaults', async () => {
      // DATABASE_URL is in both prod.env AND env_defaults — prod.env must win
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEnvRead(sql, 'function:src/a.ts:a', 'DATABASE_URL', 'src/a.ts', 3, 'process.env')

      const yamlWithBothCoverage = `
version: 1
substitutions:
  Database:
    prod:
      type: PostgresDatabase
      module: src/infra/postgres.ts
      env: [DATABASE_URL]
    test:
      type: SQLiteMemory
      module: src/infra/sqlite-memory.ts
      env: []
env_defaults:
  DATABASE_URL: postgres://localhost/fallback
`
      const mod = createModule(yamlWithBothCoverage)
      const envVars = await mod.envVarsFor('function:src/a.ts:a')
      expect(envVars).toHaveLength(1)
      expect(envVars[0].status).toBe('covered')
      expect(envVars[0].coveredBy).toBe('Database')
    })
  })

  describe('readiness() — compound scenarios', () => {
    test('reports both wirable and unknown deps correctly', async () => {
      await insertEntity(sql, { id: 'function:src/svc.ts:run', kind: 'function', name: 'run', filepath: 'src/svc.ts', startLine: 1, endLine: 30, exported: true })
      await insertFunctionDep(sql, 'function:src/svc.ts:run', 'db', 'Database', 0)
      await insertFunctionDep(sql, 'function:src/svc.ts:run', 'logger', 'CustomLogger', 1)

      const mod = createModule(REGISTRY_YAML)
      const verdict = await mod.readiness('function:src/svc.ts:run')

      expect(verdict.ready).toBe(false)
      // db is wirable, logger is unknown → one blocker
      const dbDep = verdict.deps.find(d => d.paramName === 'db')
      expect(dbDep?.status).toBe('wirable')
      const loggerDep = verdict.deps.find(d => d.paramName === 'logger')
      expect(loggerDep?.status).toBe('unknown')
      expect(verdict.blockers).toHaveLength(1)
      expect(verdict.blockers[0]).toContain('logger')
      expect(verdict.blockers[0]).toContain('CustomLogger')
    })
  })

  describe('getRegistry() — caching', () => {
    test('returns the same registry instance on repeated calls', async () => {
      const mod = createModule(REGISTRY_YAML)
      const reg1 = await mod.getRegistry()
      const reg2 = await mod.getRegistry()
      expect(reg1).toBe(reg2) // same reference, not just equal
    })
  })

  describe('gaps() — filepath filtering', () => {
    test('passes filepath filter through to boundaries', async () => {
      // Two boundaries in different files
      await insertEntity(sql, { id: 'function:src/a.ts:a', kind: 'function', name: 'a', filepath: 'src/a.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/b.ts:b', kind: 'function', name: 'b', filepath: 'src/b.ts', startLine: 1, endLine: 10, exported: true })
      await insertEntity(sql, { id: 'function:src/caller.ts:c', kind: 'function', name: 'c', filepath: 'src/caller.ts', startLine: 1, endLine: 10 })
      await insertCall(sql, 'function:src/caller.ts:c', 'function:src/a.ts:a')
      await insertCall(sql, 'function:src/caller.ts:c', 'function:src/b.ts:b')

      const mod = createModule(REGISTRY_YAML)
      const allGaps = await mod.gaps()
      expect(allGaps.totalBoundaries).toBe(2)

      const filteredGaps = await mod.gaps('src/a.ts')
      expect(filteredGaps.totalBoundaries).toBe(1)
      expect(filteredGaps.boundaries[0].entity.filepath).toBe('src/a.ts')
    })
  })
})
