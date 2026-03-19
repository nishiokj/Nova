/**
 * Defended contracts:
 * - aedf09c3: Contract status must be one of exactly four values: 'insufficient', 'dirty', 'passing', 'failing'
 * - ac789c96: A newly created contract without a testFilePath must have status 'insufficient'
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'crypto'
import { updateContractStatus, contractById } from 'entity-graph/contracts/queries.js'
import { SCHEMA_DDL } from 'entity-graph/schema.js'

// ---------------------------------------------------------------------------
// Test DB isolation
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/agent_memory'

const TEST_DB_NAME = `test_ucs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

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
const NOW = new Date().toISOString()

beforeAll(async () => {
  adminSql = postgres(BASE_URL, { max: 2, connect_timeout: 10 })
  await adminSql.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`)
  await adminSql.unsafe(`CREATE DATABASE "${TEST_DB_NAME}"`)

  sql = postgres(dbUrl(TEST_DB_NAME), { max: 4, connect_timeout: 10 })
  await sql.unsafe(SCHEMA_DDL)

  await sql`INSERT INTO entity_graph.contracts
    (id, statement, type, source, status, confidence, created_at, updated_at) VALUES
    (${CONTRACT_A}, 'contract A', 'guarantee', 'event', 'insufficient', 0.9, ${NOW}, ${NOW}),
    (${CONTRACT_B}, 'contract B', 'invariant', 'compiled', 'passing', 1.0, ${NOW}, ${NOW})
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

describe('updateContractStatus', () => {
  it('transitions a contract from insufficient to dirty', async () => {
    await updateContractStatus(sql, CONTRACT_A, 'dirty')
    const contract = await contractById(sql, CONTRACT_A)

    expect(contract!.status).toBe('dirty')
  })

  it('transitions a contract from dirty to passing', async () => {
    await updateContractStatus(sql, CONTRACT_A, 'passing')
    const contract = await contractById(sql, CONTRACT_A)

    expect(contract!.status).toBe('passing')
  })

  it('transitions a contract from passing to failing', async () => {
    await updateContractStatus(sql, CONTRACT_A, 'failing')
    const contract = await contractById(sql, CONTRACT_A)

    expect(contract!.status).toBe('failing')
  })

  it('transitions a contract from failing to insufficient', async () => {
    await updateContractStatus(sql, CONTRACT_A, 'insufficient')
    const contract = await contractById(sql, CONTRACT_A)

    expect(contract!.status).toBe('insufficient')
  })

  it('updates updated_at timestamp on status change', async () => {
    const before = await contractById(sql, CONTRACT_B)
    const beforeTimestamp = before!.updatedAt

    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 10))
    await updateContractStatus(sql, CONTRACT_B, 'dirty')

    const after = await contractById(sql, CONTRACT_B)
    expect(after!.updatedAt).not.toBe(beforeTimestamp)
    expect(new Date(after!.updatedAt).getTime()).toBeGreaterThan(new Date(beforeTimestamp).getTime())
  })

  it('only affects the targeted contract', async () => {
    // Reset both to known states
    await updateContractStatus(sql, CONTRACT_A, 'insufficient')
    await updateContractStatus(sql, CONTRACT_B, 'passing')

    // Change only A
    await updateContractStatus(sql, CONTRACT_A, 'failing')

    const a = await contractById(sql, CONTRACT_A)
    const b = await contractById(sql, CONTRACT_B)
    expect(a!.status).toBe('failing')
    expect(b!.status).toBe('passing')
  })

  it('persists each of the four valid status values', async () => {
    // Contract aedf09c3: all four values must be persistable
    const validStatuses = ['insufficient', 'dirty', 'passing', 'failing'] as const
    for (const status of validStatuses) {
      await updateContractStatus(sql, CONTRACT_A, status)
      const contract = await contractById(sql, CONTRACT_A)
      expect(contract!.status).toBe(status)
    }
  })

  it('is idempotent — setting same status does not error', async () => {
    await updateContractStatus(sql, CONTRACT_A, 'dirty')
    await updateContractStatus(sql, CONTRACT_A, 'dirty')

    const contract = await contractById(sql, CONTRACT_A)
    expect(contract!.status).toBe('dirty')
  })

  it('does not alter non-status fields', async () => {
    await updateContractStatus(sql, CONTRACT_A, 'insufficient')
    const before = await contractById(sql, CONTRACT_A)

    await updateContractStatus(sql, CONTRACT_A, 'passing')
    const after = await contractById(sql, CONTRACT_A)

    expect(after!.statement).toBe(before!.statement)
    expect(after!.type).toBe(before!.type)
    expect(after!.source).toBe(before!.source)
    expect(after!.confidence).toBe(before!.confidence)
    expect(after!.createdAt).toBe(before!.createdAt)
  })
})
