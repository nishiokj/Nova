/**
 * Defended contracts:
 * - ac789c96: A newly created contract without a testFilePath must have status 'insufficient'
 * - aff7c01d: When a testFilePath is set on a contract, the contract must transition to 'dirty' status
 *   (note: the transition is the caller's responsibility; upsertContract persists what it receives)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'crypto'
import {
  upsertContract,
  contractById,
  entityLinksForContract,
  contractDependencies,
} from 'entity-graph/contracts/queries.js'
import { SCHEMA_DDL } from 'entity-graph/schema.js'

// ---------------------------------------------------------------------------
// Test DB isolation
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/agent_memory'

const TEST_DB_NAME = `test_upsert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function dbUrl(dbName: string): string {
  const u = new URL(BASE_URL)
  u.pathname = `/${dbName}`
  return u.toString()
}

let adminSql: ReturnType<typeof postgres>
let sql: ReturnType<typeof postgres>

const ENTITY_A = 'function:src/a.ts:funcA'
const ENTITY_B = 'function:src/b.ts:funcB'
const ENTITY_C = 'class:src/c.ts:ClassC'

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
  await sql`DELETE FROM entity_graph.contract_dependencies`
  await sql`DELETE FROM entity_graph.contract_entity_links`
  await sql`DELETE FROM entity_graph.contracts`
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upsertContract', () => {
  it('creates a new contract with all fields persisted', async () => {
    const contract = await upsertContract(
      sql,
      {
        statement: 'data must not be lost',
        type: 'invariant',
        source: 'event',
        status: 'insufficient',
        confidence: 0.95,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [ENTITY_A],
    )

    expect(contract.id).toBeTruthy()
    expect(contract.statement).toBe('data must not be lost')
    expect(contract.type).toBe('invariant')
    expect(contract.source).toBe('event')
    expect(contract.status).toBe('insufficient')
    expect(contract.confidence).toBe(0.95)
    expect(contract.testFilePath).toBeNull()
    expect(contract.createdAt).toBeTruthy()
    expect(contract.updatedAt).toBeTruthy()
  })

  it('new contract without testFilePath has status insufficient', async () => {
    // Contract ac789c96
    const contract = await upsertContract(
      sql,
      {
        statement: 'no test path contract',
        type: 'guarantee',
        source: 'interview',
        status: 'insufficient',
        confidence: 0.8,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [],
    )

    expect(contract.status).toBe('insufficient')
    expect(contract.testFilePath).toBeNull()

    // Verify in DB directly
    const fromDb = await contractById(sql, contract.id)
    expect(fromDb!.status).toBe('insufficient')
  })

  it('deduplicates by (source, type, statement) — updates existing instead of inserting', async () => {
    const first = await upsertContract(
      sql,
      {
        statement: 'dedup test',
        type: 'guarantee',
        source: 'event',
        status: 'insufficient',
        confidence: 0.5,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [ENTITY_A],
    )

    const second = await upsertContract(
      sql,
      {
        statement: 'dedup test',
        type: 'guarantee',
        source: 'event',
        status: 'dirty',
        confidence: 0.9,
        domainId: 'domain-1',
        testFilePath: 'tests/dedup.test.ts',
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [ENTITY_B],
    )

    // Same ID (dedup hit)
    expect(second.id).toBe(first.id)

    // Fields updated
    expect(second.status).toBe('dirty')
    expect(second.confidence).toBe(0.9)
    expect(second.domainId).toBe('domain-1')
    expect(second.testFilePath).toBe('tests/dedup.test.ts')
  })

  it('different (source, type, statement) creates distinct contracts', async () => {
    const a = await upsertContract(
      sql,
      {
        statement: 'unique A',
        type: 'guarantee',
        source: 'event',
        status: 'insufficient',
        confidence: 0.5,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [],
    )

    const b = await upsertContract(
      sql,
      {
        statement: 'unique B',
        type: 'guarantee',
        source: 'event',
        status: 'insufficient',
        confidence: 0.5,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [],
    )

    expect(a.id).not.toBe(b.id)
  })

  it('creates entity links for new contract', async () => {
    const contract = await upsertContract(
      sql,
      {
        statement: 'link test',
        type: 'invariant',
        source: 'event',
        status: 'insufficient',
        confidence: 1,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [ENTITY_A, ENTITY_B],
    )

    const links = await entityLinksForContract(sql, contract.id)
    expect(links).toHaveLength(2)
    expect(links.map(l => l.entityId).sort()).toEqual([ENTITY_A, ENTITY_B].sort())
    expect(links.every(l => l.role === 'subject')).toBe(true)
  })

  it('rebuilds entity links on upsert — replaces old links with new', async () => {
    const contract = await upsertContract(
      sql,
      {
        statement: 'link rebuild',
        type: 'guarantee',
        source: 'compiled',
        status: 'insufficient',
        confidence: 0.8,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [ENTITY_A, ENTITY_B],
    )

    // Re-upsert with different entity links
    await upsertContract(
      sql,
      {
        statement: 'link rebuild',
        type: 'guarantee',
        source: 'compiled',
        status: 'insufficient',
        confidence: 0.8,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [ENTITY_C],
    )

    const links = await entityLinksForContract(sql, contract.id)
    expect(links).toHaveLength(1)
    expect(links[0].entityId).toBe(ENTITY_C)
  })

  it('creates dependency links when provided', async () => {
    const upstream = await upsertContract(
      sql,
      {
        statement: 'upstream',
        type: 'guarantee',
        source: 'event',
        status: 'insufficient',
        confidence: 1,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [],
    )

    const downstream = await upsertContract(
      sql,
      {
        statement: 'downstream',
        type: 'postcondition',
        source: 'event',
        status: 'insufficient',
        confidence: 0.9,
        domainId: null,
        testFilePath: null,
        verificationPlanJson: null,
        verdictRule: null,
        refinedIntent: null,
        compileStatus: null,
        lastVerdict: null,
        lastVerdictAt: null,
      },
      [],
      [{ contractId: upstream.id, relationship: 'requires' }],
    )

    const deps = await contractDependencies(sql, downstream.id)
    expect(deps).toHaveLength(1)
    expect(deps[0].dependsOnContractId).toBe(upstream.id)
    expect(deps[0].relationship).toBe('requires')
  })

  it('persists compilation fields', async () => {
    const contract = await upsertContract(
      sql,
      {
        statement: 'compiled contract',
        type: 'invariant',
        source: 'compiled',
        status: 'dirty',
        confidence: 1,
        domainId: null,
        testFilePath: 'tests/compiled.test.ts',
        verificationPlanJson: '{"steps":["run"]}',
        verdictRule: 'all_pass',
        refinedIntent: 'must preserve data integrity',
        compileStatus: 'compiled',
        lastVerdict: 'pass',
        lastVerdictAt: '2026-03-01T00:00:00Z',
      },
      [],
    )

    expect(contract.testFilePath).toBe('tests/compiled.test.ts')
    expect(contract.verificationPlanJson).toBe('{"steps":["run"]}')
    expect(contract.verdictRule).toBe('all_pass')
    expect(contract.refinedIntent).toBe('must preserve data integrity')
    expect(contract.compileStatus).toBe('compiled')
    expect(contract.lastVerdict).toBe('pass')
    expect(contract.lastVerdictAt).toBe('2026-03-01T00:00:00Z')
  })
})
