import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { createRequestListener } from '../../packages/apps/metarepo/src/analysis_routes.ts'
import type { ArtifactRecord, MetarepoApi, RepoRecord, RunRecord, WorkflowResponse } from '../../packages/apps/metarepo/src/types.ts'

async function startServer(api: MetarepoApi): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(createRequestListener(api))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port')
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function makeRepo(id = 'repo-local'): RepoRecord {
  return {
    id,
    name: 'repo',
    sourceKind: 'local',
    rootPath: '/abs/repo',
    cloneUrl: null,
    defaultBranch: null,
    authRef: null,
    registryPath: null,
    defaultEnvProfileId: null,
    createdAt: '2026-03-11T00:00:00.000Z',
    updatedAt: '2026-03-11T00:00:00.000Z',
  }
}

function makeRun(id = 'run-1'): RunRecord {
  return {
    id,
    repoId: 'repo-local',
    workflow: 'graph.index',
    status: 'succeeded',
    sourceFingerprint: {
      repoId: 'repo-local',
      sourceKind: 'local',
      rootPath: '/abs/repo',
      dirty: false,
      createdAt: '2026-03-11T00:00:00.000Z',
    },
    requestedBy: 'test',
    errorMessage: null,
    graphDatabaseName: null,
    tempRootPath: null,
    createdAt: '2026-03-11T00:00:00.000Z',
    startedAt: '2026-03-11T00:00:01.000Z',
    finishedAt: '2026-03-11T00:00:02.000Z',
    updatedAt: '2026-03-11T00:00:02.000Z',
  }
}

function makeArtifact(id = 'artifact-1', kind = 'review'): ArtifactRecord {
  return {
    id,
    repoId: 'repo-local',
    runId: 'run-1',
    kind,
    title: kind,
    payload: { ok: true },
    sourceFingerprint: makeRun().sourceFingerprint,
    createdAt: '2026-03-11T00:00:03.000Z',
  }
}

function makeEvent(id = 'event-1', eventType = 'run.created') {
  return {
    id,
    repoId: 'repo-local',
    runId: 'run-1',
    eventType,
    payload: { workflow: 'red.mutate' },
    createdAt: '2026-03-11T00:00:01.000Z',
  }
}

function makeBlueHandoff() {
  return {
    artifact: makeArtifact('artifact-blue', 'blue_handoff'),
    handoff: {
      selector: 'src/orders',
      assignmentArtifactId: 'artifact-blue-assignment',
      boundaryId: 'function:src/orders/process.ts:processOrder',
      boundary: {
        boundaryId: 'function:src/orders/process.ts:processOrder',
        file: 'src/orders/process.ts',
        name: 'processOrder',
        kind: 'function',
        lineStart: 10,
        lineEnd: 68,
        fanIn: 3,
        readiness: 'ready',
        hasTests: false,
        testFileCount: 0,
        blastRadiusCount: 15,
        defended: false,
        approvedSurvivals: 0,
        defenseValueScore: 400,
        reasons: ['blast-radius=15', 'fan-in=3'],
      },
      testFiles: ['tests/behavioral/orders/process.behavior.test.ts'],
      changedFiles: ['tests/behavioral/orders/process.behavior.test.ts'],
      testCommand: ['bun', 'test', 'tests/behavioral/orders/process.behavior.test.ts'],
      summary: 'covers happy path and invalid sku',
      notes: 'uses real db',
      bugIds: [],
    },
  }
}

function makeWorkflowResponse(result: unknown): WorkflowResponse<unknown> {
  return {
    run: makeRun(),
    artifacts: [makeArtifact()],
    result,
  }
}

