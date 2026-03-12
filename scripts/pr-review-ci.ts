#!/usr/bin/env bun

import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  COMMENT_MARKER,
  formatReviewMarkdown,
  parsePositiveInt,
} from '../packages/plugins/entity-graph/src/pr-review/service.ts'
import { ensureLocalRepo, reviewRun } from '../packages/apps/metarepo/src/client.ts'

export {
  COMMENT_MARKER,
  formatReviewMarkdown,
  parsePositiveInt,
} from '../packages/plugins/entity-graph/src/pr-review/service.ts'

const OUTPUT_DIR = '.artifacts/pr-review'

type Comment = {
  id: number
  body: string
  user?: { login?: string; type?: string }
}

export async function main(): Promise<void> {
  const {
    BASE_SHA,
    HEAD_SHA,
    PR_NUMBER,
    GITHUB_TOKEN,
    GITHUB_REPOSITORY,
    GITHUB_API_URL,
    PR_REVIEW_MAX_DEPTH,
    METAREPO_BASE_URL,
  } = process.env

  if (!METAREPO_BASE_URL) {
    throw new Error('Missing METAREPO_BASE_URL env var')
  }

  const baseSha = BASE_SHA || resolveDefaultBaseSha()
  const headSha = HEAD_SHA || resolveDefaultHeadSha()
  const maxDepth = parsePositiveInt(PR_REVIEW_MAX_DEPTH, 2)

  const repo = await ensureLocalRepo(METAREPO_BASE_URL, {
    rootPath: process.cwd(),
    name: path.basename(process.cwd()),
  })

  const reviewResponse = await reviewRun(METAREPO_BASE_URL, {
    repoId: repo.id,
    baseSha,
    headSha,
    maxDepth,
    requestedBy: 'pr-review-ci',
  })

  const { review, markdown } = reviewResponse.result

  mkdirSync(OUTPUT_DIR, { recursive: true })
  await writeFile(`${OUTPUT_DIR}/pr-review.json`, JSON.stringify(review, null, 2), 'utf-8')
  await writeFile(`${OUTPUT_DIR}/pr-review.md`, markdown, 'utf-8')

  if (GITHUB_TOKEN && PR_NUMBER && GITHUB_REPOSITORY) {
    const apiBase = GITHUB_API_URL || 'https://api.github.com'
    try {
      await upsertPrComment(apiBase, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, markdown)
      console.log(`Posted PR review comment on #${PR_NUMBER}`)
    } catch (error) {
      if (isGithubPermissionError(error)) {
        console.warn(`[pr-review-ci] Skipping PR comment publish: ${String((error as Error).message ?? error)}`)
      } else {
        throw error
      }
    }
  } else {
    console.log('Skipping PR comment publish (missing GITHUB_TOKEN/PR_NUMBER/GITHUB_REPOSITORY)')
  }
}

function runGit(command: string): string {
  return execSync(command, { encoding: 'utf-8' }).trim()
}

export function resolveDefaultBaseSha(): string {
  try {
    return runGit('git merge-base HEAD origin/main')
  } catch {
    try {
      return runGit('git rev-parse HEAD~1')
    } catch {
      return runGit('git rev-parse HEAD')
    }
  }
}

export function resolveDefaultHeadSha(): string {
  return runGit('git rev-parse HEAD')
}

export async function upsertPrComment(
  apiBase: string,
  token: string,
  repo: string,
  prNumber: string,
  body: string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  }

  const commentsUrl = `${apiBase}/repos/${repo}/issues/${prNumber}/comments`
  const existing = await findExistingComment(commentsUrl, headers)

  if (existing) {
    const updateUrl = `${apiBase}/repos/${repo}/issues/comments/${existing.id}`
    const updateResponse = await fetch(updateUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
    })
    if (!updateResponse.ok) {
      throw new Error(`Failed to update PR comment: ${updateResponse.status} ${await updateResponse.text()}`)
    }
    return
  }

  const createResponse = await fetch(commentsUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ body }),
  })
  if (!createResponse.ok) {
    throw new Error(`Failed to create PR comment: ${createResponse.status} ${await createResponse.text()}`)
  }
}

export async function findExistingComment(
  commentsUrl: string,
  headers: Record<string, string>,
): Promise<Comment | undefined> {
  const perPage = 100
  let page = 1
  const maxPages = 10
  while (page <= maxPages) {
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
    })
    const pageUrl = `${commentsUrl}?${params.toString()}`
    const listResponse = await fetch(pageUrl, { headers })
    if (!listResponse.ok) {
      throw new Error(`Failed to list PR comments: ${listResponse.status} ${await listResponse.text()}`)
    }
    const comments = (await listResponse.json()) as Comment[]
    const existing = comments.find(c => c.body?.includes(COMMENT_MARKER))
    if (existing) {
      return existing
    }
    if (comments.length < perPage) {
      break
    }
    page += 1
  }
  return undefined
}

export function isGithubPermissionError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error)
  return /Failed to (list PR comments|update PR comment|create PR comment):\s*(401|403|404)\b/.test(message)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[pr-review-ci] Failed:', error)
    process.exit(1)
  })
}
