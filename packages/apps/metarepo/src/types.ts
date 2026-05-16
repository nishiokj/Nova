import type {
  BoundaryCandidate,
  BoundaryDossier,
  BoundaryInfo,
  CallTreeNode,
  DependencyInfo,
  EnvVarInfo,
  GapReport,
  PRReview,
  ProjectIndex,
  ReadinessVerdict,
} from '../../../plugins/entity-graph/src/index.js'
export type {
  BoundaryCandidate,
  BoundaryDossier,
  BoundaryInfo,
  CallTreeNode,
  ContractSummary,
  DependencyInfo,
  EnvVarInfo,
  GapReport,
  PRReview,
  ProjectIndex,
  ReadinessVerdict,
} from '../../../plugins/entity-graph/src/index.js'

export interface ServiceConfig {
  port: number
  host: string
  databaseUrl: string
  workdir: string
  gitBin: string
  requestTimeoutMs: number
  secretMasterKey: string
}

export type RepoSourceKind = 'local' | 'git'
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface RepoSourceLocal {
  kind: 'local'
  rootPath: string
  registryPath?: string
}

export interface RepoSourceGit {
  kind: 'git'
  cloneUrl: string
  defaultBranch?: string
  authRef?: string
  registryPath?: string
}

export type RepoSourceInput = RepoSourceLocal | RepoSourceGit

export interface CreateRepoInput {
  name?: string
  source: RepoSourceInput
  defaultEnvProfileId?: string
}

export interface UpdateRepoInput {
  name?: string
  defaultBranch?: string | null
  authRef?: string | null
  registryPath?: string | null
  defaultEnvProfileId?: string | null
}

export interface RepoRecord {
  id: string
  name: string
  sourceKind: RepoSourceKind
  rootPath: string | null
  cloneUrl: string | null
  defaultBranch: string | null
  authRef: string | null
  registryPath: string | null
  defaultEnvProfileId: string | null
  createdAt: string
  updatedAt: string
}

export interface SourceFingerprint {
  repoId: string
  sourceKind: RepoSourceKind
  rootPath?: string
  cloneUrl?: string
  ref?: string
  commitSha?: string
  branch?: string
  dirty: boolean
  createdAt: string
}

export interface RunRecord {
  id: string
  repoId: string
  workflow: string
  status: RunStatus
  sourceFingerprint: SourceFingerprint
  requestedBy: string | null
  errorMessage: string | null
  graphDatabaseName: string | null
  tempRootPath: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export interface ArtifactRecord {
  id: string
  repoId: string
  runId: string
  kind: string
  title: string
  payload: unknown
  sourceFingerprint: SourceFingerprint
  createdAt: string
}

export interface EventLedgerRecord {
  id: string
  repoId: string
  runId: string | null
  eventType: string
  payload: unknown
  createdAt: string
}

export interface BugRecord {
  id: string
  repoId: string
  runId: string | null
  title: string
  description: string | null
  status: string
  payload: unknown
  sourceFingerprint: SourceFingerprint | null
  createdAt: string
  updatedAt: string
}

export interface CreateBugInput {
  title: string
  description?: string
  status?: string
  payload?: unknown
  runId?: string
  sourceFingerprint?: SourceFingerprint | null
}

export type BehaviorClaimStatus = 'open' | 'assigned' | 'defended' | 'stale' | 'dismissed'

export interface BehaviorClaimScope {
  files: string[]
  symbols?: string[]
  language?: string
  package?: string
  metadata?: unknown
}

export interface BehaviorClaimEvidence {
  testFiles?: string[]
  testCommand?: string[]
  notes?: string
  metadata?: unknown
}

export interface CreateBehaviorClaimInput {
  behavior: string
  scope?: Partial<BehaviorClaimScope>
  evidence?: BehaviorClaimEvidence
  source?: string
  status?: BehaviorClaimStatus
  sourceFingerprint?: SourceFingerprint | null
}

export interface BehaviorClaimRecord {
  id: string
  repoId: string
  behavior: string
  scope: BehaviorClaimScope
  evidence: BehaviorClaimEvidence
  status: BehaviorClaimStatus
  source: string | null
  sourceFingerprint: SourceFingerprint | null
  createdAt: string
  updatedAt: string
}

export const BEHAVIOR_CLAIM_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'metarepo/behavior-claim.schema.json',
  title: 'Metarepo Behavior Claim',
  type: 'object',
  additionalProperties: false,
  required: ['behavior'],
  properties: {
    behavior: { type: 'string', minLength: 1 },
    scope: {
      type: 'object',
      additionalProperties: true,
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        symbols: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        language: { type: 'string', minLength: 1 },
        package: { type: 'string', minLength: 1 },
        metadata: {},
      },
    },
    evidence: {
      type: 'object',
      additionalProperties: true,
      properties: {
        testFiles: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        testCommand: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        notes: { type: 'string' },
        metadata: {},
      },
    },
    source: { type: 'string', minLength: 1 },
    status: { enum: ['open', 'assigned', 'defended', 'stale', 'dismissed'] },
    sourceFingerprint: {},
  },
} as const

