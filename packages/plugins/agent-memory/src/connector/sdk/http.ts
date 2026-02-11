/**
 * Resilient HTTP Client
 *
 * A production-grade HTTP client with:
 * - Connection timeout and request timeout
 * - Exponential backoff with jitter
 * - Circuit breaker pattern
 * - Token bucket rate limiting
 * - Request/response logging hooks
 * - Configurable retry policies
 *
 * @module connector/sdk/http
 */

import { z } from 'zod'

// ============ Configuration ============

/**
 * HTTP client configuration schema with sensible defaults.
 */
export const HttpClientConfigSchema = z.object({
  /** Connection timeout in milliseconds */
  connectTimeout: z.number().int().positive().default(5000),
  /** Request timeout in milliseconds (total time for request + response) */
  requestTimeout: z.number().int().positive().default(30000),
  /** Maximum retry attempts */
  maxRetries: z.number().int().nonnegative().default(3),
  /** HTTP status codes that trigger a retry */
  retryableStatuses: z.array(z.number().int()).default([429, 500, 502, 503, 504]),
  /** Base delay for exponential backoff (ms) */
  baseRetryDelay: z.number().int().positive().default(1000),
  /** Maximum delay between retries (ms) */
  maxRetryDelay: z.number().int().positive().default(30000),
  /** Maximum requests per second (rate limiting) */
  maxRequestsPerSecond: z.number().positive().default(10),
  /** Number of failures before circuit breaker opens */
  circuitBreakerThreshold: z.number().int().positive().default(5),
  /** Time before circuit breaker attempts half-open (ms) */
  circuitBreakerResetMs: z.number().int().positive().default(30000),
  /** Maximum concurrent connections */
  maxConnections: z.number().int().positive().default(10),
  /** Enable debug logging */
  debug: z.boolean().default(false),
})

export type HttpClientConfig = z.infer<typeof HttpClientConfigSchema>

// ============ Request/Response Types ============

/**
 * HTTP methods supported by the client.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/**
 * Request options for the HTTP client.
 */
export interface RequestOptions {
  /** HTTP method (default: GET) */
  method?: HttpMethod
  /** Request headers */
  headers?: Record<string, string>
  /** Request body (will be JSON stringified if object) */
  body?: unknown
  /** Query parameters */
  params?: Record<string, string | number | boolean | undefined>
  /** Override request timeout for this request */
  timeout?: number
  /** Skip retry logic for this request */
  noRetry?: boolean
  /** Skip rate limiting for this request */
  noRateLimit?: boolean
  /** Custom retry condition (return true to retry) */
  shouldRetry?: (response: HttpResponse<unknown>, attempt: number) => boolean
  /** Signal for request cancellation */
  signal?: AbortSignal
}

/**
 * HTTP response wrapper with metadata.
 */
export interface HttpResponse<T> {
  /** Response status code */
  status: number
  /** Response status text */
  statusText: string
  /** Response headers */
  headers: Headers
  /** Parsed response body */
  data: T
  /** Whether the request was successful (2xx status) */
  ok: boolean
  /** Response URL (may differ from request URL if redirected) */
  url: string
  /** Total request duration in milliseconds */
  durationMs: number
  /** Number of retry attempts made */
  retryCount: number
}

/**
 * Rate limit information extracted from response headers.
 */
export interface RateLimitHeaders {
  /** Remaining requests in the current window */
  remaining?: number
  /** Total requests allowed in the window */
  limit?: number
  /** When the rate limit resets (Unix timestamp in seconds) */
  resetsAt?: number
  /** Retry-After header value (seconds) */
  retryAfter?: number
}

// ============ Error Types ============

/**
 * Base HTTP error class.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly response?: HttpResponse<unknown>,
    public readonly metadata: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Request timeout error.
 */
export class TimeoutError extends HttpError {
  constructor(message: string, metadata: Record<string, unknown> = {}) {
    super(message, 'TIMEOUT', true, undefined, undefined, metadata)
    this.name = 'TimeoutError'
  }
}

/**
 * Network error (DNS failure, connection refused, etc.).
 */
export class NetworkError extends HttpError {
  constructor(message: string, public readonly cause?: Error, metadata: Record<string, unknown> = {}) {
    super(message, 'NETWORK_ERROR', true, undefined, undefined, metadata)
    this.name = 'NetworkError'
  }
}