function makeApi(): MetarepoApi {
  return {
    health: () => ({ ok: true, service: 'metarepo' }),
    ready: async () => ({ ok: true, service: 'metarepo' }),
    createRepo: async () => makeRepo(),
    getRepo: async () => makeRepo(),
    updateRepo: async () => ({ ...makeRepo(), name: 'renamed' }),
    blueAssign: async () => makeWorkflowResponse({
      artifact: makeArtifact('artifact-blue-assignment', 'blue_assignment'),
      assignment: {
        selector: 'src/orders',
        boundary: {
          boundaryId: 'function:src/orders/process.ts:processOrder',
          file: 'src/orders/process.ts',
          name: 'processOrder',
          kind: 'function',
          lineStart: 10,
          lineEnd: 68,
          fanIn: 3,
          readiness: 'ready',
          hasTests: false,
          testFileCount: 0,
          blastRadiusCount: 15,
          defended: false,
          approvedSurvivals: 0,
          defenseValueScore: 400,
          reasons: ['blast-radius=15', 'fan-in=3'],
        },
      },
    }),
    createBlueHandoff: async () => makeBlueHandoff(),
    getLatestBlueHandoff: async () => makeBlueHandoff(),
    listRepoArtifacts: async () => [makeArtifact()],
    listRepoBugs: async () => [],
    createBug: async () => ({
      id: 'bug-1',
      repoId: 'repo-local',
      runId: null,
      title: 'bug',
      description: null,
      status: 'open',
      payload: {},
      sourceFingerprint: null,
      createdAt: '2026-03-11T00:00:00.000Z',
      updatedAt: '2026-03-11T00:00:00.000Z',
    }),
    createEnvProfile: async () => ({
      id: 'env-1',
      repoId: 'repo-local',
      name: 'default',
      variables: { NODE_ENV: 'test' },
      secretBindings: {},
      createdAt: '2026-03-11T00:00:00.000Z',
      updatedAt: '2026-03-11T00:00:00.000Z',
    }),
    createSecretRef: async () => ({
      id: 'secret-1',
      repoId: 'repo-local',
      kind: 'token',
      name: 'github',
      provider: 'inline',
      encryptedPayload: 'ciphertext',
      externalRef: null,
      createdAt: '2026-03-11T00:00:00.000Z',
      updatedAt: '2026-03-11T00:00:00.000Z',
    }),
    getRun: async () => makeRun(),
    listRunEvents: async () => [makeEvent()],
    listRunArtifacts: async () => [makeArtifact()],
    getArtifact: async () => makeArtifact(),
    graphBoundaries: async () => makeWorkflowResponse([{ entity: { id: 'function:src/a.ts:run' } }]),
    graphDeps: async input => makeWorkflowResponse([{ entityId: input.entityId }]),
    graphTree: async input => makeWorkflowResponse([{ entityId: input.entityId, maxDepth: input.maxDepth ?? null }]),
    graphEnv: async input => makeWorkflowResponse([{ entityId: input.entityId, varName: 'TOKEN' }]),
    graphReadiness: async input => makeWorkflowResponse({ entityId: input.entityId, ready: true }),
    graphGaps: async input => makeWorkflowResponse({ filepath: input.filepath ?? null, totalBoundaries: 1 }),
    graphIndex: async input => makeWorkflowResponse({ filepath: input.filepath ?? null, maxDepth: input.maxDepth ?? null }),
    testRecentPaths: async () => ['tests/example.behavior.test.ts'],
    testSmells: async () => ({ selector: 'recent', fileCount: 1, totalTests: 1, totalPenaltyPoints: -2, files: [] }),
    reviewRun: async input => makeWorkflowResponse({ review: { summary: `${input.baseSha}..${input.headSha}` }, markdown: 'rendered' }),
    redTargets: async () => makeWorkflowResponse([{ boundaryId: 'function:src/a.ts:run' }]),
    redDossier: async () => makeWorkflowResponse({ boundary: { boundaryId: 'function:src/a.ts:run' } }),
    startRedMutate: async () => ({ run: makeRun('run-red-start') }),
    redMutate: async () => makeWorkflowResponse({ id: 'proposal-1', status: 'survived', realMutation: true, preservesIntendedBehavior: null, patchApplied: true, workspacePath: '/tmp/work', testTarget: { command: ['bun', 'test'] }, testsRun: ['bun test'], summary: 'survived', reason: 'tests passed' }),
    refereeRun: async () => makeWorkflowResponse({ id: 'proposal-1', status: 'killed', realMutation: true, preservesIntendedBehavior: null, patchApplied: true, workspacePath: '/tmp/work', testTarget: { command: ['bun', 'test'] }, testsRun: ['bun test'], summary: 'killed', reason: 'tests failed' }),
  }
}

