import { describe, expect, it } from 'vitest';
import { buildLLMRequestConfig } from './llm_config.js';

describe('buildLLMRequestConfig', () => {
  it('passes through an explicit per-run apiKey override', () => {
    const config = buildLLMRequestConfig(
      {
        provider: 'codex',
        model: 'gpt-5.3-codex',
        contextWindow: 256_000,
        apiKey: 'explicit-token',
      },
      {
        maxTokens: 8_000,
        temperature: 0.1,
      }
    );

    expect(config).toMatchObject({
      provider: 'codex',
      displayProvider: 'codex',
      model: 'gpt-5.3-codex',
      apiKey: 'explicit-token',
      contextWindow: 256_000,
      maxTokens: 8_000,
      temperature: 0.1,
    });
  });
});
