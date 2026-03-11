import type {
  IndexedTestCase,
  IndexedTestCaseAssertion,
  IndexedTestCaseCall,
  IndexedTestCaseImport,
  IndexedTestCaseMock,
  IndexedTestCaseSeamOverride,
} from '../types.js'
import type {
  BoundaryInfo,
  CallTreeNode,
  DependencyInfo,
  EnvVarInfo,
} from '../test-health.js'
import type { IndexedTestFactsBundle } from '../queries.js'
import { hydrateBoundaryCandidate, type SkepticSelectionContext } from './selection.js'
import type {
  AssertionKind,
  BoundaryDossier,
  BoundaryDossierEnvVar,
  BoundaryCandidate,
  MockSite,
  SeamOverride,
  TestCaseFact,
} from './types.js'

export interface BoundaryDossierContext extends SkepticSelectionContext {
  boundaryInfo(entityId: string): Promise<BoundaryInfo | null>
  indexedTestFacts(filepaths: string[]): Promise<IndexedTestFactsBundle>
}

export interface BuildBoundaryDossierOptions {
  maxDepth?: number
}

export async function buildBoundaryDossier(
  context: BoundaryDossierContext,
  boundaryId: string,
  opts?: BuildBoundaryDossierOptions,
): Promise<BoundaryDossier> {
  const info = await context.boundaryInfo(boundaryId)
  if (!info) {
    throw new Error(`Boundary not found: ${boundaryId}`)
  }

  const testFiles = await context.testFiles(boundaryId)
  const [boundary, deps, envVars, tree, indexedFacts] = await Promise.all([
    hydrateBoundaryCandidate(context, info, { maxDepth: opts?.maxDepth, testFiles }),
    context.depsFor(boundaryId),
    context.envVarsFor(boundaryId),
    context.callTree(boundaryId, opts?.maxDepth ?? 4),
    context.indexedTestFacts(testFiles.map(file => file.filepath)),
  ])

  const testCases = materializeTestCaseFacts(boundary, indexedFacts)
  const seamCoverage = buildSeamCoverage(testCases, deps, envVars, tree)
  const assertionGaps = buildAssertionGaps(boundary, testCases, deps, envVars, tree, seamCoverage)

  return {
    boundary,
    callTree: {
      totalNodes: tree.length + 1,
      nodes: [
        {
          entityId: boundary.boundaryId,
          file: boundary.file,
          name: boundary.name,
          depth: 0,
          injected: false,
        },
        ...tree.map(node => ({
          entityId: node.entity.id,
          file: node.entity.filepath,
          name: node.entity.name,
          depth: node.depth,
          injected: node.injected,
        })),
      ],
    },
    deps: deps.map(dep => ({
      name: dep.paramName,
      type: dep.paramType,
      status: dep.status,
    })),
    envVars: envVars.map(envVar => {
      const item: BoundaryDossierEnvVar = {
        name: envVar.varName,
        accessor: envVar.accessor,
        status: envVar.status,
      }
      if (envVar.coveredBy) item.coveredBy = envVar.coveredBy
      if (envVar.default) item.default = envVar.default
      return item
    }),
    testFiles: testFiles.map(file => file.filepath),
    testCases,
    assertionGaps,
    seamCoverage,
  }
}

export function materializeTestCaseFacts(
  boundary: BoundaryCandidate,
  indexedFacts: IndexedTestFactsBundle,
): TestCaseFact[] {
  const importsByCase = groupBy(indexedFacts.testCaseImports, row => row.testCaseId)
  const callsByCase = groupBy(indexedFacts.testCaseCalls, row => row.testCaseId)
  const assertionsByCase = groupBy(indexedFacts.testCaseAssertions, row => row.testCaseId)
  const mocksByCase = groupBy(indexedFacts.testCaseMocks, row => row.testCaseId)
  const seamsByCase = groupBy(indexedFacts.testCaseSeamOverrides, row => row.testCaseId)

  return indexedFacts.testCases
    .map(testCase =>
      materializeOneTestCase(
        boundary,
        testCase,
        importsByCase.get(testCase.id) ?? [],
        callsByCase.get(testCase.id) ?? [],
        assertionsByCase.get(testCase.id) ?? [],
        mocksByCase.get(testCase.id) ?? [],
        seamsByCase.get(testCase.id) ?? [],
      ))
    .sort((a, b) => (
      a.file.localeCompare(b.file)
      || a.lineStart - b.lineStart
      || a.name.localeCompare(b.name)
    ))
}

