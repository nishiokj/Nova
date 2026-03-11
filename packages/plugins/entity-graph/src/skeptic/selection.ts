import { execSync } from 'child_process'
import path from 'path'
import type { Entity } from '../types.js'
import type {
  BoundaryInfo,
  CallTreeNode,
  DependencyInfo,
  EnvVarInfo,
  SubstitutionRegistry,
} from '../test-health.js'
import { DEFAULT_SKEPTIC_CONFIG, type BoundaryCandidate } from './types.js'

export interface SkepticSelectionContext {
  getRegistry(): Promise<SubstitutionRegistry>
  getSourceRoot(): string
  boundaries(filepath?: string): Promise<BoundaryInfo[]>
  callTree(entityId: string, maxDepth?: number): Promise<CallTreeNode[]>
  depsFor(entityId: string): Promise<DependencyInfo[]>
  envVarsFor(entityId: string): Promise<EnvVarInfo[]>
  testFiles(entityId: string): Promise<Entity[]>
}

export interface SelectBoundaryCandidatesOptions {
  selector?: string
  maxDepth?: number
  recentPaths?: string[]
}

interface CandidateSeed {
  info: BoundaryInfo
  recentPaths: string[]
}

export async function selectBoundaryCandidates(
  context: SkepticSelectionContext,
  opts?: SelectBoundaryCandidatesOptions,
): Promise<BoundaryCandidate[]> {
  const registry = await context.getRegistry()
  const config = registry.skeptic ?? DEFAULT_SKEPTIC_CONFIG
  const selector = normalizeSelector(opts?.selector)
  const allBoundaries = await context.boundaries()
  const recentPaths = selector === 'recent'
    ? normalizePaths(opts?.recentPaths ?? recentPathsFromGit(context.getSourceRoot()))
    : []
  const testFileCache = new Map<string, Entity[]>()

  const seeds = selector === 'recent'
    ? await selectRecentSeeds(context, allBoundaries, recentPaths, testFileCache, config.selection.preferRecent)
    : await selectExplicitSeeds(context, allBoundaries, selector, testFileCache)

  const candidates: BoundaryCandidate[] = []

  for (const seed of seeds) {
    if (seed.info.fanIn < config.selection.minFanIn && seed.recentPaths.length === 0) continue

    const tests = await getCachedTestFiles(context, testFileCache, seed.info.entity.id)
    candidates.push(await hydrateBoundaryCandidate(context, seed.info, {
      maxDepth: opts?.maxDepth,
      recentPaths: seed.recentPaths,
      testFiles: tests,
    }))
  }

  const sorted = candidates.sort((a, b) => (
    b.riskScore - a.riskScore
    || Number(b.recent) - Number(a.recent)
    || b.fanIn - a.fanIn
    || a.boundaryId.localeCompare(b.boundaryId)
  ))

  if (selector !== 'recent') return sorted
  return sorted.slice(0, Math.max(config.mutation.maxBoundariesPerRun, 1))
}

async function selectRecentSeeds(
  context: SkepticSelectionContext,
  allBoundaries: BoundaryInfo[],
  recentPaths: string[],
  testFileCache: Map<string, Entity[]>,
  _preferRecent: boolean,
): Promise<CandidateSeed[]> {
  if (recentPaths.length === 0) {
    return allBoundaries.map(info => ({ info, recentPaths: [] }))
  }

  const recentSet = new Set(recentPaths)
  const matches: CandidateSeed[] = []

  for (const info of allBoundaries) {
    const hitPaths = new Set<string>()
    const boundaryFile = normalizeRelPath(info.entity.filepath)
    if (recentSet.has(boundaryFile)) {
      hitPaths.add(boundaryFile)
    }

    if (recentPaths.length > 0) {
      const tests = await getCachedTestFiles(context, testFileCache, info.entity.id)
      for (const testFile of tests) {
        const testPath = normalizeRelPath(testFile.filepath)
        if (recentSet.has(testPath)) {
          hitPaths.add(testPath)
        }
      }
    }

    if (hitPaths.size > 0) {
      matches.push({ info, recentPaths: [...hitPaths] })
    }
  }

  if (matches.length > 0) return matches
  return allBoundaries.map(info => ({ info, recentPaths: [] }))
}

async function selectExplicitSeeds(
  context: SkepticSelectionContext,
  allBoundaries: BoundaryInfo[],
  selector: string,
  testFileCache: Map<string, Entity[]>,
): Promise<CandidateSeed[]> {
  const matches: CandidateSeed[] = []
  const normalizedSelector = normalizeRelPath(selector)

  for (const info of allBoundaries) {
    if (matchesPath(info.entity.filepath, normalizedSelector)) {
      matches.push({ info, recentPaths: [] })
      continue
    }

    const tests = await getCachedTestFiles(context, testFileCache, info.entity.id)
    if (tests.some(testFile => matchesPath(testFile.filepath, normalizedSelector))) {
      matches.push({ info, recentPaths: [] })
    }
  }

  return matches
}

