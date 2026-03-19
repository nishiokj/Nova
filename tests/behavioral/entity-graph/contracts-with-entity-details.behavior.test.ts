/**
 * Defended contracts:
 * - aedf09c3: Contract status must be one of exactly four values: 'insufficient', 'dirty', 'passing', 'failing'
 * - 1707f919: The entity_graph.contracts table is the authoritative source for contract data
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'crypto'
import { contractsWithEntityDetails } from 'entity-graph/contracts/queries.js'
import { SCHEMA_DDL } from 'entity-graph/schema.js'

// ---------------------------------------------------------------------------
// Test DB isolation: unique database per file, dropped on teardown
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/agent_memory'

const TEST_DB_NAME = `test_cwed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function dbUrl(dbName: string): string {
  const u = new URL(BASE_URL)
  u.pathname = `/${dbName}`
  return u.toString()
}

let adminSql: ReturnType<typeof postgres>
let sql: ReturnType<typeof postgres>

// ---------------------------------------------------------------------------
// Seed data IDs
// ---------------------------------------------------------------------------

const CONTRACT_INSUFFICIENT = randomUUID()
const CONTRACT_DIRTY = randomUUID()
const CONTRACT_PASSING = randomUUID()
const CONTRACT_FAILING = randomUUID()
const CONTRACT_NO_LINKS = randomUUID()

const ENTITY_A = 'function:src/foo.ts:doStuff'
const ENTITY_B = 'function:src/bar.ts:handleBar'
const ENTITY_C = 'class:src/baz.ts:BazService'

const NOW = new Date().toISOString()

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  adminSql = postgres(BASE_URL, { max: 2, connect_timeout: 10 })
  await adminSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`)
  await adminSql.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`)

  sql = postgres(dbUrl(TEST_DB_NAME), { max: 4, connect_timeout: 10 })
  await sql.unsafe(SCHEMA_DDL)

  // Seed contracts with all four statuses, different types and sources
  await sql`INSERT INTO entity_graph.contracts
    (id, statement, type, source, status, confidence, test_file_path, created_at, updated_at) VALUES
    (${CONTRACT_INSUFFICIENT}, 'must validate input', 'precondition', 'interview', 'insufficient', 0.9, ${null}, ${NOW}, ${NOW}),
    (${CONTRACT_DIRTY}, 'returns correct total', 'guarantee', 'event', 'dirty', 0.85, 'tests/foo.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_PASSING}, 'never loses data', 'invariant', 'compiled', 'passing', 1.0, 'tests/bar.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_FAILING}, 'handles timeout', 'postcondition', 'incident', 'failing', 0.7, 'tests/baz.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_NO_LINKS}, 'standalone contract', 'assumption', 'event', 'dirty', 0.5, ${null}, ${NOW}, ${NOW})
  `

  // Seed entity links (CONTRACT_NO_LINKS intentionally has none)
  await sql`INSERT INTO entity_graph.contract_entity_links (contract_id, entity_id, role) VALUES
    (${CONTRACT_INSUFFICIENT}, ${ENTITY_A}, 'subject'),
    (${CONTRACT_DIRTY}, ${ENTITY_A}, 'subject'),
    (${CONTRACT_DIRTY}, ${ENTITY_B}, 'dependency'),
    (${CONTRACT_PASSING}, ${ENTITY_B}, 'subject'),
    (${CONTRACT_PASSING}, ${ENTITY_C}, 'context'),
    (${CONTRACT_FAILING}, ${ENTITY_C}, 'subject')
  `
}, 30_000)

afterAll(async () => {
  await sql?.end()
  if (adminSql) {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`)
    await adminSql.end()
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contractsWithEntityDetails', () => {
  it('returns all contracts with entity links when no filters provided', async () => {
    const result = await contractsWithEntityDetails(sql)

    expect(result.length).toBe(5)

    const ids = result.map(c => c.id)
    expect(ids).toContain(CONTRACT_INSUFFICIENT)
    expect(ids).toContain(CONTRACT_DIRTY)
    expect(ids).toContain(CONTRACT_PASSING)
    expect(ids).toContain(CONTRACT_FAILING)
    expect(ids).toContain(CONTRACT_NO_LINKS)
  })

  it('enriches each contract with its entity links', async () => {
    const result = await contractsWithEntityDetails(sql)
    const byId = new Map(result.map(c => [c.id, c]))

    const dirty = byId.get(CONTRACT_DIRTY)!
    expect(dirty.entityLinks).toHaveLength(2)
    expect(dirty.entityLinks).toEqual(
      expect.arrayContaining([
        { contractId: CONTRACT_DIRTY, entityId: ENTITY_A, role: 'subject' },
        { contractId: CONTRACT_DIRTY, entityId: ENTITY_B, role: 'dependency' },
      ]),
    )

    const passing = byId.get(CONTRACT_PASSING)!
    expect(passing.entityLinks).toHaveLength(2)
    expect(passing.entityLinks).toEqual(
      expect.arrayContaining([
        { contractId: CONTRACT_PASSING, entityId: ENTITY_B, role: 'subject' },
        { contractId: CONTRACT_PASSING, entityId: ENTITY_C, role: 'context' },
      ]),
    )

    const noLinks = byId.get(CONTRACT_NO_LINKS)!
    expect(noLinks.entityLinks).toEqual([])
  })

  it('maps all contract fields correctly from DB rows', async () => {
    const result = await contractsWithEntityDetails(sql)
    const insufficient = result.find(c => c.id === CONTRACT_INSUFFICIENT)!

    expect(insufficient.statement).toBe('must validate input')
    expect(insufficient.type).toBe('precondition')
    expect(insufficient.source).toBe('interview')
    expect(insufficient.status).toBe('insufficient')
    expect(insufficient.confidence).toBe(0.9)
    expect(insufficient.testFilePath).toBeNull()
    expect(insufficient.createdAt).toBe(NOW)
    expect(insufficient.updatedAt).toBe(NOW)
  })

  it('filters by status', async () => {
    const result = await contractsWithEntityDetails(sql, { status: 'passing' })

    expect(result.length).toBe(1)
    expect(result[0].id).toBe(CONTRACT_PASSING)
    expect(result[0].status).toBe('passing')
  })

  it('filters by type', async () => {
    const result = await contractsWithEntityDetails(sql, { type: 'guarantee' })

    expect(result.length).toBe(1)
    expect(result[0].id).toBe(CONTRACT_DIRTY)
    expect(result[0].type).toBe('guarantee')
  })

  it('filters by source', async () => {
    const result = await contractsWithEntityDetails(sql, { source: 'event' })

    expect(result.length).toBe(2)
    const ids = result.map(c => c.id)
    expect(ids).toContain(CONTRACT_DIRTY)
    expect(ids).toContain(CONTRACT_NO_LINKS)
  })

  it('filters by combined status + type', async () => {
    const result = await contractsWithEntityDetails(sql, {
      status: 'dirty',
      type: 'guarantee',
    })

    expect(result.length).toBe(1)
    expect(result[0].id).toBe(CONTRACT_DIRTY)
  })

  it('filters by combined status + type + source', async () => {
    const result = await contractsWithEntityDetails(sql, {
      status: 'dirty',
      type: 'guarantee',
      source: 'event',
    })

    expect(result.length).toBe(1)
    expect(result[0].id).toBe(CONTRACT_DIRTY)
  })

  it('returns empty array when no contracts match filter', async () => {
    const result = await contractsWithEntityDetails(sql, { status: 'passing', type: 'precondition' })

    expect(result).toEqual([])
  })

  it('returns only valid contract statuses from the four-value enum', async () => {
    // Contract aedf09c3: status must be one of exactly four values
    const result = await contractsWithEntityDetails(sql)
    const validStatuses = new Set(['insufficient', 'dirty', 'passing', 'failing'])

    for (const contract of result) {
      expect(validStatuses.has(contract.status)).toBe(true)
    }

    const observedStatuses = new Set(result.map(c => c.status))
    expect(observedStatuses).toEqual(validStatuses)
  })

  it('reads from the authoritative contracts table, not derived state', async () => {
    // Contract 1707f919: the DB table is the authoritative source
    // Mutate a contract directly in the DB, then verify the function reflects the change
    const newStatement = `mutated-${randomUUID()}`
    await sql`UPDATE entity_graph.contracts SET statement = ${newStatement} WHERE id = ${CONTRACT_FAILING}`

    const result = await contractsWithEntityDetails(sql, { status: 'failing' })
    expect(result.length).toBe(1)
    expect(result[0].statement).toBe(newStatement)

    // Restore
    await sql`UPDATE entity_graph.contracts SET statement = 'handles timeout' WHERE id = ${CONTRACT_FAILING}`
  })

  it('returns contracts ordered by updated_at DESC', async () => {
    // Update one contract to make it most recent
    const later = new Date(Date.now() + 60_000).toISOString()
    await sql`UPDATE entity_graph.contracts SET updated_at = ${later} WHERE id = ${CONTRACT_INSUFFICIENT}`

    const result = await contractsWithEntityDetails(sql)
    expect(result[0].id).toBe(CONTRACT_INSUFFICIENT)

    // Restore
    await sql`UPDATE entity_graph.contracts SET updated_at = ${NOW} WHERE id = ${CONTRACT_INSUFFICIENT}`
  })
})
