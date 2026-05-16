#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  blueAssign,
  blueAssignClaim,
  contractAcknowledge,
  contractBatchCreate,
  contractChallenge,
  contractCheck,
  contractCompile,
  contractInterview,
  contractSubmitProof,
  contractUpdateTestPaths,
  contractVerify,
  createBlueClaimDefense,
  createBlueHandoff,
  createBehaviorClaim,
  createBug,
  createEnvProfile,
  createSecretRef,
  ensureGitRepo,
  ensureLocalRepo,
  getRun,
  getLatestBlueHandoff,
  graphBoundaries,
  graphDeps,
  graphEnv,
  graphGaps,
  graphIndex,
  graphReadiness,
  graphTree,
  listRepoArtifacts,
  listBehaviorClaims,
  listRunArtifacts,
  listRunEvents,
  redDossier,
  redTargets,
  recordRedMutate,
  refereeRun,
  refereeVerdict,
  startRedMutate,
  testRecentPaths,
  testSmells,
  updateRepo,
} from './client.js'
import { main as serveMain } from './index.js'
import { evaluateMutation, runCommand } from './mutation_evaluator.js'
import {
  type ArtifactRecord,
  BEHAVIOR_CLAIM_EXAMPLE,
  BEHAVIOR_CLAIM_JSON_SCHEMA,
  BLUE_CLAIM_DEFENSE_EXAMPLE,
  BLUE_CLAIM_DEFENSE_JSON_SCHEMA,
  type BehaviorClaimStatus,
  type EventLedgerRecord,
  MUTATION_PROPOSAL_EXAMPLE,
  MUTATION_PROPOSAL_JSON_SCHEMA,
  MUTATION_VERDICT_JSON_SCHEMA,
  type MutationEvaluationResult,
  type MutationProposalInput,
  type MutationVerdictInput,
  type RepoRecord,
  type RunRecord,
  type SourceFingerprint,
  type WorkflowResponse,
} from './types.js'

type ClientRepoConfig = {
  rootPath: string
  name?: string
  sourceKind?: 'local' | 'git'
  cloneUrl?: string
  defaultBranch?: string
}

type ClientState = {
  version: 1
  repo: ClientRepoConfig
}

const DEFAULT_PORT = process.env.PORT?.trim() ? process.env.PORT.trim() : '8080'
const DEFAULT_BASE_URL = process.env.METAREPO_BASE_URL?.trim() || `http://127.0.0.1:${DEFAULT_PORT}`
const CLI_SOURCE_PATH = fileURLToPath(import.meta.url)
const METAREPO_APP_ROOT = path.resolve(path.dirname(CLI_SOURCE_PATH), '..')
const METAREPO_REPO_ROOT = path.resolve(METAREPO_APP_ROOT, '../../..')
const METAREPO_WRAPPER_PATH = path.join(METAREPO_REPO_ROOT, 'metarepo')
const RED_BLUE_SKILL_SOURCE = path.join(METAREPO_APP_ROOT, 'skills', 'red-blue-team')

type CliErrorCode =
  | 'METAREPO_USAGE'
  | 'METAREPO_UNKNOWN_COMMAND'
  | 'METAREPO_SERVER_UNAVAILABLE'
  | 'METAREPO_REPO_NOT_CONFIGURED'
  | 'METAREPO_REQUEST_FAILED'
  | 'METAREPO_VALIDATION'
  | 'METAREPO_INTERNAL'

class CliError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

function explicitStatePath(): string | null {
  const configured = process.env.METAREPO_CLIENT_STATE_PATH?.trim()
  return configured ? path.resolve(configured) : null
}

function legacyStatePath(): string {
  return path.join(os.homedir(), '.config', 'metarepo', 'client.json')
}

function repoStatePath(startPath: string): string {
  return path.join(resolveRepoRoot(startPath), '.metarepo', 'client.json')
}

function statePath(startPath: string): string {
  return explicitStatePath() ?? repoStatePath(startPath)
}

function coerceRepoConfig(value: unknown): ClientRepoConfig | null {
  if (!value || typeof value !== 'object') return null
  const repo = value as Record<string, unknown>
  if (typeof repo.rootPath !== 'string' || !repo.rootPath.trim()) return null
  return {
    rootPath: repo.rootPath,
    name: typeof repo.name === 'string' ? repo.name : undefined,
    sourceKind: repo.sourceKind === 'git' ? 'git' : 'local',
    cloneUrl: typeof repo.cloneUrl === 'string' ? repo.cloneUrl : undefined,
    defaultBranch: typeof repo.defaultBranch === 'string' ? repo.defaultBranch : undefined,
  }
}

async function readClientStateFile(file: string): Promise<ClientState | null> {
  const raw = await readFile(file, 'utf-8').catch(() => '')
  if (!raw) return null
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const repo = coerceRepoConfig(parsed.repo)
  if (repo) {
    return { version: 1, repo }
  }
  const repos = Array.isArray(parsed.repos)
    ? parsed.repos.map(coerceRepoConfig).filter((repo): repo is ClientRepoConfig => Boolean(repo))
    : []
  if (repos.length > 0) {
    return { version: 1, repo: repos[0] }
  }
  return null
}

