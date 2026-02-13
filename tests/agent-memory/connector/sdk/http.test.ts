/**
 * HTTP Client Tests
 */

import {
  TokenBucket,
  CircuitBreaker,
  CircuitBreakerOpenError,
  ResilientHttpClient,
  HttpError,
  TimeoutError,
  NetworkError,
  createHttpClient,
} from 'agent-memory/connector/sdk/http.js'

// ============ TokenBucket Tests ============

describe('TokenBucket', () => {
  test('starts with full capacity', () => {
    const bucket = new TokenBucket(10, 5)
    expect(bucket.getTokens()).toBe(10)
  })

  test('tryAcquire consumes tokens', () => {
    const bucket = new TokenBucket(10, 5)
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.getTokens()).toBeCloseTo(9, 0)
  })

  test('tryAcquire returns false when empty', () => {
    const bucket = new TokenBucket(2, 1)
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(false)
  })

  test('refills over time', async () => {
    const bucket = new TokenBucket(10, 100) // 100 tokens/second
    // Drain the bucket
    for (let i = 0; i < 10; i++) {
      bucket.tryAcquire()
    }
    expect(bucket.getTokens()).toBeCloseTo(0, 0)

    // Wait for refill
    await new Promise(r => setTimeout(r, 50))
    expect(bucket.getTokens()).toBeGreaterThan(0)
  })

  test('acquire waits when empty', async () => {
    const bucket = new TokenBucket(1, 50) // 50 tokens/second
    bucket.tryAcquire() // Empty the bucket

    const start = Date.now()
    await bucket.acquire()
    const elapsed = Date.now() - start

    // Should have waited for refill (at least ~20ms)
    expect(elapsed).toBeGreaterThanOrEqual(10)
  })

  test('getWaitTime returns 0 when tokens available', () => {
    const bucket = new TokenBucket(10, 5)
    expect(bucket.getWaitTime()).toBe(0)
  })

  test('getWaitTime returns positive when empty', () => {
    const bucket = new TokenBucket(1, 10)
    bucket.tryAcquire()
    expect(bucket.getWaitTime()).toBeGreaterThan(0)
  })
})

// ============ CircuitBreaker Tests ============

describe('CircuitBreaker', () => {
  test('starts in closed state', () => {
    const cb = new CircuitBreaker(3, 1000)
    expect(cb.getState()).toBe('closed')
  })

  test('check() passes when closed', () => {
    const cb = new CircuitBreaker(3, 1000)
    expect(() => cb.check()).not.toThrow()
  })

  test('opens after threshold failures', () => {
    const cb = new CircuitBreaker(3, 1000)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.getState()).toBe('closed')
    cb.recordFailure()
    expect(cb.getState()).toBe('open')
  })

  test('check() throws when open', () => {
    const cb = new CircuitBreaker(3, 1000)
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    expect(() => cb.check()).toThrow(CircuitBreakerOpenError)
  })

  test('transitions to half-open after reset timeout', async () => {
    const cb = new CircuitBreaker(3, 50) // 50ms reset
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.getState()).toBe('open')

    await new Promise(r => setTimeout(r, 60))
    expect(cb.getState()).toBe('half-open')
  })

  test('closes after success in half-open', async () => {
    const cb = new CircuitBreaker(3, 50)
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()

    await new Promise(r => setTimeout(r, 60))
    expect(cb.getState()).toBe('half-open')

    cb.recordSuccess()
    expect(cb.getState()).toBe('closed')
    expect(cb.getStats().failureCount).toBe(0)
  })

  test('reopens after failure in half-open', async () => {
    const cb = new CircuitBreaker(3, 50)
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()

    await new Promise(r => setTimeout(r, 60))
    expect(cb.getState()).toBe('half-open')

    cb.recordFailure()
    expect(cb.getState()).toBe('open')
  })

  test('reset() clears state', () => {
    const cb = new CircuitBreaker(3, 1000)
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.getState()).toBe('open')

    cb.reset()
    expect(cb.getState()).toBe('closed')
    expect(cb.getStats().failureCount).toBe(0)
  })

  test('success in closed state decays failure count', () => {
    const cb = new CircuitBreaker(5, 1000)
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.getStats().failureCount).toBe(2)

    cb.recordSuccess()
    expect(cb.getStats().failureCount).toBe(1)

    cb.recordSuccess()
    expect(cb.getStats().failureCount).toBe(0)
  })
})

// ============ ResilientHttpClient Tests ============

