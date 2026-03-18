import type {
  ArtifactRecord,
  BlueAssignmentRecord,
  BlueAssignRequest,
  BlueHandoffInput,
  BlueHandoffRecord,
  BoundaryCandidate,
  BoundaryDossier,
  BoundaryInfo,
  CallTreeNode,
  CreateBugInput,
  CreateBlueHandoffRequest,
  CreateEnvProfileInput,
  CreateSecretRefInput,
  DependencyInfo,
  EnvProfileRecord,
  EventLedgerRecord,
  EnvVarInfo,
  GapReport,
  MutationVerdictInput,
  MutationVerdictRecord,
  MutationVerdictRequest,
  RedDossierRequest,
  RedMutateRequest,
  RedTargetsRequest,
  RepoRecord,
  ReviewRunRequest,
  ReviewWorkflowResult,
  SecretRefRecord,
  TestSmellSummary,
  TestRecentPathsRequest,
  TestSmellsRequest,
  GraphBoundariesRequest,
  GraphDepsRequest,
  GraphEnvRequest,
  GraphGapsRequest,
  GraphIndexRequest,
  GraphReadinessRequest,
  GraphTreeRequest,
  ProjectIndex,
  ReadinessVerdict,
  MutationEvaluationResult,
  BugRecord,
  ContractCompileRequest,
  ContractCompileResult,
  ContractInterviewRequest,
  ContractInterviewResult,
  RefereeRunRequest,
  RunRecord,
  RunStartResponse,
  WorkflowResponse,
} from './types.js'

async function readErrorText(response: Response): Promise<string> {
  const text = await response.text()
  return text || response.statusText || 'request failed'
}

export async function requestJson<T>(baseUrl: string, input: {
  path: string
  method?: string
  body?: unknown
}): Promise<T> {
  const response = await fetch(new URL(input.path, baseUrl), {
    method: input.method ?? 'GET',
    headers: input.body ? { 'content-type': 'application/json' } : undefined,
    body: input.body ? JSON.stringify(input.body) : undefined,
  })

  if (!response.ok) {
    throw new Error(`metarepo request failed: ${response.status} ${await readErrorText(response)}`)
  }

  return response.json() as Promise<T>
}

export async function ensureLocalRepo(baseUrl: string, input: {
  name?: string
  rootPath: string
  registryPath?: string
  defaultEnvProfileId?: string
}): Promise<RepoRecord> {
  return requestJson<RepoRecord>(baseUrl, {
    path: '/repos',
    method: 'POST',
    body: {
      name: input.name,
      defaultEnvProfileId: input.defaultEnvProfileId,
      source: {
        kind: 'local',
        rootPath: input.rootPath,
        registryPath: input.registryPath,
      },
    },
  })
}

export async function updateRepo(baseUrl: string, repoId: string, input: {
  defaultEnvProfileId?: string | null
  name?: string
  registryPath?: string | null
}): Promise<RepoRecord> {
  return requestJson<RepoRecord>(baseUrl, {
    path: `/repos/${encodeURIComponent(repoId)}`,
    method: 'PATCH',
    body: input,
  })
}

export async function createSecretRef(baseUrl: string, repoId: string, input: CreateSecretRefInput): Promise<SecretRefRecord> {
  return requestJson<SecretRefRecord>(baseUrl, {
    path: `/repos/${encodeURIComponent(repoId)}/secret-refs`,
    method: 'POST',
    body: input,
  })
}

export async function createEnvProfile(baseUrl: string, repoId: string, input: CreateEnvProfileInput): Promise<EnvProfileRecord> {
  return requestJson<EnvProfileRecord>(baseUrl, {
    path: `/repos/${encodeURIComponent(repoId)}/env-profiles`,
    method: 'POST',
    body: input,
  })
}

export async function createBug(baseUrl: string, repoId: string, input: CreateBugInput): Promise<BugRecord> {
  return requestJson<BugRecord>(baseUrl, {
    path: `/repos/${encodeURIComponent(repoId)}/bugs`,
    method: 'POST',
    body: input,
  })
}