async function migrateLegacyClientState(cwd: string): Promise<ClientState | null> {
  if (explicitStatePath()) return null
  const raw = await readFile(legacyStatePath(), 'utf-8').catch(() => '')
  if (!raw) return null
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const repos = Array.isArray(parsed.repos)
    ? parsed.repos.map(coerceRepoConfig).filter((repo): repo is ClientRepoConfig => Boolean(repo))
    : []
  if (repos.length === 0) return null

  const repoRoot = canonicalPath(resolveRepoRoot(cwd))
  const matches = repos
    .filter(repo => {
      const root = canonicalPath(repo.rootPath)
      return repoRoot === root || repoRoot.startsWith(`${root}${path.sep}`) || root.startsWith(`${repoRoot}${path.sep}`)
    })
    .sort((a, b) => b.rootPath.length - a.rootPath.length)
  const repo = matches[0]
  if (!repo) return null

  const state = { version: 1 as const, repo }
  await saveClientState(state, cwd)
  return state
}

async function loadClientState(cwd: string): Promise<ClientState | null> {
  const local = await readClientStateFile(statePath(cwd))
  if (local) return local
  return migrateLegacyClientState(cwd)
}

async function saveClientState(state: ClientState, cwd: string): Promise<void> {
  const file = statePath(cwd)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2), 'utf-8')
}

function resolveRepoRoot(startPath: string): string {
  const absolute = path.resolve(startPath)
  try {
    return execFileSync(
      'git',
      ['-C', absolute, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
  } catch {
    return absolute
  }
}

function canonicalPath(input: string): string {
  const absolute = path.resolve(input)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function optionalGitOutput(rootPath: string, args: string[]): string | undefined {
  try {
    const output = execFileSync(
      'git',
      ['-C', rootPath, ...args],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return output || undefined
  } catch {
    return undefined
  }
}

function inferGitRemoteUrl(rootPath: string): string {
  const remote = optionalGitOutput(rootPath, ['config', '--get', 'remote.origin.url'])
  if (!remote) {
    throw new Error('client-mode registration requires a git remote at remote.origin.url')
  }
  return remote
}

function inferGitBranch(rootPath: string): string | undefined {
  return optionalGitOutput(rootPath, ['branch', '--show-current'])
}

export function parseEnvFileContents(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separatorIndex = normalized.includes('=')
      ? normalized.indexOf('=')
      : normalized.indexOf(',')
    if (separatorIndex <= 0) {
      throw new Error(`Invalid env line: ${rawLine}`)
    }
    const key = normalized.slice(0, separatorIndex).trim()
    let value = normalized.slice(separatorIndex + 1).trim()
    if (!key) {
      throw new Error(`Invalid env key in line: ${rawLine}`)
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    } else {
      const commentIndex = value.search(/\s#/)
      if (commentIndex >= 0) {
        value = value.slice(0, commentIndex).trim()
      }
    }
    values[key] = value
  }
  return values
}

function printUsage(): void {
  console.log([
    'Usage:',
    '  metarepo serve',
    '  metarepo status',
    '  metarepo doctor [--base-url URL]',
    '  metarepo install client [path] [--force]',
    '  metarepo install skill [path] [--force]',
    '  metarepo install all [path] [--force]',
    '  metarepo add [path] [--name repo-name]',
    '  metarepo add --client [path] [--name repo-name]',
    '  metarepo repo show',
    '  metarepo claims schema',
    '  metarepo claims create --file claim.json',
    '  metarepo claims list [--status open|assigned|defended|stale|dismissed]',
    '  metarepo blue schema',
    '  metarepo blue assign [selector] [--max-depth 5]',
    '  metarepo blue assign-claim [selector]',
    '  metarepo blue record --file payload.json',
    '  metarepo blue record-defense --file payload.json',
    '  metarepo blue latest',
    '  metarepo secrets add --file path/to/.env [--profile default]',
    '  metarepo graph boundaries [filepath]',
    '  metarepo graph gaps [filepath]',
    '  metarepo graph deps <entity-id>',
    '  metarepo graph tree <entity-id> [--max-depth 5]',
    '  metarepo graph env <entity-id>',
    '  metarepo graph readiness <entity-id>',
    '  metarepo graph index [filepath] [--max-depth 5]',
    '  metarepo test recent-paths [selector]',
    '  metarepo test smells [selector]',
    '  metarepo contract compile [--contract-ids id1,id2]',
    '  metarepo contract interview --file responses.json',
    '  metarepo contract create --file contracts.json',
    '  metarepo contract update-test-paths --file updates.json',
    '  metarepo contract check',
    '  metarepo red schema',
    '  metarepo red targets [selector] [--max-depth 5]',
    '  metarepo red dossier <boundary-id> [--max-depth 5]',
    '  metarepo red mutate --file payload.json [--claim-id claim-id]',
    '  metarepo red evaluate --file payload.json [--claim-id claim-id]',
    '  metarepo referee <proposal-artifact-id>',
    '  metarepo referee schema',
    '  metarepo referee verdict --file payload.json',
    '  metarepo artifacts [--kind mutation_proposal|mutation_verdict]',
    '  metarepo bug create --title "..." [--description "..."] [--status open]',
  ].join('\n'))
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2))
}

function printProgress(message: string): void {
  console.error(`[metarepo] ${message}`)
}

function parsePositiveInt(value: string | undefined, field: string): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError('METAREPO_VALIDATION', `${field} must be a positive integer`)
  }
  return parsed
}

