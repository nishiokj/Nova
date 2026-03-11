/**
 * Behavioral tests for LLM provider internal types.
 *
 * Covers:
 * - toLLMExecutionError: coercion of unknown errors into typed LLMExecutionError
 * - PartialStreamError: construction and static guard
 * - inferExecutionErrorType: implicit via toLLMExecutionError output
 */

import { describe, it, expect } from 'vitest';
import { toLLMExecutionError, PartialStreamError } from 'llm/providers/types.js';

// ============================================
// PartialStreamError
// ============================================

describe('PartialStreamError', () => {
  describe('construction', () => {
    it('stores partial content and cause', () => {
      const cause = new Error('network reset');
      const err = new PartialStreamError('stream failed', cause, 'partial output');

      expect(err.partialContent).toBe('partial output');
      expect(err.cause).toBe(cause);
      expect(err.name).toBe('PartialStreamError');
    });

    it('composes message from description and cause message', () => {
      const cause = new Error('ECONNRESET');
      const err = new PartialStreamError('mid-stream', cause, '');

      expect(err.message).toBe('mid-stream: ECONNRESET');
    });

    it('defaults partialToolCalls to empty array', () => {
      const err = new PartialStreamError('x', new Error('y'), 'z');
      expect(err.partialToolCalls).toEqual([]);
    });

    it('stores provided partialToolCalls', () => {
      const calls = [{ id: 'c1', name: 'Read', arguments: '{}' }];
      const err = new PartialStreamError('x', new Error('y'), 'z', calls);

      expect(err.partialToolCalls).toHaveLength(1);
      expect(err.partialToolCalls[0].name).toBe('Read');
    });

    it('is an instance of Error', () => {
      const err = new PartialStreamError('x', new Error('y'), 'z');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('hasPartialContent static guard', () => {
    it('returns true when partialContent is non-empty', () => {
      const err = new PartialStreamError('x', new Error('y'), 'some content');
      expect(PartialStreamError.hasPartialContent(err)).toBe(true);
    });

    it('returns false when partialContent is empty string', () => {
      const err = new PartialStreamError('x', new Error('y'), '');
      expect(PartialStreamError.hasPartialContent(err)).toBe(false);
    });

    it('returns false for plain Error', () => {
      expect(PartialStreamError.hasPartialContent(new Error('nope'))).toBe(false);
    });

    it('returns false for null', () => {
      expect(PartialStreamError.hasPartialContent(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(PartialStreamError.hasPartialContent(undefined)).toBe(false);
    });

    it('returns false for string', () => {
      expect(PartialStreamError.hasPartialContent('not an error')).toBe(false);
    });

    it('returns false for plain object that looks like PartialStreamError', () => {
      const fake = { partialContent: 'content', name: 'PartialStreamError' };
      expect(PartialStreamError.hasPartialContent(fake)).toBe(false);
    });
  });
});

// ============================================
// toLLMExecutionError
// ============================================

describe('toLLMExecutionError', () => {
  const PROVIDER = 'openai';
  const MODEL = 'gpt-4';

  describe('already-typed errors (objects with type + message)', () => {
    it('returns the object as-is without modification', () => {
      const existing = {
        type: 'timeout' as const,
        message: 'request timed out',
        metadata: { provider: 'anthropic', model: 'claude-3' },
      };
      const result = toLLMExecutionError(existing, PROVIDER, MODEL);

      expect(result).toBe(existing); // identity
      expect(result.type).toBe('timeout');
      expect(result.metadata).toEqual({ provider: 'anthropic', model: 'claude-3' });
    });

    it('does not overwrite the existing type with inferred type', () => {
      const existing = { type: 'schema_error' as const, message: 'bad schema' };
      const result = toLLMExecutionError(existing, PROVIDER, MODEL);

      expect(result.type).toBe('schema_error');
    });

    it('does not inject provider/model metadata into pre-typed errors', () => {
      const existing = { type: 'cancelled' as const, message: 'aborted' };
      const result = toLLMExecutionError(existing, PROVIDER, MODEL);

      expect(result.metadata).toBeUndefined();
    });

    it('preserves cause on pre-typed errors', () => {
      const cause = new Error('root');
      const existing = { type: 'provider_error' as const, message: 'fail', cause };
      const result = toLLMExecutionError(existing, PROVIDER, MODEL);

      expect(result.cause).toBe(cause);
    });
  });

  describe('Error instances - type inference via inferExecutionErrorType', () => {
    it('infers provider_error from PartialStreamError', () => {
      const pse = new PartialStreamError('stream broke', new Error('net'), 'partial');
      const result = toLLMExecutionError(pse, PROVIDER, MODEL);

      expect(result.type).toBe('provider_error');
    });

    it('infers cancelled from AbortError', () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      expect(result.type).toBe('cancelled');
    });

    it('infers timeout from TimeoutError', () => {
      const err = new DOMException('The operation timed out', 'TimeoutError');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      expect(result.type).toBe('timeout');
    });

    it('infers cancelled when message includes "cancel"', () => {
      const err = new Error('Request was cancelled by the user');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      expect(result.type).toBe('cancelled');
    });

    it('infers cancelled case-insensitively (message lowercased)', () => {
      const err = new Error('CANCELLED due to policy');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      expect(result.type).toBe('cancelled');
    });

    it('infers timeout when message includes "timeout"', () => {
      const err = new Error('Connection timeout after 30s');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      expect(result.type).toBe('timeout');
    });

    it('infers timeout case-insensitively', () => {
      const err = new Error('TIMEOUT EXCEEDED');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      expect(result.type).toBe('timeout');
    });

    it('falls back to unknown for generic errors', () => {
      const err = new Error('something went wrong');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      expect(result.type).toBe('unknown');
    });

    it('decorates error with provider and model metadata', () => {
      const err = new Error('generic');
      const result = toLLMExecutionError(err, 'anthropic', 'claude-3-opus');

      expect(result.metadata).toEqual({ provider: 'anthropic', model: 'claude-3-opus' });
    });

    it('preserves the original error message', () => {
      const err = new Error('specific failure details');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      expect(result.message).toBe('specific failure details');
    });

    it('does not overwrite existing type on a decorated Error', () => {
      // Simulate an Error that already has .type set (e.g., from a previous call)
      const err = new Error('already typed') as Error & { type: string };
      err.type = 'schema_error';
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      // Has type + message -> passes the first guard, returns as-is
      expect(result.type).toBe('schema_error');
    });

    it('does not overwrite existing metadata on a decorated Error', () => {
      const err = new Error('has meta') as Error & { metadata: Record<string, unknown> };
      err.metadata = { custom: true };
      // This error has no 'type' in its own properties, so goes through Error branch
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      // ??= won't overwrite existing metadata
      expect(result.metadata).toEqual({ custom: true });
    });
  });

  describe('PartialStreamError priority over message heuristics', () => {
    it('classifies as provider_error even if message contains "cancel"', () => {
      const cause = new Error('cancel');
      const pse = new PartialStreamError('cancelled mid-stream', cause, 'data');
      const result = toLLMExecutionError(pse, PROVIDER, MODEL);

      // PartialStreamError check comes first in inferExecutionErrorType
      expect(result.type).toBe('provider_error');
    });

    it('classifies as provider_error even if message contains "timeout"', () => {
      const cause = new Error('timeout');
      const pse = new PartialStreamError('timeout during stream', cause, 'data');
      const result = toLLMExecutionError(pse, PROVIDER, MODEL);

      expect(result.type).toBe('provider_error');
    });
  });

  describe('AbortError vs cancel-in-message precedence', () => {
    it('AbortError name takes precedence over message content', () => {
      const err = new DOMException('timeout happened', 'AbortError');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      // name === 'AbortError' check runs before message heuristic
      expect(result.type).toBe('cancelled');
    });
  });

  describe('primitive and exotic values (fallback branch)', () => {
    it('wraps a string into an LLMExecutionError', () => {
      const result = toLLMExecutionError('raw error string', PROVIDER, MODEL);

      expect(result.type).toBe('unknown');
      expect(result.message).toBe('raw error string');
      expect(result.cause).toBe('raw error string');
      expect(result.metadata).toEqual({ provider: PROVIDER, model: MODEL });
    });

    it('wraps a number', () => {
      const result = toLLMExecutionError(500, PROVIDER, MODEL);

      expect(result.message).toBe('500');
      expect(result.cause).toBe(500);
    });

    it('wraps null', () => {
      const result = toLLMExecutionError(null, PROVIDER, MODEL);

      expect(result.message).toBe('null');
      expect(result.cause).toBeNull();
    });

    it('wraps undefined', () => {
      const result = toLLMExecutionError(undefined, PROVIDER, MODEL);

      expect(result.message).toBe('undefined');
      expect(result.cause).toBeUndefined();
    });

    it('wraps boolean', () => {
      const result = toLLMExecutionError(false, PROVIDER, MODEL);

      expect(result.message).toBe('false');
      expect(result.type).toBe('unknown');
    });

    it('wraps object without type/message', () => {
      const obj = { code: 429, detail: 'rate limited' };
      const result = toLLMExecutionError(obj, PROVIDER, MODEL);

      expect(result.type).toBe('unknown');
      expect(result.message).toBe(String(obj));
      expect(result.cause).toBe(obj);
    });

    it('treats object with only type (no message) as non-typed', () => {
      const partial = { type: 'timeout' };
      const result = toLLMExecutionError(partial, PROVIDER, MODEL);

      // 'message' not in partial -> falls to primitive branch
      expect(result.type).toBe('unknown');
      expect(result.cause).toBe(partial);
    });

    it('treats object with only message (no type) as non-typed', () => {
      const partial = { message: 'bad' };
      const result = toLLMExecutionError(partial, PROVIDER, MODEL);

      expect(result.type).toBe('unknown');
      expect(result.cause).toBe(partial);
    });
  });

  describe('mutation behavior on Error instances', () => {
    it('mutates the original Error object (decorates in-place)', () => {
      const err = new Error('mutated');
      const result = toLLMExecutionError(err, PROVIDER, MODEL);

      // The implementation uses ??= which modifies the error in-place
      expect((err as any).type).toBeDefined();
      expect((err as any).metadata).toBeDefined();
      // Return value is the same object (cast)
      expect(result.message).toBe('mutated');
    });

    it('second call with different provider does NOT overwrite first decoration', () => {
      const err = new Error('reused');
      toLLMExecutionError(err, 'openai', 'gpt-4');
      const result = toLLMExecutionError(err, 'anthropic', 'claude-3');

      // ??= means first write wins
      expect(result.metadata).toEqual({ provider: 'openai', model: 'gpt-4' });
    });

    it('second call does not change type either', () => {
      const err = new Error('Operation was cancelled');
      toLLMExecutionError(err, 'openai', 'gpt-4');

      // Now manually set type to something else, then call again
      // ??= means the first inferred type sticks
      const result = toLLMExecutionError(err, 'anthropic', 'claude-3');
      expect(result.type).toBe('cancelled');
    });
  });
});
