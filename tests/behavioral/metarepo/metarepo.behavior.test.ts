import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMetarepoApi } from '../../../packages/apps/metarepo/src/index.ts'
import { createRequestListener } from '../../../packages/apps/metarepo/src/analysis_routes.ts'
import type { ServiceConfig } from '../../../packages/apps/metarepo/src/types.ts'

const TEST_DB_URL = process.env.TEST_DATABASE_URL
const describeWithDb = TEST_DB_URL ? describe : describe.skip

async function writeRepoFiles(rootPath: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(rootPath, relativePath)
    await mkdir(path.dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
  }
}

function git(rootPath: string, args: string[]): string {
  return execFileSync('git', ['-C', rootPath, ...args], { encoding: 'utf-8' }).trim()
}

async function startServer(config: ServiceConfig): Promise<{ server: Server; baseUrl: string }> {
  const api = createMetarepoApi(config)
  const server = createServer(createRequestListener(api))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
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

describeWithDb('metarepo behavioral flow', () => {
  let tempRoot = ''
  let workdir = ''
  let server: Server | null = null
  let baseUrl = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'metarepo-behavior-'))
    workdir = await mkdtemp(path.join(os.tmpdir(), 'metarepo-workdir-'))
  })

  afterEach(async () => {
    if (server) {
      await stopServer(server)
      server = null
    }
    if (workdir) {
      await rm(workdir, { recursive: true, force: true })
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('registers a repo, runs graph and review workflows, and evaluates a mutation', async () => {
    await writeRepoFiles(tempRoot, {
      'src/math.ts': [
        'export function add(a: number, b: number): number {',
        '  return a + b',
        '}',
        '',
      ].join('\n'),
      'tests/math.test.ts': [
        "import { describe, expect, test } from 'bun:test'",
        "import { add } from '../src/math'",
        '',
        "describe('add', () => {",
        "  test('adds values', () => {",
        '    expect(add(1, 2)).toBe(3)',
        '  })',
        '})',
        '',
      ].join('\n'),
      'tests/env.test.ts': [
        "import { expect, test } from 'bun:test'",
        '',
        "test('injects APP_SECRET from metarepo env profile', () => {",
        "  expect(process.env.APP_SECRET).toBe('super-secret')",
        '})',
        '',
      ].join('\n'),
      'test-health.yaml': [
        'version: 1',
        'substitutions: {}',
        'env_defaults:',
        '  NODE_ENV: test',
        'test_patterns:',
        '  - "tests/**/*.test.ts"',
        'skeptic:',
        '  runner:',
        '    command: ["bun", "test"]',
        '    test_name_flag: "-t"',
        '    timeout_sec: 60',
        '    env: {}',
        '  mutation:',
        '    worktree_dir: ".tmp/test-red-team"',
        '    proposal_dir: ".tmp/test-red-team/proposals"',
        '    max_mutants_per_boundary: 2',
        '    max_boundaries_per_run: 5',
        '  selection:',
        '    prefer_recent: true',
        '    min_fan_in: 1',
        '',
      ].join('\n'),
    })

    git(tempRoot, ['init', '-b', 'main'])
    git(tempRoot, ['config', 'user.email', 'tests@example.com'])
    git(tempRoot, ['config', 'user.name', 'Tests'])
    git(tempRoot, ['add', '.'])
    git(tempRoot, ['commit', '-m', 'base'])
    const baseSha = git(tempRoot, ['rev-parse', 'HEAD'])

    await writeRepoFiles(tempRoot, {
      'src/math.ts': [
        'export function add(a: number, b: number): number {',
        '  return a + b + 1',
        '}',
        '',
      ].join('\n'),
      'tests/math.test.ts': [
        "import { describe, expect, test } from 'bun:test'",
        "import { add } from '../src/math'",
        '',
        "describe('add', () => {",
        "  test('adds values', () => {",
        '    expect(add(1, 2)).toBe(4)',
        '  })',
        '})',
        '',
      ].join('\n'),
    })
    git(tempRoot, ['add', '.'])
    git(tempRoot, ['commit', '-m', 'head'])
    const headSha = git(tempRoot, ['rev-parse', 'HEAD'])

    const started = await startServer({
      port: 0,
      host: '127.0.0.1',
      databaseUrl: TEST_DB_URL!,
      workdir,
      gitBin: 'git',
      requestTimeoutMs: 60_000,
      secretMasterKey: 'behavior-test-master-key',
    })
    server = started.server
    baseUrl = started.baseUrl

    const repoResponse = await fetch(`${baseUrl}/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'math-repo',
        source: {
          kind: 'local',
          rootPath: tempRoot,
          registryPath: 'test-health.yaml',
        },
      }),
    })
    expect(repoResponse.status).toBe(201)
    const repoPayload = await repoResponse.json() as { id: string }

    const indexResponseAfterEnv = await fetch(`${baseUrl}/rpc/graph.index`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: repoPayload.id, maxDepth: 2, requestedBy: 'behavior-test' }),
    })
    expect(indexResponseAfterEnv.status).toBe(200)
    const indexPayload = await indexResponse.json() as {
      result: {
        summary: { totalBoundaries: number }
        boundaries: Array<{ id: string; hasTests: boolean }>
      }
    }
    expect(indexPayload.result.summary.totalBoundaries).toBeGreaterThan(0)
    expect(indexPayload.result.boundaries.some(boundary => boundary.id === 'function:src/math.ts:add')).toBe(true)

    const reviewResponse = await fetch(`${baseUrl}/rpc/review.run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: repoPayload.id,
        baseSha,
        headSha,
        maxDepth: 2,
        requestedBy: 'behavior-test',
      }),
    })
    expect(reviewResponse.status).toBe(200)
    const reviewPayload = await reviewResponse.json() as {
      result: {
        review: { changedEntities: Array<{ entity: { id: string } }> }
        markdown: string
      }
    }
    expect(reviewPayload.result.review.changedEntities.some(item => item.entity.id === 'function:src/math.ts:add')).toBe(true)
    expect(reviewPayload.result.markdown).toContain('Entity Graph PR Review')

    const secretRefResponse = await fetch(`${baseUrl}/repos/${repoPayload.id}/secret-refs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'env',
        name: 'APP_SECRET',
        provider: 'encrypted_db',
        value: 'super-secret',
      }),
    })
    expect(secretRefResponse.status).toBe(201)
    const secretRefPayload = await secretRefResponse.json() as { id: string }

    const envProfileResponse = await fetch(`${baseUrl}/repos/${repoPayload.id}/env-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'default',
        secretBindings: {
          APP_SECRET: secretRefPayload.id,
        },
      }),
    })
    expect(envProfileResponse.status).toBe(201)
    const envProfilePayload = await envProfileResponse.json() as { id: string }

    const updateRepoResponse = await fetch(`${baseUrl}/repos/${repoPayload.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultEnvProfileId: envProfilePayload.id,
      }),
    })
    expect(updateRepoResponse.status).toBe(200)

    const indexResponse = await fetch(`${baseUrl}/rpc/graph.index`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: repoPayload.id,
        filepath: 'src/math.ts',
        maxDepth: 2,
        requestedBy: 'behavior-test',
      }),
    })
    expect(indexResponse.status).toBe(200)

    const recentPathsResponse = await fetch(`${baseUrl}/rpc/test.recent_paths`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: repoPayload.id,
        selector: 'recent',
        requestedBy: 'behavior-test',
      }),
    })
    expect(recentPathsResponse.status).toBe(200)
    const recentPathsPayload = await recentPathsResponse.json() as string[]
    expect(recentPathsPayload).toContain('tests/math.test.ts')

    const smellResponse = await fetch(`${baseUrl}/rpc/test.smells`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: repoPayload.id,
        selector: 'recent',
        requestedBy: 'behavior-test',
      }),
    })
    expect(smellResponse.status).toBe(200)
    const smellPayload = await smellResponse.json() as { files: Array<{ path: string }> }
    expect(smellPayload.files.some(item => item.path === 'tests/math.test.ts')).toBe(true)

    const redTargetsResponse = await fetch(`${baseUrl}/rpc/red.targets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: repoPayload.id,
        selector: 'recent',
        maxDepth: 2,
        requestedBy: 'behavior-test',
      }),
    })
    expect(redTargetsResponse.status).toBe(200)
    const redTargetsPayload = await redTargetsResponse.json() as {
      result: Array<{ boundaryId: string }>
    }
    expect(redTargetsPayload.result.some(item => item.boundaryId === 'function:src/math.ts:add')).toBe(true)

    const mutationResponse = await fetch(`${baseUrl}/rpc/red.mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoId: repoPayload.id,
        requestedBy: 'behavior-test',
        proposal: {
          title: 'Break add result',
          family: 'wrong-value',
          targetFile: 'src/math.ts',
          targetSymbol: 'add',
          whyThisBoundary: 'Simple observable arithmetic behavior.',
          predictedOutcome: 'killed',
          survivalRationale: 'The existing test should catch the wrong value.',
          testTarget: {
            command: ['bun', 'test', 'tests/math.test.ts', 'tests/env.test.ts'],
          },
          patch: [
            {
              op: 'replace',
              file: 'src/math.ts',
              find: 'return a + b + 1',
              replace: 'return a + b + 2',
            },
          ],
        },
      }),
    })
    expect(mutationResponse.status).toBe(200)
    const mutationPayload = await mutationResponse.json() as {
      artifacts: Array<{ kind: string }>
      result: { status: string; patchApplied: boolean; realMutation: boolean }
    }
    expect(mutationPayload.result.status).toBe('killed')
    expect(mutationPayload.result.patchApplied).toBe(true)
    expect(mutationPayload.result.realMutation).toBe(true)
    expect(mutationPayload.artifacts.some(item => item.kind === 'mutation_proposal')).toBe(true)
    expect(mutationPayload.artifacts.some(item => item.kind === 'referee_result')).toBe(true)
  })
})