function classifyError(error: unknown): { code: CliErrorCode; message: string } {
  if (error instanceof CliError) {
    return { code: error.code, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('No metarepo server is listening')) {
    return { code: 'METAREPO_SERVER_UNAVAILABLE', message }
  }
  if (message.startsWith('No metarepo repo configured')) {
    return { code: 'METAREPO_REPO_NOT_CONFIGURED', message }
  }
  if (message.startsWith('metarepo request failed:')) {
    return { code: 'METAREPO_REQUEST_FAILED', message }
  }
  if (message.startsWith('Unknown metarepo')) {
    return { code: 'METAREPO_UNKNOWN_COMMAND', message }
  }
  if (
    message.includes('requires ')
    || message.includes('must be ')
    || message.includes('already exists')
  ) {
    return { code: 'METAREPO_VALIDATION', message }
  }
  return { code: 'METAREPO_INTERNAL', message }
}

function printCliError(error: unknown): void {
  const classified = classifyError(error)
  if (process.env.METAREPO_JSON_ERRORS === '1') {
    console.error(JSON.stringify({
      ok: false,
      code: classified.code,
      error: classified.message,
    }))
    return
  }
  console.error(`metarepo[${classified.code}]: ${classified.message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatRunEvent(event: EventLedgerRecord): string {
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {}

  switch (event.eventType) {
    case 'run.created':
      return `run created for ${String(payload.workflow ?? 'workflow')}`
    case 'graph.database.created':
      return `graph database created`
    case 'graph.build.started':
      return `building graph`
    case 'graph.built':
      return `graph built (${String(payload.files ?? '?')} files, ${String(payload.durationMs ?? '?')}ms)`
    case 'mutation.workspace.prepared':
      return `mutation workspace prepared`
    case 'mutation.proposal.persisted':
      return `proposal persisted for ${String(payload.targetSymbol ?? 'target')}`
    case 'mutation.evaluation.started':
      return `starting mutation evaluation`
    case 'mutation.baseline.started':
      return `running baseline test target`
    case 'mutation.baseline.finished':
      return `baseline finished (exit ${String(payload.exitCode ?? '?')}, ${String(payload.durationMs ?? '?')}ms)`
    case 'mutation.patch.started':
      return `applying mutation patch`
    case 'mutation.patch.applied':
      return `mutation patch applied`
    case 'mutation.patch.rejected':
      return `mutation patch rejected: ${String(payload.reason ?? 'unknown reason')}`
    case 'mutation.test.started':
      return `running mutated test target`
    case 'mutation.test.finished':
      return `mutated test target finished (exit ${String(payload.exitCode ?? '?')}, ${String(payload.durationMs ?? '?')}ms)`
    case 'mutation.result':
      return `mutation result: ${String(payload.status ?? 'unknown')}`
    case 'mutation.result.recorded':
      return `mutation artifacts recorded (${String(payload.status ?? 'unknown')})`
    case 'run.succeeded':
      return `run succeeded`
    case 'run.failed':
      return `run failed: ${String(payload.error ?? 'unknown error')}`
    default:
      return `${event.eventType}`
  }
}

async function waitForRunCompletion(baseUrl: string, runId: string): Promise<{
  run: RunRecord
  events: EventLedgerRecord[]
}> {
  const seen = new Set<string>()
  let lastVisibleActivityAt = Date.now()

  for (;;) {
    const [run, events] = await Promise.all([
      getRun(baseUrl, runId),
      listRunEvents(baseUrl, runId),
    ])

    let sawNewEvent = false
    for (const event of events) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      sawNewEvent = true
      lastVisibleActivityAt = Date.now()
      printProgress(formatRunEvent(event))
    }

    if (run.status === 'succeeded' || run.status === 'failed') {
      return { run, events }
    }

    if (!sawNewEvent && Date.now() - lastVisibleActivityAt >= 10000) {
      printProgress(`still waiting on run ${run.id} (${run.status})`)
      lastVisibleActivityAt = Date.now()
    }

    await sleep(1000)
  }
}

function extractMutationWorkflowResponse(run: RunRecord, artifacts: ArtifactRecord[]): WorkflowResponse<MutationEvaluationResult> {
  const resultArtifact = [...artifacts].reverse().find(artifact => artifact.kind === 'mutation_result')
  if (!resultArtifact) {
    throw new Error(`run ${run.id} completed without a mutation_result artifact`)
  }

  return {
    run,
    artifacts,
    result: resultArtifact.payload as MutationEvaluationResult,
  }
}

async function createLocalEvaluationWorkspace(sourceRoot: string): Promise<{
  sourceRoot: string
  cleanup: () => Promise<void>
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'metarepo-local-eval-'))
  const worktreeRoot = path.join(parent, 'repo')
  const canUseWorktree = optionalGitOutput(sourceRoot, ['rev-parse', '--is-inside-work-tree']) === 'true'
    && Boolean(optionalGitOutput(sourceRoot, ['rev-parse', '--verify', 'HEAD']))

  try {
    if (canUseWorktree) {
      const headSha = optionalGitOutput(sourceRoot, ['rev-parse', 'HEAD']) ?? 'HEAD'
      await runCommand({
        command: 'git',
        cwd: sourceRoot,
        args: ['worktree', 'add', '--detach', worktreeRoot, headSha],
        timeoutMs: 60_000,
      })
      await symlink(path.join(sourceRoot, 'node_modules'), path.join(worktreeRoot, 'node_modules')).catch(() => {})
      await copyDirtyFiles(sourceRoot, worktreeRoot)
      return {
        sourceRoot: worktreeRoot,
        cleanup: async () => {
          await runCommand({
            command: 'git',
            cwd: sourceRoot,
            args: ['worktree', 'remove', '--force', worktreeRoot],
            timeoutMs: 60_000,
            rejectOnNonZero: false,
          }).catch(() => undefined)
          await rm(parent, { recursive: true, force: true })
        },
      }
    }

    await cp(sourceRoot, worktreeRoot, {
      recursive: true,
      force: true,
      filter: item => path.basename(item) !== '.git',
    })
    return {
      sourceRoot: worktreeRoot,
      cleanup: async () => {
        await rm(parent, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(parent, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function copyDirtyFiles(sourceRoot: string, worktreeRoot: string): Promise<void> {
  const modified = await runCommand({
    command: 'git',
    cwd: sourceRoot,
    args: ['diff', '--name-only', '--diff-filter=AM'],
    timeoutMs: 60_000,
    rejectOnNonZero: false,
  })
  const untracked = await runCommand({
    command: 'git',
    cwd: sourceRoot,
    args: ['ls-files', '--others', '--exclude-standard'],
    timeoutMs: 60_000,
    rejectOnNonZero: false,
  })
  const relPaths = [...new Set([
    ...modified.stdout.split(/\r?\n/),
    ...untracked.stdout.split(/\r?\n/),
  ].map(item => item.trim()).filter(Boolean))]

  for (const relPath of relPaths) {
    const src = path.join(sourceRoot, relPath)
    const dst = path.join(worktreeRoot, relPath)
    await mkdir(path.dirname(dst), { recursive: true })
    await cp(src, dst, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function copyMutationTargetFiles(sourceRoot: string, worktreeRoot: string, proposal: MutationProposalInput): Promise<void> {
  const relPaths = [...new Set(proposal.patch.map(operation => operation.file))]
  for (const relPath of relPaths) {
    const src = path.join(sourceRoot, relPath)
    const dst = path.join(worktreeRoot, relPath)
    await mkdir(path.dirname(dst), { recursive: true })
    await cp(src, dst, { recursive: true, force: true }).catch(() => undefined)
  }
}

function buildClientFingerprint(repo: RepoRecord, configured: ClientRepoConfig): SourceFingerprint {
  const rootPath = configured.rootPath
  const status = optionalGitOutput(rootPath, ['status', '--porcelain'])
  return {
    repoId: repo.id,
    sourceKind: repo.sourceKind,
    rootPath,
    cloneUrl: configured.cloneUrl ?? repo.cloneUrl ?? optionalGitOutput(rootPath, ['config', '--get', 'remote.origin.url']),
    commitSha: optionalGitOutput(rootPath, ['rev-parse', 'HEAD']),
    branch: inferGitBranch(rootPath),
    dirty: status !== undefined ? status.length > 0 : true,
    createdAt: new Date().toISOString(),
  }
}

async function assertMetarepoAvailable(baseUrl: string): Promise<void> {
  const healthUrl = new URL('/healthz', baseUrl)
  let response: Response
  try {
    response = await fetch(healthUrl)
  } catch {
    throw new CliError('METAREPO_SERVER_UNAVAILABLE', `No metarepo server is listening at ${baseUrl}. Start it with \`./metarepo serve\`.`)
  }
  if (!response.ok) {
    throw new CliError('METAREPO_SERVER_UNAVAILABLE', `Expected metarepo health endpoint at ${healthUrl.toString()}, got HTTP ${response.status}.`)
  }
}

