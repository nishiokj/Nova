import { describe, it, expect, beforeEach } from 'vitest';
import { TransformationRegistry } from 'agent-memory/transform/registry.js';
import type { Transformation } from 'agent-memory/transform/types.js';
import type { ConnectorType } from 'agent-memory/ids.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTransformation(
  overrides: Partial<Transformation> & { id: string },
): Transformation {
  return {
    name: overrides.name ?? overrides.id,
    source: overrides.source ?? { connector: 'gmail' as ConnectorType, entityType: 'message' },
    inputSchema: overrides.inputSchema ?? z.unknown(),
    outputType: overrides.outputType ?? 'note',
    transform: overrides.transform ?? (() => ({
      primary: {
        entityType: 'note' as const,
        sourceRefKey: 'test-ref',
        data: {},
      },
    })),
    onError: overrides.onError ?? 'skip',
    enabled: overrides.enabled ?? true,
    version: overrides.version ?? 1,
    ...overrides,
  } as Transformation;
}

const GMAIL_MESSAGE = makeTransformation({
  id: 'gmail-message',
  source: { connector: 'gmail' as ConnectorType, entityType: 'message' },
  enabled: true,
});

const GMAIL_THREAD = makeTransformation({
  id: 'gmail-thread',
  source: { connector: 'gmail' as ConnectorType, entityType: 'thread' },
  enabled: true,
});

const GITHUB_ISSUE = makeTransformation({
  id: 'github-issue',
  source: { connector: 'github' as ConnectorType, entityType: 'issue' },
  enabled: true,
});

