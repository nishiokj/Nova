/**
 * Contract Verification Layer — Types
 *
 * Semantic contracts linked to entity-graph entities.
 * Contracts are authored (UUID IDs), not AST-derived.
 */

export type ContractType =
  | 'guarantee'
  | 'assumption'
  | 'invariant'
  | 'precondition'
  | 'postcondition'
  | 'metamorphic'

export type ContractSource = 'interview' | 'compiled' | 'incident' | 'event'

export type ContractStatus = 'passing' | 'failing' | 'dirty' | 'insufficient' | 'compiled' | 'proven' | 'challenged'

export type ContractEntityRole = 'subject' | 'dependency' | 'context'

export type ContractDependencyRelationship = 'requires' | 'implies' | 'conflicts'

export interface Contract {
  id: string
  statement: string
  type: ContractType
  source: ContractSource
  status: ContractStatus
  confidence: number
  domainId: string | null
  testFilePath: string | null
  verificationPlanJson: string | null
  verdictRule: string | null
  refinedIntent: string | null
  compileStatus: 'compiled' | 'needs_user_answer' | 'failed' | null
  lastVerdict: 'pass' | 'fail' | 'error' | 'skipped' | null
  lastVerdictAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ContractEntityLink {
  contractId: string
  entityId: string
  role: ContractEntityRole
}

export interface ContractDependency {
  contractId: string
  dependsOnContractId: string
  relationship: ContractDependencyRelationship
}

export interface DomainEntity {
  name: string
  description: string
  aliases: string[]
}

export interface DomainModel {
  version: number
  systemDescription: string
  entities: DomainEntity[]
  criticalPath: string
  hardRules: string[]
  painPoints: string[]
}

export interface ContractSummary {
  total: number
  byStatus: Record<ContractStatus, number>
  byType: Record<ContractType, number>
  bySource: Record<ContractSource, number>
}

export type ContractCompileStatus = 'compiled' | 'needs_user_answer' | 'failed'
export type ContractVerdictValue = 'pass' | 'fail' | 'error' | 'skipped'

// --- Deterministic Contract Verification ---

export interface ValidationCondition {
  id: string                    // e.g. "cond-001"
  statement: string             // precise, testable behavioral claim
  rationale: string             // why this condition is necessary for the contract
}

export interface ValidationSpec {
  version: 2
  compiledAt: string
  compileStatus: 'compiled' | 'needs_user_answer' | 'failed'
  conditions: ValidationCondition[]
  questions?: Array<{
    question_id: string
    invariant_id: string
    question: string
    rationale: string
    options?: string[]
  }>
}

export interface ConditionEvidence {
  conditionId: string           // references ValidationCondition.id
  testFile: string
  testName: string              // describe/it path
  explanation: string           // 1-2 sentences: how this test proves the condition
}

export interface ContractProof {
  contractId: string
  testFiles: string[]
  conditionEvidence: ConditionEvidence[]
}

export interface ContractChallenge {
  id: string
  contractId: string
  conditionId: string | null
  argument: string              // why the proof is insufficient
  evidence: string | null       // optional counterexample or demonstration
  status: 'open' | 'addressed' | 'dismissed'
  submittedAt: string
  resolvedAt: string | null
}

export interface ContractAcknowledgement {
  id: string
  contractId: string
  submittedAt: string
  invalidatedAt: string | null
  invalidatedReason: string | null
}