async function resolveConfiguredRepo(state: ClientState, cwd: string): Promise<ClientRepoConfig> {
  const repo = state.repo
  if (!repo) {
    throw new CliError('METAREPO_REPO_NOT_CONFIGURED', 'No metarepo repo configured for this directory. Run `metarepo add` first.')
  }
  const actualRoot = canonicalPath(resolveRepoRoot(cwd))
  const configuredRoot = canonicalPath(repo.rootPath)
  if (actualRoot !== configuredRoot) {
    throw new Error(
      `Metarepo repo binding mismatch for this directory. Expected ${configuredRoot}, got ${actualRoot}. Run \`metarepo add\` here.`,
    )
  }
  return repo
}

async function resolveCurrentRepo(baseUrlOverride: string | undefined): Promise<{
  baseUrl: string
  configured: ClientRepoConfig
  repo: RepoRecord
}> {
  const state = await loadClientState(process.cwd())
  if (!state) {
    throw new CliError('METAREPO_REPO_NOT_CONFIGURED', 'No metarepo repo configured for this directory. Run `metarepo add` first.')
  }
  const configured = await resolveConfiguredRepo(state, process.cwd())
  const baseUrl = baseUrlOverride ?? DEFAULT_BASE_URL
  await assertMetarepoAvailable(baseUrl)
  const repo = configured.sourceKind === 'git'
    ? await ensureGitRepo(baseUrl, {
      name: configured.name,
      cloneUrl: configured.cloneUrl ?? inferGitRemoteUrl(configured.rootPath),
      defaultBranch: configured.defaultBranch,
    })
    : await ensureLocalRepo(baseUrl, configured)
  return { baseUrl, configured, repo }
}

async function commandStatus(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'base-url': { type: 'string' },
    },
  })
  const baseUrl = values['base-url'] ?? DEFAULT_BASE_URL
  await assertMetarepoAvailable(baseUrl)
  printJson({ ok: true, baseUrl })
}

function commandVersion(command: string, args: string[] = ['--version']): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

async function commandDoctor(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'base-url': { type: 'string' },
    },
  })
  const baseUrl = values['base-url'] ?? DEFAULT_BASE_URL
  const cwd = process.cwd()
  const repoRoot = resolveRepoRoot(cwd)
  const state = await loadClientState(cwd)
  const server = await fetch(new URL('/healthz', baseUrl))
    .then(async response => ({
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null) as unknown,
    }))
    .catch(error => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
  const hasPackageJson = await exists(path.join(repoRoot, 'package.json'))
  const hasCargoToml = await exists(path.join(repoRoot, 'Cargo.toml')) || await exists(path.join(repoRoot, 'rust', 'Cargo.toml'))

  printJson({
    ok: true,
    baseUrl,
    repoRoot,
    client: {
      configured: Boolean(state),
      statePath: statePath(cwd),
      wrapperPath: path.join(repoRoot, '.metarepo', 'bin', 'metarepo'),
      skillPath: path.join(repoRoot, '.agents', 'red-blue-team', 'SKILL.md'),
    },
    server,
    tools: {
      bun: `bun ${Bun.version}`,
      git: commandVersion('git'),
      cargo: hasCargoToml ? commandVersion('cargo') : null,
      npm: hasPackageJson ? commandVersion('npm') : null,
    },
    hints: {
      installClient: !(await exists(path.join(repoRoot, '.metarepo', 'bin', 'metarepo'))),
      installSkill: !(await exists(path.join(repoRoot, '.agents', 'red-blue-team', 'SKILL.md'))),
      repoHasNodePackage: hasPackageJson,
      repoHasRustPackage: hasCargoToml,
    },
  })
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false)
}