export async function createBlueHandoff(
  baseUrl: string,
  repoId: string,
  input: BlueHandoffInput,
  requestedBy?: string,
): Promise<BlueHandoffRecord> {
  return requestJson<BlueHandoffRecord>(baseUrl, {
    path: `/repos/${encodeURIComponent(repoId)}/blue-handoffs`,
    method: 'POST',
    body: {
      repoId,
      handoff: input,
      requestedBy,
    } satisfies CreateBlueHandoffRequest,
  })
}

export async function getLatestBlueHandoff(baseUrl: string, repoId: string): Promise<BlueHandoffRecord> {
  return requestJson<BlueHandoffRecord>(baseUrl, {
    path: `/repos/${encodeURIComponent(repoId)}/blue-handoffs/latest`,
  })
}

export async function getRun(baseUrl: string, runId: string): Promise<RunRecord> {
  return requestJson<RunRecord>(baseUrl, {
    path: `/runs/${encodeURIComponent(runId)}`,
  })
}

export async function listRunEvents(baseUrl: string, runId: string): Promise<EventLedgerRecord[]> {
  return requestJson<EventLedgerRecord[]>(baseUrl, {
    path: `/runs/${encodeURIComponent(runId)}/events`,
  })
}

export async function listRunArtifacts(baseUrl: string, runId: string): Promise<ArtifactRecord[]> {
  return requestJson<ArtifactRecord[]>(baseUrl, {
    path: `/runs/${encodeURIComponent(runId)}/artifacts`,
  })
}

export async function blueAssign(baseUrl: string, input: BlueAssignRequest): Promise<WorkflowResponse<BlueAssignmentRecord>> {
  return requestJson<WorkflowResponse<BlueAssignmentRecord>>(baseUrl, {
    path: '/rpc/blue.assign',
    method: 'POST',
    body: input,
  })
}

export async function listRepoArtifacts(baseUrl: string, repoId: string, kind?: string): Promise<ArtifactRecord[]> {
  const suffix = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return requestJson<ArtifactRecord[]>(baseUrl, {
    path: `/repos/${encodeURIComponent(repoId)}/artifacts${suffix}`,
  })
}

export async function contractInterview(baseUrl: string, input: ContractInterviewRequest): Promise<ContractInterviewResult> {
  return requestJson<ContractInterviewResult>(baseUrl, {
    path: '/rpc/contract.interview',
    method: 'POST',
    body: input,
  })
}

export async function contractCompile(baseUrl: string, input: ContractCompileRequest): Promise<ContractCompileResult> {
  return requestJson<ContractCompileResult>(baseUrl, {
    path: '/rpc/contract.compile',
    method: 'POST',
    body: input,
  })
}

export async function contractBatchCreate(baseUrl: string, input: import('./types.js').ContractBatchCreateRequest): Promise<import('./types.js').ContractBatchCreateResult> {
  return requestJson<import('./types.js').ContractBatchCreateResult>(baseUrl, {
    path: '/rpc/contract.batch-create',
    method: 'POST',
    body: input,
  })
}

export async function contractUpdateTestPaths(baseUrl: string, input: import('./types.js').ContractUpdateTestPathRequest): Promise<import('./types.js').ContractUpdateTestPathResult> {
  return requestJson<import('./types.js').ContractUpdateTestPathResult>(baseUrl, {
    path: '/rpc/contract.update-test-paths',
    method: 'POST',
    body: input,
  })
}

export async function graphBoundaries(baseUrl: string, input: GraphBoundariesRequest): Promise<WorkflowResponse<BoundaryInfo[]>> {
  return requestJson<WorkflowResponse<BoundaryInfo[]>>(baseUrl, {
    path: '/rpc/graph.boundaries',
    method: 'POST',
    body: input,
  })
}

export async function graphDeps(baseUrl: string, input: GraphDepsRequest): Promise<WorkflowResponse<DependencyInfo[]>> {
  return requestJson<WorkflowResponse<DependencyInfo[]>>(baseUrl, {
    path: '/rpc/graph.deps',
    method: 'POST',
    body: input,
  })
}

