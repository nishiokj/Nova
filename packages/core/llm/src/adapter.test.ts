import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { createAdapter } from './adapter.js';

describe('LLM adapter codex auth', () => {
  it('honors an explicit per-request apiKey before OAuth file lookup', async () => {
    const adapter = createAdapter() as unknown as {
      resolveRequestConfig: (llm: Record<string, unknown>) => Effect.Effect<Record<string, unknown>, Error>;
    };

    const resolved = await Effect.runPromise(adapter.resolveRequestConfig({
      provider: 'codex',
      model: 'gpt-5.3-codex',
      apiKey: 'explicit-token',
    }));

    expect(resolved).toMatchObject({
      provider: 'codex',
      displayProvider: 'codex',
      model: 'gpt-5.3-codex',
      apiKey: 'explicit-token',
    });
    expect(resolved).not.toHaveProperty('chatgptAccountId');
  });
});