function clientWrapperContents(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `exec ${JSON.stringify(METAREPO_WRAPPER_PATH)} "$@"`,
    '',
  ].join('\n')
}

async function installClientWrapper(targetRoot: string, force: boolean): Promise<string> {
  const binDir = path.join(targetRoot, '.metarepo', 'bin')
  const clientPath = path.join(binDir, 'metarepo')
  await mkdir(binDir, { recursive: true })
  if (!force && await exists(clientPath)) {
    throw new CliError('METAREPO_USAGE', `${clientPath} already exists. Re-run with --force to replace it.`)
  }
  await writeFile(clientPath, clientWrapperContents(), { encoding: 'utf-8', mode: 0o755 })
  await chmod(clientPath, 0o755)
  return clientPath
}

async function installRedBlueSkill(targetRoot: string, force: boolean): Promise<string> {
  const skillDir = path.join(targetRoot, '.agents', 'red-blue-team')
  if (!force && await exists(skillDir)) {
    throw new CliError('METAREPO_USAGE', `${skillDir} already exists. Re-run with --force to replace it.`)
  }
  await mkdir(path.dirname(skillDir), { recursive: true })
  await cp(RED_BLUE_SKILL_SOURCE, skillDir, {
    recursive: true,
    force,
    errorOnExist: !force,
  })
  return skillDir
}

async function commandInstall(subcommand: string | undefined, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      force: { type: 'boolean' },
    },
  })
  const targetRoot = resolveRepoRoot(path.resolve(positionals[0] ?? process.cwd()))
  const force = Boolean(values.force)

  switch (subcommand) {
    case 'client': {
      printJson({
        ok: true,
        kind: 'client',
        path: await installClientWrapper(targetRoot, force),
      })
      return
    }
    case 'skill': {
      printJson({
        ok: true,
        kind: 'skill',
        path: await installRedBlueSkill(targetRoot, force),
      })
      return
    }
    case 'all': {
      const clientPath = await installClientWrapper(targetRoot, force)
      const skillPath = await installRedBlueSkill(targetRoot, force)
      printJson({
        ok: true,
        kind: 'all',
        clientPath,
        skillPath,
      })
      return
    }
    default:
      throw new CliError('METAREPO_UNKNOWN_COMMAND', `Unknown metarepo install command: ${subcommand ?? '(missing)'}`)
  }
}

async function commandAdd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      'base-url': { type: 'string' },
      client: { type: 'boolean' },
    },
  })
  const rootPath = resolveRepoRoot(positionals[0] ?? process.cwd())
  const baseUrl = values['base-url'] ?? DEFAULT_BASE_URL
  await assertMetarepoAvailable(baseUrl)
  const repo = values.client
    ? await ensureGitRepo(baseUrl, {
      name: values.name,
      cloneUrl: inferGitRemoteUrl(rootPath),
      defaultBranch: inferGitBranch(rootPath),
    })
    : await ensureLocalRepo(baseUrl, {
      name: values.name,
      rootPath,
    })
  await saveClientState({
    version: 1,
    repo: {
      rootPath,
      name: repo.name,
      sourceKind: values.client ? 'git' : 'local',
      cloneUrl: repo.cloneUrl ?? undefined,
      defaultBranch: repo.defaultBranch ?? undefined,
    },
  }, rootPath)
  printJson({
    ok: true,
    repoId: repo.id,
    sourceKind: repo.sourceKind,
    rootPath,
    cloneUrl: repo.cloneUrl,
  })
}

async function commandRepoShow(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'base-url': { type: 'string' },
    },
  })
  const { repo } = await resolveCurrentRepo(values['base-url'])
  printJson(repo)
}

async function commandClaims(subcommand: string | undefined, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: 'string' },
      status: { type: 'string' },
      'base-url': { type: 'string' },
    },
  })

  switch (subcommand) {
    case 'schema':
      printJson({
        schema: BEHAVIOR_CLAIM_JSON_SCHEMA,
        example: BEHAVIOR_CLAIM_EXAMPLE,
      })
      return
  }

  const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])

  switch (subcommand) {
    case 'create': {
      if (!values.file) throw new Error('claims create requires --file claim.json')
      const claim = JSON.parse(await readFile(path.resolve(values.file), 'utf-8'))
      printJson(await createBehaviorClaim(baseUrl, repo.id, claim))
      return
    }
    case 'list':
      printJson(await listBehaviorClaims(baseUrl, repo.id, values.status as BehaviorClaimStatus | undefined))
      return
    default:
      throw new Error(`Unknown metarepo claims command: ${subcommand ?? '(missing)'}`)
  }
}

