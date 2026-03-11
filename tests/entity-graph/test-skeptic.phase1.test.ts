import { parseRegistryYaml } from 'entity-graph/test-health.js'
import type {
  BoundaryInfo,
  CallTreeNode,
  DependencyInfo,
  EnvVarInfo,
  SubstitutionRegistry,
} from 'entity-graph/test-health.js'
import { selectBoundaryCandidates, type SkepticSelectionContext } from 'entity-graph/skeptic/selection.js'
import { DEFAULT_SKEPTIC_CONFIG } from 'entity-graph/skeptic/types.js'

function makeEntity(id: string, filepath: string, name: string, kind: BoundaryInfo['entity']['kind']) {
  return {
    id,
    kind,
    name,
    filepath,
    startLine: 1,
    endLine: 10,
    exported: kind !== 'file',
    async: false,
    rawText: null,
    paramsText: null,
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

function createSelectionContext(input?: {
  registry?: Partial<SubstitutionRegistry>
  boundaries?: BoundaryInfo[]
  tests?: Record<string, string[]>
  deps?: Record<string, number>
  envVars?: Record<string, number>
  injectedNodes?: Record<string, number>
}): SkepticSelectionContext {
  const registry: SubstitutionRegistry = {
    version: 1,
    substitutions: {},
    envDefaults: {},
    testPatterns: [],
    skeptic: {
      ...DEFAULT_SKEPTIC_CONFIG,
      mutation: { ...DEFAULT_SKEPTIC_CONFIG.mutation, maxBoundariesPerRun: 10 },
    },
    ...input?.registry,
  }

  const depsMap = input?.deps ?? {}
  const envMap = input?.envVars ?? {}
  const treeMap = input?.injectedNodes ?? {}

  return {
    async getRegistry() {
      return registry
    },
    getSourceRoot() {
      return '/repo'
    },
    async boundaries() {
      return input?.boundaries ?? []
    },
    async callTree(entityId: string): Promise<CallTreeNode[]> {
      const injectedCount = treeMap[entityId] ?? 0
      return Array.from({ length: injectedCount }, (_, index) => ({
        entity: makeEntity(`${entityId}:callee:${index}`, `src/deps/${index}.ts`, `callee${index}`, 'function'),
        depth: index + 1,
        sameModule: false,
        injected: true,
      }))
    },
    async depsFor(entityId: string): Promise<DependencyInfo[]> {
      return Array.from({ length: depsMap[entityId] ?? 0 }, (_, index) => ({
        paramName: `dep${index}`,
        paramType: `Dep${index}`,
        status: 'wirable',
      }))
    },
    async envVarsFor(entityId: string): Promise<EnvVarInfo[]> {
      return Array.from({ length: envMap[entityId] ?? 0 }, (_, index) => ({
        varName: `ENV_${index}`,
        accessor: 'process.env',
        readBy: makeEntity(entityId, `src/${entityId}.ts`, `reader${index}`, 'function'),
        status: 'covered',
        coveredBy: 'NODE_ENV',
      }))
    },
    async testFiles(entityId: string) {
      return (input?.tests?.[entityId] ?? []).map((filepath, index) =>
        makeEntity(`file:${entityId}:${index}`, filepath, filepath.split('/').pop() ?? filepath, 'file'))
    },
  }
}

describe('test-skeptic phase 1', () => {
  test('parseRegistryYaml provides default skeptic config when omitted', () => {
    const registry = parseRegistryYaml('')
    expect(registry.skeptic).toEqual(DEFAULT_SKEPTIC_CONFIG)
  })

  test('parseRegistryYaml parses skeptic runner, mutation, and selection config', () => {
    const registry = parseRegistryYaml(`
version: 1
skeptic:
  runner:
    command: ["bunx", "vitest", "run", "tests/orders/process.test.ts"]
    test_name_flag: "--testNamePattern"
    timeout_sec: 15
    env:
      NODE_ENV: test
  mutation:
    worktree_dir: ".tmp/custom-skeptic"
    proposal_dir: ".tmp/custom-skeptic/proposals"
    max_mutants_per_boundary: 1
    max_boundaries_per_run: 3
  selection:
    prefer_recent: false
    min_fan_in: 2
`)

    expect(registry.skeptic.runner.command).toEqual([
      'bunx',
      'vitest',
      'run',
      'tests/orders/process.test.ts',
    ])
    expect(registry.skeptic.runner.testNameFlag).toBe('--testNamePattern')
    expect(registry.skeptic.runner.timeoutSec).toBe(15)
    expect(registry.skeptic.runner.env).toEqual({ NODE_ENV: 'test' })
    expect(registry.skeptic.mutation.worktreeDir).toBe('.tmp/custom-skeptic')
    expect(registry.skeptic.mutation.proposalDir).toBe('.tmp/custom-skeptic/proposals')
    expect(registry.skeptic.mutation.maxMutantsPerBoundary).toBe(1)
    expect(registry.skeptic.mutation.maxBoundariesPerRun).toBe(3)
    expect(registry.skeptic.selection.preferRecent).toBe(false)
    expect(registry.skeptic.selection.minFanIn).toBe(2)
  })

  test('selectBoundaryCandidates resolves recent test changes back to production boundaries', async () => {
    const processOrder = 'function:src/orders/process.ts:processOrder'
    const charge = 'function:src/payments/charge.ts:charge'
    const context = createSelectionContext({
      boundaries: [
        makeBoundaryInfo(processOrder, 'src/orders/process.ts', 'processOrder', 4, 'ready', true),
        makeBoundaryInfo(charge, 'src/payments/charge.ts', 'charge', 8, 'blocked', true),
      ],
      tests: {
        [processOrder]: ['tests/orders/process.test.ts'],
        [charge]: ['tests/payments/charge.test.ts'],
      },
      deps: { [processOrder]: 1, [charge]: 2 },
      envVars: { [processOrder]: 1, [charge]: 0 },
      injectedNodes: { [processOrder]: 2, [charge]: 1 },
    })

    const candidates = await selectBoundaryCandidates(context, {
      selector: 'recent',
      recentPaths: ['tests/orders/process.test.ts'],
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0].boundaryId).toBe(processOrder)
    expect(candidates[0].recent).toBe(true)
    expect(candidates[0].recentPaths).toEqual(['tests/orders/process.test.ts'])
  })

  test('selectBoundaryCandidates ranks ready recent boundaries ahead of blocked ones and honors explicit selectors', async () => {
    const processOrder = 'function:src/orders/process.ts:processOrder'
    const reconcile = 'function:src/orders/reconcile.ts:reconcile'
    const context = createSelectionContext({
      registry: {
        skeptic: {
          ...DEFAULT_SKEPTIC_CONFIG,
          mutation: { ...DEFAULT_SKEPTIC_CONFIG.mutation, maxBoundariesPerRun: 1 },
        },
      },
      boundaries: [
        makeBoundaryInfo(processOrder, 'src/orders/process.ts', 'processOrder', 4, 'ready', true),
        makeBoundaryInfo(reconcile, 'src/orders/reconcile.ts', 'reconcile', 7, 'blocked', true),
      ],
      tests: {
        [processOrder]: ['tests/orders/process.test.ts'],
        [reconcile]: ['tests/orders/reconcile.test.ts'],
      },
      deps: { [processOrder]: 2, [reconcile]: 3 },
      envVars: { [processOrder]: 1, [reconcile]: 2 },
      injectedNodes: { [processOrder]: 3, [reconcile]: 2 },
    })

    const recentCandidates = await selectBoundaryCandidates(context, {
      selector: 'recent',
      recentPaths: ['src/orders/process.ts', 'src/orders/reconcile.ts'],
    })
    expect(recentCandidates).toHaveLength(1)
    expect(recentCandidates[0].boundaryId).toBe(processOrder)

    const explicitCandidates = await selectBoundaryCandidates(context, {
      selector: 'src/orders/reconcile.ts',
    })
    expect(explicitCandidates).toHaveLength(1)
    expect(explicitCandidates[0].boundaryId).toBe(reconcile)
  })
})
