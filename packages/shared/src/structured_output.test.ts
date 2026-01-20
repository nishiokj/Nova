import { describe, it, expect } from 'bun:test';
import { coerceStructuredOutput, extractPreJsonText } from './structured_output.js';

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

describe('extractPreJsonText', () => {
  it('returns empty string for pure JSON', () => {
    expect(extractPreJsonText('{"action":"done"}')).toBe('');
  });

  it('returns empty string when content starts with {', () => {
    expect(extractPreJsonText('  {"action":"done"}')).toBe('');
  });

  it('extracts text before JSON object', () => {
    const input = 'Here is my analysis:\n\n{"action":"done","response":null}';
    expect(extractPreJsonText(input)).toBe('Here is my analysis:');
  });

  it('extracts text before fenced JSON', () => {
    const input = 'Summary of findings:\n```json\n{"action":"done"}\n```';
    expect(extractPreJsonText(input)).toBe('Summary of findings:');
  });

  it('handles multiline pre-JSON text', () => {
    const input = `I found the following:
- Item 1
- Item 2

{"action":"continue","response":null}`;
    const result = extractPreJsonText(input);
    expect(result).toContain('I found the following:');
    expect(result).toContain('- Item 1');
  });

  it('returns empty for null/undefined', () => {
    expect(extractPreJsonText(null as any)).toBe('');
    expect(extractPreJsonText(undefined as any)).toBe('');
    expect(extractPreJsonText('')).toBe('');
  });

  it('skips invalid JSON objects and finds valid one', () => {
    const input = 'Text before {not valid json} more text {"action":"done"}';
    expect(extractPreJsonText(input)).toBe('Text before {not valid json} more text');
  });
});
