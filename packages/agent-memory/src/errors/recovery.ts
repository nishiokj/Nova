/**
 * Error Recovery Strategies
 *
 * Utilities for handling errors with retry logic,
 * backoff strategies, and recovery patterns.
 */

import type { ErrorCode, ErrorContext } from './types.js'
import {
  AgentMemoryError,
  isRetryableError,
  isRateLimitError,
  RateLimitError,
  TimeoutError,
  wrapError,
} from './types.js'

// ============ Retry Configuration ============

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number
  /** Initial delay between retries in ms */
  initialDelayMs: number
  /** Maximum delay between retries in ms */
  maxDelayMs: number
  /** Backoff multiplier */
  backoffMultiplier: number
  /** Add jitter to delay */
  jitter: boolean
  /** Function to determine if error is retryable */
  retryIf?: (error: AgentMemoryError, attempt: number) => boolean
  /** Callback on each retry */
  onRetry?: (error: AgentMemoryError, attempt: number, delayMs: number) => void
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
}

// ============ Backoff Strategies ============

/**
 * Calculate exponential backoff delay.
 */
export function exponentialBackoff(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  multiplier: number = 2,
  jitter: boolean = true
): number {
  const delay = Math.min(
    initialDelayMs * Math.pow(multiplier, attempt - 1),
    maxDelayMs
  )

  if (jitter) {
    // Add +/- 25% jitter
    const jitterRange = delay * 0.25
    return delay + (Math.random() * 2 - 1) * jitterRange
  }

  return delay
}

/**
 * Calculate delay with rate limit awareness.
 */
export function rateLimitAwareDelay(
  error: unknown,
  fallbackDelayMs: number = 5000
): number {
  if (isRateLimitError(error)) {
    return error.retryAfter
  }
  return fallbackDelayMs
}

// ============ Retry Execution ============

/**
 * Result of a retry operation.
 */
export interface RetryResult<T> {
  success: boolean
  value?: T
  attempts: number
  errors: AgentMemoryError[]
  totalDelayMs: number
}

/**
 * Execute a function with retry logic.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  config: Partial<RetryConfig> = {},
  context?: ErrorContext
): Promise<RetryResult<T>> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config }
  const errors: AgentMemoryError[] = []
  let totalDelayMs = 0

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      const value = await operation(attempt)
      return {
        success: true,
        value,
        attempts: attempt,
        errors,
        totalDelayMs,
      }
    } catch (err) {
      const error = wrapError(err, undefined, context)
      errors.push(error)

      // Check if we should retry
      const shouldRetry =
        attempt < cfg.maxAttempts &&
        (cfg.retryIf?.(error, attempt) ?? isRetryableError(error))

      if (!shouldRetry) {
        return {
          success: false,
          attempts: attempt,
          errors,
          totalDelayMs,
        }
      }

      // Calculate delay
      let delayMs: number
      if (isRateLimitError(error)) {
        delayMs = error.retryAfter
      } else {
        delayMs = exponentialBackoff(
          attempt,
          cfg.initialDelayMs,
          cfg.maxDelayMs,
          cfg.backoffMultiplier,
          cfg.jitter
        )
      }

      // Notify callback
      cfg.onRetry?.(error, attempt, delayMs)

      // Wait before retry
      await sleep(delayMs)
      totalDelayMs += delayMs
    }
  }

  // Should not reach here
  return {
    success: false,
    attempts: cfg.maxAttempts,
    errors,
    totalDelayMs,
  }
}

/**
 * Execute a function with retry, throwing on failure.
 */
export async function retryOrThrow<T>(
  operation: (attempt: number) => Promise<T>,
  config: Partial<RetryConfig> = {},
  context?: ErrorContext
): Promise<T> {
  const result = await withRetry(operation, config, context)

  if (result.success && result.value !== undefined) {
    return result.value
  }

  // Throw the last error
  const lastError = result.errors[result.errors.length - 1]
  if (lastError) {
    throw lastError
  }

  throw new AgentMemoryError(
    'Retry failed with no error captured',
    'INTERNAL_UNKNOWN' as ErrorCode,
    { context }
  )
}

// ============ Timeout Handling ============

/**
 * Execute a function with a timeout.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  context?: ErrorContext
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new TimeoutError(`Operation timed out after ${timeoutMs}ms`, {
          timeoutMs,
          context,
        })
      )
    }, timeoutMs)
  })

  try {
    return await Promise.race([operation, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

/**
 * Execute with both timeout and retry.
 */
export async function withTimeoutAndRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    timeoutMs: number
    retry?: Partial<RetryConfig>
    context?: ErrorContext
  }
): Promise<T> {
  return retryOrThrow(
    async (attempt) => {
      return withTimeout(operation(attempt), options.timeoutMs, options.context)
    },
    options.retry,
    options.context
  )
}

// ============ Circuit Breaker ============

/**
 * Circuit breaker state.
 */
