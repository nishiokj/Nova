/**
 * Distributed Tracing
 *
 * Simple tracing implementation for request/operation tracking.
 */

import type {
  Tracer,
  Span,
  SpanData,
  SpanStatus,
  SpanKind,
  SpanAttributes,
  SpanEvent,
} from './types.js'
import { ulid } from 'ulid'

// ============ Span Implementation ============

/**
 * Span implementation.
 */
export class TracingSpan implements Span {
  readonly spanId: string
  readonly traceId: string
  readonly parentSpanId?: string
  readonly name: string
  readonly kind: SpanKind
  readonly startTime: number
  private endTime?: number
  private status: SpanStatus = 'unset'
  private statusMessage?: string
  private attributes: SpanAttributes = {}
  private events: SpanEvent[] = []
  private ended = false

  constructor(
    name: string,
    options: {
      traceId?: string
      parentSpanId?: string
      kind?: SpanKind
      attributes?: SpanAttributes
    } = {}
  ) {
    this.spanId = generateSpanId()
    this.traceId = options.traceId ?? generateTraceId()
    this.parentSpanId = options.parentSpanId
    this.name = name
    this.kind = options.kind ?? 'internal'
    this.startTime = Date.now()
    if (options.attributes) {
      this.attributes = { ...options.attributes }
    }
  }

  /**
   * Set span status.
   */
  setStatus(status: SpanStatus, message?: string): void {
    if (this.ended) return
    this.status = status
    this.statusMessage = message
  }

  /**
   * Set attributes.
   */
  setAttributes(attributes: SpanAttributes): void {
    if (this.ended) return
    Object.assign(this.attributes, attributes)
  }

  /**
   * Add an event.
   */
  addEvent(name: string, attributes?: SpanAttributes): void {
    if (this.ended) return
    this.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    })
  }

  /**
   * End the span.
   */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.endTime = Date.now()
  }

  /**
   * Get span data.
   */
  getData(): SpanData {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      status: this.status,
      startTime: this.startTime,
      endTime: this.endTime,
      attributes: { ...this.attributes },
      events: [...this.events],
    }
  }

  /**
   * Get duration in milliseconds.
   */
  getDuration(): number | undefined {
    if (!this.endTime) return undefined
    return this.endTime - this.startTime
  }
}

// ============ Tracer Implementation ============

/**
 * Span exporter interface.
 */
export interface SpanExporter {
  export(spans: SpanData[]): Promise<void>
}

/**
 * Tracer configuration.
 */
export interface TracerConfig {
  /** Service name */
  serviceName: string
  /** Span exporter */
  exporter?: SpanExporter
  /** Sample rate (0-1) */
  sampleRate?: number
  /** Maximum spans to buffer */
  maxBufferSize?: number
}

/**
 * Default tracer configuration.
 */
export const DEFAULT_TRACER_CONFIG: TracerConfig = {
  serviceName: 'agent-memory',
  sampleRate: 1.0,
  maxBufferSize: 1000,
}

/**
 * Tracer implementation.
 */
export class SimpleTracer implements Tracer {
  private readonly config: TracerConfig
  private activeSpan?: TracingSpan
  private spanBuffer: SpanData[] = []
  private readonly spanStack: TracingSpan[] = []

  constructor(config: Partial<TracerConfig> = {}) {
    this.config = { ...DEFAULT_TRACER_CONFIG, ...config }
  }

  /**
   * Start a new span.
   */
  startSpan(
    name: string,
    options: { kind?: SpanKind; attributes?: SpanAttributes } = {}
  ): Span {
    // Check sampling
    if (!this.shouldSample()) {
      return new NoopSpan(name)
    }

    const parentSpan = this.activeSpan
    const span = new TracingSpan(name, {
      traceId: parentSpan?.traceId,
      parentSpanId: parentSpan?.spanId,
      kind: options.kind,
      attributes: {
        'service.name': this.config.serviceName,
        ...options.attributes,
      },
    })

    this.spanStack.push(span)
    this.activeSpan = span

    return span
  }

  /**
   * Get current active span.
   */
  getActiveSpan(): Span | undefined {
    return this.activeSpan
  }