export const BEHAVIOR_CLAIM_EXAMPLE: CreateBehaviorClaimInput = {
  behavior: 'processOrder rejects invalid SKUs before creating an order.',
  scope: {
    files: ['src/orders/process.ts'],
    symbols: ['processOrder'],
    language: 'typescript',
    package: 'orders',
  },
  evidence: {
    testFiles: ['tests/behavioral/orders/process.behavior.test.ts'],
    testCommand: ['bun', 'test', 'tests/behavioral/orders/process.behavior.test.ts'],
    notes: 'Existing tests should prove the externally visible validation behavior.',
  },
  source: 'agent:red-blue-team',
}

export interface SecretRefRecord {
  id: string
  repoId: string | null
  kind: string
  name: string
  provider: string
  encryptedPayload: string | null
  externalRef: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateSecretRefInput {
  kind: string
  name: string
  provider: string
  value?: string
  externalRef?: string
}

export interface EnvProfileRecord {
  id: string
  repoId: string
  name: string
  variables: Record<string, string>
  secretBindings: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface CreateEnvProfileInput {
  name: string
  variables?: Record<string, string>
  secretBindings?: Record<string, string>
}

export interface BlueAssignedBoundary {
  boundaryId: string
  file: string
  name: string
  kind: BoundaryCandidate['kind']
  lineStart: number | null
  lineEnd: number | null
  fanIn: number
  readiness: BoundaryCandidate['readiness']
  hasTests: boolean
  testFileCount: number
  blastRadiusCount: number
  defended: boolean
  approvedSurvivals: number
  defenseValueScore: number
  reasons: string[]
}

export interface BlueAssignmentInput {
  selector?: string
}

export interface BlueAssignmentPayload {
  selector: string
  boundary: BlueAssignedBoundary
}

export interface BlueAssignmentRecord {
  artifact: ArtifactRecord
  assignment: BlueAssignmentPayload
}

export interface BlueClaimAssignmentPayload {
  selector: string
  claim: BehaviorClaimRecord
  reasons: string[]
}

export interface BlueClaimAssignmentRecord {
  artifact: ArtifactRecord
  assignment: BlueClaimAssignmentPayload
}

export interface BlueHandoffInput {
  assignmentArtifactId: string
  testFiles: string[]
  changedFiles?: string[]
  testCommand: string[]
  summary?: string
  notes?: string
  bugIds?: string[]
  contractIds?: string[]
}

export interface BlueHandoffPayload {
  selector: string
  assignmentArtifactId: string
  boundaryId: string
  boundary: BlueAssignedBoundary
  testFiles: string[]
  changedFiles: string[]
  testCommand: string[]
  summary?: string
  notes?: string
  bugIds: string[]
  contractIds: string[]
}

export interface BlueHandoffRecord {
  artifact: ArtifactRecord
  handoff: BlueHandoffPayload
}

export interface BlueClaimDefenseInput {
  assignmentArtifactId: string
  testFiles: string[]
  changedFiles?: string[]
  testCommand: string[]
  summary?: string
  notes?: string
  bugIds?: string[]
}

export interface BlueClaimDefensePayload {
  selector: string
  assignmentArtifactId: string
  claimId: string
  claim: BehaviorClaimRecord
  testFiles: string[]
  changedFiles: string[]
  testCommand: string[]
  summary?: string
  notes?: string
  bugIds: string[]
}

export interface BlueClaimDefenseRecord {
  artifact: ArtifactRecord
  defense: BlueClaimDefensePayload
}

export const BLUE_CLAIM_DEFENSE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'metarepo/blue-claim-defense.schema.json',
  title: 'Metarepo Blue Claim Defense',
  type: 'object',
  additionalProperties: false,
  required: ['assignmentArtifactId', 'testFiles', 'testCommand'],
  properties: {
    assignmentArtifactId: { type: 'string', minLength: 1 },
    testFiles: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    changedFiles: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    testCommand: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    summary: { type: 'string' },
    notes: { type: 'string' },
    bugIds: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
} as const

export const BLUE_CLAIM_DEFENSE_EXAMPLE: BlueClaimDefenseInput = {
  assignmentArtifactId: 'artifact-blue-claim-assignment',
  testFiles: ['tests/behavioral/orders/process.behavior.test.ts'],
  changedFiles: ['tests/behavioral/orders/process.behavior.test.ts'],
  testCommand: ['bun', 'test', 'tests/behavioral/orders/process.behavior.test.ts'],
  summary: 'Covers invalid SKU rejection, valid order creation, and duplicate order id behavior.',
  notes: 'Uses the repo-native test runner and keeps owned collaborators real.',
  bugIds: [],
}

export interface RunSourceRequest {
  ref?: string
}

export interface GraphBoundariesRequest {
  repoId: string
  filepath?: string
  source?: RunSourceRequest
  requestedBy?: string
}

export interface BlueAssignRequest {
  repoId: string
  selector?: string
  maxDepth?: number
  source?: RunSourceRequest
  requestedBy?: string
}

export interface BlueAssignClaimRequest {
  repoId: string
  selector?: string
  requestedBy?: string
}

export interface CreateBlueHandoffRequest {
  repoId: string
  handoff: BlueHandoffInput
  source?: RunSourceRequest
  requestedBy?: string
}

export interface CreateBlueClaimDefenseRequest {
  repoId: string
  defense: BlueClaimDefenseInput
  sourceFingerprint?: SourceFingerprint
  source?: RunSourceRequest
  requestedBy?: string
}

export interface GraphDepsRequest {
  repoId: string
  entityId: string
  source?: RunSourceRequest
  requestedBy?: string
}

export interface GraphTreeRequest {
  repoId: string
  entityId: string
  maxDepth?: number
  source?: RunSourceRequest
  requestedBy?: string
}

export interface GraphEnvRequest {
  repoId: string
  entityId: string
  source?: RunSourceRequest
  requestedBy?: string
}

export interface GraphReadinessRequest {
  repoId: string
  entityId: string
  source?: RunSourceRequest
  requestedBy?: string
}

export interface GraphGapsRequest {
  repoId: string
  filepath?: string
  source?: RunSourceRequest
  requestedBy?: string
}

export interface GraphIndexRequest {
  repoId: string
  filepath?: string
  maxDepth?: number
  source?: RunSourceRequest
  requestedBy?: string
}

export interface ContractCompileRequest {
  repoId: string
  contractIds?: string[]
  requestedBy?: string
}

export interface ContractInterviewRequest {
  repoId: string
  responses: {
    systemDescription: string
    entities: string
    criticalPath: string
    hardRules: string
    painPoints: string
  }
  sandboxed?: boolean
  requestedBy?: string
}

export interface ContractInterviewResult {
  domainYamlPath: string
  contractsSeeded: number
}

export interface ContractCompileResult {
  compiled: number
  failed: number
  needsUserAnswer: number
  findings: Array<{ contractId: string; message: string }>
}

export interface ContractBatchCreateRequest {
  repoId: string
  contracts: Array<{
    statement: string
    type: string
    source: string
    confidence: number
    entityIds?: string[]
    conditions?: Array<{
      id: string
      statement: string
      rationale: string
    }>
  }>
  requestedBy?: string
}

export interface ContractBatchCreateResult {
  created: number
  contractIds: string[]
}

export interface ContractUpdateTestPathRequest {
  repoId: string
  updates: Array<{
    contractId: string
    testFilePath: string
  }>
  requestedBy?: string
}

export interface ContractUpdateTestPathResult {
  updated: number
}

export interface ContractCheckRequest {
  repoId: string
  requestedBy?: string
}

export interface ContractCheckResult {
  summary: import('../../../plugins/entity-graph/src/contracts/types.js').ContractSummary
  undefended: Array<{
    id: string
    statement: string
    type: string
    source: string
    status: string
    confidence: number
  }>
  dirtyCount: number
  failingCount: number
  insufficientCount: number
}

export interface ContractSubmitProofRequest {
  repoId: string
  contractId: string
  testFiles: string[]
  conditionEvidence: Array<{
    conditionId: string
    testFile: string
    testName: string
    explanation: string
  }>
  requestedBy?: string
}

export interface ContractSubmitProofResult {
  evidenceCount: number
  newStatus: string
}

export interface ContractChallengeRequest {
  repoId: string
  contractId: string
  conditionId?: string
  argument: string
  evidence?: string
  requestedBy?: string
}

export interface ContractChallengeResult {
  challengeId: string
  newStatus: string
}

export interface ContractAcknowledgeRequest {
  repoId: string
  contractId: string
  requestedBy?: string
}

export interface ContractAcknowledgeResult {
  acknowledgementId: string
  newStatus: string
}

export interface ContractVerifyRequest {
  repoId: string
  requestedBy?: string
}

export interface ContractVerifyResult {
  total: number
  passed: number
  failed: number
  results: Array<{
    contractId: string
    statement: string
    previousStatus: string
    newStatus: string
    hasAcknowledgement: boolean
    acknowledgementInvalidated: boolean
    openChallenges: number
  }>
}

export interface ReviewRunRequest {
  repoId: string
  baseSha: string
  headSha: string
  maxDepth?: number
  source?: RunSourceRequest
  requestedBy?: string
}

export interface TestRecentPathsRequest {
  repoId: string
  selector?: string
  source?: RunSourceRequest
  requestedBy?: string
}

export interface TestSmellsRequest {
  repoId: string
  selector?: string
  source?: RunSourceRequest
  requestedBy?: string
}

export interface RedTargetsRequest {
  repoId: string
  selector?: string
  maxDepth?: number
  source?: RunSourceRequest
  requestedBy?: string
}

export interface RedDossierRequest {
  repoId: string
  boundaryId: string
  maxDepth?: number
  source?: RunSourceRequest
  requestedBy?: string
}

export interface MutationPatchReplace {
  op: 'replace'
  file: string
  find: string
  replace: string
  expectedMatches?: number
}

export type MutationPatchOperation = MutationPatchReplace

export interface MutationTestTarget {
  command: string[]
}

export interface MutationProposalInput {
  title?: string
  family: string
  targetFile: string
  targetSymbol: string
  whyThisBoundary: string
  patch: MutationPatchOperation[]
  testTarget: MutationTestTarget
  predictedOutcome: 'survived' | 'killed' | 'invalid'
  survivalRationale: string
  validatorNotes?: string
}

export const MUTATION_PROPOSAL_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'metarepo/mutation-proposal.schema.json',
  title: 'Metarepo Mutation Proposal',
  type: 'object',
  additionalProperties: false,
  required: [
    'family',
    'targetFile',
    'targetSymbol',
    'whyThisBoundary',
    'patch',
    'testTarget',
    'predictedOutcome',
    'survivalRationale',
  ],
  properties: {
    title: { type: 'string', minLength: 1 },
    family: { type: 'string', minLength: 1 },
    targetFile: { type: 'string', minLength: 1 },
    targetSymbol: { type: 'string', minLength: 1 },
    whyThisBoundary: { type: 'string', minLength: 1 },
    patch: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'file', 'find', 'replace'],
        properties: {
          op: { const: 'replace' },
          file: { type: 'string', minLength: 1 },
          find: { type: 'string', minLength: 1 },
          replace: { type: 'string' },
          expectedMatches: { type: 'integer', minimum: 1 },
        },
      },
    },
    testTarget: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 },
        },
      },
    },
    predictedOutcome: {
      enum: ['survived', 'killed', 'invalid'],
    },
    survivalRationale: { type: 'string', minLength: 1 },
    validatorNotes: { type: 'string' },
  },
} as const

