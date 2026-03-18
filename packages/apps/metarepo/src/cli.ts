#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  blueAssign,
  contractBatchCreate,
  contractCompile,
  contractInterview,
  contractUpdateTestPaths,
  createBlueHandoff,
  createBug,
  createEnvProfile,
  createSecretRef,
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
  listRunArtifacts,
  listRunEvents,
  redDossier,
  redTargets,
  refereeRun,
  refereeVerdict,
  startRedMutate,
  testRecentPaths,
  testSmells,
  updateRepo,
} from './client.js'
import { main as serveMain } from './index.js'
import {
  type ArtifactRecord,
  type EventLedgerRecord,
  MUTATION_PROPOSAL_EXAMPLE,
  MUTATION_PROPOSAL_JSON_SCHEMA,
  MUTATION_VERDICT_JSON_SCHEMA,
  type MutationEvaluationResult,
  type MutationVerdictInput,
  type RunRecord,
  type WorkflowResponse,
} from './types.js'

type ClientRepoConfig = {
  rootPath: string
  name?: string
}

type ClientState = {
  version: 1
  repo: ClientRepoConfig
}

const DEFAULT_PORT = process.env.PORT?.trim() ? process.env.PORT.trim() : '8080'
const DEFAULT_BASE_URL = process.env.METAREPO_BASE_URL?.trim() || `http://127.0.0.1:${DEFAULT_PORT}`

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
    '  metarepo add [path] [--name repo-name]',
    '  metarepo repo show',
    '  metarepo blue assign [selector] [--max-depth 5]',
    '  metarepo blue record --file payload.json',
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
    '  metarepo red mutate --file payload.json',
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
    throw new Error(`${field} must be a positive integer`)
  }
  return parsed
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

async function assertMetarepoAvailable(baseUrl: string): Promise<void> {
  const healthUrl = new URL('/healthz', baseUrl)
  let response: Response
  try {
    response = await fetch(healthUrl)
  } catch {
    throw new Error(`No metarepo server is listening at ${baseUrl}. Start it with \`./metarepo serve\`.`)
  }
  if (!response.ok) {
    throw new Error(`Expected metarepo health endpoint at ${healthUrl.toString()}, got HTTP ${response.status}.`)
  }
}

async function resolveConfiguredRepo(state: ClientState, cwd: string): Promise<ClientRepoConfig> {
  const repo = state.repo
  if (!repo) {
    throw new Error('No metarepo repo configured for this directory. Run `metarepo add` first.')
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
  repo: Awaited<ReturnType<typeof ensureLocalRepo>>
}> {
  const state = await loadClientState(process.cwd())
  if (!state) {
    throw new Error('No metarepo repo configured for this directory. Run `metarepo add` first.')
  }
  const configured = await resolveConfiguredRepo(state, process.cwd())
  const baseUrl = baseUrlOverride ?? DEFAULT_BASE_URL
  await assertMetarepoAvailable(baseUrl)
  const repo = await ensureLocalRepo(baseUrl, configured)
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

async function commandAdd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      'base-url': { type: 'string' },
    },
  })
  const rootPath = resolveRepoRoot(positionals[0] ?? process.cwd())
  const baseUrl = values['base-url'] ?? DEFAULT_BASE_URL
  await assertMetarepoAvailable(baseUrl)
  const repo = await ensureLocalRepo(baseUrl, {
    name: values.name,
    rootPath,
  })
  await saveClientState({
    version: 1,
    repo: {
      rootPath,
      name: repo.name,
    },
  }, rootPath)
  printJson({
    ok: true,
    repoId: repo.id,
    rootPath,
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
    case 'record':
    case 'latest':
      break
    default:
      throw new Error(`Unknown metarepo blue command: ${subcommand ?? '(missing)'}`)
  }

  const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])

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
      break
    default:
      throw new Error(`Unknown metarepo red command: ${subcommand ?? '(missing)'}`)
  }

  const { baseUrl, repo } = await resolveCurrentRepo(values['base-url'])
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
  if (!command || command === 'help' || command === '--help' || command === '-h') {
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
  if (command === 'add') {
    await commandAdd([subcommand, ...rest].filter(Boolean))
    return
  }
  if (command === 'repo' && subcommand === 'show') {
    await commandRepoShow(rest)
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

  throw new Error(`Unknown metarepo command: ${[command, subcommand].filter(Boolean).join(' ')}`)
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
