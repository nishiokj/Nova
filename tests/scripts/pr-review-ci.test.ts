import type { PRReview } from 'entity-graph/pr-review/types.js'
import {
  COMMENT_MARKER,
  parsePositiveInt,
  formatReviewMarkdown,
  findExistingComment,
  upsertPrComment,
  isGithubPermissionError,
} from '../../scripts/pr-review-ci.ts'

function makeResponse(init: {
  ok: boolean
  status?: number
  jsonData?: unknown
  textData?: string
}): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    json: async () => init.jsonData,
    text: async () => init.textData ?? '',
  } as unknown as Response
}

function makeReview(overrides?: Partial<PRReview>): PRReview {
  return {
    summary: 'review summary',
    changedEntities: [
      {
        changeKind: 'body_changed',
        fileStatus: 'modified',
        entity: {
          id: 'function:src/a.ts:run',
          kind: 'function',
          name: 'run',
          filepath: 'src/a.ts',
          startLine: 1,
          endLine: 10,
          exported: true,
          async: false,
          rawText: null,
        },
      },
    ],
    blastRadius: {
      direct: [],
      transitive: [],
      totalFiles: 0,
      totalEntities: 0,
    },
    risks: [
      {
        entity: {
          id: 'function:src/b.ts:dep',
          kind: 'function',
          name: 'dep',
          filepath: 'src/b.ts',
          startLine: 1,
          endLine: 10,
          exported: false,
          async: false,
          rawText: null,
        },
        score: 55,
        factors: ['depth 1 via calls'],
      },
    ],
    impactGaps: [],
    deadCode: [],
    ...overrides,
  }
}

describe('scripts/pr-review-ci', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('parses positive integers with fallback', () => {
    expect(parsePositiveInt('3', 2)).toBe(3)
    expect(parsePositiveInt(undefined, 2)).toBe(2)
    expect(parsePositiveInt('0', 2)).toBe(2)
    expect(parsePositiveInt('-1', 2)).toBe(2)
    expect(parsePositiveInt('abc', 2)).toBe(2)
  })

  it('formats markdown with marker and summary data', () => {
    const markdown = formatReviewMarkdown('abcdef1234', '1234abcd', 2, makeReview())
    expect(markdown).toContain(COMMENT_MARKER)
    expect(markdown).toContain('Entity Graph PR Review')
    expect(markdown).toContain('Summary: review summary')
    expect(markdown).toContain('Contract impact gaps: 0')
  })

  it('renders the impact graph as pure markdown bullets', () => {
    const review = makeReview()
    const markdown = formatReviewMarkdown('abcdef1234', '1234abcd', 2, {
      ...review,
      blastRadius: {
        direct: [
          {
            entity: review.risks[0].entity,
            depth: 1,
            via: 'calls',
            seedId: review.changedEntities[0].entity.id,
          },
        ],
        transitive: [],
        totalFiles: 1,
        totalEntities: 1,
      },
    })

    expect(markdown).toContain('### Impact Graph')
    expect(markdown).toContain('- `run` in `src/a.ts` - `body_changed`')
    expect(markdown).toContain('  - depth 1 via `calls`: `dep` in `src/b.ts`')
    expect(markdown).not.toContain('```mermaid')
  })

  it('shows changed entities with no graph dependents in markdown', () => {
    const markdown = formatReviewMarkdown('abcdef1234', '1234abcd', 2, makeReview())
    expect(markdown).toContain('### Impact Graph')
    expect(markdown).toContain('  - No dependent entities found.')
  })

  it('renders unresolved contract dependents section when impact gaps exist', () => {
    const markdown = formatReviewMarkdown(
      'abcdef1234',
      '1234abcd',
      2,
      makeReview({
        impactGaps: [
          {
            seed: makeReview().changedEntities[0].entity,
            seedChangeKind: 'signature_changed',
            directDependents: [makeReview().risks[0].entity],
            unresolvedDependents: [makeReview().risks[0].entity],
          },
        ],
      }),
    )
    expect(markdown).toContain('Unresolved Contract Dependents')
    expect(markdown).toContain('signature_changed')
    expect(markdown).toContain('has 1/1 direct dependents not updated')
  })

  it('truncates oversized markdown output', () => {
    const hugeFactor = 'x'.repeat(70000)
    const markdown = formatReviewMarkdown(
      'abcdef1234',
      '1234abcd',
      2,
      makeReview({
        risks: [
          {
            ...makeReview().risks[0],
            factors: [hugeFactor],
          },
        ],
      }),
    )
    expect(markdown.endsWith('_Comment truncated due to size._')).toBe(true)
  })

  it('finds existing marker comment across pagination', async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `comment ${i + 1}` }))
    const secondPage = [{ id: 999, body: `persisted ${COMMENT_MARKER}` }]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ ok: true, jsonData: firstPage }))
      .mockResolvedValueOnce(makeResponse({ ok: true, jsonData: secondPage }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const existing = await findExistingComment('https://api.github.com/repos/acme/repo/issues/5/comments', {})

    expect(existing?.id).toBe(999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain('per_page=100&page=1')
    expect(String(fetchMock.mock.calls[1][0])).toContain('per_page=100&page=2')
  })

  it('updates existing sticky comment when marker is present', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({
        ok: true,
        jsonData: [{ id: 123, body: `${COMMENT_MARKER}\nold` }],
      }))
      .mockResolvedValueOnce(makeResponse({ ok: true, jsonData: {} }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await upsertPrComment('https://api.github.com', 'token', 'acme/repo', '7', 'new body')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.github.com/repos/acme/repo/issues/comments/123')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PATCH' })
  })

  it('creates sticky comment when marker is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ ok: true, jsonData: [{ id: 1, body: 'other' }] }))
      .mockResolvedValueOnce(makeResponse({ ok: true, jsonData: {} }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await upsertPrComment('https://api.github.com', 'token', 'acme/repo', '8', 'new body')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.github.com/repos/acme/repo/issues/8/comments')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' })
  })

  it('detects permission-related GitHub API errors', () => {
    expect(isGithubPermissionError(new Error('Failed to create PR comment: 403 forbidden'))).toBe(true)
    expect(isGithubPermissionError(new Error('Failed to list PR comments: 404 not found'))).toBe(true)
    expect(isGithubPermissionError(new Error('Failed to update PR comment: 401 unauthorized'))).toBe(true)
    expect(isGithubPermissionError(new Error('network timeout'))).toBe(false)
  })
})