  /**
   * Run function within a span.
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>
  ): Promise<T> {
    const span = this.startSpan(name)

    try {
      const result = await fn(span)
      span.setStatus('ok')
      return result
    } catch (error) {
      span.setStatus('error', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      span.end()
      this.endSpan(span)
    }
  }

  /**
   * End a span and update active span.
   */
  private endSpan(span: Span): void {
    // Record span data
    if (span instanceof TracingSpan) {
      const data = span.getData()
      this.spanBuffer.push(data)

      // Flush if buffer is full
      if (this.spanBuffer.length >= this.config.maxBufferSize!) {
        this.flush()
      }

      // Pop from stack
      const index = this.spanStack.indexOf(span)
      if (index >= 0) {
        this.spanStack.splice(index, 1)
      }

      // Update active span
      this.activeSpan = this.spanStack[this.spanStack.length - 1]
    }
  }

  /**
   * Flush buffered spans to exporter.
   */
  async flush(): Promise<void> {
    if (this.spanBuffer.length === 0) return
    if (!this.config.exporter) {
      this.spanBuffer = []
      return
    }

    const spans = [...this.spanBuffer]
    this.spanBuffer = []

    try {
      await this.config.exporter.export(spans)
    } catch {
      // Put spans back in buffer on failure
      this.spanBuffer.unshift(...spans)
    }
  }

  /**
   * Get buffered spans.
   */
  getBufferedSpans(): SpanData[] {
    return [...this.spanBuffer]
  }

  /**
   * Clear buffered spans.
   */
  clearBuffer(): void {
    this.spanBuffer = []
  }

  private shouldSample(): boolean {
    return Math.random() < (this.config.sampleRate ?? 1.0)
  }
}

// ============ No-op Span ============

/**
 * No-op span for when tracing is disabled.
 */
class NoopSpan implements Span {
  readonly spanId = '0000000000000000'
  readonly traceId = '00000000000000000000000000000000'

  constructor(private readonly name: string) {}

  setStatus(): void {}
  setAttributes(): void {}
  addEvent(): void {}
  end(): void {}

  getData(): SpanData {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      name: this.name,
      kind: 'internal',
      status: 'unset',
      startTime: 0,
      attributes: {},
      events: [],
    }
  }
}

// ============ Factory Functions ============

/**
 * Create a new tracer.
 */
export function createTracer(config: Partial<TracerConfig> = {}): SimpleTracer {
  return new SimpleTracer(config)
}

/**
 * No-op tracer.
 */
export const noopTracer: Tracer = {
  startSpan: (name: string) => new NoopSpan(name),
  getActiveSpan: () => undefined,
  withSpan: async <T>(_name: string, fn: (span: Span) => T | Promise<T>) =>
    fn(new NoopSpan('')),
}

/**
 * Default tracer instance.
 */
export const defaultTracer = createTracer()

// ============ Console Exporter ============

/**
 * Console span exporter for development.
 */
export class ConsoleSpanExporter implements SpanExporter {
  async export(spans: SpanData[]): Promise<void> {
    for (const span of spans) {
      const duration = span.endTime ? span.endTime - span.startTime : 0
      console.log(
        `[TRACE] ${span.name} (${span.spanId.slice(0, 8)}) ` +
          `status=${span.status} duration=${duration}ms`
      )
      if (Object.keys(span.attributes).length > 0) {
        console.log(`  attributes: ${JSON.stringify(span.attributes)}`)
      }
      for (const event of span.events) {
        console.log(`  event: ${event.name} at ${event.timestamp}`)
      }
    }
  }
}

// ============ Helpers ============

/**
 * Generate a trace ID (32 hex characters).
 */
function generateTraceId(): string {
  return ulid().toLowerCase()
}

/**
 * Generate a span ID (16 hex characters).
 */
function generateSpanId(): string {
  const id = ulid().toLowerCase()
  return id.slice(0, 16)
}

/**
 * Extract trace context from headers.
 */
export function extractTraceContext(
  headers: Record<string, string | undefined>
): { traceId?: string; spanId?: string } {
  // W3C Trace Context format: traceparent header
  const traceparent = headers['traceparent']
  if (traceparent) {
    const parts = traceparent.split('-')
    if (parts.length >= 3) {
      return {
        traceId: parts[1],
        spanId: parts[2],
      }
    }
  }
  return {}
}

/**
 * Inject trace context into headers.
 */
export function injectTraceContext(
  span: Span,
  headers: Record<string, string>
): void {
  // W3C Trace Context format
  headers['traceparent'] = `00-${span.traceId}-${span.spanId}-01`
}