async function commandSecretsAdd(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: 'string' },
      profile: { type: 'string' },
      'base-url': { type: 'string' },
    },
  })
  if (!values.file) {
    throw new Error('--file is required')
  }
  const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])
  const envValues = parseEnvFileContents(await readFile(path.resolve(values.file), 'utf-8'))
  const secretBindings: Record<string, string> = {}
  for (const [name, value] of Object.entries(envValues)) {
    const secret = await createSecretRef(baseUrl, repo.id, {
      kind: 'env',
      name,
      provider: 'encrypted_db',
      value,
    })
    secretBindings[name] = secret.id
  }
  const profile = await createEnvProfile(baseUrl, repo.id, {
    name: values.profile ?? 'default',
    variables: {},
    secretBindings,
  })
  await updateRepo(baseUrl, repo.id, { defaultEnvProfileId: profile.id })
  printJson({
    ok: true,
    repoId: repo.id,
    envProfileId: profile.id,
    importedSecretCount: Object.keys(secretBindings).length,
  })
}

async function commandBlue(subcommand: string | undefined, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      'max-depth': { type: 'string' },
      'base-url': { type: 'string' },
    },
  })

  switch (subcommand) {
    case 'schema':
      printJson({
        claimDefense: {
          schema: BLUE_CLAIM_DEFENSE_JSON_SCHEMA,
          example: BLUE_CLAIM_DEFENSE_EXAMPLE,
        },
      })
      return
    case 'assign': {
      const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])
      const response = await blueAssign(baseUrl, {
        repoId: repo.id,
        selector: positionals[0],
        maxDepth: parsePositiveInt(values['max-depth'], 'max-depth'),
        requestedBy: 'metarepo-cli:blue.assign',
      })
      printJson({
        run: response.run,
        artifacts: response.artifacts,
        assignmentArtifactId: response.result.artifact.id,
        assignment: response.result.assignment,
      })
      return
    }
    case 'assign-claim': {
      const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])
      const response = await blueAssignClaim(baseUrl, {
        repoId: repo.id,
        selector: positionals[0],
        requestedBy: 'metarepo-cli:blue.assign-claim',
      })
      printJson({
        run: response.run,
        artifacts: response.artifacts,
        assignmentArtifactId: response.result.artifact.id,
        assignment: response.result.assignment,
      })
      return
    }
    case 'record':
    case 'record-defense':
    case 'latest':
      break
    default:
      throw new Error(`Unknown metarepo blue command: ${subcommand ?? '(missing)'}`)
  }

  const { baseUrl, configured, repo } = await resolveCurrentRepo(values['base-url'])

  switch (subcommand) {
    case 'record':
      if (!values.file) throw new Error('blue record requires --file payload.json')
      printJson(await createBlueHandoff(
        baseUrl,
        repo.id,
        JSON.parse(await readFile(path.resolve(values.file), 'utf-8')),
        'metarepo-cli:blue.record',
      ))
      return
    case 'record-defense':
      if (!values.file) throw new Error('blue record-defense requires --file payload.json')
      printJson(await createBlueClaimDefense(
        baseUrl,
        repo.id,
        JSON.parse(await readFile(path.resolve(values.file), 'utf-8')),
        'metarepo-cli:blue.record-defense',
        buildClientFingerprint(repo, configured),
      ))
      return
    case 'latest':
      printJson(await getLatestBlueHandoff(baseUrl, repo.id))
      return
  }
}

async function commandGraph(subcommand: string | undefined, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'max-depth': { type: 'string' },
      'base-url': { type: 'string' },
    },
  })
  const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])
  const maxDepth = parsePositiveInt(values['max-depth'], 'max-depth')

  switch (subcommand) {
    case 'boundaries':
      printJson(await graphBoundaries(baseUrl, {
        repoId: repo.id,
        filepath: positionals[0],
        requestedBy: 'metarepo-cli:graph.boundaries',
      }))
      return
    case 'gaps':
      printJson(await graphGaps(baseUrl, {
        repoId: repo.id,
        filepath: positionals[0],
        requestedBy: 'metarepo-cli:graph.gaps',
      }))
      return
    case 'deps':
      if (!positionals[0]) throw new Error('graph deps requires <entity-id>')
      printJson(await graphDeps(baseUrl, {
        repoId: repo.id,
        entityId: positionals[0],
        requestedBy: 'metarepo-cli:graph.deps',
      }))
      return
    case 'tree':
      if (!positionals[0]) throw new Error('graph tree requires <entity-id>')
      printJson(await graphTree(baseUrl, {
        repoId: repo.id,
        entityId: positionals[0],
        maxDepth,
        requestedBy: 'metarepo-cli:graph.tree',
      }))
      return
    case 'env':
      if (!positionals[0]) throw new Error('graph env requires <entity-id>')
      printJson(await graphEnv(baseUrl, {
        repoId: repo.id,
        entityId: positionals[0],
        requestedBy: 'metarepo-cli:graph.env',
      }))
      return
    case 'readiness':
      if (!positionals[0]) throw new Error('graph readiness requires <entity-id>')
      printJson(await graphReadiness(baseUrl, {
        repoId: repo.id,
        entityId: positionals[0],
        requestedBy: 'metarepo-cli:graph.readiness',
      }))
      return
    case 'index':
      printJson(await graphIndex(baseUrl, {
        repoId: repo.id,
        filepath: positionals[0],
        maxDepth,
        requestedBy: 'metarepo-cli:graph.index',
      }))
      return
    default:
      throw new Error(`Unknown metarepo graph command: ${subcommand ?? '(missing)'}`)
  }
}

