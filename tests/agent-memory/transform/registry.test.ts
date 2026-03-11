import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { TransformationRegistry } from 'agent-memory/transform/registry.js'
import type { Transformation } from 'agent-memory/transform/types.js'
import type { ConnectorType } from 'agent-memory/ids.js'

function makeTransformation(overrides: Partial<Transformation> = {}): Transformation {
  return {
    id: 'test-transform',
    name: 'Test Transform',
    source: { connector: 'gmail', entityType: 'message' },
    inputSchema: z.any(),
    outputType: 'message',
    transform: () => ({
      primary: {
        entityType: 'message',
        sourceRefKey: 'test',
        data: {},
      },
    }),
    onError: 'skip',
    enabled: true,
    version: 1,
    ...overrides,
  }
}

describe('TransformationRegistry', () => {
  // ── register ──────────────────────────────────────────────────────

  describe('register', () => {
    it('stores a transformation retrievable by id', () => {
      const reg = new TransformationRegistry()
      const t = makeTransformation({ id: 'alpha' })
      reg.register(t)

      const result = reg.get('alpha')
      expect(result!.id).toBe('alpha')
      expect(result!.name).toBe('Test Transform')
      expect(result!.source.connector).toBe('gmail')
    })

    it('returns this for chaining', () => {
      const reg = new TransformationRegistry()
      const returned = reg.register(makeTransformation({ id: 'a' }))
      expect(returned).toBe(reg)
    })

    it('supports chaining multiple register calls', () => {
      const reg = new TransformationRegistry()
      reg
        .register(makeTransformation({ id: 'a' }))
        .register(makeTransformation({ id: 'b' }))
        .register(makeTransformation({ id: 'c' }))

      expect(reg.list().length).toBe(3)
      expect(reg.get('a')!.id).toBe('a')
      expect(reg.get('b')!.id).toBe('b')
      expect(reg.get('c')!.id).toBe('c')
    })

    it('throws on duplicate id', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'dup' }))

      expect(() => reg.register(makeTransformation({ id: 'dup' }))).toThrowError(
        'Transformation already registered: dup',
      )
    })

    it('throws on duplicate id even when other fields differ', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'same', name: 'First', version: 1 }))

      expect(() =>
        reg.register(makeTransformation({ id: 'same', name: 'Second', version: 2 })),
      ).toThrowError('Transformation already registered: same')
    })

    it('does not partially register when throwing on duplicate', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'orig', name: 'Original' }))

      try {
        reg.register(makeTransformation({ id: 'orig', name: 'Imposter' }))
      } catch {
        // expected
      }

      // Original is untouched
      expect(reg.get('orig')!.name).toBe('Original')
      expect(reg.list().length).toBe(1)
    })
  })

  // ── unregister ────────────────────────────────────────────────────

  describe('unregister', () => {
    it('removes a registered transformation and returns true', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'doomed' }))

      expect(reg.unregister('doomed')).toBe(true)
      expect(reg.get('doomed')).toBe(undefined)
    })

    it('returns false for a non-existent id', () => {
      const reg = new TransformationRegistry()
      expect(reg.unregister('ghost')).toBe(false)
    })

    it('returns false when unregistering the same id twice', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'once' }))

      expect(reg.unregister('once')).toBe(true)
      expect(reg.unregister('once')).toBe(false)
    })

    it('does not affect other registrations', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'keep' }))
      reg.register(makeTransformation({ id: 'remove' }))

      reg.unregister('remove')

      expect(reg.get('keep')!.id).toBe('keep')
      expect(reg.list().length).toBe(1)
    })
  })

  // ── get ───────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns undefined for empty registry', () => {
      const reg = new TransformationRegistry()
      expect(reg.get('anything')).toBe(undefined)
    })

    it('returns undefined for non-existent id in populated registry', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'exists' }))

      expect(reg.get('does-not-exist')).toBe(undefined)
    })

    it('returns the exact transformation object', () => {
      const reg = new TransformationRegistry()
      const t = makeTransformation({ id: 'exact', version: 7, description: 'seven' })
      reg.register(t)

      const result = reg.get('exact')!
      expect(result.version).toBe(7)
      expect(result.description).toBe('seven')
      expect(result.onError).toBe('skip')
    })
  })

  // ── findBySource ──────────────────────────────────────────────────

  describe('findBySource', () => {
    it('returns empty array when nothing matches', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'a', source: { connector: 'gmail', entityType: 'message' } }))

      expect(reg.findBySource('github', 'issue').length).toBe(0)
    })

    it('returns empty array on empty registry', () => {
      const reg = new TransformationRegistry()
      expect(reg.findBySource('gmail', 'message').length).toBe(0)
    })

    it('matches by connector and entityType', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'g1', source: { connector: 'github', entityType: 'issue' } }))
      reg.register(makeTransformation({ id: 'g2', source: { connector: 'github', entityType: 'pr' } }))
      reg.register(makeTransformation({ id: 'm1', source: { connector: 'gmail', entityType: 'message' } }))

      const results = reg.findBySource('github', 'issue')
      expect(results.length).toBe(1)
      expect(results[0].id).toBe('g1')
    })

    it('excludes disabled transformations', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'enabled',
        source: { connector: 'telegram', entityType: 'chat' },
        enabled: true,
      }))
      reg.register(makeTransformation({
        id: 'disabled',
        source: { connector: 'telegram', entityType: 'chat' },
        enabled: false,
      }))

      const results = reg.findBySource('telegram', 'chat')
      expect(results.length).toBe(1)
      expect(results[0].id).toBe('enabled')
    })

    it('returns nothing when all matches are disabled', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'd1',
        source: { connector: 'gmail', entityType: 'thread' },
        enabled: false,
      }))
      reg.register(makeTransformation({
        id: 'd2',
        source: { connector: 'gmail', entityType: 'thread' },
        enabled: false,
      }))

      expect(reg.findBySource('gmail', 'thread').length).toBe(0)
    })

    it('requires exact entityType match', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'x', source: { connector: 'gmail', entityType: 'message' } }))

      // Substring should not match
      expect(reg.findBySource('gmail', 'msg').length).toBe(0)
      expect(reg.findBySource('gmail', 'messages').length).toBe(0)
      expect(reg.findBySource('gmail', 'MESSAGE').length).toBe(0)
    })

    it('returns multiple enabled matches for same source', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'v1',
        source: { connector: 'obsidian', entityType: 'note' },
        version: 1,
      }))
      reg.register(makeTransformation({
        id: 'v2',
        source: { connector: 'obsidian', entityType: 'note' },
        version: 2,
      }))

      const results = reg.findBySource('obsidian', 'note')
      expect(results.length).toBe(2)
      const ids = results.map((r) => r.id)
      expect(ids).toContain('v1')
      expect(ids).toContain('v2')
    })
  })

  // ── findByConnector ───────────────────────────────────────────────

  describe('findByConnector', () => {
    it('returns empty array for unregistered connector', () => {
      const reg = new TransformationRegistry()
      expect(reg.findByConnector('xcom').length).toBe(0)
    })

    it('returns all transformations for connector regardless of entityType', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'gh-issue', source: { connector: 'github', entityType: 'issue' } }))
      reg.register(makeTransformation({ id: 'gh-pr', source: { connector: 'github', entityType: 'pr' } }))
      reg.register(makeTransformation({ id: 'gh-comment', source: { connector: 'github', entityType: 'comment' } }))
      reg.register(makeTransformation({ id: 'gm-msg', source: { connector: 'gmail', entityType: 'message' } }))

      const results = reg.findByConnector('github')
      expect(results.length).toBe(3)
      const ids = results.map((r) => r.id)
      expect(ids).toContain('gh-issue')
      expect(ids).toContain('gh-pr')
      expect(ids).toContain('gh-comment')
    })

    it('includes disabled transformations', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'on',
        source: { connector: 'imessage', entityType: 'sms' },
        enabled: true,
      }))
      reg.register(makeTransformation({
        id: 'off',
        source: { connector: 'imessage', entityType: 'sms' },
        enabled: false,
      }))

      const results = reg.findByConnector('imessage')
      expect(results.length).toBe(2)
      const ids = results.map((r) => r.id)
      expect(ids).toContain('on')
      expect(ids).toContain('off')
    })

    it('does not return transformations from other connectors', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'a', source: { connector: 'gmail', entityType: 'msg' } }))
      reg.register(makeTransformation({ id: 'b', source: { connector: 'github', entityType: 'issue' } }))

      const results = reg.findByConnector('gmail')
      expect(results.length).toBe(1)
      expect(results[0].id).toBe('a')
    })
  })

  // ── list ──────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns empty array for empty registry', () => {
      const reg = new TransformationRegistry()
      expect(reg.list().length).toBe(0)
    })

    it('returns all registered transformations', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'x' }))
      reg.register(makeTransformation({ id: 'y' }))
      reg.register(makeTransformation({ id: 'z' }))

      const all = reg.list()
      expect(all.length).toBe(3)
      const ids = all.map((t) => t.id)
      expect(ids).toContain('x')
      expect(ids).toContain('y')
      expect(ids).toContain('z')
    })

    it('reflects unregistrations', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'a' }))
      reg.register(makeTransformation({ id: 'b' }))
      reg.unregister('a')

      const all = reg.list()
      expect(all.length).toBe(1)
      expect(all[0].id).toBe('b')
    })
  })

  // ── hasTransformation ─────────────────────────────────────────────

  describe('hasTransformation', () => {
    it('returns false on empty registry', () => {
      const reg = new TransformationRegistry()
      expect(reg.hasTransformation('gmail', 'message')).toBe(false)
    })

    it('returns true when an enabled match exists', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'h1',
        source: { connector: 'github', entityType: 'issue' },
        enabled: true,
      }))

      expect(reg.hasTransformation('github', 'issue')).toBe(true)
    })

    it('returns false when only disabled matches exist', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'h2',
        source: { connector: 'github', entityType: 'pr' },
        enabled: false,
      }))

      expect(reg.hasTransformation('github', 'pr')).toBe(false)
    })

    it('returns false for wrong connector', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'h3',
        source: { connector: 'gmail', entityType: 'message' },
        enabled: true,
      }))

      expect(reg.hasTransformation('telegram', 'message')).toBe(false)
    })

    it('returns false for wrong entityType', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'h4',
        source: { connector: 'gmail', entityType: 'message' },
        enabled: true,
      }))

      expect(reg.hasTransformation('gmail', 'thread')).toBe(false)
    })

    it('returns false after the only match is unregistered', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'h5',
        source: { connector: 'obsidian', entityType: 'note' },
        enabled: true,
      }))

      expect(reg.hasTransformation('obsidian', 'note')).toBe(true)
      reg.unregister('h5')
      expect(reg.hasTransformation('obsidian', 'note')).toBe(false)
    })

    it('becomes false after disabling the only match', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'h6',
        source: { connector: 'xcom', entityType: 'post' },
        enabled: true,
      }))

      expect(reg.hasTransformation('xcom', 'post')).toBe(true)
      reg.setEnabled('h6', false)
      expect(reg.hasTransformation('xcom', 'post')).toBe(false)
    })
  })

  // ── setEnabled ────────────────────────────────────────────────────

  describe('setEnabled', () => {
    it('returns false for non-existent id', () => {
      const reg = new TransformationRegistry()
      expect(reg.setEnabled('nope', true)).toBe(false)
    })

    it('returns false for non-existent id in populated registry', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'exists' }))
      expect(reg.setEnabled('wrong-id', false)).toBe(false)
    })

    it('disables an enabled transformation', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'target', enabled: true }))

      expect(reg.setEnabled('target', false)).toBe(true)
      expect(reg.get('target')!.enabled).toBe(false)
    })

    it('enables a disabled transformation', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'off', enabled: false }))

      expect(reg.setEnabled('off', true)).toBe(true)
      expect(reg.get('off')!.enabled).toBe(true)
    })

    it('is idempotent when setting same state', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'idem', enabled: true }))

      expect(reg.setEnabled('idem', true)).toBe(true)
      expect(reg.get('idem')!.enabled).toBe(true)
    })

    it('toggling affects findBySource results', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'toggle',
        source: { connector: 'claude_sessions', entityType: 'turn' },
        enabled: true,
      }))

      expect(reg.findBySource('claude_sessions', 'turn').length).toBe(1)

      reg.setEnabled('toggle', false)
      expect(reg.findBySource('claude_sessions', 'turn').length).toBe(0)

      reg.setEnabled('toggle', true)
      expect(reg.findBySource('claude_sessions', 'turn').length).toBe(1)
    })

    it('does not affect findByConnector results', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({
        id: 'stay',
        source: { connector: 'google-calendar', entityType: 'event' },
        enabled: true,
      }))

      reg.setEnabled('stay', false)
      // findByConnector includes disabled
      expect(reg.findByConnector('google-calendar').length).toBe(1)
      expect(reg.findByConnector('google-calendar')[0].enabled).toBe(false)
    })

    it('returns false after the transformation is unregistered', () => {
      const reg = new TransformationRegistry()
      reg.register(makeTransformation({ id: 'gone' }))
      reg.unregister('gone')

      expect(reg.setEnabled('gone', true)).toBe(false)
    })
  })

  // ── isolation between registries ──────────────────────────────────

  describe('instance isolation', () => {
    it('separate registries do not share state', () => {
      const a = new TransformationRegistry()
      const b = new TransformationRegistry()

      a.register(makeTransformation({ id: 'only-in-a' }))
      b.register(makeTransformation({ id: 'only-in-b' }))

      expect(a.get('only-in-a')!.id).toBe('only-in-a')
      expect(a.get('only-in-b')).toBe(undefined)
      expect(b.get('only-in-b')!.id).toBe('only-in-b')
      expect(b.get('only-in-a')).toBe(undefined)
    })
  })
})
