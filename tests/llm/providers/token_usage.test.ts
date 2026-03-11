import { describe, it, expect } from 'vitest';
import { normalizeResponsesApiUsage, normalizeChatCompletionsUsage } from 'llm/providers/token_usage.js';

const ZEROS = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

// ─── helpers ────────────────────────────────────────────────────────
function expectZeros(result: ReturnType<typeof normalizeResponsesApiUsage>) {
  expect(result.promptTokens).toBe(0);
  expect(result.completionTokens).toBe(0);
  expect(result.totalTokens).toBe(0);
  expect(result.cachedTokens).toBeUndefined();
  expect(result.reasoningTokens).toBeUndefined();
}

// =====================================================================
// normalizeResponsesApiUsage  (Responses API keys: input_tokens, output_tokens)
// =====================================================================
describe('normalizeResponsesApiUsage', () => {
  // ─── happy paths ────────────────────────────────────────────────
  it('returns standard token counts from a well-formed usage object', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
    expect(result).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedTokens: undefined,
      reasoningTokens: undefined,
    });
  });

  it('computes totalTokens when total_tokens is absent', () => {
    const result = normalizeResponsesApiUsage({ input_tokens: 80, output_tokens: 20 });
    expect(result.totalTokens).toBe(100);
  });

  it('uses explicit total_tokens even when it disagrees with sum', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 999,
    });
    expect(result.totalTokens).toBe(999);
  });

  it('parses numeric strings for all token fields', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: '200',
      output_tokens: '100',
      total_tokens: '300',
    });
    expect(result.promptTokens).toBe(200);
    expect(result.completionTokens).toBe(100);
    expect(result.totalTokens).toBe(300);
  });

  it('parses numeric strings with whitespace', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: '  42  ',
      output_tokens: '  8  ',
    });
    expect(result.promptTokens).toBe(42);
    expect(result.completionTokens).toBe(8);
    expect(result.totalTokens).toBe(50);
  });

  it('extracts reasoning_tokens from top-level key', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 3,
    });
    expect(result.reasoningTokens).toBe(3);
  });

  it('extracts reasoningTokens from camelCase top-level key', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      reasoningTokens: 7,
    });
    expect(result.reasoningTokens).toBe(7);
  });

  it('extracts reasoning_tokens from completion_tokens_details', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 2 },
    });
    expect(result.reasoningTokens).toBe(2);
  });

  it('extracts reasoningTokens (camelCase) from completion_tokens_details', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      completion_tokens_details: { reasoningTokens: 11 },
    });
    expect(result.reasoningTokens).toBe(11);
  });

  it('extracts reasoning_tokens from output_tokens_details', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 4 },
    });
    expect(result.reasoningTokens).toBe(4);
  });

  it('extracts reasoningTokens (camelCase) from output_tokens_details', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      output_tokens_details: { reasoningTokens: 9 },
    });
    expect(result.reasoningTokens).toBe(9);
  });

  it('prefers top-level reasoning_tokens over nested variants', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 1,
      completion_tokens_details: { reasoning_tokens: 99 },
      output_tokens_details: { reasoning_tokens: 88 },
    });
    expect(result.reasoningTokens).toBe(1);
  });

  it('prefers top-level reasoning_tokens over camelCase reasoningTokens', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 5,
      reasoningTokens: 10,
    });
    expect(result.reasoningTokens).toBe(5);
  });

  it('extracts cachedTokens from prompt_tokens_details.cached_tokens', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 100,
      output_tokens: 50,
      prompt_tokens_details: { cached_tokens: 30 },
    });
    expect(result.cachedTokens).toBe(30);
  });

  it('extracts cachedTokens from prompt_tokens_details.cachedTokens (camelCase)', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 100,
      output_tokens: 50,
      prompt_tokens_details: { cachedTokens: 25 },
    });
    expect(result.cachedTokens).toBe(25);
  });

  it('prefers cached_tokens over cachedTokens in prompt_tokens_details', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 100,
      output_tokens: 50,
      prompt_tokens_details: { cached_tokens: 10, cachedTokens: 20 },
    });
    expect(result.cachedTokens).toBe(10);
  });

  it('handles a fully populated usage object', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 500,
      output_tokens: 250,
      total_tokens: 750,
      reasoning_tokens: 40,
      prompt_tokens_details: { cached_tokens: 100 },
    });
    expect(result).toEqual({
      promptTokens: 500,
      completionTokens: 250,
      totalTokens: 750,
      cachedTokens: 100,
      reasoningTokens: 40,
    });
  });

  it('handles zero values explicitly', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  // ─── sad paths ──────────────────────────────────────────────────
  it('returns zeros for undefined input', () => {
    expectZeros(normalizeResponsesApiUsage(undefined));
  });

  it('returns zeros for null input', () => {
    expectZeros(normalizeResponsesApiUsage(null));
  });

  it('returns zeros for a boolean input', () => {
    expectZeros(normalizeResponsesApiUsage(true));
  });

  it('returns zeros for a string input', () => {
    expectZeros(normalizeResponsesApiUsage('not an object'));
  });

  it('returns zeros for a number input', () => {
    expectZeros(normalizeResponsesApiUsage(42));
  });

  it('returns zeros for an empty object', () => {
    const result = normalizeResponsesApiUsage({});
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it('ignores ChatCompletions keys (prompt_tokens, completion_tokens)', () => {
    const result = normalizeResponsesApiUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
    });
    // These are wrong keys for Responses API
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('treats negative numbers as zero', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: -10,
      output_tokens: -5,
      total_tokens: -15,
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it('treats NaN as zero', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: NaN,
      output_tokens: NaN,
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('treats Infinity as zero', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: Infinity,
      output_tokens: -Infinity,
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('treats non-numeric strings as zero', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 'abc',
      output_tokens: 'xyz',
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('treats empty string as zero', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: '',
      output_tokens: '   ',
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('treats negative numeric strings as zero', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: '-10',
      output_tokens: '-5',
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('ignores non-object prompt_tokens_details', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      prompt_tokens_details: 'not an object',
    });
    expect(result.cachedTokens).toBeUndefined();
  });

  it('ignores non-object completion_tokens_details', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      completion_tokens_details: 42,
    });
    expect(result.reasoningTokens).toBeUndefined();
  });

  it('ignores non-object output_tokens_details', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: 10,
      output_tokens: 5,
      output_tokens_details: null,
    });
    expect(result.reasoningTokens).toBeUndefined();
  });

  it('ignores array input (arrays are objects but not UsageRecord-shaped)', () => {
    const result = normalizeResponsesApiUsage([1, 2, 3]);
    // Arrays are objects, so asRecord succeeds but keys won't match
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('treats object values (like nested objects) as zero for token keys', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: { nested: true },
      output_tokens: [1],
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('treats boolean token values as zero', () => {
    const result = normalizeResponsesApiUsage({
      input_tokens: true,
      output_tokens: false,
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });
});

// =====================================================================
// normalizeChatCompletionsUsage  (Chat Completions API keys: prompt_tokens, completion_tokens)
// =====================================================================
describe('normalizeChatCompletionsUsage', () => {
  // ─── happy paths ────────────────────────────────────────────────
  it('returns standard token counts from a well-formed usage object', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: 120,
      completion_tokens: 60,
      total_tokens: 180,
    });
    expect(result).toEqual({
      promptTokens: 120,
      completionTokens: 60,
      totalTokens: 180,
      cachedTokens: undefined,
      reasoningTokens: undefined,
    });
  });

  it('computes totalTokens when total_tokens is absent', () => {
    const result = normalizeChatCompletionsUsage({ prompt_tokens: 30, completion_tokens: 20 });
    expect(result.totalTokens).toBe(50);
  });

  it('uses explicit total_tokens even when it disagrees with sum', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 500,
    });
    expect(result.totalTokens).toBe(500);
  });

  it('parses numeric strings', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: '75',
      completion_tokens: '25',
      total_tokens: '100',
    });
    expect(result.promptTokens).toBe(75);
    expect(result.completionTokens).toBe(25);
    expect(result.totalTokens).toBe(100);
  });

  it('extracts reasoning_tokens from completion_tokens_details', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: 50,
      completion_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 10 },
    });
    expect(result.reasoningTokens).toBe(10);
  });

  it('extracts cachedTokens from prompt_tokens_details', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    expect(result.cachedTokens).toBe(40);
  });

  it('handles a fully populated ChatCompletions usage object', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: 400,
      completion_tokens: 200,
      total_tokens: 600,
      reasoning_tokens: 50,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 60 },
    });
    // Top-level reasoning_tokens takes priority
    expect(result.reasoningTokens).toBe(50);
    expect(result.cachedTokens).toBe(80);
    expect(result.totalTokens).toBe(600);
  });

  // ─── sad paths ──────────────────────────────────────────────────
  it('returns zeros for undefined input', () => {
    expectZeros(normalizeChatCompletionsUsage(undefined));
  });

  it('returns zeros for null input', () => {
    expectZeros(normalizeChatCompletionsUsage(null));
  });

  it('returns zeros for a number input', () => {
    expectZeros(normalizeChatCompletionsUsage(123));
  });

  it('ignores Responses API keys (input_tokens, output_tokens)', () => {
    const result = normalizeChatCompletionsUsage({
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('treats negative numbers as zero', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: -100,
      completion_tokens: -50,
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('treats NaN as zero', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: NaN,
      completion_tokens: NaN,
    });
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('computes totalTokens as 0 when all tokens are invalid', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: 'invalid',
      completion_tokens: null,
    });
    expect(result.totalTokens).toBe(0);
  });

  it('returns zeros for an empty object', () => {
    const result = normalizeChatCompletionsUsage({});
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it('ignores null prompt_tokens_details', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: null,
    });
    expect(result.cachedTokens).toBeUndefined();
  });

  it('ignores reasoning_tokens inside a non-object completion_tokens_details', () => {
    const result = normalizeChatCompletionsUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      completion_tokens_details: 'bad',
    });
    expect(result.reasoningTokens).toBeUndefined();
  });
});
