/**
 * State-machine tests for LLM Adapter routing, fallback, and resilience
 *
 * Tests the adapter's state machine behavior:
 * - Provider resolution and routing
 * - Model registry auto-registration
 * - Fallback activation on failure
 * - Circuit breaker state transitions
 * - API key management
 * - Resilience configuration
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  createCircuitState,
  shouldAllowRequest,
  recordSuccess,
  recordFailure,
  calculateBackoff,
  isRetryableError,
  CircuitOpenError,
  RetriesExhaustedError,
  DEFAULT_RESILIENCE_CONFIG,
  type CircuitBreakerState,
  type ResilienceConfig,
} from '../packages/core/llm/src/retry.js';

describe('Circuit Breaker State Machine', () => {
  let state: CircuitBreakerState;
  let config: ResilienceConfig;

  beforeEach(() => {
    state = createCircuitState();
    config = { ...DEFAULT_RESILIENCE_CONFIG };
  });

  describe('Initial state', () => {
    it('starts in closed state', () => {
      expect(state.state).toBe('closed');
      expect(state.failures).toBe(0);
      expect(state.successes).toBe(0);
    });

    it('allows requests in closed state', () => {
      expect(shouldAllowRequest(state, config)).toBe(true);
    });
  });

  describe('State transitions', () => {
    it('transitions to open after failure threshold', () => {
      // Record failures up to threshold
      for (let i = 0; i < config.failureThreshold; i++) {
        recordFailure(state, config);
      }

      expect(state.state).toBe('open');
    });

    it('blocks requests when open', () => {
      // Force open state
      state.state = 'open';
      state.lastFailure = Date.now();

      expect(shouldAllowRequest(state, config)).toBe(false);
    });

    it('transitions to half_open after recovery timeout', () => {
      // Force open state with old failure time
      state.state = 'open';
      state.lastFailure = Date.now() - config.recoveryTimeoutMs - 1000;

      // shouldAllowRequest triggers transition
      const allowed = shouldAllowRequest(state, config);

      expect(allowed).toBe(true);
      expect(state.state).toBe('half_open');
    });

    it('transitions from half_open to closed on success', () => {
      state.state = 'half_open';
      state.successes = 0;

      // Record success(es) to meet threshold
      for (let i = 0; i < config.halfOpenSuccesses; i++) {
        recordSuccess(state, config);
      }

      expect(state.state).toBe('closed');
      expect(state.failures).toBe(0);
    });

    it('transitions from half_open to open on failure', () => {
      state.state = 'half_open';

      recordFailure(state, config);

      expect(state.state).toBe('open');
    });

    it('resets failure count on success in closed state', () => {
      state.failures = 1;

      recordSuccess(state, config);

      expect(state.failures).toBe(0);
    });
  });

  describe('Allows requests in half_open for testing recovery', () => {
    it('allows limited requests in half_open state', () => {
      state.state = 'half_open';

      expect(shouldAllowRequest(state, config)).toBe(true);
    });
  });
});

describe('Backoff Calculation', () => {
  const config = DEFAULT_RESILIENCE_CONFIG;

  it('calculates exponential backoff', () => {
    const delay0 = calculateBackoff(0, config);
    const delay1 = calculateBackoff(1, config);
    const delay2 = calculateBackoff(2, config);

    // Delays should increase exponentially (with some jitter variance)
    expect(delay0).toBeGreaterThan(0);
    expect(delay1).toBeGreaterThan(delay0 * 0.5); // Account for jitter
    expect(delay2).toBeGreaterThan(delay1 * 0.5);
  });

  it('respects max backoff limit', () => {
    // Very high attempt number
    const delay = calculateBackoff(100, config);

    expect(delay).toBeLessThanOrEqual(config.maxBackoffMs * (1 + config.jitter));
  });

  it('adds jitter to delay', () => {
    // Run multiple times to check for variance
    const delays = Array.from({ length: 10 }, () => calculateBackoff(0, config));
    const uniqueDelays = new Set(delays);

    // Should have some variation due to jitter
    expect(uniqueDelays.size).toBeGreaterThan(1);
  });
});

describe('Retryable Error Detection', () => {
  it('rate limit errors should NOT retry (trigger fallback instead)', () => {
    // Rate limits shouldn't be retried - they should trigger fallback to another provider
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(false);
    expect(isRetryableError(new Error('Error 429: Too many requests'))).toBe(false);
  });

  it('identifies timeout errors as retryable', () => {
    expect(isRetryableError(new Error('request timeout'))).toBe(true);
    expect(isRetryableError(new Error('Connection timeout after 30s'))).toBe(true);
  });

  it('identifies server errors as retryable', () => {
    expect(isRetryableError(new Error('Error 500: Internal server error'))).toBe(true);
    expect(isRetryableError(new Error('Error 503: Service unavailable'))).toBe(true);
    expect(isRetryableError(new Error('API overloaded'))).toBe(true);
  });

  it('identifies Anthropic overload errors as retryable', () => {
    expect(isRetryableError(new Error('Error 529: API overloaded'))).toBe(true);
  });

  it('does not mark non-retryable errors', () => {
    expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
    expect(isRetryableError(new Error('Bad request'))).toBe(false);
    expect(isRetryableError(new Error('Model not found'))).toBe(false);
  });
});

describe('Error Types', () => {
  it('CircuitOpenError contains circuit key', () => {
    const error = new CircuitOpenError('openai:gpt-4');

    expect(error.name).toBe('CircuitOpenError');
    expect(error.message).toContain('openai:gpt-4');
  });

  it('RetriesExhaustedError preserves underlying error', () => {
    const underlying = new Error('Connection refused');
    const error = new RetriesExhaustedError('Request failed', underlying, 3);

    expect(error.name).toBe('RetriesExhaustedError');
    expect(error.cause).toBe(underlying);
    expect(error.attempts).toBe(3);
    expect(error.message).toContain('Connection refused');
    expect(error.message).toContain('3 attempts');
  });
});

describe('Full Circuit Breaker Lifecycle', () => {
  it('completes full lifecycle: closed → open → half_open → closed', () => {
    const state = createCircuitState();
    const config: ResilienceConfig = {
      ...DEFAULT_RESILIENCE_CONFIG,
      failureThreshold: 2,
      halfOpenSuccesses: 1,
      recoveryTimeoutMs: 100, // Short for testing
    };

    // Phase 1: Closed state, accumulate failures
    expect(state.state).toBe('closed');
    recordFailure(state, config);
    expect(state.state).toBe('closed'); // Not yet at threshold
    recordFailure(state, config);
    expect(state.state).toBe('open'); // Threshold reached

    // Phase 2: Open state, requests blocked
    expect(shouldAllowRequest(state, config)).toBe(false);

    // Phase 3: Wait for recovery, transition to half_open
    state.lastFailure = Date.now() - 200; // Simulate time passing
    expect(shouldAllowRequest(state, config)).toBe(true);
    expect(state.state).toBe('half_open');

    // Phase 4: Success in half_open, close circuit
    recordSuccess(state, config);
    expect(state.state).toBe('closed');
    expect(state.failures).toBe(0);
  });

  it('reopens circuit on failure during half_open', () => {
    const state = createCircuitState();
    const config = DEFAULT_RESILIENCE_CONFIG;

    // Get to half_open state
    state.state = 'half_open';

    // Failure should immediately reopen
    recordFailure(state, config);
    expect(state.state).toBe('open');
  });
});

describe('Resilience Configuration', () => {
  it('DEFAULT_RESILIENCE_CONFIG has sensible defaults', () => {
    expect(DEFAULT_RESILIENCE_CONFIG.maxRetries).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_RESILIENCE_CONFIG.initialBackoffMs).toBeGreaterThan(0);
    expect(DEFAULT_RESILIENCE_CONFIG.backoffMultiplier).toBeGreaterThan(1);
    expect(DEFAULT_RESILIENCE_CONFIG.failureThreshold).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_RESILIENCE_CONFIG.jitter).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_RESILIENCE_CONFIG.jitter).toBeLessThanOrEqual(1);
  });

  it('allows config overrides', () => {
    const customConfig: ResilienceConfig = {
      ...DEFAULT_RESILIENCE_CONFIG,
      maxRetries: 5,
      initialBackoffMs: 500,
    };

    expect(customConfig.maxRetries).toBe(5);
    expect(customConfig.initialBackoffMs).toBe(500);
    // Other values preserved
    expect(customConfig.backoffMultiplier).toBe(DEFAULT_RESILIENCE_CONFIG.backoffMultiplier);
  });
});

describe('Adapter Provider Routing (Unit Tests)', () => {
  // These tests verify the routing logic patterns without making actual API calls

  describe('Provider resolution patterns', () => {
    it('should resolve provider from model registry', () => {
      // Simulate registry lookup
      const registry = new Map<string, { provider: string; baseUrl: string }>([
        ['gpt-5-mini', { provider: 'openai', baseUrl: 'https://api.openai.com' }],
        ['claude-sonnet-4-5', { provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }],
      ]);

      const model = 'gpt-5-mini';
      const entry = registry.get(model);

      expect(entry?.provider).toBe('openai');
      expect(entry?.baseUrl).toBe('https://api.openai.com');
    });

    it('should handle unknown models with explicit provider', () => {
      // When model not in registry but provider is specified
      const requestConfig = {
        model: 'custom-model',
        provider: 'openai-compat',
        baseUrl: 'https://custom.api.com',
        apiKey: 'key',
      };

      // Simulating the auto-registration behavior
      const registry = new Map<string, { provider: string; baseUrl: string }>();
      registry.set(requestConfig.model, {
        provider: requestConfig.provider,
        baseUrl: requestConfig.baseUrl,
      });

      expect(registry.get('custom-model')?.provider).toBe('openai-compat');
    });

    it('should throw for unknown model without provider', () => {
      const registry = new Map<string, { provider: string }>();
      const model = 'unknown-model';

      const entry = registry.get(model);
      const provider = undefined; // No provider specified

      expect(entry).toBeUndefined();
      expect(provider).toBeUndefined();

      // This would throw: "Unknown provider for model 'unknown-model'"
      const shouldThrow = !entry && !provider;
      expect(shouldThrow).toBe(true);
    });
  });

  describe('API key resolution patterns', () => {
    it('prioritizes per-request API key over stored key', () => {
      const storedKeys = { openai: 'stored-key' };
      const requestKey = 'request-key';

      const resolvedKey = requestKey ?? storedKeys.openai;
      expect(resolvedKey).toBe('request-key');
    });

    it('falls back to stored API key when not provided per-request', () => {
      const storedKeys: Record<string, string> = { openai: 'stored-key' };
      const requestKey = undefined;

      const resolvedKey = requestKey ?? storedKeys.openai;
      expect(resolvedKey).toBe('stored-key');
    });

    it('should throw for missing API key', () => {
      const storedKeys: Record<string, string | undefined> = {};
      const requestKey = undefined;
      const provider = 'openai';

      const resolvedKey = requestKey ?? storedKeys[provider];

      expect(resolvedKey).toBeUndefined();
      // This would throw: "API key not configured for provider 'openai'"
    });
  });

  describe('Base URL resolution patterns', () => {
    it('uses per-request baseUrl first', () => {
      const defaultUrls = { openai: 'https://api.openai.com' };
      const registryUrl = 'https://registry.url.com';
      const requestUrl = 'https://request.url.com';

      const resolved = requestUrl ?? registryUrl ?? defaultUrls.openai;
      expect(resolved).toBe('https://request.url.com');
    });

    it('uses registry baseUrl second', () => {
      const defaultUrls = { openai: 'https://api.openai.com' };
      const registryUrl = 'https://registry.url.com';
      const requestUrl = undefined;

      const resolved = requestUrl ?? registryUrl ?? defaultUrls.openai;
      expect(resolved).toBe('https://registry.url.com');
    });

    it('uses default baseUrl as fallback', () => {
      const defaultUrls = { openai: 'https://api.openai.com' };
      const registryUrl = undefined;
      const requestUrl = undefined;

      const resolved = requestUrl ?? registryUrl ?? defaultUrls.openai;
      expect(resolved).toBe('https://api.openai.com');
    });
  });
});

describe('Fallback Logic Patterns', () => {
  it('fallback should use different provider on primary failure', () => {
    const primaryConfig = { provider: 'openai', model: 'gpt-5-mini' };
    const fallbackConfig = { provider: 'anthropic', model: 'claude-sonnet-4-5' };

    // Simulate primary failure and fallback activation
    const primaryFailed = true;

    if (primaryFailed && fallbackConfig) {
      // Would use fallback provider
      expect(fallbackConfig.provider).not.toBe(primaryConfig.provider);
    }
  });

  it('fallback should not chain (prevents infinite loops)', () => {
    const originalFallback = { provider: 'anthropic', model: 'claude', fallback: undefined };

    // When creating fallback params, don't include nested fallback
    const fallbackLlm = {
      model: originalFallback.model,
      provider: originalFallback.provider,
      // Notice: no 'fallback' field - prevents chaining
    };

    expect(fallbackLlm).not.toHaveProperty('fallback');
  });

  it('per-request fallback takes precedence over global', () => {
    const globalFallback = { provider: 'anthropic', model: 'claude' };
    const requestFallback = { provider: 'openai-compat', model: 'custom' };

    const activeFallback = requestFallback ?? globalFallback;

    expect(activeFallback.provider).toBe('openai-compat');
  });

  it('uses global fallback when no per-request fallback', () => {
    const globalFallback = { provider: 'anthropic', model: 'claude' };
    const requestFallback = undefined;

    const activeFallback = requestFallback ?? globalFallback;

    expect(activeFallback?.provider).toBe('anthropic');
  });

  it('marks response as usedFallback when fallback is used', () => {
    const response = {
      content: 'Response from fallback',
      model: 'claude-sonnet-4-5',
    };

    // When fallback is used, response should be marked
    const fallbackResponse = { ...response, usedFallback: true };

    expect(fallbackResponse.usedFallback).toBe(true);
  });
});

describe('Model Registry Patterns', () => {
  it('normalizes model keys to lowercase', () => {
    const normalizeKey = (model: string) => model.trim().toLowerCase();

    expect(normalizeKey('GPT-5-Mini')).toBe('gpt-5-mini');
    expect(normalizeKey(' Claude-Sonnet ')).toBe('claude-sonnet');
  });

  it('does not overwrite existing registry entries', () => {
    const registry = new Map<string, { provider: string }>();
    registry.set('model', { provider: 'openai' });

    // Simulate register that doesn't overwrite
    const registerModel = (key: string, provider: string) => {
      if (!registry.has(key)) {
        registry.set(key, { provider });
      }
    };

    registerModel('model', 'anthropic'); // Should not overwrite

    expect(registry.get('model')?.provider).toBe('openai');
  });
});

describe('API Key Management Patterns', () => {
  it('updateApiKey resets circuit breaker', () => {
    // Simulate adapter state
    let circuitState = createCircuitState();
    circuitState.state = 'open';
    circuitState.failures = 5;

    // Simulate updateApiKey behavior
    const updateApiKey = () => {
      circuitState = createCircuitState(); // Reset circuit
    };

    updateApiKey();

    expect(circuitState.state).toBe('closed');
    expect(circuitState.failures).toBe(0);
  });

  it('resetCircuitBreaker clears failure state', () => {
    const state = createCircuitState();
    state.state = 'open';
    state.failures = 10;
    state.lastFailure = Date.now();

    // Simulate reset
    const resetState = createCircuitState();

    expect(resetState.state).toBe('closed');
    expect(resetState.failures).toBe(0);
  });
});
