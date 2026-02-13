/**
 * Observability Tests
 */

import {
  // Logger
  StructuredLogger,
  createLogger,
  noopLogger,
  logTiming,
  scopedLogger,
  LOG_LEVEL_PRIORITY,
} from 'agent-memory/observability/logger.js'
import {
  // Metrics
  InMemoryMetricsCollector,
  createMetricsCollector,
  noopMetrics,
  METRICS,
} from 'agent-memory/observability/metrics.js'
import {
  // Tracing
  TracingSpan,
  SimpleTracer,
  createTracer,
  noopTracer,
  ConsoleSpanExporter,
  extractTraceContext,
  injectTraceContext,
} from 'agent-memory/observability/tracing.js'
import {
  // Health
  SimpleHealthChecker,
  createHealthChecker,
  createDatabaseHealthCheck,
  createMemoryHealthCheck,
  createEventLoopHealthCheck,
  createExternalServiceHealthCheck,
} from 'agent-memory/observability/health.js'
import {
  // Alerts
  AlertManager,
  createAlertManager,
  ConsoleAlertHandler,
  InMemoryAlertHandler,
  CallbackAlertHandler,
  alertFromError,
  alertHealthFailure,
} from 'agent-memory/observability/alerts.js'

// ============ Logger Tests ============

describe('StructuredLogger', () => {
  test('creates logger with default config', () => {
    const logger = createLogger()
    expect(logger).toBeInstanceOf(StructuredLogger)
  })

  test('respects log level filtering', () => {
    const entries: any[] = []
    const logger = createLogger({
      level: 'warn',
      output: (entry) => entries.push(entry),
    })

    logger.debug('debug message')
    logger.info('info message')
    logger.warn('warn message')
    logger.error('error message')

    expect(entries).toHaveLength(2)
    expect(entries[0].level).toBe('warn')
    expect(entries[1].level).toBe('error')
  })

  test('includes context in entries', () => {
    const entries: any[] = []
    const logger = createLogger({
      output: (entry) => entries.push(entry),
    })

    logger.info('test message', { userId: '123' })

    expect(entries[0].context).toEqual({ userId: '123' })
  })

  test('includes error details', () => {
    const entries: any[] = []
    const logger = createLogger({
      output: (entry) => entries.push(entry),
    })

    const error = new Error('Test error')
    logger.error('An error occurred', error)

    expect(entries[0].error).toBeDefined()
    expect(entries[0].error.name).toBe('Error')
    expect(entries[0].error.message).toBe('Test error')
  })

  test('child logger inherits context', () => {
    const entries: any[] = []
    const logger = createLogger({
      context: { service: 'test' },
      output: (entry) => entries.push(entry),
    })

    const child = logger.child({ component: 'auth' })
    child.info('test')

    expect(entries[0].context).toEqual({
      service: 'test',
      component: 'auth',
    })
  })

  test('setTraceContext adds trace info', () => {
    const entries: any[] = []
    const logger = createLogger({
      output: (entry) => entries.push(entry),
    }) as StructuredLogger

    logger.setTraceContext('trace-123', 'span-456')
    logger.info('test')

    expect(entries[0].traceId).toBe('trace-123')
    expect(entries[0].spanId).toBe('span-456')
  })

  test('noopLogger discards all output', () => {
    // Should not throw
    noopLogger.debug('test')
    noopLogger.info('test')
    noopLogger.warn('test')
    noopLogger.error('test')
    noopLogger.fatal('test')
    noopLogger.child({}).info('test')
  })
})

describe('Logger Helpers', () => {
  test('logTiming measures execution time', async () => {
    const entries: any[] = []
    const logger = createLogger({
      level: 'debug',
      output: (entry) => entries.push(entry),
    })

    const result = await logTiming(logger, 'test-operation', async () => {
      await new Promise(r => setTimeout(r, 10))
      return 'done'
    })

    expect(result).toBe('done')
    expect(entries).toHaveLength(1)
    expect(entries[0].context.durationMs).toBeGreaterThan(5)
  })

  test('scopedLogger adds component context', () => {
    const entries: any[] = []
    const logger = createLogger({
      output: (entry) => entries.push(entry),
    })

    const scoped = scopedLogger(logger, 'queue', { queueId: 'q1' })
    scoped.info('test')

    expect(entries[0].context).toEqual({
      component: 'queue',
      queueId: 'q1',
    })
  })

  test('LOG_LEVEL_PRIORITY is ordered correctly', () => {
    expect(LOG_LEVEL_PRIORITY.debug).toBeLessThan(LOG_LEVEL_PRIORITY.info)
    expect(LOG_LEVEL_PRIORITY.info).toBeLessThan(LOG_LEVEL_PRIORITY.warn)
    expect(LOG_LEVEL_PRIORITY.warn).toBeLessThan(LOG_LEVEL_PRIORITY.error)
    expect(LOG_LEVEL_PRIORITY.error).toBeLessThan(LOG_LEVEL_PRIORITY.fatal)
  })
})