function materializeOneTestCase(
  boundary: BoundaryCandidate,
  testCase: IndexedTestCase,
  imports: IndexedTestCaseImport[],
  calls: IndexedTestCaseCall[],
  assertions: IndexedTestCaseAssertion[],
  mocks: IndexedTestCaseMock[],
  seams: IndexedTestCaseSeamOverride[],
): TestCaseFact {
  const importedProdSymbols = imports
    .filter(item => item.isProd)
    .map(item => item.importedName)
    .sort((a, b) => a.localeCompare(b))

  const calledProdSymbols = calls
    .filter(call => call.kind === 'imported')
    .map(call => call.symbol)
    .sort((a, b) => a.localeCompare(b))

  const helperCalls = calls
    .filter(call => call.kind === 'helper')
    .map(call => call.symbol)
    .sort((a, b) => a.localeCompare(b))

  const assertionKinds = assertions
    .slice()
    .sort((a, b) => a.line - b.line)
    .map(assertion => normalizeAssertionKind(boundary, assertion))

  const mockSites = mocks
    .slice()
    .sort((a, b) => a.line - b.line)
    .map<MockSite>(mock => ({
      kind: mock.kind,
      api: mock.api,
      target: mock.target,
      line: mock.line,
    }))

  const seamOverrides = seams
    .slice()
    .sort((a, b) => a.line - b.line)
    .map<SeamOverride>(seam => ({
      kind: seam.kind,
      target: seam.target,
      line: seam.line,
    }))

  const envOverrides = seamOverrides
    .filter(seam => seam.kind === 'env')
    .map(seam => seam.target)

  const touchesBoundaryDirectly = calls.some(call =>
    call.kind === 'imported'
    && call.resolvedPath === boundary.file
    && call.symbol === boundary.name)

  const touchesBoundaryModule = touchesBoundaryDirectly
    || imports.some(item => item.resolvedPath === boundary.file)
    || calls.some(call => call.resolvedPath === boundary.file)

  const confidence = touchesBoundaryDirectly
    ? 'high'
    : touchesBoundaryModule
      ? 'medium'
      : 'low'

  return {
    file: testCase.filepath,
    name: testCase.name,
    lineStart: testCase.lineStart,
    lineEnd: testCase.lineEnd,
    importedProdSymbols,
    calledProdSymbols,
    helperCalls,
    assertionKinds,
    mockSites,
    seamOverrides,
    envOverrides,
    touchesBoundaryDirectly,
    touchesBoundaryModule,
    confidence,
  }
}

function normalizeAssertionKind(
  boundary: BoundaryCandidate,
  assertion: IndexedTestCaseAssertion,
): AssertionKind {
  if (
    assertion.resolvedPath
    && assertion.targetSymbol
    && (assertion.kind === 'return-value' || assertion.kind === 'state' || assertion.kind === 'side-effect')
  ) {
    if (assertion.resolvedPath === boundary.file && assertion.targetSymbol === boundary.name) {
      return 'return-value'
    }

    return 'side-effect'
  }

  return assertion.kind as AssertionKind
}

