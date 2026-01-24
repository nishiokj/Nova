/**
 * Observability Types
 *
 * Type definitions for logging, metrics, tracing, and health checks.
 */

import { z } from 'zod'

// ============ Log Levels ============

/**
 * Log levels in order of severity.
 */
export const LogLevel = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel]

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal'])

/**
 * Numeric priority for log levels (higher = more severe).
 */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
}

// ============ Log Entry ============

/**
 * Structured log entry.
 */
export interface LogEntry {
  /** Log level */
  level: LogLevel
  /** Log message */
  message: string
  /** Timestamp */
  timestamp: string
  /** Logger name/category */
  logger: string
  /** Structured context */
  context?: Record<string, unknown>
  /** Error if present */
  error?: {
    name: string
    message: string
    code?: string
    stack?: string
  }
  /** Span ID for tracing correlation */
  spanId?: string
  /** Trace ID for tracing correlation */
  traceId?: string
}

export const LogEntrySchema: z.ZodType<LogEntry> = z.object({
  level: LogLevelSchema,
  message: z.string(),
  timestamp: z.string().datetime(),
  logger: z.string(),
  context: z.record(z.unknown()).optional(),
  error: z
    .object({
      name: z.string(),
      message: z.string(),
      code: z.string().optional(),
      stack: z.string().optional(),
    })
    .optional(),
  spanId: z.string().optional(),
  traceId: z.string().optional(),
})

// ============ Metrics Types ============

/**
 * Metric types.
 */
export const MetricType = {
  COUNTER: 'counter',
  GAUGE: 'gauge',
  HISTOGRAM: 'histogram',
  SUMMARY: 'summary',
} as const

export type MetricType = (typeof MetricType)[keyof typeof MetricType]

export const MetricTypeSchema = z.enum(['counter', 'gauge', 'histogram', 'summary'])

/**
 * Metric labels.
 */
export type MetricLabels = Record<string, string>

/**
 * Metric definition.
 */
export interface MetricDefinition {
  name: string
  type: MetricType
  description: string
  labels?: string[]
  buckets?: number[] // For histograms
}

/**
 * Metric sample.
 */
export interface MetricSample {
  name: string
  type: MetricType
  value: number
  labels: MetricLabels
  timestamp: number
}

/**
 * Histogram data.
 */
export interface HistogramData {
  count: number
  sum: number
  buckets: Array<{ le: number; count: number }>
}

/**
 * Summary data.
 */
export interface SummaryData {
  count: number
  sum: number
  quantiles: Array<{ quantile: number; value: number }>
}

// ============ Tracing Types ============

/**
 * Span status.
 */
export const SpanStatus = {
  UNSET: 'unset',
  OK: 'ok',
  ERROR: 'error',
} as const

export type SpanStatus = (typeof SpanStatus)[keyof typeof SpanStatus]

/**
 * Span kind.
 */
export const SpanKind = {
  INTERNAL: 'internal',
  SERVER: 'server',
  CLIENT: 'client',
  PRODUCER: 'producer',
  CONSUMER: 'consumer',
} as const

export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind]

/**
 * Span attributes.
 */
export type SpanAttributes = Record<string, string | number | boolean | string[]>

/**
 * Span event.
 */
export interface SpanEvent {
  name: string
  timestamp: number
  attributes?: SpanAttributes
}

/**
 * Span data.
 */
export interface SpanData {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  status: SpanStatus
  startTime: number
  endTime?: number
  attributes: SpanAttributes
  events: SpanEvent[]
}

// ============ Health Check Types ============

/**
 * Health status.
 */
export const HealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
} as const

export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus]

export const HealthStatusSchema = z.enum(['healthy', 'degraded', 'unhealthy'])

/**
 * Health check result for a single component.
 */
export interface ComponentHealth {
  status: HealthStatus
  message?: string
  latencyMs?: number
  details?: Record<string, unknown>
  lastCheck: string
}

