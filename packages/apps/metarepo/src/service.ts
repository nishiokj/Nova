import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import postgres from 'postgres'
import type { Sql } from 'postgres'
import { buildFullGraph } from '../../../plugins/entity-graph/src/pipeline.js'
import {
  DEFAULT_GRAPH_EXCLUDE,
  buildDiff,
  formatReviewMarkdown,
  runReview,
} from '../../../plugins/entity-graph/src/pr-review/service.js'
import { TestHealthModule } from '../../../plugins/entity-graph/src/test-health.js'
import { DatabaseManager } from './database_manager.js'
import { decryptSecretValue, encryptSecretValue } from './secrets.js'
import { recentTestPaths, summarizeSmells } from './test_smells.js'
import type {
  ArtifactRecord,
  BlueAssignedBoundary,
  BlueAssignmentPayload,
  BlueAssignmentRecord,
  BlueAssignRequest,
  BlueHandoffInput,
  BlueHandoffPayload,
  BlueHandoffRecord,
  BoundaryCandidate,
  BoundaryDossier,
  BoundaryInfo,
  BugRecord,
  CallTreeNode,
  CreateBugInput,
  CreateBlueHandoffRequest,
  CreateEnvProfileInput,
  CreateRepoInput,
  CreateSecretRefInput,
  DependencyInfo,
  EnvProfileRecord,
  EnvVarInfo,
  GapReport,
  GraphBoundariesRequest,
  GraphBuildStats,
  GraphDepsRequest,
  GraphEnvRequest,
  GraphGapsRequest,
  GraphIndexRequest,
  GraphReadinessRequest,
  GraphTreeRequest,
  MetarepoApi,
  MutationEvaluationResult,
  MutationPatchOperation,
  MutationProposalInput,
  ProjectIndex,
  RedDossierRequest,
  RedMutateRequest,
  RedTargetsRequest,
  ReadinessVerdict,
  RefereeRunRequest,
  RepoRecord,
  ReviewRunRequest,
  ReviewWorkflowResult,
  RunRecord,
  RunSourceRequest,
  SecretRefRecord,
  ServiceConfig,
  SourceFingerprint,
  TestSmellSummary,
  TestRecentPathsRequest,
  TestSmellsRequest,
  UpdateRepoInput,
  WorkflowResponse,
} from './types.js'

type RunCommandInput = {
  cwd: string
  args: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  command?: string
  rejectOnNonZero?: boolean
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type PreparedSourceRoot = {
  sourceRoot: string
  registryPath?: string
  cleanup?: {
    kind: 'directory' | 'git-worktree'
    path: string
    ownerRepoRoot?: string
  }
  sourceFingerprint: SourceFingerprint
}

type StoredTempRoot =
  | {
      kind: 'directory'
      path: string
    }
  | {
      kind: 'git-worktree'
      path: string
      ownerRepoRoot: string
    }

type GraphWorkflowContext = {
  repo: RepoRecord
  run: RunRecord
  sourceRoot: string
  sourceFingerprint: SourceFingerprint
  graphBuild: GraphBuildStats
  testHealth: TestHealthModule
  graphDatabaseUrl: string
  createArtifact: (kind: string, title: string, payload: unknown) => Promise<ArtifactRecord>
  recordEvent: (eventType: string, payload: unknown) => Promise<void>
}

type RepoRow = {
  id: string
  name: string
  source_kind: string
  root_path: string | null
  clone_url: string | null
  default_branch: string | null
  auth_ref: string | null
  registry_path: string | null
  default_env_profile_id: string | null
  created_at: Date
  updated_at: Date
}

type RunRow = {
  id: string
  repo_id: string
  workflow: string
  status: string
  source_fingerprint_json: unknown
  requested_by: string | null
  error_message: string | null
  graph_database_name: string | null
  temp_root_path: string | null
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
  updated_at: Date
}

type ArtifactRow = {
  id: string
  repo_id: string
  run_id: string
  kind: string
  title: string
  payload_json: unknown
  source_fingerprint_json: unknown
  created_at: Date
}

type BugRow = {
  id: string
  repo_id: string
  run_id: string | null
  title: string
  description: string | null
  status: string
  payload_json: unknown
  source_fingerprint_json: unknown
  created_at: Date
  updated_at: Date
}

type EnvProfileRow = {
  id: string
  repo_id: string
  name: string
  variables_json: unknown
  secret_bindings_json: unknown
  created_at: Date
  updated_at: Date
}

type SecretRefRow = {
  id: string
  repo_id: string | null
  kind: string
  name: string
  provider: string
  encrypted_payload: string | null
  external_ref: string | null
  created_at: Date
  updated_at: Date
}

const TEST_FAILURE_INVALID_RE = /syntaxerror|transform failed|build failed|compilation failed|unexpected token|no test files found|no tests found/i
const ALLOWED_PARENT_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'COMSPEC',
  'TERM',
  'SHELL',
  'PWD',
] as const

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function normalizeSourceFingerprint(value: unknown): SourceFingerprint {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid source fingerprint')
  }
  const payload = value as Record<string, unknown>
  return {
    repoId: String(payload.repoId ?? ''),
    sourceKind: (payload.sourceKind === 'git' ? 'git' : 'local'),
    rootPath: typeof payload.rootPath === 'string' ? payload.rootPath : undefined,
    cloneUrl: typeof payload.cloneUrl === 'string' ? payload.cloneUrl : undefined,
    ref: typeof payload.ref === 'string' ? payload.ref : undefined,
    commitSha: typeof payload.commitSha === 'string' ? payload.commitSha : undefined,
    branch: typeof payload.branch === 'string' ? payload.branch : undefined,
    dirty: Boolean(payload.dirty),
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : new Date().toISOString(),
  }
}

function mapRepo(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    name: row.name,
    sourceKind: row.source_kind === 'git' ? 'git' : 'local',
    rootPath: row.root_path,
    cloneUrl: row.clone_url,
    defaultBranch: row.default_branch,
    authRef: row.auth_ref,
    registryPath: row.registry_path,
    defaultEnvProfileId: row.default_env_profile_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    workflow: row.workflow,
    status: row.status as RunRecord['status'],
    sourceFingerprint: normalizeSourceFingerprint(row.source_fingerprint_json),
    requestedBy: row.requested_by,
    errorMessage: row.error_message,
    graphDatabaseName: row.graph_database_name,
    tempRootPath: row.temp_root_path,
    createdAt: row.created_at.toISOString(),
    startedAt: toIsoString(row.started_at),
    finishedAt: toIsoString(row.finished_at),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    runId: row.run_id,
    kind: row.kind,
    title: row.title,
    payload: row.payload_json,
    sourceFingerprint: normalizeSourceFingerprint(row.source_fingerprint_json),
    createdAt: row.created_at.toISOString(),
  }
}

function mapBlueAssignment(artifact: ArtifactRecord): BlueAssignmentRecord {
  return {
    artifact,
    assignment: normalizeBlueAssignmentPayload(artifact.payload),
  }
}

function mapBlueHandoff(artifact: ArtifactRecord): BlueHandoffRecord {
  return {
    artifact,
    handoff: normalizeBlueHandoffPayload(artifact.payload),
  }
}

