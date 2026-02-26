/**
 * Tests for rate limit header parsing and classification.
 *
 * Covers: parseRateLimitHeaders, classifyRateLimitType, createRateLimitError
 * across OpenAI, Anthropic, and Cerebras header formats.
 */

import {
  parseRateLimitHeaders,
  classifyRateLimitType,
  createRateLimitError,
} from 'llm/rate-limits.js';
import { RateLimitError } from 'llm/policies.js';

function makeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

// =========================================================================
// parseRateLimitHeaders
// =========================================================================

describe('parseRateLimitHeaders', () => {
  it('returns empty result for no rate limit headers', () => {
    const result = parseRateLimitHeaders(makeHeaders({}));
    expect(result).toEqual({});
  });

  // --- retry-after (standard) ---

  it('parses standard retry-after header (seconds)', () => {
    const result = parseRateLimitHeaders(makeHeaders({ 'retry-after': '30' }));
    expect(result.retryAfterMs).toBe(30_000);
  });

  it('ignores non-numeric retry-after', () => {
    const result = parseRateLimitHeaders(makeHeaders({ 'retry-after': 'invalid' }));
    expect(result.retryAfterMs).toBeUndefined();
  });

  // --- Cerebras x-ratelimit-reset-ms ---

  it('parses Cerebras x-ratelimit-reset-ms header', () => {
    const result = parseRateLimitHeaders(makeHeaders({ 'x-ratelimit-reset-ms': '1500' }));
    expect(result.retryAfterMs).toBe(1500);
  });

  it('x-ratelimit-reset-ms takes priority over reset-requests/tokens', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-reset-ms': '500',
      'x-ratelimit-reset-requests': '10s',
      'x-ratelimit-reset-tokens': '5s',
    }));
    expect(result.retryAfterMs).toBe(500);
  });

  // --- OpenAI/Anthropic duration strings ---

  it('parses "Ns" second duration', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-reset-requests': '5s',
    }));
    expect(result.retryAfterMs).toBe(5_000);
  });

  it('parses "Nms" millisecond duration', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-reset-tokens': '750ms',
    }));
    expect(result.retryAfterMs).toBe(750);
  });

  it('parses "Nm" minute duration', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-reset-requests': '2m',
    }));
    expect(result.retryAfterMs).toBe(120_000);
  });

  it('uses the longer of requests and tokens waits', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-reset-requests': '2s',
      'x-ratelimit-reset-tokens': '10s',
    }));
    expect(result.retryAfterMs).toBe(10_000);
  });

  it('parses numeric seconds (float)', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-reset-requests': '1.5',
    }));
    expect(result.retryAfterMs).toBe(1500);
  });

  // --- Remaining counts ---

  it('parses remaining requests', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-remaining-requests': '42',
    }));
    expect(result.remaining).toBe(42);
    expect(result.limitType).toBe('requests');
  });

  it('parses remaining tokens', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-remaining-tokens': '1000',
    }));
    expect(result.remaining).toBe(1000);
    expect(result.limitType).toBe('tokens');
  });

  it('tokens override requests when tokens remaining is lower', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-remaining-requests': '100',
      'x-ratelimit-remaining-tokens': '5',
    }));
    expect(result.remaining).toBe(5);
    expect(result.limitType).toBe('tokens');
  });

  it('requests remain when tokens remaining is higher', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-remaining-requests': '3',
      'x-ratelimit-remaining-tokens': '5000',
    }));
    expect(result.remaining).toBe(3);
    expect(result.limitType).toBe('requests');
  });

  it('ignores non-numeric remaining headers', () => {
    const result = parseRateLimitHeaders(makeHeaders({
      'x-ratelimit-remaining-requests': 'many',
    }));
    expect(result.remaining).toBeUndefined();
  });
});

// =========================================================================
// classifyRateLimitType
// =========================================================================

