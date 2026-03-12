import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { tmpdir } from 'node:os'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runReview } from 'entity-graph/pr-review/service.js'

// ---------------------------------------------------------------------------
// Test DB isolation: unique database per file, dropped on teardown
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/agent_memory'

const TEST_DB_NAME = `test_runreview_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function dbUrl(dbName: string): string {
  const u = new URL(BASE_URL)
  u.pathname = `/${dbName}`
  return u.toString()
}

let adminSql: ReturnType<typeof postgres>
let testDbUrl: string

// ---------------------------------------------------------------------------
// Fixture: minimal source tree
// ---------------------------------------------------------------------------

let fixtureDir: string

// add (exported) is called by sum (exported) which is used by formatResult (exported)
// multiply (exported) is standalone — no callers
// This gives us: import edge, call edge, use edge, plus a dead-code candidate

const SRC_MATH = `\
export function add(a: number, b: number): number {
  return a + b
}

export function multiply(x: number, y: number): number {
  return x * y
}
`

const SRC_CALC = `\
import { add } from './math.js'

export function sum(values: number[]): number {
  return values.reduce((acc, v) => add(acc, v), 0)
}
`

const SRC_FORMAT = `\
import { sum } from './calc.js'

export function formatTotal(values: number[]): string {
  return \`Total: \${sum(values)}\`
}
`

// A longer function whose body extends well past the signature zone (first 3 lines)
const SRC_HELPER = `\
export function compute(data: number[]): { min: number; max: number; avg: number } {
  if (data.length === 0) {
    return { min: 0, max: 0, avg: 0 }
  }
  let min = data[0]
  let max = data[0]
  let total = 0
  for (const val of data) {
    if (val < min) min = val
    if (val > max) max = val
    total += val
  }
  return { min, max, avg: total / data.length }
}
`

// Diffs exercising different scenarios
// Modifies add's signature line (line 1 of math.ts)
const DIFF_MODIFY_ADD = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index 1234567..abcdefg 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1,3 +1,3 @@',
  '-export function add(a: number, b: number): number {',
  '+export function add(left: number, right: number): number {',
  '   return a + b',
  ' }',
].join('\n')

// Adds a new file with an unused export
const DIFF_ADD_NEWUTIL = [
  'diff --git a/src/newutil.ts b/src/newutil.ts',
  'new file mode 100644',
  'index 0000000..abcdefg',
  '--- /dev/null',
  '+++ b/src/newutil.ts',
  '@@ -0,0 +1,3 @@',
  '+export function noop(): void {',
  '+  // intentionally empty',
  '+}',
].join('\n')

// Deletes format.ts
const DIFF_DELETE_FORMAT = [
  'diff --git a/src/format.ts b/src/format.ts',
  'deleted file mode 100644',
  'index abcdefg..0000000',
  '--- a/src/format.ts',
  '+++ /dev/null',
  '@@ -1,5 +0,0 @@',
  '-import { sum } from \'./calc.js\'',
  '-',
  '-export function formatTotal(values: number[]): string {',
  `-  return \`Total: \${sum(values)}\``,
  '-}',
].join('\n')

// Body-only change: modifies line 10 of helper.ts (well past signature zone lines 1-3)
const DIFF_BODY_CHANGE = [
  'diff --git a/src/helper.ts b/src/helper.ts',
  'index 1234567..abcdefg 100644',
  '--- a/src/helper.ts',
  '+++ b/src/helper.ts',
  '@@ -9,3 +9,3 @@',
  '   for (const val of data) {',
  '-    if (val < min) min = val',
  '+    if (val <= min) min = val',
  '     if (val > max) max = val',
].join('\n')

// Export-only change: modifies exactly line 1 with 1-line hunk (export line only)
const DIFF_EXPORT_ONLY = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index 1234567..abcdefg 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1,1 +1,1 @@',
  '-export function add(a: number, b: number): number {',
  '+export function add(a: number, b: number): number { // stable',
].join('\n')

