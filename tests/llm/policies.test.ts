import {
  DEFAULT_RESILIENCE_CONFIG,
  RetriesExhaustedError,
  TimeoutError,
  resilientCall,
} from 'llm';

describe('LLM resilience policies', () => {
  it('passes through non-retryable errors without wrapping', async () => {
    const authError = new Error('401: Invalid API key');

    try {
      await resilientCall(
        async () => {
          throw authError;
        },
        {
          config: {
            ...DEFAULT_RESILIENCE_CONFIG,
            maxRetries: 3,
          },
        }
      );
      expect(true).toBe(false);
    } catch (error) {
      expect(error).not.toBeInstanceOf(RetriesExhaustedError);
      const message = String((error as { message?: string })?.message ?? error);
      expect(message).toContain('401');
      expect(message).not.toContain('All retries failed');
    }
  });

  it('wraps exhausted retryable errors as RetriesExhaustedError', async () => {
    const timeoutError = new TimeoutError('upstream timeout', 25);

    await expect(
      resilientCall(
        async () => {
          throw timeoutError;
        },
        {
          config: {
            ...DEFAULT_RESILIENCE_CONFIG,
            maxRetries: 0,
          },
        }
      )
    ).rejects.toBeInstanceOf(RetriesExhaustedError);
  });
});
