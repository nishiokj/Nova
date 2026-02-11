/**
 * Observability Module
 *
 * Logging, metrics, tracing, health checks, and alerting.
 */

// Types
export {
  // Log types
  LogLevel,
  LOG_LEVEL_PRIORITY,
  LogLevelSchema,
  type LogEntry,
  LogEntrySchema,
  // Metric types
  MetricType,
  MetricTypeSchema,
  type MetricLabels,
  type MetricDefinition,
  type MetricSample,
  type HistogramData,
  type SummaryData,
  // Span types
  SpanStatus,
  SpanKind,
  type SpanAttributes,
  type SpanEvent,
  type SpanData,
  // Health types
  HealthStatus,
  HealthStatusSchema,
  type ComponentHealth,
  type HealthCheckResult,
  ComponentHealthSchema,
  HealthCheckResultSchema,
  // Alert types
  AlertSeverity,
  AlertSeveritySchema,
  type Alert,
  AlertSchema,
  // Interfaces
  type Logger,
  type MetricsCollector,
  type Tracer,
  type Span,
  type HealthChecker,
  type AlertHandler,
} from './types.js'

// Logger
export {
  type LoggerConfig,
  DEFAULT_LOGGER_CONFIG,
  StructuredLogger,
  createLogger,
  createLoggerFromEnv,
  noopLogger,
  defaultLogger,
  logTiming,
  scopedLogger,
} from './logger.js'

// Metrics
export {
  DEFAULT_HISTOGRAM_BUCKETS,
  METRICS,
  InMemoryMetricsCollector,
  createMetricsCollector,
  noopMetrics,
  defaultMetrics,
} from './metrics.js'

// Tracing
export {
  type SpanExporter,
  type TracerConfig,
  DEFAULT_TRACER_CONFIG,
  TracingSpan,
  SimpleTracer,
  createTracer,
  noopTracer,
  defaultTracer,
  ConsoleSpanExporter,
  extractTraceContext,
  injectTraceContext,
} from './tracing.js'

// Health checks
export {
  type HealthCheckerConfig,
  type HealthCheckFn,
  DEFAULT_HEALTH_CHECKER_CONFIG,
  SimpleHealthChecker,
  createHealthChecker,
  defaultHealthChecker,
  createDatabaseHealthCheck,
  createMemoryHealthCheck,
  createEventLoopHealthCheck,
  createExternalServiceHealthCheck,
} from './health.js'

// Alerts
export {
  type AlertManagerConfig,
  DEFAULT_ALERT_MANAGER_CONFIG,
  AlertManager,
  ConsoleAlertHandler,
  InMemoryAlertHandler,
  WebhookAlertHandler,
  CallbackAlertHandler,
  createAlertManager,
  defaultAlertManager,
  alertFromError,
  alertHealthFailure,
  alertRateLimited,
} from './alerts.js'