export const MUTATION_PROPOSAL_EXAMPLE: MutationProposalInput = {
  title: 'Skip invalid sku guard in processOrder',
  family: 'missing_action',
  targetFile: 'src/orders/process.ts',
  targetSymbol: 'function:src/orders/process.ts:processOrder',
  whyThisBoundary: 'Blue claims to defend order validation at the exported processOrder boundary.',
  patch: [
    {
      op: 'replace',
      file: 'src/orders/process.ts',
      find: "if (!isValidSku(input.sku)) throw new Error('invalid sku')",
      replace: '',
      expectedMatches: 1,
    },
  ],
  testTarget: {
    command: ['bun', 'test', 'tests/behavioral/orders/process.behavior.test.ts'],
  },
  predictedOutcome: 'survived',
  survivalRationale: 'The new tests cover the happy path but do not appear to assert that invalid SKUs are rejected.',
  validatorNotes: 'Reject if this edit breaks parsing or changes a different boundary than processOrder.',
}

export interface RedMutateRequest {
  repoId: string
  proposal: MutationProposalInput
  claimId?: string
  source?: RunSourceRequest
  requestedBy?: string
}

export interface RedMutateRecordRequest {
  repoId: string
  proposal: MutationProposalInput
  result: MutationEvaluationResult
  claimId?: string
  sourceFingerprint?: Partial<SourceFingerprint>
  requestedBy?: string
}

