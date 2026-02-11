/**
 * Metrics Collection
 *
 * In-memory metrics collection with support for counters, gauges,
 * histograms, and summaries.
 */

import type {
  MetricsCollector,
  MetricType,
  MetricLabels,
  MetricSample,
  MetricDefinition,
  HistogramData,
  SummaryData,
} from './types.js'

// ============ Metric Storage ============

/**
 * Internal metric storage.
 */
interface MetricStorage {
  definition: MetricDefinition
  values: Map<string, MetricValue>
}

/**
 * Internal metric value storage.
 */
interface MetricValue {
  labels: MetricLabels
  value: number
  count?: number
  sum?: number
  buckets?: Map<number, number>
  samples?: number[]
  lastUpdated: number
}

// ============ Default Histogram Buckets ============

/**
 * Default histogram buckets (in milliseconds for latency).
 */
export const DEFAULT_HISTOGRAM_BUCKETS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
]

// ============ Pre-defined Metrics ============

/**
 * Standard metrics for agent-memory.
 */
export const METRICS = {
  // Sync metrics
  SYNC_JOBS_TOTAL: 'agent_memory_sync_jobs_total',
  SYNC_JOBS_DURATION_MS: 'agent_memory_sync_jobs_duration_ms',
  SYNC_ITEMS_PROCESSED: 'agent_memory_sync_items_processed_total',
  SYNC_ITEMS_FAILED: 'agent_memory_sync_items_failed_total',

  // Queue metrics
  QUEUE_JOBS_ENQUEUED: 'agent_memory_queue_jobs_enqueued_total',
  QUEUE_JOBS_COMPLETED: 'agent_memory_queue_jobs_completed_total',
  QUEUE_JOBS_FAILED: 'agent_memory_queue_jobs_failed_total',
  QUEUE_JOBS_RETRIED: 'agent_memory_queue_jobs_retried_total',
  QUEUE_DEPTH: 'agent_memory_queue_depth',
  QUEUE_PROCESSING_DURATION_MS: 'agent_memory_queue_processing_duration_ms',

  // HTTP metrics
  HTTP_REQUESTS_TOTAL: 'agent_memory_http_requests_total',
  HTTP_REQUEST_DURATION_MS: 'agent_memory_http_request_duration_ms',
  HTTP_ERRORS_TOTAL: 'agent_memory_http_errors_total',
  HTTP_RETRIES_TOTAL: 'agent_memory_http_retries_total',
  HTTP_RATE_LIMITS_TOTAL: 'agent_memory_http_rate_limits_total',

  // Entity metrics
  ENTITIES_CREATED: 'agent_memory_entities_created_total',
  ENTITIES_UPDATED: 'agent_memory_entities_updated_total',
  ENTITIES_MERGED: 'agent_memory_entities_merged_total',

  // Resolution metrics
  RESOLUTION_MATCHES: 'agent_memory_resolution_matches_total',
  RESOLUTION_REVIEWS_PENDING: 'agent_memory_resolution_reviews_pending',

  // Database metrics
  DB_QUERIES_TOTAL: 'agent_memory_db_queries_total',
  DB_QUERY_DURATION_MS: 'agent_memory_db_query_duration_ms',
  DB_CONNECTIONS_ACTIVE: 'agent_memory_db_connections_active',

  // Error metrics
  ERRORS_TOTAL: 'agent_memory_errors_total',
} as const

// ============ Metrics Collector Implementation ============

/**
 * In-memory metrics collector.
 */
export class InMemoryMetricsCollector implements MetricsCollector {
  private metrics: Map<string, MetricStorage> = new Map()
  private readonly histogramBuckets: number[]
  private readonly summaryWindow: number

  constructor(options: { histogramBuckets?: number[]; summaryWindowMs?: number } = {}) {
    this.histogramBuckets = options.histogramBuckets ?? DEFAULT_HISTOGRAM_BUCKETS
    this.summaryWindow = options.summaryWindowMs ?? 60000
  }