// Rename: math.ts → arithmetic.ts
const DIFF_RENAME = [
  'diff --git a/src/math.ts b/src/arithmetic.ts',
  'similarity index 100%',
  'rename from src/math.ts',
  'rename to src/arithmetic.ts',
].join('\n')

// Multi-file: modifies both math.ts signature and calc.ts body
const DIFF_MULTI_FILE = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index 1234567..abcdefg 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1,3 +1,3 @@',
  '-export function add(a: number, b: number): number {',
  '+export function add(left: number, right: number): number {',
  '   return a + b',
  ' }',
  'diff --git a/src/calc.ts b/src/calc.ts',
  'index 1234567..abcdefg 100644',
  '--- a/src/calc.ts',
  '+++ b/src/calc.ts',
  '@@ -3,3 +3,3 @@',
  ' export function sum(values: number[]): number {',
  '-  return values.reduce((acc, v) => add(acc, v), 0)',
  '+  return values.reduce((total, v) => add(total, v), 0)',
  ' }',
].join('\n')

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  adminSql = postgres(BASE_URL, { max: 2, connect_timeout: 10 })
  await adminSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`)
  await adminSql.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`)
  testDbUrl = dbUrl(TEST_DB_NAME)

  fixtureDir = await mkdtemp(join(tmpdir(), 'runreview-'))
  await mkdir(join(fixtureDir, 'src'), { recursive: true })
  await writeFile(join(fixtureDir, 'src', 'math.ts'), SRC_MATH)
  await writeFile(join(fixtureDir, 'src', 'calc.ts'), SRC_CALC)
  await writeFile(join(fixtureDir, 'src', 'format.ts'), SRC_FORMAT)
  await writeFile(join(fixtureDir, 'src', 'helper.ts'), SRC_HELPER)
}, 30_000)

afterAll(async () => {
  await adminSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`)
  await adminSql.end()
  await rm(fixtureDir, { recursive: true, force: true })
}, 15_000)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resetSchema(): Promise<void> {
  const sql = postgres(testDbUrl, { max: 1, connect_timeout: 5 })
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS entity_graph CASCADE')
  } finally {
    await sql.end()
  }
}

async function schemaExists(): Promise<boolean> {
  const sql = postgres(testDbUrl, { max: 1, connect_timeout: 5 })
  try {
    const [row] = await sql<[{ exists: boolean }]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'entity_graph'
      ) as exists
    `
    return row.exists
  } finally {
    await sql.end()
  }
}

async function entityCount(): Promise<number> {
  const sql = postgres(testDbUrl, { max: 1, connect_timeout: 5 })
  try {
    const [row] = await sql<[{ count: string }]>`SELECT count(*) as count FROM entity_graph.entities`
    return parseInt(row.count, 10)
  } finally {
    await sql.end()
  }
}

async function insertSentinel(): Promise<void> {
  const sql = postgres(testDbUrl, { max: 1, connect_timeout: 5 })
  try {
    await sql`
      INSERT INTO entity_graph.entities (id, kind, name, filepath, exported, async)
      VALUES ('sentinel:old:data', 'function', '__sentinel__', 'sentinel.ts', false, false)
    `
  } finally {
    await sql.end()
  }
}

async function sentinelExists(): Promise<boolean> {
  const sql = postgres(testDbUrl, { max: 1, connect_timeout: 5 })
  try {
    const [row] = await sql<[{ exists: boolean }]>`
      SELECT EXISTS (SELECT 1 FROM entity_graph.entities WHERE id = 'sentinel:old:data') as exists
    `
    return row.exists
  } finally {
    await sql.end()
  }
}

async function activeConnectionCount(): Promise<number> {
  const sql = postgres(BASE_URL, { max: 1, connect_timeout: 5 })
  try {
    const [row] = await sql<[{ count: string }]>`
      SELECT count(*) as count FROM pg_stat_activity
      WHERE datname = ${TEST_DB_NAME} AND pid != pg_backend_pid()
    `
    return parseInt(row.count, 10)
  } finally {
    await sql.end()
  }
}