// ============ Metrics Tests ============

describe('InMemoryMetricsCollector', () => {
  let metrics: InMemoryMetricsCollector

  beforeEach(() => {
    metrics = createMetricsCollector()
  })

  test('increments counters', () => {
    metrics.increment('requests_total')
    metrics.increment('requests_total')
    metrics.increment('requests_total', 3)

    const samples = metrics.getMetrics()
    const counter = samples.find(s => s.name === 'requests_total')
    expect(counter?.value).toBe(5)
  })

  test('sets gauges', () => {
    metrics.gauge('queue_depth', 10)
    metrics.gauge('queue_depth', 15)

    const samples = metrics.getMetrics()
    const gauge = samples.find(s => s.name === 'queue_depth')
    expect(gauge?.value).toBe(15)
  })

  test('records histograms', () => {
    metrics.histogram('latency_ms', 50)
    metrics.histogram('latency_ms', 100)
    metrics.histogram('latency_ms', 200)

    const data = metrics.getHistogram('latency_ms')
    expect(data).toBeDefined()
    expect(data!.count).toBe(3)
    expect(data!.sum).toBe(350)
    expect(data!.buckets.find(b => b.le === 100)?.count).toBe(2)
  })

  test('records summaries', () => {
    for (let i = 1; i <= 100; i++) {
      metrics.summary('response_time', i)
    }

    const data = metrics.getSummary('response_time', {}, [0.5, 0.99])
    expect(data).toBeDefined()
    expect(data!.count).toBe(100)
    expect(data!.sum).toBe(5050)
    expect(data!.quantiles.find(q => q.quantile === 0.5)?.value).toBe(50)
  })

  test('tracks labels separately', () => {
    metrics.increment('http_requests', 1, { method: 'GET' })
    metrics.increment('http_requests', 2, { method: 'POST' })
    metrics.increment('http_requests', 1, { method: 'GET' })

    const samples = metrics.getMetrics()
    const gets = samples.find(s => s.name === 'http_requests' && s.labels.method === 'GET')
    const posts = samples.find(s => s.name === 'http_requests' && s.labels.method === 'POST')

    expect(gets?.value).toBe(2)
    expect(posts?.value).toBe(2)
  })

  test('startTimer records duration', async () => {
    const stopTimer = metrics.startTimer('operation_duration')
    await new Promise(r => setTimeout(r, 10))
    const duration = stopTimer()

    expect(duration).toBeGreaterThan(5)
    const data = metrics.getHistogram('operation_duration')
    expect(data?.count).toBe(1)
  })

  test('reset clears all values', () => {
    metrics.increment('counter')
    metrics.gauge('gauge', 10)
    metrics.reset()

    expect(metrics.getMetrics()).toHaveLength(0)
  })

  test('exports to Prometheus format', () => {
    metrics.register({
      name: 'test_counter',
      type: 'counter',
      description: 'A test counter',
    })
    metrics.increment('test_counter', 5, { env: 'test' })

    const output = metrics.toPrometheusFormat()
    expect(output).toContain('# HELP test_counter A test counter')
    expect(output).toContain('# TYPE test_counter counter')
    expect(output).toContain('test_counter{env="test",} 5')
  })

  test('noopMetrics does nothing', () => {
    noopMetrics.increment('test')
    noopMetrics.gauge('test', 10)
    noopMetrics.histogram('test', 5)
    noopMetrics.summary('test', 5)
    const stop = noopMetrics.startTimer('test')
    expect(stop()).toBe(0)
    expect(noopMetrics.getMetrics()).toHaveLength(0)
  })

  test('METRICS constants are defined', () => {
    expect(METRICS.SYNC_JOBS_TOTAL).toBeDefined()
    expect(METRICS.HTTP_REQUESTS_TOTAL).toBeDefined()
    expect(METRICS.ERRORS_TOTAL).toBeDefined()
  })
})

// ============ Tracing Tests ============

