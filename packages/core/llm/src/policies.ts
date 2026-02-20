/**
 * Effect-native resilience policies (retry, timeout, circuit breaker).
 */

import { Duration, Effect, Schedule } from 'effect';

// ============================================
// CIRCUIT BREAKER STATE
// ============================================

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: number;
  lastSuccess: number;
}

export function createCircuitState(): CircuitBreakerState {
  return {
    state: 'closed',
    failures: 0,
    successes: 0,
    lastFailure: 0,
    lastSuccess: 0,
  };
}

/**
 * Shared provider-level circuit state map.
 * This is owned by llm policies so higher-level runtimes (agent/orchestrator)
 * consume a single source of truth instead of maintaining local registries.
 */
const providerCircuitStates = new Map<string, CircuitBreakerState>();

/**
 * Get or create a circuit state for a provider.
 */
export function getProviderCircuitState(provider: string): CircuitBreakerState {
  let state = providerCircuitStates.get(provider);
  if (!state) {
    state = createCircuitState();
    providerCircuitStates.set(provider, state);
  }
  return state;
}

/**
 * Reset one provider circuit state, or all provider states when omitted.
 */
export function resetProviderCircuit(provider?: string): void {
  if (provider && provider.trim().length > 0) {
    providerCircuitStates.delete(provider);
    return;
  }
  providerCircuitStates.clear();
}

/**
 * Return a copy of current provider circuit states.
 */
export function getCircuitStatus(): Map<string, CircuitBreakerState> {
  return new Map(providerCircuitStates);
}

// ============================================
// RESILIENCE CONFIG
// ============================================

export interface ResilienceConfig {
  maxRetries: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  jitter: number;
  failureThreshold: number;
  recoveryTimeoutMs: number;
  halfOpenSuccesses: number;
}

export const DEFAULT_RESILIENCE_CONFIG: ResilienceConfig = {
  maxRetries: 2,
  initialBackoffMs: 1000,
  backoffMultiplier: 2.0,
  maxBackoffMs: 30000,
  jitter: 0.1,
  failureThreshold: 2,
  recoveryTimeoutMs: 30000,
  halfOpenSuccesses: 1,
};

// ============================================
// RETRY HELPERS
// ============================================

export function calculateBackoff(
  attempt: number,
  config: ResilienceConfig
): number {
  const delay = Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, attempt),
    config.maxBackoffMs
  );

  const jitterRange = delay * config.jitter;
  const jitter = Math.random() * jitterRange * 2 - jitterRange;
  return Math.max(0, delay + jitter);
}

export function sleep(ms: number): Effect.Effect<void, never> {
  return Effect.sleep(ms);
}

export class TimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function withTimeout<T>(
  effect: Effect.Effect<T, unknown>,
  timeoutMs: number,
  operationName: string = 'Operation'
): Effect.Effect<T, Error | TimeoutError> {
  return effect.pipe(
    Effect.mapError((error) => error instanceof Error ? error : new Error(String(error))),
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () => new TimeoutError(`${operationName} timed out after ${timeoutMs}ms`, timeoutMs),
    })
  );
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return error.isWorthWaiting();
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('429') || message.includes('rate limit')) {
      return false;
    }
    if (
      message.includes('timeout') ||
      message.includes('overloaded') ||
      message.includes('503') ||
      message.includes('529') ||
      message.includes('500')
    ) {
      return true;
    }
  }
  return false;
}

// ============================================
// CIRCUIT BREAKER LOGIC
// ============================================

export function shouldAllowRequest(
  state: CircuitBreakerState,
  config: ResilienceConfig
): boolean {
  const now = Date.now();

  switch (state.state) {
    case 'closed':
      return true;
    case 'open':
      if (now - state.lastFailure >= config.recoveryTimeoutMs) {
        state.state = 'half_open';
        state.successes = 0;
        return true;
      }
      return false;
    case 'half_open':
      return true;
  }
}

export function recordSuccess(
  state: CircuitBreakerState,
  config: ResilienceConfig
): void {
  state.lastSuccess = Date.now();
  state.successes++;

  if (state.state === 'half_open') {
    if (state.successes >= config.halfOpenSuccesses) {
      state.state = 'closed';
      state.failures = 0;
    }
  } else if (state.state === 'closed') {
    state.failures = 0;
  }
}