describe('ResilientHttpClient', () => {
  let originalFetch: typeof globalThis.fetch
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: 'test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('makes successful GET request', async () => {
    const client = createHttpClient()
    const response = await client.get<{ data: string }>('https://api.example.com/test')

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.data).toEqual({ data: 'test' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  test('makes successful POST request', async () => {
    const client = createHttpClient()
    const response = await client.post<{ data: string }>(
      'https://api.example.com/test',
      { input: 'value' }
    )

    expect(response.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url, options] = mockFetch.mock.calls[0]
    expect(options.method).toBe('POST')
    expect(options.body).toBe(JSON.stringify({ input: 'value' }))
  })

  test('adds query parameters', async () => {
    const client = createHttpClient()
    await client.get('https://api.example.com/test', {
      params: { foo: 'bar', num: 123, flag: true, undef: undefined },
    })

    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.example.com/test?foo=bar&num=123&flag=true')
  })

  test('passes custom headers', async () => {
    const client = createHttpClient()
    await client.get('https://api.example.com/test', {
      headers: { 'Authorization': 'Bearer token', 'X-Custom': 'value' },
    })

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers['Authorization']).toBe('Bearer token')
    expect(options.headers['X-Custom']).toBe('value')
  })

  test('retries on 500 error', async () => {
    let callCount = 0
    mockFetch.mockImplementation(() => {
      callCount++
      if (callCount < 3) {
        return Promise.resolve(
          new Response('Server Error', { status: 500 })
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    })

    const client = createHttpClient({ baseRetryDelay: 10, maxRetryDelay: 50 })
    const response = await client.get<{ data: string }>('https://api.example.com/test')

    expect(response.status).toBe(200)
    expect(callCount).toBe(3)
  })

  test('respects Retry-After header', async () => {
    let callCount = 0
    mockFetch.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response('Rate Limited', {
            status: 429,
            headers: { 'Retry-After': '1' },
          })
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    })

    const client = createHttpClient()
    const start = Date.now()
    await client.get('https://api.example.com/test')
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(1000)
    expect(callCount).toBe(2)
  })

  test('stops retrying after max attempts', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('Server Error', { status: 500 }))
    )

    const client = createHttpClient({ maxRetries: 2, baseRetryDelay: 10 })

    try {
      await client.get('https://api.example.com/test')
      expect(true).toBe(false) // Should not reach here
    } catch (error) {
      // Request should fail after 3 attempts (1 initial + 2 retries)
      expect(mockFetch).toHaveBeenCalledTimes(3)
    }
  })

  test('does not retry when noRetry is true', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('Server Error', { status: 500 }))
    )

    const client = createHttpClient()

    try {
      await client.get('https://api.example.com/test', { noRetry: true })
      expect(true).toBe(false)
    } catch (error) {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    }
  })

  test('circuit breaker opens after failures', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('Server Error', { status: 500 }))
    )

    const client = createHttpClient({
      circuitBreakerThreshold: 2,
      maxRetries: 0,
      baseRetryDelay: 10,
    })

    // First two failures should work normally
    try { await client.get('https://api.example.com/test') } catch (e) {}
    try { await client.get('https://api.example.com/test') } catch (e) {}

    // Third request should fail immediately with circuit open
    try {
      await client.get('https://api.example.com/test')
      expect(true).toBe(false)
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitBreakerOpenError)
    }
  })

  test('handles network errors', async () => {
    mockFetch.mockImplementation(() =>
      Promise.reject(new TypeError('fetch failed'))
    )

    const client = createHttpClient({ maxRetries: 0 })

    try {
      await client.get('https://api.example.com/test')
      expect(true).toBe(false)
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkError)
    }
  })

  test('handles empty response (204)', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 204,
          headers: { 'content-length': '0' },
        })
      )
    )

    const client = createHttpClient()
    const response = await client.delete('https://api.example.com/test')

    expect(response.status).toBe(204)
    expect(response.data).toBeUndefined()
  })

  test('parses rate limit headers', () => {
    const client = createHttpClient()
    const headers = new Headers({
      'x-ratelimit-remaining': '100',
      'x-ratelimit-limit': '1000',
      'x-ratelimit-reset': '1700000000',
    })

    const limits = client.parseRateLimitHeaders(headers)
    expect(limits.remaining).toBe(100)
    expect(limits.limit).toBe(1000)
    expect(limits.resetsAt).toBe(1700000000)
  })

  test('getStats returns current state', () => {
    const client = createHttpClient()
    const stats = client.getStats()

    expect(stats.rateLimiter).toHaveProperty('tokens')
    expect(stats.rateLimiter).toHaveProperty('waitTime')
    expect(stats.circuitBreaker).toHaveProperty('state')
    expect(stats.circuitBreaker.state).toBe('closed')
  })

  test('calls hooks during request lifecycle', async () => {
    const hooks = {
      onRequest: vi.fn(() => {}),
      onResponse: vi.fn(() => {}),
    }

    const client = createHttpClient({}, hooks)
    await client.get('https://api.example.com/test')

    expect(hooks.onRequest).toHaveBeenCalledTimes(1)
    expect(hooks.onResponse).toHaveBeenCalledTimes(1)
  })

  test('calls onRetry hook on retry', async () => {
    let callCount = 0
    mockFetch.mockImplementation(() => {
      callCount++
      if (callCount < 2) {
        return Promise.resolve(new Response('Error', { status: 500 }))
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    })

    const hooks = {
      onRetry: vi.fn(() => {}),
    }

    const client = createHttpClient({ baseRetryDelay: 10 }, hooks)
    await client.get('https://api.example.com/test')

    expect(hooks.onRetry).toHaveBeenCalledTimes(1)
  })

  test('convenience methods use correct HTTP methods', async () => {
    const client = createHttpClient()

    await client.get('https://api.example.com/test')
    expect(mockFetch.mock.calls[0][1].method).toBe('GET')

    await client.post('https://api.example.com/test', {})
    expect(mockFetch.mock.calls[1][1].method).toBe('POST')

    await client.put('https://api.example.com/test', {})
    expect(mockFetch.mock.calls[2][1].method).toBe('PUT')

    await client.patch('https://api.example.com/test', {})
    expect(mockFetch.mock.calls[3][1].method).toBe('PATCH')

    await client.delete('https://api.example.com/test')
    expect(mockFetch.mock.calls[4][1].method).toBe('DELETE')
  })
})