describe('classifyRateLimitType', () => {
  // Billing
  it('classifies billing errors', () => {
    expect(classifyRateLimitType('Your billing plan has expired')).toBe('billing');
    expect(classifyRateLimitType('Payment required')).toBe('billing');
    expect(classifyRateLimitType('Insufficient credits')).toBe('billing');
    expect(classifyRateLimitType('Invalid subscription')).toBe('billing');
    expect(classifyRateLimitType('No credit remaining')).toBe('billing');
  });

  // Quota
  it('classifies quota exhaustion errors', () => {
    expect(classifyRateLimitType('You have exceeded your daily quota')).toBe('quota');
    expect(classifyRateLimitType('Monthly quota reached')).toBe('quota');
    expect(classifyRateLimitType('Weekly limit exceeded')).toBe('quota');
    expect(classifyRateLimitType('exceeded your API usage')).toBe('quota');
  });

  // Window (rate limit)
  it('classifies window rate limits', () => {
    expect(classifyRateLimitType('Rate limit exceeded', 5000)).toBe('window');
    expect(classifyRateLimitType('Too many requests')).toBe('window');
    expect(classifyRateLimitType('requests per minute exceeded')).toBe('window');
    expect(classifyRateLimitType('tokens per minute exceeded')).toBe('window');
  });

  it('classifies rate limit with long retry-after as window', () => {
    // Even with long retry-after, generic rate limit still classifies as window
    expect(classifyRateLimitType('Rate limit exceeded', 300_000)).toBe('window');
  });

  // Unknown
  it('returns unknown for unrecognized errors', () => {
    expect(classifyRateLimitType('Something went wrong')).toBe('unknown');
    expect(classifyRateLimitType('Internal server error')).toBe('unknown');
  });

  // Case insensitivity
  it('is case-insensitive', () => {
    expect(classifyRateLimitType('RATE LIMIT EXCEEDED')).toBe('window');
    expect(classifyRateLimitType('BILLING ISSUE')).toBe('billing');
    expect(classifyRateLimitType('DAILY QUOTA REACHED')).toBe('quota');
  });
});

// =========================================================================
// createRateLimitError
// =========================================================================

describe('createRateLimitError', () => {
  it('creates a RateLimitError with parsed headers and JSON body', () => {
    const headers = makeHeaders({
      'retry-after': '10',
      'x-ratelimit-remaining-requests': '0',
    });
    const body = JSON.stringify({ error: { message: 'Rate limit exceeded' } });

    const error = createRateLimitError('openai', 'gpt-4', 429, headers, body);

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.message).toContain('openai');
    expect(error.message).toContain('Rate limit exceeded');
    expect(error.info.type).toBe('window');
    expect(error.info.retryAfterMs).toBe(10_000);
    expect(error.info.remaining).toBe(0);
    expect(error.provider).toBe('openai');
    expect(error.model).toBe('gpt-4');
    expect(error.status).toBe(429);
  });

  it('handles plain text response body', () => {
    const headers = makeHeaders({});
    const error = createRateLimitError('anthropic', 'claude-3', 429, headers, 'Too many requests');

    expect(error.info.message).toBe('Too many requests');
    expect(error.info.type).toBe('window');
  });

  it('handles malformed JSON body gracefully', () => {
    const headers = makeHeaders({});
    const error = createRateLimitError('provider', 'model', 429, headers, '{invalid json');

    expect(error.info.message).toBe('{invalid json');
  });

  it('extracts nested error.message from OpenAI format', () => {
    const body = JSON.stringify({
      error: { message: 'You exceeded your current quota', type: 'insufficient_quota' },
    });
    const error = createRateLimitError('openai', 'gpt-4', 429, makeHeaders({}), body);
    expect(error.info.type).toBe('quota');
    expect(error.info.message).toContain('exceeded your current quota');
  });

  it('extracts top-level message from Anthropic format', () => {
    const body = JSON.stringify({ message: 'Rate limit reached for requests per minute' });
    const error = createRateLimitError('anthropic', 'claude-3', 429, makeHeaders({}), body);
    expect(error.info.type).toBe('window');
  });

  it('includes display wait time in error message', () => {
    const headers = makeHeaders({ 'retry-after': '5' });
    const error = createRateLimitError('openai', 'gpt-4', 429, headers, 'Too many requests');
    expect(error.message).toContain('retry after 5s');
  });

  it('omits display wait time when no retry-after', () => {
    const error = createRateLimitError('openai', 'gpt-4', 429, makeHeaders({}), 'Too many requests');
    expect(error.message).not.toContain('retry after');
  });
});
