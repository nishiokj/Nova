/**
 * Defended contracts:
 * - 1fd0d598: recordVerdicts() must be called after test execution for every contract whose testFilePath was included in the test run
 * - 7a05b02d: When any verification condition for a contract fails, the contract transitions to 'failing' (violation creation is in verifyContracts, not this boundary)
 * - 6115fb49: When all verification conditions for a contract pass, the contract transitions to 'passing' (violation resolution is in verifyContracts, not this boundary)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'crypto'
import { recordVerdicts, type VerdictInput } from 'entity-graph/contracts/compilation.js'
import { contractById } from 'entity-graph/contracts/queries.js'
import { SCHEMA_DDL } from 'entity-graph/schema.js'

// ---------------------------------------------------------------------------
// Test DB isolation
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/agent_memory'

const TEST_DB_NAME = `test_rv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

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

const CONTRACT_A = randomUUID()
const CONTRACT_B = randomUUID()
const CONTRACT_C = randomUUID()
const NOW = new Date().toISOString()

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
  // Reset contracts to known state before each test
  await sql`DELETE FROM entity_graph.contracts`
  await sql`INSERT INTO entity_graph.contracts
    (id, statement, type, source, status, confidence, test_file_path, created_at, updated_at) VALUES
    (${CONTRACT_A}, 'contract A', 'guarantee', 'event', 'dirty', 0.9, 'tests/a.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_B}, 'contract B', 'invariant', 'compiled', 'dirty', 1.0, 'tests/b.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_C}, 'contract C', 'postcondition', 'event', 'failing', 0.8, 'tests/c.test.ts', ${NOW}, ${NOW})
  `
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recordVerdicts', () => {
  it('returns { updated: 0 } for empty verdicts array', async () => {
    const result = await recordVerdicts(sql, [])
    expect(result).toEqual({ updated: 0 })
  })

  it('transitions contract to passing on pass verdict', async () => {
    const verdicts: VerdictInput[] = [{ inv_id: CONTRACT_A, verdict: 'pass' }]
    await recordVerdicts(sql, verdicts)

    const contract = await contractById(sql, CONTRACT_A)
    expect(contract!.status).toBe('passing')
  })

  it('transitions contract to failing on fail verdict', async () => {
    const verdicts: VerdictInput[] = [{ inv_id: CONTRACT_A, verdict: 'fail' }]
    await recordVerdicts(sql, verdicts)

    const contract = await contractById(sql, CONTRACT_A)
    expect(contract!.status).toBe('failing')
  })

  it('does not change status on error verdict', async () => {
    const verdicts: VerdictInput[] = [{ inv_id: CONTRACT_A, verdict: 'error' }]
    await recordVerdicts(sql, verdicts)

    const contract = await contractById(sql, CONTRACT_A)
    expect(contract!.status).toBe('dirty') // unchanged
  })

  it('does not change status on skipped verdict', async () => {
    const verdicts: VerdictInput[] = [{ inv_id: CONTRACT_B, verdict: 'skipped' }]
    await recordVerdicts(sql, verdicts)

    const contract = await contractById(sql, CONTRACT_B)
    expect(contract!.status).toBe('dirty') // unchanged
  })

  it('records lastVerdict and lastVerdictAt for all verdict types', async () => {
    const verdicts: VerdictInput[] = [
      { inv_id: CONTRACT_A, verdict: 'pass' },
      { inv_id: CONTRACT_B, verdict: 'error' },
      { inv_id: CONTRACT_C, verdict: 'skipped' },
    ]
    await recordVerdicts(sql, verdicts)

    const a = await contractById(sql, CONTRACT_A)
    const b = await contractById(sql, CONTRACT_B)
    const c = await contractById(sql, CONTRACT_C)

    expect(a!.lastVerdict).toBe('pass')
    expect(a!.lastVerdictAt).not.toBeNull()

    expect(b!.lastVerdict).toBe('error')
    expect(b!.lastVerdictAt).not.toBeNull()

    expect(c!.lastVerdict).toBe('skipped')
    expect(c!.lastVerdictAt).not.toBeNull()
  })

  it('processes multiple verdicts in a single call', async () => {
    const verdicts: VerdictInput[] = [
      { inv_id: CONTRACT_A, verdict: 'pass' },
      { inv_id: CONTRACT_B, verdict: 'fail' },
    ]
    const result = await recordVerdicts(sql, verdicts)

    expect(result.updated).toBe(2)

    const a = await contractById(sql, CONTRACT_A)
    const b = await contractById(sql, CONTRACT_B)
    expect(a!.status).toBe('passing')
    expect(b!.status).toBe('failing')
  })

  it('skips non-existent contract IDs without error', async () => {
    const fakeId = randomUUID()
    const verdicts: VerdictInput[] = [
      { inv_id: fakeId, verdict: 'pass' },
      { inv_id: CONTRACT_A, verdict: 'fail' },
    ]
    const result = await recordVerdicts(sql, verdicts)

    // Only 1 updated (the existing one)
    expect(result.updated).toBe(1)

    const a = await contractById(sql, CONTRACT_A)
    expect(a!.status).toBe('failing')
  })

  it('counts only existing contracts in updated total', async () => {
    const fakeId1 = randomUUID()
    const fakeId2 = randomUUID()
    const verdicts: VerdictInput[] = [
      { inv_id: fakeId1, verdict: 'pass' },
      { inv_id: fakeId2, verdict: 'fail' },
      { inv_id: CONTRACT_C, verdict: 'pass' },
    ]
    const result = await recordVerdicts(sql, verdicts)

    expect(result.updated).toBe(1)
    const c = await contractById(sql, CONTRACT_C)
    expect(c!.status).toBe('passing')
  })

  it('sets all lastVerdictAt timestamps to the same run time', async () => {
    const verdicts: VerdictInput[] = [
      { inv_id: CONTRACT_A, verdict: 'pass' },
      { inv_id: CONTRACT_B, verdict: 'fail' },
    ]
    await recordVerdicts(sql, verdicts)

    const a = await contractById(sql, CONTRACT_A)
    const b = await contractById(sql, CONTRACT_B)

    // Both should have the same lastVerdictAt since they were recorded in the same call
    expect(a!.lastVerdictAt).toBe(b!.lastVerdictAt)
  })
})