describe('TracingSpan', () => {
  test('generates unique IDs', () => {
    const span1 = new TracingSpan('test1')
    const span2 = new TracingSpan('test2')

    expect(span1.spanId).not.toBe(span2.spanId)
    expect(span1.traceId).not.toBe(span2.traceId)
  })

  test('inherits trace ID from parent', () => {
    const parent = new TracingSpan('parent')
    const child = new TracingSpan('child', {
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
    })

    expect(child.traceId).toBe(parent.traceId)
    expect(child.getData().parentSpanId).toBe(parent.spanId)
  })

  test('setStatus updates status', () => {
    const span = new TracingSpan('test')
    span.setStatus('ok')

    expect(span.getData().status).toBe('ok')
  })

  test('setAttributes adds attributes', () => {
    const span = new TracingSpan('test')
    span.setAttributes({ 'http.method': 'GET' })
    span.setAttributes({ 'http.status': 200 })

    const data = span.getData()
    expect(data.attributes['http.method']).toBe('GET')
    expect(data.attributes['http.status']).toBe(200)
  })

  test('addEvent records events', () => {
    const span = new TracingSpan('test')
    span.addEvent('request_started', { url: '/api/test' })
    span.addEvent('response_received')

    const data = span.getData()
    expect(data.events).toHaveLength(2)
    expect(data.events[0].name).toBe('request_started')
    expect(data.events[0].attributes?.url).toBe('/api/test')
  })

  test('end sets endTime', () => {
    const span = new TracingSpan('test')
    expect(span.getData().endTime).toBeUndefined()

    span.end()
    expect(span.getData().endTime).toBeDefined()
  })

  test('ignores updates after end', () => {
    const span = new TracingSpan('test')
    span.end()

    span.setStatus('error')
    span.addEvent('late_event')

    expect(span.getData().status).toBe('unset')
    expect(span.getData().events).toHaveLength(0)
  })
})

describe('SimpleTracer', () => {
  test('creates spans', () => {
    const tracer = createTracer()
    const span = tracer.startSpan('test-operation')

    expect(span).toBeDefined()
    expect(span.spanId).toBeDefined()
  })

  test('tracks active span', () => {
    const tracer = createTracer()

    expect(tracer.getActiveSpan()).toBeUndefined()

    const span = tracer.startSpan('test')
    expect(tracer.getActiveSpan()).toBe(span)
  })

  test('withSpan wraps function', async () => {
    const tracer = createTracer()

    const result = await tracer.withSpan('test-operation', async (span) => {
      span.setAttributes({ key: 'value' })
      return 'done'
    })

    expect(result).toBe('done')
  })

  test('withSpan sets error status on exception', async () => {
    const tracer = createTracer()
    const bufferedSpans = (tracer as SimpleTracer).getBufferedSpans()

    await expect(
      tracer.withSpan('failing-op', async () => {
        throw new Error('test error')
      })
    ).rejects.toThrow('test error')

    const spans = (tracer as SimpleTracer).getBufferedSpans()
    expect(spans.length).toBeGreaterThan(0)
    expect(spans[spans.length - 1].status).toBe('error')
  })

  test('sampling respects sampleRate', () => {
    const tracer = createTracer({ sampleRate: 0 })
    const span = tracer.startSpan('test')

    // NoopSpan has zero IDs
    expect(span.spanId).toBe('0000000000000000')
  })

  test('buffers spans for export', async () => {
    const tracer = createTracer()

    await tracer.withSpan('op1', async () => 'a')
    await tracer.withSpan('op2', async () => 'b')

    const spans = (tracer as SimpleTracer).getBufferedSpans()
    expect(spans).toHaveLength(2)
  })

  test('noopTracer does nothing', async () => {
    const span = noopTracer.startSpan('test')
    expect(span.spanId).toBe('0000000000000000')

    expect(noopTracer.getActiveSpan()).toBeUndefined()

    const result = await noopTracer.withSpan('test', async () => 'done')
    expect(result).toBe('done')
  })
})

