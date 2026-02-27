/**
 * Tests for pr-review/diff.ts — unified diff parser
 */

import { parseDiff, parseHunkHeader } from 'entity-graph/pr-review/diff.js'

describe('parseHunkHeader', () => {
  it('parses a standard hunk header with counts', () => {
    const hunk = parseHunkHeader('@@ -10,5 +12,8 @@ function foo() {')
    expect(hunk).toEqual({
      oldStart: 10,
      oldCount: 5,
      newStart: 12,
      newCount: 8,
    })
  })

  it('parses a hunk header without counts (single-line)', () => {
    const hunk = parseHunkHeader('@@ -1 +1 @@')
    expect(hunk).toEqual({
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
    })
  })

  it('parses a hunk with zero count (empty side)', () => {
    const hunk = parseHunkHeader('@@ -0,0 +1,25 @@')
    expect(hunk).toEqual({
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: 25,
    })
  })

  it('returns null for non-hunk lines', () => {
    expect(parseHunkHeader('not a hunk')).toBeNull()
    expect(parseHunkHeader('--- a/file.ts')).toBeNull()
  })
})

describe('parseDiff', () => {
  it('parses a simple modified file diff', () => {
    const diff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index abc123..def456 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -10,3 +10,5 @@ export function authenticate() {',
      '   const token = getToken()',
      '-  return validate(token)',
      '+  const decoded = decode(token)',
      '+  return validate(decoded)',
      '+  // added line',
    ].join('\n')

    const changes = parseDiff(diff)
    expect(changes).toHaveLength(1)
    expect(changes[0].filepath).toBe('src/auth.ts')
    expect(changes[0].status).toBe('modified')
    expect(changes[0].hunks).toHaveLength(1)
    expect(changes[0].hunks[0]).toEqual({
      oldStart: 10,
      oldCount: 3,
      newStart: 10,
      newCount: 5,
    })
  })

  it('parses a new file diff', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,10 @@',
      '+export function hello() {}',
    ].join('\n')

    const changes = parseDiff(diff)
    expect(changes).toHaveLength(1)
    expect(changes[0].status).toBe('added')
    expect(changes[0].filepath).toBe('src/new.ts')
  })

  it('parses a deleted file diff', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,5 +0,0 @@',
      '-export function goodbye() {}',
    ].join('\n')

    const changes = parseDiff(diff)
    expect(changes).toHaveLength(1)
    expect(changes[0].status).toBe('deleted')
  })

  it('parses a renamed file diff', () => {
    const diff = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 95%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      'index abc123..def456 100644',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -1,3 +1,3 @@',
      ' export function foo() {',
      '-  return 1',
      '+  return 2',
      ' }',
    ].join('\n')

    const changes = parseDiff(diff)
    expect(changes).toHaveLength(1)
    expect(changes[0].status).toBe('renamed')
    expect(changes[0].filepath).toBe('src/new-name.ts')
    expect(changes[0].oldFilepath).toBe('src/old-name.ts')
  })

  it('parses multiple files in one diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index abc..def 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' line1',
      '+line2',
      'diff --git a/src/b.ts b/src/b.ts',
      'index ghi..jkl 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -5,3 +5,4 @@',
      ' existing',
      '+new',
      'diff --git a/src/c.ts b/src/c.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/c.ts',
      '@@ -0,0 +1,1 @@',
      '+content',
    ].join('\n')

    const changes = parseDiff(diff)
    expect(changes).toHaveLength(3)
    expect(changes[0].filepath).toBe('src/a.ts')
    expect(changes[1].filepath).toBe('src/b.ts')
    expect(changes[2].filepath).toBe('src/c.ts')
    expect(changes[2].status).toBe('added')
  })

  it('parses multiple hunks in a single file', () => {
    const diff = [
      'diff --git a/src/big.ts b/src/big.ts',
      'index abc..def 100644',
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      '@@ -5,3 +5,4 @@ function first() {',
      ' line',
      '+added',
      '@@ -50,2 +51,3 @@ function second() {',
      ' line',
      '+added',
    ].join('\n')

    const changes = parseDiff(diff)
    expect(changes).toHaveLength(1)
    expect(changes[0].hunks).toHaveLength(2)
    expect(changes[0].hunks[0].oldStart).toBe(5)
    expect(changes[0].hunks[1].oldStart).toBe(50)
  })

  it('returns empty array for empty input', () => {
    expect(parseDiff('')).toEqual([])
  })
})
