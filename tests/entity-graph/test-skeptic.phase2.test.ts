import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'
import type {
  BoundaryInfo,
  CallTreeNode,
  DependencyInfo,
  EnvVarInfo,
  SubstitutionRegistry,
} from 'entity-graph/test-health.js'
import { buildBoundaryDossier, type BoundaryDossierContext } from 'entity-graph/skeptic/boundary_dossier.js'
import { DEFAULT_SKEPTIC_CONFIG } from 'entity-graph/skeptic/types.js'
import type {
  IndexedTestCaseAssertion,
  IndexedTestCaseCall,
  IndexedTestCaseImport,
  IndexedTestCaseMock,
  IndexedTestCaseSeamOverride,
} from 'entity-graph'

function makeEntity(
  id: string,
  filepath: string,
  name: string,
  kind: BoundaryInfo['entity']['kind'],
) {
  return {
    id,
    kind,
    name,
    filepath,
    startLine: 1,
    endLine: 20,
    exported: kind !== 'file',
    async: false,
    rawText: null,
    paramsText: '()',
    returnText: null,
  }
}

function makeBoundaryInfo(
  id: string,
  filepath: string,
  name: string,
  fanIn: number,
  readiness: BoundaryInfo['readiness'],
  hasTests: boolean,
): BoundaryInfo {
  return {
    entity: makeEntity(id, filepath, name, 'function'),
    fanIn,
    readiness,
    hasTests,
  }
}

async function writeRepoFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content)
  }
}

function parseFileViaSubprocess(repoRoot: string, filepath: string) {
  const stdout = execFileSync(
    'bun',
    [
      '-e',
      `
        (async () => {
          const { parseFile } = await import('./packages/plugins/entity-graph/src/pipeline.ts')
          const result = await parseFile(process.env.TARGET_FILE, process.env.TARGET_SOURCE_ROOT)
          if (!result) {
            throw new Error('parseFile returned null')
          }
          process.stdout.write(JSON.stringify({
            testCases: result.testCases,
            testCaseImports: result.testCaseImports,
            testCaseCalls: result.testCaseCalls,
            testCaseAssertions: result.testCaseAssertions,
            testCaseMocks: result.testCaseMocks,
            testCaseSeamOverrides: result.testCaseSeamOverrides,
          }))
        })().catch(err => {
          console.error(err)
          process.exit(1)
        })
      `,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        TARGET_FILE: filepath,
        TARGET_SOURCE_ROOT: repoRoot,
      },
    },
  )

  return JSON.parse(stdout) as {
    testCases: Array<{
      id: string
      filepath: string
      name: string
      lineStart: number
      lineEnd: number
    }>
    testCaseImports: IndexedTestCaseImport[]
    testCaseCalls: IndexedTestCaseCall[]
    testCaseAssertions: IndexedTestCaseAssertion[]
    testCaseMocks: IndexedTestCaseMock[]
    testCaseSeamOverrides: IndexedTestCaseSeamOverride[]
  }
}

function createDossierContext(
  root: string,
  input: {
    boundary: BoundaryInfo
    testFiles: string[]
    deps?: DependencyInfo[]
    envVars?: EnvVarInfo[]
    tree?: CallTreeNode[]
    indexedFacts?: {
      testCases: Array<{
        id: string
        filepath: string
        name: string
        lineStart: number
        lineEnd: number
      }>
      testCaseImports?: IndexedTestCaseImport[]
      testCaseCalls?: IndexedTestCaseCall[]
      testCaseAssertions?: IndexedTestCaseAssertion[]
      testCaseMocks?: IndexedTestCaseMock[]
      testCaseSeamOverrides?: IndexedTestCaseSeamOverride[]
    }
  },
): BoundaryDossierContext {
  const registry: SubstitutionRegistry = {
    version: 1,
    substitutions: {},
    envDefaults: {},
    testPatterns: [],
    skeptic: DEFAULT_SKEPTIC_CONFIG,
  }

  return {
    async getRegistry() {
      return registry
    },
    getSourceRoot() {
      return root
    },
    async boundaries() {
      return [input.boundary]
    },
    async boundaryInfo(entityId: string) {
      return entityId === input.boundary.entity.id ? input.boundary : null
    },
    async callTree() {
      return input.tree ?? []
    },
    async depsFor() {
      return input.deps ?? []
    },
    async envVarsFor() {
      return input.envVars ?? []
    },
    async testFiles() {
      return input.testFiles.map((filepath, index) =>
        makeEntity(`file:${index}:${filepath}`, filepath, path.basename(filepath), 'file'))
    },
    async indexedTestFacts() {
      return {
        testCases: input.indexedFacts?.testCases ?? [],
        testCaseImports: input.indexedFacts?.testCaseImports ?? [],
        testCaseCalls: input.indexedFacts?.testCaseCalls ?? [],
        testCaseAssertions: input.indexedFacts?.testCaseAssertions ?? [],
        testCaseMocks: input.indexedFacts?.testCaseMocks ?? [],
        testCaseSeamOverrides: input.indexedFacts?.testCaseSeamOverrides ?? [],
      }
    },
  }
}

