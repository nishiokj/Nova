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

export type ContractStatus = 'passing' | 'failing' | 'dirty' | 'insufficient'

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
