import { describe, it, expect } from 'bun:test';
import { coerceStructuredOutput } from './structured_output.js';

describe('coerceStructuredOutput', () => {
  it('parses direct JSON object', () => {
    const result = coerceStructuredOutput('{"action":"done"}');
    expect(result).toEqual({ action: 'done' });
  });

  it('parses JSON inside a fenced code block', () => {
    const input = 'Result:\n```json\n{"action":"done","response":"ok"}\n```';
    const result = coerceStructuredOutput(input);
    expect(result).toEqual({ action: 'done', response: 'ok' });
  });

  it('finds the first valid JSON object in mixed text', () => {
    const input = 'prefix {not json} {"action":"done","response":"ok"} trailing {"other":1}';
    const result = coerceStructuredOutput(input);
    expect(result).toEqual({ action: 'done', response: 'ok' });
  });
});