function buildSeamCoverage(
  testCases: TestCaseFact[],
  deps: DependencyInfo[],
  envVars: EnvVarInfo[],
  tree: CallTreeNode[],
): BoundaryDossier['seamCoverage'] {
  const overriddenTargets = new Set<string>()
  let semanticAssertions = 0
  let mockInteractionAssertions = 0

  for (const testCase of testCases) {
    for (const envVar of testCase.envOverrides) overriddenTargets.add(`env:${envVar}`)
    for (const override of testCase.seamOverrides) overriddenTargets.add(`${override.kind}:${override.target}`)
    for (const mockSite of testCase.mockSites) overriddenTargets.add(`mock:${mockSite.target ?? mockSite.api}`)

    for (const kind of testCase.assertionKinds) {
      if (kind === 'mock-interaction') {
        mockInteractionAssertions++
        continue
      }
      if (kind !== 'existence') semanticAssertions++
    }
  }

  return {
    reachableSeams: deps.length + envVars.length + tree.filter(node => node.injected).length,
    overriddenSeams: overriddenTargets.size,
    semanticAssertions,
    mockInteractionAssertions,
  }
}

function buildAssertionGaps(
  boundary: BoundaryCandidate,
  testCases: TestCaseFact[],
  deps: DependencyInfo[],
  envVars: EnvVarInfo[],
  tree: CallTreeNode[],
  seamCoverage: BoundaryDossier['seamCoverage'],
): string[] {
  const gaps: string[] = []
  const directCases = testCases.filter(testCase => testCase.touchesBoundaryDirectly)
  const moduleOnlyCases = testCases.filter(testCase => !testCase.touchesBoundaryDirectly && testCase.touchesBoundaryModule)
  const counts = countAssertionKinds(testCases)
  const hasInjectedTree = tree.some(node => node.injected)
  const hasOverrides = testCases.some(testCase => testCase.seamOverrides.length > 0 || testCase.mockSites.length > 0)

  if (testCases.length === 0) {
    gaps.push('Covering test files were found, but no persisted test-case facts were indexed for this boundary.')
    return gaps
  }

  if (directCases.length === 0) {
    if (moduleOnlyCases.length > 0) {
      gaps.push('Only helper/module-level tests touch this boundary; no indexed test directly exercises the exported boundary.')
    } else {
      gaps.push('Covering test files import the module, but no indexed test case appears to touch this boundary.')
    }
  }

  if (envVars.length > 0 && testCases.every(testCase => testCase.envOverrides.length === 0)) {
    gaps.push('Boundary reads env vars, but the indexed tests never vary env input.')
  }

  if (deps.length > 0 && seamCoverage.mockInteractionAssertions > 0 && seamCoverage.semanticAssertions === 0) {
    gaps.push('Boundary has injectable deps and indexed tests assert only through mock interactions.')
  }

  if (hasInjectedTree && counts['side-effect'] === 0 && counts.state === 0 && (counts['return-value'] > 0 || counts.error > 0)) {
    gaps.push('Boundary reaches injected callees, but indexed tests only pin return/error behavior and never assert downstream state or side effects.')
  }

  if (hasOverrides && counts.ordering === 0 && counts.cleanup === 0) {
    gaps.push('Indexed tests replace seams, timers, or globals without explicit ordering or cleanup assertions.')
  }

  if (counts.existence > 0 && seamCoverage.semanticAssertions === 0 && seamCoverage.mockInteractionAssertions === 0) {
    gaps.push('Assertions are existence-only and do not pin observable behavior.')
  }

  if (boundary.hasTests && counts.error === 0 && counts['return-value'] > 0 && counts['side-effect'] === 0 && counts.state === 0) {
    gaps.push('Indexed tests lean on return-value checks only; they do not exercise broader behavioral invariants.')
  }

  return gaps
}

function countAssertionKinds(testCases: TestCaseFact[]): Record<AssertionKind, number> {
  const counts: Record<AssertionKind, number> = {
    'return-value': 0,
    error: 0,
    state: 0,
    'side-effect': 0,
    ordering: 0,
    cleanup: 0,
    'mock-interaction': 0,
    existence: 0,
  }

  for (const testCase of testCases) {
    for (const kind of testCase.assertionKinds) counts[kind]++
  }

  return counts
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const value of values) {
    const groupKey = key(value)
    const existing = grouped.get(groupKey)
    if (existing) {
      existing.push(value)
    } else {
      grouped.set(groupKey, [value])
    }
  }
  return grouped
}
