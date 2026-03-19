/**
 * Defended contracts:
 * - ace8be41: Verification must group contracts by testFilePath and execute one test run per unique file
 * - 18a25b17: Verification must only target contracts with status 'dirty' or 'failing' AND a non-null testFilePath
 * - 7a05b02d: When any verification condition fails, contract transitions to 'failing' and a violation record is created (only if no open violation exists)
 * - 6115fb49: When all conditions pass, contract transitions to 'passing' and all open violations are resolved
 * - e5391d07: Violations are durable records — passing resolves (resolved_at set), never deletes
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'crypto'
import { verifyContracts, type TestRunner } from 'entity-graph/contracts/verify.js'
import { contractById, violationsForContract, createViolation } from 'entity-graph/contracts/queries.js'
import { SCHEMA_DDL } from 'entity-graph/schema.js'

// ---------------------------------------------------------------------------
// Test DB isolation
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/agent_memory'

const TEST_DB_NAME = `test_verify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

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

const CONTRACT_DIRTY_A = randomUUID()
const CONTRACT_DIRTY_B = randomUUID() // same testFilePath as A (for grouping test)
const CONTRACT_FAILING = randomUUID()
const CONTRACT_PASSING = randomUUID()
const CONTRACT_INSUFFICIENT = randomUUID()
const CONTRACT_NO_TEST_PATH = randomUUID()
const NOW = new Date().toISOString()

async function seedContracts() {
  await sql`DELETE FROM entity_graph.contract_violations`
  await sql`DELETE FROM entity_graph.contract_entity_links`
  await sql`DELETE FROM entity_graph.contracts`
  await sql`INSERT INTO entity_graph.contracts
    (id, statement, type, source, status, confidence, test_file_path, created_at, updated_at) VALUES
    (${CONTRACT_DIRTY_A}, 'dirty contract A', 'guarantee', 'event', 'dirty', 0.9, 'tests/shared.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_DIRTY_B}, 'dirty contract B', 'invariant', 'event', 'dirty', 0.8, 'tests/shared.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_FAILING}, 'failing contract', 'postcondition', 'compiled', 'failing', 0.7, 'tests/failing.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_PASSING}, 'passing contract', 'guarantee', 'event', 'passing', 1.0, 'tests/passing.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_INSUFFICIENT}, 'insufficient contract', 'assumption', 'interview', 'insufficient', 0.5, 'tests/insuf.test.ts', ${NOW}, ${NOW}),
    (${CONTRACT_NO_TEST_PATH}, 'no test path', 'invariant', 'event', 'dirty', 0.9, ${null}, ${NOW}, ${NOW})
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
  await seedContracts()
})

// ---------------------------------------------------------------------------
// Test runners (system boundary stubs)
// ---------------------------------------------------------------------------

const alwaysPass: TestRunner = async () => ({ passed: true, output: '' })
const alwaysFail: TestRunner = async () => ({ passed: false, output: 'assertion failed: expected 3 got 4' })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyContracts', () => {
  it('only targets dirty and failing contracts with non-null testFilePath', async () => {
    // Contract 18a25b17: passing, insufficient, and null-testFilePath must be excluded
    const filesRun: string[] = []
    const trackingRunner: TestRunner = async (file) => {
      filesRun.push(file)
      return { passed: true, output: '' }
    }

    await verifyContracts(sql, trackingRunner)

    // Should run tests/shared.test.ts (DIRTY_A + DIRTY_B) and tests/failing.test.ts (FAILING)
    // Should NOT run tests/passing.test.ts or tests/insuf.test.ts
    expect(filesRun.sort()).toEqual(['tests/failing.test.ts', 'tests/shared.test.ts'])
  })

  it('groups contracts by testFilePath — runs each unique file once', async () => {
    // Contract ace8be41: one test run per unique file
    let runCount = 0
    const countingRunner: TestRunner = async () => {
      runCount++
      return { passed: true, output: '' }
    }

    const result = await verifyContracts(sql, countingRunner)

    // 2 unique files: tests/shared.test.ts, tests/failing.test.ts
    expect(runCount).toBe(2)
    // But 3 contracts total (DIRTY_A, DIRTY_B share a file, + FAILING)
    expect(result.total).toBe(3)
  })

  it('transitions contracts to passing on test pass', async () => {
    await verifyContracts(sql, alwaysPass)

    const a = await contractById(sql, CONTRACT_DIRTY_A)
    const b = await contractById(sql, CONTRACT_DIRTY_B)
    const f = await contractById(sql, CONTRACT_FAILING)

    expect(a!.status).toBe('passing')
    expect(b!.status).toBe('passing')
    expect(f!.status).toBe('passing')
  })

  it('transitions contracts to failing on test fail', async () => {
    await verifyContracts(sql, alwaysFail)

    const a = await contractById(sql, CONTRACT_DIRTY_A)
    const b = await contractById(sql, CONTRACT_DIRTY_B)

    expect(a!.status).toBe('failing')
    expect(b!.status).toBe('failing')
  })

  it('does not change passing or insufficient contracts', async () => {
    await verifyContracts(sql, alwaysFail)

    const passing = await contractById(sql, CONTRACT_PASSING)
    const insufficient = await contractById(sql, CONTRACT_INSUFFICIENT)
    const noPath = await contractById(sql, CONTRACT_NO_TEST_PATH)

    expect(passing!.status).toBe('passing')
    expect(insufficient!.status).toBe('insufficient')
    expect(noPath!.status).toBe('dirty')
  })

  it('creates violation records on failure', async () => {
    // Contract 7a05b02d
    await verifyContracts(sql, alwaysFail)

    const violationsA = await violationsForContract(sql, CONTRACT_DIRTY_A)
    expect(violationsA.length).toBe(1)
    expect(violationsA[0].testFilePath).toBe('tests/shared.test.ts')
    expect(violationsA[0].testOutput).toBe('assertion failed: expected 3 got 4')
    expect(violationsA[0].resolvedAt).toBeNull()

    const violationsB = await violationsForContract(sql, CONTRACT_DIRTY_B)
    expect(violationsB.length).toBe(1)
  })

  it('does not create duplicate violation if open violation already exists', async () => {
    // Contract 7a05b02d: "only if no open (unresolved) violation already exists"
    // Pre-create an open violation for DIRTY_A
    await createViolation(sql, CONTRACT_DIRTY_A, 'tests/shared.test.ts', 'prior failure')

    await verifyContracts(sql, alwaysFail)

    const violations = await violationsForContract(sql, CONTRACT_DIRTY_A)
    // Should still be 1 (the pre-existing one), not 2
    expect(violations.length).toBe(1)
    expect(violations[0].testOutput).toBe('prior failure')
  })

  it('resolves open violations on pass', async () => {
    // Contract 6115fb49 + e5391d07: passing resolves (set resolved_at), never deletes
    // Pre-create open violations
    await createViolation(sql, CONTRACT_DIRTY_A, 'tests/shared.test.ts', 'old failure')
    await createViolation(sql, CONTRACT_DIRTY_B, 'tests/shared.test.ts', 'old failure')

    await verifyContracts(sql, alwaysPass)

    // Violations should still exist (not deleted) but be resolved
    const violationsA = await violationsForContract(sql, CONTRACT_DIRTY_A)
    expect(violationsA.length).toBe(1)
    expect(violationsA[0].resolvedAt).not.toBeNull()

    const violationsB = await violationsForContract(sql, CONTRACT_DIRTY_B)
    expect(violationsB.length).toBe(1)
    expect(violationsB[0].resolvedAt).not.toBeNull()
  })

  it('returns correct summary counts', async () => {
    const fileResults = new Map<string, boolean>([
      ['tests/shared.test.ts', true],
      ['tests/failing.test.ts', false],
    ])
    const mixedRunner: TestRunner = async (file) => ({
      passed: fileResults.get(file) ?? false,
      output: fileResults.get(file) ? '' : 'failed',
    })

    const result = await verifyContracts(sql, mixedRunner)

    expect(result.total).toBe(3)
    expect(result.passed).toBe(2) // DIRTY_A + DIRTY_B (shared file passes)
    expect(result.failed).toBe(1) // FAILING (failing.test.ts fails)
  })

  it('returns violation details in result', async () => {
    const result = await verifyContracts(sql, alwaysFail)

    expect(result.violations.length).toBe(3)
    for (const v of result.violations) {
      expect(v.contractId).toBeTruthy()
      expect(v.statement).toBeTruthy()
      expect(v.testFilePath).toBeTruthy()
      expect(v.output).toBe('assertion failed: expected 3 got 4')
    }
  })

  it('returns empty result when no contracts are verifiable', async () => {
    // Remove all dirty/failing contracts
    await sql`UPDATE entity_graph.contracts SET status = 'passing'`

    const result = await verifyContracts(sql, alwaysPass)
    expect(result).toEqual({ total: 0, passed: 0, failed: 0, violations: [] })
  })
})