describe('metarepo routes', () => {
  let server: Server | null = null
  let baseUrl = ''

  beforeEach(async () => {
    const started = await startServer(makeApi())
    server = started.server
    baseUrl = started.baseUrl
  })

  afterEach(async () => {
    if (server) {
      await stopServer(server)
      server = null
    }
  })

  it('serves health and readiness', async () => {
    const health = await fetch(`${baseUrl}/healthz`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ ok: true, service: 'metarepo' })

    const ready = await fetch(`${baseUrl}/readyz`)
    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toEqual({ ok: true, service: 'metarepo' })
  })

  it('creates repos and dispatches workflow RPCs', async () => {
    const repoResponse = await fetch(`${baseUrl}/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: {
          kind: 'local',
          rootPath: '/abs/repo',
        },
      }),
    })
    expect(repoResponse.status).toBe(201)
    await expect(repoResponse.json()).resolves.toMatchObject({
      id: 'repo-local',
      sourceKind: 'local',
      rootPath: '/abs/repo',
    })

    const indexResponse = await fetch(`${baseUrl}/rpc/graph.index`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 'repo-local', maxDepth: 3 }),
    })
    expect(indexResponse.status).toBe(200)
    await expect(indexResponse.json()).resolves.toMatchObject({
      run: { workflow: 'graph.index' },
      result: { maxDepth: 3 },
    })

    const reviewResponse = await fetch(`${baseUrl}/rpc/review.run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 'repo-local', baseSha: 'abc', headSha: 'def', maxDepth: 2 }),
    })
    expect(reviewResponse.status).toBe(200)
    await expect(reviewResponse.json()).resolves.toMatchObject({
      result: {
        review: { summary: 'abc..def' },
        markdown: 'rendered',
      },
    })

    const recentPathsResponse = await fetch(`${baseUrl}/rpc/test.recent_paths`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 'repo-local', selector: 'recent' }),
    })
    expect(recentPathsResponse.status).toBe(200)
    await expect(recentPathsResponse.json()).resolves.toEqual(['tests/example.behavior.test.ts'])

    const blueAssignResponse = await fetch(`${baseUrl}/rpc/blue.assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 'repo-local', selector: 'src/orders', maxDepth: 5 }),
    })
    expect(blueAssignResponse.status).toBe(200)
    await expect(blueAssignResponse.json()).resolves.toMatchObject({
      result: {
        artifact: { kind: 'blue_assignment' },
        assignment: {
          selector: 'src/orders',
          boundary: { boundaryId: 'function:src/orders/process.ts:processOrder' },
        },
      },
    })

    const blueRecordResponse = await fetch(`${baseUrl}/repos/repo-local/blue-handoffs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: 'repo-local',
        handoff: {
          assignmentArtifactId: 'artifact-blue-assignment',
          testFiles: ['tests/behavioral/orders/process.behavior.test.ts'],
          testCommand: ['bun', 'test', 'tests/behavioral/orders/process.behavior.test.ts'],
        },
      }),
    })
    expect(blueRecordResponse.status).toBe(201)
    await expect(blueRecordResponse.json()).resolves.toMatchObject({
      artifact: { kind: 'blue_handoff' },
      handoff: { boundaryId: 'function:src/orders/process.ts:processOrder' },
    })

    const blueLatestResponse = await fetch(`${baseUrl}/repos/repo-local/blue-handoffs/latest`)
    expect(blueLatestResponse.status).toBe(200)
    await expect(blueLatestResponse.json()).resolves.toMatchObject({
      artifact: { kind: 'blue_handoff' },
      handoff: {
        testFiles: ['tests/behavioral/orders/process.behavior.test.ts'],
      },
    })

    const runEventsResponse = await fetch(`${baseUrl}/runs/run-1/events`)
    expect(runEventsResponse.status).toBe(200)
    await expect(runEventsResponse.json()).resolves.toEqual([
      expect.objectContaining({ id: 'event-1', eventType: 'run.created' }),
    ])

    const redMutateStartResponse = await fetch(`${baseUrl}/rpc/red.mutate.start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: 'repo-local',
        proposal: {
          family: 'missing_action',
          targetFile: 'src/orders/process.ts',
          targetSymbol: 'function:src/orders/process.ts:processOrder',
          whyThisBoundary: 'attack the export',
          patch: [{ op: 'replace', file: 'src/orders/process.ts', find: 'a', replace: 'b' }],
          testTarget: { command: ['bun', 'test', 'tests/behavioral/orders/process.behavior.test.ts'] },
          predictedOutcome: 'survived',
          survivalRationale: 'tests are shallow',
        },
      }),
    })
    expect(redMutateStartResponse.status).toBe(200)
    await expect(redMutateStartResponse.json()).resolves.toMatchObject({
      run: { id: 'run-red-start' },
    })
  })

  it('returns request errors as json', async () => {
    const response = await fetch(`${baseUrl}/rpc/graph.deps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 'repo-local' }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'entityId is required',
    })
  })
})