export type CircuitState = 'closed' | 'open' | 'half-open'

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening */
  failureThreshold: number
  /** Time before attempting half-open in ms */
  resetTimeoutMs: number
  /** Number of successes in half-open to close */
  successThreshold: number
  /** Function to determine if error should trip breaker */
  shouldTrip?: (error: AgentMemoryError) => boolean
  /** Callback when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void
}

/**
 * Default circuit breaker configuration.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  successThreshold: 2,
}

/**
 * Simple circuit breaker implementation.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private successCount = 0
  private lastFailureTime?: number
  private readonly config: CircuitBreakerConfig

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
  }

  /**
   * Get current state.
   */
  getState(): CircuitState {
    return this.state
  }

  /**
   * Check if circuit allows requests.
   */
  isAllowed(): boolean {
    if (this.state === 'closed') {
      return true
    }

    if (this.state === 'open') {
      // Check if we should transition to half-open
      const elapsed = Date.now() - (this.lastFailureTime ?? 0)
      if (elapsed >= this.config.resetTimeoutMs) {
        this.transition('half-open')
        return true
      }
      return false
    }

    // half-open: allow one request
    return true
  }

  /**
   * Record a successful operation.
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++
      if (this.successCount >= this.config.successThreshold) {
        this.transition('closed')
      }
    } else {
      this.failureCount = 0
    }
  }

  /**
   * Record a failed operation.
   */
  recordFailure(error: AgentMemoryError): void {
    // Check if this error should trip the breaker
    if (this.config.shouldTrip && !this.config.shouldTrip(error)) {
      return
    }

    this.lastFailureTime = Date.now()

    if (this.state === 'half-open') {
      // Any failure in half-open goes back to open
      this.transition('open')
    } else {
      this.failureCount++
      if (this.failureCount >= this.config.failureThreshold) {
        this.transition('open')
      }
    }
  }

  /**
   * Execute operation with circuit breaker protection.
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.isAllowed()) {
      throw new AgentMemoryError(
        'Circuit breaker is open',
        'HTTP_CIRCUIT_OPEN' as ErrorCode,
        {
          retryable: false,
          context: { circuitState: this.state },
        }
      )
    }

    try {
      const result = await operation()
      this.recordSuccess()
      return result
    } catch (err) {
      const error = wrapError(err)
      this.recordFailure(error)
      throw error
    }
  }

  /**
   * Manually reset the circuit breaker.
   */
  reset(): void {
    this.transition('closed')
  }

  private transition(newState: CircuitState): void {
    const oldState = this.state
    if (oldState === newState) return

    this.state = newState
    this.failureCount = 0
    this.successCount = 0

    this.config.onStateChange?.(oldState, newState)
  }
}

// ============ Partial Failure Handling ============

/**
 * Result of a batch operation that may have partial failures.
 */
export interface BatchResult<T, E = AgentMemoryError> {
  /** Successfully processed items */
  succeeded: T[]
  /** Failed items with their errors */
  failed: Array<{ item: unknown; error: E }>
  /** Total items attempted */
  total: number
  /** Whether all items succeeded */
  allSucceeded: boolean
  /** Whether any items succeeded */
  anySucceeded: boolean
}

/**
 * Process items in batch with partial failure handling.
 */
export async function processBatch<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  options: {
    /** Stop on first error */
    failFast?: boolean
    /** Maximum concurrent operations */
    concurrency?: number
    /** Wrap errors with context */
    context?: ErrorContext
  } = {}
): Promise<BatchResult<R>> {
  const { failFast = false, concurrency = 1, context } = options
  const succeeded: R[] = []
  const failed: Array<{ item: unknown; error: AgentMemoryError }> = []

  if (concurrency <= 1) {
    // Sequential processing
    for (let i = 0; i < items.length; i++) {
      try {
        const result = await processor(items[i], i)
        succeeded.push(result)
      } catch (err) {
        const error = wrapError(err, undefined, {
          ...context,
          batchIndex: i,
        })
        failed.push({ item: items[i], error })
        if (failFast) break
      }
    }
  } else {
    // Concurrent processing with limited parallelism
    const chunks = chunkArray(items, concurrency)
    for (const chunk of chunks) {
      const startIndex = items.indexOf(chunk[0])
      const results = await Promise.allSettled(
        chunk.map((item, idx) => processor(item, startIndex + idx))
      )

      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.status === 'fulfilled') {
          succeeded.push(result.value)
        } else {
          const error = wrapError(result.reason, undefined, {
            ...context,
            batchIndex: startIndex + i,
          })
          failed.push({ item: chunk[i], error })
          if (failFast) break
        }
      }

      if (failFast && failed.length > 0) break
    }
  }

  return {
    succeeded,
    failed,
    total: items.length,
    allSucceeded: failed.length === 0,
    anySucceeded: succeeded.length > 0,
  }
}

// ============ Helpers ============

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Chunk an array into smaller arrays.
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}