async function commandTest(subcommand: string | undefined, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
    },
  })
  const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])
  const selector = positionals[0]

  switch (subcommand) {
    case 'recent-paths':
      printJson(await testRecentPaths(baseUrl, {
        repoId: repo.id,
        selector,
        requestedBy: 'metarepo-cli:test.recent_paths',
      }))
      return
    case 'smells':
      printJson(await testSmells(baseUrl, {
        repoId: repo.id,
        selector,
        requestedBy: 'metarepo-cli:test.smells',
      }))
      return
    default:
      throw new Error(`Unknown metarepo test command: ${subcommand ?? '(missing)'}`)
  }
}

async function commandContract(subcommand: string | undefined, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      file: { type: 'string' },
    },
  })

  const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])

  switch (subcommand) {
    case 'compile':
      printJson(await contractCompile(baseUrl, {
        repoId: repo.id,
        contractIds: positionals.length > 0 ? positionals : undefined,
        requestedBy: 'metarepo-cli:contract.compile',
      }))
      return
    case 'interview': {
      if (!values.file) throw new Error('contract interview requires --file responses.json')
      const raw = await readFile(path.resolve(values.file), 'utf-8')
      const responses = JSON.parse(raw) as {
        systemDescription: string
        entities: string
        criticalPath: string
        hardRules: string
        painPoints: string
      }
      printJson(await contractInterview(baseUrl, {
        repoId: repo.id,
        responses,
        requestedBy: 'metarepo-cli:contract.interview',
      }))
      return
    }
    case 'create': {
      if (!values.file) throw new Error('contract create requires --file contracts.json')
      const raw = await readFile(path.resolve(values.file), 'utf-8')
      const contracts = JSON.parse(raw) as Array<{
        statement: string
        type: string
        source: string
        confidence: number
        entityIds?: string[]
      }>
      printJson(await contractBatchCreate(baseUrl, {
        repoId: repo.id,
        contracts,
        requestedBy: 'metarepo-cli:contract.create',
      }))
      return
    }
    case 'update-test-paths': {
      if (!values.file) throw new Error('contract update-test-paths requires --file updates.json')
      const raw = await readFile(path.resolve(values.file), 'utf-8')
      const updates = JSON.parse(raw) as Array<{
        contractId: string
        testFilePath: string
      }>
      printJson(await contractUpdateTestPaths(baseUrl, {
        repoId: repo.id,
        updates,
        requestedBy: 'metarepo-cli:contract.update-test-paths',
      }))
      return
    }
    case 'check': {
      const result = await contractCheck(baseUrl, {
        repoId: repo.id,
        requestedBy: 'metarepo-cli:contract.check',
      })
      printJson(result)
      return
    }
    case 'submit-proof': {
      if (!values.file) throw new Error('contract submit-proof requires --file proof.json')
      const raw = await readFile(path.resolve(values.file), 'utf-8')
      const proof = JSON.parse(raw) as {
        contractId: string
        testFiles: string[]
        conditionEvidence: Array<{
          conditionId: string; testFile: string; testName: string; explanation: string
        }>
      }
      printJson(await contractSubmitProof(baseUrl, {
        repoId: repo.id,
        ...proof,
        requestedBy: 'metarepo-cli:contract.submit-proof',
      }))
      return
    }
    case 'challenge': {
      if (!values.file) throw new Error('contract challenge requires --file challenge.json')
      const raw = await readFile(path.resolve(values.file), 'utf-8')
      const challenge = JSON.parse(raw) as {
        contractId: string; conditionId?: string; argument: string; evidence?: string
      }
      printJson(await contractChallenge(baseUrl, {
        repoId: repo.id,
        ...challenge,
        requestedBy: 'metarepo-cli:contract.challenge',
      }))
      return
    }
    case 'acknowledge': {
      const contractId = positionals[0]
      if (!contractId) throw new Error('contract acknowledge requires a contract ID')
      printJson(await contractAcknowledge(baseUrl, {
        repoId: repo.id,
        contractId,
        requestedBy: 'metarepo-cli:contract.acknowledge',
      }))
      return
    }
    case 'verify': {
      printJson(await contractVerify(baseUrl, {
        repoId: repo.id,
        requestedBy: 'metarepo-cli:contract.verify',
      }))
      return
    }
    default:
      throw new Error(`Unknown metarepo contract command: ${subcommand ?? '(missing)'}`)
  }
}

