import { describe, expect, it } from 'bun:test';
import { getOutputSchemaJson, unwrapStructuredOutput } from './output_schemas.js';

describe('getOutputSchemaJson', () => {
  it('returns canonical schema output without provider-specific wrapping', () => {
    const definition = getOutputSchemaJson('explorer');
    expect(definition).toBeDefined();

    const schema = definition!.schema as Record<string, unknown>;
    expect('$schema' in schema).toBe(false);
    expect(schema.anyOf).toBeDefined();
    expect(schema.type).toBeUndefined();
    expect((schema.properties as Record<string, unknown> | undefined)?.result).toBeUndefined();
  });
});

describe('unwrapStructuredOutput', () => {
  it('unwraps result envelopes when present', () => {
    expect(unwrapStructuredOutput({ result: { action: 'done' } })).toEqual({ action: 'done' });
  });

  it('leaves ordinary objects unchanged', () => {
    const value = { action: 'done', response: 'ok' };
    expect(unwrapStructuredOutput(value)).toEqual(value);
  });
});

