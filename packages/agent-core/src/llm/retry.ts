/**
 * Retry logic with exponential backoff and circuit breaker.
 *
 * Ported from: src/util/resilience.py
 */

// ============================================
// CIRCUIT BREAKER STATE
// ============================================

/**
 * Circuit breaker states.
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Circuit breaker state tracking.
 */
export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: number;
  lastSuccess: number;
}

/**
 * Create initial circuit breaker state.
 */
export function createCircuitState(): CircuitBreakerState {
  return {
    state: 'closed',
    failures: 0,
    successes: 0,
    lastFailure: 0,
    lastSuccess: 0,
  };
}

// ============================================
// RESILIENCE CONFIG
// ============================================

/**
 * Configuration for retry and circuit breaker behavior.
 */
export interface ResilienceConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay between retries in ms */
  initialBackoffMs: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Maximum delay between retries in ms */
  maxBackoffMs: number;
  /** Random jitter factor (0-1) */
  jitter: number;
  /** Failures before circuit opens */
  failureThreshold: number;
  /** Time before attempting recovery in ms */
  recoveryTimeoutMs: number;
  /** Successes needed in half-open to close */
  halfOpenSuccesses: number;
}

/**
 * Default resilience configuration.
 */
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

/**
 * Calculate backoff delay with exponential increase and jitter.
 */
export function calculateBackoff(
  attempt: number,
  config: ResilienceConfig
): number {
  const delay = Math.min(
    config.initialBackoffMs * Math.pow(config.backoffMultiplier, attempt),
    config.maxBackoffMs
  );

  // Add jitter
  const jitterRange = delay * config.jitter;
  const jitter = Math.random() * jitterRange * 2 - jitterRange;

  return Math.max(0, delay + jitter);
}

/**
 * Sleep for specified milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Rate limits, timeouts, server errors
    if (
      message.includes('rate') ||
      message.includes('429') ||
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

/**
 * Check if circuit should allow request.
 */
export function shouldAllowRequest(
  state: CircuitBreakerState,
  config: ResilienceConfig
): boolean {
  const now = Date.now();

  switch (state.state) {
    case 'closed':
      return true;

    case 'open':
      // Check if recovery timeout has elapsed
      if (now - state.lastFailure >= config.recoveryTimeoutMs) {
        // Transition to half-open
        state.state = 'half_open';
        state.successes = 0;
        return true;
      }
      return false;

    case 'half_open':
      // Allow limited requests to test recovery
      return true;
  }
}

/**
 * Record a successful request.
 */
export function recordSuccess(
  state: CircuitBreakerState,
  config: ResilienceConfig
): void {
  state.lastSuccess = Date.now();
  state.successes++;

  if (state.state === 'half_open') {
    if (state.successes >= config.halfOpenSuccesses) {
      // Circuit recovered
      state.state = 'closed';
      state.failures = 0;
    }
  } else if (state.state === 'closed') {
    // Reset failure count on success
    state.failures = 0;
  }
}

/**
 * Record a failed request.
 */
export function recordFailure(
  state: CircuitBreakerState,
  config: ResilienceConfig
): void {
  state.lastFailure = Date.now();
  state.failures++;

  if (state.state === 'half_open') {
    // Immediate trip on failure in half-open
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

/**
 * Error thrown when circuit is open.
 */
export class CircuitOpenError extends Error {
  constructor(key: string) {
    super(`Circuit breaker is open for: ${key}`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Error thrown when all retries exhausted.
 * Preserves the underlying error message for debugging.
 */
export class RetriesExhaustedError extends Error {
  public readonly lastError: Error;
  public readonly attempts: number;

  constructor(message: string, lastError: Error, attempts: number) {
    // Include the underlying error message so it surfaces to users
    const underlyingMessage = lastError.message;
    super(`${message} after ${attempts} attempts: ${underlyingMessage}`);
    this.name = 'RetriesExhaustedError';
    this.lastError = lastError;
    this.attempts = attempts;
    // Preserve the stack trace from the original error
    if (lastError.stack) {
      this.stack = `${this.stack}\nCaused by: ${lastError.stack}`;
    }
  }
}

/**
 * Options for resilient call.
 */
export interface ResilientCallOptions {
  config?: Partial<ResilienceConfig>;
  circuitState?: CircuitBreakerState;
  circuitKey?: string;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Execute a function with retry and circuit breaker logic.
 */
export async function resilientCall<T>(
  fn: () => Promise<T>,
  options: ResilientCallOptions = {}
): Promise<T> {
  const config: ResilienceConfig = {
    ...DEFAULT_RESILIENCE_CONFIG,
    ...options.config,
  };

  const state = options.circuitState ?? createCircuitState();
  const key = options.circuitKey ?? 'default';

  // Check circuit breaker
  if (!shouldAllowRequest(state, config)) {
    throw new CircuitOpenError(key);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn();
      recordSuccess(state, config);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (attempt < config.maxRetries && isRetryableError(error)) {
        const delayMs = calculateBackoff(attempt, config);
        options.onRetry?.(attempt + 1, lastError, delayMs);
        await sleep(delayMs);
      } else {
        // No more retries or non-retryable error
        recordFailure(state, config);
        break;
      }
    }
  }

  throw new RetriesExhaustedError(
    'All retries failed',
    lastError!,
    config.maxRetries + 1
  );
}
