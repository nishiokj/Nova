import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import postgres from 'postgres'
import { resolveGithubToken } from './github.js'
import type { JobRunResult, PRReviewJob, ServiceConfig } from './types.js'

type ProcessResult = {
  stdout: string
  stderr: string
}

async function runCommand(input: {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Command timed out after ${input.timeoutMs}ms: ${input.command} ${input.args.join(' ')}`))
    }, input.timeoutMs)

    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${input.command} ${input.args.join(' ')}\n${stderr}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function prepareWorkspace(job: PRReviewJob, token: string, config: ServiceConfig): Promise<string> {
  const tempParent = config.workspaceParentDir || os.tmpdir()
  const root = await mkdtemp(path.join(tempParent, 'nova-pr-review-'))
  const repoDir = path.join(root, 'repo')

  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_HTTP_EXTRAHEADER: `AUTHORIZATION: bearer ${token}`,
  }

  await runCommand({
    command: config.gitBin,
    args: ['clone', '--no-checkout', '--depth', '200', job.cloneUrl, repoDir],
    timeoutMs: config.requestTimeoutMs,
    env: gitEnv,
  })

  await runCommand({
    command: config.gitBin,
    args: ['-C', repoDir, 'fetch', '--depth', '200', 'origin', job.baseSha],
    timeoutMs: config.requestTimeoutMs,
    env: gitEnv,
  })

  try {
    await runCommand({
      command: config.gitBin,
      args: ['-C', repoDir, 'fetch', '--depth', '200', 'origin', job.headSha],
      timeoutMs: config.requestTimeoutMs,
      env: gitEnv,
    })
  } catch {
    await runCommand({
      command: config.gitBin,
      args: ['-C', repoDir, 'fetch', '--depth', '200', 'origin', `pull/${job.prNumber}/head`],
      timeoutMs: config.requestTimeoutMs,
      env: gitEnv,
    })
  }

  await runCommand({
    command: config.gitBin,
    args: ['-C', repoDir, 'checkout', '--force', job.headSha],
    timeoutMs: config.requestTimeoutMs,
    env: gitEnv,
  })

  return repoDir
}

async function resetEntityGraphTables(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 })
  try {
    await sql.unsafe(`
      TRUNCATE
        entity_graph.imports,
        entity_graph.calls,
        entity_graph.uses,
        entity_graph.owns,
        entity_graph.extends,
        entity_graph.implements,
        entity_graph.entities,
        entity_graph.file_leases
    `)
  } finally {
    await sql.end()
  }
}

async function runDeterministicReview(
  workspaceDir: string,
  job: PRReviewJob,
  token: string,
  config: ServiceConfig,
): Promise<JobRunResult> {
  await resetEntityGraphTables(config.entityGraphDatabaseUrl)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BASE_SHA: job.baseSha,
    HEAD_SHA: job.headSha,
    ENTITY_GRAPH_DATABASE_URL: config.entityGraphDatabaseUrl,
    PR_NUMBER: String(job.prNumber),
    GITHUB_TOKEN: token,
    GITHUB_REPOSITORY: job.repoFullName,
    GITHUB_API_URL: config.apiBase,
  }

  await runCommand({
    command: config.bunBin,
    args: ['run', config.prReviewScriptPath],
    cwd: workspaceDir,
    env,
    timeoutMs: config.requestTimeoutMs,
  })

  const markdownPath = path.join(workspaceDir, '.artifacts', 'pr-review', 'pr-review.md')
  const jsonPath = path.join(workspaceDir, '.artifacts', 'pr-review', 'pr-review.json')
  let summary: string | undefined
  try {
    const jsonRaw = await readFile(jsonPath, 'utf-8')
    const parsed = JSON.parse(jsonRaw) as { summary?: string }
    summary = typeof parsed.summary === 'string' ? parsed.summary : undefined
  } catch {
    // best-effort metadata only
  }

  return { markdownPath, jsonPath, summary }
}

export async function runPrReviewJob(job: PRReviewJob, config: ServiceConfig): Promise<JobRunResult> {
  const token = await resolveGithubToken({
    apiBase: config.apiBase,
    staticToken: config.staticGithubToken,
    appId: config.githubAppId,
    appPrivateKey: config.githubAppPrivateKey,
    installationId: job.installationId,
  })

  const workspaceRoot = await mkdtemp(path.join(config.workspaceParentDir || os.tmpdir(), 'nova-pr-review-job-'))
  try {
    const workspaceRepoDir = await prepareWorkspace(job, token, {
      ...config,
      workspaceParentDir: workspaceRoot,
    })
    return await runDeterministicReview(workspaceRepoDir, job, token, config)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}
