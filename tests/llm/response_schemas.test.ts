import { describe, it, expect } from 'vitest';
import { parseApiErrorResponse, formatApiError } from 'llm/response_schemas.js';
import type { ParsedApiError } from 'llm/response_schemas.js';

// =====================================================================
// parseApiErrorResponse
// =====================================================================
describe('parseApiErrorResponse', () => {
  // ─── OpenAI format ──────────────────────────────────────────────
  describe('OpenAI error format', () => {
    it('parses a full OpenAI error with all fields', () => {
      const body = JSON.stringify({
        error: {
          message: 'Rate limit exceeded',
          type: 'tokens',
          code: 'rate_limit_exceeded',
          param: 'max_tokens',
        },
      });
      const result = parseApiErrorResponse('openai', 429, body);
      expect(result.provider).toBe('openai');
      expect(result.message).toBe('Rate limit exceeded');
      expect(result.type).toBe('tokens');
      expect(result.code).toBe('rate_limit_exceeded');
      expect(result.param).toBe('max_tokens');
    });

    it('parses an OpenAI error with only message', () => {
      const body = JSON.stringify({
        error: { message: 'Something went wrong' },
      });
      const result = parseApiErrorResponse('openai', 500, body);
      expect(result.provider).toBe('openai');
      expect(result.message).toBe('Something went wrong');
      expect(result.type).toBeUndefined();
      expect(result.code).toBeUndefined();
      expect(result.param).toBeUndefined();
    });

    it('converts null param to undefined', () => {
      const body = JSON.stringify({
        error: { message: 'Bad param', param: null },
      });
      const result = parseApiErrorResponse('openai', 400, body);
      expect(result.provider).toBe('openai');
      expect(result.param).toBeUndefined();
    });

    it('handles OpenAI error with optional type and code present', () => {
      const body = JSON.stringify({
        error: { message: 'Invalid model', type: 'invalid_request_error', code: 'model_not_found' },
      });
      const result = parseApiErrorResponse('openai', 404, body);
      expect(result.provider).toBe('openai');
      expect(result.type).toBe('invalid_request_error');
      expect(result.code).toBe('model_not_found');
      expect(result.param).toBeUndefined();
    });
  });

  // ─── Anthropic format ───────────────────────────────────────────
  describe('Anthropic error format', () => {
    it('OpenAI schema matches first even for Anthropic-shaped errors (both have error.message)', () => {
      // The OpenAI schema requires only error.message, so it always matches
      // before the Anthropic schema when error.message is present.
      const body = JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      });
      const result = parseApiErrorResponse('anthropic', 529, body);
      expect(result.provider).toBe('openai');
      expect(result.message).toBe('Overloaded');
    });

    it('parses an Anthropic error without top-level type', () => {
      const body = JSON.stringify({
        error: { type: 'authentication_error', message: 'Invalid API key' },
      });
      // AnthropicErrorSchema has type as optional at top level, but error.type is required
      // However, OpenAI schema also matches if error has message — check priority
      // OpenAI is tried first; OpenAI schema requires error.message (string) which matches.
      // So this will match OpenAI first.
      const result = parseApiErrorResponse('anthropic', 401, body);
      // OpenAI schema matches first because it only requires error.message
      expect(result.provider).toBe('openai');
      expect(result.message).toBe('Invalid API key');
    });

    it('parses an Anthropic error with both top-level type and error.type', () => {
      const body = JSON.stringify({
        type: 'error',
        error: { type: 'not_found_error', message: 'Model not found' },
      });
      // OpenAI schema will also match since error.message is present.
      // OpenAI is tried first.
      const result = parseApiErrorResponse('anthropic', 404, body);
      // OpenAI matches first (it requires error.message, which is present)
      expect(result.provider).toBe('openai');
      expect(result.message).toBe('Model not found');
    });
  });

  // ─── Anthropic-only matches (error without string message won't match OpenAI) ──
  describe('Anthropic-only parsing (OpenAI schema fails)', () => {
    // To reach the Anthropic branch, the body must fail OpenAI parsing.
    // OpenAI requires error.message as string. If we craft something that
    // has error.type and error.message but also has fields that make
    // OpenAI schema fail... Actually OpenAI schema uses z.object with no
    // strict mode, so extra keys are fine. The real way to hit Anthropic
    // is if OpenAI schema parse fails, which happens when error.message
    // is missing from OpenAI perspective but error has type+message for
    // Anthropic. Since both have error.message, OpenAI will always match
    // first. This is by design — OpenAI format is the superset check.
    //
    // We verify this intentional priority ordering:
    it('OpenAI schema always wins when error.message is a string', () => {
      const body = JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'Too many requests' },
      });
      const result = parseApiErrorResponse('anthropic', 429, body);
      expect(result.provider).toBe('openai');
    });
  });

  // ─── Generic format ─────────────────────────────────────────────
  describe('Generic error format', () => {
    it('parses a top-level message field', () => {
      const body = JSON.stringify({ message: 'Service unavailable' });
      const result = parseApiErrorResponse('unknown', 503, body);
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('Service unavailable');
      expect(result.type).toBeUndefined();
      expect(result.code).toBeUndefined();
    });

    it('falls back to generic when error field is not an object', () => {
      const body = JSON.stringify({ error: 'just a string', message: 'fallback msg' });
      const result = parseApiErrorResponse('openai', 500, body);
      // OpenAI schema fails (error is string, not object)
      // Anthropic schema fails (error is string, not object)
      // Generic schema matches (top-level message is string)
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('fallback msg');
    });
  });

  // ─── JSON fallback (no schema matches) ──────────────────────────
  describe('JSON fallback', () => {
    it('stringifies JSON when no schema matches', () => {
      const body = JSON.stringify({ code: 42, status: 'failed' });
      const result = parseApiErrorResponse('openai', 500, body);
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe(JSON.stringify({ code: 42, status: 'failed' }));
    });

    it('truncates stringified JSON at 500 characters', () => {
      const longValue = 'x'.repeat(600);
      const body = JSON.stringify({ data: longValue });
      const result = parseApiErrorResponse('openai', 500, body);
      expect(result.provider).toBe('unknown');
      expect(result.message.length).toBeLessThanOrEqual(500);
    });

    it('handles JSON arrays as fallback', () => {
      const body = JSON.stringify([1, 2, 3]);
      const result = parseApiErrorResponse('openai', 500, body);
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('[1,2,3]');
    });

    it('handles JSON null as fallback', () => {
      const body = 'null';
      const result = parseApiErrorResponse('openai', 500, body);
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('null');
    });

    it('handles JSON number as fallback', () => {
      const body = '42';
      const result = parseApiErrorResponse('openai', 500, body);
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('42');
    });

    it('handles JSON boolean as fallback', () => {
      const body = 'true';
      const result = parseApiErrorResponse('openai', 500, body);
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('true');
    });

    it('handles JSON string as fallback', () => {
      const body = '"just a string"';
      const result = parseApiErrorResponse('openai', 500, body);
      // JSON.parse produces a string, no schema matches
      // JSON.stringify of a string wraps in quotes
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('"just a string"');
    });

    it('handles deeply nested JSON with no matching schema', () => {
      const body = JSON.stringify({ a: { b: { c: { d: 'deep' } } } });
      const result = parseApiErrorResponse('openai', 500, body);
      expect(result.provider).toBe('unknown');
      expect(result.message).toContain('deep');
    });
  });

  // ─── Invalid JSON fallback ─────────────────────────────────────
  describe('invalid JSON (raw text)', () => {
    it('returns raw text for non-JSON responses', () => {
      const result = parseApiErrorResponse('openai', 502, 'Bad Gateway');
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('Bad Gateway');
    });

    it('returns raw text for HTML error pages', () => {
      const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';
      const result = parseApiErrorResponse('openai', 502, html);
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe(html);
    });

    it('truncates raw text at 500 characters', () => {
      const longText = 'a'.repeat(600);
      const result = parseApiErrorResponse('openai', 500, longText);
      expect(result.provider).toBe('unknown');
      expect(result.message.length).toBe(503); // 500 chars + '...'
      expect(result.message.endsWith('...')).toBe(true);
    });

    it('does not add ellipsis when raw text is exactly 500 chars', () => {
      const text = 'b'.repeat(500);
      const result = parseApiErrorResponse('openai', 500, text);
      expect(result.message).toBe(text);
      expect(result.message.length).toBe(500);
    });

    it('returns empty string for empty responseText', () => {
      const result = parseApiErrorResponse('openai', 500, '');
      // Empty string is not valid JSON, goes to catch block
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('');
    });

    it('returns raw text for partial JSON', () => {
      const result = parseApiErrorResponse('openai', 500, '{"error":');
      expect(result.provider).toBe('unknown');
      expect(result.message).toBe('{"error":');
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────
  describe('edge cases', () => {
    it('provider argument does not affect parsing logic', () => {
      const body = JSON.stringify({ error: { message: 'test' } });
      const asOpenai = parseApiErrorResponse('openai', 400, body);
      const asAnthropic = parseApiErrorResponse('anthropic', 400, body);
      const asCustom = parseApiErrorResponse('my-provider', 400, body);
      // All parse identically — provider param is informational only
      expect(asOpenai.provider).toBe('openai');
      expect(asAnthropic.provider).toBe('openai');
      expect(asCustom.provider).toBe('openai');
    });

    it('status does not affect parsing logic', () => {
      const body = JSON.stringify({ error: { message: 'err' } });
      const r200 = parseApiErrorResponse('x', 200, body);
      const r500 = parseApiErrorResponse('x', 500, body);
      expect(r200.message).toBe(r500.message);
      expect(r200.provider).toBe(r500.provider);
    });

    it('handles error.message with special characters', () => {
      const body = JSON.stringify({
        error: { message: 'Line1\nLine2\t"quoted"' },
      });
      const result = parseApiErrorResponse('openai', 400, body);
      expect(result.message).toBe('Line1\nLine2\t"quoted"');
    });

    it('handles error.message that is an empty string', () => {
      const body = JSON.stringify({ error: { message: '' } });
      const result = parseApiErrorResponse('openai', 400, body);
      expect(result.provider).toBe('openai');
      expect(result.message).toBe('');
    });

    it('handles unicode in error messages', () => {
      const body = JSON.stringify({ error: { message: 'Erreur: données invalides \u2014 réessayez' } });
      const result = parseApiErrorResponse('openai', 400, body);
      expect(result.message).toContain('données invalides');
    });
  });
});

// =====================================================================
// formatApiError
// =====================================================================
describe('formatApiError', () => {
  // ─── happy paths ────────────────────────────────────────────────
  it('formats a full error with type, code, and param', () => {
    const parsed: ParsedApiError = {
      message: 'Rate limit exceeded',
      type: 'tokens',
      code: 'rate_limit_exceeded',
      param: 'max_tokens',
      provider: 'openai',
    };
    const err = formatApiError('openai', 429, parsed);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('openai API error 429: Rate limit exceeded (type=tokens, code=rate_limit_exceeded, param=max_tokens)');
  });

  it('formats an error with only type', () => {
    const parsed: ParsedApiError = {
      message: 'Overloaded',
      type: 'overloaded_error',
      provider: 'anthropic',
    };
    const err = formatApiError('anthropic', 529, parsed);
    expect(err.message).toBe('anthropic API error 529: Overloaded (type=overloaded_error)');
  });

  it('formats an error with only code', () => {
    const parsed: ParsedApiError = {
      message: 'Invalid key',
      code: 'invalid_api_key',
      provider: 'openai',
    };
    const err = formatApiError('openai', 401, parsed);
    expect(err.message).toBe('openai API error 401: Invalid key (code=invalid_api_key)');
  });

  it('formats an error with only param', () => {
    const parsed: ParsedApiError = {
      message: 'Bad param',
      param: 'temperature',
      provider: 'openai',
    };
    const err = formatApiError('openai', 400, parsed);
    expect(err.message).toBe('openai API error 400: Bad param (param=temperature)');
  });

  it('formats an error with no detail fields (no parenthetical)', () => {
    const parsed: ParsedApiError = {
      message: 'Unknown error',
      provider: 'unknown',
    };
    const err = formatApiError('unknown', 500, parsed);
    expect(err.message).toBe('unknown API error 500: Unknown error');
    expect(err.message).not.toContain('(');
  });

  it('uses the provider argument for formatting, not parsed.provider', () => {
    const parsed: ParsedApiError = {
      message: 'test',
      provider: 'openai',
    };
    const err = formatApiError('my-custom-provider', 418, parsed);
    expect(err.message).toMatch(/^my-custom-provider API error 418:/);
  });

  it('formats with type and code but no param', () => {
    const parsed: ParsedApiError = {
      message: 'Model not found',
      type: 'invalid_request_error',
      code: 'model_not_found',
      provider: 'openai',
    };
    const err = formatApiError('openai', 404, parsed);
    expect(err.message).toBe('openai API error 404: Model not found (type=invalid_request_error, code=model_not_found)');
  });

  // ─── sad / edge paths ──────────────────────────────────────────
  it('handles an empty message', () => {
    const parsed: ParsedApiError = {
      message: '',
      provider: 'unknown',
    };
    const err = formatApiError('openai', 500, parsed);
    expect(err.message).toBe('openai API error 500: ');
  });

  it('handles a very long message', () => {
    const longMsg = 'Z'.repeat(2000);
    const parsed: ParsedApiError = { message: longMsg, provider: 'unknown' };
    const err = formatApiError('openai', 500, parsed);
    expect(err.message).toContain(longMsg);
    expect(err).toBeInstanceOf(Error);
  });

  it('handles status 0', () => {
    const parsed: ParsedApiError = { message: 'Network error', provider: 'unknown' };
    const err = formatApiError('openai', 0, parsed);
    expect(err.message).toBe('openai API error 0: Network error');
  });

  it('skips falsy detail fields from parenthetical', () => {
    const parsed: ParsedApiError = {
      message: 'err',
      type: undefined,
      code: undefined,
      param: undefined,
      provider: 'unknown',
    };
    const err = formatApiError('x', 400, parsed);
    expect(err.message).toBe('x API error 400: err');
    expect(err.message).not.toContain('(');
  });

  it('skips empty-string detail fields from parenthetical', () => {
    const parsed: ParsedApiError = {
      message: 'err',
      type: '',
      code: '',
      param: '',
      provider: 'unknown',
    };
    const err = formatApiError('x', 400, parsed);
    // Empty strings are falsy, filtered out
    expect(err.message).toBe('x API error 400: err');
  });

  it('returns an Error instance that can be thrown', () => {
    const parsed: ParsedApiError = { message: 'fail', provider: 'openai' };
    const err = formatApiError('openai', 500, parsed);
    expect(() => { throw err; }).toThrow('fail');
  });
});

// =====================================================================
// Integration: parseApiErrorResponse → formatApiError
// =====================================================================
describe('parse → format integration', () => {
  it('round-trips an OpenAI error', () => {
    const body = JSON.stringify({
      error: { message: 'ctx too long', type: 'invalid_request_error', code: 'context_length_exceeded' },
    });
    const parsed = parseApiErrorResponse('openai', 400, body);
    const err = formatApiError('openai', 400, parsed);
    expect(err.message).toBe('openai API error 400: ctx too long (type=invalid_request_error, code=context_length_exceeded)');
  });

  it('round-trips an invalid-JSON response', () => {
    const parsed = parseApiErrorResponse('anthropic', 502, '<nginx>error</nginx>');
    const err = formatApiError('anthropic', 502, parsed);
    expect(err.message).toBe('anthropic API error 502: <nginx>error</nginx>');
  });

  it('round-trips a generic error', () => {
    const body = JSON.stringify({ message: 'quota exceeded' });
    const parsed = parseApiErrorResponse('openai', 429, body);
    const err = formatApiError('openai', 429, parsed);
    expect(err.message).toBe('openai API error 429: quota exceeded');
  });
});