async function getCachedTestFiles(
  context: SkepticSelectionContext,
  cache: Map<string, Entity[]>,
  entityId: string,
): Promise<Entity[]> {
  const cached = cache.get(entityId)
  if (cached) return cached

  const tests = await context.testFiles(entityId)
  cache.set(entityId, tests)
  return tests
}

function buildCandidate(
  seed: CandidateSeed,
  tests: Entity[],
  deps: DependencyInfo[],
  envVars: EnvVarInfo[],
  tree: CallTreeNode[],
): BoundaryCandidate {
  const reasons: string[] = []
  let riskScore = 0
  const injectedNodeCount = tree.filter(node => node.injected).length

  if (seed.recentPaths.length > 0) {
    riskScore += 60
    reasons.push(`recent-change:${seed.recentPaths.join(',')}`)
  }

  if (seed.info.readiness === 'ready') {
    riskScore += 25
    reasons.push('ready')
  } else if (seed.info.readiness === 'unknown') {
    riskScore += 5
    reasons.push('unknown-readiness')
  } else {
    riskScore -= 20
    reasons.push('blocked')
  }

  riskScore += Math.min(seed.info.fanIn, 10) * 5
  reasons.push(`fan-in=${seed.info.fanIn}`)

  if (tests.length > 0) {
    riskScore += 15
    reasons.push(`tests=${tests.length}`)
  } else {
    riskScore -= 10
    reasons.push('no-covering-tests')
  }

  if (deps.length > 0) {
    riskScore += Math.min(deps.length, 5) * 4
    reasons.push(`deps=${deps.length}`)
  }

  if (envVars.length > 0) {
    riskScore += Math.min(envVars.length, 4) * 4
    reasons.push(`env=${envVars.length}`)
  }

  if (injectedNodeCount > 0) {
    riskScore += Math.min(injectedNodeCount, 5) * 3
    reasons.push(`injected=${injectedNodeCount}`)
  }

  return {
    boundaryId: seed.info.entity.id,
    file: seed.info.entity.filepath,
    name: seed.info.entity.name,
    kind: seed.info.entity.kind as BoundaryCandidate['kind'],
    fanIn: seed.info.fanIn,
    readiness: seed.info.readiness,
    hasTests: seed.info.hasTests,
    testFileCount: tests.length,
    depCount: deps.length,
    envVarCount: envVars.length,
    injectedNodeCount,
    recent: seed.recentPaths.length > 0,
    recentPaths: seed.recentPaths,
    riskScore,
    reasons,
  }
}

export async function hydrateBoundaryCandidate(
  context: SkepticSelectionContext,
  info: BoundaryInfo,
  opts?: {
    maxDepth?: number
    recentPaths?: string[]
    testFiles?: Entity[]
  },
): Promise<BoundaryCandidate> {
  const tests = opts?.testFiles ?? await context.testFiles(info.entity.id)
  const [deps, envVars, tree] = await Promise.all([
    context.depsFor(info.entity.id),
    context.envVarsFor(info.entity.id),
    context.callTree(info.entity.id, opts?.maxDepth ?? 4),
  ])

  return buildCandidate(
    {
      info,
      recentPaths: opts?.recentPaths ?? [],
    },
    tests,
    deps,
    envVars,
    tree,
  )
}

function recentPathsFromGit(sourceRoot: string): string[] {
  const paths = new Set<string>()
  for (const line of runGit(sourceRoot, ['status', '--porcelain']).split('\n')) {
    if (!line) continue
    const filepath = line.length > 3 ? line.slice(3).trim() : ''
    if (filepath) paths.add(normalizeRelPath(filepath))
  }

  const headRef = runGit(sourceRoot, ['rev-parse', '--verify', 'HEAD~1']).trim()
  if (!headRef) return [...paths]

  for (const filepath of runGit(sourceRoot, ['diff', '--name-only', '--diff-filter=AM', 'HEAD~1', 'HEAD']).split('\n')) {
    if (!filepath) continue
    paths.add(normalizeRelPath(filepath))
  }

  return [...paths]
}

function runGit(sourceRoot: string, args: string[]): string {
  try {
    return execSync(`git ${args.map(escapeShellArg).join(' ')}`, {
      cwd: sourceRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function normalizeSelector(selector?: string): string {
  if (!selector || selector.trim().length === 0) return 'recent'
  return normalizeRelPath(selector.trim())
}

function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeRelPath).filter(Boolean))]
}

function normalizeRelPath(filepath: string): string {
  const normalized = filepath.replace(/\\/g, '/')
  return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

function matchesPath(filepath: string, selector: string): boolean {
  const normalizedPath = normalizeRelPath(filepath)
  const normalizedSelector = normalizeRelPath(selector)
  if (normalizedSelector === 'recent') return false
  if (normalizedPath === normalizedSelector) return true
  if (normalizedPath.startsWith(`${normalizedSelector}/`)) return true
  if (normalizedPath.includes(normalizedSelector)) return true

  const basename = path.posix.basename(normalizedPath)
  return basename === normalizedSelector
}
