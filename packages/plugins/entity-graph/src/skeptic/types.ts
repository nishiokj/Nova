import type {
  TestAssertionKind,
  TestMockKind,
  TestSeamOverrideKind,
} from '../types.js'

export interface SkepticRunnerConfig {
  command: string[]
  testNameFlag: string
  timeoutSec: number
  env: Record<string, string>
}

export interface SkepticMutationConfig {
  worktreeDir: string
  maxMutantsPerBoundary: number
  maxBoundariesPerRun: number
}

export interface SkepticSelectionConfig {
  preferRecent: boolean
  minFanIn: number
}

export interface SkepticConfig {
  runner: SkepticRunnerConfig
  mutation: SkepticMutationConfig
  selection: SkepticSelectionConfig
}

export type BoundaryReadiness = 'ready' | 'blocked' | 'unknown'
export type BoundaryCandidateKind = 'function' | 'method' | 'class'
export type AssertionKind = TestAssertionKind
export type MockSiteKind = TestMockKind
export type SeamOverrideKind = TestSeamOverrideKind

export interface BoundaryCandidate {
  boundaryId: string
  file: string
  name: string
  kind: BoundaryCandidateKind
  fanIn: number
  readiness: BoundaryReadiness
  hasTests: boolean
  testFileCount: number
  depCount: number
  envVarCount: number
  injectedNodeCount: number
  recent: boolean
  recentPaths: string[]
  riskScore: number
  reasons: string[]
}

export interface MockSite {
  kind: MockSiteKind
  api: string
  target: string | null
  line: number
}

export interface SeamOverride {
  kind: SeamOverrideKind
  target: string
  line: number
}

export interface TestCaseFact {
  file: string
  name: string
  lineStart: number
  lineEnd: number
  importedProdSymbols: string[]
  calledProdSymbols: string[]
  helperCalls: string[]
  assertionKinds: AssertionKind[]
  mockSites: MockSite[]
  seamOverrides: SeamOverride[]
  envOverrides: string[]
  touchesBoundaryDirectly: boolean
  touchesBoundaryModule: boolean
  confidence: 'high' | 'medium' | 'low'
}

export interface BoundaryDossierCallTreeNode {
  entityId: string
  file: string
  name: string
  depth: number
  injected: boolean
}

export interface BoundaryDossierDep {
  name: string
  type: string | null
  status: 'wirable' | 'blocked' | 'unknown'
}

export interface BoundaryDossierEnvVar {
  name: string
  accessor: string
  status: 'covered' | 'defaulted' | 'unmapped'
  coveredBy?: string
  default?: string
}

export interface BoundaryDossier {
  boundary: BoundaryCandidate
  callTree: {
    totalNodes: number
    nodes: BoundaryDossierCallTreeNode[]
  }
  deps: BoundaryDossierDep[]
  envVars: BoundaryDossierEnvVar[]
  testFiles: string[]
  testCases: TestCaseFact[]
  assertionGaps: string[]
  seamCoverage: {
    reachableSeams: number
    overriddenSeams: number
    semanticAssertions: number
    mockInteractionAssertions: number
  }
}

export const DEFAULT_SKEPTIC_CONFIG: SkepticConfig = {
  runner: {
    command: ['bunx', 'vitest', 'run'],
    testNameFlag: '-t',
    timeoutSec: 60,
    env: {},
  },
  mutation: {
    worktreeDir: '.tmp/test-skeptic',
    maxMutantsPerBoundary: 2,
    maxBoundariesPerRun: 5,
  },
  selection: {
    preferRecent: true,
    minFanIn: 1,
  },
}

export function cloneDefaultSkepticConfig(): SkepticConfig {
  return {
    runner: {
      command: [...DEFAULT_SKEPTIC_CONFIG.runner.command],
      testNameFlag: DEFAULT_SKEPTIC_CONFIG.runner.testNameFlag,
      timeoutSec: DEFAULT_SKEPTIC_CONFIG.runner.timeoutSec,
      env: { ...DEFAULT_SKEPTIC_CONFIG.runner.env },
    },
    mutation: {
      worktreeDir: DEFAULT_SKEPTIC_CONFIG.mutation.worktreeDir,
      maxMutantsPerBoundary: DEFAULT_SKEPTIC_CONFIG.mutation.maxMutantsPerBoundary,
      maxBoundariesPerRun: DEFAULT_SKEPTIC_CONFIG.mutation.maxBoundariesPerRun,
    },
    selection: {
      preferRecent: DEFAULT_SKEPTIC_CONFIG.selection.preferRecent,
      minFanIn: DEFAULT_SKEPTIC_CONFIG.selection.minFanIn,
    },
  }
}