export interface RefereeRunRequest {
  proposalArtifactId: string
  requestedBy?: string
}

// --- Mutation Verdict (referee 3rd-party disposition) ---

/**
 * What the referee decided about a survived mutation.
 * - fixed:     gap was real, a test was written to kill it
 * - dismissed: gap is not worth closing
 * - blocked:   gap is real but can't be closed with tests alone
 */
export type VerdictDisposition = 'fixed' | 'dismissed' | 'blocked'

/**
 * Why the referee made that decision. Each basis is valid only for
 * specific dispositions. The vocabulary is intentionally small and
 * precise so verdicts are queryable without reading free text.
 *
 * fixed:
 *   untested_path      — no test exercises this code path
 *   weak_assertion     — test reaches the path but doesn't assert the relevant output
 *   partial_coverage   — behavior tested for some input classes but not the one the mutation exploits
 *
 * dismissed:
 *   not_contractual       — behavior isn't part of the boundary's public contract
 *   already_specified     — behavior is covered by tests at this or another scope
 *   no_observable_effect  — mutation doesn't change any output observable to consumers
 *
 * blocked:
 *   not_observable_at_boundary — contractual but not testable through the boundary's interface
 *   requires_source_change    — test would require production code changes
 */
export type VerdictBasis =
  | 'untested_path'
  | 'weak_assertion'
  | 'partial_coverage'
  | 'not_contractual'
  | 'already_specified'
  | 'no_observable_effect'
  | 'not_observable_at_boundary'
  | 'requires_source_change'