function mapBug(row: BugRow): BugRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    runId: row.run_id,
    title: row.title,
    description: row.description,
    status: row.status,
    payload: row.payload_json,
    sourceFingerprint: row.source_fingerprint_json ? normalizeSourceFingerprint(row.source_fingerprint_json) : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapEnvProfile(row: EnvProfileRow): EnvProfileRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    name: row.name,
    variables: asStringRecord(row.variables_json),
    secretBindings: asStringRecord(row.secret_bindings_json),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapSecretRef(row: SecretRefRow): SecretRefRecord {
  return {
    id: row.id,
    repoId: row.repo_id,
    kind: row.kind,
    name: row.name,
    provider: row.provider,
    encryptedPayload: row.encrypted_payload,
    externalRef: row.external_ref,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const payload = value as Record<string, unknown>
  return Object.fromEntries(
    Object.entries(payload).filter(([, item]) => typeof item === 'string') as Array<[string, string]>,
  )
}

function normalizeStringList(value: unknown, field: string, opts?: { min?: number }): string[] {
  const items = Array.isArray(value) ? value : []
  if (items.some(item => typeof item !== 'string')) {
    throw new ValidationError(`${field} must contain only strings`)
  }
  const normalized = [...new Set(items.map(item => item.trim()).filter(Boolean))]
  if ((opts?.min ?? 0) > normalized.length) {
    throw new ValidationError(`${field} must contain at least ${opts?.min} item${opts?.min === 1 ? '' : 's'}`)
  }
  return normalized
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeBlueAssignedBoundary(value: unknown, field: string): BlueAssignedBoundary {
  const payload = asObjectRecord(value, field)
  const reasons = normalizeStringList(payload.reasons, `${field}.reasons`)
  const recentPaths = normalizeStringList(payload.recentPaths, `${field}.recentPaths`)
  return {
    boundaryId: requireTrimmedString(payload.boundaryId, `${field}.boundaryId`),
    file: requireTrimmedString(payload.file, `${field}.file`),
    name: requireTrimmedString(payload.name, `${field}.name`),
    kind: requireTrimmedString(payload.kind, `${field}.kind`) as BlueAssignedBoundary['kind'],
    lineStart: asOptionalNumber(payload.lineStart),
    lineEnd: asOptionalNumber(payload.lineEnd),
    fanIn: requireFiniteNumber(payload.fanIn, `${field}.fanIn`),
    readiness: requireTrimmedString(payload.readiness, `${field}.readiness`) as BlueAssignedBoundary['readiness'],
    hasTests: Boolean(payload.hasTests),
    testFileCount: requireFiniteNumber(payload.testFileCount, `${field}.testFileCount`),
    depCount: requireFiniteNumber(payload.depCount, `${field}.depCount`),
    envVarCount: requireFiniteNumber(payload.envVarCount, `${field}.envVarCount`),
    injectedNodeCount: requireFiniteNumber(payload.injectedNodeCount, `${field}.injectedNodeCount`),
    callTreeNodeCount: requireFiniteNumber(payload.callTreeNodeCount, `${field}.callTreeNodeCount`),
    recent: Boolean(payload.recent),
    recentPaths,
    defenseValueScore: requireFiniteNumber(payload.defenseValueScore, `${field}.defenseValueScore`),
    reasons,
  }
}

function normalizeBlueAssignmentPayload(value: unknown): BlueAssignmentPayload {
  const payload = asObjectRecord(value, 'blue assignment')
  return {
    selector: requireTrimmedString(payload.selector, 'assignment.selector'),
    boundary: normalizeBlueAssignedBoundary(payload.boundary, 'assignment.boundary'),
  }
}

function buildBlueHandoffPayload(input: BlueHandoffInput, assignment: BlueAssignmentPayload): BlueHandoffPayload {
  if (!input?.assignmentArtifactId?.trim()) {
    throw new ValidationError('handoff.assignmentArtifactId is required')
  }
  const testFiles = normalizeStringList(input.testFiles, 'handoff.testFiles', { min: 1 })
  const testCommand = normalizeStringList(input.testCommand, 'handoff.testCommand', { min: 1 })
  const changedFiles = normalizeStringList(
    [...(input.changedFiles ?? []), ...testFiles],
    'handoff.changedFiles',
    { min: 1 },
  )
  const bugIds = normalizeStringList(input.bugIds ?? [], 'handoff.bugIds')

  return {
    selector: assignment.selector,
    assignmentArtifactId: input.assignmentArtifactId.trim(),
    boundaryId: assignment.boundary.boundaryId,
    boundary: assignment.boundary,
    testFiles,
    changedFiles,
    testCommand,
    summary: input.summary?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    bugIds,
  }
}

function normalizeBlueHandoffPayload(value: unknown): BlueHandoffPayload {
  const payload = asObjectRecord(value, 'blue handoff')
  return {
    selector: requireTrimmedString(payload.selector, 'handoff.selector'),
    assignmentArtifactId: requireTrimmedString(payload.assignmentArtifactId, 'handoff.assignmentArtifactId'),
    boundaryId: requireTrimmedString(payload.boundaryId, 'handoff.boundaryId'),
    boundary: normalizeBlueAssignedBoundary(payload.boundary, 'handoff.boundary'),
    testFiles: normalizeStringList(payload.testFiles, 'handoff.testFiles', { min: 1 }),
    changedFiles: normalizeStringList(payload.changedFiles, 'handoff.changedFiles', { min: 1 }),
    testCommand: normalizeStringList(payload.testCommand, 'handoff.testCommand', { min: 1 }),
    summary: optionalTrimmedString(payload.summary),
    notes: optionalTrimmedString(payload.notes),
    bugIds: normalizeStringList(payload.bugIds, 'handoff.bugIds'),
  }
}

function asObjectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new ValidationError(`${field} is required`)
  }
  return value as Record<string, unknown>
}

function requireTrimmedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} is required`)
  }
  return value.trim()
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`)
  }
  return value
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeRepoName(input: string): string {
  return input.trim() || 'repo'
}

function defaultRepoName(source: CreateRepoInput['source']): string {
  if (source.kind === 'local') {
    return normalizeRepoName(path.basename(source.rootPath))
  }
  const raw = source.cloneUrl.replace(/\/+$/, '').split('/').at(-1) ?? 'repo'
  return normalizeRepoName(raw.replace(/\.git$/, ''))
}

async function assertAbsoluteDirectory(absPath: string, label: string): Promise<void> {
  if (!path.isAbsolute(absPath)) {
    throw new ValidationError(`${label} must be an absolute path`)
  }
  const info = await stat(absPath).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new ValidationError(`${label} must be an existing directory`)
  }
}

function resolveRegistryPath(sourceRoot: string, registryPath: string | null): string | undefined {
  if (!registryPath) return undefined
  return path.isAbsolute(registryPath) ? registryPath : path.join(sourceRoot, registryPath)
}

function summarizeOutput(output: string): string | undefined {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed
}

function pickParentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_PARENT_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value
    }
  }
  return env
}

function normalizeContentSignal(content: string): string {
  return content.replace(/\s+/g, '')
}

function normalizeSelector(selector?: string): string {
  if (!selector || !selector.trim()) return 'recent'
  return normalizeRelPath(selector.trim())
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
  return path.posix.basename(normalizedPath) === normalizedSelector
}

function lineSpan(boundary: BoundaryInfo['entity']): number {
  if (boundary.startLine == null || boundary.endLine == null || boundary.endLine < boundary.startLine) {
    return 0
  }
  return boundary.endLine - boundary.startLine + 1
}

function buildBlueAssignedBoundary(input: {
  info: BoundaryInfo
  recentPaths: string[]
  testFiles: number
  depCount: number
  envVarCount: number
  injectedNodeCount: number
  callTreeNodeCount: number
}): BlueAssignedBoundary {
  const { info } = input
  const reasons: string[] = []
  let score = 0

  if (info.readiness === 'ready') {
    score += 80
    reasons.push('ready')
  } else if (info.readiness === 'unknown') {
    score += 20
    reasons.push('unknown-readiness')
  } else {
    score -= 60
    reasons.push('blocked')
  }

  if (input.recentPaths.length > 0) {
    score += 55
    reasons.push(`recent-change:${input.recentPaths.join(',')}`)
  }

  const breadthUnits = input.callTreeNodeCount + input.depCount + input.envVarCount + input.injectedNodeCount
  score += Math.min(input.callTreeNodeCount, 12) * 6
  score += Math.min(input.depCount, 6) * 7
  score += Math.min(input.envVarCount, 5) * 6
  score += Math.min(input.injectedNodeCount, 6) * 5
  score += Math.min(info.fanIn, 8) * 2
  score += Math.min(lineSpan(info.entity), 120) / 6
  score += info.hasTests ? Math.min(input.testFiles, 4) * 2 : 10

  if (breadthUnits >= 10) {
    score += 20
    reasons.push(`broad-surface=${breadthUnits}`)
  }
  if (breadthUnits >= 18) {
    score += 30
    reasons.push('broad-surface-bonus')
  }
  if (
    input.callTreeNodeCount <= 2
    && input.depCount === 0
    && input.envVarCount === 0
    && input.injectedNodeCount === 0
    && lineSpan(info.entity) <= 20
  ) {
    score -= 40
    reasons.push('tiny-surface-penalty')
  }

  reasons.push(`fan-in=${info.fanIn}`)
  reasons.push(`call-tree=${input.callTreeNodeCount}`)
  if (input.depCount > 0) reasons.push(`deps=${input.depCount}`)
  if (input.envVarCount > 0) reasons.push(`env=${input.envVarCount}`)
  if (input.injectedNodeCount > 0) reasons.push(`injected=${input.injectedNodeCount}`)
  reasons.push(`span=${lineSpan(info.entity)}`)

  return {
    boundaryId: info.entity.id,
    file: info.entity.filepath,
    name: info.entity.name,
    kind: info.entity.kind as BlueAssignedBoundary['kind'],
    lineStart: info.entity.startLine,
    lineEnd: info.entity.endLine,
    fanIn: info.fanIn,
    readiness: info.readiness,
    hasTests: info.hasTests,
    testFileCount: input.testFiles,
    depCount: input.depCount,
    envVarCount: input.envVarCount,
    injectedNodeCount: input.injectedNodeCount,
    callTreeNodeCount: input.callTreeNodeCount,
    recent: input.recentPaths.length > 0,
    recentPaths: input.recentPaths,
    defenseValueScore: score,
    reasons,
  }
}

function isLikelyTestPath(filepath: string): boolean {
  return /(^|\/)(__tests__|tests)(\/|$)|\.(test|spec)\.[A-Za-z0-9]+$/.test(filepath)
}

function serializeTempRoot(cleanup: PreparedSourceRoot['cleanup']): string | null {
  if (!cleanup) return null
  return JSON.stringify(cleanup)
}

