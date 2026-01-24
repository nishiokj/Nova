/**
 * Error Handling Tests
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import {
  // Error classes
  AgentMemoryError,
  AuthenticationError,
  TokenExpiredError,
  NetworkError,
  TimeoutError,
  RateLimitError,
  ValidationError,
  DatabaseError,
  SyncError,
  ConnectorError,
  QueueError,
  ResolutionError,
  InternalError,
  AssertionError,
  NotImplementedError,
  // Constants
  ErrorCode,
  ErrorCategory,
  // Type guards
  isAgentMemoryError,
  isRetryableError,
  isRateLimitError,
  isAuthError,
  isValidationError,
  // Utilities
  wrapError,
  deserializeError,
} from './types.js'

import {
  // Recovery utilities
  exponentialBackoff,
  rateLimitAwareDelay,
  withRetry,
  retryOrThrow,
  withTimeout,
  withTimeoutAndRetry,
  CircuitBreaker,
  processBatch,
  DEFAULT_RETRY_CONFIG,
} from './recovery.js'

import { z } from 'zod'

// ============ Error Types Tests ============

describe('AgentMemoryError', () => {
  test('creates error with all properties', () => {
    const error = new AgentMemoryError('Test error', ErrorCode.INTERNAL_UNKNOWN, {
      category: ErrorCategory.INTERNAL,
      severity: 'error',
      retryable: false,
      context: { foo: 'bar' },
    })

    expect(error.message).toBe('Test error')
    expect(error.code).toBe(ErrorCode.INTERNAL_UNKNOWN)
    expect(error.category).toBe(ErrorCategory.INTERNAL)
    expect(error.severity).toBe('error')
    expect(error.retryable).toBe(false)
    expect(error.context).toEqual({ foo: 'bar' })
    expect(error.timestamp).toBeInstanceOf(Date)
  })

  test('infers category from code', () => {
    const authError = new AgentMemoryError('Auth', ErrorCode.AUTH_INVALID)
    expect(authError.category).toBe(ErrorCategory.AUTH)

    const networkError = new AgentMemoryError('Network', ErrorCode.NETWORK_TIMEOUT)
    expect(networkError.category).toBe(ErrorCategory.NETWORK)

    const dbError = new AgentMemoryError('DB', ErrorCode.DATABASE_QUERY)
    expect(dbError.category).toBe(ErrorCategory.DATABASE)
  })

  test('withContext adds context', () => {
    const error = new AgentMemoryError('Test', ErrorCode.INTERNAL_UNKNOWN)
    error.withContext({ jobId: '123' })
    expect(error.context.jobId).toBe('123')
  })

  test('serializes to JSON', () => {
    const error = new AgentMemoryError('Test error', ErrorCode.SYNC_PROCESS, {
      retryable: true,
      context: { operation: 'sync' },
    })

    const json = error.toJSON()
    expect(json.name).toBe('AgentMemoryError')
    expect(json.message).toBe('Test error')
    expect(json.code).toBe(ErrorCode.SYNC_PROCESS)
    expect(json.retryable).toBe(true)
    expect(json.context).toEqual({ operation: 'sync' })
    expect(json.timestamp).toBeDefined()
  })

  test('toString returns readable format', () => {
    const error = new AgentMemoryError('Test error', ErrorCode.SYNC_PROCESS, {
      retryable: true,
    })

    const str = error.toString()
    expect(str).toContain('SYNC_PROCESS')
    expect(str).toContain('Test error')
    expect(str).toContain('retryable')
  })
})

describe('Specialized Error Classes', () => {
  test('AuthenticationError', () => {
    const error = new AuthenticationError('Invalid credentials')
    expect(error.name).toBe('AuthenticationError')
    expect(error.code).toBe(ErrorCode.AUTH_INVALID)
    expect(error.category).toBe(ErrorCategory.AUTH)
    expect(error.retryable).toBe(false)
  })

  test('TokenExpiredError', () => {
    const error = new TokenExpiredError()
    expect(error.name).toBe('TokenExpiredError')
    expect(error.code).toBe(ErrorCode.AUTH_EXPIRED)
    expect(error.retryable).toBe(true) // Can retry after refresh
  })

  test('NetworkError', () => {
    const error = new NetworkError('Connection failed')
    expect(error.name).toBe('NetworkError')
    expect(error.category).toBe(ErrorCategory.NETWORK)
    expect(error.retryable).toBe(true)
  })

  test('TimeoutError', () => {
    const error = new TimeoutError('Timed out', { timeoutMs: 5000 })
    expect(error.name).toBe('TimeoutError')
    expect(error.code).toBe(ErrorCode.NETWORK_TIMEOUT)
    expect(error.context.timeoutMs).toBe(5000)
  })

  test('RateLimitError', () => {
    const error = new RateLimitError('Rate limited', { retryAfter: 60000 })
    expect(error.name).toBe('RateLimitError')
    expect(error.code).toBe(ErrorCode.HTTP_RATE_LIMITED)
    expect(error.retryAfter).toBe(60000)
    expect(error.retryable).toBe(true)
  })

  test('ValidationError with Zod error', () => {
    const schema = z.object({ name: z.string() })
    let zodError: z.ZodError | undefined
    try {
      schema.parse({ name: 123 })
    } catch (e) {
      zodError = e as z.ZodError
    }

    const error = new ValidationError('Validation failed', { zodError })
    expect(error.name).toBe('ValidationError')
    expect(error.zodError).toBeDefined()
    expect(error.violations.length).toBeGreaterThan(0)
    expect(error.retryable).toBe(false)
  })

  test('DatabaseError', () => {
    const error = new DatabaseError('Query failed', ErrorCode.DATABASE_QUERY)
    expect(error.name).toBe('DatabaseError')
    expect(error.category).toBe(ErrorCategory.DATABASE)
  })

  test('SyncError', () => {
    const error = new SyncError('Sync failed', ErrorCode.SYNC_PROCESS)
    expect(error.name).toBe('SyncError')
    expect(error.category).toBe(ErrorCategory.SYNC)
    expect(error.retryable).toBe(true)
  })

  test('ConnectorError', () => {
    const error = new ConnectorError('API error')
    expect(error.name).toBe('ConnectorError')
    expect(error.category).toBe(ErrorCategory.CONNECTOR)
  })

  test('QueueError', () => {
    const error = new QueueError('Job failed')
    expect(error.name).toBe('QueueError')
    expect(error.category).toBe(ErrorCategory.QUEUE)
  })

  test('ResolutionError', () => {
    const error = new ResolutionError('Merge conflict')
    expect(error.name).toBe('ResolutionError')
    expect(error.category).toBe(ErrorCategory.RESOLUTION)
  })

  test('InternalError', () => {
    const error = new InternalError('Bug')
    expect(error.name).toBe('InternalError')
    expect(error.severity).toBe('fatal')
    expect(error.retryable).toBe(false)
  })

  test('AssertionError', () => {
    const error = new AssertionError('Invariant violated')
    expect(error.name).toBe('AssertionError')
    expect(error.code).toBe(ErrorCode.INTERNAL_ASSERTION)
  })

  test('NotImplementedError', () => {
    const error = new NotImplementedError('Feature X')
    expect(error.name).toBe('NotImplementedError')
    expect(error.code).toBe(ErrorCode.INTERNAL_NOT_IMPLEMENTED)
  })
})

describe('Type Guards', () => {
  test('isAgentMemoryError', () => {
    expect(isAgentMemoryError(new AgentMemoryError('test', ErrorCode.INTERNAL_UNKNOWN))).toBe(true)
    expect(isAgentMemoryError(new AuthenticationError('test'))).toBe(true)
    expect(isAgentMemoryError(new Error('test'))).toBe(false)
    expect(isAgentMemoryError('not an error')).toBe(false)
  })

  test('isRetryableError', () => {
    expect(isRetryableError(new RateLimitError())).toBe(true)
    expect(isRetryableError(new NetworkError('test'))).toBe(true)
    expect(isRetryableError(new ValidationError('test'))).toBe(false)
    expect(isRetryableError(new Error('test'))).toBe(false)
  })

  test('isRateLimitError', () => {
    expect(isRateLimitError(new RateLimitError())).toBe(true)
    expect(isRateLimitError(new NetworkError('test'))).toBe(false)
  })

  test('isAuthError', () => {
    expect(isAuthError(new AuthenticationError('test'))).toBe(true)
    expect(isAuthError(new TokenExpiredError())).toBe(true)
    expect(isAuthError(new NetworkError('test'))).toBe(false)
  })

  test('isValidationError', () => {
    expect(isValidationError(new ValidationError('test'))).toBe(true)
    expect(isValidationError(new NetworkError('test'))).toBe(false)
  })
})

describe('Error Utilities', () => {
  test('wrapError wraps unknown error', () => {
    const original = new Error('Original error')
    const wrapped = wrapError(original, 'Wrapped message')

    expect(wrapped).toBeInstanceOf(AgentMemoryError)
    expect(wrapped.message).toBe('Wrapped message')
    expect(wrapped.cause).toBe(original)
  })

  test('wrapError returns AgentMemoryError unchanged', () => {
    const original = new AuthenticationError('Auth error')
    const wrapped = wrapError(original)

    expect(wrapped).toBe(original)
  })

  test('wrapError adds context', () => {
    const wrapped = wrapError(new Error('test'), undefined, { jobId: '123' })
    expect(wrapped.context.jobId).toBe('123')
  })

  test('deserializeError recreates error', () => {
    const original = new AgentMemoryError('Test', ErrorCode.SYNC_PROCESS, {
      retryable: true,
      context: { foo: 'bar' },
    })

    const serialized = original.toJSON()
    const deserialized = deserializeError(serialized)

    expect(deserialized.message).toBe(original.message)
    expect(deserialized.code).toBe(original.code)
    expect(deserialized.retryable).toBe(original.retryable)
    expect(deserialized.context).toEqual(original.context)
  })
})

// ============ Recovery Tests ============

describe('Backoff Strategies', () => {
  test('exponentialBackoff calculates correct delays', () => {
    const delay1 = exponentialBackoff(1, 1000, 30000, 2, false)
    expect(delay1).toBe(1000)

    const delay2 = exponentialBackoff(2, 1000, 30000, 2, false)
    expect(delay2).toBe(2000)

    const delay3 = exponentialBackoff(3, 1000, 30000, 2, false)
    expect(delay3).toBe(4000)
  })

  test('exponentialBackoff respects max delay', () => {
    const delay = exponentialBackoff(10, 1000, 5000, 2, false)
    expect(delay).toBe(5000)
  })

  test('exponentialBackoff adds jitter', () => {
    const delays = new Set<number>()
    for (let i = 0; i < 10; i++) {
      delays.add(exponentialBackoff(1, 1000, 30000, 2, true))
    }
    // With jitter, we should get different values
    expect(delays.size).toBeGreaterThan(1)
  })

  test('rateLimitAwareDelay extracts from RateLimitError', () => {
    const error = new RateLimitError('test', { retryAfter: 5000 })
    expect(rateLimitAwareDelay(error)).toBe(5000)
  })

  test('rateLimitAwareDelay returns fallback for other errors', () => {
    expect(rateLimitAwareDelay(new Error('test'), 3000)).toBe(3000)
  })
})

describe('withRetry', () => {
  test('returns success on first attempt', async () => {
    const result = await withRetry(async () => 'success')
    expect(result.success).toBe(true)
    expect(result.value).toBe('success')
    expect(result.attempts).toBe(1)
    expect(result.errors).toHaveLength(0)
  })

  test('retries on retryable errors', async () => {
    let attempts = 0
    const result = await withRetry(
      async () => {
        attempts++
        if (attempts < 3) {
          throw new NetworkError('Temporary failure')
        }
        return 'success'
      },
      { maxAttempts: 5, initialDelayMs: 10 }
    )

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(3)
    expect(result.errors).toHaveLength(2)
  })

  test('stops on non-retryable errors', async () => {
    const result = await withRetry(
      async () => {
        throw new ValidationError('Invalid input')
      },
      { maxAttempts: 5 }
    )

    expect(result.success).toBe(false)
    expect(result.attempts).toBe(1)
  })

  test('respects maxAttempts', async () => {
    const result = await withRetry(
      async () => {
        throw new NetworkError('Always fails')
      },
      { maxAttempts: 3, initialDelayMs: 10 }
    )

    expect(result.success).toBe(false)
    expect(result.attempts).toBe(3)
    expect(result.errors).toHaveLength(3)
  })

  test('calls onRetry callback', async () => {
    const retries: number[] = []
    await withRetry(
      async (attempt) => {
        if (attempt < 3) {
          throw new NetworkError('Fail')
        }
        return 'ok'
      },
      {
        maxAttempts: 5,
        initialDelayMs: 10,
        onRetry: (_err, attempt) => retries.push(attempt),
      }
    )

    expect(retries).toEqual([1, 2])
  })
})

describe('retryOrThrow', () => {
  test('returns value on success', async () => {
    const result = await retryOrThrow(async () => 'success')
    expect(result).toBe('success')
  })

  test('throws last error on failure', async () => {
    await expect(
      retryOrThrow(
        async () => {
          throw new NetworkError('Always fails')
        },
        { maxAttempts: 2, initialDelayMs: 10 }
      )
    ).rejects.toThrow('Always fails')
  })
})

describe('withTimeout', () => {
  test('returns value before timeout', async () => {
    const result = await withTimeout(
      new Promise<string>(resolve => setTimeout(() => resolve('done'), 10)),
      1000
    )
    expect(result).toBe('done')
  })

  test('throws TimeoutError on timeout', async () => {
    await expect(
      withTimeout(
        new Promise(resolve => setTimeout(resolve, 1000)),
        10
      )
    ).rejects.toThrow(TimeoutError)
  })
})

describe('withTimeoutAndRetry', () => {
  test('combines timeout and retry', async () => {
    let attempts = 0
    const result = await withTimeoutAndRetry(
      async () => {
        attempts++
        if (attempts < 2) {
          throw new NetworkError('Fail')
        }
        return 'success'
      },
      {
        timeoutMs: 1000,
        retry: { maxAttempts: 3, initialDelayMs: 10 },
      }
    )

    expect(result).toBe('success')
    expect(attempts).toBe(2)
  })
})

describe('CircuitBreaker', () => {
  test('starts in closed state', () => {
    const breaker = new CircuitBreaker()
    expect(breaker.getState()).toBe('closed')
    expect(breaker.isAllowed()).toBe(true)
  })

  test('opens after failure threshold', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 })

    for (let i = 0; i < 3; i++) {
      breaker.recordFailure(new NetworkError('fail'))
    }

    expect(breaker.getState()).toBe('open')
    expect(breaker.isAllowed()).toBe(false)
  })

  test('resets failure count on success', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 })

    breaker.recordFailure(new NetworkError('fail'))
    breaker.recordFailure(new NetworkError('fail'))
    breaker.recordSuccess()
    breaker.recordFailure(new NetworkError('fail'))

    expect(breaker.getState()).toBe('closed')
  })

  test('transitions to half-open after reset timeout', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 })

    breaker.recordFailure(new NetworkError('fail'))
    expect(breaker.getState()).toBe('open')
    expect(breaker.isAllowed()).toBe(false)

    await new Promise(r => setTimeout(r, 60))

    expect(breaker.isAllowed()).toBe(true)
    expect(breaker.getState()).toBe('half-open')
  })

  test('closes after success in half-open', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 10,
      successThreshold: 1,
    })

    breaker.recordFailure(new NetworkError('fail'))
    await new Promise(r => setTimeout(r, 20))
    breaker.isAllowed() // Triggers transition to half-open

    breaker.recordSuccess()
    expect(breaker.getState()).toBe('closed')
  })

  test('execute wraps function with circuit breaker', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 })

    const result = await breaker.execute(async () => 'success')
    expect(result).toBe('success')

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.execute(async () => {
          throw new NetworkError('fail')
        })
      } catch {
        // Expected
      }
    }

    // Should reject immediately
    await expect(breaker.execute(async () => 'success')).rejects.toThrow(
      'Circuit breaker is open'
    )
  })

  test('calls onStateChange callback', () => {
    const transitions: Array<{ from: string; to: string }> = []
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      onStateChange: (from, to) => transitions.push({ from, to }),
    })

    breaker.recordFailure(new NetworkError('fail'))
    breaker.reset()

    expect(transitions).toEqual([
      { from: 'closed', to: 'open' },
      { from: 'open', to: 'closed' },
    ])
  })
})

describe('processBatch', () => {
  test('processes all items successfully', async () => {
    const items = [1, 2, 3, 4, 5]
    const result = await processBatch(items, async (item) => item * 2)

    expect(result.allSucceeded).toBe(true)
    expect(result.anySucceeded).toBe(true)
    expect(result.succeeded).toEqual([2, 4, 6, 8, 10])
    expect(result.failed).toHaveLength(0)
    expect(result.total).toBe(5)
  })

  test('handles partial failures', async () => {
    const items = [1, 2, 3, 4, 5]
    const result = await processBatch(items, async (item) => {
      if (item === 3) {
        throw new Error('Item 3 failed')
      }
      return item * 2
    })

    expect(result.allSucceeded).toBe(false)
    expect(result.anySucceeded).toBe(true)
    expect(result.succeeded).toEqual([2, 4, 8, 10])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].item).toBe(3)
  })

  test('stops on failFast', async () => {
    const processed: number[] = []
    const result = await processBatch(
      [1, 2, 3, 4, 5],
      async (item) => {
        processed.push(item)
        if (item === 2) {
          throw new Error('Fail')
        }
        return item
      },
      { failFast: true }
    )

    expect(result.allSucceeded).toBe(false)
    expect(processed).toEqual([1, 2])
  })

  test('supports concurrency', async () => {
    const items = [1, 2, 3, 4, 5]
    const result = await processBatch(
      items,
      async (item) => {
        await new Promise(r => setTimeout(r, 10))
        return item * 2
      },
      { concurrency: 3 }
    )

    expect(result.allSucceeded).toBe(true)
    expect(result.succeeded.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10])
  })
})
