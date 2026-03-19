/**
 * Contract Verification — Deterministic Three-Party Protocol
 *
 * A contract reaches 'passing' only when:
 * 1. ValidationSpec compiled and human-approved
 * 2. Every condition has evidence (test + explanation)
 * 3. Every referenced test passes
 * 4. Red team acknowledgement exists and is not invalidated
 *
 * When a referenced test fails → acknowledgement invalidated → status drops to 'proven'.
 */

import type { Sql } from 'postgres'
import type { ContractStatus, ConditionEvidence } from './types.js'
import { parseValidationSpec } from './validation-spec.js'
import { evidenceForContract } from './queries.js'
import { updateContractStatus } from './queries.js'
import { activeAcknowledgement, invalidateAcknowledgement, openChallengesForContract } from './challenge.js'

export interface TestResult {
  passed: boolean
  output: string
}

export type TestRunner = (testFilePath: string) => Promise<TestResult>

export interface ConditionVerifyStatus {
  conditionId: string
  hasEvidence: boolean
  testFile: string | null
  testName: string | null
  testPassed: boolean | null  // null = not yet run
}

export interface ContractVerifyResult {
  contractId: string
  statement: string
  previousStatus: ContractStatus
  newStatus: ContractStatus
  conditions: ConditionVerifyStatus[]
  hasAcknowledgement: boolean
  acknowledgementInvalidated: boolean
  openChallenges: number
}

export interface VerifyResult {
  total: number
  passed: number
  failed: number
  results: ContractVerifyResult[]
}

/**
 * Verify contracts by checking the full deterministic protocol:
 * spec → evidence → test pass → acknowledgement.
 *
 * For each contract:
 * 1. Parse ValidationSpec from verification_plan_json
 * 2. Check condition evidence coverage
 * 3. Run referenced tests
 * 4. Check acknowledgement status
 * 5. Compute new status
 */
export async function verifyContracts(
  sql: Sql,
  runTest: TestRunner,
  opts?: { statuses?: ContractStatus[] },
): Promise<VerifyResult> {
  const statuses = opts?.statuses ?? ['compiled', 'proven', 'passing', 'challenged', 'dirty', 'failing']

  const rows = await sql<Array<{
    id: string; statement: string; status: string; verification_plan_json: string | null
  }>>`
    SELECT id, statement, status, verification_plan_json
    FROM entity_graph.contracts
    WHERE status = ANY(${statuses})
    ORDER BY updated_at ASC
  `

  if (rows.length === 0) {
    return { total: 0, passed: 0, failed: 0, results: [] }
  }

  // Collect unique test files to run each once
  const testFileResults = new Map<string, TestResult>()
  const results: ContractVerifyResult[] = []
  let passed = 0
  let failed = 0

  for (const row of rows) {
    const previousStatus = row.status as ContractStatus
    const spec = parseValidationSpec(row.verification_plan_json)

    // No spec → insufficient
    if (!spec || spec.compileStatus !== 'compiled') {
      results.push({
        contractId: row.id,
        statement: row.statement,
        previousStatus,
        newStatus: previousStatus === 'insufficient' ? 'insufficient' : previousStatus,
        conditions: [],
        hasAcknowledgement: false,
        acknowledgementInvalidated: false,
        openChallenges: 0,
      })
      continue
    }

    // Check evidence for each condition
    const evidence = await evidenceForContract(sql, row.id)
    const evidenceByCondition = new Map<string, ConditionEvidence>()
    for (const e of evidence) {
      evidenceByCondition.set(e.conditionId, e)
    }

    const conditionResults: ConditionVerifyStatus[] = []
    let allConditionsEvidenced = true
    let allTestsPassed = true
    let anyTestFailed = false

    for (const condition of spec.conditions) {
      const ev = evidenceByCondition.get(condition.id)
      if (!ev) {
        allConditionsEvidenced = false
        conditionResults.push({
          conditionId: condition.id,
          hasEvidence: false,
          testFile: null,
          testName: null,
          testPassed: null,
        })
        continue
      }

      // Run the test if not already run
      if (!testFileResults.has(ev.testFile)) {
        testFileResults.set(ev.testFile, await runTest(ev.testFile))
      }
      const testResult = testFileResults.get(ev.testFile)!

      conditionResults.push({
        conditionId: condition.id,
        hasEvidence: true,
        testFile: ev.testFile,
        testName: ev.testName,
        testPassed: testResult.passed,
      })

      if (!testResult.passed) {
        allTestsPassed = false
        anyTestFailed = true
      }
    }

    // Check acknowledgement
    const ack = await activeAcknowledgement(sql, row.id)
    let acknowledgementInvalidated = false

    // If any test failed, invalidate acknowledgement
    if (ack && anyTestFailed) {
      const failedTests = conditionResults
        .filter(c => c.testPassed === false)
        .map(c => `test '${c.testName}' in ${c.testFile}`)
        .join(', ')
      await invalidateAcknowledgement(sql, row.id, `Test failure: ${failedTests}`)
      acknowledgementInvalidated = true
    }

    // Check open challenges
    const challenges = await openChallengesForContract(sql, row.id)

    // Compute new status
    let newStatus: ContractStatus
    if (!allConditionsEvidenced) {
      newStatus = 'compiled' // has spec but missing proofs
    } else if (!allTestsPassed) {
      newStatus = 'proven' // proof exists but tests failing → ack invalidated
    } else if (challenges.length > 0) {
      newStatus = 'challenged'
    } else if (ack && !acknowledgementInvalidated) {
      newStatus = 'passing'
      passed++
    } else {
      newStatus = 'proven' // all tests pass, all evidence present, but no ack
    }

    if (newStatus !== previousStatus) {
      await updateContractStatus(sql, row.id, newStatus)
    }

    if (newStatus !== 'passing') {
      failed++
    }

    results.push({
      contractId: row.id,
      statement: row.statement,
      previousStatus,
      newStatus,
      conditions: conditionResults,
      hasAcknowledgement: !!ack && !acknowledgementInvalidated,
      acknowledgementInvalidated,
      openChallenges: challenges.length,
    })
  }

  return { total: rows.length, passed, failed, results }
}