/**
 * Rate limit exceeded error.
 */
export class HttpRateLimitError extends HttpError {
  constructor(
    message: string,
    public readonly retryAfter: number,
    response?: HttpResponse<unknown>,
    metadata: Record<string, unknown> = {}
  ) {
    super(message, 'RATE_LIMIT', true, 429, response, { ...metadata, retryAfter })
    this.name = 'HttpRateLimitError'
  }
}

/**
 * Circuit breaker is open error.
 */
export class CircuitBreakerOpenError extends HttpError {
  constructor(metadata: Record<string, unknown> = {}) {
    super('Circuit breaker is open', 'CIRCUIT_OPEN', false, undefined, undefined, metadata)
    this.name = 'CircuitBreakerOpenError'
  }
}

// ============ Token Bucket Rate Limiter ============

/**
 * Token bucket implementation for rate limiting.
 * Allows bursting up to bucket capacity while maintaining average rate.
 */
export class TokenBucket {
  private tokens: number
  private lastRefill: number
  private readonly tokensPerMs: number

  constructor(
    /** Maximum tokens (burst capacity) */
    private readonly capacity: number,
    /** Tokens added per second */
    private readonly refillRate: number
  ) {
    this.tokens = capacity
    this.lastRefill = Date.now()
    this.tokensPerMs = refillRate / 1000
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    const tokensToAdd = elapsed * this.tokensPerMs
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd)
    this.lastRefill = now
  }

  /**
   * Attempt to acquire a token. Returns immediately.
   * @returns true if token acquired, false otherwise
   */
  tryAcquire(): boolean {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /**
   * Wait until a token is available, then acquire it.
   * @param signal Optional abort signal
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    while (!this.tryAcquire()) {
      if (signal?.aborted) {
        throw new Error('Aborted while waiting for rate limit')
      }
      // Calculate wait time for next token
      const waitMs = Math.ceil((1 - this.tokens) / this.tokensPerMs)
      await sleep(Math.min(waitMs, 100), signal)
    }
  }

  /**
   * Get current token count (for monitoring).
   */
  getTokens(): number {
    this.refill()
    return this.tokens
  }

  /**
   * Get time until next token is available (ms).
   */
  getWaitTime(): number {
    this.refill()
    if (this.tokens >= 1) return 0
    return Math.ceil((1 - this.tokens) / this.tokensPerMs)
  }
}

// ============ Circuit Breaker ============

type CircuitState = 'closed' | 'open' | 'half-open'

/**
 * Circuit breaker implementation.
 * Prevents cascading failures by failing fast when a service is unhealthy.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private lastFailure: Date | null = null
  private halfOpenAttempts = 0

  constructor(
    /** Number of failures before opening */
    private readonly threshold: number,
    /** Time before attempting half-open (ms) */
    private readonly resetTimeout: number
  ) {}

  /**
   * Check if the circuit allows a request.
   * @throws {CircuitBreakerOpenError} if circuit is open
   */
  check(): void {
    this.updateState()
    if (this.state === 'open') {
      throw new CircuitBreakerOpenError({
        failureCount: this.failureCount,
        lastFailure: this.lastFailure?.toISOString(),
      })
    }
  }

  /**
   * Update circuit state based on elapsed time.
   */
  private updateState(): void {
    if (this.state !== 'open') return
    if (this.lastFailure && Date.now() - this.lastFailure.getTime() > this.resetTimeout) {
      this.state = 'half-open'
      this.halfOpenAttempts = 0
    }
  }

  /**
   * Record a successful request.
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      // One success in half-open closes the circuit
      this.state = 'closed'
      this.failureCount = 0
      this.lastFailure = null
    } else if (this.state === 'closed') {
      // Decay failure count on success
      this.failureCount = Math.max(0, this.failureCount - 1)
    }
  }

  /**
   * Record a failed request.
   */
  recordFailure(): void {
    this.failureCount++
    this.lastFailure = new Date()

    if (this.state === 'half-open') {
      // Any failure in half-open reopens the circuit
      this.state = 'open'
    } else if (this.state === 'closed' && this.failureCount >= this.threshold) {
      this.state = 'open'
    }
  }

  /**
   * Get current circuit state (for monitoring).
   */
  getState(): CircuitState {
    this.updateState()
    return this.state
  }

  /**
   * Get circuit breaker stats.
   */
  getStats(): { state: CircuitState; failureCount: number; lastFailure: Date | null } {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      lastFailure: this.lastFailure,
    }
  }

  /**
   * Manually reset the circuit breaker.
   */
  reset(): void {
    this.state = 'closed'
    this.failureCount = 0
    this.lastFailure = null
    this.halfOpenAttempts = 0
  }
}