  /**
   * Register a metric definition.
   */
  register(definition: MetricDefinition): void {
    if (!this.metrics.has(definition.name)) {
      this.metrics.set(definition.name, {
        definition,
        values: new Map(),
      })
    }
  }

  /**
   * Increment a counter.
   */
  increment(name: string, value: number = 1, labels: MetricLabels = {}): void {
    this.ensureMetric(name, 'counter')
    const storage = this.metrics.get(name)!
    const key = labelsToKey(labels)

    const existing = storage.values.get(key)
    if (existing) {
      existing.value += value
      existing.lastUpdated = Date.now()
    } else {
      storage.values.set(key, {
        labels,
        value,
        lastUpdated: Date.now(),
      })
    }
  }

  /**
   * Set a gauge value.
   */
  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.ensureMetric(name, 'gauge')
    const storage = this.metrics.get(name)!
    const key = labelsToKey(labels)

    storage.values.set(key, {
      labels,
      value,
      lastUpdated: Date.now(),
    })
  }

  /**
   * Record a histogram value.
   */
  histogram(name: string, value: number, labels: MetricLabels = {}): void {
    this.ensureMetric(name, 'histogram')
    const storage = this.metrics.get(name)!
    const key = labelsToKey(labels)
    const buckets = storage.definition.buckets ?? this.histogramBuckets

    let metricValue = storage.values.get(key)
    if (!metricValue) {
      metricValue = {
        labels,
        value: 0,
        count: 0,
        sum: 0,
        buckets: new Map(buckets.map(b => [b, 0])),
        lastUpdated: Date.now(),
      }
      storage.values.set(key, metricValue)
    }

    metricValue.count = (metricValue.count ?? 0) + 1
    metricValue.sum = (metricValue.sum ?? 0) + value
    metricValue.lastUpdated = Date.now()

    // Update buckets
    for (const bucket of buckets) {
      if (value <= bucket) {
        const currentCount = metricValue.buckets!.get(bucket) ?? 0
        metricValue.buckets!.set(bucket, currentCount + 1)
      }
    }
  }

  /**
   * Record a summary value.
   */
  summary(name: string, value: number, labels: MetricLabels = {}): void {
    this.ensureMetric(name, 'summary')
    const storage = this.metrics.get(name)!
    const key = labelsToKey(labels)
    const now = Date.now()

    let metricValue = storage.values.get(key)
    if (!metricValue) {
      metricValue = {
        labels,
        value: 0,
        count: 0,
        sum: 0,
        samples: [],
        lastUpdated: now,
      }
      storage.values.set(key, metricValue)
    }

    metricValue.count = (metricValue.count ?? 0) + 1
    metricValue.sum = (metricValue.sum ?? 0) + value
    metricValue.samples = metricValue.samples ?? []
    metricValue.samples.push(value)
    metricValue.lastUpdated = now

    // Keep only samples within the window
    if (metricValue.samples.length > 1000) {
      metricValue.samples = metricValue.samples.slice(-500)
    }
  }

  /**
   * Start a timer that records duration on stop.
   */
  startTimer(name: string, labels: MetricLabels = {}): () => number {
    const start = performance.now()
    return () => {
      const duration = performance.now() - start
      this.histogram(name, duration, labels)
      return duration
    }
  }

  /**
   * Get all current metrics.
   */
  getMetrics(): MetricSample[] {
    const samples: MetricSample[] = []

    for (const [name, storage] of this.metrics) {
      for (const [, metricValue] of storage.values) {
        samples.push({
          name,
          type: storage.definition.type,
          value: metricValue.value,
          labels: metricValue.labels,
          timestamp: metricValue.lastUpdated,
        })
      }
    }

    return samples
  }

  /**
   * Get histogram data for a metric.
   */
  getHistogram(name: string, labels: MetricLabels = {}): HistogramData | undefined {
    const storage = this.metrics.get(name)
    if (!storage || storage.definition.type !== 'histogram') return undefined

    const key = labelsToKey(labels)
    const metricValue = storage.values.get(key)
    if (!metricValue) return undefined

    const buckets = storage.definition.buckets ?? this.histogramBuckets
    return {
      count: metricValue.count ?? 0,
      sum: metricValue.sum ?? 0,
      buckets: buckets.map(le => ({
        le,
        count: metricValue.buckets?.get(le) ?? 0,
      })),
    }
  }

  /**
   * Get summary data for a metric.
   */
  getSummary(
    name: string,
    labels: MetricLabels = {},
    quantiles: number[] = [0.5, 0.9, 0.99]
  ): SummaryData | undefined {
    const storage = this.metrics.get(name)
    if (!storage || storage.definition.type !== 'summary') return undefined

    const key = labelsToKey(labels)
    const metricValue = storage.values.get(key)
    if (!metricValue || !metricValue.samples) return undefined

    const sorted = [...metricValue.samples].sort((a, b) => a - b)
    return {
      count: metricValue.count ?? 0,
      sum: metricValue.sum ?? 0,
      quantiles: quantiles.map(q => ({
        quantile: q,
        value: percentile(sorted, q),
      })),
    }
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    for (const storage of this.metrics.values()) {
      storage.values.clear()
    }
  }

  /**
   * Export metrics in Prometheus format.
   */
  toPrometheusFormat(): string {
    const lines: string[] = []

    for (const [name, storage] of this.metrics) {
      lines.push(`# HELP ${name} ${storage.definition.description}`)
      lines.push(`# TYPE ${name} ${storage.definition.type}`)

      for (const [, metricValue] of storage.values) {
        const labelStr = formatLabels(metricValue.labels)

        if (storage.definition.type === 'histogram') {
          const buckets = storage.definition.buckets ?? this.histogramBuckets
          for (const bucket of buckets) {
            const count = metricValue.buckets?.get(bucket) ?? 0
            lines.push(`${name}_bucket{${labelStr}le="${bucket}"} ${count}`)
          }
          lines.push(`${name}_bucket{${labelStr}le="+Inf"} ${metricValue.count ?? 0}`)
          lines.push(`${name}_sum{${labelStr}} ${metricValue.sum ?? 0}`)
          lines.push(`${name}_count{${labelStr}} ${metricValue.count ?? 0}`)
        } else {
          const labelPart = labelStr ? `{${labelStr}}` : ''
          lines.push(`${name}${labelPart} ${metricValue.value}`)
        }
      }
    }

    return lines.join('\n')
  }

  private ensureMetric(name: string, type: MetricType): void {
    if (!this.metrics.has(name)) {
      this.register({
        name,
        type,
        description: name,
      })
    }
  }
}

// ============ Factory Functions ============

/**
 * Create a new metrics collector.
 */
export function createMetricsCollector(
  options: { histogramBuckets?: number[]; summaryWindowMs?: number } = {}
): InMemoryMetricsCollector {
  return new InMemoryMetricsCollector(options)
}

/**
 * No-op metrics collector.
 */
export const noopMetrics: MetricsCollector = {
  increment: () => {},
  gauge: () => {},
  histogram: () => {},
  summary: () => {},
  startTimer: () => () => 0,
  getMetrics: () => [],
}

/**
 * Default metrics collector instance.
 */
export const defaultMetrics = createMetricsCollector()

// ============ Helpers ============

/**
 * Convert labels to a string key.
 */
function labelsToKey(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort((a, b) => a[0].localeCompare(b[0]))
  return entries.map(([k, v]) => `${k}=${v}`).join(',')
}

/**
 * Format labels for Prometheus output.
 */
function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels)
  if (entries.length === 0) return ''
  return entries.map(([k, v]) => `${k}="${v}",`).join('')
}

/**
 * Calculate percentile from sorted array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]
}
