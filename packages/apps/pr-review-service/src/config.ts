import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServiceConfig } from './types.js'

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function findRepoRoot(startDir: string): string {
  let current = startDir
  while (true) {
    const marker = path.join(current, 'bun.lock')
    if (existsSync(marker)) return current
    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`Could not find repository root from ${startDir}`)
    }
    current = parent
  }
}

function resolveDefaultScriptPath(): string {
  const repoRoot = findRepoRoot(process.cwd())
  const scriptPath = path.join(repoRoot, 'scripts', 'pr-review-ci.ts')
  if (!existsSync(scriptPath)) {
    throw new Error(`PR review script not found: ${scriptPath}`)
  }
  return scriptPath
}

export function loadConfigFromEnv(): ServiceConfig {
  const entityGraphDatabaseUrl = process.env.ENTITY_GRAPH_DATABASE_URL ?? process.env.DATABASE_URL
  if (!entityGraphDatabaseUrl) {
    throw new Error('Missing ENTITY_GRAPH_DATABASE_URL or DATABASE_URL')
  }

  const staticGithubToken = process.env.GITHUB_TOKEN
  const githubAppId = process.env.GITHUB_APP_ID
  const githubAppPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY

  if (!staticGithubToken && (!githubAppId || !githubAppPrivateKey)) {
    throw new Error('Missing GitHub auth config. Set GITHUB_TOKEN or (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY).')
  }

  return {
    port: parsePositiveInt(process.env.PORT, 8080),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    apiBase: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    staticGithubToken,
    githubAppId,
    githubAppPrivateKey,
    entityGraphDatabaseUrl,
    workspaceParentDir: process.env.WORKSPACE_PARENT_DIR ?? os.tmpdir(),
    prReviewScriptPath: process.env.PR_REVIEW_SCRIPT_PATH ?? resolveDefaultScriptPath(),
    bunBin: process.env.BUN_BIN ?? 'bun',
    gitBin: process.env.GIT_BIN ?? 'git',
    requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS, 15 * 60 * 1000),
  }
}
