/**
 * Contract Queries
 *
 * CRUD + joins for the contract verification layer.
 * All accept a postgres Sql instance as first param, matching queries.ts pattern.
 */

import { randomUUID } from 'crypto'
import type { Sql } from 'postgres'
import type {
  Contract,
  ContractDependency,
  ContractDependencyRelationship,
  ContractEntityLink,
  ContractEntityRole,
  ContractSource,
  ContractStatus,
  ContractSummary,
  ContractType,
} from './types.js'

// --- Row Mapping ---

interface ContractRow {
  id: string
  statement: string
  type: string
  source: string
  status: string
  confidence: number
  domain_id: string | null
  test_file_path: string | null
  verification_plan_json: string | null
  verdict_rule: string | null
  refined_intent: string | null
  compile_status: string | null
  last_verdict: string | null
  last_verdict_at: string | null
  created_at: string
  updated_at: string
}

function rowToContract(row: ContractRow): Contract {
  return {
    id: row.id,
    statement: row.statement,
    type: row.type as ContractType,
    source: row.source as ContractSource,
    status: row.status as ContractStatus,
    confidence: row.confidence,
    domainId: row.domain_id,
    testFilePath: row.test_file_path,
    verificationPlanJson: row.verification_plan_json,
    verdictRule: row.verdict_rule,
    refinedIntent: row.refined_intent,
    compileStatus: row.compile_status as Contract['compileStatus'],
    lastVerdict: row.last_verdict as Contract['lastVerdict'],
    lastVerdictAt: row.last_verdict_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// --- Single Lookups ---

export async function contractById(sql: Sql, id: string): Promise<Contract | null> {
  const [row] = await sql<ContractRow[]>`
    SELECT * FROM entity_graph.contracts WHERE id = ${id}
  `
  return row ? rowToContract(row) : null
}

// --- Filtered Queries ---

export async function contractsForEntity(sql: Sql, entityId: string): Promise<Contract[]> {
  const rows = await sql<ContractRow[]>`
    SELECT c.* FROM entity_graph.contracts c
    JOIN entity_graph.contract_entity_links cel ON cel.contract_id = c.id
    WHERE cel.entity_id = ${entityId}
    ORDER BY c.updated_at DESC
  `
  return rows.map(rowToContract)
}

export async function contractsForFile(sql: Sql, filepath: string): Promise<Contract[]> {
  const rows = await sql<ContractRow[]>`
    SELECT DISTINCT c.* FROM entity_graph.contracts c
    JOIN entity_graph.contract_entity_links cel ON cel.contract_id = c.id
    JOIN entity_graph.entities e ON e.id = cel.entity_id
    WHERE e.filepath = ${filepath}
    ORDER BY c.updated_at DESC
  `
  return rows.map(rowToContract)
}

export async function contractsByStatus(sql: Sql, status: ContractStatus): Promise<Contract[]> {
  const rows = await sql<ContractRow[]>`
    SELECT * FROM entity_graph.contracts WHERE status = ${status}
    ORDER BY updated_at DESC
  `
  return rows.map(rowToContract)
}

export async function contractsByType(sql: Sql, type: ContractType): Promise<Contract[]> {
  const rows = await sql<ContractRow[]>`
    SELECT * FROM entity_graph.contracts WHERE type = ${type}
    ORDER BY updated_at DESC
  `
  return rows.map(rowToContract)
}

// --- Rich Query ---

export interface ContractWithEntities extends Contract {
  entityLinks: ContractEntityLink[]
}

export async function contractsWithEntityDetails(
  sql: Sql,
  filters?: { status?: ContractStatus; type?: ContractType; source?: ContractSource },
): Promise<ContractWithEntities[]> {
  const conditions: string[] = []
  const params: (string | number)[] = []
  let paramIdx = 1

  if (filters?.status) {
    conditions.push(`c.status = $${paramIdx++}`)
    params.push(filters.status)
  }
  if (filters?.type) {
    conditions.push(`c.type = $${paramIdx++}`)
    params.push(filters.type)
  }
  if (filters?.source) {
    conditions.push(`c.source = $${paramIdx}`)
    params.push(filters.source)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const contractRows = await sql.unsafe<ContractRow[]>(
    `SELECT * FROM entity_graph.contracts c ${where} ORDER BY c.updated_at DESC`,
    params,
  )

  if (contractRows.length === 0) return []

  const contractIds = contractRows.map(r => r.id)
  const linkRows = await sql<Array<{ contract_id: string; entity_id: string; role: string }>>`
    SELECT contract_id, entity_id, role
    FROM entity_graph.contract_entity_links
    WHERE contract_id = ANY(${contractIds})
  `

  const linksByContract = new Map<string, ContractEntityLink[]>()
  for (const row of linkRows) {
    const links = linksByContract.get(row.contract_id) ?? []
    links.push({
      contractId: row.contract_id,
      entityId: row.entity_id,
      role: row.role as ContractEntityRole,
    })
    linksByContract.set(row.contract_id, links)
  }

  return contractRows.map(row => ({
    ...rowToContract(row),
    entityLinks: linksByContract.get(row.id) ?? [],
  }))
}

// --- Mutations ---

export async function upsertContract(
  sql: Sql,
  contract: Omit<Contract, 'id' | 'createdAt' | 'updatedAt'>,
  entityIds: string[],
  dependsOn?: Array<{ contractId: string; relationship: ContractDependencyRelationship }>,
): Promise<Contract> {
  const now = new Date().toISOString()

  // Dedup key: (source, type, statement)
  const [existing] = await sql<ContractRow[]>`
    SELECT * FROM entity_graph.contracts
    WHERE source = ${contract.source}
      AND type = ${contract.type}
      AND statement = ${contract.statement}
    LIMIT 1
  `

  let contractId: string

  if (existing) {
    contractId = existing.id
    await sql`
      UPDATE entity_graph.contracts
      SET status = ${contract.status},
          confidence = ${contract.confidence},
          domain_id = ${contract.domainId ?? null},
          test_file_path = ${contract.testFilePath ?? null},
          verification_plan_json = ${contract.verificationPlanJson ?? null},
          verdict_rule = ${contract.verdictRule ?? null},
          refined_intent = ${contract.refinedIntent ?? null},
          compile_status = ${contract.compileStatus ?? null},
          last_verdict = ${contract.lastVerdict ?? null},
          last_verdict_at = ${contract.lastVerdictAt ?? null},
          updated_at = ${now}
      WHERE id = ${contractId}
    `
  } else {
    contractId = randomUUID()
    await sql`
      INSERT INTO entity_graph.contracts (
        id, statement, type, source, status, confidence, domain_id,
        test_file_path, verification_plan_json, verdict_rule, refined_intent,
        compile_status, last_verdict, last_verdict_at, created_at, updated_at
      )
      VALUES (
        ${contractId}, ${contract.statement}, ${contract.type}, ${contract.source},
        ${contract.status}, ${contract.confidence}, ${contract.domainId ?? null},
        ${contract.testFilePath ?? null}, ${contract.verificationPlanJson ?? null},
        ${contract.verdictRule ?? null}, ${contract.refinedIntent ?? null},
        ${contract.compileStatus ?? null}, ${contract.lastVerdict ?? null},
        ${contract.lastVerdictAt ?? null}, ${now}, ${now}
      )
    `
  }

  // Rebuild entity links
  await sql`DELETE FROM entity_graph.contract_entity_links WHERE contract_id = ${contractId}`
  for (const entityId of entityIds) {
    await sql`
      INSERT INTO entity_graph.contract_entity_links (contract_id, entity_id, role)
      VALUES (${contractId}, ${entityId}, 'subject')
      ON CONFLICT DO NOTHING
    `
  }

  // Rebuild dependency links
  if (dependsOn && dependsOn.length > 0) {
    await sql`DELETE FROM entity_graph.contract_dependencies WHERE contract_id = ${contractId}`
    for (const dep of dependsOn) {
      await sql`
        INSERT INTO entity_graph.contract_dependencies (contract_id, depends_on_contract_id, relationship)
        VALUES (${contractId}, ${dep.contractId}, ${dep.relationship})
        ON CONFLICT DO NOTHING
      `
    }
  }

  const result = await contractById(sql, contractId)
  return result!
}

export async function updateContractStatus(
  sql: Sql,
  contractId: string,
  status: ContractStatus,
): Promise<void> {
  await sql`
    UPDATE entity_graph.contracts
    SET status = ${status}, updated_at = ${new Date().toISOString()}
    WHERE id = ${contractId}
  `
}

export async function updateContractCompilation(
  sql: Sql,
  contractId: string,
  fields: {
    testFilePath?: string | null
    verificationPlanJson?: string | null
    verdictRule?: string | null
    refinedIntent?: string | null
    compileStatus?: 'compiled' | 'needs_user_answer' | 'failed' | null
    lastVerdict?: 'pass' | 'fail' | 'error' | 'skipped' | null
    lastVerdictAt?: string | null
  },
): Promise<void> {
  const now = new Date().toISOString()
  const has = (k: string) => Object.hasOwn(fields, k)
  await sql`
    UPDATE entity_graph.contracts
    SET test_file_path = ${has('testFilePath') ? fields.testFilePath ?? null : sql`test_file_path`},
        verification_plan_json = ${has('verificationPlanJson') ? fields.verificationPlanJson ?? null : sql`verification_plan_json`},
        verdict_rule = ${has('verdictRule') ? fields.verdictRule ?? null : sql`verdict_rule`},
        refined_intent = ${has('refinedIntent') ? fields.refinedIntent ?? null : sql`refined_intent`},
        compile_status = ${has('compileStatus') ? fields.compileStatus ?? null : sql`compile_status`},
        last_verdict = ${has('lastVerdict') ? fields.lastVerdict ?? null : sql`last_verdict`},
        last_verdict_at = ${has('lastVerdictAt') ? fields.lastVerdictAt ?? null : sql`last_verdict_at`},
        updated_at = ${now}
    WHERE id = ${contractId}
  `
}

export async function deleteContract(sql: Sql, contractId: string): Promise<void> {
  await sql`DELETE FROM entity_graph.contract_entity_links WHERE contract_id = ${contractId}`
  await sql`DELETE FROM entity_graph.contract_dependencies WHERE contract_id = ${contractId}`
  await sql`DELETE FROM entity_graph.contract_dependencies WHERE depends_on_contract_id = ${contractId}`
  await sql`DELETE FROM entity_graph.contracts WHERE id = ${contractId}`
}

// --- Aggregation ---

export async function contractSummary(sql: Sql): Promise<ContractSummary> {
  const [counts] = await sql<[{
    total: string
    passing: string
    failing: string
    dirty: string
    insufficient: string
    guarantee: string
    assumption: string
    invariant: string
    precondition: string
    postcondition: string
    metamorphic: string
    interview: string
    compiled: string
    incident: string
    event: string
  }]>`
    SELECT
      (SELECT count(*) FROM entity_graph.contracts)::text AS total,
      (SELECT count(*) FROM entity_graph.contracts WHERE status = 'passing')::text AS passing,
      (SELECT count(*) FROM entity_graph.contracts WHERE status = 'failing')::text AS failing,
      (SELECT count(*) FROM entity_graph.contracts WHERE status = 'dirty')::text AS dirty,
      (SELECT count(*) FROM entity_graph.contracts WHERE status = 'insufficient')::text AS insufficient,
      (SELECT count(*) FROM entity_graph.contracts WHERE type = 'guarantee')::text AS guarantee,
      (SELECT count(*) FROM entity_graph.contracts WHERE type = 'assumption')::text AS assumption,
      (SELECT count(*) FROM entity_graph.contracts WHERE type = 'invariant')::text AS invariant,
      (SELECT count(*) FROM entity_graph.contracts WHERE type = 'precondition')::text AS precondition,
      (SELECT count(*) FROM entity_graph.contracts WHERE type = 'postcondition')::text AS postcondition,
      (SELECT count(*) FROM entity_graph.contracts WHERE type = 'metamorphic')::text AS metamorphic,
      (SELECT count(*) FROM entity_graph.contracts WHERE source = 'interview')::text AS interview,
      (SELECT count(*) FROM entity_graph.contracts WHERE source = 'compiled')::text AS compiled,
      (SELECT count(*) FROM entity_graph.contracts WHERE source = 'incident')::text AS incident,
      (SELECT count(*) FROM entity_graph.contracts WHERE source = 'event')::text AS event
  `

  return {
    total: parseInt(counts.total, 10),
    byStatus: {
      passing: parseInt(counts.passing, 10),
      failing: parseInt(counts.failing, 10),
      dirty: parseInt(counts.dirty, 10),
      insufficient: parseInt(counts.insufficient, 10),
    },
    byType: {
      guarantee: parseInt(counts.guarantee, 10),
      assumption: parseInt(counts.assumption, 10),
      invariant: parseInt(counts.invariant, 10),
      precondition: parseInt(counts.precondition, 10),
      postcondition: parseInt(counts.postcondition, 10),
      metamorphic: parseInt(counts.metamorphic, 10),
    },
    bySource: {
      interview: parseInt(counts.interview, 10),
      compiled: parseInt(counts.compiled, 10),
      incident: parseInt(counts.incident, 10),
      event: parseInt(counts.event, 10),
    },
  }
}

// --- Violation CRUD ---

export interface ContractViolation {
  id: string
  contractId: string
  testFilePath: string
  testOutput: string | null
  detectedAt: string
  resolvedAt: string | null
}

export async function createViolation(
  sql: Sql,
  contractId: string,
  testFilePath: string,
  testOutput?: string,
): Promise<string> {
  const id = randomUUID()
  const now = new Date().toISOString()
  await sql`
    INSERT INTO entity_graph.contract_violations (id, contract_id, test_file_path, test_output, detected_at)
    VALUES (${id}, ${contractId}, ${testFilePath}, ${testOutput ?? null}, ${now})
  `
  return id
}

export async function resolveViolations(sql: Sql, contractId: string): Promise<number> {
  const now = new Date().toISOString()
  const result = await sql`
    UPDATE entity_graph.contract_violations
    SET resolved_at = ${now}
    WHERE contract_id = ${contractId} AND resolved_at IS NULL
  `
  return result.count
}

export async function openViolations(sql: Sql): Promise<ContractViolation[]> {
  const rows = await sql<Array<{
    id: string; contract_id: string; test_file_path: string
    test_output: string | null; detected_at: string; resolved_at: string | null
  }>>`
    SELECT * FROM entity_graph.contract_violations WHERE resolved_at IS NULL
    ORDER BY detected_at DESC
  `
  return rows.map(r => ({
    id: r.id,
    contractId: r.contract_id,
    testFilePath: r.test_file_path,
    testOutput: r.test_output,
    detectedAt: r.detected_at,
    resolvedAt: r.resolved_at,
  }))
}

export async function violationsForContract(sql: Sql, contractId: string): Promise<ContractViolation[]> {
  const rows = await sql<Array<{
    id: string; contract_id: string; test_file_path: string
    test_output: string | null; detected_at: string; resolved_at: string | null
  }>>`
    SELECT * FROM entity_graph.contract_violations WHERE contract_id = ${contractId}
    ORDER BY detected_at DESC
  `
  return rows.map(r => ({
    id: r.id,
    contractId: r.contract_id,
    testFilePath: r.test_file_path,
    testOutput: r.test_output,
    detectedAt: r.detected_at,
    resolvedAt: r.resolved_at,
  }))
}

// --- Entity Link Queries ---

export async function entityLinksForContract(
  sql: Sql,
  contractId: string,
): Promise<ContractEntityLink[]> {
  const rows = await sql<Array<{ contract_id: string; entity_id: string; role: string }>>`
    SELECT contract_id, entity_id, role
    FROM entity_graph.contract_entity_links
    WHERE contract_id = ${contractId}
  `
  return rows.map(r => ({
    contractId: r.contract_id,
    entityId: r.entity_id,
    role: r.role as ContractEntityRole,
  }))
}

export async function contractDependencies(
  sql: Sql,
  contractId: string,
): Promise<ContractDependency[]> {
  const rows = await sql<Array<{ contract_id: string; depends_on_contract_id: string; relationship: string }>>`
    SELECT contract_id, depends_on_contract_id, relationship
    FROM entity_graph.contract_dependencies
    WHERE contract_id = ${contractId}
  `
  return rows.map(r => ({
    contractId: r.contract_id,
    dependsOnContractId: r.depends_on_contract_id,
    relationship: r.relationship as ContractDependencyRelationship,
  }))
}