export const VERDICT_BASIS_BY_DISPOSITION: Record<VerdictDisposition, VerdictBasis[]> = {
  fixed: ['untested_path', 'weak_assertion', 'partial_coverage'],
  dismissed: ['not_contractual', 'already_specified', 'no_observable_effect'],
  blocked: ['not_observable_at_boundary', 'requires_source_change'],
}

export interface MutationVerdictInput {
  proposalArtifactId: string
  disposition: VerdictDisposition
  basis: VerdictBasis
  reasoning: string
  testFile?: string
  testName?: string
}

export interface MutationVerdictRecord {
  artifact: ArtifactRecord
  verdict: MutationVerdictInput
}

export interface MutationVerdictRequest {
  repoId: string
  verdict: MutationVerdictInput
  requestedBy?: string
}

export const MUTATION_VERDICT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'metarepo/mutation-verdict.schema.json',
  title: 'Metarepo Mutation Verdict',
  type: 'object',
  additionalProperties: false,
  required: ['proposalArtifactId', 'disposition', 'basis', 'reasoning'],
  properties: {
    proposalArtifactId: { type: 'string', minLength: 1 },
    disposition: { enum: ['fixed', 'dismissed', 'blocked'] },
    basis: {
      enum: [
        'untested_path',
        'weak_assertion',
        'partial_coverage',
        'not_contractual',
        'already_specified',
        'no_observable_effect',
        'not_observable_at_boundary',
        'requires_source_change',
      ],
    },
    reasoning: { type: 'string', minLength: 1 },
    testFile: { type: 'string' },
    testName: { type: 'string' },
  },
} as const

