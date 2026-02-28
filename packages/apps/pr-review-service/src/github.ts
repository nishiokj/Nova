import { createHmac, createSign, timingSafeEqual } from 'node:crypto'
import type { PRReviewJob } from './types.js'

const SUPPORTED_PR_ACTIONS = new Set([
  'opened',
  'synchronize',
  'reopened',
  'ready_for_review',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function verifyGitHubSignature(
  secret: string | undefined,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!secret) return true
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false

  const providedHex = signatureHeader.slice('sha256='.length)
  const expectedHex = createHmac('sha256', secret).update(rawBody, 'utf-8').digest('hex')
  const provided = Buffer.from(providedHex, 'hex')
  const expected = Buffer.from(expectedHex, 'hex')
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

export function parsePullRequestJob(eventName: string | undefined, payload: unknown): PRReviewJob | null {
  if (eventName !== 'pull_request') return null
  const root = asRecord(payload)
  if (!root) return null

  const action = asString(root.action)
  if (!action || !SUPPORTED_PR_ACTIONS.has(action)) return null

  const pullRequest = asRecord(root.pull_request)
  const repository = asRecord(root.repository)
  if (!pullRequest || !repository) return null

  const isDraft = pullRequest.draft === true
  if (isDraft && action !== 'ready_for_review') {
    return null
  }

  const number = asNumber(pullRequest.number) ?? asNumber(root.number)
  const base = asRecord(pullRequest.base)
  const head = asRecord(pullRequest.head)
  const cloneUrl = asString(repository.clone_url)
  const repoFullName = asString(repository.full_name)

  const baseSha = base ? asString(base.sha) : null
  const headSha = head ? asString(head.sha) : null

  if (!number || !baseSha || !headSha || !cloneUrl || !repoFullName) {
    return null
  }

  const installation = asRecord(root.installation)
  const installationId = installation ? asNumber(installation.id) : null

  return {
    installationId,
    repoFullName,
    cloneUrl,
    prNumber: number,
    action,
    baseSha,
    headSha,
  }
}

function base64UrlEncode(raw: Buffer | string): string {
  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function normalizePrivateKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
}

export function createGitHubAppJwt(
  appId: string,
  privateKeyRaw: string,
  nowEpochSec: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64UrlEncode(JSON.stringify({
    iat: nowEpochSec - 60,
    exp: nowEpochSec + (9 * 60),
    iss: appId,
  }))
  const unsigned = `${header}.${payload}`

  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  const signature = signer.sign(normalizePrivateKey(privateKeyRaw))
  return `${unsigned}.${base64UrlEncode(signature)}`
}

export async function exchangeInstallationToken(input: {
  apiBase: string
  appId: string
  appPrivateKey: string
  installationId: number
}): Promise<string> {
  const jwt = createGitHubAppJwt(input.appId, input.appPrivateKey)
  const response = await fetch(
    `${input.apiBase}/app/installations/${input.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    },
  )
  if (!response.ok) {
    throw new Error(`Failed to exchange installation token: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { token?: string }
  if (!body.token) {
    throw new Error('GitHub installation token response missing token')
  }
  return body.token
}

export async function resolveGithubToken(input: {
  apiBase: string
  staticToken?: string
  appId?: string
  appPrivateKey?: string
  installationId: number | null
}): Promise<string> {
  if (input.staticToken) {
    return input.staticToken
  }

  if (!input.appId || !input.appPrivateKey || !input.installationId) {
    throw new Error(
      'Missing GitHub credentials. Set GITHUB_TOKEN or set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY with installation webhook payload.',
    )
  }

  return exchangeInstallationToken({
    apiBase: input.apiBase,
    appId: input.appId,
    appPrivateKey: input.appPrivateKey,
    installationId: input.installationId,
  })
}
