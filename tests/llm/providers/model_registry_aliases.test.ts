import { describe, expect, it } from 'vitest';
import { getModelDefinition, getProviderForModel } from 'types';

describe('model registry aliases', () => {
  it('maps codex-spark to the canonical codex spark model', () => {
    expect(getProviderForModel('codex-spark')).toBe('codex');
    expect(getModelDefinition('codex-spark')?.id).toBe('gpt-5.3-codex-spark');
  });
});