export interface RunStartResponse {
  run: RunRecord
}

export interface GraphBuildStats {
  files: number
  entities: number
  edges: number
  durationMs: number
}

export interface WorkflowResponse<T> {
  run: RunRecord
  artifacts: ArtifactRecord[]
  result: T
}

export interface ReviewWorkflowResult {
  review: PRReview
  markdown: string
}

export interface TestSmellHit {
  code: string
  label: string
  line: number
  points: number
  excerpt: string
}

export interface TestSmellFileReport {
  path: string
  testCount: number
  imports: string[]
  penaltyPoints: number
  hitCount: number
  hits: TestSmellHit[]
}

export interface TestSmellSummary {
  selector: string | null
  fileCount: number
  totalTests: number
  totalPenaltyPoints: number
  files: TestSmellFileReport[]
}

export interface MutationEvaluationResult {
  id: string
  status: 'survived' | 'killed' | 'invalid'
  realMutation: boolean
  preservesIntendedBehavior: boolean | null
  patchApplied: boolean
  workspacePath: string
  testTarget: MutationTestTarget
  testsRun: string[]
  summary: string
  reason: string
  stdoutSummary?: string
  stderrSummary?: string
  failingTests?: string[]
  observedBehaviorChange?: string
}

export interface MetarepoApi {
  health(): Record<string, unknown>
  ready(): Promise<Record<string, unknown>>
  createRepo(input: CreateRepoInput): Promise<RepoRecord>
  getRepo(id: string): Promise<RepoRecord>
  updateRepo(id: string, input: UpdateRepoInput): Promise<RepoRecord>
  blueAssign(input: BlueAssignRequest): Promise<WorkflowResponse<BlueAssignmentRecord>>
  createBlueHandoff(input: CreateBlueHandoffRequest): Promise<BlueHandoffRecord>
  createBlueClaimDefense(input: CreateBlueClaimDefenseRequest): Promise<BlueClaimDefenseRecord>
  getLatestBlueHandoff(repoId: string): Promise<BlueHandoffRecord>
  listRepoArtifacts(id: string, kind?: string): Promise<ArtifactRecord[]>
  listRepoBugs(id: string): Promise<BugRecord[]>
  createBug(repoId: string, input: CreateBugInput): Promise<BugRecord>
  listBehaviorClaims(repoId: string, status?: BehaviorClaimStatus): Promise<BehaviorClaimRecord[]>
  createBehaviorClaim(repoId: string, input: CreateBehaviorClaimInput): Promise<BehaviorClaimRecord>
  createEnvProfile(repoId: string, input: CreateEnvProfileInput): Promise<EnvProfileRecord>
  createSecretRef(repoId: string, input: CreateSecretRefInput): Promise<SecretRefRecord>
  getRun(id: string): Promise<RunRecord>
  listRunEvents(id: string): Promise<EventLedgerRecord[]>
  listRunArtifacts(id: string): Promise<ArtifactRecord[]>
  getArtifact(id: string): Promise<ArtifactRecord>
  blueAssignClaim(input: BlueAssignClaimRequest): Promise<WorkflowResponse<BlueClaimAssignmentRecord>>
  contractCompile(input: ContractCompileRequest): Promise<ContractCompileResult>
  contractInterview(input: ContractInterviewRequest): Promise<ContractInterviewResult>
  contractBatchCreate(input: ContractBatchCreateRequest): Promise<ContractBatchCreateResult>
  contractUpdateTestPaths(input: ContractUpdateTestPathRequest): Promise<ContractUpdateTestPathResult>
  contractCheck(input: ContractCheckRequest): Promise<ContractCheckResult>
  contractSubmitProof(input: ContractSubmitProofRequest): Promise<ContractSubmitProofResult>
  contractChallenge(input: ContractChallengeRequest): Promise<ContractChallengeResult>
  contractAcknowledge(input: ContractAcknowledgeRequest): Promise<ContractAcknowledgeResult>
  contractVerify(input: ContractVerifyRequest): Promise<ContractVerifyResult>
  graphBoundaries(input: GraphBoundariesRequest): Promise<WorkflowResponse<BoundaryInfo[]>>
  graphDeps(input: GraphDepsRequest): Promise<WorkflowResponse<DependencyInfo[]>>
  graphTree(input: GraphTreeRequest): Promise<WorkflowResponse<CallTreeNode[]>>
  graphEnv(input: GraphEnvRequest): Promise<WorkflowResponse<EnvVarInfo[]>>
  graphReadiness(input: GraphReadinessRequest): Promise<WorkflowResponse<ReadinessVerdict>>
  graphGaps(input: GraphGapsRequest): Promise<WorkflowResponse<GapReport>>
  graphIndex(input: GraphIndexRequest): Promise<WorkflowResponse<ProjectIndex>>
  testRecentPaths(input: TestRecentPathsRequest): Promise<string[]>
  testSmells(input: TestSmellsRequest): Promise<TestSmellSummary>
  reviewRun(input: ReviewRunRequest): Promise<WorkflowResponse<ReviewWorkflowResult>>
  redTargets(input: RedTargetsRequest): Promise<WorkflowResponse<BoundaryCandidate[]>>
  redDossier(input: RedDossierRequest): Promise<WorkflowResponse<BoundaryDossier>>
  startRedMutate(input: RedMutateRequest): Promise<RunStartResponse>
  redMutate(input: RedMutateRequest): Promise<WorkflowResponse<MutationEvaluationResult>>
  recordRedMutate(input: RedMutateRecordRequest): Promise<WorkflowResponse<MutationEvaluationResult>>
  refereeRun(input: RefereeRunRequest): Promise<WorkflowResponse<MutationEvaluationResult>>
  refereeVerdict(input: MutationVerdictRequest): Promise<MutationVerdictRecord>
}