export function recordFailure(
  state: CircuitBreakerState,
  config: ResilienceConfig
): void {
  state.lastFailure = Date.now();
  state.failures++;

  if (state.state === 'half_open') {
    state.state = 'open';
  } else if (state.state === 'closed') {
    if (state.failures >= config.failureThreshold) {
      state.state = 'open';
    }
  }
}

// ============================================
// RESILIENT CALL WRAPPER
// ============================================

export class CircuitOpenError extends Error {
  constructor(key: string) {
    super(`Circuit breaker is open for: ${key}`);
    this.name = 'CircuitOpenError';
  }
}

export type RateLimitType = 'window' | 'quota' | 'billing' | 'unknown';

export interface RateLimitInfo {
  type: RateLimitType;
  retryAfterMs?: number;
  limitType?: string;
  remaining?: number;
  resetAt?: Date;
  message: string;
}

export class RateLimitError extends Error {
  public readonly info: RateLimitInfo;
  public readonly provider: string;
  public readonly model: string;
  public readonly status: number;

  constructor(
    message: string,
    info: RateLimitInfo,
    provider: string,
    model: string,
    status: number = 429
  ) {
    super(message);
    this.name = 'RateLimitError';
    this.info = info;
    this.provider = provider;
    this.model = model;
    this.status = status;
  }

  isWorthWaiting(maxWaitMs: number = 60000): boolean {
    if (this.info.type === 'quota' || this.info.type === 'billing') {
      return false;
    }
    if (this.info.retryAfterMs && this.info.retryAfterMs <= maxWaitMs) {
      return true;
    }
    return false;
  }

  static isRateLimitError(error: unknown): error is RateLimitError {
    return error instanceof RateLimitError;
  }
}

export class RetriesExhaustedError extends Error {
  public readonly attempts: number;

  constructor(message: string, lastError: Error, attempts: number) {
    super(`${message} after ${attempts} attempts: ${lastError.message}`, {
      cause: lastError,
    });
    this.name = 'RetriesExhaustedError';
    this.attempts = attempts;
  }
}

export interface ResilientCallOptions {
  config?: Partial<ResilienceConfig>;
  circuitState?: CircuitBreakerState;
  circuitKey?: string;
  timeoutMs?: number;
  operationName?: string;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export function resilientCall<T, E>(
  effect: Effect.Effect<T, E>,
  options: ResilientCallOptions = {}
): Effect.Effect<T, Error | CircuitOpenError | TimeoutError | RetriesExhaustedError> {
  const config: ResilienceConfig = {
    ...DEFAULT_RESILIENCE_CONFIG,
    ...options.config,
  };

  const state = options.circuitState ?? createCircuitState();
  const key = options.circuitKey ?? 'default';
  const { timeoutMs, operationName = 'LLM call' } = options;

  if (!shouldAllowRequest(state, config)) {
    return Effect.fail(new CircuitOpenError(key));
  }

  let retryCount = 0;
  const retryPolicy = Schedule.addDelay(
    Schedule.recurs(config.maxRetries),
    (attempt) =>
      Duration.millis(calculateBackoff(typeof attempt === 'number' ? attempt : retryCount, config))
  );

  const baseEffect: Effect.Effect<T, Error> = effect.pipe(
    Effect.mapError((error) => error instanceof Error ? error : new Error(String(error)))
  );

  const timedEffect: Effect.Effect<T, Error | TimeoutError> = timeoutMs
    ? baseEffect.pipe(
        Effect.timeoutFail({
          duration: timeoutMs,
          onTimeout: () => new TimeoutError(`${operationName} timed out after ${timeoutMs}ms`, timeoutMs),
        })
      )
    : baseEffect;

  return timedEffect.pipe(
    Effect.retry({
      schedule: retryPolicy,
      while: (error: Error) => {
        const retryable = isRetryableError(error) || error instanceof TimeoutError;
        if (retryable && retryCount < config.maxRetries) {
          const delayMs = calculateBackoff(retryCount, config);
          options.onRetry?.(retryCount + 1, error, delayMs);
        }
        retryCount++;
        return retryable;
      },
    }),
    Effect.tap(() => Effect.sync(() => {
      recordSuccess(state, config);
    })),
    Effect.catchAll((error) => {
      recordFailure(state, config);
      const exhaustedRetryable = error instanceof TimeoutError || isRetryableError(error);
      if (!exhaustedRetryable) {
        return Effect.fail(error);
      }
      return Effect.fail(
        new RetriesExhaustedError(
          'All retries failed',
          error instanceof Error ? error : new Error(String(error)),
          config.maxRetries + 1
        )
      );
    })
  );
}
