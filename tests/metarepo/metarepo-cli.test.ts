import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../../packages/apps/metarepo/src/cli.ts'

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('metarepo cli primitive flow', () => {
  const originalFetch = globalThis.fetch
  const originalConsoleLog = console.log
  const originalConsoleError = console.error
  const originalStatePath = process.env.METAREPO_CLIENT_STATE_PATH
  const originalBaseUrl = process.env.METAREPO_BASE_URL
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'metarepo-cli-'))
    process.env.METAREPO_CLIENT_STATE_PATH = path.join(tempRoot, 'client.json')
    process.env.METAREPO_BASE_URL = 'http://127.0.0.1:8080'
    console.log = vi.fn()
    console.error = vi.fn()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    console.log = originalConsoleLog
    console.error = originalConsoleError
    process.env.METAREPO_CLIENT_STATE_PATH = originalStatePath
    process.env.METAREPO_BASE_URL = originalBaseUrl
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('adds a repo, imports secrets, records blue handoffs, and queries graph primitives without an explicit repo id', async () => {
    const repoRoot = path.join(tempRoot, 'repo')
    await writeFile(path.join(tempRoot, '.env'), 'APP_SECRET=super-secret\nNODE_ENV=test\n', 'utf-8')
    await mkdir(repoRoot, { recursive: true })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/healthz')) {
        return jsonResponse(200, { ok: true, service: 'metarepo' })
      }
      if (url.endsWith('/repos') && init?.method === 'POST') {
        return jsonResponse(201, {
          id: 'repo-1',
          name: 'repo',
          sourceKind: 'local',
          rootPath: repoRoot,
          cloneUrl: null,
          defaultBranch: null,
          authRef: null,
          registryPath: null,
          defaultEnvProfileId: null,
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        })
      }
      if (url.endsWith('/repos/repo-1/secret-refs') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string }
        return jsonResponse(201, {
          id: `secret-${body.name}`,
          repoId: 'repo-1',
          kind: 'env',
          name: body.name,
          provider: 'encrypted_db',
          encryptedPayload: 'ciphertext',
          externalRef: null,
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        })
      }
      if (url.endsWith('/repos/repo-1/env-profiles') && init?.method === 'POST') {
        return jsonResponse(201, {
          id: 'env-default',
          repoId: 'repo-1',
          name: 'default',
          variables: {},
          secretBindings: {
            APP_SECRET: 'secret-APP_SECRET',
            NODE_ENV: 'secret-NODE_ENV',
          },
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        })
      }
      if (url.endsWith('/repos/repo-1') && init?.method === 'PATCH') {
        return jsonResponse(200, {
          id: 'repo-1',
          name: 'repo',
          sourceKind: 'local',
          rootPath: repoRoot,
          cloneUrl: null,
          defaultBranch: null,
          authRef: null,
          registryPath: null,
          defaultEnvProfileId: 'env-default',
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        })
      }
      if (url.endsWith('/rpc/blue.assign') && init?.method === 'POST') {
        return jsonResponse(200, {
          run: {
            id: 'run-blue-assign',
            repoId: 'repo-1',
            workflow: 'blue.assign',
            status: 'succeeded',
            sourceFingerprint: {
              repoId: 'repo-1',
              sourceKind: 'local',
              rootPath: repoRoot,
              dirty: true,
              createdAt: '2026-03-11T00:00:00.000Z',
            },
            requestedBy: 'metarepo-cli:blue.assign',
            errorMessage: null,
            graphDatabaseName: null,
            tempRootPath: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            startedAt: '2026-03-11T00:00:00.000Z',
            finishedAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
          },
          artifacts: [{
            id: 'artifact-blue-assignment',
            repoId: 'repo-1',
            runId: 'run-blue-assign',
            kind: 'blue_assignment',
            title: 'function:src/orders/process.ts:processOrder',
            payload: {},
            sourceFingerprint: {
              repoId: 'repo-1',
              sourceKind: 'local',
              rootPath: repoRoot,
              dirty: true,
              createdAt: '2026-03-11T00:00:00.000Z',
            },
            createdAt: '2026-03-11T00:00:00.000Z',
          }],
          result: {
            artifact: {
              id: 'artifact-blue-assignment',
              repoId: 'repo-1',
              runId: 'run-blue-assign',
              kind: 'blue_assignment',
              title: 'function:src/orders/process.ts:processOrder',
              payload: {},
              sourceFingerprint: {
                repoId: 'repo-1',
                sourceKind: 'local',
                rootPath: repoRoot,
                dirty: true,
                createdAt: '2026-03-11T00:00:00.000Z',
              },
              createdAt: '2026-03-11T00:00:00.000Z',
            },
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
          },
        })
      }
      if (url.endsWith('/repos/repo-1/blue-handoffs') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          handoff: {
            assignmentArtifactId: string
            testFiles: string[]
          }
        }
        return jsonResponse(201, {
          artifact: {
            id: 'artifact-blue',
            repoId: 'repo-1',
            runId: 'run-blue',
            kind: 'blue_handoff',
            title: 'function:src/orders/process.ts:processOrder',
            payload: body.handoff,
            sourceFingerprint: {
              repoId: 'repo-1',
              sourceKind: 'local',
              rootPath: repoRoot,
              dirty: true,
              createdAt: '2026-03-11T00:00:00.000Z',
            },
            createdAt: '2026-03-11T00:00:00.000Z',
          },
          handoff: {
            selector: 'src/orders',
            assignmentArtifactId: body.handoff.assignmentArtifactId,
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
            testFiles: body.handoff.testFiles,
            changedFiles: body.handoff.testFiles,
            testCommand: ['bun', 'test', body.handoff.testFiles[0]],
            summary: undefined,
            notes: undefined,
            bugIds: [],
          },
        })
      }
      if (url.endsWith('/repos/repo-1/blue-handoffs/latest') && init?.method !== 'POST') {
        return jsonResponse(200, {
          artifact: {
            id: 'artifact-blue',
            repoId: 'repo-1',
            runId: 'run-blue',
            kind: 'blue_handoff',
            title: 'function:src/orders/process.ts:processOrder',
            payload: {},
            sourceFingerprint: {
              repoId: 'repo-1',
              sourceKind: 'local',
              rootPath: repoRoot,
              dirty: true,
              createdAt: '2026-03-11T00:00:00.000Z',
            },
            createdAt: '2026-03-11T00:00:00.000Z',
          },
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
            summary: 'covers invalid sku',
            notes: undefined,
            bugIds: [],
          },
        })
      }
      if (url.endsWith('/rpc/graph.index') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { repoId: string }
        return jsonResponse(200, {
          run: {
            id: 'run-1',
            repoId: body.repoId,
            workflow: 'graph.index',
            status: 'succeeded',
            sourceFingerprint: {
              repoId: body.repoId,
              sourceKind: 'local',
              rootPath: repoRoot,
              dirty: false,
              createdAt: '2026-03-11T00:00:00.000Z',
            },
            requestedBy: 'metarepo-cli:graph.index',
            errorMessage: null,
            graphDatabaseName: null,
            tempRootPath: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            startedAt: '2026-03-11T00:00:00.000Z',
            finishedAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
          },
          artifacts: [],
          result: {
            version: 1,
            boundaries: [],
            graphStats: { entities: 1, imports: 0, calls: 0, uses: 0, owns: 0, extends: 0, implements: 0 },
            repoRoot,
            commit: '',
            timestamp: '2026-03-11T00:00:00.000Z',
            summary: { totalBoundaries: 0, tested: 0, ready: 0, blocked: 0, unknown: 0 },
            testInfrastructure: { framework: 'vitest', testFiles: [] },
            unresolved: [],
          },
        })
      }
      if (url.endsWith('/repos/repo-1/bugs') && init?.method === 'POST') {
        return jsonResponse(201, {
          id: 'bug-1',
          repoId: 'repo-1',
          runId: null,
          title: 'broken boundary',
          description: 'needs local postgres',
          status: 'open',
          payload: {},
          sourceFingerprint: null,
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const previousCwd = process.cwd()
    process.chdir(repoRoot)
    try {
      await runCli(['add', repoRoot])
      const savedState = JSON.parse(await readFile(path.join(tempRoot, 'client.json'), 'utf-8')) as {
        repo: { rootPath: string }
      }
      expect(savedState.repo.rootPath).toBe(repoRoot)
      await runCli(['secrets', 'add', '--file', path.join(tempRoot, '.env')])
      await runCli(['blue', 'assign', 'src/orders'])
      await writeFile(path.join(tempRoot, 'blue.json'), JSON.stringify({
        assignmentArtifactId: 'artifact-blue-assignment',
        testFiles: ['tests/behavioral/orders/process.behavior.test.ts'],
        testCommand: ['bun', 'test', 'tests/behavioral/orders/process.behavior.test.ts'],
      }), 'utf-8')
      await runCli(['blue', 'record', '--file', path.join(tempRoot, 'blue.json')])
      await runCli(['blue', 'latest'])
      await runCli(['graph', 'index'])
      await runCli(['bug', 'create', '--title', 'broken boundary', '--description', 'needs local postgres'])
    } finally {
      process.chdir(previousCwd)
    }

    expect(fetchMock).toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/rpc/blue.assign'))).toBe(true)
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/repos/repo-1/blue-handoffs'))).toBe(true)
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/repos/repo-1/blue-handoffs/latest'))).toBe(true)
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/rpc/graph.index'))).toBe(true)
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/repos/repo-1/bugs'))).toBe(true)
  })

  it('stores repo binding in the repo by default so another pane can reuse it', async () => {
    const repoRoot = path.join(tempRoot, 'repo-local-state')
    await mkdir(repoRoot, { recursive: true })
    process.env.METAREPO_CLIENT_STATE_PATH = ''

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/healthz')) {
        return jsonResponse(200, { ok: true, service: 'metarepo' })
      }
      if (url.endsWith('/repos') && init?.method === 'POST') {
        return jsonResponse(201, {
          id: 'repo-2',
          name: 'repo-local-state',
          sourceKind: 'local',
          rootPath: repoRoot,
          cloneUrl: null,
          defaultBranch: null,
          authRef: null,
          registryPath: null,
          defaultEnvProfileId: null,
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const previousCwd = process.cwd()
    process.chdir(repoRoot)
    try {
      await runCli(['add'])
      const savedState = JSON.parse(await readFile(path.join(repoRoot, '.metarepo', 'client.json'), 'utf-8')) as {
        repo: { rootPath: string }
      }
      expect(realpathSync(savedState.repo.rootPath)).toBe(realpathSync(repoRoot))
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('starts red mutate asynchronously and reports run progress before printing the final result', async () => {
    const repoRoot = path.join(tempRoot, 'repo-red')
    await mkdir(repoRoot, { recursive: true })
    await writeFile(path.join(tempRoot, 'client.json'), JSON.stringify({
      version: 1,
      repo: { rootPath: repoRoot, name: 'repo-red' },
    }), 'utf-8')
    await writeFile(path.join(tempRoot, 'mutation.json'), JSON.stringify({
      family: 'missing_action',
      targetFile: 'src/orders/process.ts',
      targetSymbol: 'function:src/orders/process.ts:processOrder',
      whyThisBoundary: 'attack the export',
      patch: [{ op: 'replace', file: 'src/orders/process.ts', find: 'a', replace: 'b' }],
      testTarget: { command: ['bun', 'test', 'tests/behavioral/orders/process.behavior.test.ts'] },
      predictedOutcome: 'survived',
      survivalRationale: 'tests are shallow',
    }), 'utf-8')

    let runPollCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/healthz')) {
        return jsonResponse(200, { ok: true, service: 'metarepo' })
      }
      if (url.endsWith('/repos') && init?.method === 'POST') {
        return jsonResponse(201, {
          id: 'repo-1',
          name: 'repo-red',
          sourceKind: 'local',
          rootPath: repoRoot,
          cloneUrl: null,
          defaultBranch: null,
          authRef: null,
          registryPath: null,
          defaultEnvProfileId: null,
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        })
      }
      if (url.endsWith('/rpc/red.mutate.start') && init?.method === 'POST') {
        return jsonResponse(200, {
          run: {
            id: 'run-red-1',
            repoId: 'repo-1',
            workflow: 'red.mutate',
            status: 'pending',
            sourceFingerprint: {
              repoId: 'repo-1',
              sourceKind: 'local',
              rootPath: repoRoot,
              dirty: true,
              createdAt: '2026-03-11T00:00:00.000Z',
            },
            requestedBy: 'metarepo-cli:red.mutate',
            errorMessage: null,
            graphDatabaseName: null,
            tempRootPath: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            startedAt: null,
            finishedAt: null,
            updatedAt: '2026-03-11T00:00:00.000Z',
          },
        })
      }
      if (url.endsWith('/runs/run-red-1') && init?.method !== 'POST') {
        runPollCount += 1
        return jsonResponse(200, {
          id: 'run-red-1',
          repoId: 'repo-1',
          workflow: 'red.mutate',
          status: runPollCount >= 2 ? 'succeeded' : 'running',
          sourceFingerprint: {
            repoId: 'repo-1',
            sourceKind: 'local',
            rootPath: repoRoot,
            dirty: true,
            createdAt: '2026-03-11T00:00:00.000Z',
          },
          requestedBy: 'metarepo-cli:red.mutate',
          errorMessage: null,
          graphDatabaseName: null,
          tempRootPath: '/tmp/metarepo-run',
          createdAt: '2026-03-11T00:00:00.000Z',
          startedAt: '2026-03-11T00:00:01.000Z',
          finishedAt: runPollCount >= 2 ? '2026-03-11T00:00:05.000Z' : null,
          updatedAt: '2026-03-11T00:00:05.000Z',
        })
      }
      if (url.endsWith('/runs/run-red-1/events') && init?.method !== 'POST') {
        return jsonResponse(200, [
          {
            id: 'event-1',
            repoId: 'repo-1',
            runId: 'run-red-1',
            eventType: 'mutation.workspace.prepared',
            payload: { sourceRoot: repoRoot },
            createdAt: '2026-03-11T00:00:01.000Z',
          },
          {
            id: 'event-2',
            repoId: 'repo-1',
            runId: 'run-red-1',
            eventType: 'mutation.baseline.started',
            payload: { command: ['bun', 'test'] },
            createdAt: '2026-03-11T00:00:02.000Z',
          },
          {
            id: 'event-3',
            repoId: 'repo-1',
            runId: 'run-red-1',
            eventType: 'mutation.result',
            payload: { status: 'survived' },
            createdAt: '2026-03-11T00:00:04.000Z',
          },
        ])
      }
      if (url.endsWith('/runs/run-red-1/artifacts') && init?.method !== 'POST') {
        return jsonResponse(200, [
          {
            id: 'artifact-proposal',
            repoId: 'repo-1',
            runId: 'run-red-1',
            kind: 'mutation_proposal',
            title: 'proposal',
            payload: {},
            sourceFingerprint: {
              repoId: 'repo-1',
              sourceKind: 'local',
              rootPath: repoRoot,
              dirty: true,
              createdAt: '2026-03-11T00:00:00.000Z',
            },
            createdAt: '2026-03-11T00:00:03.000Z',
          },
          {
            id: 'artifact-result',
            repoId: 'repo-1',
            runId: 'run-red-1',
            kind: 'mutation_result',
            title: 'result',
            payload: {
              id: 'artifact-proposal',
              status: 'survived',
              realMutation: true,
              preservesIntendedBehavior: null,
              patchApplied: true,
              workspacePath: '/tmp/metarepo-run',
              testTarget: { command: ['bun', 'test', 'tests/behavioral/orders/process.behavior.test.ts'] },
              testsRun: ['bun test tests/behavioral/orders/process.behavior.test.ts'],
              summary: 'Mutation survived the named test target',
              reason: 'The named test target still passed after applying the mutation.',
            },
            sourceFingerprint: {
              repoId: 'repo-1',
              sourceKind: 'local',
              rootPath: repoRoot,
              dirty: true,
              createdAt: '2026-03-11T00:00:00.000Z',
            },
            createdAt: '2026-03-11T00:00:04.000Z',
          },
        ])
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const previousCwd = process.cwd()
    process.chdir(repoRoot)
    try {
      await runCli(['red', 'mutate', '--file', path.join(tempRoot, 'mutation.json')])
    } finally {
      process.chdir(previousCwd)
    }

    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/rpc/red.mutate.start'))).toBe(true)
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/runs/run-red-1/events'))).toBe(true)
    expect(console.error).toHaveBeenCalledWith('[metarepo] started red mutate run run-red-1')
    expect(console.error).toHaveBeenCalledWith('[metarepo] mutation workspace prepared')
    expect(console.error).toHaveBeenCalledWith('[metarepo] mutation result: survived')
    const output = JSON.parse(String((console.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '{}')) as {
      run: { id: string; status: string }
      result: { status: string }
    }
    expect(output.run.id).toBe('run-red-1')
    expect(output.result.status).toBe('survived')
  })

  it('prints the red mutation schema without requiring a server', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('fetch should not be called for red schema')
    }) as unknown as typeof fetch

    await runCli(['red', 'schema'])

    expect(console.log).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String((console.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '{}')) as {
      schema: { title: string }
      example: { targetFile: string; patch: Array<{ op: string }> }
    }
    expect(payload.schema.title).toBe('Metarepo Mutation Proposal')
    expect(payload.example.targetFile).toBe('src/orders/process.ts')
    expect(payload.example.patch[0]?.op).toBe('replace')
  })
})
