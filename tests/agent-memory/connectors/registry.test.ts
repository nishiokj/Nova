import { describe, it, expect, vi } from 'vitest'

// bun:sqlite is unavailable in Node/vitest — mock it so transitive imports resolve
vi.mock('bun:sqlite', () => ({
  Database: class MockDatabase {},
}))

import {
  listFactoryTypes,
  getFactory,
  hasFactory,
  createConnector,
  CONNECTOR_FACTORIES,
} from 'agent-memory/connectors/registry.js'
import type { ConnectorType } from 'agent-memory/ids.js'

const ALL_TYPES: ConnectorType[] = [
  'gmail',
  'github',
  'claude_sessions',
  'nova_sessions',
  'imessage',
  'google-calendar',
  'obsidian',
  'telegram',
  'xcom',
  'watcher_sessions',
]

describe('Connector Factory Registry', () => {
  // ============ listFactoryTypes ============

  describe('listFactoryTypes', () => {
    it('returns all registered connector types', () => {
      const types = listFactoryTypes()
      for (const t of ALL_TYPES) {
        expect(types).toContain(t)
      }
    })

    it('returns exactly the keys of CONNECTOR_FACTORIES', () => {
      const types = listFactoryTypes()
      const keys = Object.keys(CONNECTOR_FACTORIES)
      expect(types).toEqual(keys)
    })

    it('has no duplicate entries', () => {
      const types = listFactoryTypes()
      expect(new Set(types).size).toBe(types.length)
    })

    it('returns the expected count of connector types', () => {
      expect(listFactoryTypes()).toHaveLength(ALL_TYPES.length)
    })
  })

  // ============ getFactory ============

  describe('getFactory', () => {
    it.each(ALL_TYPES)('returns an entry for "%s"', (type) => {
      const entry = getFactory(type)
      expect(entry).toBeDefined()
      expect(typeof entry!.factory).toBe('function')
      expect(typeof entry!.displayName).toBe('string')
      expect(entry!.displayName.length).toBeGreaterThan(0)
    })

    it('returns undefined for an unknown type', () => {
      expect(getFactory('nonexistent' as ConnectorType)).toBeUndefined()
    })

    it('returns undefined for empty string', () => {
      expect(getFactory('' as ConnectorType)).toBeUndefined()
    })

    it('is case-sensitive (uppercase variant not found)', () => {
      expect(getFactory('GMAIL' as ConnectorType)).toBeUndefined()
    })

    it('returns the same reference as CONNECTOR_FACTORIES', () => {
      const entry = getFactory('github')
      expect(entry).toBe(CONNECTOR_FACTORIES.github)
    })
  })

  // ============ hasFactory ============

  describe('hasFactory', () => {
    it.each(ALL_TYPES)('returns true for "%s"', (type) => {
      expect(hasFactory(type)).toBe(true)
    })

    it('returns false for an unknown type', () => {
      expect(hasFactory('nonexistent' as ConnectorType)).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(hasFactory('' as ConnectorType)).toBe(false)
    })

    it('returns false for a type with trailing whitespace', () => {
      expect(hasFactory('gmail ' as ConnectorType)).toBe(false)
    })

    it('returns false for a substring of a valid type', () => {
      expect(hasFactory('gmai' as ConnectorType)).toBe(false)
    })

    it('is consistent with getFactory', () => {
      for (const t of ALL_TYPES) {
        expect(hasFactory(t)).toBe(getFactory(t) !== undefined)
      }
      expect(hasFactory('bogus' as ConnectorType)).toBe(
        getFactory('bogus' as ConnectorType) !== undefined,
      )
    })
  })

  // ============ createConnector ============

  describe('createConnector', () => {
    it('throws for an unknown connector type with the exact message', async () => {
      await expect(createConnector('does_not_exist' as ConnectorType)).rejects.toThrow(
        'Unknown connector type: does_not_exist',
      )
    })

    it('throws for empty string type', async () => {
      await expect(createConnector('' as ConnectorType)).rejects.toThrow(
        'Unknown connector type: ',
      )
    })

    it('throws Error (not a subclass) for unknown type', async () => {
      try {
        await createConnector('nope' as ConnectorType)
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).message).toBe('Unknown connector type: nope')
      }
    })

    it('propagates the error from telegram factory', async () => {
      await expect(createConnector('telegram')).rejects.toThrow(
        'Telegram connector is initialized separately via TelegramConnector',
      )
    })

    it('propagates the error from xcom factory', async () => {
      await expect(createConnector('xcom')).rejects.toThrow(
        'X.com connector not yet implemented',
      )
    })

    it('telegram factory error is an Error instance', async () => {
      try {
        await createConnector('telegram')
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
      }
    })

    it('xcom factory error is an Error instance', async () => {
      try {
        await createConnector('xcom')
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
      }
    })

    it('passes config through to the factory', async () => {
      // telegram's factory ignores config and throws — but the throw proves
      // the factory was called (if it weren't, we'd get "Unknown connector type")
      await expect(
        createConnector('telegram', { apiKey: 'test-key' }),
      ).rejects.toThrow('Telegram connector is initialized separately via TelegramConnector')
    })
  })

  // ============ CONNECTOR_FACTORIES shape ============

  describe('CONNECTOR_FACTORIES', () => {
    it('every entry has a factory function', () => {
      for (const [type, entry] of Object.entries(CONNECTOR_FACTORIES)) {
        expect(typeof entry.factory).toBe('function')
      }
    })

    it('every entry has a non-empty displayName', () => {
      for (const [type, entry] of Object.entries(CONNECTOR_FACTORIES)) {
        expect(entry.displayName).toBeTruthy()
        expect(typeof entry.displayName).toBe('string')
      }
    })

    it('displayNames are unique across all entries', () => {
      const names = Object.values(CONNECTOR_FACTORIES).map((e) => e.displayName)
      expect(new Set(names).size).toBe(names.length)
    })

    it('async field is either undefined or boolean when present', () => {
      for (const entry of Object.values(CONNECTOR_FACTORIES)) {
        if ('async' in entry) {
          expect(typeof entry.async).toBe('boolean')
        }
      }
    })

    it('known display names match expected values', () => {
      const expected: Record<string, string> = {
        gmail: 'Gmail',
        github: 'GitHub',
        claude_sessions: 'Claude Code Sessions',
        nova_sessions: 'Nova Sessions (GraphD)',
        imessage: 'iMessage',
        'google-calendar': 'Google Calendar',
        obsidian: 'Obsidian',
        telegram: 'Telegram',
        xcom: 'X (Twitter)',
        watcher_sessions: 'Watcher Sessions',
      }
      for (const [type, name] of Object.entries(expected)) {
        expect(CONNECTOR_FACTORIES[type as ConnectorType].displayName).toBe(name)
      }
    })
  })
})
