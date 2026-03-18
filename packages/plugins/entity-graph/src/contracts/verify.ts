/**
 * Contract Verification
 *
 * Composable verify function that runs linked tests, records verdicts,
 * and persists violations as durable records.
 */

import type { Sql } from 'postgres'
import type { ContractStatus } from './types.js'
import { recordVerdicts } from './compilation.js'
import { createViolation, resolveViolations, openViolations as queryOpenViolations } from './queries.js'

export interface TestResult {
  passed: boolean
  output: string
}

export type TestRunner = (testFilePath: string) => Promise<TestResult>

export interface VerifyResult {
  total: number
  passed: number
  failed: number
  violations: Array<{ contractId: string; statement: string; testFilePath: string; output: string }>
}

/**
 * Verify contracts by running their linked tests.
 *
 * 1. Query contracts with matching status and a test_file_path
 * 2. Group by testFilePath (one test run per unique file)
 * 3. Run tests, map results back to contracts
 * 4. Record verdicts, create/resolve violations
 */
export async function verifyContracts(
  sql: Sql,
  runTest: TestRunner,
  opts?: { statuses?: ContractStatus[] },
): Promise<VerifyResult> {
  const statuses = opts?.statuses ?? ['dirty', 'failing']

  // Fetch verifiable contracts
  const rows = await sql<Array<{
    id: string; statement: string; test_file_path: string
  }>>`
    SELECT id, statement, test_file_path
    FROM entity_graph.contracts
    WHERE status = ANY(${statuses})
      AND test_file_path IS NOT NULL
    ORDER BY updated_at ASC
  `

  if (rows.length === 0) {
    return { total: 0, passed: 0, failed: 0, violations: [] }
  }

  // Group contracts by test file
  const byFile = new Map<string, Array<{ id: string; statement: string }>>()
  for (const row of rows) {
    const file = row.test_file_path
    const list = byFile.get(file) ?? []
    list.push({ id: row.id, statement: row.statement })
    byFile.set(file, list)
  }

  // Get existing open violations for skip-if-already-open check
  const existingOpen = await queryOpenViolations(sql)
  const openByContract = new Set(existingOpen.map(v => v.contractId))

  let passed = 0
  let failed = 0
  const violations: VerifyResult['violations'] = []

  // Run each unique test file once
  for (const [testFilePath, contracts] of byFile) {
    const result = await runTest(testFilePath)

    if (result.passed) {
      // All contracts linked to this file pass
      await recordVerdicts(sql, contracts.map(c => ({ inv_id: c.id, verdict: 'pass' as const })))
      for (const c of contracts) {
        await resolveViolations(sql, c.id)
      }
      passed += contracts.length
    } else {
      // All contracts linked to this file fail
      await recordVerdicts(sql, contracts.map(c => ({ inv_id: c.id, verdict: 'fail' as const })))
      for (const c of contracts) {
        // Only create a new violation if there isn't already an open one
        if (!openByContract.has(c.id)) {
          await createViolation(sql, c.id, testFilePath, result.output)
        }
        violations.push({
          contractId: c.id,
          statement: c.statement,
          testFilePath,
          output: result.output,
        })
      }
      failed += contracts.length
    }
  }

  return { total: rows.length, passed, failed, violations }
}