const GMAIL_MESSAGE_DISABLED = makeTransformation({
  id: 'gmail-message-disabled',
  source: { connector: 'gmail' as ConnectorType, entityType: 'message' },
  enabled: false,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransformationRegistry', () => {
  let registry: TransformationRegistry;

  beforeEach(() => {
    registry = new TransformationRegistry();
  });

  // --- register ---

  describe('register', () => {
    it('stores a transformation retrievable by id', () => {
      registry.register(GMAIL_MESSAGE);
      const stored = registry.get(GMAIL_MESSAGE.id);
      expect(stored).toBe(GMAIL_MESSAGE);
    });

    it('returns the registry instance for chaining', () => {
      const ret = registry.register(GMAIL_MESSAGE);
      expect(ret).toBe(registry);
    });

    it('allows chaining multiple registrations', () => {
      const ret = registry
        .register(GMAIL_MESSAGE)
        .register(GMAIL_THREAD)
        .register(GITHUB_ISSUE);
      expect(ret).toBe(registry);
      expect(registry.list()).toHaveLength(3);
    });

    it('throws on duplicate id with the conflicting id in the message', () => {
      registry.register(GMAIL_MESSAGE);
      expect(() => registry.register(GMAIL_MESSAGE)).toThrowError(
        `Transformation already registered: ${GMAIL_MESSAGE.id}`,
      );
    });

    it('allows different ids for the same source', () => {
      const duplicate = makeTransformation({
        id: 'gmail-message-v2',
        source: { connector: 'gmail' as ConnectorType, entityType: 'message' },
      });
      registry.register(GMAIL_MESSAGE);
      registry.register(duplicate);
      expect(registry.list()).toHaveLength(2);
    });
  });

  // --- unregister ---

  describe('unregister', () => {
    it('returns true and removes an existing transformation', () => {
      registry.register(GMAIL_MESSAGE);
      const removed = registry.unregister(GMAIL_MESSAGE.id);
      expect(removed).toBe(true);
      expect(registry.get(GMAIL_MESSAGE.id)).toBeUndefined();
    });

    it('returns false for a non-existent id', () => {
      const removed = registry.unregister('nonexistent');
      expect(removed).toBe(false);
    });

    it('makes the id available for re-registration', () => {
      registry.register(GMAIL_MESSAGE);
      registry.unregister(GMAIL_MESSAGE.id);
      // Should not throw — the id slot is free
      registry.register(GMAIL_MESSAGE);
      expect(registry.get(GMAIL_MESSAGE.id)).toBe(GMAIL_MESSAGE);
    });
  });

  // --- get ---

  describe('get', () => {
    it('returns undefined for unknown id', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('returns the exact object that was registered', () => {
      registry.register(GMAIL_MESSAGE);
      expect(registry.get(GMAIL_MESSAGE.id)).toBe(GMAIL_MESSAGE);
    });
  });

  // --- findBySource ---

  describe('findBySource', () => {
    it('returns transformations matching both connector and entityType', () => {
      registry.register(GMAIL_MESSAGE).register(GMAIL_THREAD).register(GITHUB_ISSUE);
      const matches = registry.findBySource('gmail' as ConnectorType, 'message');
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe('gmail-message');
    });

    it('excludes disabled transformations', () => {
      registry.register(GMAIL_MESSAGE).register(GMAIL_MESSAGE_DISABLED);
      const matches = registry.findBySource('gmail' as ConnectorType, 'message');
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe('gmail-message');
    });

    it('returns empty array when connector matches but entityType does not', () => {
      registry.register(GMAIL_MESSAGE);
      const matches = registry.findBySource('gmail' as ConnectorType, 'thread');
      expect(matches).toHaveLength(0);
    });

    it('returns empty array when entityType matches but connector does not', () => {
      registry.register(GMAIL_MESSAGE);
      const matches = registry.findBySource('github' as ConnectorType, 'message');
      expect(matches).toHaveLength(0);
    });

    it('returns empty array on empty registry', () => {
      const matches = registry.findBySource('gmail' as ConnectorType, 'message');
      expect(matches).toHaveLength(0);
    });

    it('returns multiple enabled matches for the same source', () => {
      const extra = makeTransformation({
        id: 'gmail-message-v2',
        source: { connector: 'gmail' as ConnectorType, entityType: 'message' },
        enabled: true,
      });
      registry.register(GMAIL_MESSAGE).register(extra);
      const matches = registry.findBySource('gmail' as ConnectorType, 'message');
      expect(matches).toHaveLength(2);
      const ids = matches.map((m) => m.id).sort();
      expect(ids).toEqual(['gmail-message', 'gmail-message-v2']);
    });
  });

  // --- findByConnector ---

  describe('findByConnector', () => {
    it('returns all transformations for a connector regardless of entityType', () => {
      registry.register(GMAIL_MESSAGE).register(GMAIL_THREAD).register(GITHUB_ISSUE);
      const matches = registry.findByConnector('gmail' as ConnectorType);
      expect(matches).toHaveLength(2);
      const ids = matches.map((m) => m.id).sort();
      expect(ids).toEqual(['gmail-message', 'gmail-thread']);
    });

    it('includes disabled transformations (unlike findBySource)', () => {
      registry.register(GMAIL_MESSAGE).register(GMAIL_MESSAGE_DISABLED);
      const matches = registry.findByConnector('gmail' as ConnectorType);
      expect(matches).toHaveLength(2);
      const ids = matches.map((m) => m.id).sort();
      expect(ids).toEqual(['gmail-message', 'gmail-message-disabled']);
    });

    it('returns empty array for unregistered connector', () => {
      registry.register(GMAIL_MESSAGE);
      const matches = registry.findByConnector('telegram' as ConnectorType);
      expect(matches).toHaveLength(0);
    });
  });

  // --- list ---

  describe('list', () => {
    it('returns empty array when nothing is registered', () => {
      expect(registry.list()).toEqual([]);
    });

    it('returns all registered transformations', () => {
      registry.register(GMAIL_MESSAGE).register(GITHUB_ISSUE);
      const all = registry.list();
      expect(all).toHaveLength(2);
      const ids = all.map((t) => t.id).sort();
      expect(ids).toEqual(['github-issue', 'gmail-message']);
    });
  });

  // --- hasTransformation ---

  describe('hasTransformation', () => {
    it('returns true when an enabled match exists', () => {
      registry.register(GMAIL_MESSAGE);
      expect(registry.hasTransformation('gmail' as ConnectorType, 'message')).toBe(true);
    });

    it('returns false when no match exists', () => {
      expect(registry.hasTransformation('gmail' as ConnectorType, 'message')).toBe(false);
    });

    it('returns false when only disabled matches exist', () => {
      registry.register(GMAIL_MESSAGE_DISABLED);
      expect(registry.hasTransformation('gmail' as ConnectorType, 'message')).toBe(false);
    });
  });

  // --- setEnabled ---

  describe('setEnabled', () => {
    it('disables an enabled transformation', () => {
      registry.register(GMAIL_MESSAGE);
      const result = registry.setEnabled('gmail-message', false);
      expect(result).toBe(true);
      // Observable effect: findBySource now excludes it
      expect(registry.findBySource('gmail' as ConnectorType, 'message')).toHaveLength(0);
    });

    it('enables a disabled transformation', () => {
      registry.register(GMAIL_MESSAGE_DISABLED);
      const result = registry.setEnabled('gmail-message-disabled', true);
      expect(result).toBe(true);
      expect(registry.findBySource('gmail' as ConnectorType, 'message')).toHaveLength(1);
      expect(registry.findBySource('gmail' as ConnectorType, 'message')[0].id).toBe(
        'gmail-message-disabled',
      );
    });

    it('returns false for non-existent id', () => {
      expect(registry.setEnabled('nonexistent', true)).toBe(false);
    });

    it('disabled transformation still appears in findByConnector', () => {
      registry.register(GMAIL_MESSAGE);
      registry.setEnabled('gmail-message', false);
      const matches = registry.findByConnector('gmail' as ConnectorType);
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe('gmail-message');
    });

    it('disabled transformation still appears in get', () => {
      registry.register(GMAIL_MESSAGE);
      registry.setEnabled('gmail-message', false);
      const t = registry.get('gmail-message');
      expect(t).toBe(GMAIL_MESSAGE);
      expect(t!.enabled).toBe(false);
    });

    it('disabled transformation still appears in list', () => {
      registry.register(GMAIL_MESSAGE);
      registry.setEnabled('gmail-message', false);
      const all = registry.list();
      expect(all).toHaveLength(1);
      expect(all[0].enabled).toBe(false);
    });
  });

  // --- cross-cutting: enabled filtering asymmetry ---

  describe('enabled filtering asymmetry', () => {
    it('findBySource filters disabled; findByConnector does not; hasTransformation delegates to findBySource', () => {
      registry.register(GMAIL_MESSAGE);
      registry.setEnabled('gmail-message', false);

      // findBySource excludes disabled
      expect(registry.findBySource('gmail' as ConnectorType, 'message')).toHaveLength(0);
      // findByConnector includes disabled
      expect(registry.findByConnector('gmail' as ConnectorType)).toHaveLength(1);
      // hasTransformation follows findBySource
      expect(registry.hasTransformation('gmail' as ConnectorType, 'message')).toBe(false);
    });
  });
});