// Build the graph once — many tests reuse it with rebuildGraph=false
async function buildGraph(): Promise<void> {
  await runReview({
    databaseUrl: testDbUrl,
    diffText: '',
    maxDepth: 1,
    sourceRoot: fixtureDir,
    rebuildGraph: true,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runReview', () => {

  // ---- rebuildGraph=true ----

  describe('rebuildGraph=true', () => {
    beforeEach(resetSchema)

    it('creates schema, parses source files, and returns valid PRReview', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        sourceRoot: fixtureDir,
        rebuildGraph: true,
      })

      expect(await schemaExists()).toBe(true)
      // Tree-sitter parsed our 3 files → should find add, multiply, sum, formatTotal
      const count = await entityCount()
      expect(count).toBeGreaterThanOrEqual(4)

      expect(review.summary).toBeTypeOf('string')
      expect(review.summary.length).toBeGreaterThan(0)
      expect(Array.isArray(review.changedEntities)).toBe(true)
      expect(Array.isArray(review.risks)).toBe(true)
      expect(Array.isArray(review.impactGaps)).toBe(true)
      expect(Array.isArray(review.deadCode)).toBe(true)
      expect(typeof review.blastRadius.totalFiles).toBe('number')
      expect(typeof review.blastRadius.totalEntities).toBe('number')
    }, 60_000)

    it('drops existing schema data before rebuilding', async () => {
      // First build populates the graph
      await buildGraph()
      // Insert sentinel into the existing schema
      await insertSentinel()
      expect(await sentinelExists()).toBe(true)

      // Rebuild — must wipe everything including sentinel
      await runReview({
        databaseUrl: testDbUrl,
        diffText: '',
        maxDepth: 1,
        sourceRoot: fixtureDir,
        rebuildGraph: true,
      })

      expect(await sentinelExists()).toBe(false)
    }, 60_000)

    it('throws with exact message when sourceRoot is missing', async () => {
      await expect(
        runReview({
          databaseUrl: testDbUrl,
          diffText: DIFF_MODIFY_ADD,
          maxDepth: 2,
          rebuildGraph: true,
        })
      ).rejects.toThrow('runReview(sourceRoot) is required when rebuildGraph=true')
    })

    it('uses custom exclude to skip matching files', async () => {
      // Exclude calc.ts — graph should not contain sum
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 1,
        sourceRoot: fixtureDir,
        rebuildGraph: true,
        exclude: ['**/calc.ts'],
      })

      const sql = postgres(testDbUrl, { max: 1, connect_timeout: 5 })
      try {
        const rows = await sql<Array<{ name: string }>>`
          SELECT name FROM entity_graph.entities WHERE filepath = 'src/calc.ts'
        `
        expect(rows).toHaveLength(0)
      } finally {
        await sql.end()
      }
    }, 60_000)

    it('excludes node_modules by default when no exclude is provided', async () => {
      const nmDir = join(fixtureDir, 'node_modules', 'dep')
      await mkdir(nmDir, { recursive: true })
      await writeFile(join(nmDir, 'index.ts'), 'export const x = 1\n')

      try {
        await runReview({
          databaseUrl: testDbUrl,
          diffText: '',
          maxDepth: 1,
          sourceRoot: fixtureDir,
          rebuildGraph: true,
        })

        const sql = postgres(testDbUrl, { max: 1, connect_timeout: 5 })
        try {
          const rows = await sql<Array<{ filepath: string }>>`
            SELECT filepath FROM entity_graph.entities WHERE filepath LIKE 'node_modules%'
          `
          expect(rows).toHaveLength(0)
        } finally {
          await sql.end()
        }
      } finally {
        await rm(nmDir, { recursive: true, force: true })
      }
    }, 60_000)
  })

  // ---- rebuildGraph=false ----

  describe('rebuildGraph=false', () => {
    it('creates schema without dropping existing data', async () => {
      await resetSchema()
      await buildGraph()
      await insertSentinel()

      await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 1,
        rebuildGraph: false,
      })

      expect(await sentinelExists()).toBe(true)
    }, 60_000)

    it('creates schema when it does not already exist', async () => {
      await resetSchema()
      expect(await schemaExists()).toBe(false)

      await runReview({
        databaseUrl: testDbUrl,
        diffText: '',
        maxDepth: 1,
        rebuildGraph: false,
      })

      expect(await schemaExists()).toBe(true)
    }, 15_000)
  })

  // ---- Review pipeline: real classification, blast radius, scoring, dead code ----

  describe('review pipeline', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('classifies modified entities with correct changeKind', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const addChange = review.changedEntities.find(ec => ec.entity.name === 'add')
      expect(addChange).toBeDefined()
      expect(addChange!.changeKind).toBe('signature_changed')
      expect(addChange!.fileStatus).toBe('modified')
    }, 30_000)

    it('computes blast radius through real graph edges', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      // add → sum (depth 1, import/call edge)
      const directNames = review.blastRadius.direct.map(e => e.entity.name)
      expect(directNames).toContain('sum')

      // sum → formatTotal (depth 2, import edge)
      const transitiveNames = review.blastRadius.transitive.map(e => e.entity.name)
      expect(transitiveNames).toContain('formatTotal')

      expect(review.blastRadius.totalEntities).toBeGreaterThanOrEqual(2)
      expect(review.blastRadius.totalFiles).toBeGreaterThanOrEqual(2)
    }, 30_000)

    it('limits blast radius depth via maxDepth', async () => {
      const shallow = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 1,
        rebuildGraph: false,
      })

      const deep = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      // maxDepth=1: sum (depth 1) but NOT formatTotal (depth 2)
      const shallowAll = [...shallow.blastRadius.direct, ...shallow.blastRadius.transitive]
      expect(shallowAll.map(e => e.entity.name)).toContain('sum')
      expect(shallowAll.map(e => e.entity.name)).not.toContain('formatTotal')

      // maxDepth=2: both
      const deepAll = [...deep.blastRadius.direct, ...deep.blastRadius.transitive]
      expect(deepAll.map(e => e.entity.name)).toContain('sum')
      expect(deepAll.map(e => e.entity.name)).toContain('formatTotal')
    }, 30_000)

    it('produces risk scores sorted descending in [0, 100] with factors', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      expect(review.risks.length).toBeGreaterThan(0)
      for (const risk of review.risks) {
        expect(risk.score).toBeGreaterThanOrEqual(0)
        expect(risk.score).toBeLessThanOrEqual(100)
        expect(risk.factors.length).toBeGreaterThan(0)
        expect(risk.entity.id).toBeTypeOf('string')
        expect(risk.entity.filepath).toBeTypeOf('string')
      }
      for (let i = 1; i < review.risks.length; i++) {
        expect(review.risks[i].score).toBeLessThanOrEqual(review.risks[i - 1].score)
      }
    }, 30_000)

    it('contract change with unresolved dependents scores higher than the dependent itself', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      // add has signature_changed with sum as unresolved dependent → penalty boosts score
      const addRisk = review.risks.find(r => r.entity.name === 'add')
      const sumRisk = review.risks.find(r => r.entity.name === 'sum')
      expect(addRisk).toBeDefined()
      expect(sumRisk).toBeDefined()
      // The directly-changed contract entity with unresolved dependents must score
      // higher than its blast-radius dependent
      expect(addRisk!.score).toBeGreaterThan(sumRisk!.score)
    }, 30_000)

    it('detects impact gaps when contract changes have unresolved dependents', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      // add has signature_changed → sum is unresolved dependent
      expect(review.impactGaps.length).toBeGreaterThan(0)
      const addGap = review.impactGaps.find(g => g.seed.name === 'add')
      expect(addGap).toBeDefined()
      expect(addGap!.seedChangeKind).toBe('signature_changed')
      expect(addGap!.unresolvedDependents.map(d => d.name)).toContain('sum')
    }, 30_000)

    it('detects dead code from newly added unused exports', async () => {
      const newFile = join(fixtureDir, 'src', 'newutil.ts')
      await writeFile(newFile, 'export function noop(): void {}\n')
      try {
        // Rebuild to include newutil.ts in graph
        const review = await runReview({
          databaseUrl: testDbUrl,
          diffText: DIFF_ADD_NEWUTIL,
          maxDepth: 1,
          sourceRoot: fixtureDir,
          rebuildGraph: true,
        })

        expect(review.deadCode.map(e => e.name)).toContain('noop')
      } finally {
        await rm(newFile, { force: true })
      }
    }, 60_000)

    it('detects dead code in modified files', async () => {
      // DIFF_MODIFY_ADD modifies math.ts (status='modified')
      // multiply is exported from math.ts but has no callers
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 1,
        rebuildGraph: false,
      })

      expect(review.deadCode.map(e => e.name)).toContain('multiply')
    }, 30_000)

    it('classifies deleted file entities as entity_deleted', async () => {
      // Rebuild graph first to ensure format.ts entities exist
      await runReview({
        databaseUrl: testDbUrl,
        diffText: '',
        maxDepth: 1,
        sourceRoot: fixtureDir,
        rebuildGraph: true,
      })

      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_DELETE_FORMAT,
        maxDepth: 1,
        rebuildGraph: false,
      })

      const deleted = review.changedEntities.filter(ec => ec.changeKind === 'entity_deleted')
      expect(deleted.length).toBeGreaterThan(0)
      expect(deleted.map(ec => ec.entity.name)).toContain('formatTotal')
      expect(deleted[0].fileStatus).toBe('deleted')
    }, 60_000)

    it('builds summary reflecting entity count and ending with period', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 1,
        rebuildGraph: false,
      })

      const count = review.changedEntities.length
      if (count === 1) {
        expect(review.summary).toContain('1 entity changed')
      } else {
        expect(review.summary).toContain(`${count} entities changed`)
      }
      expect(review.summary).toMatch(/\.$/)
    }, 15_000)
  })

  // ---- Edge cases ----

  describe('edge cases', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('returns empty results for empty diff text', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: '',
        maxDepth: 1,
        rebuildGraph: false,
      })

      expect(review.changedEntities).toHaveLength(0)
      expect(review.blastRadius.direct).toHaveLength(0)
      expect(review.blastRadius.transitive).toHaveLength(0)
      expect(review.blastRadius.totalEntities).toBe(0)
      expect(review.risks).toHaveLength(0)
      expect(review.summary).toContain('0 entities changed')
    }, 15_000)

    it('handles diff referencing files not in the graph', async () => {
      const ghostDiff = [
        'diff --git a/src/ghost.ts b/src/ghost.ts',
        'index 1234567..abcdefg 100644',
        '--- a/src/ghost.ts',
        '+++ b/src/ghost.ts',
        '@@ -1,3 +1,3 @@',
        '-export const old = 1',
        '+export const new_ = 2',
      ].join('\n')

      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: ghostDiff,
        maxDepth: 1,
        rebuildGraph: false,
      })

      expect(review.summary).toBeTypeOf('string')
      expect(Array.isArray(review.changedEntities)).toBe(true)
    }, 15_000)
  })

  // ---- Classification gaps ----

  describe('classification: body_changed', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('classifies a body-only modification as body_changed', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_BODY_CHANGE,
        maxDepth: 1,
        rebuildGraph: false,
      })

      const computeChange = review.changedEntities.find(ec => ec.entity.name === 'compute')
      expect(computeChange).toBeDefined()
      expect(computeChange!.changeKind).toBe('body_changed')
      expect(computeChange!.fileStatus).toBe('modified')
    }, 30_000)
  })

  describe('classification: export_changed', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('classifies export-line-only modification on exported entity as export_changed', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_EXPORT_ONLY,
        maxDepth: 1,
        rebuildGraph: false,
      })

      const addChange = review.changedEntities.find(ec => ec.entity.name === 'add')
      expect(addChange).toBeDefined()
      expect(addChange!.changeKind).toBe('export_changed')
      expect(addChange!.fileStatus).toBe('modified')
    }, 30_000)
  })

  describe('classification: renamed file', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('produces entity_deleted for old path and entity_added for new path', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_RENAME,
        maxDepth: 1,
        rebuildGraph: false,
      })

      const deleted = review.changedEntities.filter(
        ec => ec.changeKind === 'entity_deleted' && ec.fileStatus === 'renamed',
      )
      const added = review.changedEntities.filter(
        ec => ec.changeKind === 'entity_added' && ec.fileStatus === 'renamed',
      )

      // Old path entities (add, multiply from math.ts) should be deleted
      expect(deleted.length).toBeGreaterThan(0)
      expect(deleted.map(ec => ec.entity.filepath)).toContain('src/math.ts')

      // New path (arithmetic.ts) — no entities in graph yet, so a synthetic file entity
      expect(added.length).toBeGreaterThan(0)
    }, 30_000)
  })

  // ---- Multi-file diff ----

  describe('multi-file diff', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('processes all files in a multi-file diff, not just the first', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MULTI_FILE,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const changedNames = review.changedEntities.map(ec => ec.entity.name)
      // Both files' entities must appear
      expect(changedNames).toContain('add')
      expect(changedNames).toContain('sum')

      const changedPaths = new Set(review.changedEntities.map(ec => ec.entity.filepath))
      expect(changedPaths.has('src/math.ts')).toBe(true)
      expect(changedPaths.has('src/calc.ts')).toBe(true)
    }, 30_000)
  })

  // ---- Blast radius structural integrity ----

  describe('blast radius integrity', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('blast radius entries contain no duplicate entity IDs', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const allEntries = [...review.blastRadius.direct, ...review.blastRadius.transitive]
      const ids = allEntries.map(e => e.entity.id)
      const unique = new Set(ids)
      expect(ids.length).toBe(unique.size)
    }, 30_000)

    it('blast radius entries carry edge type in via field', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const validVias = new Set(['imports', 'calls', 'uses', 'extends', 'implements'])
      const allEntries = [...review.blastRadius.direct, ...review.blastRadius.transitive]
      expect(allEntries.length).toBeGreaterThan(0)
      for (const entry of allEntries) {
        expect(validVias.has(entry.via)).toBe(true)
      }
    }, 30_000)

    it('direct entries have depth 1 and transitive entries have depth > 1', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      for (const entry of review.blastRadius.direct) {
        expect(entry.depth).toBe(1)
      }
      for (const entry of review.blastRadius.transitive) {
        expect(entry.depth).toBeGreaterThan(1)
      }
    }, 30_000)

    it('totalFiles and totalEntities match actual entry counts', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const allEntries = [...review.blastRadius.direct, ...review.blastRadius.transitive]
      expect(review.blastRadius.totalEntities).toBe(allEntries.length)

      const files = new Set(allEntries.map(e => e.entity.filepath))
      expect(review.blastRadius.totalFiles).toBe(files.size)
    }, 30_000)
  })

  // ---- Impact gap structure ----

  describe('impact gap structure', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('directDependents includes all depth-1 dependents, not just unresolved', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const addGap = review.impactGaps.find(g => g.seed.name === 'add')
      expect(addGap).toBeDefined()
      // directDependents should be a superset of unresolvedDependents
      expect(addGap!.directDependents.length).toBeGreaterThanOrEqual(
        addGap!.unresolvedDependents.length,
      )
      // Every unresolved dependent must exist in directDependents
      const directIds = new Set(addGap!.directDependents.map(d => d.id))
      for (const unresolved of addGap!.unresolvedDependents) {
        expect(directIds.has(unresolved.id)).toBe(true)
      }
    }, 30_000)

    it('impact gaps only fire for contract changes (signature, export, deleted)', async () => {
      // body_changed should NOT produce impact gaps
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_BODY_CHANGE,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const computeGap = review.impactGaps.find(g => g.seed.name === 'compute')
      expect(computeGap).toBeUndefined()
    }, 30_000)

    it('impact gaps are sorted by unresolvedDependents.length descending', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      for (let i = 1; i < review.impactGaps.length; i++) {
        expect(review.impactGaps[i].unresolvedDependents.length).toBeLessThanOrEqual(
          review.impactGaps[i - 1].unresolvedDependents.length,
        )
      }
    }, 30_000)
  })

  // ---- Summary content ----

  describe('summary content', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('includes risk counts when risks are present', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const critical = review.risks.filter(r => r.score >= 70).length
      const warnings = review.risks.filter(r => r.score >= 40 && r.score < 70).length

      if (critical > 0) {
        expect(review.summary).toContain('critical risk')
      }
      if (warnings > 0) {
        expect(review.summary).toContain('warning')
      }
    }, 30_000)

    it('includes impact gap info when gaps exist', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      if (review.impactGaps.length > 0) {
        expect(review.summary).toContain('contract gap')
      }
    }, 30_000)

    it('includes dependent counts when blast radius is non-empty', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const direct = review.blastRadius.direct.length
      const transitive = review.blastRadius.transitive.length
      if (direct > 0 || transitive > 0) {
        expect(review.summary).toContain('direct')
        expect(review.summary).toContain('transitive')
      }
    }, 30_000)
  })

  // ---- Connection cleanup ----

  describe('connection cleanup', () => {
    beforeEach(resetSchema)

    it('closes connection after successful execution', async () => {
      await runReview({
        databaseUrl: testDbUrl,
        diffText: '',
        maxDepth: 1,
        sourceRoot: fixtureDir,
        rebuildGraph: true,
      })

      await new Promise(r => setTimeout(r, 300))
      expect(await activeConnectionCount()).toBe(0)
    }, 15_000)

    it('closes connection even when an error is thrown', async () => {
      try {
        await runReview({
          databaseUrl: testDbUrl,
          diffText: '',
          maxDepth: 1,
          rebuildGraph: true,
        })
      } catch {
        // expected — sourceRoot missing
      }

      await new Promise(r => setTimeout(r, 300))
      expect(await activeConnectionCount()).toBe(0)
    }, 15_000)
  })

  // ---- Mutation gap closers ----

  describe('entity_added classification', () => {
    it('classifies new-file entities as entity_added with fileStatus=added', async () => {
      const newFile = join(fixtureDir, 'src', 'newutil.ts')
      await writeFile(newFile, 'export function noop(): void {}\n')
      try {
        await resetSchema()
        const review = await runReview({
          databaseUrl: testDbUrl,
          diffText: DIFF_ADD_NEWUTIL,
          maxDepth: 1,
          sourceRoot: fixtureDir,
          rebuildGraph: true,
        })

        const added = review.changedEntities.filter(ec => ec.changeKind === 'entity_added')
        expect(added.length).toBeGreaterThan(0)
        const noopAdded = added.find(ec => ec.entity.name === 'noop')
        expect(noopAdded).toBeDefined()
        expect(noopAdded!.fileStatus).toBe('added')
      } finally {
        await rm(newFile, { force: true })
      }
    }, 60_000)
  })

  describe('isolated entity (no dependents)', () => {
    // multiply is exported but has zero callers in the fixture graph
    const DIFF_MODIFY_MULTIPLY = [
      'diff --git a/src/math.ts b/src/math.ts',
      'index 1234567..abcdefg 100644',
      '--- a/src/math.ts',
      '+++ b/src/math.ts',
      '@@ -5,3 +5,3 @@',
      ' export function multiply(x: number, y: number): number {',
      '-  return x * y',
      '+  return x * y // perf tweak',
      ' }',
    ].join('\n')

    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('produces zero blast radius for entity with no callers', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_MULTIPLY,
        maxDepth: 2,
        rebuildGraph: false,
      })

      expect(review.blastRadius.direct).toHaveLength(0)
      expect(review.blastRadius.transitive).toHaveLength(0)
      expect(review.blastRadius.totalEntities).toBe(0)
      expect(review.blastRadius.totalFiles).toBe(0)
    }, 30_000)

    it('summary omits direct/transitive text when blast radius is empty', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_MULTIPLY,
        maxDepth: 2,
        rebuildGraph: false,
      })

      expect(review.summary).not.toContain('direct')
      expect(review.summary).not.toContain('transitive')
    }, 30_000)

    it('produces no impact gaps for body_changed on isolated entity', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_MULTIPLY,
        maxDepth: 2,
        rebuildGraph: false,
      })

      expect(review.impactGaps).toHaveLength(0)
    }, 30_000)
  })

  describe('impact gap self-exclusion', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('seed entity is never listed as its own directDependent', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      for (const gap of review.impactGaps) {
        const depIds = gap.directDependents.map(d => d.id)
        expect(depIds).not.toContain(gap.seed.id)
      }
    }, 30_000)

    it('seed entity is never listed as its own unresolvedDependent', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      for (const gap of review.impactGaps) {
        const unresIds = gap.unresolvedDependents.map(d => d.id)
        expect(unresIds).not.toContain(gap.seed.id)
      }
    }, 30_000)
  })

  describe('risk score factors', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('directly changed entity has "directly signature changed" factor', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const addRisk = review.risks.find(r => r.entity.name === 'add')
      expect(addRisk).toBeDefined()
      expect(addRisk!.factors.some(f => f.includes('directly') && f.includes('signature changed'))).toBe(true)
    }, 30_000)

    it('exported directly-changed entity has "exported" factor', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const addRisk = review.risks.find(r => r.entity.name === 'add')
      expect(addRisk).toBeDefined()
      expect(addRisk!.factors.some(f => f.includes('exported'))).toBe(true)
    }, 30_000)

    it('blast-radius dependent has "upstream" factor referencing its seed', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 2,
        rebuildGraph: false,
      })

      const sumRisk = review.risks.find(r => r.entity.name === 'sum')
      expect(sumRisk).toBeDefined()
      expect(sumRisk!.factors.some(f => f.includes('upstream') && f.includes('add'))).toBe(true)
    }, 30_000)

    it('body_changed scores lower than signature_changed for same entity kind', async () => {
      // Run both diffs against the same graph and compare scores for the changed entity
      const sigReview = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 1,
        rebuildGraph: false,
      })

      const bodyReview = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_BODY_CHANGE,
        maxDepth: 1,
        rebuildGraph: false,
      })

      const sigScore = sigReview.risks.find(r => r.entity.name === 'add')?.score ?? 0
      const bodyScore = bodyReview.risks.find(r => r.entity.name === 'compute')?.score ?? 0
      expect(sigScore).toBeGreaterThan(bodyScore)
    }, 30_000)
  })

  describe('dead code structural integrity', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('deadCode array contains no duplicate entity IDs', async () => {
      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 1,
        rebuildGraph: false,
      })

      const ids = review.deadCode.map(e => e.id)
      expect(ids.length).toBe(new Set(ids).size)
    }, 30_000)
  })

  describe('rebuildGraph omitted', () => {
    it('treats missing rebuildGraph as non-rebuild (preserves existing data)', async () => {
      await resetSchema()
      await buildGraph()
      await insertSentinel()

      await runReview({
        databaseUrl: testDbUrl,
        diffText: DIFF_MODIFY_ADD,
        maxDepth: 1,
        // rebuildGraph intentionally omitted
      })

      expect(await sentinelExists()).toBe(true)
    }, 60_000)
  })

  describe('modified file with no hunks', () => {
    beforeAll(async () => {
      await resetSchema()
      await buildGraph()
    }, 60_000)

    it('produces no changedEntities for file header without hunk lines', async () => {
      const hunklessDiff = [
        'diff --git a/src/math.ts b/src/math.ts',
        'index 1234567..abcdefg 100644',
      ].join('\n')

      const review = await runReview({
        databaseUrl: testDbUrl,
        diffText: hunklessDiff,
        maxDepth: 1,
        rebuildGraph: false,
      })

      expect(review.changedEntities).toHaveLength(0)
    }, 15_000)
  })
})
