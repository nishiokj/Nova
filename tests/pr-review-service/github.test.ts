import { createHmac, generateKeyPairSync } from 'node:crypto'
import {
  createGitHubAppJwt,
  parsePullRequestJob,
  verifyGitHubSignature,
} from '../../packages/apps/pr-review-service/src/github.ts'

describe('pr-review-service github helpers', () => {
  it('accepts valid signatures and rejects invalid signatures', () => {
    const secret = 'super-secret'
    const body = JSON.stringify({ hello: 'world' })
    const digest = createHmac('sha256', secret).update(body, 'utf-8').digest('hex')
    const signature = `sha256=${digest}`

    expect(verifyGitHubSignature(secret, body, signature)).toBe(true)
    expect(verifyGitHubSignature(secret, body, 'sha256=deadbeef')).toBe(false)
    expect(verifyGitHubSignature(secret, body, undefined)).toBe(false)
  })

  it('accepts unsigned payloads when no secret is configured', () => {
    expect(verifyGitHubSignature(undefined, '{}', undefined)).toBe(true)
  })

  it('parses pull_request webhook payloads for supported actions', () => {
    const payload = {
      action: 'synchronize',
      number: 42,
      installation: { id: 777 },
      repository: {
        full_name: 'acme/repo',
        clone_url: 'https://github.com/acme/repo.git',
      },
      pull_request: {
        number: 42,
        draft: false,
        base: { sha: 'base-sha' },
        head: { sha: 'head-sha' },
      },
    }

    expect(parsePullRequestJob('pull_request', payload)).toEqual({
      action: 'synchronize',
      installationId: 777,
      repoFullName: 'acme/repo',
      cloneUrl: 'https://github.com/acme/repo.git',
      prNumber: 42,
      baseSha: 'base-sha',
      headSha: 'head-sha',
    })
  })

  it('ignores draft PR updates until ready_for_review', () => {
    const draftPayload = {
      action: 'opened',
      number: 1,
      repository: { full_name: 'acme/repo', clone_url: 'https://github.com/acme/repo.git' },
      pull_request: {
        number: 1,
        draft: true,
        base: { sha: 'base' },
        head: { sha: 'head' },
      },
    }

    expect(parsePullRequestJob('pull_request', draftPayload)).toBeNull()

    const readyPayload = {
      ...draftPayload,
      action: 'ready_for_review',
    }
    expect(parsePullRequestJob('pull_request', readyPayload)).not.toBeNull()
  })

  it('creates jwt-looking token for GitHub app auth', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const token = createGitHubAppJwt(
      '12345',
      privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      1_700_000_000,
    )
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    expect(parts[0].length).toBeGreaterThan(0)
    expect(parts[1].length).toBeGreaterThan(0)
    expect(parts[2].length).toBeGreaterThan(0)
  })
})