export async function graphTree(baseUrl: string, input: GraphTreeRequest): Promise<WorkflowResponse<CallTreeNode[]>> {
  return requestJson<WorkflowResponse<CallTreeNode[]>>(baseUrl, {
    path: '/rpc/graph.tree',
    method: 'POST',
    body: input,
  })
}

export async function graphEnv(baseUrl: string, input: GraphEnvRequest): Promise<WorkflowResponse<EnvVarInfo[]>> {
  return requestJson<WorkflowResponse<EnvVarInfo[]>>(baseUrl, {
    path: '/rpc/graph.env',
    method: 'POST',
    body: input,
  })
}

export async function graphReadiness(baseUrl: string, input: GraphReadinessRequest): Promise<WorkflowResponse<ReadinessVerdict>> {
  return requestJson<WorkflowResponse<ReadinessVerdict>>(baseUrl, {
    path: '/rpc/graph.readiness',
    method: 'POST',
    body: input,
  })
}

export async function graphGaps(baseUrl: string, input: GraphGapsRequest): Promise<WorkflowResponse<GapReport>> {
  return requestJson<WorkflowResponse<GapReport>>(baseUrl, {
    path: '/rpc/graph.gaps',
    method: 'POST',
    body: input,
  })
}

export async function graphIndex(baseUrl: string, input: GraphIndexRequest): Promise<WorkflowResponse<ProjectIndex>> {
  return requestJson<WorkflowResponse<ProjectIndex>>(baseUrl, {
    path: '/rpc/graph.index',
    method: 'POST',
    body: input,
  })
}

export async function testRecentPaths(baseUrl: string, input: TestRecentPathsRequest): Promise<string[]> {
  return requestJson<string[]>(baseUrl, {
    path: '/rpc/test.recent_paths',
    method: 'POST',
    body: input,
  })
}

export async function testSmells(baseUrl: string, input: TestSmellsRequest): Promise<TestSmellSummary> {
  return requestJson<TestSmellSummary>(baseUrl, {
    path: '/rpc/test.smells',
    method: 'POST',
    body: input,
  })
}

export async function reviewRun(baseUrl: string, input: ReviewRunRequest): Promise<WorkflowResponse<ReviewWorkflowResult>> {
  return requestJson<WorkflowResponse<ReviewWorkflowResult>>(baseUrl, {
    path: '/rpc/review.run',
    method: 'POST',
    body: input,
  })
}

export async function redTargets(baseUrl: string, input: RedTargetsRequest): Promise<WorkflowResponse<BoundaryCandidate[]>> {
  return requestJson<WorkflowResponse<BoundaryCandidate[]>>(baseUrl, {
    path: '/rpc/red.targets',
    method: 'POST',
    body: input,
  })
}

export async function redDossier(baseUrl: string, input: RedDossierRequest): Promise<WorkflowResponse<BoundaryDossier>> {
  return requestJson<WorkflowResponse<BoundaryDossier>>(baseUrl, {
    path: '/rpc/red.dossier',
    method: 'POST',
    body: input,
  })
}

export async function startRedMutate(baseUrl: string, input: RedMutateRequest): Promise<RunStartResponse> {
  return requestJson<RunStartResponse>(baseUrl, {
    path: '/rpc/red.mutate.start',
    method: 'POST',
    body: input,
  })
}

export async function redMutate(baseUrl: string, input: RedMutateRequest): Promise<WorkflowResponse<MutationEvaluationResult>> {
  return requestJson<WorkflowResponse<MutationEvaluationResult>>(baseUrl, {
    path: '/rpc/red.mutate',
    method: 'POST',
    body: input,
  })
}

export async function refereeRun(baseUrl: string, input: RefereeRunRequest): Promise<WorkflowResponse<MutationEvaluationResult>> {
  return requestJson<WorkflowResponse<MutationEvaluationResult>>(baseUrl, {
    path: '/rpc/referee.run',
    method: 'POST',
    body: input,
  })
}

export async function refereeVerdict(baseUrl: string, input: MutationVerdictRequest): Promise<MutationVerdictRecord> {
  return requestJson<MutationVerdictRecord>(baseUrl, {
    path: '/rpc/referee.verdict',
    method: 'POST',
    body: input,
  })
}