function parseStoredTempRoot(value: string): StoredTempRoot | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<StoredTempRoot>
    if (parsed.kind === 'directory' && typeof parsed.path === 'string') {
      return { kind: 'directory', path: parsed.path }
    }
    if (
      parsed.kind === 'git-worktree'
      && typeof parsed.path === 'string'
      && typeof parsed.ownerRepoRoot === 'string'
    ) {
      return {
        kind: 'git-worktree',
        path: parsed.path,
        ownerRepoRoot: parsed.ownerRepoRoot,
      }
    }
  } catch {
    return { kind: 'directory', path: value }
  }
  return null
}

export class RepoNotFoundError extends Error {
  constructor(id: string) {
    super(`Repo not found: ${id}`)
    this.name = 'RepoNotFoundError'
  }
}

export class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`Run not found: ${id}`)
    this.name = 'RunNotFoundError'
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`Artifact not found: ${id}`)
    this.name = 'ArtifactNotFoundError'
  }
}

export class BlueHandoffNotFoundError extends Error {
  constructor(repoId: string) {
    super(`Blue handoff not found for repo: ${repoId}`)
    this.name = 'BlueHandoffNotFoundError'
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export async function runGitCommand(input: Omit<RunCommandInput, 'command'>): Promise<CommandResult> {
  return runCommand({ ...input, command: 'git' })
}

async function runCommand(input: RunCommandInput): Promise<CommandResult> {
  const command = input.command ?? 'git'
  return new Promise((resolve, reject) => {
    const child = spawn(command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Command timed out after ${input.timeoutMs}ms: ${command} ${input.args.join(' ')}`))
    }, input.timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })

    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', code => {
      clearTimeout(timer)
      const exitCode = code ?? 1
      const result = { stdout, stderr, exitCode }
      if (exitCode !== 0 && input.rejectOnNonZero !== false) {
        reject(new Error(`Command failed (${exitCode}): ${command} ${input.args.join(' ')}\n${stderr}`))
        return
      }
      resolve(result)
    })
  })
}

export class MetarepoService implements MetarepoApi {
  private startupPromise: Promise<void> | null = null

  constructor(
    private config: ServiceConfig,
    private databaseManager: DatabaseManager,
  ) {}

  health(): Record<string, unknown> {
    return {
      ok: true,
      service: 'metarepo',
    }
  }

  async ready(): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    return {
      ok: true,
      service: 'metarepo',
    }
  }

  async createRepo(input: CreateRepoInput): Promise<RepoRecord> {
    await this.ensureStarted()
    this.validateCreateRepoInput(input)
    const sql = this.databaseManager.getAppSql()

    if (input.source.kind === 'local') {
      await assertAbsoluteDirectory(input.source.rootPath, 'rootPath')
    }

    const existing = input.source.kind === 'local'
      ? await sql<RepoRow[]>`
          SELECT * FROM metarepo.repos
          WHERE source_kind = 'local'
            AND root_path = ${input.source.rootPath}
          LIMIT 1
        `
      : await sql<RepoRow[]>`
          SELECT * FROM metarepo.repos
          WHERE source_kind = 'git'
            AND clone_url = ${input.source.cloneUrl}
          LIMIT 1
        `

    if (existing[0]) {
      const current = existing[0]
      const updated = await sql<RepoRow[]>`
        UPDATE metarepo.repos
        SET name = ${input.name ? normalizeRepoName(input.name) : current.name},
            default_branch = ${input.source.kind === 'git' ? input.source.defaultBranch ?? current.default_branch : current.default_branch},
            auth_ref = ${input.source.kind === 'git' ? input.source.authRef ?? current.auth_ref : current.auth_ref},
            registry_path = ${input.source.registryPath ?? current.registry_path},
            default_env_profile_id = ${input.defaultEnvProfileId ?? current.default_env_profile_id},
            updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *
      `
      return mapRepo(updated[0]!)
    }

    const id = randomUUID()
    const rows = await sql<RepoRow[]>`
      INSERT INTO metarepo.repos (
        id,
        name,
        source_kind,
        root_path,
        clone_url,
        default_branch,
        auth_ref,
        registry_path,
        default_env_profile_id
      ) VALUES (
        ${id},
        ${normalizeRepoName(input.name ?? defaultRepoName(input.source))},
        ${input.source.kind},
        ${input.source.kind === 'local' ? input.source.rootPath : null},
        ${input.source.kind === 'git' ? input.source.cloneUrl : null},
        ${input.source.kind === 'git' ? input.source.defaultBranch ?? null : null},
        ${input.source.kind === 'git' ? input.source.authRef ?? null : null},
        ${input.source.registryPath ?? null},
        ${input.defaultEnvProfileId ?? null}
      )
      RETURNING *
    `
    return mapRepo(rows[0]!)
  }

  async getRepo(id: string): Promise<RepoRecord> {
    await this.ensureStarted()
    return this.requireRepo(id)
  }

  async updateRepo(id: string, input: UpdateRepoInput): Promise<RepoRecord> {
    await this.ensureStarted()
    await this.requireRepo(id)
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<RepoRow[]>`
      UPDATE metarepo.repos
      SET name = COALESCE(${input.name ? normalizeRepoName(input.name) : null}, name),
          default_branch = COALESCE(${input.defaultBranch ?? null}, default_branch),
          auth_ref = COALESCE(${input.authRef ?? null}, auth_ref),
          registry_path = COALESCE(${input.registryPath ?? null}, registry_path),
          default_env_profile_id = COALESCE(${input.defaultEnvProfileId ?? null}, default_env_profile_id),
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `
    return mapRepo(rows[0]!)
  }

  async createBlueHandoff(input: CreateBlueHandoffRequest): Promise<BlueHandoffRecord> {
    await this.ensureStarted()
    const repo = await this.requireRepo(input.repoId)
    const prepared = await this.prepareSourceRoot(repo, input.source, undefined, false)
    const assignmentArtifact = await this.getArtifact(input.handoff.assignmentArtifactId)
    if (assignmentArtifact.repoId !== repo.id) {
      throw new ValidationError(`blue assignment ${assignmentArtifact.id} does not belong to repo ${repo.id}`)
    }
    if (assignmentArtifact.kind !== 'blue_assignment') {
      throw new ValidationError(`artifact ${assignmentArtifact.id} is not a blue assignment`)
    }
    const assignment = mapBlueAssignment(assignmentArtifact).assignment
    const handoff = buildBlueHandoffPayload(input.handoff, assignment)
    let run: RunRecord | null = null

    try {
      run = await this.createRun(repo.id, 'blue.record', prepared.sourceFingerprint, input.requestedBy)
      await this.recordEvent(repo.id, run.id, 'run.created', { workflow: 'blue.record' })
      run = await this.updateRun(run.id, {
        status: 'running',
        tempRootPath: serializeTempRoot(prepared.cleanup),
        startedAt: new Date(),
      })
      const artifact = await this.insertArtifact(
        repo.id,
        run.id,
        'blue_handoff',
        handoff.boundaryId,
        handoff,
        prepared.sourceFingerprint,
      )
      await this.recordEvent(repo.id, run.id, 'blue.handoff.recorded', {
        artifactId: artifact.id,
        assignmentArtifactId: assignmentArtifact.id,
        boundaryId: handoff.boundaryId,
        changedFiles: handoff.changedFiles,
        testFiles: handoff.testFiles,
      })
      run = await this.updateRun(run.id, {
        status: 'succeeded',
        finishedAt: new Date(),
      })
      await this.recordEvent(repo.id, run.id, 'run.succeeded', {
        workflow: 'blue.record',
        artifactCount: 1,
      })
      return {
        artifact,
        handoff,
      }
    } catch (error) {
      if (run) {
        await this.updateRun(run.id, {
          status: 'failed',
          errorMessage: stringifyError(error),
          finishedAt: new Date(),
        }).catch(() => null)
        await this.recordEvent(repo.id, run.id, 'run.failed', { error: stringifyError(error) }).catch(() => {})
      }
      throw error
    } finally {
      if (prepared.cleanup) {
        await this.cleanupPreparedSource(prepared.cleanup).catch(() => {})
      }
    }
  }

  async getLatestBlueHandoff(repoId: string): Promise<BlueHandoffRecord> {
    await this.ensureStarted()
    await this.requireRepo(repoId)
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<ArtifactRow[]>`
      SELECT * FROM metarepo.artifacts
      WHERE repo_id = ${repoId}
        AND kind = 'blue_handoff'
      ORDER BY created_at DESC
      LIMIT 1
    `
    if (!rows[0]) throw new BlueHandoffNotFoundError(repoId)
    return mapBlueHandoff(mapArtifact(rows[0]))
  }

  async listRepoArtifacts(id: string, kind?: string): Promise<ArtifactRecord[]> {
    await this.ensureStarted()
    await this.requireRepo(id)
    const sql = this.databaseManager.getAppSql()
    const rows = kind
      ? await sql<ArtifactRow[]>`
          SELECT * FROM metarepo.artifacts
          WHERE repo_id = ${id}
            AND kind = ${kind}
          ORDER BY created_at DESC
        `
      : await sql<ArtifactRow[]>`
          SELECT * FROM metarepo.artifacts
          WHERE repo_id = ${id}
          ORDER BY created_at DESC
        `
    return rows.map(mapArtifact)
  }

  async listRepoBugs(id: string): Promise<BugRecord[]> {
    await this.ensureStarted()
    await this.requireRepo(id)
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<BugRow[]>`
      SELECT * FROM metarepo.bugs
      WHERE repo_id = ${id}
      ORDER BY created_at DESC
    `
    return rows.map(mapBug)
  }

  async createBug(repoId: string, input: CreateBugInput): Promise<BugRecord> {
    await this.ensureStarted()
    if (!input.title?.trim()) {
      throw new ValidationError('title is required')
    }
    await this.requireRepo(repoId)
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<BugRow[]>`
      INSERT INTO metarepo.bugs (
        id,
        repo_id,
        run_id,
        title,
        description,
        status,
        payload_json,
        source_fingerprint_json
      ) VALUES (
        ${randomUUID()},
        ${repoId},
        ${input.runId ?? null},
        ${input.title.trim()},
        ${input.description ?? null},
        ${input.status ?? 'open'},
        ${sql.json((input.payload ?? {}) as any)},
        ${input.sourceFingerprint ? sql.json(input.sourceFingerprint as any) : null}
      )
      RETURNING *
    `
    return mapBug(rows[0]!)
  }

  async createEnvProfile(repoId: string, input: CreateEnvProfileInput): Promise<EnvProfileRecord> {
    await this.ensureStarted()
    if (!input.name?.trim()) {
      throw new ValidationError('name is required')
    }
    await this.requireRepo(repoId)
    const sql = this.databaseManager.getAppSql()
    const existing = await sql<EnvProfileRow[]>`
      SELECT * FROM metarepo.env_profiles
      WHERE repo_id = ${repoId}
        AND name = ${input.name.trim()}
      ORDER BY updated_at DESC
      LIMIT 1
    `
    const rows = existing[0]
      ? await sql<EnvProfileRow[]>`
          UPDATE metarepo.env_profiles
          SET variables_json = ${sql.json((input.variables ?? {}) as any)},
              secret_bindings_json = ${sql.json((input.secretBindings ?? {}) as any)},
              updated_at = NOW()
          WHERE id = ${existing[0].id}
          RETURNING *
        `
      : await sql<EnvProfileRow[]>`
          INSERT INTO metarepo.env_profiles (
            id,
            repo_id,
            name,
            variables_json,
            secret_bindings_json
          ) VALUES (
            ${randomUUID()},
            ${repoId},
            ${input.name.trim()},
            ${sql.json((input.variables ?? {}) as any)},
            ${sql.json((input.secretBindings ?? {}) as any)}
          )
          RETURNING *
        `
    return mapEnvProfile(rows[0]!)
  }

  async createSecretRef(repoId: string, input: CreateSecretRefInput): Promise<SecretRefRecord> {
    await this.ensureStarted()
    if (!input.kind?.trim() || !input.name?.trim() || !input.provider?.trim()) {
      throw new ValidationError('kind, name, and provider are required')
    }
    await this.requireRepo(repoId)
    if (input.provider !== 'encrypted_db') {
      throw new ValidationError('metarepo local mode only supports provider=encrypted_db')
    }
    if (!input.value?.length) {
      throw new ValidationError('value is required for provider=encrypted_db')
    }
    const sql = this.databaseManager.getAppSql()
    const encryptedPayload = encryptSecretValue(this.config.secretMasterKey, input.value)
    const existing = await sql<SecretRefRow[]>`
      SELECT * FROM metarepo.secret_refs
      WHERE repo_id = ${repoId}
        AND name = ${input.name.trim()}
      ORDER BY updated_at DESC
      LIMIT 1
    `
    const rows = existing[0]
      ? await sql<SecretRefRow[]>`
          UPDATE metarepo.secret_refs
          SET kind = ${input.kind.trim()},
              provider = ${input.provider.trim()},
              encrypted_payload = ${encryptedPayload},
              external_ref = ${input.externalRef ?? null},
              updated_at = NOW()
          WHERE id = ${existing[0].id}
          RETURNING *
        `
      : await sql<SecretRefRow[]>`
          INSERT INTO metarepo.secret_refs (
            id,
            repo_id,
            kind,
            name,
            provider,
            encrypted_payload,
            external_ref
          ) VALUES (
            ${randomUUID()},
            ${repoId},
            ${input.kind.trim()},
            ${input.name.trim()},
            ${input.provider.trim()},
            ${encryptedPayload},
            ${input.externalRef ?? null}
          )
          RETURNING *
        `
    return mapSecretRef(rows[0]!)
  }

  async getRun(id: string): Promise<RunRecord> {
    await this.ensureStarted()
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<RunRow[]>`
      SELECT * FROM metarepo.runs WHERE id = ${id} LIMIT 1
    `
    if (!rows[0]) throw new RunNotFoundError(id)
    return mapRun(rows[0])
  }

  async listRunArtifacts(id: string): Promise<ArtifactRecord[]> {
    await this.ensureStarted()
    await this.getRun(id)
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<ArtifactRow[]>`
      SELECT * FROM metarepo.artifacts
      WHERE run_id = ${id}
      ORDER BY created_at ASC
    `
    return rows.map(mapArtifact)
  }

  async getArtifact(id: string): Promise<ArtifactRecord> {
    await this.ensureStarted()
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<ArtifactRow[]>`
      SELECT * FROM metarepo.artifacts WHERE id = ${id} LIMIT 1
    `
    if (!rows[0]) throw new ArtifactNotFoundError(id)
    return mapArtifact(rows[0])
  }

  async graphBoundaries(input: GraphBoundariesRequest): Promise<WorkflowResponse<BoundaryInfo[]>> {
    return this.executeGraphWorkflow(input.repoId, 'graph.boundaries', input.requestedBy, input.source, async ctx => {
      const result = await ctx.testHealth.boundaries(input.filepath)
      await ctx.createArtifact('graph_boundaries', 'Graph boundaries', result)
      return result
    })
  }

  async graphDeps(input: GraphDepsRequest): Promise<WorkflowResponse<DependencyInfo[]>> {
    if (!input.entityId) throw new ValidationError('entityId is required')
    return this.executeGraphWorkflow(input.repoId, 'graph.deps', input.requestedBy, input.source, async ctx => {
      const result = await ctx.testHealth.depsFor(input.entityId)
      await ctx.createArtifact('graph_deps', `Dependency graph for ${input.entityId}`, result)
      return result
    })
  }

  async graphTree(input: GraphTreeRequest): Promise<WorkflowResponse<CallTreeNode[]>> {
    if (!input.entityId) throw new ValidationError('entityId is required')
    return this.executeGraphWorkflow(input.repoId, 'graph.tree', input.requestedBy, input.source, async ctx => {
      const result = await ctx.testHealth.callTree(input.entityId, input.maxDepth)
      await ctx.createArtifact('graph_tree', `Call tree for ${input.entityId}`, result)
      return result
    })
  }

  async graphEnv(input: GraphEnvRequest): Promise<WorkflowResponse<EnvVarInfo[]>> {
    if (!input.entityId) throw new ValidationError('entityId is required')
    return this.executeGraphWorkflow(input.repoId, 'graph.env', input.requestedBy, input.source, async ctx => {
      const result = await ctx.testHealth.envVarsFor(input.entityId)
      await ctx.createArtifact('graph_env', `Environment dependencies for ${input.entityId}`, result)
      return result
    })
  }

  async graphReadiness(input: GraphReadinessRequest): Promise<WorkflowResponse<ReadinessVerdict>> {
    if (!input.entityId) throw new ValidationError('entityId is required')
    return this.executeGraphWorkflow(input.repoId, 'graph.readiness', input.requestedBy, input.source, async ctx => {
      const result = await ctx.testHealth.readiness(input.entityId)
      await ctx.createArtifact('graph_readiness', `Readiness for ${input.entityId}`, result)
      return result
    })
  }

  async graphGaps(input: GraphGapsRequest): Promise<WorkflowResponse<GapReport>> {
    return this.executeGraphWorkflow(input.repoId, 'graph.gaps', input.requestedBy, input.source, async ctx => {
      const result = await ctx.testHealth.gaps(input.filepath)
      await ctx.createArtifact('graph_gaps', 'Gap report', result)
      return result
    })
  }

  async graphIndex(input: GraphIndexRequest): Promise<WorkflowResponse<ProjectIndex>> {
    return this.executeGraphWorkflow(input.repoId, 'graph.index', input.requestedBy, input.source, async ctx => {
      const result = await ctx.testHealth.buildIndex({
        repoRoot: ctx.sourceRoot,
        commit: ctx.sourceFingerprint.commitSha ?? '',
        filepath: input.filepath,
        maxDepth: input.maxDepth,
      })
      await ctx.createArtifact('boundary_index', 'Boundary index', result)
      return result
    })
  }

  async reviewRun(input: ReviewRunRequest): Promise<WorkflowResponse<ReviewWorkflowResult>> {
    if (!input.baseSha || !input.headSha) {
      throw new ValidationError('baseSha and headSha are required')
    }
    return this.executeGraphWorkflow(
      input.repoId,
      'review.run',
      input.requestedBy,
      { ref: input.headSha },
      async ctx => {
        const diffText = buildDiff({
          baseSha: input.baseSha,
          headSha: input.headSha,
          cwd: ctx.sourceRoot,
          gitBin: this.config.gitBin,
        })
        const review = await runReview({
          databaseUrl: ctx.graphDatabaseUrl,
          diffText,
          maxDepth: input.maxDepth ?? 2,
          rebuildGraph: false,
        })
        const markdown = formatReviewMarkdown(input.baseSha, input.headSha, input.maxDepth ?? 2, review as never)
        await ctx.createArtifact('review', `Review ${input.baseSha}...${input.headSha}`, {
          review,
          markdown,
        })
        return { review, markdown }
      },
      [input.baseSha, input.headSha],
    )
  }

  async testRecentPaths(input: TestRecentPathsRequest): Promise<string[]> {
    await this.ensureStarted()
    const repo = await this.requireRepo(input.repoId)
    const prepared = await this.prepareSourceRoot(repo, input.source, undefined, false)
    try {
      return recentTestPaths(prepared.sourceRoot, input.selector ?? 'recent')
    } finally {
      if (prepared.cleanup) {
        await this.cleanupPreparedSource(prepared.cleanup).catch(() => {})
      }
    }
  }

  async testSmells(input: TestSmellsRequest): Promise<TestSmellSummary> {
    await this.ensureStarted()
    const repo = await this.requireRepo(input.repoId)
    const prepared = await this.prepareSourceRoot(repo, input.source, undefined, false)
    try {
      const selector = input.selector ?? 'recent'
      const paths = selector === 'recent'
        ? await recentTestPaths(prepared.sourceRoot, selector)
        : (isLikelyTestPath(selector) ? [selector] : [])
      return summarizeSmells(prepared.sourceRoot, selector, paths)
    } finally {
      if (prepared.cleanup) {
        await this.cleanupPreparedSource(prepared.cleanup).catch(() => {})
      }
    }
  }

  async blueAssign(input: BlueAssignRequest): Promise<WorkflowResponse<BlueAssignmentRecord>> {
    return this.executeGraphWorkflow(input.repoId, 'blue.assign', input.requestedBy, input.source, async ctx => {
      const assignment = await this.selectBlueAssignment(ctx, input.selector, input.maxDepth)
      const artifact = await ctx.createArtifact('blue_assignment', assignment.boundary.boundaryId, assignment)
      await ctx.recordEvent('blue.assignment.created', {
        artifactId: artifact.id,
        selector: assignment.selector,
        boundaryId: assignment.boundary.boundaryId,
        defenseValueScore: assignment.boundary.defenseValueScore,
      })
      return {
        artifact,
        assignment,
      }
    })
  }

  async redTargets(input: RedTargetsRequest): Promise<WorkflowResponse<BoundaryCandidate[]>> {
    return this.executeGraphWorkflow(input.repoId, 'red.targets', input.requestedBy, input.source, async ctx => {
      const result = await ctx.testHealth.skepticTargets(input.selector, { maxDepth: input.maxDepth })
      await ctx.createArtifact('red_targets', 'Red targets', result)
      return result
    })
  }

  async redDossier(input: RedDossierRequest): Promise<WorkflowResponse<BoundaryDossier>> {
    if (!input.boundaryId) throw new ValidationError('boundaryId is required')
    return this.executeGraphWorkflow(input.repoId, 'red.dossier', input.requestedBy, input.source, async ctx => {
      const result = await ctx.testHealth.skepticDossier(input.boundaryId, { maxDepth: input.maxDepth })
      await ctx.createArtifact('red_dossier', `Red dossier ${input.boundaryId}`, result)
      return result
    })
  }

  async redMutate(input: RedMutateRequest): Promise<WorkflowResponse<MutationEvaluationResult>> {
    this.validateMutationProposal(input.proposal)
    return this.executeGraphWorkflow(
      input.repoId,
      'red.mutate',
      input.requestedBy,
      input.source,
      async ctx => {
        const proposalArtifact = await ctx.createArtifact('mutation_proposal', input.proposal.title ?? input.proposal.targetSymbol, input.proposal)
        const result = await this.evaluateMutation(ctx, input.proposal, proposalArtifact.id)
        await ctx.createArtifact('mutation_result', `Mutation result ${proposalArtifact.id}`, result)
        await ctx.createArtifact('referee_result', `Referee result ${proposalArtifact.id}`, {
          proposalArtifactId: proposalArtifact.id,
          result,
        })
        return result
      },
      undefined,
      true,
    )
  }

  private async selectBlueAssignment(
    ctx: GraphWorkflowContext,
    selector: string | undefined,
    maxDepth: number | undefined,
  ): Promise<BlueAssignmentPayload> {
    const normalizedSelector = normalizeSelector(selector)
    const recentPaths = normalizedSelector === 'recent'
      ? await this.collectRecentPaths(ctx.sourceRoot)
      : []
    const recentSet = new Set(recentPaths.map(normalizeRelPath))
    const allBoundaries = await ctx.testHealth.boundaries()

    const boundariesWithTests = await Promise.all(allBoundaries.map(async info => ({
      info,
      tests: await ctx.testHealth.testFiles(info.entity.id),
    })))

    const selected = boundariesWithTests.filter(item => {
      if (normalizedSelector === 'recent') {
        if (recentSet.size === 0) return true
        if (recentSet.has(normalizeRelPath(item.info.entity.filepath))) return true
        return item.tests.some(testFile => recentSet.has(normalizeRelPath(testFile.filepath)))
      }
      if (item.info.entity.id === normalizedSelector) return true
      if (matchesPath(item.info.entity.filepath, normalizedSelector)) return true
      return item.tests.some(testFile => matchesPath(testFile.filepath, normalizedSelector))
    })

    const seeds = selected.length > 0 || normalizedSelector !== 'recent'
      ? selected
      : boundariesWithTests

    if (seeds.length === 0) {
      throw new ValidationError(`no boundary candidates matched selector: ${normalizedSelector}`)
    }

    const scored = await Promise.all(seeds.map(async item => {
      const [deps, envVars, tree] = await Promise.all([
        ctx.testHealth.depsFor(item.info.entity.id),
        ctx.testHealth.envVarsFor(item.info.entity.id),
        ctx.testHealth.callTree(item.info.entity.id, maxDepth),
      ])
      const hitPaths = normalizedSelector === 'recent'
        ? [
            ...(recentSet.has(normalizeRelPath(item.info.entity.filepath)) ? [normalizeRelPath(item.info.entity.filepath)] : []),
            ...item.tests
              .map(testFile => normalizeRelPath(testFile.filepath))
              .filter(testPath => recentSet.has(testPath)),
          ]
        : []
      return buildBlueAssignedBoundary({
        info: item.info,
        recentPaths: [...new Set(hitPaths)],
        testFiles: item.tests.length,
        depCount: deps.length,
        envVarCount: envVars.length,
        injectedNodeCount: tree.filter(node => node.injected).length,
        callTreeNodeCount: tree.length,
      })
    }))

    scored.sort((a, b) => (
      b.defenseValueScore - a.defenseValueScore
      || Number(b.readiness === 'ready') - Number(a.readiness === 'ready')
      || b.callTreeNodeCount - a.callTreeNodeCount
      || b.depCount - a.depCount
      || b.fanIn - a.fanIn
      || a.boundaryId.localeCompare(b.boundaryId)
    ))

    return {
      selector: normalizedSelector,
      boundary: scored[0]!,
    }
  }

  async refereeRun(input: RefereeRunRequest): Promise<WorkflowResponse<MutationEvaluationResult>> {
    if (!input.proposalArtifactId) {
      throw new ValidationError('proposalArtifactId is required')
    }
    const proposalArtifact = await this.getArtifact(input.proposalArtifactId)
    if (proposalArtifact.kind !== 'mutation_proposal') {
      throw new ValidationError(`artifact ${proposalArtifact.id} is not a mutation proposal`)
    }

    const proposal = this.parseMutationProposal(proposalArtifact.payload)
    return this.executeGraphWorkflow(
      proposalArtifact.repoId,
      'referee.run',
      input.requestedBy,
      proposalArtifact.sourceFingerprint.ref ? { ref: proposalArtifact.sourceFingerprint.ref } : undefined,
      async ctx => {
        const result = await this.evaluateMutation(ctx, proposal, proposalArtifact.id)
        await ctx.createArtifact('referee_result', `Referee result ${proposalArtifact.id}`, {
          proposalArtifactId: proposalArtifact.id,
          result,
        })
        return result
      },
      undefined,
      true,
    )
  }

  private async ensureStarted(): Promise<void> {
    if (!this.startupPromise) {
      this.startupPromise = this.start()
    }
    await this.startupPromise
  }

  private async start(): Promise<void> {
    await mkdir(this.config.workdir, { recursive: true })
    await this.databaseManager.ready()
    await this.recoverAbandonedRuns()
  }

  private validateCreateRepoInput(input: CreateRepoInput): void {
    if (!input.source) {
      throw new ValidationError('source is required')
    }
    if (input.source.kind === 'local') {
      if (!input.source.rootPath) {
        throw new ValidationError('rootPath is required')
      }
      return
    }
    if (!input.source.cloneUrl) {
      throw new ValidationError('cloneUrl is required')
    }
  }

  private async requireRepo(id: string): Promise<RepoRecord> {
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<RepoRow[]>`
      SELECT * FROM metarepo.repos WHERE id = ${id} LIMIT 1
    `
    if (!rows[0]) throw new RepoNotFoundError(id)
    return mapRepo(rows[0])
  }

  private async createRun(repoId: string, workflow: string, sourceFingerprint: SourceFingerprint, requestedBy?: string): Promise<RunRecord> {
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<RunRow[]>`
      INSERT INTO metarepo.runs (
        id,
        repo_id,
        workflow,
        status,
        source_fingerprint_json,
        requested_by
      ) VALUES (
        ${randomUUID()},
        ${repoId},
        ${workflow},
        'pending',
        ${sql.json(sourceFingerprint as any)},
        ${requestedBy ?? null}
      )
      RETURNING *
    `
    return mapRun(rows[0]!)
  }

  private async updateRun(runId: string, input: {
    status?: RunRecord['status']
    errorMessage?: string | null
    graphDatabaseName?: string | null
    tempRootPath?: string | null
    startedAt?: Date | null
    finishedAt?: Date | null
  }): Promise<RunRecord> {
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<RunRow[]>`
      UPDATE metarepo.runs
      SET status = COALESCE(${input.status ?? null}, status),
          error_message = COALESCE(${input.errorMessage ?? null}, error_message),
          graph_database_name = COALESCE(${input.graphDatabaseName ?? null}, graph_database_name),
          temp_root_path = COALESCE(${input.tempRootPath ?? null}, temp_root_path),
          started_at = COALESCE(${input.startedAt ?? null}, started_at),
          finished_at = COALESCE(${input.finishedAt ?? null}, finished_at),
          updated_at = NOW()
      WHERE id = ${runId}
      RETURNING *
    `
    if (!rows[0]) throw new RunNotFoundError(runId)
    return mapRun(rows[0])
  }

  private async recordEvent(repoId: string, runId: string | null, eventType: string, payload: unknown): Promise<void> {
    const sql = this.databaseManager.getAppSql()
    await sql`
      INSERT INTO metarepo.event_ledger (
        id,
        repo_id,
        run_id,
        event_type,
        payload_json
      ) VALUES (
        ${randomUUID()},
        ${repoId},
        ${runId},
        ${eventType},
        ${sql.json((payload ?? {}) as any)}
      )
    `
  }

  private async insertArtifact(repoId: string, runId: string, kind: string, title: string, payload: unknown, sourceFingerprint: SourceFingerprint): Promise<ArtifactRecord> {
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<ArtifactRow[]>`
      INSERT INTO metarepo.artifacts (
        id,
        repo_id,
        run_id,
        kind,
        title,
        payload_json,
        source_fingerprint_json
      ) VALUES (
        ${randomUUID()},
        ${repoId},
        ${runId},
        ${kind},
        ${title},
        ${sql.json((payload ?? {}) as any)},
        ${sql.json(sourceFingerprint as any)}
      )
      RETURNING *
    `
    return mapArtifact(rows[0]!)
  }

  private async executeGraphWorkflow<T>(
    repoId: string,
    workflow: string,
    requestedBy: string | undefined,
    source: RunSourceRequest | undefined,
    runWorkflow: (ctx: GraphWorkflowContext) => Promise<T>,
    extraGitRefs?: string[],
    isolatedSource = false,
  ): Promise<WorkflowResponse<T>> {
    await this.ensureStarted()
    const repo = await this.requireRepo(repoId)
    const prepared = await this.prepareSourceRoot(repo, source, extraGitRefs, isolatedSource)
    const createdArtifacts: ArtifactRecord[] = []
    let graphDatabaseName: string | null = null
    let run: RunRecord | null = null
    let activeRun: RunRecord | null = null
    let runId = ''

    try {
      run = await this.createRun(repoId, workflow, prepared.sourceFingerprint, requestedBy)
      activeRun = run
      runId = run.id
      await this.recordEvent(repo.id, run.id, 'run.created', { workflow })

      const graphDb = await this.databaseManager.createGraphDatabase()
      graphDatabaseName = graphDb.databaseName
      activeRun = await this.updateRun(run.id, {
        status: 'running',
        graphDatabaseName: graphDb.databaseName,
        tempRootPath: serializeTempRoot(prepared.cleanup),
        startedAt: new Date(),
      })

      await this.recordEvent(repo.id, run.id, 'graph.database.created', { databaseName: graphDb.databaseName })
      await this.databaseManager.initializeGraphDatabase(graphDb.databaseUrl)
      const graphBuild = await this.buildGraph(graphDb.databaseUrl, prepared.sourceRoot)
      await this.recordEvent(repo.id, run.id, 'graph.built', graphBuild)

      const graphSql = postgres(graphDb.databaseUrl, { max: 2, idle_timeout: 5, connect_timeout: 10 })
      try {
        const testHealth = new TestHealthModule(
          graphSql as unknown as Sql,
          prepared.sourceRoot,
          prepared.registryPath,
        )
        const context: GraphWorkflowContext = {
          repo,
          run: activeRun,
          sourceRoot: prepared.sourceRoot,
          sourceFingerprint: prepared.sourceFingerprint,
          graphBuild,
          testHealth,
          graphDatabaseUrl: graphDb.databaseUrl,
          createArtifact: async (kind, title, payload) => {
            const artifact = await this.insertArtifact(repo.id, runId, kind, title, payload, prepared.sourceFingerprint)
            createdArtifacts.push(artifact)
            return artifact
          },
          recordEvent: async (eventType, payload) => {
            await this.recordEvent(repo.id, runId, eventType, payload)
          },
        }

        const result = await runWorkflow(context)
        activeRun = await this.updateRun(runId, {
          status: 'succeeded',
          finishedAt: new Date(),
        })
        await this.recordEvent(repo.id, runId, 'run.succeeded', {
          workflow,
          artifactCount: createdArtifacts.length,
        })
        return {
          run: activeRun!,
          artifacts: createdArtifacts,
          result,
        }
      } finally {
        await graphSql.end()
      }
    } catch (error) {
      if (run) {
        activeRun = await this.updateRun(run.id, {
          status: 'failed',
          errorMessage: stringifyError(error),
          finishedAt: new Date(),
        }).catch(() => activeRun)
        await this.recordEvent(repo.id, run.id, 'run.failed', { error: stringifyError(error) }).catch(() => {})
      }
      throw error
    } finally {
      if (graphDatabaseName) {
        await this.databaseManager.dropGraphDatabase(graphDatabaseName).catch(() => {})
      }
      if (prepared.cleanup) {
        await this.cleanupPreparedSource(prepared.cleanup).catch(() => {})
      }
    }
  }

  private async prepareSourceRoot(
    repo: RepoRecord,
    source: RunSourceRequest | undefined,
    extraGitRefs: string[] | undefined,
    isolatedSource: boolean,
  ): Promise<PreparedSourceRoot> {
    if (repo.sourceKind === 'local') {
      if (!repo.rootPath) {
        throw new ValidationError(`repo ${repo.id} is missing rootPath`)
      }
      await assertAbsoluteDirectory(repo.rootPath, 'repo rootPath')

      if (isolatedSource) {
        const isolated = await this.createIsolatedLocalRoot(repo.rootPath)
        return {
          sourceRoot: isolated.sourceRoot,
          registryPath: resolveRegistryPath(isolated.sourceRoot, repo.registryPath),
          cleanup: isolated.cleanup,
          sourceFingerprint: await this.buildSourceFingerprint(repo, isolated.sourceRoot, source),
        }
      }

      return {
        sourceRoot: repo.rootPath,
        registryPath: resolveRegistryPath(repo.rootPath, repo.registryPath),
        sourceFingerprint: await this.buildSourceFingerprint(repo, repo.rootPath, source),
      }
    }

    if (!repo.cloneUrl) {
      throw new ValidationError(`repo ${repo.id} is missing cloneUrl`)
    }
    const gitCheckout = await this.createGitCheckout(repo, source, extraGitRefs)
    return {
      sourceRoot: gitCheckout.sourceRoot,
      registryPath: resolveRegistryPath(gitCheckout.sourceRoot, repo.registryPath),
      cleanup: gitCheckout.cleanup,
      sourceFingerprint: await this.buildSourceFingerprint(repo, gitCheckout.sourceRoot, source),
    }
  }

  private async createGitCheckout(
    repo: RepoRecord,
    source: RunSourceRequest | undefined,
    extraGitRefs: string[] | undefined,
  ): Promise<{ sourceRoot: string; cleanup: PreparedSourceRoot['cleanup'] }> {
    const checkoutParent = await mkdtemp(path.join(this.config.workdir, 'metarepo-git-'))
    const repoDir = path.join(checkoutParent, 'repo')
    try {
      await runCommand({
        command: this.config.gitBin,
        cwd: checkoutParent,
        args: ['clone', '--no-checkout', '--depth', '200', repo.cloneUrl!, repoDir],
        timeoutMs: this.config.requestTimeoutMs,
      })

      for (const ref of [source?.ref, ...(extraGitRefs ?? [])]) {
        if (!ref) continue
        await this.ensureCheckoutTarget(repoDir, ref)
      }

      const checkoutTarget = source?.ref ?? extraGitRefs?.at(-1) ?? repo.defaultBranch ?? 'HEAD'
      await runCommand({
        command: this.config.gitBin,
        cwd: checkoutParent,
        args: ['-C', repoDir, 'checkout', '--force', checkoutTarget],
        timeoutMs: this.config.requestTimeoutMs,
      })

      return {
        sourceRoot: repoDir,
        cleanup: {
          kind: 'directory',
          path: checkoutParent,
        },
      }
    } catch (error) {
      await rm(checkoutParent, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  private async createIsolatedLocalRoot(sourceRoot: string): Promise<{ sourceRoot: string; cleanup: PreparedSourceRoot['cleanup'] }> {
    const cleanGitRepo = await this.canUseGitWorktree(sourceRoot)
    if (cleanGitRepo) {
      const parent = await mkdtemp(path.join(this.config.workdir, 'metarepo-worktree-'))
      const worktreeRoot = path.join(parent, 'repo')
      try {
        const headSha = await this.resolveHeadSha(sourceRoot)
        await runCommand({
          command: this.config.gitBin,
          cwd: sourceRoot,
          args: ['worktree', 'add', '--detach', worktreeRoot, headSha || 'HEAD'],
          timeoutMs: this.config.requestTimeoutMs,
        })
        return {
          sourceRoot: worktreeRoot,
          cleanup: {
            kind: 'git-worktree',
            path: worktreeRoot,
            ownerRepoRoot: sourceRoot,
          },
        }
      } catch (error) {
        await rm(parent, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }

    const parent = await mkdtemp(path.join(this.config.workdir, 'metarepo-copy-'))
    const copyRoot = path.join(parent, 'repo')
    try {
      await cp(sourceRoot, copyRoot, {
        recursive: true,
        force: true,
        filter: item => path.basename(item) !== '.git',
      })
      return {
        sourceRoot: copyRoot,
        cleanup: {
          kind: 'directory',
          path: parent,
        },
      }
    } catch (error) {
      await rm(parent, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  private async cleanupPreparedSource(cleanup: NonNullable<PreparedSourceRoot['cleanup']>): Promise<void> {
    if (cleanup.kind === 'git-worktree') {
      await runCommand({
        command: this.config.gitBin,
        cwd: cleanup.ownerRepoRoot ?? cleanup.path,
        args: ['worktree', 'remove', '--force', cleanup.path],
        timeoutMs: this.config.requestTimeoutMs,
        rejectOnNonZero: false,
      })
      const parent = path.dirname(cleanup.path)
      await rm(parent, { recursive: true, force: true })
      return
    }
    await rm(cleanup.path, { recursive: true, force: true })
  }

  private async buildSourceFingerprint(
    repo: RepoRecord,
    sourceRoot: string,
    source: RunSourceRequest | undefined,
  ): Promise<SourceFingerprint> {
    const commitSha = await this.resolveHeadSha(sourceRoot)
    const branch = await this.resolveBranch(sourceRoot)
    const dirty = await this.isDirtyGitRepo(sourceRoot)
    return {
      repoId: repo.id,
      sourceKind: repo.sourceKind,
      rootPath: repo.rootPath ?? undefined,
      cloneUrl: repo.cloneUrl ?? undefined,
      ref: source?.ref,
      commitSha: commitSha || undefined,
      branch: branch || undefined,
      dirty,
      createdAt: new Date().toISOString(),
    }
  }

  private async buildGraph(databaseUrl: string, sourceRoot: string): Promise<GraphBuildStats> {
    const sql = postgres(databaseUrl, { max: 4, idle_timeout: 30, connect_timeout: 10 })
    try {
      return await buildFullGraph(sql as unknown as Sql, {
        sourceRoot,
        exclude: DEFAULT_GRAPH_EXCLUDE,
      })
    } finally {
      await sql.end()
    }
  }

  private async evaluateMutation(
    ctx: GraphWorkflowContext,
    proposal: MutationProposalInput,
    proposalArtifactId: string,
  ): Promise<MutationEvaluationResult> {
    const baseline = await runCommand({
      cwd: ctx.sourceRoot,
      command: proposal.testTarget.command[0],
      args: proposal.testTarget.command.slice(1),
      env: await this.resolveExecutionEnv(ctx.repo, ctx.testHealth),
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })

    if (baseline.exitCode !== 0) {
      return {
        id: proposalArtifactId,
        status: 'invalid',
        realMutation: false,
        preservesIntendedBehavior: null,
        patchApplied: false,
        workspacePath: ctx.sourceRoot,
        testTarget: proposal.testTarget,
        testsRun: [proposal.testTarget.command.join(' ')],
        summary: 'Baseline target does not pass before mutation',
        reason: 'The named test target failed before the mutation was applied.',
        stdoutSummary: summarizeOutput(baseline.stdout),
        stderrSummary: summarizeOutput(baseline.stderr),
      }
    }

    const patchResult = await this.applyMutationPatch(ctx.sourceRoot, proposal.patch)
    if (!patchResult.patchApplied || !patchResult.realMutation) {
      return {
        id: proposalArtifactId,
        status: 'invalid',
        realMutation: patchResult.realMutation,
        preservesIntendedBehavior: null,
        patchApplied: patchResult.patchApplied,
        workspacePath: ctx.sourceRoot,
        testTarget: proposal.testTarget,
        testsRun: [proposal.testTarget.command.join(' ')],
        summary: 'Mutation proposal did not apply as a real code change',
        reason: patchResult.reason,
      }
    }

    const mutated = await runCommand({
      cwd: ctx.sourceRoot,
      command: proposal.testTarget.command[0],
      args: proposal.testTarget.command.slice(1),
      env: await this.resolveExecutionEnv(ctx.repo, ctx.testHealth),
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })

    if (mutated.exitCode === 0) {
      return {
        id: proposalArtifactId,
        status: 'survived',
        realMutation: true,
        preservesIntendedBehavior: null,
        patchApplied: true,
        workspacePath: ctx.sourceRoot,
        testTarget: proposal.testTarget,
        testsRun: [proposal.testTarget.command.join(' ')],
        summary: 'Mutation survived the named test target',
        reason: 'The named test target still passed after applying the mutation.',
        stdoutSummary: summarizeOutput(mutated.stdout),
        stderrSummary: summarizeOutput(mutated.stderr),
      }
    }

    const output = `${mutated.stdout}\n${mutated.stderr}`
    if (TEST_FAILURE_INVALID_RE.test(output)) {
      return {
        id: proposalArtifactId,
        status: 'invalid',
        realMutation: true,
        preservesIntendedBehavior: null,
        patchApplied: true,
        workspacePath: ctx.sourceRoot,
        testTarget: proposal.testTarget,
        testsRun: [proposal.testTarget.command.join(' ')],
        summary: 'Mutation caused setup/build failure instead of an observed behavioral failure',
        reason: 'The named target failed before the tests could cleanly evaluate the mutation.',
        stdoutSummary: summarizeOutput(mutated.stdout),
        stderrSummary: summarizeOutput(mutated.stderr),
      }
    }

    return {
      id: proposalArtifactId,
      status: 'killed',
      realMutation: true,
      preservesIntendedBehavior: null,
      patchApplied: true,
      workspacePath: ctx.sourceRoot,
      testTarget: proposal.testTarget,
      testsRun: [proposal.testTarget.command.join(' ')],
      summary: 'Mutation was killed by the named test target',
      reason: 'The named test target failed after the mutation was applied.',
      stdoutSummary: summarizeOutput(mutated.stdout),
      stderrSummary: summarizeOutput(mutated.stderr),
    }
  }

  private async applyMutationPatch(
    sourceRoot: string,
    operations: MutationPatchOperation[],
  ): Promise<{ patchApplied: boolean; realMutation: boolean; reason: string }> {
    for (const operation of operations) {
      if (operation.op !== 'replace') {
        return {
          patchApplied: false,
          realMutation: false,
          reason: `Unsupported patch operation: ${String((operation as { op?: string }).op ?? 'unknown')}`,
        }
      }

      const targetPath = path.resolve(sourceRoot, operation.file)
      const rootPath = path.resolve(sourceRoot)
      if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
        return {
          patchApplied: false,
          realMutation: false,
          reason: `Patch target escapes repo root: ${operation.file}`,
        }
      }

      const before = await readFile(targetPath, 'utf-8').catch(() => null)
      if (before === null) {
        return {
          patchApplied: false,
          realMutation: false,
          reason: `Patch target does not exist: ${operation.file}`,
        }
      }

      if (!operation.find) {
        return {
          patchApplied: false,
          realMutation: false,
          reason: `Patch operation for ${operation.file} is missing a non-empty find string`,
        }
      }

      const matches = before.split(operation.find).length - 1
      const expectedMatches = operation.expectedMatches ?? 1
      if (matches !== expectedMatches) {
        return {
          patchApplied: false,
          realMutation: false,
          reason: `Expected ${expectedMatches} exact matches for ${operation.file}, found ${matches}`,
        }
      }

      const after = before.replace(operation.find, operation.replace)
      if (after === before) {
        return {
          patchApplied: false,
          realMutation: false,
          reason: `Patch for ${operation.file} did not change file contents`,
        }
      }

      const realMutation = normalizeContentSignal(after) !== normalizeContentSignal(before)
      if (!realMutation) {
        return {
          patchApplied: false,
          realMutation: false,
          reason: `Patch for ${operation.file} only changed formatting or whitespace`,
        }
      }

      await writeFile(targetPath, after, 'utf-8')
    }

    return {
      patchApplied: true,
      realMutation: true,
      reason: 'Patch applied',
    }
  }

  private async resolveExecutionEnv(repo: RepoRecord, testHealth: TestHealthModule): Promise<NodeJS.ProcessEnv> {
    const env = pickParentEnv()
    const envProfile = await this.resolveEnvProfile(repo)
    Object.assign(env, envProfile.variables)
    Object.assign(env, await this.resolveSecretBindings(repo.id, envProfile.secretBindings))
    const registry = await testHealth.getRegistry()
    Object.assign(env, registry.skeptic.runner.env)
    return env
  }

  private async resolveEnvProfile(repo: RepoRecord): Promise<{ variables: Record<string, string>; secretBindings: Record<string, string> }> {
    if (!repo.defaultEnvProfileId) {
      return { variables: {}, secretBindings: {} }
    }
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<EnvProfileRow[]>`
      SELECT * FROM metarepo.env_profiles WHERE id = ${repo.defaultEnvProfileId} LIMIT 1
    `
    if (!rows[0]) {
      return { variables: {}, secretBindings: {} }
    }
    return {
      variables: asStringRecord(rows[0].variables_json),
      secretBindings: asStringRecord(rows[0].secret_bindings_json),
    }
  }

  private async resolveSecretBindings(repoId: string, bindings: Record<string, string>): Promise<Record<string, string>> {
    const entries = Object.entries(bindings)
    if (entries.length === 0) return {}
    const sql = this.databaseManager.getAppSql()
    const resolved: Record<string, string> = {}
    for (const [envName, secretRefId] of entries) {
      const rows = await sql<SecretRefRow[]>`
        SELECT * FROM metarepo.secret_refs
        WHERE id = ${secretRefId}
          AND (repo_id = ${repoId} OR repo_id IS NULL)
        LIMIT 1
      `
      const secret = rows[0]
      if (!secret) {
        throw new ValidationError(`secret binding ${envName} refers to missing secret ref ${secretRefId}`)
      }
      if (secret.provider !== 'encrypted_db') {
        throw new ValidationError(`secret ref ${secret.name} uses unsupported provider ${secret.provider}`)
      }
      if (!secret.encrypted_payload) {
        throw new ValidationError(`secret ref ${secret.name} is missing encrypted payload`)
      }
      try {
        resolved[envName] = decryptSecretValue(this.config.secretMasterKey, secret.encrypted_payload)
      } catch (error) {
        throw new ValidationError(
          `failed to decrypt secret ref ${secret.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return resolved
  }

  private async collectRecentPaths(sourceRoot: string): Promise<string[]> {
    const paths = new Set<string>()

    const status = await runGitCommand({
      cwd: sourceRoot,
      args: ['status', '--porcelain'],
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })
    for (const line of status.stdout.split('\n')) {
      if (!line) continue
      const filepath = line.length > 3 ? line.slice(3).trim() : ''
      if (filepath) paths.add(normalizeRelPath(filepath))
    }

    const head = await runGitCommand({
      cwd: sourceRoot,
      args: ['rev-parse', '--verify', 'HEAD~1'],
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })
    if (head.exitCode !== 0 || !head.stdout.trim()) {
      return [...paths]
    }

    const diff = await runGitCommand({
      cwd: sourceRoot,
      args: ['diff', '--name-only', '--diff-filter=AM', 'HEAD~1', 'HEAD'],
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })
    for (const filepath of diff.stdout.split('\n')) {
      if (!filepath.trim()) continue
      paths.add(normalizeRelPath(filepath.trim()))
    }

    return [...paths]
  }

  private validateMutationProposal(proposal: MutationProposalInput): void {
    if (!proposal.family?.trim()) throw new ValidationError('proposal.family is required')
    if (!proposal.targetFile?.trim()) throw new ValidationError('proposal.targetFile is required')
    if (!proposal.targetSymbol?.trim()) throw new ValidationError('proposal.targetSymbol is required')
    if (!proposal.whyThisBoundary?.trim()) throw new ValidationError('proposal.whyThisBoundary is required')
    if (!proposal.survivalRationale?.trim()) throw new ValidationError('proposal.survivalRationale is required')
    if (!proposal.patch?.length) throw new ValidationError('proposal.patch must contain at least one operation')
    if (!proposal.testTarget || !Array.isArray(proposal.testTarget.command) || proposal.testTarget.command.length === 0) {
      throw new ValidationError('proposal.testTarget.command is required')
    }
    for (const commandPart of proposal.testTarget.command) {
      if (typeof commandPart !== 'string' || !commandPart.trim()) {
        throw new ValidationError('proposal.testTarget.command must contain only non-empty strings')
      }
    }
    for (const operation of proposal.patch) {
      if (operation.op !== 'replace') {
        throw new ValidationError(`unsupported patch op: ${String((operation as { op?: string }).op ?? 'unknown')}`)
      }
      if (!operation.file?.trim() || !operation.find || typeof operation.replace !== 'string') {
        throw new ValidationError('replace patch operations require file, find, and replace')
      }
    }
  }

  private parseMutationProposal(payload: unknown): MutationProposalInput {
    if (!payload || typeof payload !== 'object') {
      throw new ValidationError('mutation proposal payload is invalid')
    }
    const proposal = payload as MutationProposalInput
    this.validateMutationProposal(proposal)
    return proposal
  }

  private async recoverAbandonedRuns(): Promise<void> {
    const sql = this.databaseManager.getAppSql()
    const rows = await sql<RunRow[]>`
      SELECT * FROM metarepo.runs
      WHERE status IN ('pending', 'running')
      ORDER BY created_at ASC
    `
    for (const row of rows) {
      const run = mapRun(row)
      if (run.graphDatabaseName) {
        await this.databaseManager.dropGraphDatabase(run.graphDatabaseName).catch(() => {})
      }
      if (run.tempRootPath) {
        const stored = parseStoredTempRoot(run.tempRootPath)
        if (stored?.kind === 'git-worktree') {
          await this.cleanupPreparedSource({
            kind: 'git-worktree',
            path: stored.path,
            ownerRepoRoot: stored.ownerRepoRoot,
          }).catch(() => {})
        } else if (stored?.kind === 'directory') {
          await rm(stored.path, { recursive: true, force: true }).catch(() => {})
        }
      }
      await this.updateRun(run.id, {
        status: 'failed',
        errorMessage: 'metarepo restarted while the run was active',
        finishedAt: new Date(),
      }).catch(() => {})
      await this.recordEvent(run.repoId, run.id, 'run.recovered_as_failed', {
        reason: 'metarepo restarted while the run was active',
      }).catch(() => {})
    }
  }

  private async ensureCheckoutTarget(repoDir: string, target: string): Promise<void> {
    const verify = await runCommand({
      command: this.config.gitBin,
      cwd: repoDir,
      args: ['-C', repoDir, 'rev-parse', '--verify', target],
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })
    if (verify.exitCode === 0) return
    await runCommand({
      command: this.config.gitBin,
      cwd: repoDir,
      args: ['-C', repoDir, 'fetch', '--depth', '200', 'origin', target],
      timeoutMs: this.config.requestTimeoutMs,
    })
  }

  private async resolveHeadSha(rootPath: string): Promise<string> {
    const result = await runCommand({
      command: this.config.gitBin,
      cwd: rootPath,
      args: ['-C', rootPath, 'rev-parse', 'HEAD'],
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })
    return result.exitCode === 0 ? result.stdout.trim() : ''
  }

  private async resolveBranch(rootPath: string): Promise<string> {
    const result = await runCommand({
      command: this.config.gitBin,
      cwd: rootPath,
      args: ['-C', rootPath, 'symbolic-ref', '--short', 'HEAD'],
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })
    return result.exitCode === 0 ? result.stdout.trim() : ''
  }

  private async isDirtyGitRepo(rootPath: string): Promise<boolean> {
    const result = await runCommand({
      command: this.config.gitBin,
      cwd: rootPath,
      args: ['-C', rootPath, 'status', '--porcelain'],
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })
    if (result.exitCode !== 0) return false
    return result.stdout.trim().length > 0
  }

  private async canUseGitWorktree(rootPath: string): Promise<boolean> {
    const inside = await runCommand({
      command: this.config.gitBin,
      cwd: rootPath,
      args: ['-C', rootPath, 'rev-parse', '--is-inside-work-tree'],
      timeoutMs: this.config.requestTimeoutMs,
      rejectOnNonZero: false,
    })
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      return false
    }
    return !(await this.isDirtyGitRepo(rootPath))
  }

}
