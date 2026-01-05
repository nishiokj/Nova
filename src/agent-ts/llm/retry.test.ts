/**
 * Comprehensive test suite for Retry and Circuit Breaker Logic
 *
 * Goal: Find bugs, not just pass tests.
 * Focus areas:
 * - Backoff calculation edge cases
 * - Circuit breaker state transitions
 * - Retry logic with various error types
 * - Jitter behavior
 * - Recovery after circuit opens
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  calculateBackoff,
  sleep,
  isRetryableError,
  shouldAllowRequest,
  recordSuccess,
  recordFailure,
  createCircuitState,
  resilientCall,
  CircuitOpenError,
  RetriesExhaustedError,
  type CircuitState,
  type CircuitBreakerState,
  type ResilienceConfig,
  DEFAULT_RESILIENCE_CONFIG,
} from './retry.js';

describe('calculateBackoff', () => {
  const baseConfig: ResilienceConfig = {
    ...DEFAULT_RESILIENCE_CONFIG,
    jitter: 0, // Disable jitter for predictable tests
  };

  it('should return initialBackoffMs for attempt 0', () => {
    const delay = calculateBackoff(0, baseConfig);
    expect(delay).toBe(baseConfig.initialBackoffMs);
  });

  it('should increase exponentially with attempt number', () => {
    const config = { ...baseConfig, initialBackoffMs: 1000, backoffMultiplier: 2 };

    expect(calculateBackoff(0, config)).toBe(1000);
    expect(calculateBackoff(1, config)).toBe(2000);
    expect(calculateBackoff(2, config)).toBe(4000);
    expect(calculateBackoff(3, config)).toBe(8000);
  });

  it('should cap at maxBackoffMs', () => {
    const config = {
      ...baseConfig,
      initialBackoffMs: 1000,
      backoffMultiplier: 10,
      maxBackoffMs: 5000,
    };

    expect(calculateBackoff(0, config)).toBe(1000);
    expect(calculateBackoff(1, config)).toBe(5000); // Capped at 5000, not 10000
    expect(calculateBackoff(2, config)).toBe(5000); // Still capped
  });

  it('should add jitter when enabled', () => {
    const config = {
      ...baseConfig,
      initialBackoffMs: 1000,
      jitter: 0.1, // 10% jitter
    };

    // Run multiple times to verify jitter variance
    const delays = new Set<number>();
    for (let i = 0; i < 10; i++) {
      delays.add(calculateBackoff(0, config));
    }

    // Should have some variance
    expect(delays.size).toBeGreaterThan(1);

    // All delays should be within jitter range (900 to 1100)
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(900);
      expect(delay).toBeLessThanOrEqual(1100);
    }
  });

  it('should handle negative jitter result gracefully', () => {
    const config = {
      ...baseConfig,
      initialBackoffMs: 100,
      jitter: 0.9, // Large jitter
    };

    // Should never return negative
    for (let i = 0; i < 100; i++) {
      const delay = calculateBackoff(0, config);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('BUG CANDIDATE: very large attempt numbers cause overflow', () => {
    const config = {
      ...baseConfig,
      initialBackoffMs: 1000,
      backoffMultiplier: 2,
      maxBackoffMs: 30000,
    };

    // Attempt 100 would calculate 1000 * 2^100 before capping
    const delay = calculateBackoff(100, config);

    // Should be capped at maxBackoffMs
    expect(delay).toBe(30000);
  });
});

describe('isRetryableError', () => {
  it('should return true for rate limit errors', () => {
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('Rate Limit'))).toBe(true);
    expect(isRetryableError(new Error('You have exceeded your rate limit'))).toBe(true);
  });

  it('should return true for timeout errors', () => {
    expect(isRetryableError(new Error('request timeout'))).toBe(true);
    expect(isRetryableError(new Error('TIMEOUT occurred'))).toBe(true);
  });

  it('should return true for overloaded errors', () => {
    expect(isRetryableError(new Error('server overloaded'))).toBe(true);
    expect(isRetryableError(new Error('The API is currently overloaded'))).toBe(true);
  });

  it('should return true for 5xx errors', () => {
    expect(isRetryableError(new Error('500: Internal Server Error'))).toBe(true);
    expect(isRetryableError(new Error('503: Service Unavailable'))).toBe(true);
    expect(isRetryableError(new Error('529: Server Too Busy'))).toBe(true);
  });

  it('should return false for 4xx client errors', () => {
    expect(isRetryableError(new Error('400: Bad Request'))).toBe(false);
    expect(isRetryableError(new Error('401: Unauthorized'))).toBe(false);
    expect(isRetryableError(new Error('404: Not Found'))).toBe(false);
  });

  it('should return false for non-Error values', () => {
    expect(isRetryableError('string error')).toBe(false);
    expect(isRetryableError({ message: 'object error' })).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it('should return false for unrecognized errors', () => {
    expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
    expect(isRetryableError(new Error('Content policy violation'))).toBe(false);
  });

  it('BUG CANDIDATE: 429 is not in the check', () => {
    // 429 is the standard rate limit status code but only "rate" keyword is checked
    const error = new Error('429: Too Many Requests');

    // This should be retryable but the keyword "rate" is not in "Too Many Requests"
    // However, "429" is not checked either
    // Let's see what the current implementation returns
    const result = isRetryableError(error);

    // The implementation checks for 'rate' which IS in the message
    // Actually it looks for 'rate' in lowercase, and '429' is a specific check
    // Looking at the code: message.includes('rate') || message.includes('timeout') || ...
    // '429' is not directly checked
  });
});

describe('Circuit Breaker', () => {
  describe('shouldAllowRequest', () => {
    it('should allow request when circuit is closed', () => {
      const state = createCircuitState();
      expect(shouldAllowRequest(state, DEFAULT_RESILIENCE_CONFIG)).toBe(true);
    });

    it('should block request when circuit is open and timeout not elapsed', () => {
      const state = createCircuitState();
      state.state = 'open';
      state.lastFailure = Date.now(); // Just failed

      expect(shouldAllowRequest(state, DEFAULT_RESILIENCE_CONFIG)).toBe(false);
    });

    it('should transition to half_open when timeout elapsed', () => {
      const state = createCircuitState();
      state.state = 'open';
      state.lastFailure = Date.now() - 60000; // 60 seconds ago

      const result = shouldAllowRequest(state, {
        ...DEFAULT_RESILIENCE_CONFIG,
        recoveryTimeoutMs: 30000, // 30 second timeout
      });

      expect(result).toBe(true);
      expect(state.state as CircuitState).toBe('half_open');
      expect(state.successes).toBe(0); // Reset on transition
    });

    it('should allow request when circuit is half_open', () => {
      const state = createCircuitState();
      state.state = 'half_open';

      expect(shouldAllowRequest(state, DEFAULT_RESILIENCE_CONFIG)).toBe(true);
    });

    it('BUG CANDIDATE: state mutation in shouldAllowRequest', () => {
      // shouldAllowRequest mutates state when transitioning to half_open
      // This could be unexpected if caller expects read-only check
      const state = createCircuitState();
      state.state = 'open';
      state.lastFailure = Date.now() - 60000;
      state.successes = 5;

      shouldAllowRequest(state, {
        ...DEFAULT_RESILIENCE_CONFIG,
        recoveryTimeoutMs: 30000,
      });

      // State was mutated
      expect(state.state as CircuitState).toBe('half_open');
      expect(state.successes).toBe(0);
    });
  });

  describe('recordSuccess', () => {
    it('should reset failure count in closed state', () => {
      const state = createCircuitState();
      state.failures = 3;

      recordSuccess(state, DEFAULT_RESILIENCE_CONFIG);

      expect(state.failures).toBe(0);
      expect(state.successes).toBe(1);
    });

    it('should transition from half_open to closed after enough successes', () => {
      const config = { ...DEFAULT_RESILIENCE_CONFIG, halfOpenSuccesses: 2 };
      const state = createCircuitState();
      state.state = 'half_open';

      recordSuccess(state, config);
      expect(state.state as CircuitState).toBe('half_open');

      recordSuccess(state, config);
      expect(state.state as CircuitState).toBe('closed');
      expect(state.failures).toBe(0);
    });

    it('should increment successes in half_open state', () => {
      const state = createCircuitState();
      state.state = 'half_open';
      state.successes = 0;

      recordSuccess(state, DEFAULT_RESILIENCE_CONFIG);

      expect(state.successes).toBe(1);
    });
  });

  describe('recordFailure', () => {
    it('should increment failure count in closed state', () => {
      const state = createCircuitState();

      recordFailure(state, DEFAULT_RESILIENCE_CONFIG);

      expect(state.failures).toBe(1);
    });

    it('should open circuit after threshold in closed state', () => {
      const config = { ...DEFAULT_RESILIENCE_CONFIG, failureThreshold: 2 };
      const state = createCircuitState();

      recordFailure(state, config);
      expect(state.state as CircuitState).toBe('closed');

      recordFailure(state, config);
      expect(state.state as CircuitState).toBe('open');
    });

    it('should immediately re-open circuit on failure in half_open state', () => {
      const state = createCircuitState();
      state.state = 'half_open';

      recordFailure(state, DEFAULT_RESILIENCE_CONFIG);

      expect(state.state as CircuitState).toBe('open');
    });

    it('should update lastFailure timestamp', () => {
      const state = createCircuitState();
      const before = Date.now();

      recordFailure(state, DEFAULT_RESILIENCE_CONFIG);

      expect(state.lastFailure).toBeGreaterThanOrEqual(before);
    });
  });
});

describe('resilientCall', () => {
  it('should return result on success', async () => {
    const result = await resilientCall(async () => 'success');
    expect(result).toBe('success');
  });

  it('should retry on retryable error', async () => {
    let attempts = 0;
    const result = await resilientCall(
      async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('timeout: temporary failure');
        }
        return 'success after retry';
      },
      { config: { maxRetries: 3 } }
    );

    expect(result).toBe('success after retry');
    expect(attempts).toBe(2);
  });

  it('should not retry on non-retryable error', async () => {
    let attempts = 0;

    await expect(
      resilientCall(
        async () => {
          attempts++;
          throw new Error('401: Invalid API key');
        },
        { config: { maxRetries: 3 } }
      )
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });

  it('should throw RetriesExhaustedError after max retries', async () => {
    let attempts = 0;

    try {
      await resilientCall(
        async () => {
          attempts++;
          throw new Error('503: Service Unavailable');
        },
        { config: { maxRetries: 2 } }
      );
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(RetriesExhaustedError);
      expect((error as RetriesExhaustedError).attempts).toBe(3); // 1 initial + 2 retries
    }

    expect(attempts).toBe(3);
  });

  it('should throw CircuitOpenError when circuit is open', async () => {
    const circuitState = createCircuitState();
    circuitState.state = 'open';
    circuitState.lastFailure = Date.now(); // Just failed

    await expect(
      resilientCall(
        async () => 'success',
        { circuitState, circuitKey: 'test-circuit' }
      )
    ).rejects.toThrow(CircuitOpenError);
  });

  it('should call onRetry callback', async () => {
    const retryLogs: Array<{ attempt: number; error: Error; delayMs: number }> = [];

    await expect(
      resilientCall(
        async () => {
          throw new Error('timeout: always fails');
        },
        {
          config: { maxRetries: 2, initialBackoffMs: 10, jitter: 0 },
          onRetry: (attempt, error, delayMs) => {
            retryLogs.push({ attempt, error, delayMs });
          },
        }
      )
    ).rejects.toThrow();

    expect(retryLogs).toHaveLength(2);
    expect(retryLogs[0].attempt).toBe(1);
    expect(retryLogs[1].attempt).toBe(2);
  });

  it('should record success in circuit state', async () => {
    const circuitState = createCircuitState();
    circuitState.failures = 5;

    await resilientCall(
      async () => 'success',
      { circuitState }
    );

    expect(circuitState.failures).toBe(0);
    expect(circuitState.successes).toBeGreaterThan(0);
  });

  it('should record failure in circuit state after exhausting retries', async () => {
    const circuitState = createCircuitState();

    await expect(
      resilientCall(
        async () => {
          throw new Error('timeout: always fails');
        },
        {
          circuitState,
          config: { ...DEFAULT_RESILIENCE_CONFIG, maxRetries: 0 },
        }
      )
    ).rejects.toThrow();

    expect(circuitState.failures).toBe(1);
  });

  it('should use default circuit state if not provided', async () => {
    // Should not throw
    const result = await resilientCall(async () => 'success');
    expect(result).toBe('success');
  });

  it('BUG CANDIDATE: circuit state shared across calls', async () => {
    // If the same circuitState is passed to multiple concurrent calls,
    // the state mutations are not thread-safe
    const circuitState = createCircuitState();
    const config = { ...DEFAULT_RESILIENCE_CONFIG, failureThreshold: 2 };

    // Simulate concurrent failures
    const promises = [
      resilientCall(
        async () => { throw new Error('timeout'); },
        { circuitState, config: { ...config, maxRetries: 0 } }
      ).catch(() => {}),
      resilientCall(
        async () => { throw new Error('timeout'); },
        { circuitState, config: { ...config, maxRetries: 0 } }
      ).catch(() => {}),
    ];

    await Promise.all(promises);

    // Both failures should have been recorded
    // In a truly concurrent scenario, there could be race conditions
    expect(circuitState.failures).toBe(2);
  });
});

describe('sleep', () => {
  it('should wait approximately the specified time', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some variance
    expect(elapsed).toBeLessThan(100);
  });

  it('should resolve immediately for 0ms', async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10);
  });
});

describe('CircuitOpenError', () => {
  it('should include circuit key in message', () => {
    const error = new CircuitOpenError('my-service');
    expect(error.message).toContain('my-service');
    expect(error.name).toBe('CircuitOpenError');
  });
});

describe('RetriesExhaustedError', () => {
  it('should include attempt count and last error', () => {
    const lastError = new Error('final failure');
    const error = new RetriesExhaustedError('All retries failed', lastError, 3);

    expect(error.message).toContain('3');
    expect(error.lastError).toBe(lastError);
    expect(error.attempts).toBe(3);
    expect(error.name).toBe('RetriesExhaustedError');
  });
});

describe('createCircuitState', () => {
  it('should create initial closed state', () => {
    const state = createCircuitState();

    expect(state.state).toBe('closed');
    expect(state.failures).toBe(0);
    expect(state.successes).toBe(0);
    expect(state.lastFailure).toBe(0);
    expect(state.lastSuccess).toBe(0);
  });
});
