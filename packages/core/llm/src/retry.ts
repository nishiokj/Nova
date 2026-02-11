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
 * Error thrown when an operation times out.
 */
export class TimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wrap a promise with a timeout.
 * If the promise doesn't resolve within timeoutMs, rejects with TimeoutError.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string = 'Operation'
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`${operationName} timed out after ${timeoutMs}ms`, timeoutMs));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Check if an error is retryable.
 * RateLimitErrors are handled specially - only retry if worth waiting.
 * Other transient errors (timeout, overload) are retryable.
 */
export function isRetryableError(error: unknown): boolean {
  // RateLimitErrors: only retry if it's a short window we can wait for
  if (error instanceof RateLimitError) {
    return error.isWorthWaiting();
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Generic 429 without RateLimitError wrapper - don't retry (let it bubble up)
    if (message.includes('429') || message.includes('rate limit')) {
      return false;
    }
    // Transient errors: timeouts, server overloads - worth retrying
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
 * Rate limit type classification.
 * - 'window': Short-term limit (per-minute, per-second) - worth waiting
 * - 'quota': Daily/weekly/monthly quota exceeded - not worth waiting
 * - 'billing': Account billing limit - requires user action
 * - 'unknown': Couldn't determine the type
 */
export type RateLimitType = 'window' | 'quota' | 'billing' | 'unknown';

/**
 * Parsed rate limit information from headers and error response.
 */
export interface RateLimitInfo {
  type: RateLimitType;
  retryAfterMs?: number;
  limitType?: string; // e.g., 'tokens', 'requests'
  remaining?: number;
  resetAt?: Date;
  message: string;
}

/**
 * Error thrown when rate limit is hit.
 * Contains metadata to allow callers to decide how to handle.
 */
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

  /**
   * Check if this rate limit is worth waiting for (short window).
   * Returns true if retryAfterMs is defined and <= 60 seconds.
   */
  isWorthWaiting(maxWaitMs: number = 60000): boolean {
    if (this.info.type === 'quota' || this.info.type === 'billing') {
      return false;
    }
    if (this.info.retryAfterMs && this.info.retryAfterMs <= maxWaitMs) {
      return true;
    }
    return false;
  }

  /**
   * Check if an error is a RateLimitError.
   */
  static isRateLimitError(error: unknown): error is RateLimitError {
    return error instanceof RateLimitError;
  }
}

/**
 * Error thrown when all retries exhausted.
 * Preserves the underlying error via standard .cause property.
 */
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

/**
 * Options for resilient call.
 */
export interface ResilientCallOptions {
  config?: Partial<ResilienceConfig>;
  circuitState?: CircuitBreakerState;
  circuitKey?: string;
  /** Timeout for each attempt in ms. If not set, no timeout is applied. */
  timeoutMs?: number;
  /** Name of the operation for timeout error messages */
  operationName?: string;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Execute a function with retry, circuit breaker, and optional timeout.
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
  const { timeoutMs, operationName = 'LLM call' } = options;

  // Check circuit breaker
  if (!shouldAllowRequest(state, config)) {
    throw new CircuitOpenError(key);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      // Apply timeout wrapper if configured
      const result = timeoutMs
        ? await withTimeout(fn(), timeoutMs, operationName)
        : await fn();
      recordSuccess(state, config);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // TimeoutError is retryable - the operation may have been transiently slow
      const isTimeout = error instanceof TimeoutError;

      // Check if we should retry
      if (attempt < config.maxRetries && (isRetryableError(error) || isTimeout)) {
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