describe('test-skeptic phase 2', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), 'entity-graph-skeptic-'))
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('parseFile indexes direct boundary calls, env overrides, and assertion kinds', async () => {
    await writeRepoFiles(repoRoot, {
      'src/orders/process.ts': 'export async function processOrder(input: unknown) { return { total: 1, input } }\n',
      'src/orders/helpers.ts': 'export function inspectDb() { return { status: "ok" } }\n',
      'tests/orders/process.test.ts': `
import { describe, test, expect, vi } from 'vitest'
import { processOrder as subject } from '../../src/orders/process'
import { inspectDb } from '../../src/orders/helpers'

describe('processOrder', () => {
  test('writes receipt', async () => {
    const spy = vi.spyOn(api, 'send')
    process.env.ORDER_MODE = 'test'
    const result = await subject({ id: 1 })

    expect(result.total).toBe(1)
    expect(inspectDb()).toEqual({ status: 'ok' })
    expect(spy).toHaveBeenCalledWith('receipt')
  })
})
`,
    })

    const result = parseFileViaSubprocess(repoRoot, 'tests/orders/process.test.ts')

    expect(result.testCases).toHaveLength(1)
    expect(result.testCases[0].name).toBe('processOrder > writes receipt')
    expect(result.testCaseCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'imported', symbol: 'processOrder', resolvedPath: 'src/orders/process.ts' }),
      expect.objectContaining({ kind: 'imported', symbol: 'inspectDb', resolvedPath: 'src/orders/helpers.ts' }),
    ]))
    expect(result.testCaseSeamOverrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'env', target: 'ORDER_MODE' }),
    ]))
    expect(result.testCaseAssertions.map(assertion => assertion.kind)).toEqual([
      'return-value',
      'return-value',
      'mock-interaction',
    ])
    expect(result.testCaseAssertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'return-value', targetSymbol: 'processOrder', resolvedPath: 'src/orders/process.ts' }),
      expect.objectContaining({ kind: 'return-value', targetSymbol: 'inspectDb', resolvedPath: 'src/orders/helpers.ts' }),
    ]))
    expect(result.testCaseMocks.map(site => site.kind)).toEqual(['spy'])
  })

  test('buildBoundaryDossier surfaces helper-only and env coverage gaps from indexed facts', async () => {
    const boundaryId = 'function:src/orders/process.ts:processOrder'

    await writeRepoFiles(repoRoot, {
      'src/orders/process.ts': `
export function helperScenario() {
  return { ok: true }
}

export function processOrder() {
  return helperScenario()
}
`,
      'tests/orders/process.test.ts': `
import { describe, test, expect, vi } from 'vitest'
import { helperScenario } from '../../src/orders/process'

describe('processOrder', () => {
  test('keeps helper green', () => {
    vi.mock('../../src/payments/client')
    const result = helperScenario()
    expect(result).toBeDefined()
  })
})
`,
    })

    const result = parseFileViaSubprocess(repoRoot, 'tests/orders/process.test.ts')

    const boundary = makeBoundaryInfo(boundaryId, 'src/orders/process.ts', 'processOrder', 4, 'ready', true)
    const context = createDossierContext(repoRoot, {
      boundary,
      testFiles: ['tests/orders/process.test.ts'],
      deps: [
        { paramName: 'payments', paramType: 'PaymentsClient', status: 'wirable' },
      ],
      envVars: [
        {
          varName: 'ORDER_MODE',
          accessor: 'process.env',
          readBy: makeEntity(boundaryId, 'src/orders/process.ts', 'processOrder', 'function'),
          status: 'covered',
          coveredBy: 'ORDER_MODE',
        },
      ],
      tree: [
        {
          entity: makeEntity('function:src/orders/helpers.ts:emitReceipt', 'src/orders/helpers.ts', 'emitReceipt', 'function'),
          depth: 1,
          sameModule: false,
          injected: true,
        },
      ],
      indexedFacts: {
        testCases: result.testCases,
        testCaseImports: result.testCaseImports,
        testCaseCalls: result.testCaseCalls,
        testCaseAssertions: result.testCaseAssertions,
        testCaseMocks: result.testCaseMocks,
        testCaseSeamOverrides: result.testCaseSeamOverrides,
      },
    })

    const dossier = await buildBoundaryDossier(context, boundaryId)

    expect(dossier.testCases).toHaveLength(1)
    expect(dossier.seamCoverage.semanticAssertions).toBe(0)
    expect(dossier.seamCoverage.mockInteractionAssertions).toBe(0)
    expect(dossier.assertionGaps).toContain(
      'Only helper/module-level tests touch this boundary; no indexed test directly exercises the exported boundary.',
    )
    expect(dossier.assertionGaps).toContain(
      'Boundary reads env vars, but the indexed tests never vary env input.',
    )
    expect(dossier.assertionGaps).toContain(
      'Assertions are existence-only and do not pin observable behavior.',
    )
  })
})