async function commandRed(subcommand: string | undefined, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      'max-depth': { type: 'string' },
      'base-url': { type: 'string' },
      timeout: { type: 'string' },
      'claim-id': { type: 'string' },
    },
  })

  switch (subcommand) {
    case 'schema':
      printJson({
        schema: MUTATION_PROPOSAL_JSON_SCHEMA,
        example: MUTATION_PROPOSAL_EXAMPLE,
      })
      return
    case 'targets':
    case 'dossier':
    case 'mutate':
    case 'evaluate':
      break
    default:
      throw new Error(`Unknown metarepo red command: ${subcommand ?? '(missing)'}`)
  }

  const { baseUrl, configured, repo } = await resolveCurrentRepo(values['base-url'])
  const maxDepth = parsePositiveInt(values['max-depth'], 'max-depth')

  switch (subcommand) {
    case 'targets':
      printJson(await redTargets(baseUrl, {
        repoId: repo.id,
        selector: positionals[0],
        maxDepth,
        requestedBy: 'metarepo-cli:red.targets',
      }))
      return
    case 'dossier':
      if (!positionals[0]) throw new Error('red dossier requires <boundary-id>')
      printJson(await redDossier(baseUrl, {
        repoId: repo.id,
        boundaryId: positionals[0],
        maxDepth,
        requestedBy: 'metarepo-cli:red.dossier',
      }))
      return
    case 'mutate':
      if (!values.file) throw new Error('red mutate requires --file payload.json')
      {
        const payload = JSON.parse(await readFile(path.resolve(values.file), 'utf-8'))
        const started = await startRedMutate(baseUrl, {
          ...payload,
          repoId: repo.id,
          claimId: values['claim-id'],
          requestedBy: 'metarepo-cli:red.mutate',
        })
        printProgress(`started red mutate run ${started.run.id}`)
        const { run } = await waitForRunCompletion(baseUrl, started.run.id)
        const artifacts = await listRunArtifacts(baseUrl, started.run.id)
        if (run.status === 'failed') {
          throw new Error(run.errorMessage || `red mutate run ${run.id} failed`)
        }
        printJson(extractMutationWorkflowResponse(run, artifacts))
      }
      return
    case 'evaluate':
      if (!values.file) throw new Error('red evaluate requires --file payload.json')
      {
        const proposal = JSON.parse(await readFile(path.resolve(values.file), 'utf-8')) as MutationProposalInput
        const workspace = await createLocalEvaluationWorkspace(configured.rootPath)
        try {
          await copyMutationTargetFiles(configured.rootPath, workspace.sourceRoot, proposal)
          printProgress(`prepared local evaluation workspace ${workspace.sourceRoot}`)
          const result = await evaluateMutation({
            sourceRoot: workspace.sourceRoot,
            proposal,
            proposalArtifactId: 'client-local',
            env: process.env,
            timeoutMs: parsePositiveInt(values.timeout, 'timeout') ?? 15 * 60 * 1000,
            recordEvent: async (eventType, payload) => {
              printProgress(formatRunEvent({
                id: eventType,
                repoId: repo.id,
                runId: null,
                eventType,
                payload,
                createdAt: new Date().toISOString(),
              }))
            },
          })
          const response = await recordRedMutate(baseUrl, {
            repoId: repo.id,
            proposal,
            result,
            claimId: values['claim-id'],
            sourceFingerprint: buildClientFingerprint(repo, configured),
            requestedBy: 'metarepo-cli:red.evaluate',
          })
          printJson(response)
        } finally {
          await workspace.cleanup()
        }
      }
      return
  }
}

async function commandReferee(subcommand: string | undefined, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      'base-url': { type: 'string' },
    },
  })

  if (subcommand === 'schema') {
    printJson({ schema: MUTATION_VERDICT_JSON_SCHEMA })
    return
  }

  if (subcommand === 'verdict') {
    if (!values.file) throw new Error('referee verdict requires --file payload.json')
    const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])
    const verdict = JSON.parse(await readFile(path.resolve(values.file), 'utf-8')) as MutationVerdictInput
    printJson(await refereeVerdict(baseUrl, {
      repoId: repo.id,
      verdict,
      requestedBy: 'metarepo-cli:referee.verdict',
    }))
    return
  }

  // Default: treat subcommand as a proposal-artifact-id for re-evaluation
  const proposalId = subcommand
  if (!proposalId) {
    throw new Error('referee requires <proposal-artifact-id>, or: referee schema, referee verdict --file payload.json')
  }
  const baseUrl = values['base-url'] ?? DEFAULT_BASE_URL
  await assertMetarepoAvailable(baseUrl)
  printJson(await refereeRun(baseUrl, {
    proposalArtifactId: proposalId,
    requestedBy: 'metarepo-cli:referee',
  }))
}

async function commandArtifacts(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      kind: { type: 'string' },
      'base-url': { type: 'string' },
    },
  })
  const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])
  printJson(await listRepoArtifacts(baseUrl, repo.id, values.kind))
}

async function commandBugCreate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      title: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string' },
      'base-url': { type: 'string' },
    },
  })
  if (!values.title) {
    throw new Error('bug create requires --title')
  }
  const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])
  printJson(await createBug(baseUrl, repo.id, {
    title: values.title,
    description: values.description,
    status: values.status,
  }))
}

export async function runCli(argv: string[]): Promise<void> {
  const [command, subcommand, ...rest] = argv
  if (!command || command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    return
  }

  if (command === 'serve') {
    await serveMain()
    return
  }
  if (command === 'status') {
    await commandStatus([subcommand, ...rest].filter(Boolean))
    return
  }
  if (command === 'doctor') {
    await commandDoctor([subcommand, ...rest].filter(Boolean))
    return
  }
  if (command === 'install') {
    await commandInstall(subcommand, rest)
    return
  }
  if (command === 'add') {
    await commandAdd([subcommand, ...rest].filter(Boolean))
    return
  }
  if (command === 'repo' && subcommand === 'show') {
    await commandRepoShow(rest)
    return
  }
  if (command === 'claims') {
    await commandClaims(subcommand, rest)
    return
  }
  if (command === 'blue') {
    await commandBlue(subcommand, rest)
    return
  }
  if (command === 'secrets' && subcommand === 'add') {
    await commandSecretsAdd(rest)
    return
  }
  if (command === 'graph') {
    await commandGraph(subcommand, rest)
    return
  }
  if (command === 'test') {
    await commandTest(subcommand, rest)
    return
  }
  if (command === 'contract') {
    await commandContract(subcommand, rest)
    return
  }
  if (command === 'red') {
    await commandRed(subcommand, rest)
    return
  }
  if (command === 'referee') {
    await commandReferee(subcommand, rest)
    return
  }
  if (command === 'artifacts') {
    await commandArtifacts([subcommand, ...rest].filter(Boolean))
    return
  }
  if (command === 'bug' && subcommand === 'create') {
    await commandBugCreate(rest)
    return
  }

  throw new CliError('METAREPO_UNKNOWN_COMMAND', `Unknown metarepo command: ${[command, subcommand].filter(Boolean).join(' ')}`)
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch(error => {
    printCliError(error)
    process.exit(1)
  })
}
