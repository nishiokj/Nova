import { MemoryInjectedDataSchema } from 'types';

describe('MemoryInjectedDataSchema hard cutover', () => {
  it('accepts unversioned payloads', () => {
    const parsed = MemoryInjectedDataSchema.parse({
      query: 'find prior implementation notes',
      itemCount: 2,
      success: true,
      iteration: 0,
    });

    expect(parsed.query).toBe('find prior implementation notes');
  });

  it('rejects version compatibility field', () => {
    expect(() => MemoryInjectedDataSchema.parse({
      query: 'removed field payload',
      itemCount: 0,
      success: false,
      iteration: 0,
      version: 'removed',
    })).toThrow();
  });

  it('rejects removed fallbackToV1 field', () => {
    expect(() => MemoryInjectedDataSchema.parse({
      query: 'removed fallback field payload',
      itemCount: 0,
      success: false,
      iteration: 0,
      fallbackToV1: true,
    })).toThrow();
  });
});