/**
 * Overall health check result.
 */
export interface HealthCheckResult {
  status: HealthStatus
  version?: string
  uptime: number
  timestamp: string
  components: Record<string, ComponentHealth>
}

export const ComponentHealthSchema: z.ZodType<ComponentHealth> = z.object({
  status: HealthStatusSchema,
  message: z.string().optional(),
  latencyMs: z.number().optional(),
  details: z.record(z.unknown()).optional(),
  lastCheck: z.string().datetime(),
})

export const HealthCheckResultSchema: z.ZodType<HealthCheckResult> = z.object({
  status: HealthStatusSchema,
  version: z.string().optional(),
  uptime: z.number(),
  timestamp: z.string().datetime(),
  components: z.record(ComponentHealthSchema),
})

// ============ Alert Types ============

/**
 * Alert severity.
 */
export const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
} as const

export type AlertSeverity = (typeof AlertSeverity)[keyof typeof AlertSeverity]

export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical'])

/**
 * Alert definition.
 */
export interface Alert {
  id: string
  severity: AlertSeverity
  title: string
  message: string
  source: string
  timestamp: string
  context?: Record<string, unknown>
  resolved?: boolean
  resolvedAt?: string
}

export const AlertSchema: z.ZodType<Alert> = z.object({
  id: z.string(),
  severity: AlertSeveritySchema,
  title: z.string(),
  message: z.string(),
  source: z.string(),
  timestamp: z.string().datetime(),
  context: z.record(z.unknown()).optional(),
  resolved: z.boolean().optional(),
  resolvedAt: z.string().datetime().optional(),
})

// ============ Interfaces ============

/**
 * Logger interface.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, error?: Error, context?: Record<string, unknown>): void
  fatal(message: string, error?: Error, context?: Record<string, unknown>): void
  child(context: Record<string, unknown>): Logger
}

/**
 * Metrics collector interface.
 */
export interface MetricsCollector {
  /** Increment a counter */
  increment(name: string, value?: number, labels?: MetricLabels): void
  /** Set a gauge value */
  gauge(name: string, value: number, labels?: MetricLabels): void
  /** Record a histogram value */
  histogram(name: string, value: number, labels?: MetricLabels): void
  /** Record a summary value */
  summary(name: string, value: number, labels?: MetricLabels): void
  /** Start a timer that records duration on stop */
  startTimer(name: string, labels?: MetricLabels): () => number
  /** Get all current metrics */
  getMetrics(): MetricSample[]
}

/**
 * Tracer interface.
 */
export interface Tracer {
  /** Start a new span */
  startSpan(name: string, options?: { kind?: SpanKind; attributes?: SpanAttributes }): Span
  /** Get current active span */
  getActiveSpan(): Span | undefined
  /** Run function within a span */
  withSpan<T>(name: string, fn: (span: Span) => T | Promise<T>): Promise<T>
}

/**
 * Span interface.
 */
export interface Span {
  /** Span ID */
  readonly spanId: string
  /** Trace ID */
  readonly traceId: string
  /** Set span status */
  setStatus(status: SpanStatus, message?: string): void
  /** Set attributes */
  setAttributes(attributes: SpanAttributes): void
  /** Add an event */
  addEvent(name: string, attributes?: SpanAttributes): void
  /** End the span */
  end(): void
  /** Get span data */
  getData(): SpanData
}

/**
 * Health checker interface.
 */
export interface HealthChecker {
  /** Register a health check */
  register(name: string, check: () => Promise<ComponentHealth>): void
  /** Run all health checks */
  check(): Promise<HealthCheckResult>
  /** Get cached health status */
  getStatus(): HealthCheckResult | undefined
}

/**
 * Alert handler interface.
 */
export interface AlertHandler {
  /** Send an alert */
  send(alert: Alert): Promise<void>
  /** Resolve an alert */
  resolve(alertId: string): Promise<void>
}