describe('Trace Context', () => {
  test('extractTraceContext parses W3C format', () => {
    const ctx = extractTraceContext({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    })

    expect(ctx.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(ctx.spanId).toBe('b7ad6b7169203331')
  })

  test('extractTraceContext returns empty for invalid header', () => {
    const ctx = extractTraceContext({ traceparent: 'invalid' })
    expect(ctx.traceId).toBeUndefined()
  })

  test('injectTraceContext adds W3C header', () => {
    const span = new TracingSpan('test')
    const headers: Record<string, string> = {}

    injectTraceContext(span, headers)

    expect(headers.traceparent).toContain(span.traceId)
    expect(headers.traceparent).toContain(span.spanId)
  })
})

// ============ Health Check Tests ============

describe('SimpleHealthChecker', () => {
  test('registers and runs checks', async () => {
    const checker = createHealthChecker()

    checker.register('database', async () => ({
      status: 'healthy',
      message: 'Connected',
      lastCheck: new Date().toISOString(),
    }))

    checker.register('cache', async () => ({
      status: 'healthy',
      message: 'Available',
      lastCheck: new Date().toISOString(),
    }))

    const result = await checker.check()

    expect(result.status).toBe('healthy')
    expect(result.components.database.status).toBe('healthy')
    expect(result.components.cache.status).toBe('healthy')
    expect(result.uptime).toBeGreaterThanOrEqual(0)
  })

  test('returns degraded if any component degraded', async () => {
    const checker = createHealthChecker()

    checker.register('healthy', async () => ({
      status: 'healthy',
      lastCheck: new Date().toISOString(),
    }))

    checker.register('degraded', async () => ({
      status: 'degraded',
      message: 'Slow',
      lastCheck: new Date().toISOString(),
    }))

    const result = await checker.check()
    expect(result.status).toBe('degraded')
  })

  test('returns unhealthy if any component unhealthy', async () => {
    const checker = createHealthChecker()

    checker.register('healthy', async () => ({
      status: 'healthy',
      lastCheck: new Date().toISOString(),
    }))

    checker.register('unhealthy', async () => ({
      status: 'unhealthy',
      message: 'Down',
      lastCheck: new Date().toISOString(),
    }))

    const result = await checker.check()
    expect(result.status).toBe('unhealthy')
  })

  test('handles check timeouts', async () => {
    const checker = createHealthChecker({ checkTimeoutMs: 10 })

    checker.register('slow', async () => {
      await new Promise(r => setTimeout(r, 100))
      return { status: 'healthy', lastCheck: new Date().toISOString() }
    })

    const result = await checker.check()
    expect(result.components.slow.status).toBe('unhealthy')
    expect(result.components.slow.message).toContain('timed out')
  })

  test('caches results', async () => {
    let callCount = 0
    const checker = createHealthChecker({ cacheTtlMs: 1000 })

    checker.register('test', async () => {
      callCount++
      return { status: 'healthy', lastCheck: new Date().toISOString() }
    })

    await checker.check()
    await checker.check()
    await checker.check()

    expect(callCount).toBe(1)
  })

  test('getStatus returns cached result', async () => {
    const checker = createHealthChecker()
    expect(checker.getStatus()).toBeUndefined()

    checker.register('test', async () => ({
      status: 'healthy',
      lastCheck: new Date().toISOString(),
    }))
    await checker.check()

    expect(checker.getStatus()).toBeDefined()
    expect(checker.getStatus()?.status).toBe('healthy')
  })
})

describe('Built-in Health Checks', () => {
  test('createDatabaseHealthCheck', async () => {
    const check = createDatabaseHealthCheck(async () => true)
    const result = await check()
    expect(result.status).toBe('healthy')
  })

  test('createMemoryHealthCheck', async () => {
    const check = createMemoryHealthCheck()
    const result = await check()
    expect(['healthy', 'degraded', 'unhealthy']).toContain(result.status)
    expect(result.details?.heapUsedMb).toBeDefined()
  })

  test('createEventLoopHealthCheck', async () => {
    const check = createEventLoopHealthCheck()
    const result = await check()
    expect(['healthy', 'degraded', 'unhealthy']).toContain(result.status)
    expect(result.details?.lagMs).toBeDefined()
  })

  test('createExternalServiceHealthCheck', async () => {
    const check = createExternalServiceHealthCheck('api', async () => true)
    const result = await check()
    expect(result.status).toBe('healthy')
    expect(result.message).toContain('api')
  })
})

// ============ Alert Tests ============

describe('AlertManager', () => {
  test('sends alerts to handlers', async () => {
    const handler = new InMemoryAlertHandler()
    const manager = createAlertManager({ handlers: [handler] })

    const alertId = await manager.alert('warning', 'Test Alert', 'Test message', {
      source: 'test',
    })

    expect(alertId).toBeDefined()
    expect(handler.alerts).toHaveLength(1)
    expect(handler.alerts[0].title).toBe('Test Alert')
  })

  test('filters by minimum severity', async () => {
    const handler = new InMemoryAlertHandler()
    const manager = createAlertManager({
      handlers: [handler],
      minSeverity: 'warning',
    })

    await manager.alert('info', 'Info Alert', 'Should be filtered')
    await manager.alert('warning', 'Warning Alert', 'Should pass')

    expect(handler.alerts).toHaveLength(1)
    expect(handler.alerts[0].severity).toBe('warning')
  })

  test('deduplicates alerts', async () => {
    const handler = new InMemoryAlertHandler()
    const manager = createAlertManager({
      handlers: [handler],
      dedupeWindowMs: 1000,
    })

    await manager.alert('warning', 'Duplicate', 'Message', { source: 'test' })
    await manager.alert('warning', 'Duplicate', 'Message', { source: 'test' })

    expect(handler.alerts).toHaveLength(1)
  })

  test('resolves alerts', async () => {
    const handler = new InMemoryAlertHandler()
    const manager = createAlertManager({ handlers: [handler] })

    const alertId = await manager.alert('warning', 'Test', 'Message')
    await manager.resolve(alertId!)

    expect(handler.resolved).toContain(alertId)
    expect(manager.getActiveAlerts()).toHaveLength(0)
  })

  test('getActiveAlerts returns unresolved', async () => {
    const manager = createAlertManager()

    await manager.alert('warning', 'Alert 1', 'Message')
    const id2 = await manager.alert('warning', 'Alert 2', 'Message', {
      dedupeKey: 'alert2',
    })
    await manager.resolve(id2!)

    const active = manager.getActiveAlerts()
    expect(active).toHaveLength(1)
    expect(active[0].title).toBe('Alert 1')
  })

  test('clearResolved removes resolved alerts', async () => {
    const manager = createAlertManager()

    const id1 = await manager.alert('warning', 'Alert 1', 'Message')
    await manager.alert('warning', 'Alert 2', 'Message', { dedupeKey: 'alert2' })
    await manager.resolve(id1!)

    manager.clearResolved()

    expect(manager.getAllAlerts()).toHaveLength(1)
  })
})

describe('Alert Handlers', () => {
  test('ConsoleAlertHandler logs to console', async () => {
    const handler = new ConsoleAlertHandler()
    // Should not throw
    await handler.send({
      id: 'test-id',
      severity: 'warning',
      title: 'Test',
      message: 'Test message',
      source: 'test',
      timestamp: new Date().toISOString(),
    })
    await handler.resolve('test-id')
  })

  test('InMemoryAlertHandler stores alerts', async () => {
    const handler = new InMemoryAlertHandler()

    await handler.send({
      id: 'id1',
      severity: 'critical',
      title: 'Critical',
      message: 'Message',
      source: 'test',
      timestamp: new Date().toISOString(),
    })

    expect(handler.alerts).toHaveLength(1)

    handler.clear()
    expect(handler.alerts).toHaveLength(0)
  })

  test('CallbackAlertHandler calls functions', async () => {
    const sent: any[] = []
    const resolved: string[] = []

    const handler = new CallbackAlertHandler(
      async (alert) => sent.push(alert),
      async (id) => resolved.push(id)
    )

    await handler.send({
      id: 'id1',
      severity: 'warning',
      title: 'Test',
      message: 'Message',
      source: 'test',
      timestamp: new Date().toISOString(),
    })
    await handler.resolve('id1')

    expect(sent).toHaveLength(1)
    expect(resolved).toContain('id1')
  })
})

describe('Alert Helpers', () => {
  test('alertFromError creates alert from error', async () => {
    const handler = new InMemoryAlertHandler()
    const manager = createAlertManager({ handlers: [handler] })

    const error = new Error('Something went wrong')
    await alertFromError(manager, error, { severity: 'critical' })

    expect(handler.alerts).toHaveLength(1)
    expect(handler.alerts[0].title).toBe('Error')
    expect(handler.alerts[0].severity).toBe('critical')
  })

  test('alertHealthFailure creates health alert', async () => {
    const handler = new InMemoryAlertHandler()
    const manager = createAlertManager({ handlers: [handler] })

    await alertHealthFailure(manager, 'database', 'Connection lost')

    expect(handler.alerts).toHaveLength(1)
    expect(handler.alerts[0].title).toContain('database')
    expect(handler.alerts[0].severity).toBe('critical')
  })
})