// ============ Resilient HTTP Client ============

/**
 * Event hooks for request lifecycle.
 */
export interface HttpClientHooks {
  /** Called before each request attempt */
  onRequest?: (url: string, options: RequestOptions, attempt: number) => void
  /** Called after each response (success or error response) */
  onResponse?: (url: string, response: HttpResponse<unknown>, attempt: number) => void
  /** Called on retry */
  onRetry?: (url: string, error: Error, attempt: number, delayMs: number) => void
  /** Called on circuit breaker state change */
  onCircuitStateChange?: (oldState: CircuitState, newState: CircuitState) => void
}

/**
 * Resilient HTTP client with retry logic, rate limiting, and circuit breaker.
 */
export class ResilientHttpClient {
  private readonly config: HttpClientConfig
  private readonly rateLimiter: TokenBucket
  private readonly circuitBreaker: CircuitBreaker
  private readonly hooks: HttpClientHooks

  constructor(config: Partial<HttpClientConfig> = {}, hooks: HttpClientHooks = {}) {
    this.config = HttpClientConfigSchema.parse(config)
    this.rateLimiter = new TokenBucket(
      this.config.maxRequestsPerSecond * 2, // Allow 2-second burst
      this.config.maxRequestsPerSecond
    )
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerResetMs
    )
    this.hooks = hooks
  }

  /**
   * Make an HTTP request with automatic retries and resilience.
   */
  async request<T = unknown>(url: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    // Check circuit breaker
    this.circuitBreaker.check()

    // Wait for rate limit token (unless bypassed)
    if (!options.noRateLimit) {
      await this.rateLimiter.acquire(options.signal)
    }

    const startTime = Date.now()
    let lastError: Error | undefined
    const maxAttempts = options.noRetry ? 1 : this.config.maxRetries + 1

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.hooks.onRequest?.(url, options, attempt)
        const response = await this.executeRequest<T>(url, options)
        this.hooks.onResponse?.(url, response as HttpResponse<unknown>, attempt)

        // Record 5xx responses as circuit breaker failures
        const isServerError = response.status >= 500

        // Check if we should retry based on status code
        if (!response.ok && this.shouldRetry(response, attempt, maxAttempts, options)) {
          if (isServerError) {
            this.circuitBreaker.recordFailure()
          }
          const delay = this.getRetryDelay(response, attempt)
          this.hooks.onRetry?.(url, new HttpError(`HTTP ${response.status}`, 'HTTP_ERROR', true, response.status), attempt, delay)
          await sleep(delay, options.signal)
          continue
        }

        // Record success/failure for circuit breaker
        // 5xx = server failure (counts toward circuit breaker)
        // 2xx-4xx = success or client error (not a circuit breaker concern)
        if (isServerError) {
          this.circuitBreaker.recordFailure()
        } else {
          this.circuitBreaker.recordSuccess()
        }
        return response
      } catch (error) {
        lastError = error as Error

        if (error instanceof CircuitBreakerOpenError) {
          throw error
        }

        // Record failure for circuit breaker
        if (this.isCircuitBreakerFailure(error as Error)) {
          this.circuitBreaker.recordFailure()
        }

        // Check if we should retry
        if (attempt < maxAttempts && this.isRetryableError(error as Error)) {
          const delay = this.getRetryDelay(undefined, attempt)
          this.hooks.onRetry?.(url, error as Error, attempt, delay)
          await sleep(delay, options.signal)
          continue
        }

        throw error
      }
    }

    // Should not reach here, but TypeScript needs this
    throw lastError ?? new Error('Request failed')
  }

  /**
   * Execute a single HTTP request (no retry logic).
   */
  private async executeRequest<T>(url: string, options: RequestOptions): Promise<HttpResponse<T>> {
    const startTime = Date.now()
    const timeout = options.timeout ?? this.config.requestTimeout

    // Build URL with query params
    const fullUrl = this.buildUrl(url, options.params)

    // Build request options
    const fetchOptions: RequestInit = {
      method: options.method ?? 'GET',
      headers: this.buildHeaders(options.headers, options.body),
      signal: this.createTimeoutSignal(timeout, options.signal),
    }

    // Add body if present
    if (options.body !== undefined) {
      fetchOptions.body = typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
    }

    try {
      const response = await fetch(fullUrl, fetchOptions)
      const durationMs = Date.now() - startTime

      // Parse response body
      const data = await this.parseResponseBody<T>(response)

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data,
        ok: response.ok,
        url: response.url,
        durationMs,
        retryCount: 0, // Will be updated by caller
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError' || error.message.includes('timeout')) {
          throw new TimeoutError(`Request timed out after ${timeout}ms`, { url: fullUrl, timeout })
        }
        if (error.name === 'TypeError' || error.message.includes('fetch')) {
          throw new NetworkError(`Network error: ${error.message}`, error, { url: fullUrl })
        }
      }
      throw error
    }
  }

  /**
   * Build URL with query parameters.
   */
  private buildUrl(baseUrl: string, params?: Record<string, string | number | boolean | undefined>): string {
    if (!params) return baseUrl

    const url = new URL(baseUrl)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  /**
   * Build request headers.
   */
  private buildHeaders(
    customHeaders?: Record<string, string>,
    body?: unknown
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...customHeaders,
    }

    // Add Content-Type for requests with body
    if (body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }

    return headers
  }

  /**
   * Create an AbortSignal that times out.
   */
  private createTimeoutSignal(timeout: number, existingSignal?: AbortSignal): AbortSignal {
    const controller = new AbortController()

    const timeoutId = setTimeout(() => controller.abort(), timeout)

    // Clean up timeout if existing signal aborts
    existingSignal?.addEventListener('abort', () => {
      clearTimeout(timeoutId)
      controller.abort()
    })

    return controller.signal
  }

  /**
   * Parse response body based on content type.
   */
  private async parseResponseBody<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type') ?? ''

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T
    }

    if (contentType.includes('application/json')) {
      return response.json() as Promise<T>
    }

    // Return text for non-JSON responses
    return response.text() as unknown as T
  }

  /**
   * Determine if response should be retried.
   */
  private shouldRetry(
    response: HttpResponse<unknown>,
    attempt: number,
    maxAttempts: number,
    options: RequestOptions
  ): boolean {
    if (attempt >= maxAttempts) return false

    // Custom retry condition
    if (options.shouldRetry) {
      return options.shouldRetry(response, attempt)
    }

    // Retry on configured status codes
    return this.config.retryableStatuses.includes(response.status)
  }

  /**
   * Determine if error is retryable.
   */
  private isRetryableError(error: Error): boolean {
    if (error instanceof TimeoutError) return true
    if (error instanceof NetworkError) return true
    if (error instanceof HttpRateLimitError) return true
    if (error instanceof HttpError && error.retryable) return true
    return false
  }

  /**
   * Determine if error should count toward circuit breaker.
   */
  private isCircuitBreakerFailure(error: Error): boolean {
    // Network failures and timeouts count
    if (error instanceof TimeoutError) return true
    if (error instanceof NetworkError) return true
    // 5xx errors count, but not 4xx
    if (error instanceof HttpError && error.status && error.status >= 500) return true
    return false
  }

  /**
   * Calculate retry delay with exponential backoff and jitter.
   */
  private getRetryDelay(response: HttpResponse<unknown> | undefined, attempt: number): number {
    // Check Retry-After header for 429 responses
    if (response?.status === 429) {
      const retryAfter = this.parseRetryAfter(response.headers)
      if (retryAfter) {
        return Math.min(retryAfter * 1000, this.config.maxRetryDelay)
      }
    }

    // Exponential backoff with jitter
    const exponentialDelay = this.config.baseRetryDelay * Math.pow(2, attempt - 1)
    const jitter = Math.random() * 0.3 * exponentialDelay // 0-30% jitter
    const delay = Math.min(exponentialDelay + jitter, this.config.maxRetryDelay)

    return Math.round(delay)
  }

  /**
   * Parse Retry-After header value.
   */
  private parseRetryAfter(headers: Headers): number | undefined {
    const retryAfter = headers.get('retry-after')
    if (!retryAfter) return undefined

    // Retry-After can be seconds or HTTP-date
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds
    }

    // Try parsing as date
    const date = new Date(retryAfter)
    if (!isNaN(date.getTime())) {
      return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000))
    }

    return undefined
  }

  /**
   * Extract rate limit headers from response.
   */
  parseRateLimitHeaders(headers: Headers): RateLimitHeaders {
    const result: RateLimitHeaders = {}

    // Common header patterns
    const remainingHeaders = ['x-ratelimit-remaining', 'x-rate-limit-remaining', 'ratelimit-remaining']
    const limitHeaders = ['x-ratelimit-limit', 'x-rate-limit-limit', 'ratelimit-limit']
    const resetHeaders = ['x-ratelimit-reset', 'x-rate-limit-reset', 'ratelimit-reset']

    for (const header of remainingHeaders) {
      const value = headers.get(header)
      if (value) {
        result.remaining = parseInt(value, 10)
        break
      }
    }

    for (const header of limitHeaders) {
      const value = headers.get(header)
      if (value) {
        result.limit = parseInt(value, 10)
        break
      }
    }

    for (const header of resetHeaders) {
      const value = headers.get(header)
      if (value) {
        const parsed = parseInt(value, 10)
        // Could be Unix timestamp or seconds until reset
        result.resetsAt = parsed > 1e10 ? parsed / 1000 : parsed
        break
      }
    }

    const retryAfter = this.parseRetryAfter(headers)
    if (retryAfter !== undefined) {
      result.retryAfter = retryAfter
    }

    return result
  }

  // ============ Convenience Methods ============

  /**
   * Make a GET request.
   */
  async get<T = unknown>(url: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'GET' })
  }

  /**
   * Make a POST request.
   */
  async post<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'POST', body })
  }

  /**
   * Make a PUT request.
   */
  async put<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'PUT', body })
  }

  /**
   * Make a PATCH request.
   */
  async patch<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'PATCH', body })
  }

  /**
   * Make a DELETE request.
   */
  async delete<T = unknown>(url: string, options?: Omit<RequestOptions, 'method'>): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'DELETE' })
  }

  // ============ Monitoring ============

  /**
   * Get current client stats.
   */
  getStats(): {
    rateLimiter: { tokens: number; waitTime: number }
    circuitBreaker: { state: CircuitState; failureCount: number; lastFailure: Date | null }
  } {
    return {
      rateLimiter: {
        tokens: this.rateLimiter.getTokens(),
        waitTime: this.rateLimiter.getWaitTime(),
      },
      circuitBreaker: this.circuitBreaker.getStats(),
    }
  }

  /**
   * Reset the circuit breaker manually.
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset()
  }
}

// ============ Utilities ============

/**
 * Sleep for a given duration with optional abort signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    const timeoutId = setTimeout(resolve, ms)

    signal?.addEventListener('abort', () => {
      clearTimeout(timeoutId)
      reject(new Error('Aborted'))
    })
  })
}

/**
 * Create a pre-configured HTTP client for a specific API.
 */
export function createHttpClient(
  config?: Partial<HttpClientConfig>,
  hooks?: HttpClientHooks
): ResilientHttpClient {
  return new ResilientHttpClient(config, hooks)
}

/**
 * Create a simple logging hook for debugging.
 */
export function createLoggingHooks(
  logger: { debug: (msg: string, meta?: Record<string, unknown>) => void } = console
): HttpClientHooks {
  return {
    onRequest: (url, options, attempt) => {
      logger.debug(`HTTP ${options.method ?? 'GET'} ${url}`, { attempt })
    },
    onResponse: (url, response, attempt) => {
      logger.debug(`HTTP ${response.status} ${url}`, {
        attempt,
        durationMs: response.durationMs,
        ok: response.ok,
      })
    },
    onRetry: (url, error, attempt, delayMs) => {
      logger.debug(`HTTP retry ${url}`, {
        attempt,
        error: error.message,
        delayMs,
      })
    },
    onCircuitStateChange: (oldState, newState) => {
      logger.debug(`Circuit breaker: ${oldState} -> ${newState}`)
    },
  }
}
