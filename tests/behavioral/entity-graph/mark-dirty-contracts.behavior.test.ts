/**
 * Defended contracts:
 * - 8df2b58b: When a linked entity changes, contracts in 'passing' or 'failing' state must transition to 'dirty'
 * - 64fc6083: When a linked entity changes, contracts already in 'dirty' or 'insufficient' state must NOT be re-marked or have their status altered
 * - 4071c65f: A contract with status 'insufficient' must never transition to another state as a result of entity change events
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'crypto'
import { markDirtyContracts } from 'entity-graph/contracts/staleness.js'
import { contractById } from 'entity-graph/contracts/queries.js'
import { SCHEMA_DDL } from 'entity-graph/schema.js'

// ---------------------------------------------------------------------------
// Test DB isolation
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/agent_memory'

const TEST_DB_NAME = `test_stale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function dbUrl(dbName: string): string {
  const u = new URL(BASE_URL)
  u.pathname = `/${dbName}`
  return u.toString()
}

let adminSql: ReturnType<typeof postgres>
let sql: ReturnType<typeof postgres>

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const ENTITY_CHANGED = 'function:src/foo.ts:doFoo'
const ENTITY_UNRELATED = 'function:src/bar.ts:doBar'

const CONTRACT_PASSING = randomUUID()
const CONTRACT_FAILING = randomUUID()
const CONTRACT_DIRTY = randomUUID()
const CONTRACT_INSUFFICIENT = randomUUID()
const CONTRACT_UNLINKED = randomUUID()
const NOW = new Date().toISOString()

async function seedAll() {
  await sql`DELETE FROM entity_graph.contract_entity_links`
  await sql`DELETE FROM entity_graph.contracts`
  await sql`DELETE FROM entity_graph.entities`

  // Seed entities
  await sql`INSERT INTO entity_graph.entities (id, kind, name, filepath, exported) VALUES
    (${ENTITY_CHANGED}, 'function', 'doFoo', 'src/foo.ts', true),
    (${ENTITY_UNRELATED}, 'function', 'doBar', 'src/bar.ts', true)
  `

  // Seed contracts with all four statuses, all linked to ENTITY_CHANGED
  await sql`INSERT INTO entity_graph.contracts
    (id, statement, type, source, status, confidence, test_file_path, created_at, updated_at) VALUES
    (${CONTRACT_PASSING}, 'passing contract', 'guarantee', 'event', 'passing', 1.0, 'tests/p.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_FAILING}, 'failing contract', 'postcondition', 'compiled', 'failing', 0.7, 'tests/f.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_DIRTY}, 'dirty contract', 'invariant', 'event', 'dirty', 0.9, 'tests/d.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_INSUFFICIENT}, 'insufficient contract', 'assumption', 'interview', 'insufficient', 0.5, ${null}, ${NOW}, ${NOW}),
    (${CONTRACT_UNLINKED}, 'unlinked contract', 'guarantee', 'event', 'passing', 1.0, 'tests/u.test.ts', ${NOW}, ${NOW})
  `

  // Link contracts to ENTITY_CHANGED (except UNLINKED which links to UNRELATED)
  await sql`INSERT INTO entity_graph.contract_entity_links (contract_id, entity_id, role) VALUES
    (${CONTRACT_PASSING}, ${ENTITY_CHANGED}, 'subject'),
    (${CONTRACT_FAILING}, ${ENTITY_CHANGED}, 'subject'),
    (${CONTRACT_DIRTY}, ${ENTITY_CHANGED}, 'subject'),
    (${CONTRACT_INSUFFICIENT}, ${ENTITY_CHANGED}, 'subject'),
    (${CONTRACT_UNLINKED}, ${ENTITY_UNRELATED}, 'subject')
  `
}

beforeAll(async () => {
  adminSql = postgres(BASE_URL, { max: 2, connect_timeout: 10 })
  await adminSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`)
  await adminSql.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`)

  sql = postgres(dbUrl(TEST_DB_NAME), { max: 4, connect_timeout: 10 })
  await sql.unsafe(SCHEMA_DDL)
}, 30_000)

afterAll(async () => {
  await sql?.end()
  if (adminSql) {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`)
    await adminSql.end()
  }
})

beforeEach(async () => {
  await seedAll()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('markDirtyContracts', () => {
  it('transitions passing contracts to dirty when linked entity changes', async () => {
    // Contract 8df2b58b
    const count = await markDirtyContracts(sql, [ENTITY_CHANGED])

    const contract = await contractById(sql, CONTRACT_PASSING)
    expect(contract!.status).toBe('dirty')
    expect(count).toBeGreaterThanOrEqual(1)
  })

  it('transitions failing contracts to dirty when linked entity changes', async () => {
    // Contract 8df2b58b
    await markDirtyContracts(sql, [ENTITY_CHANGED])

    const contract = await contractById(sql, CONTRACT_FAILING)
    expect(contract!.status).toBe('dirty')
  })

  it('does NOT alter dirty contracts when linked entity changes', async () => {
    // Contract 64fc6083
    const beforeDirty = await contractById(sql, CONTRACT_DIRTY)
    const beforeUpdatedAt = beforeDirty!.updatedAt

    await markDirtyContracts(sql, [ENTITY_CHANGED])

    const after = await contractById(sql, CONTRACT_DIRTY)
    expect(after!.status).toBe('dirty')
    // updated_at should not change since it was excluded from the UPDATE
    expect(after!.updatedAt).toBe(beforeUpdatedAt)
  })

  it('does NOT alter insufficient contracts when linked entity changes', async () => {
    // Contract 4071c65f: insufficient must never transition from entity change events
    const before = await contractById(sql, CONTRACT_INSUFFICIENT)

    await markDirtyContracts(sql, [ENTITY_CHANGED])

    const after = await contractById(sql, CONTRACT_INSUFFICIENT)
    expect(after!.status).toBe('insufficient')
    expect(after!.updatedAt).toBe(before!.updatedAt)
  })

  it('does NOT affect contracts linked to unrelated entities', async () => {
    await markDirtyContracts(sql, [ENTITY_CHANGED])

    const unlinked = await contractById(sql, CONTRACT_UNLINKED)
    expect(unlinked!.status).toBe('passing')
  })

  it('returns count of transitioned contracts', async () => {
    const count = await markDirtyContracts(sql, [ENTITY_CHANGED])
    // Only passing + failing should transition (2 contracts)
    expect(count).toBe(2)
  })

  it('returns 0 for empty changed entity list', async () => {
    const count = await markDirtyContracts(sql, [])
    expect(count).toBe(0)
  })

  it('returns 0 when no contracts are linked to changed entities', async () => {
    const count = await markDirtyContracts(sql, ['function:src/nonexistent.ts:nope'])
    expect(count).toBe(0)
  })

  it('handles multiple changed entities at once', async () => {
    const count = await markDirtyContracts(sql, [ENTITY_CHANGED, ENTITY_UNRELATED])

    const passing = await contractById(sql, CONTRACT_PASSING)
    const unlinked = await contractById(sql, CONTRACT_UNLINKED)

    expect(passing!.status).toBe('dirty')
    expect(unlinked!.status).toBe('dirty')
    // passing + failing + unlinked = 3 transitioned
    expect(count).toBe(3)
  })
})
